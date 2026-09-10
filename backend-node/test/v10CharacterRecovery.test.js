"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createMigratedV2Database, uid } = require("./helpers/v2RepositoryDatabase");
const { seedApprovedCharacterSource, executionRequest } = require("./helpers/v10CollectionFixture");
const { createProductionCharacterCandidateExecutionRuntime } = require("../src/characterCandidates/execution/p\
roductionRuntime");
const { createV2Repositories } = require("../src/repositories/v2");
async function fixture(t, { failOrdinal = 1 } = {}) {
  const database = createMigratedV2Database(t);
  const { ids, repositories } = await seedApprovedCharacterSource(database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "character-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connection = repositories.remote.createConnection({ uid: uid(41e3), name: "synthetic", host: "offline.\
invalid", port: 22, username: "test", hostFingerprint: `SHA256:${"A".repeat(43)}`, credentialRef: `credential:\
v1:${uid(41001)}`, status: "ready", authMethod: "password", sshPublicKey: null, comfyHost: "127.0.0.1", comfyPort: 8188,
  remoteWorkDir: "synthetic" });
  const profile = { enabled: true, connectionUid: connection.uid, checkpointName: "synthetic.safetensors", samplerName: "\
euler", scheduler: "normal", steps: 20, cfg: 6, negativePrompt: "" };
  const pngs = await Promise.all([0, 1, 2, 3].map((i) => sharp({ create: { width: 256, height: 256, channels: 3,
  background: { r: 40 + i * 30, g: 70, b: 100 } } }).png().toBuffer()));
  const remote = /* @__PURE__ */ new Map();
  let submits = 0, downloads = 0, fail = true;
  const gateway = { async run(_uid, _evidence, callback) {
    return callback({
      async objectInfo() {
        return { CheckpointLoaderSimple: { input: { required: { ckpt_name: [[profile.checkpointName]] } } }, CLIPTextEncode: {},
        EmptyLatentImage: {}, KSampler: {}, VAEDecode: {}, SaveImage: {} };
      },
      async submitPrompt(prompt) {
        submits++;
        const prefix = prompt[7].inputs.filename_prefix;
        const ordinal = Number(prefix.split("/").at(-1));
        const promptId = `accepted-${submits}`;
        remote.set(promptId, { ordinal, subfolder: prefix.split("/").slice(0, -1).join("/") });
        return { promptId };
      },
      async waitForPrompt(promptId) {
        const job = remote.get(promptId);
        if (!job) throw Error("unknown synthetic prompt");
        return { promptId, state: "succeeded", outputs: [{ nodeId: "7", mediaKind: "image", fileName: `${job.ordinal}\
_00002_.png`, subfolder: job.subfolder, storageType: "output" }] };
      },
      async downloadOutput(output) {
        downloads++;
        const ordinal = Number(output.fileName[0]);
        if (fail && ordinal === failOrdinal) throw Error("synthetic download disconnected");
        return pngs[ordinal];
      }
    });
  } };
  const runtime = () => createProductionCharacterCandidateExecutionRuntime({ database, localRoot: root, dependencies: {
  remoteComfyUi: { repository: createV2Repositories(database).remote, gateway, profile } } }).characterCandidates;
  return { database, repositories, ids, root, request: executionRequest(ids), runtime, profile, pngs, allowDownload() {
    fail = false;
  }, counts: () => ({ submits, downloads }) };
}
test("normal remote generation retains first image, restarts and only collects accepted partial jobs", async (t) => {
  const f = await fixture(t);
  const first = await f.runtime().execute(f.request);
  assert.equal(first.receivedCount, 1);
  assert.equal(first.state, "recoverable");
  assert.deepEqual(f.counts(), { submits: 2, downloads: 2 });
  assert.equal(f.database.prepare("SELECT count(*) FROM assets WHERE asset_type='character_candidate'").pluck().
  get(), 1);
  assert.equal(f.database.prepare("SELECT count(*) FROM character_candidate_batches").pluck().get(), 0);
  f.repositories.characterCandidateExecutions.recoverInterrupted();
  assert.equal(f.repositories.characterCandidateExecutions.get(f.request.operationUid).state, "reserved");
  f.allowDownload();
  const second = await f.runtime().recover(f.request.operationUid);
  assert.equal(second.receivedCount, 2);
  assert.equal(second.state, "partial");
  assert.equal(second.batchReady, false);
  await f.runtime().recover(f.request.operationUid);
  await f.runtime().execute(f.request);
  assert.equal(f.counts().submits, 2);
  assert.deepEqual(second.jobs.map((j) => j.state), ["collected", "collected", "not_submitted", "not_submitted"]);
  assert.equal(f.database.prepare("SELECT count(*) FROM character_identity_lock_events").pluck().get(), 0);
  assert.equal(f.database.prepare("SELECT count(*) FROM assets WHERE asset_type='character_candidate' AND curr\
ent_version_uid IS NOT NULL").pluck().get(), 0);
  assert.equal(f.repositories.projectArchives.exportStructuredV21(f.ids.drama).characterRemoteCollections.length,
  1);
});
test("fourth download recovery seals the original normal batch without a fifth submit or identity lock", async (t) => {
  const f = await fixture(t, { failOrdinal: 3 });
  const first = await f.runtime().execute(f.request);
  assert.equal(first.receivedCount, 3);
  assert.equal(f.counts().submits, 4);
  f.allowDownload();
  const restored = await f.runtime().recover(f.request.operationUid);
  assert.equal(restored.batchReady, true);
  assert.equal(restored.receivedCount, 4);
  const standard = await f.runtime().get(f.request.operationUid);
  assert.equal(standard.execution.state, "succeeded");
  assert.equal(standard.batch.candidates.length, 4);
  await f.runtime().recover(f.request.operationUid);
  assert.equal(f.counts().submits, 4);
  assert.equal(f.database.prepare("SELECT count(*) FROM character_candidate_batches").pluck().get(), 1);
  assert.equal(f.database.prepare("SELECT count(*) FROM character_identity_lock_events").pluck().get(), 0);
});
test("unknown existing bytes are preserved; correct installed-before-commit file can be reused", async (t) => {
  const f = await fixture(t, { failOrdinal: 0 });
  await f.runtime().execute(f.request);
  const target = path.join(f.root, `characters/${f.ids.character}/candidate-batches/${f.request.operationUid}/\
0.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "unowned bytes");
  f.allowDownload();
  const refused = await f.runtime().recover(f.request.operationUid);
  assert.equal(refused.receivedCount, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "unowned bytes");
  assert.equal(f.counts().submits, 1);
  /*! Test-owned replacement models a prior successful installation with no DB commit. */
  const normalized = await require("../src/characterCandidates/execution/imageNormalizer").createCharacterCandidateImageNormalizer()(
  f.pngs[0], 256, 256);
  fs.writeFileSync(target, normalized.bytes);
  const recovered = await f.runtime().recover(f.request.operationUid);
  assert.equal(recovered.receivedCount, 1);
  assert.deepEqual(fs.readFileSync(target), normalized.bytes);
  assert.equal(f.counts().submits, 1);
});
test("configuration drift and ambiguous submission never cause resubmission", async (t) => {
  const f = await fixture(t);
  await f.runtime().execute(f.request);
  const before = f.counts();
  f.profile.cfg = 7;
  await assert.rejects(f.runtime().recover(f.request.operationUid), { code: "CHARACTER_COLLECTION_BINDING_CHAN\
GED" });
  assert.deepEqual(f.counts(), before);
});
test("accepted submit with failed acknowledgement commit stays unknown across a fresh runtime", async (t) => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER synthetic_ack_failure BEFORE UPDATE ON character_remote_collection_jobs WHEN\
 NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'synthetic ack disk failure'); END");
  const result = await f.runtime().execute(f.request);
  assert.equal(result.state, "submission_unknown");
  assert.equal(result.receivedCount, 0);
  assert.equal(f.counts().submits, 1);
  f.database.exec("DROP TRIGGER synthetic_ack_failure");
  f.allowDownload();
  const retry = await f.runtime().recover(f.request.operationUid);
  assert.equal(retry.canRecover, false);
  assert.equal(retry.state, "submission_unknown");
  assert.deepEqual(f.counts(), { submits: 1, downloads: 0 });
});
test("concurrent recovery has one writer and offline native runtime shows partial media without checking remot\
e configuration", async (t) => {
  const f = await fixture(t);
  await f.runtime().execute(f.request);
  f.allowDownload();
  const responses = await Promise.allSettled([f.runtime().recover(f.request.operationUid), f.runtime().recover(
  f.request.operationUid)]);
  assert.equal(responses.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.counts().submits, 2);
  const offline = require("../src/startup/offlineRuntime").createOfflineRuntime({ database: f.database, localRoot: f.
  root });
  const list = await offline.characterCandidates.listRecoveries({ dramaUid: f.ids.drama, characterUid: f.ids.character });
  assert.equal(list.records[0].receivedCount, 2);
  assert.equal(list.records[0].sourceCurrent, true);
  assert.equal(list.records[0].connectionCurrent, null);
  assert.equal(list.records[0].canRecover, false);
});
test("two actual processes recover the same accepted jobs after the generation process is terminated", async (t) => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const f = await fixture(t);
  const dbPath = path.join(f.root, "restart.sqlite");
  await f.database.backup(dbPath);
  const configPath = path.join(f.root, "child-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ dbPath, root: f.root, request: f.request, profile: f.profile }));
  const childFile = path.join(__dirname, "helpers/v10RecoveryChild.cjs");
  let child = fork(childFile, ["generate", configPath], { windowsHide: true, stdio: ["ignore", "ignore", "igno\
re", "ipc"] });
  try {
    assert.equal((await once(child, "message"))[0], "download-blocked");
    const done = once(child, "exit");
    child.kill();
    await done;
    child = fork(childFile, ["recover", configPath], { windowsHide: true, stdio: ["ignore", "ignore", "ignore",
    "ipc"] });
    const [result] = await once(child, "message");
    assert.equal(result.receivedCount, 2);
    assert.equal(result.state, "partial");
    await once(child, "exit");
    const counts = JSON.parse(fs.readFileSync(path.join(f.root, "remote-counts.json")));
    assert.equal(counts.submits, 2);
    assert.equal(counts.downloads, 3);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
  }
});
test("partial collection survives a real project ZIP round trip but imported binding can never execute", async (t) => {
  const f = await fixture(t);
  await f.runtime().execute(f.request);
  require("../src/db/migrate").runMigrationsAndEnsure(f.database);
  const zipService = require("../src/services/projectZipService");
  const log = { info() {
  }, error() {
  }, warn() {
  }, errorw() {
  } };
  const exported = zipService.exportDrama(f.database, { storage: { local_path: f.root } }, log, 1);
  const Database = require("better-sqlite3");
  const destination = new Database(":memory:");
  t.after(() => destination.close());
  require("../src/db/migrate").runMigrationsAndEnsure(destination);
  const target = path.join(f.root, "restored");
  fs.mkdirSync(target);
  zipService.importDrama(destination, { storage: { local_path: target } }, log, exported.buffer);
  const repos = createV2Repositories(destination);
  assert.equal(repos.characterRemoteCollections.get(f.request.operationUid).bindingState, "needs_rebind");
  const offline = require("../src/startup/offlineRuntime").createOfflineRuntime({ database: destination, localRoot: target });
  const first = await offline.characterCandidates.listRecoveries({ dramaUid: f.ids.drama, characterUid: f.ids.
  character });
  assert.equal(first.records[0].receivedCount, 1);
  assert.equal(first.records[0].canRecover, false);
  assert.equal(first.records[0].sourceCurrent, true);
  assert.deepEqual(await offline.characterCandidates.listRecoveries({ dramaUid: f.ids.drama, characterUid: f.ids.
  character }), first);
  const attempted = require("../src/characterCandidates/execution/remoteCollectionService").createRemoteCollectionService(
  { repositories: repos, storage: new (require("../src/adapters/v2/storage/localStorageProvider")).LocalStorageProvider(
  { projectRoot: target }), provider: { recoveryBinding() {
    throw Error("must not check remote");
  }, submit() {
    assert.fail("must not submit");
  }, collect() {
    assert.fail("must not collect");
  } } });
  await assert.rejects(attempted.recover(f.request.operationUid), { code: "CHARACTER_COLLECTION_REBIND_REQUIRE\
D" });
  const AdmZip = require("adm-zip");
  const malicious = new AdmZip(exported.buffer);
  const manifest = JSON.parse(malicious.readAsText("v2/manifest.json"));
  manifest.structuredRecords.characterRemoteCollections[0].binding_state = "bound";
  malicious.updateFile("v2/manifest.json", Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => zipService.importDrama(destination, { storage: { local_path: target } }, log, malicious.
  toBuffer()));
});
