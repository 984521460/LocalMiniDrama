"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { canonicalCharacterCandidateExecutionRequest, parseCharacterCandidateExecutionRequest } = require("./re\
quest");
const { createCharacterCandidateSourceResolver } = require("./sourceResolver");
const { createCharacterCandidatePrompt } = require("./prompt");
const { createCharacterCandidateImageNormalizer } = require("./imageNormalizer");
const { createQuarantineAssetInstaller } = require("../../remoteAssets/quarantineAssetInstaller");
const { V2RepositoryNotFoundError } = require("../../repositories/v2/errors");
const { PROFILE, PROFILE_JSON, PROFILE_SHA256, MANIFEST, MANIFEST_JSON, MANIFEST_SHA256 } = require("./profile");
const { createCharacterCandidateBatch } = require("../../assets/characterCandidateBatch");
const hash = (b) => createHash("sha256").update(b).digest("hex");
function fail(code) {
  const e = new Error("Character output collection requires attention");
  e.code = code;
  throw e;
}
function createRemoteCollectionService({ repositories, storage, provider, createUid = randomUUID, recoveryEnabled = true }) {
  const repo = repositories.characterRemoteCollections, resolver = createCharacterCandidateSourceResolver({ repositories });
  const normalize = createCharacterCandidateImageNormalizer(), installer = createQuarantineAssetInstaller({ repositories,
  storage, createUid });
  function current(op) {
    if (op.bindingState !== "bound") fail("CHARACTER_COLLECTION_REBIND_REQUIRED");
    let source;
    try {
      source = resolver.resolve(op.request);
      if (source.sourceSha256 !== op.sourceSha256 || JSON.stringify(provider.recoveryBinding()) !== JSON.stringify(
      op.binding)) fail("CHARACTER_COLLECTION_BINDING_CHANGED");
    } catch {
      fail("CHARACTER_COLLECTION_BINDING_CHANGED");
    }
    return source;
  }
  function command(op, ordinal) {
    const source = current(op);
    const seed = (op.request.seed + ordinal * 2654435761) % 4294967296;
    const prompt = createCharacterCandidatePrompt(source.source, ordinal, seed);
    return { schemaVersion: "character-candidate-generation-command.v1", operationUid: op.request.operationUid,
    ordinal, prompt: prompt.prompt, promptSha256: prompt.promptSha256, width: op.request.width, height: op.request.
    height, seed };
  }
  function locator(op, ordinal) {
    const relativePath = `characters/${op.request.characterUid}/candidate-batches/${op.request.operationUid}/${ordinal}\
.png`;
    return { storageProvider: "local", relativePath, logicalUri: `asset://characters/${op.request.characterUid}\
/candidate-batches/${op.request.operationUid}/${ordinal}` };
  }
  async function view(op) {
    let sourceCurrent = true;
    try {
      sourceCurrent = resolver.resolve(op.request).sourceSha256 === op.sourceSha256;
    } catch {
      sourceCurrent = false;
    }
    let connectionCurrent = null;
    if (recoveryEnabled) {
      try {
        connectionCurrent = op.bindingState === "bound" && JSON.stringify(provider.recoveryBinding()) === JSON.
        stringify(op.binding);
      } catch {
        connectionCurrent = false;
      }
    }
    const items = [], batchReady = repo.isComplete(op.request.operationUid);
    for (const job of op.jobs) {
      if (job.state !== "collected") continue;
      const item = job.item, expected = locator(op, job.ordinal);
      const asset = repositories.assets.get(item.assetUid), version = repositories.assets.getVersion(item.assetVersionUid);
      if (item.relativePath !== expected.relativePath || item.logicalUri !== expected.logicalUri || asset.ownerUid !==
      op.request.characterUid || asset.ownerType !== "character" || asset.assetType !== "character_candidate" ||
      asset.status !== (batchReady ? "ready" : "draft") || asset.currentVersionUid !== (batchReady ? item.assetVersionUid :
      null) || version.assetUid !== asset.uid || version.relativePath !== expected.relativePath || version.logicalUri !==
      expected.logicalUri || version.sha256 !== item.contentSha256 || version.status !== "ready" || version.width !==
      op.request.width || version.height !== op.request.height) fail("CHARACTER_COLLECTION_DATA_INVALID");
      const bytes = await storage.readBounded(expected, 16 * 1024 * 1024);
      if (bytes.length !== item.byteLength || hash(bytes) !== item.contentSha256) fail("CHARACTER_COLLECTION_D\
ATA_INVALID");
      items.push({ ordinal: job.ordinal, assetUid: item.assetUid, assetVersionUid: item.assetVersionUid, logicalUri: item.
      logicalUri, relativePath: item.relativePath, contentSha256: item.contentSha256, byteLength: item.byteLength,
      width: item.width, height: item.height });
    }
    const unknown = op.jobs.some((j) => j.state === "submitting");
    return Object.freeze({
      schemaVersion: "character-candidate-recovery.v1",
      operationUid: op.request.operationUid,
      dramaUid: op.request.dramaUid,
      characterUid: op.request.characterUid,
      requestedCount: 4,
      receivedCount: items.length,
      state: items.length === 4 ? "collected" : unknown ? "submission_unknown" : op.jobs.some((j) => ["submitt\
ed", "output_bound"].includes(j.state)) ? "recoverable" : "partial",
      sourceCurrent,
      bindingState: op.bindingState,
      connectionCurrent,
      recoveryEnabled,
      batchReady,
      canRecover: recoveryEnabled && sourceCurrent && connectionCurrent === true && (op.jobs.some((j) => ["sub\
mitted", "output_bound"].includes(j.state)) || items.length === 4 && !batchReady),
      quarantineStatus: "unapproved",
      jobs: Array.from({ length: 4 }, (_, ordinal) => ({ ordinal, state: op.jobs.find((j) => j.ordinal === ordinal)?.
      state || "not_submitted" })),
      items
    });
  }
  async function collectOne(op, ordinal) {
    const job = repo.get(op.request.operationUid).jobs.find((j) => j.ordinal === ordinal);
    if (!job || !["submitted", "output_bound"].includes(job.state)) return;
    const input = command(op, ordinal);
    if (input.promptSha256 !== job.promptSha256) fail("CHARACTER_COLLECTION_BINDING_CHANGED");
    const result = await provider.collect(input, op.binding, job.promptId, (output) => {
      current(op);
      repo.bindOutput(op.request.operationUid, ordinal, output);
    });
    current(op);
    const normalized = await normalize(result.bytes, op.request.width, op.request.height);
    const target = locator(op, ordinal);
    if (repo.pathHasVersion(target.relativePath)) fail("CHARACTER_COLLECTION_FILE_CONFLICT");
    await installer.install({
      ownerType: "character",
      ownerUid: op.request.characterUid,
      assetType: "character_candidate",
      reuseVerifiedFile: true,
      items: [async () => ({ bytes: normalized.bytes, width: normalized.width, height: normalized.height, mimeType: "\
image/png", durationMs: null })],
      destination: () => target,
      complete(scoped, items) {
        current(op);
        scoped.characterRemoteCollections.collected(op.request.operationUid, ordinal, { ...items[0], ordinal, bytes: items[0].
        byteLength, candidateUid: createUid(), seed: input.seed, promptSha256: input.promptSha256, provider: result.
        provider, model: result.model, parametersJson: JSON.stringify(result.parameters) });
        return null;
      }
    });
  }
  async function seal(op) {
    if (repo.isComplete(op.request.operationUid)) return;
    if (op.jobs.length !== 4 || op.jobs.some((j) => j.state !== "collected")) return;
    await view(op);
    current(op);
    const items = op.jobs.map((j) => j.item), r = op.request;
    const batch = createCharacterCandidateBatch(
      { schemaVersion: "5.0", batchUid: r.operationUid, characterUid: r.characterUid, promptSemanticUid: r.extractionResultUid,
      profileUid: PROFILE.uid, manifestUid: MANIFEST.uid, width: r.width, height: r.height, seed: r.seed, candidateCount: 4 },
      { candidates: items.map((item) => ({ uid: item.candidateUid, ordinal: item.ordinal, assetVersionUid: item.
      assetVersionUid, logicalUri: item.logicalUri, mediaType: "image/png", width: r.width, height: r.height, contentSha256: item.
      contentSha256, presentation: "single_portrait" })) }
    );
    repositories.withTransaction((scoped) => {
      current(op);
      for (const item of items) scoped.assets.setCurrentVersion(item.assetUid, item.assetVersionUid);
      const stored = scoped.characterCandidates.appendBatch(batch);
      scoped.characterCandidateExecutions.complete(r.operationUid, stored.batchUid, items);
    });
  }
  function completedResult(uid) {
    return { execution: repositories.characterCandidateExecutions.get(uid), batch: repositories.characterCandidates.
    getBatch(uid) };
  }
  async function owned(uid, action) {
    const lease = repositories.recoveryActivity.acquire(`remote/${uid}`);
    if (!lease) fail("CHARACTER_COLLECTION_IN_PROGRESS");
    try {
      return await action();
    } finally {
      lease.release();
    }
  }
  return Object.freeze({
    async execute(value) {
      if (!recoveryEnabled) fail("OFFLINE_SAFE_MODE");
      const request = parseCharacterCandidateExecutionRequest(value), json = canonicalCharacterCandidateExecutionRequest(
      request);
      return owned(request.operationUid, async () => {
        const old = repo.get(request.operationUid);
        if (old) {
          if (old.requestSha256 !== hash(json)) fail("CHARACTER_COLLECTION_CONFLICT");
          return repo.isComplete(request.operationUid) ? completedResult(request.operationUid) : view(old);
        }
        try {
          repositories.characterCandidateExecutions.get(request.operationUid);
          fail("CHARACTER_COLLECTION_LEGACY_UNKNOWN");
        } catch (e) {
          if (!(e instanceof V2RepositoryNotFoundError)) throw e;
        }
        const source = resolver.resolve(request);
        let op;
        repositories.withTransaction((scoped) => {
          scoped.characterCandidateExecutions.reserve({ request, requestSha256: hash(json), source: source.source,
          sourceSha256: source.sourceSha256, profileJson: PROFILE_JSON, profileSha256: PROFILE_SHA256, manifestJson: MANIFEST_JSON,
          manifestSha256: MANIFEST_SHA256 });
          op = scoped.characterRemoteCollections.create(json, source.sourceSha256, provider.recoveryBinding(),
          source.source);
        });
        for (let ordinal = 0; ordinal < 4; ordinal++) {
          try {
            const input = command(op, ordinal);
            repo.begin(request.operationUid, ordinal, input.promptSha256);
            const promptId = await provider.submit(input, op.binding);
            repo.accepted(request.operationUid, ordinal, promptId);
            await collectOne(op, ordinal);
          } catch {
            break;
          }
        }
        const latest = repo.get(request.operationUid);
        await seal(latest);
        return repo.isComplete(request.operationUid) ? completedResult(request.operationUid) : view(latest);
      });
    },
    async recover(uid) {
      if (!recoveryEnabled) fail("OFFLINE_SAFE_MODE");
      if (typeof uid !== "string" || !/^[0-9a-f-]{36}$/u.test(uid)) fail("CHARACTER_COLLECTION_INPUT_INVALID");
      return owned(uid, async () => {
        const op = repo.get(uid);
        if (!op) fail("CHARACTER_COLLECTION_NOT_FOUND");
        current(op);
        for (const job of op.jobs) {
          if (["submitted", "output_bound"].includes(job.state)) {
            try {
              await collectOne(op, job.ordinal);
            } catch {
              break;
            }
          }
        }
        const latest = repo.get(uid);
        await seal(latest);
        return view(latest);
      });
    },
    async get(uid) {
      const op = repo.get(uid);
      if (!op) fail("CHARACTER_COLLECTION_NOT_FOUND");
      return view(op);
    },
    async list({ dramaUid, characterUid }) {
      return { schemaVersion: "character-candidate-recovery-list.v1", records: await Promise.all(repo.list(dramaUid,
      characterUid).map(view)) };
    }
  });
}
module.exports = { createRemoteCollectionService };
