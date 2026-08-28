'use strict';

const { types: { isProxy } } = require('node:util');

const { registerKnownLogSecrets } = require('../utils/redactSecrets');
const { createV2Repositories } = require('../repositories/v2');
const { createReferenceOwnershipResolver } = require('../assets/referenceOwnership');
const { sha256Canonical, uid } = require('./contract');
const { createMinimaxH3ApiClient, createPublicH3ApiTask } = require('./apiClient');
const { createMinimaxH3ApiProvider } = require('./apiProvider');
const { createH3ApiSubmissionStore } = require('./apiSubmissionStore');
const { fail } = require('./errors');

function modelList(value) {
  if (typeof value !== 'string' || value.length > 32 * 1024) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function configFromRow(row) {
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1) fail('H3_API_UNAVAILABLE');
  const provider = String(row.provider || '').trim().toLowerCase();
  const protocol = String(row.api_protocol || '').trim().toLowerCase();
  const models = modelList(row.model);
  if (protocol !== 'minimax_h3' && provider !== 'minimax_h3'
    && !models.includes('MiniMax-H3')) fail('H3_API_UNAVAILABLE');
  const secret = row.api_key;
  const origin = String(row.base_url || '').trim() || 'https://api.minimaxi.com';
  registerKnownLogSecrets(secret);
  return Object.freeze({
    id: row.id,
    origin,
    apiKey: secret,
    evidenceSha256: sha256Canonical({
      id: row.id,
      origin,
      apiKey: secret,
      provider,
      protocol,
      models,
      updatedAt: row.updated_at,
    }),
  });
}

function configColumns(database) {
  let hasProtocol = false;
  try {
    hasProtocol = database.prepare('PRAGMA table_info(ai_service_configs)').all()
      .some((column) => column.name === 'api_protocol');
  } catch {
    return fail('H3_API_UNAVAILABLE');
  }
  return hasProtocol ? 'api_protocol,' : "'' AS api_protocol,";
}

function selectConfig(database) {
  const protocolColumn = configColumns(database);
  let rows;
  try {
    rows = database.prepare(`
      SELECT id, provider, ${protocolColumn} base_url, api_key, model,
             is_default, priority, updated_at
      FROM ai_service_configs
      WHERE deleted_at IS NULL AND service_type='video' AND is_active=1
      ORDER BY is_default DESC, priority DESC, id ASC
    `).all();
  } catch {
    return fail('H3_API_UNAVAILABLE');
  }
  const row = rows.find((candidate) => {
    const provider = String(candidate.provider || '').trim().toLowerCase();
    const protocol = String(candidate.api_protocol || '').trim().toLowerCase();
    return protocol === 'minimax_h3' || provider === 'minimax_h3'
      || modelList(candidate.model).includes('MiniMax-H3');
  });
  return configFromRow(row);
}

function selectConfigById(database, id) {
  const protocolColumn = configColumns(database);
  let row;
  try {
    row = database.prepare(`
      SELECT id, provider, ${protocolColumn} base_url, api_key, model,
             is_default, priority, updated_at
      FROM ai_service_configs
      WHERE id=? AND deleted_at IS NULL AND service_type='video' AND is_active=1
    `).get(id);
  } catch {
    return fail('H3_API_UNAVAILABLE');
  }
  return configFromRow(row);
}

function mediaUrlResolver(repositories, ownership, storageBaseUrl) {
  const configuredBase = storageBaseUrl;
  let base;
  function resolveBase() {
    if (base !== undefined) return base;
    if (configuredBase == null || configuredBase === '') {
      base = null;
      return base;
    }
    try {
      const parsed = new URL(configuredBase);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.search || parsed.hash) fail('H3_API_REQUEST_INVALID');
      base = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
    } catch {
      fail('H3_API_REQUEST_INVALID');
    }
    return base;
  }
  return function resolveMediaUrl(assetVersionUid, reference) {
    const publicBase = resolveBase();
    if (!publicBase || !reference || typeof reference !== 'object') {
      fail('H3_API_REQUEST_INVALID');
    }
    let version;
    let asset;
    try {
      version = repositories.assets.getVersion(assetVersionUid);
      asset = repositories.assets.get(version.assetUid);
    } catch {
      return fail('H3_API_REQUEST_INVALID');
    }
    const isImage = Object.hasOwn(reference, 'width') && Object.hasOwn(reference, 'height');
    const isAudio = Object.hasOwn(reference, 'durationMs');
    const mediaKind = isImage && !isAudio ? 'image' : isAudio && !isImage ? 'audio' : null;
    const evidenceMatches = mediaKind === 'image'
      ? version.width === reference.width && version.height === reference.height
      : mediaKind === 'audio' && version.durationMs === reference.durationMs;
    if (version.status !== 'ready' || version.sha256 !== reference.sha256
      || version.mimeType !== reference.mimeType || !evidenceMatches
      || version.assetUid !== asset.uid
      || !ownership.accepts(asset, reference.dramaUid, mediaKind)
      || typeof version.relativePath !== 'string') {
      fail('H3_API_REQUEST_INVALID');
    }
    const encoded = version.relativePath.split('/').map(encodeURIComponent).join('/');
    return new URL(encoded, publicBase).toString();
  };
}

function createMinimaxH3ApiService({ database, storageBaseUrl = '', fetchImpl, timeoutMs = 30000 }) {
  if (!database || typeof database.prepare !== 'function' || isProxy(database)
    || typeof fetchImpl !== 'function' || isProxy(fetchImpl)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('MiniMax H3 API service configuration is invalid');
  }
  const repositories = createV2Repositories(database);
  const ownership = createReferenceOwnershipResolver(database);
  const submissions = createH3ApiSubmissionStore(database);
  const provider = createMinimaxH3ApiProvider({
    resolveMediaUrl: mediaUrlResolver(repositories, ownership, storageBaseUrl),
  });

  function client(config) {
    return createMinimaxH3ApiClient({ ...config, fetchImpl, timeoutMs });
  }

  return Object.freeze({
    async submit(spec, operationUidValue) {
      const request = provider.buildRequest(spec);
      const operationUid = uid(operationUidValue, 'H3_API_REQUEST_INVALID');
      const requestSha256 = sha256Canonical(request);
      const config = selectConfig(database);
      const transport = client(config);
      const reservation = submissions.reserve({
        operationUid,
        requestSha256,
        configId: config.id,
        configEvidenceSha256: config.evidenceSha256,
      });
      const persisted = reservation.submission;
      if (persisted.requestSha256 !== requestSha256
        || persisted.configId !== config.id
        || persisted.configEvidenceSha256 !== config.evidenceSha256) {
        fail('H3_API_REQUEST_INVALID');
      }
      if (!reservation.created) {
        if (persisted.state === 'accepted') {
          return createPublicH3ApiTask(persisted.providerTaskId, 'queued');
        }
        fail('H3_API_SUBMISSION_UNKNOWN');
      }
      try {
        const result = await transport.submit(request);
        submissions.accept(
          operationUid,
          requestSha256,
          config.evidenceSha256,
          result.taskId,
        );
        return result;
      } catch (error) {
        submissions.markUnknown(operationUid, requestSha256, config.evidenceSha256);
        throw error;
      }
    },
    async query(taskId) {
      const submission = submissions.getByProviderTaskId(taskId);
      if (!submission || submission.state !== 'accepted') fail('H3_API_REQUEST_INVALID');
      const config = selectConfigById(database, submission.configId);
      if (config.evidenceSha256 !== submission.configEvidenceSha256) {
        fail('H3_API_UNAVAILABLE');
      }
      return client(config).query(taskId);
    },
  });
}

module.exports = Object.freeze({ createMinimaxH3ApiService });
