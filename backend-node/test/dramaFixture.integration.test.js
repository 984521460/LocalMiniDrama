'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { importDrama } = require('../src/services/dramaImportService');
const { exportDrama } = require('../src/services/dramaExportService');

const fixturePath = path.join(__dirname, 'fixtures', 'minimal-project', 'project.json');

function createZip(projectJson) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(projectJson, 'utf8'));
  return zip.toBuffer();
}

test('minimal text-only fixture survives import, export, and re-import', (t) => {
  const rawFixture = fs.readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(rawFixture);
  const tempPrefix = path.join(os.tmpdir(), 'local-mini-drama-fixture-');
  const tempRoot = fs.mkdtempSync(tempPrefix);
  const storagePath = path.join(tempRoot, 'storage');
  const databasePath = path.join(tempRoot, 'fixture.sqlite');
  const db = new Database(databasePath);
  const logs = [];
  const log = {
    info(message, fields) { logs.push(['info', message, fields]); },
    warn(message, fields) { logs.push(['warn', message, fields]); },
    error(message, fields) { logs.push(['error', message, fields]); },
  };
  const cfg = { storage: { local_path: storagePath } };
  t.after(() => {
    db.close();
    const resolved = path.resolve(tempRoot);
    assert.equal(resolved.startsWith(path.resolve(tempPrefix)), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  assert.equal(Buffer.byteLength(rawFixture, 'utf8') < 20_000, true);
  assert.doesNotMatch(rawFixture, /https:\/\/git-lfs\.github\.com\/spec\/v1/);
  assert.equal(fixture.version, '1.4');
  assert.equal(fixture.episodes.length, 1);
  assert.equal(fixture.episodes[0].storyboards.length, 1);

  runMigrationsAndEnsure(db);
  const first = importDrama(db, cfg, log, createZip(rawFixture));

  assert.equal(first.title, fixture.drama.title);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dramas').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM episodes').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storyboards').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM characters').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scenes').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM props').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM frame_prompts').get().count, 1);

  const exported = exportDrama(db, cfg, log, first.drama_id);
  const exportedZip = new AdmZip(exported.buffer);
  const entryNames = exportedZip.getEntries().map((entry) => entry.entryName).sort();
  const roundTrip = JSON.parse(exportedZip.readAsText('project.json'));

  assert.deepEqual(entryNames, ['project.json']);
  assert.equal(roundTrip.drama.title, fixture.drama.title);
  assert.equal(roundTrip.episodes[0].script_content, fixture.episodes[0].script_content);
  assert.equal(roundTrip.episodes[0].storyboards[0].dialogue, fixture.episodes[0].storyboards[0].dialogue);
  assert.deepEqual(roundTrip.episodes[0].storyboards[0].character_indices, [0]);
  assert.equal(roundTrip.episodes[0].storyboards[0].scene_index, 0);
  assert.deepEqual(roundTrip.episodes[0].storyboards[0].prop_indices, [0]);
  assert.equal(roundTrip.episodes[0].storyboards[0].frame_prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(roundTrip), /api[_-]?key|access[_-]?token|password|private[_-]?key/i);

  const second = importDrama(db, cfg, log, exported.buffer);
  assert.equal(second.title, `${fixture.drama.title} 导入1`);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dramas').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storyboards').get().count, 2);
  assert.doesNotMatch(JSON.stringify(logs), /api[_-]?key|access[_-]?token|password|private[_-]?key/i);
});
