const { archiveError } = require('./errors');
const { validateRunAggregate } = require('../../../workflows/runState');

const SCHEMA_VERSION = '2.0.0';
const ARCHIVE_KIND = 'local-mini-drama-project';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORDS = 100000;
const MAX_STRUCTURED_DEPTH = 32;

const RECORD_SPECS = Object.freeze({
  sourceDocuments: Object.freeze({
    table: 'source_documents',
    columns: Object.freeze(['uid', 'drama_uid', 'source_type', 'original_name', 'encoding', 'content_sha256', 'full_text', 'created_at']),
  }),
  sourceBlocks: Object.freeze({
    table: 'source_blocks',
    columns: Object.freeze(['uid', 'document_uid', 'ordinal', 'heading_path_json', 'char_start', 'char_end', 'text', 'text_sha256', 'created_at']),
    json: Object.freeze({ heading_path_json: 'array' }),
  }),
  sourceSelections: Object.freeze({
    table: 'source_selections',
    columns: Object.freeze(['uid', 'document_uid', 'start_block_uid', 'end_block_uid', 'start_offset', 'end_offset', 'selected_text_sha256', 'created_at']),
  }),
  assets: Object.freeze({
    table: 'assets',
    columns: Object.freeze(['uid', 'owner_type', 'owner_uid', 'asset_type', 'current_version_uid', 'status', 'created_at', 'updated_at']),
  }),
  assetVersions: Object.freeze({
    table: 'asset_versions',
    columns: Object.freeze(['uid', 'asset_uid', 'storage_provider', 'logical_uri', 'relative_path', 'sha256', 'mime_type', 'width', 'height', 'duration_ms', 'parent_uid', 'status', 'created_at']),
  }),
  workflowDefinitions: Object.freeze({
    table: 'workflow_definitions',
    columns: Object.freeze(['uid', 'drama_uid', 'name', 'version', 'status', 'description', 'created_at', 'updated_at']),
  }),
  canvasNodes: Object.freeze({
    table: 'canvas_nodes',
    columns: Object.freeze(['uid', 'workflow_uid', 'node_type', 'position_json', 'config_json', 'domain_ref_type', 'domain_ref_uid', 'status', 'created_at', 'updated_at']),
    json: Object.freeze({ position_json: 'object', config_json: 'object' }),
  }),
  canvasEdges: Object.freeze({
    table: 'canvas_edges',
    columns: Object.freeze(['uid', 'workflow_uid', 'source_node_uid', 'source_port', 'target_node_uid', 'target_port', 'created_at']),
  }),
  generationRuns: Object.freeze({
    table: 'generation_runs',
    columns: Object.freeze(['uid', 'owner_type', 'owner_uid', 'provider', 'model', 'seed', 'parameters_json', 'input_json', 'prompt_version_uid', 'output_asset_version_uid', 'status', 'retry_count', 'error_code', 'error_detail_ref', 'created_at', 'started_at', 'completed_at', 'updated_at']),
    json: Object.freeze({ parameters_json: 'object', input_json: 'object' }),
  }),
  workflowRuns: Object.freeze({
    table: 'workflow_runs',
    columns: Object.freeze(['uid', 'workflow_uid', 'graph_snapshot_json', 'graph_hash', 'graph_revision', 'trigger_type', 'status', 'retry_count', 'error_code', 'error_detail_ref', 'created_at', 'started_at', 'completed_at', 'updated_at']),
    json: Object.freeze({ graph_snapshot_json: 'object' }),
  }),
  nodeRuns: Object.freeze({
    table: 'node_runs',
    columns: Object.freeze(['uid', 'workflow_run_uid', 'node_uid', 'ordinal', 'input_snapshot_json', 'output_json', 'cache_key', 'status', 'retry_count', 'error_code', 'error_detail_ref', 'created_at', 'started_at', 'completed_at', 'updated_at']),
    json: Object.freeze({ input_snapshot_json: 'object', output_json: 'object?' }),
  }),
  exportRuns: Object.freeze({
    table: 'export_runs',
    columns: Object.freeze(['uid', 'drama_uid', 'workflow_run_uid', 'timeline_snapshot_json', 'encoding_json', 'audio_json', 'subtitle_json', 'output_asset_version_uid', 'validation_json', 'status', 'error_code', 'error_detail_ref', 'created_at', 'started_at', 'completed_at', 'updated_at']),
    json: Object.freeze({ timeline_snapshot_json: 'object', encoding_json: 'object', audio_json: 'object', subtitle_json: 'object', validation_json: 'object' }),
  }),
});

const RECORD_NAMES = Object.freeze(Object.keys(RECORD_SPECS));
const FORBIDDEN_SECRET_KEYS = new Set([
  'apikey', 'apisecret', 'accesskey', 'accesssecret', 'secretkey', 'clientkey',
  'clientsecret', 'password', 'passwd', 'token', 'secret', 'authorization',
  'bearertoken', 'refreshtoken', 'accesstoken', 'credential', 'credentialref',
  'privatekey', 'sessioncookie',
]);

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value, keys) {
  if (!isPlainObject(value)) invalidManifest();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidManifest();
  return value;
}

function assertUid(value, seen) {
  if (typeof value !== 'string' || !UUID_V4.test(value) || seen.has(value)) invalidManifest();
  seen.add(value);
}

function assertUidArray(value, seen) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) invalidManifest();
  for (const uid of value) assertUid(uid, seen);
}

function assertJsonValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) invalidManifest();
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) invalidManifest();
  const stack = [value];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20) invalidManifest();
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child === null || ['string', 'boolean'].includes(typeof child)) continue;
      if (typeof child === 'number' && Number.isFinite(child)) continue;
      if (Array.isArray(child) || isPlainObject(child)) stack.push(child);
      else invalidManifest();
    }
  }
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenSecretKey(value) {
  const key = normalizedKey(value);
  return FORBIDDEN_SECRET_KEYS.has(key)
    || key.endsWith('token')
    || key.endsWith('secret')
    || key.endsWith('password')
    || key.includes('credential')
    || key === 'auth'
    || key.endsWith('authorization');
}

function assertNoSecretKeys(value) {
  const stack = [value];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20) invalidManifest();
    if (Array.isArray(current)) {
      for (const child of current) if (child && typeof child === 'object') stack.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isForbiddenSecretKey(key)) {
        throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
      }
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function hasPortableRoutePath(value) {
  if (value === '' || value === '/') return true;
  if (!value.startsWith('/')) return false;
  const segments = value.slice(1).split('/');
  if (segments.at(-1) === '') segments.pop();
  return segments.length > 0 && segments.every((segment) => {
    if (segment.length === 0) return false;
    const decodedDots = segment.replace(/%2e/gi, '.');
    return decodedDots !== '.' && decodedDots !== '..';
  });
}

function rawRemoteUrlPath(value) {
  const scheme = /^https?:\/\//i.exec(value);
  if (!scheme) return null;
  const remainder = value.slice(scheme[0].length);
  const boundary = remainder.search(/[/?#]/);
  const authority = boundary === -1 ? remainder : remainder.slice(0, boundary);
  if (authority.length === 0) return null;
  if (boundary === -1 || remainder[boundary] !== '/') return '';
  return remainder.slice(boundary).split(/[?#]/, 1)[0];
}

function isApprovedRemoteUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 8192
    || value !== value.trim() || /[\p{White_Space}\u0000-\u001f\u007f\\]/u.test(value)) return false;
  const rawPath = rawRemoteUrlPath(value);
  if (rawPath === null || !hasPortableRoutePath(rawPath)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function portableFieldKind(rawKey) {
  if (typeof rawKey !== 'string') return null;
  const key = normalizedKey(rawKey);
  const tokens = rawKey
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === 'route' || last === 'routes'
    || ((last === 'path' || last === 'paths') && ['route', 'endpoint', 'api'].includes(previous))) return 'route';
  if (last === 'url' || last === 'urls' || last === 'endpoint'
    || key === 'origin' || ['apiorigin', 'serverorigin', 'serviceorigin', 'remoteorigin'].includes(key)
    || key === 'apiroot') return 'url';
  if (['path', 'paths', 'dir', 'dirs', 'directory', 'directories', 'folder', 'folders', 'root', 'roots']
    .includes(last)) return 'path';
  if (last === 'file' || last === 'files'
    || ((last === 'name' || last === 'names') && (previous === 'file' || previous === 'files'))) return 'file';
  return null;
}

function isApprovedApiRoute(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 8192
    || value !== value.trim() || /[\p{White_Space}\u0000-\u001f\u007f\\]/u.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return isApprovedRemoteUrl(value);
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  const pathname = value.split(/[?#]/, 1)[0];
  return hasPortableRoutePath(pathname);
}

function assertPortableFieldKind(kind, value) {
  if (kind === 'url' && !isApprovedRemoteUrl(value)) invalidManifest();
  if (kind === 'route' && !isApprovedApiRoute(value)) invalidManifest();
  if (kind === 'path' || kind === 'file') assertPortableRelativePath(value);
}

function nestedJsonContainer(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8 * 1024 * 1024) return null;
  const text = value.trim();
  if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) || isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertStructuredPayloadSafe(value) {
  const stack = [{ value, depth: 0, kind: null }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20 || current.depth > MAX_STRUCTURED_DEPTH) invalidManifest();
    const container = current.value;
    const entries = Array.isArray(container)
      ? container.map((child) => [null, child])
      : Object.entries(container);
    for (const [key, child] of entries) {
      if (key !== null && isForbiddenSecretKey(key)) {
        throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
      }
      const kind = current.kind || (key === null ? null : portableFieldKind(key));
      if (typeof child === 'string') {
        const nested = nestedJsonContainer(child);
        if (nested !== null) stack.push({ value: nested, depth: current.depth + 1, kind });
        else assertPortableFieldKind(kind, child);
      } else if (Array.isArray(child) || isPlainObject(child)) {
        stack.push({ value: child, depth: current.depth + 1, kind });
      }
    }
  }
}

function assertJsonColumn(value, expectedKind) {
  if (value === null && expectedKind.endsWith('?')) return;
  if (typeof value !== 'string') invalidManifest();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidManifest();
  }
  const kind = expectedKind.replace(/\?$/, '');
  if (kind === 'array' ? !Array.isArray(parsed) : !isPlainObject(parsed)) invalidManifest();
  assertJsonValue(parsed);
  assertStructuredPayloadSafe(parsed);
}

function assertPortableRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024
    || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.includes(':') || value.endsWith('/')) invalidManifest();
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) invalidManifest();
}

function assertPortableBasename(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 255
    || value.includes('\0') || value.includes('/') || value.includes('\\') || value.includes(':')
    || value === '.' || value === '..') invalidManifest();
}

function assertRecord(record, spec, seen) {
  assertExactObject(record, spec.columns);
  assertUid(record.uid, seen);
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) || isPlainObject(value)) invalidManifest();
    assertJsonValue(value);
    if (spec.json?.[key]) assertJsonColumn(value, spec.json[key]);
  }
  if (spec.table === 'asset_versions') {
    assertPortableRelativePath(record.relative_path);
    if (typeof record.logical_uri !== 'string' || !record.logical_uri.startsWith('asset://')
      || record.logical_uri.includes('\\') || /^[A-Za-z]:/.test(record.logical_uri)) invalidManifest();
  }
  if (spec.table === 'source_documents') assertPortableBasename(record.original_name);
}

function recordUidSet(rows) {
  return new Set(rows.map((row) => row.uid));
}

function createTypedUidSets(manifest) {
  const sets = new Map([
    ['drama', new Set([manifest.project.dramaUid])],
    ['character', new Set(manifest.project.characters)],
    ['scene', new Set(manifest.project.scenes)],
    ['prop', new Set(manifest.project.props)],
    ['episode', new Set(manifest.project.episodes.map((episode) => episode.uid))],
    ['storyboard', new Set(manifest.project.episodes.flatMap((episode) => episode.storyboards))],
  ]);
  const recordTypes = {
    source_document: 'sourceDocuments',
    source_block: 'sourceBlocks',
    source_selection: 'sourceSelections',
    asset: 'assets',
    asset_version: 'assetVersions',
    workflow_definition: 'workflowDefinitions',
    canvas_node: 'canvasNodes',
    canvas_edge: 'canvasEdges',
    generation_run: 'generationRuns',
    workflow_run: 'workflowRuns',
    node_run: 'nodeRuns',
    export_run: 'exportRuns',
  };
  for (const [type, name] of Object.entries(recordTypes)) {
    sets.set(type, recordUidSet(manifest.records[name]));
  }
  return sets;
}

function assertTypedReference(sets, type, uid) {
  if (typeof type !== 'string' || typeof uid !== 'string' || !sets.get(type)?.has(uid)) invalidManifest();
}

function workflowRunRecord(row) {
  return {
    uid: row.uid,
    workflowUid: row.workflow_uid,
    graphSnapshot: JSON.parse(row.graph_snapshot_json),
    graphHash: row.graph_hash,
    graphRevision: row.graph_revision,
    triggerType: row.trigger_type,
    status: row.status,
    retryCount: row.retry_count,
    errorCode: row.error_code,
    errorDetailRef: row.error_detail_ref,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function nodeRunRecord(row) {
  return {
    uid: row.uid,
    workflowRunUid: row.workflow_run_uid,
    nodeUid: row.node_uid,
    ordinal: row.ordinal,
    inputSnapshot: JSON.parse(row.input_snapshot_json),
    output: row.output_json === null ? null : JSON.parse(row.output_json),
    cacheKey: row.cache_key,
    status: row.status,
    retryCount: row.retry_count,
    errorCode: row.error_code,
    errorDetailRef: row.error_detail_ref,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function assertManifestClosure(manifest) {
  const records = manifest.records;
  const typed = createTypedUidSets(manifest);
  const documentByUid = new Map(records.sourceDocuments.map((row) => [row.uid, row]));
  const blockByUid = new Map(records.sourceBlocks.map((row) => [row.uid, row]));
  const workflowByUid = new Map(records.workflowDefinitions.map((row) => [row.uid, row]));
  const nodeByUid = new Map(records.canvasNodes.map((row) => [row.uid, row]));
  const assetByUid = new Map(records.assets.map((row) => [row.uid, row]));
  const versionByUid = new Map(records.assetVersions.map((row) => [row.uid, row]));
  const workflowRunByUid = new Map(records.workflowRuns.map((row) => [row.uid, row]));
  const nodeRunsByWorkflowRun = new Map();
  for (const row of records.nodeRuns) {
    const rows = nodeRunsByWorkflowRun.get(row.workflow_run_uid) || [];
    rows.push(row);
    nodeRunsByWorkflowRun.set(row.workflow_run_uid, rows);
  }

  for (const row of records.sourceDocuments) {
    if (row.drama_uid !== manifest.project.dramaUid) invalidManifest();
  }
  for (const row of records.sourceBlocks) {
    if (!documentByUid.has(row.document_uid)) invalidManifest();
  }
  for (const row of records.sourceSelections) {
    const document = documentByUid.get(row.document_uid);
    const start = blockByUid.get(row.start_block_uid);
    const end = blockByUid.get(row.end_block_uid);
    if (!document || !start || !end || start.document_uid !== document.uid || end.document_uid !== document.uid) invalidManifest();
  }
  for (const row of records.workflowDefinitions) {
    if (row.drama_uid !== manifest.project.dramaUid) invalidManifest();
  }
  for (const row of records.canvasNodes) {
    if (!workflowByUid.has(row.workflow_uid)) invalidManifest();
    if ((row.domain_ref_type === null) !== (row.domain_ref_uid === null)) invalidManifest();
    if (row.domain_ref_type !== null) assertTypedReference(typed, row.domain_ref_type, row.domain_ref_uid);
  }
  for (const row of records.canvasEdges) {
    const source = nodeByUid.get(row.source_node_uid);
    const target = nodeByUid.get(row.target_node_uid);
    if (!workflowByUid.has(row.workflow_uid) || !source || !target
      || source.workflow_uid !== row.workflow_uid || target.workflow_uid !== row.workflow_uid) invalidManifest();
  }
  for (const row of records.assets) {
    assertTypedReference(typed, row.owner_type, row.owner_uid);
    if (row.current_version_uid !== null) {
      const current = versionByUid.get(row.current_version_uid);
      if (!current || current.asset_uid !== row.uid) invalidManifest();
    }
  }
  for (const row of records.assetVersions) {
    if (!assetByUid.has(row.asset_uid)) invalidManifest();
    if (row.parent_uid !== null) {
      const parent = versionByUid.get(row.parent_uid);
      if (!parent || parent.asset_uid !== row.asset_uid) invalidManifest();
    }
  }
  for (const row of records.assetVersions) {
    const visited = new Set([row.uid]);
    let parent = row.parent_uid;
    while (parent !== null) {
      if (visited.has(parent)) invalidManifest();
      visited.add(parent);
      parent = versionByUid.get(parent)?.parent_uid ?? null;
    }
  }
  for (const row of records.generationRuns) {
    assertTypedReference(typed, row.owner_type, row.owner_uid);
    if (row.prompt_version_uid !== null) invalidManifest();
    if (row.output_asset_version_uid !== null && !versionByUid.has(row.output_asset_version_uid)) invalidManifest();
  }
  for (const row of records.workflowRuns) {
    if (!workflowByUid.has(row.workflow_uid)) invalidManifest();
    try {
      validateRunAggregate({
        run: workflowRunRecord(row),
        nodes: [...(nodeRunsByWorkflowRun.get(row.uid) || [])]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map(nodeRunRecord),
      });
    } catch {
      invalidManifest();
    }
  }
  for (const row of records.nodeRuns) {
    const run = workflowRunByUid.get(row.workflow_run_uid);
    const node = nodeByUid.get(row.node_uid);
    if (!run || !node || run.workflow_uid !== node.workflow_uid) invalidManifest();
  }
  for (const row of records.exportRuns) {
    if (row.drama_uid !== manifest.project.dramaUid) invalidManifest();
    if (row.workflow_run_uid !== null) {
      const run = workflowRunByUid.get(row.workflow_run_uid);
      if (!run || workflowByUid.get(run.workflow_uid)?.drama_uid !== row.drama_uid) invalidManifest();
    }
    if (row.output_asset_version_uid !== null && !versionByUid.has(row.output_asset_version_uid)) invalidManifest();
  }
}

function deepFreeze(value) {
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child && typeof child === 'object') stack.push(child);
    Object.freeze(current);
  }
  return value;
}

function parseProjectManifest(value) {
  const manifest = assertExactObject(value, ['schemaVersion', 'archiveKind', 'legacyProjectVersion', 'exportedAt', 'project', 'records']);
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.archiveKind !== ARCHIVE_KIND
    || typeof manifest.legacyProjectVersion !== 'string' || manifest.legacyProjectVersion.length < 1
    || manifest.legacyProjectVersion.length > 32 || typeof manifest.exportedAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.exportedAt))) invalidManifest();

  const seen = new Set();
  const project = assertExactObject(manifest.project, ['dramaUid', 'characters', 'scenes', 'props', 'episodes']);
  assertUid(project.dramaUid, seen);
  assertUidArray(project.characters, seen);
  assertUidArray(project.scenes, seen);
  assertUidArray(project.props, seen);
  if (!Array.isArray(project.episodes) || project.episodes.length > MAX_RECORDS) invalidManifest();
  for (const episode of project.episodes) {
    assertExactObject(episode, ['uid', 'storyboards']);
    assertUid(episode.uid, seen);
    assertUidArray(episode.storyboards, seen);
  }

  const records = assertExactObject(manifest.records, RECORD_NAMES);
  let recordCount = 0;
  for (const name of RECORD_NAMES) {
    const rows = records[name];
    if (!Array.isArray(rows)) invalidManifest();
    recordCount += rows.length;
    if (recordCount > MAX_RECORDS) invalidManifest();
    for (const row of rows) assertRecord(row, RECORD_SPECS[name], seen);
  }
  assertManifestClosure(manifest);
  assertNoSecretKeys(manifest);
  return deepFreeze(manifest);
}

function createProjectManifest({ legacyProjectVersion, project, records, exportedAt }) {
  return parseProjectManifest({
    schemaVersion: SCHEMA_VERSION,
    archiveKind: ARCHIVE_KIND,
    legacyProjectVersion: String(legacyProjectVersion || ''),
    exportedAt,
    project,
    records,
  });
}

function assertNoCredentialData(value) {
  assertJsonValue(value);
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20 || current.depth > MAX_STRUCTURED_DEPTH) invalidManifest();
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        if (Array.isArray(child) || isPlainObject(child)) stack.push({ value: child, depth: current.depth + 1 });
        else {
          const nested = nestedJsonContainer(child);
          if (nested !== null) stack.push({ value: nested, depth: current.depth + 1 });
        }
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (isForbiddenSecretKey(key)) throw archiveError('PROJECT_ARCHIVE_SECRET_DETECTED');
      if (Array.isArray(child) || isPlainObject(child)) stack.push({ value: child, depth: current.depth + 1 });
      else {
        const nested = nestedJsonContainer(child);
        if (nested !== null) stack.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
}

function assertNoLocalPathData(value, localRoots) {
  const roots = (Array.isArray(localRoots) ? localRoots : [])
    .filter((root) => typeof root === 'string' && root.trim().length > 0)
    .flatMap((root) => {
      const resolved = root.trim();
      return [resolved, resolved.replace(/\\/g, '/'), resolved.replace(/\//g, '\\')];
    })
    .map((root) => process.platform === 'win32' ? root.toLowerCase() : root);
  const stack = [{ kind: null, value }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_RECORDS * 20) invalidManifest();
    if (typeof current.value === 'string') {
      const text = process.platform === 'win32' ? current.value.toLowerCase() : current.value;
      if (roots.some((root) => text.includes(root))) invalidManifest();
      const nested = nestedJsonContainer(current.value);
      if (nested !== null) stack.push({ kind: current.kind, value: nested });
      else assertPortableFieldKind(current.kind, current.value);
    } else if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ kind: current.kind, value: child });
    } else if (isPlainObject(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        stack.push({ kind: current.kind || portableFieldKind(key), value: child });
      }
    }
  }
}

module.exports = {
  ARCHIVE_KIND,
  RECORD_NAMES,
  RECORD_SPECS,
  SCHEMA_VERSION,
  assertNoCredentialData,
  assertNoLocalPathData,
  createTypedUidSets,
  createProjectManifest,
  parseProjectManifest,
};
