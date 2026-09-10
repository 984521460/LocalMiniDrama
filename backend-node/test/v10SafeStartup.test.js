"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safe-start-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, startup: { mode: "offline-safe", dataRoot: root, config: { app: { name: "Synthetic safe appli\
cation", version: "test" }, server: { host: "127.0.0.1", port: 5830, insecure_tls: false }, database: { type: "\
sqlite", path: path.join(root, "db/test.sqlite") }, storage: { local_path: path.join(root, "storage") } } } };
}
test("explicit offline-safe startup rejects absent data scope before configuration fallback", () => {
  const { resolveStartup } = require("../src/startup/startupPolicy");
  assert.throws(() => resolveStartup({ mode: "offline-safe" }), { code: "STARTUP_POLICY_INVALID" });
});
test("both DB/storage overlap directions and inherited accessors reject before creating files", (t) => {
  const { resolveStartup } = require("../src/startup/startupPolicy");
  const f = setup(t);
  for (const [db, storage] of [[path.join(f.root, "data/file"), path.join(f.root, "data")], [path.join(f.root,
  "data"), path.join(f.root, "data/sub")]]) {
    const s = structuredClone(f.startup);
    s.config.database.path = db;
    s.config.storage.local_path = storage;
    assert.throws(() => resolveStartup(s), { code: "STARTUP_POLICY_INVALID" });
  }
  const invalid = { ...f.startup };
  Object.defineProperty(invalid, "config", { enumerable: true, get() {
    assert.fail("getter executed");
  } });
  assert.throws(() => resolveStartup(invalid), { code: "STARTUP_POLICY_INVALID" });
  assert.equal(fs.existsSync(path.join(f.root, "data")), false);
});
test("native createApp safe startup preserves pending external work and rejects dangerous GET/POST", async (t) => {
  const f = setup(t);
  const { createApp } = require("../src/app");
  const { closeDb } = require("../src/db");
  const video = require("../src/services/videoService");
  const old = video.resumeProcessingVideoGenerations;
  let polls = 0;
  video.resumeProcessingVideoGenerations = () => {
    polls++;
    throw Error("must not poll");
  };
  let first;
  try {
    first = createApp({ startup: f.startup, remoteDependencies: new Proxy({}, { ownKeys() {
      assert.fail("external dependencies consulted");
    } }) });
    await first.startupRecoveryPromise;
    first.db.prepare("INSERT INTO dramas(title) VALUES ('synthetic')").run();
    first.db.prepare("INSERT INTO video_generations(drama_id,provider,prompt,status,provider_task_id) VALUES (\
1,'synthetic','synthetic','processing','already-submitted')").run();
    closeDb();
    const second = createApp({ startup: f.startup });
    assert.equal((await second.startupRecoveryPromise).status, "disabled_offline_safe");
    assert.equal(polls, 0);
    assert.equal(second.db.prepare("SELECT status FROM video_generations").pluck().get(), "processing");
    const server = await new Promise((resolve) => {
      const s = second.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const [method, url] of [["GET", "/api/v1/storyboards/episode/1/generate"], ["GET", "/api/v1/dramas/\
1/export"], ["POST", "/api/v1/v2/dramas/1/characters/00000000-0000-4000-8000-000000000001/candidate-executions"]]) {
        const r = await fetch(base + url, { method, headers: { "content-type": "application/json" }, ...method ===
        "POST" ? { body: '{"mode":"normal"}' } : {} });
        assert.equal(r.status, 403);
        assert.equal((await r.json()).error.code, "OFFLINE_SAFE_MODE");
      }
      const read = await fetch(base + "/api/v1/dramas/1");
      assert.equal(read.status, 200);
      assert.ok((await read.json()).data.uid);
      for (const method of ['GET', 'HEAD']) {
        for (const route of ['/API/v1/ai-configs', '/aPi/V1/AI-Configs',
          '/API/v1/storyboards/episode/1/generate', '/aPi/v1/dramas/1/export']) {
          const blocked = await fetch(base + route, { method, headers: { Origin: 'http://127.0.0.1:5831' } });
          assert.equal(blocked.status, 403, `${method} ${route}`);
          if (method === 'GET') assert.equal((await blocked.json()).error.code, 'OFFLINE_SAFE_MODE');
          else assert.equal(await blocked.text(), '');
        }
      }
      const caps = await (await fetch(base + "/api/v1/runtime-capabilities")).json();
      assert.equal(caps.data.mode, "offline-safe");
      fs.writeFileSync(path.join(f.startup.config.storage.local_path, 'local-only.txt'), 'synthetic local data');
      for (const route of ['/api/v1/dramas/1', '/static/local-only.txt']) {
        for (const headers of [{ Origin: 'https://evil.invalid' }, { Host: 'evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
          const blocked = await new Promise((resolve, reject) => {
            require('node:http').get(base + route, { headers }, response => {
              response.resume(); response.on('end', () => resolve(response));
            }).on('error', reject);
          });
          assert.equal(blocked.statusCode, 403, `${route} ${Object.keys(headers)[0]}`);
          assert.equal(blocked.headers['access-control-allow-origin'], undefined);
        }
        const local = await fetch(base + route, { headers: { Origin: 'http://127.0.0.1:5831' } });
        assert.equal(local.status, 200);
        assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5831');
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      closeDb();
    }
  } finally {
    video.resumeProcessingVideoGenerations = old;
    closeDb();
  }
});
test("singleton refuses a different database or startup mode without opening another path", (t) => {
  const f = setup(t);
  const { getDb, closeDb } = require("../src/db");
  try {
    getDb({ path: f.startup.config.database.path, type: "sqlite" });
    const other = path.join(f.root, "other/new.sqlite");
    assert.throws(() => getDb({ path: other, type: "sqlite" }, { mode: "offline-safe" }), { code: "DATABASE_BI\
NDING_CONFLICT" });
    assert.throws(() => getDb({ path: f.startup.config.database.path, type: "sqlite" }, { mode: "offline-safe" }),
    { code: "DATABASE_BINDING_CONFLICT" });
    assert.equal(fs.existsSync(other), false);
  } finally {
    closeDb();
  }
});

test('UNC, device namespaces and a volume root fail before any file probe',t=>{
 const f=setup(t);const {resolveStartup,startupFromEnvironment}=require('../src/startup/startupPolicy');
 const original=fs.lstatSync,read=fs.readFileSync;let io=0;
 fs.lstatSync=()=>{io++;throw Error('unexpected stat')};fs.readFileSync=()=>{io++;throw Error('unexpected read')};
 try{
  for(const unsafe of ['\\\\blocked.invalid\\share','\\\\?\\C:\\unsafe','\\\\.\\C:\\unsafe']){
   for(const field of ['dataRoot','database','storage']){const value=structuredClone(f.startup);if(field==='dataRoot')value.dataRoot=unsafe;else if(field==='database')value.config.database.path=unsafe;else value.config.storage.local_path=unsafe;assert.throws(()=>resolveStartup(value),{code:'STARTUP_POLICY_INVALID'});}
   assert.throws(()=>startupFromEnvironment({LMD_STARTUP_MODE:'offline-safe',LMD_DATA_ROOT:f.root,LMD_SAFE_CONFIG:unsafe}),{code:'STARTUP_POLICY_INVALID'});
  }
  assert.throws(()=>resolveStartup({...f.startup,dataRoot:path.parse(f.root).root}),{code:'STARTUP_POLICY_INVALID'});assert.equal(io,0);
 }finally{fs.lstatSync=original;fs.readFileSync=read;}
});
