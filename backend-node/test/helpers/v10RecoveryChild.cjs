"use strict";
const fs = require("node:fs"), path = require("node:path"), Database = require("better-sqlite3"), sharp = require(
"sharp");
const c = JSON.parse(fs.readFileSync(process.argv[3]));
const mode = process.argv[2];
const db = new Database(c.dbPath);
require("../../src/db/v2/sqlFunctions").registerV2SqlFunctions(db);
const countFile = path.join(c.root, "remote-counts.json");
const counts = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile)) : { submits: 0, downloads: 0 };
function save() {
  fs.writeFileSync(countFile, JSON.stringify(counts));
}
const gateway = { async run(_uid, _evidence, callback) {
  return callback({
    async objectInfo() {
      return { CheckpointLoaderSimple: { input: { required: { ckpt_name: [[c.profile.checkpointName]] } } }, CLIPTextEncode: {},
      EmptyLatentImage: {}, KSampler: {}, VAEDecode: {}, SaveImage: {} };
    },
    async submitPrompt() {
      if (mode === "recover") throw Error("Recovery attempted a new submission");
      counts.submits++;
      save();
      return { promptId: `accepted-${counts.submits}` };
    },
    async waitForPrompt(promptId) {
      return { promptId, state: "succeeded", outputs: [{ nodeId: "7", mediaKind: "image", fileName: `${Number(
      promptId.split("-")[1]) - 1}_00002_.png`, subfolder: `character-candidates/${c.request.operationUid}`, storageType: "\
output" }] };
    },
    async downloadOutput(output) {
      counts.downloads++;
      save();
      const ordinal = Number(output.fileName[0]);
      if (mode === "generate" && ordinal === 1) {
        process.send("download-blocked");
        setInterval(() => {
        }, 1e3);
        await new Promise(() => {
        });
      }
      return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40 + ordinal * 30, g: 70,
      b: 100 } } }).png().toBuffer();
    }
  });
} };
const repositories = require("../../src/repositories/v2").createV2Repositories(db);
const runtime = require("../../src/characterCandidates/execution/productionRuntime").createProductionCharacterCandidateExecutionRuntime(
{ database: db, localRoot: c.root, dependencies: { remoteComfyUi: { repository: repositories.remote, gateway, profile: c.
profile } } }).characterCandidates;
Promise.resolve(mode === "generate" ? runtime.execute(c.request) : runtime.recover(c.request.operationUid)).then(
(result) => {
  process.send({ receivedCount: result.receivedCount, state: result.state });
  db.close();
  process.disconnect();
}).catch(() => {
  db.close();
  process.exit(1);
});
