'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const {
  LEGACY_RECORD_SPECS,
  createProjectArchiveV21LegacyData,
  validateProjectLegacyRecords,
} = require('../src/adapters/v2/compat/projectArchiveV21LegacyData');
const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function createDatabase(t) {
  const database = new Database(':memory:');
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    runMigrationsAndEnsure(database);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  t.after(() => {
    if (database.open) database.close();
  });
  return database;
}

function insertCore(database, offset, title) {
  const dramaUid = uid(offset);
  const episodeUid = uid(offset + 1);
  const characterUid = uid(offset + 2);
  const sceneUid = uid(offset + 3);
  const propUid = uid(offset + 4);
  const storyboardUid = uid(offset + 5);
  const dramaId = Number(database.prepare(`
    INSERT INTO dramas (uid,title,metadata,created_at,updated_at)
    VALUES (?,?,?, ?, ?)
  `).run(dramaUid, title, '{"source":"text"}', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z').lastInsertRowid);
  const episodeId = Number(database.prepare(`
    INSERT INTO episodes (uid,drama_id,episode_number,title,created_at,updated_at)
    VALUES (?,?,?,?,?,?)
  `).run(episodeUid, dramaId, 1, 'Episode', '2026-08-30T00:00:01.000Z', '2026-08-30T00:00:01.000Z').lastInsertRowid);
  const characterId = Number(database.prepare(`
    INSERT INTO characters (
      uid,drama_id,name,extra_images,identity_anchors,style_tokens,color_palette,
      stages,seedance2_asset,seedance2_voice_asset,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    characterUid, dramaId, 'Hero', '[]', '{}', '[]', '[]', '[]', '{}', '{}',
    '2026-08-30T00:00:02.000Z', '2026-08-30T00:00:02.000Z',
  ).lastInsertRowid);
  const sceneId = Number(database.prepare(`
    INSERT INTO scenes (uid,drama_id,episode_id,location,extra_images,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    sceneUid, dramaId, episodeId, 'Courtyard', '[]',
    '2026-08-30T00:00:03.000Z', '2026-08-30T00:00:03.000Z',
  ).lastInsertRowid);
  const propId = Number(database.prepare(`
    INSERT INTO props (uid,drama_id,episode_id,name,extra_images,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    propUid, dramaId, episodeId, 'Sword', '[]',
    '2026-08-30T00:00:04.000Z', '2026-08-30T00:00:04.000Z',
  ).lastInsertRowid);
  const storyboardId = Number(database.prepare(`
    INSERT INTO storyboards (
      uid,episode_id,scene_id,storyboard_number,title,duration,continuity_snapshot,
      creation_mode,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    storyboardUid, episodeId, sceneId, 1, 'Opening', 3.5, '{}', 'classic', 'draft',
    '2026-08-30T00:00:05.000Z', '2026-08-30T00:00:05.000Z',
  ).lastInsertRowid);
  return {
    dramaUid, dramaId, episodeId, characterId, sceneId, propId, storyboardId,
  };
}

function seedCompleteLegacyFixture(t) {
  const database = createDatabase(t);
  const first = insertCore(database, 11000, 'Legacy archive');
  const second = insertCore(database, 11100, 'Other drama');

  const characterLibraryId = Number(database.prepare(`
    INSERT INTO character_libraries (
      drama_id,name,local_path,image_url,identity_anchors,style_tokens,color_palette,
      source_type,source_id,created_at,updated_at
    ) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'Global Hero', 'projects/archive/character.png', '/static/projects/archive/character.png',
    '{}', '[]', '[]', 'character', String(first.characterId),
    '2026-08-30T00:00:06.000Z', '2026-08-30T00:00:06.000Z',
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO scene_libraries (
      drama_id,location,local_path,image_url,source_type,source_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    first.dramaId, 'Courtyard', 'projects/archive/scene.png',
    '/static/projects/archive/scene.png', 'scene', String(first.sceneId),
    '2026-08-30T00:00:07.000Z', '2026-08-30T00:00:07.000Z',
  );
  database.prepare(`
    INSERT INTO prop_libraries (
      drama_id,name,local_path,image_url,source_type,source_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    first.dramaId, 'Sword', 'projects/archive/prop.png',
    '/static/projects/archive/prop.png', 'prop', String(first.propId),
    '2026-08-30T00:00:08.000Z', '2026-08-30T00:00:08.000Z',
  );
  database.prepare('INSERT INTO episode_characters (episode_id,character_id) VALUES (?,?)')
    .run(first.episodeId, first.characterId);
  database.prepare(`
    INSERT INTO storyboard_characters (storyboard_id,character_id,created_at)
    VALUES (?,?,?)
  `).run(first.storyboardId, characterLibraryId, '2026-08-30T00:00:09.000Z');
  database.prepare('INSERT INTO storyboard_props (storyboard_id,prop_id) VALUES (?,?)')
    .run(first.storyboardId, first.propId);
  database.prepare(`
    INSERT INTO frame_prompts (storyboard_id,frame_type,prompt,description,layout,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    first.storyboardId, 'first', 'Wide opening', 'Opening frame', '{}',
    '2026-08-30T00:00:10.000Z', '2026-08-30T00:00:10.000Z',
  );

  const imageCompletedId = Number(database.prepare(`
    INSERT INTO image_generations (
      storyboard_id,drama_id,episode_id,scene_id,character_id,provider,prompt,model,
      reference_images,image_url,local_path,width,height,status,task_id,completed_at,
      error_msg,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    first.storyboardId, first.dramaId, first.episodeId, first.sceneId, first.characterId,
    'local', 'Opening image', 'fixture', '[]', '/static/projects/archive/frame.png',
    'projects/archive/frame.png', 1024, 576, 'completed', null,
    '2026-08-30T00:00:12.000Z', 'raw provider detail must not export',
    '2026-08-30T00:00:11.000Z', '2026-08-30T00:00:12.000Z',
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO image_generations (
      drama_id,provider,prompt,reference_images,status,error_msg,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    first.dramaId, 'local', 'Failed historical image', '[]', 'failed',
    'synthetic failure detail', '2026-08-30T00:00:13.000Z',
    '2026-08-30T00:00:14.000Z',
  );
  const videoId = Number(database.prepare(`
    INSERT INTO video_generations (
      drama_id,storyboard_id,scene_id,provider,prompt,model,duration,aspect_ratio,
      resolution,seed,camera_fixed,watermark,reference_image_urls,video_url,local_path,
      status,task_id,provider_task_id,completed_at,error_msg,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    first.dramaId, first.storyboardId, first.sceneId, 'local', 'Opening video',
    'fixture', 3.5, '16:9', '1024x576', 42, 0, 0, '[]',
    '/static/projects/archive/shot.mp4', 'projects/archive/shot.mp4', 'completed',
    null, null,
    '2026-08-30T00:00:16.000Z', 'raw video detail must not export',
    '2026-08-30T00:00:15.000Z', '2026-08-30T00:00:16.000Z',
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO video_merges (
      episode_id,drama_id,title,provider,model,status,scenes,merge_options,task_id,
      merged_url,duration,completed_at,error_msg,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    first.episodeId, first.dramaId, 'Episode final', 'local', 'ffmpeg', 'completed',
    '[]', '{}', null, '/static/projects/archive/episode.mp4',
    3500, '2026-08-30T00:00:18.000Z', 'raw merge detail must not export',
    '2026-08-30T00:00:17.000Z',
  );
  database.prepare(`
    INSERT INTO legacy_assets (
      drama_id,name,type,url,local_path,file_size,mime_type,width,height,duration,
      image_gen_id,video_gen_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    first.dramaId, 'Opening output', 'video', '/static/projects/archive/shot.mp4',
    'projects/archive/shot.mp4', 1000, 'video/mp4', 1024, 576, 3.5,
    imageCompletedId, videoId, '2026-08-30T00:00:19.000Z',
    '2026-08-30T00:00:19.000Z',
  );
  database.prepare(`
    UPDATE storyboards SET first_frame_image_id=?,last_frame_image_id=? WHERE id=?
  `).run(imageCompletedId, imageCompletedId, first.storyboardId);

  return { database, first, second };
}

test('2.1 legacy data module exposes the exact migrated project archive contract', (t) => {
  assert.equal(typeof LEGACY_RECORD_SPECS, 'object');
  assert.equal(typeof createProjectArchiveV21LegacyData, 'function');
  assert.equal(typeof validateProjectLegacyRecords, 'function');
  const expected = [
    ...PROJECT_ARCHIVE_CATALOG.legacyCoreTables,
    ...PROJECT_ARCHIVE_CATALOG.legacyAddendumTables,
  ].sort();
  assert.deepEqual(Object.values(LEGACY_RECORD_SPECS).map((spec) => spec.table).sort(), expected);
  assert.equal(new Set(expected).size, 17);
  const database = createDatabase(t);
  for (const spec of Object.values(LEGACY_RECORD_SPECS)) {
    const migratedColumns = database.prepare(`PRAGMA table_info(${spec.table})`)
      .all()
      .map((column) => column.name);
    assert.deepEqual([...spec.columns].sort(), migratedColumns.sort(), spec.table);
  }
});

test('empty legacy project export is exact, deterministic, bounded, and frozen', (t) => {
  const database = createDatabase(t);
  const project = insertCore(database, 11200, 'Empty legacy archive');
  const archive = createProjectArchiveV21LegacyData(database);
  const first = archive.exportForDrama(project.dramaUid);
  const second = archive.exportForDrama(project.dramaUid);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.dramas.length, 1);
  assert.equal(first.episodes.length, 1);
  assert.equal(first.storyboards.length, 1);
  assert.equal(first.characters.length, 1);
  assert.equal(first.scenes.length, 1);
  assert.equal(first.props.length, 1);
  for (const name of Object.keys(first)) assert.equal(Object.isFrozen(first[name]), true, name);
  assert.equal(validateProjectLegacyRecords(first, project.dramaUid), first);
});

test('legacy relation, library, asset, image, video, and merge histories form one project closure', (t) => {
  const fixture = seedCompleteLegacyFixture(t);
  const archive = createProjectArchiveV21LegacyData(fixture.database);
  const records = archive.exportForDrama(fixture.first.dramaUid);
  for (const [name, rows] of Object.entries(records)) {
    assert.ok(rows.length > 0, `${name} should be represented`);
  }
  assert.equal(records.imageGenerations.length, 2);
  assert.deepEqual(records.imageGenerations.map((row) => row.status), ['completed', 'failed']);
  assert.equal(records.imageGenerations[0].task_id, null);
  assert.equal(records.imageGenerations[0].error_msg, null);
  assert.equal(records.videoGenerations[0].task_id, null);
  assert.equal(records.videoGenerations[0].provider_task_id, null);
  assert.equal(records.videoGenerations[0].error_msg, null);
  assert.equal(records.videoMerges[0].task_id, null);
  assert.equal(records.videoMerges[0].error_msg, null);
  assert.doesNotMatch(JSON.stringify(records), /must-not-export|synthetic failure detail/u);
  assert.equal(records.characterLibraries[0].drama_id, null);
  assert.equal(validateProjectLegacyRecords(records, fixture.first.dramaUid), records);

  const isolated = archive.exportForDrama(fixture.second.dramaUid);
  assert.equal(isolated.dramas.length, 1);
  assert.equal(isolated.imageGenerations.length, 0);
  assert.equal(isolated.videoGenerations.length, 0);
  assert.equal(isolated.characterLibraries.length, 0);

  const mutations = [
    (value) => { value.imageGenerations[0].drama_id = fixture.second.dramaId; },
    (value) => { value.characterLibraries[0].drama_id = fixture.second.dramaId; },
    (value) => { value.episodeCharacters[0].character_id = fixture.second.characterId; },
    (value) => { value.storyboardCharacters[0].character_id += 100000; },
    (value) => { value.legacyAssets[0].video_gen_id += 100000; },
    (value) => { value.videoMerges[0].episode_id = fixture.second.episodeId; },
    (value) => { value.framePrompts[0].storyboard_id += 100000; },
    (value) => { value.imageGenerations[0].local_path = path.win32.join('C:\\private', 'frame.png'); },
    (value) => { value.videoGenerations[0].video_url = 'https://remote.invalid/private.mp4'; },
    (value) => { value.imageGenerations[0].prompt = 'api_key=synthetic-local-secret-value'; },
    (value) => { value.imageGenerations[0].prompt = '\ud800a'; },
    (value) => { value.imageGenerations.reverse(); },
    (value) => { value.episodeCharacters.push(structuredClone(value.episodeCharacters[0])); },
    (value) => { value.imageGenerations[0].unexpected = true; },
    (value) => { delete value.videoGenerations[0].provider; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(records);
    mutate(invalid);
    assert.throws(
      () => validateProjectLegacyRecords(invalid, fixture.first.dramaUid),
      (error) => ['PROJECT_ARCHIVE_MANIFEST_INVALID', 'PROJECT_ARCHIVE_SECRET_DETECTED']
        .includes(error?.code)
        && !String(error).includes('synthetic-local-secret-value'),
    );
  }
});

test('legacy data rejects duplicate-key JSON and hostile roots without executing proxy traps', (t) => {
  const fixture = seedCompleteLegacyFixture(t);
  const cleanRecords = createProjectArchiveV21LegacyData(fixture.database)
    .exportForDrama(fixture.first.dramaUid);
  fixture.database.prepare('UPDATE video_generations SET task_id=? WHERE drama_id=?')
    .run('nonportable-local-task', fixture.first.dramaId);
  assert.throws(
    () => createProjectArchiveV21LegacyData(fixture.database).exportForDrama(fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
  fixture.database.prepare('UPDATE video_generations SET task_id=NULL WHERE drama_id=?')
    .run(fixture.first.dramaId);
  fixture.database.prepare('UPDATE video_generations SET error_msg=? WHERE drama_id=?')
    .run('api_key=synthetic-local-secret-value', fixture.first.dramaId);
  assert.throws(
    () => createProjectArchiveV21LegacyData(fixture.database).exportForDrama(fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_SECRET_DETECTED'
      && !String(error).includes('synthetic-local-secret-value'),
  );
  fixture.database.prepare('UPDATE video_generations SET error_msg=? WHERE drama_id=?')
    .run('raw video detail must not export', fixture.first.dramaId);
  fixture.database.prepare(`UPDATE video_merges SET merge_options=? WHERE drama_id=?`)
    .run('{"width":1,"width":2}', fixture.first.dramaId);
  assert.throws(
    () => createProjectArchiveV21LegacyData(fixture.database).exportForDrama(fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  let reads = 0;
  const hostile = new Proxy({}, {
    ownKeys() {
      reads += 1;
      throw new Error('legacy archive sentinel');
    },
  });
  assert.throws(
    () => validateProjectLegacyRecords(hostile, fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(reads, 0);

  let accessorReads = 0;
  const accessorRecord = structuredClone(cleanRecords);
  Object.defineProperty(accessorRecord.imageGenerations[0], 'prompt', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('legacy row accessor sentinel');
    },
  });
  assert.throws(
    () => validateProjectLegacyRecords(accessorRecord, fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(accessorReads, 0);

  let arrayTrapReads = 0;
  const proxiedArrayRecord = structuredClone(cleanRecords);
  proxiedArrayRecord.imageGenerations = new Proxy(proxiedArrayRecord.imageGenerations, {
    getPrototypeOf() {
      arrayTrapReads += 1;
      throw new Error('legacy array proxy sentinel');
    },
  });
  assert.throws(
    () => validateProjectLegacyRecords(proxiedArrayRecord, fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(arrayTrapReads, 0);

  const cyclic = structuredClone(cleanRecords);
  cyclic.dramas[0].metadata.self = cyclic.dramas[0].metadata;
  assert.throws(
    () => validateProjectLegacyRecords(cyclic, fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );

  const oversized = structuredClone(cleanRecords);
  oversized.episodeCharacters = new Array(100001);
  assert.throws(
    () => validateProjectLegacyRecords(oversized, fixture.first.dramaUid),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('legacy validation does not execute inherited Array, String, or RegExp accessors', (t) => {
  const fixture = seedCompleteLegacyFixture(t);
  const records = createProjectArchiveV21LegacyData(fixture.database)
    .exportForDrama(fixture.first.dramaUid);
  const modulePath = path.resolve(__dirname, '../src/adapters/v2/compat/projectArchiveV21LegacyData.js');
  const payload = Buffer.from(JSON.stringify(records), 'utf8').toString('base64');
  const script = String.raw`
    const target = require(${JSON.stringify(modulePath)});
    const records = JSON.parse(Buffer.from(${JSON.stringify(payload)}, 'base64').toString('utf8'));
    const dramaUid = ${JSON.stringify(fixture.first.dramaUid)};
    const targets = [
      [Array.prototype, Symbol.iterator],
      [Array.prototype, 'toJSON'],
      [Object.prototype, 'toJSON'],
      [String.prototype, 'charCodeAt'],
      [String.prototype, 'endsWith'],
      [String.prototype, 'includes'],
      [String.prototype, 'split'],
      [String.prototype, 'startsWith'],
      [String.prototype, 'trim'],
      [RegExp.prototype, 'exec'],
      [JSON, 'stringify'],
    ];
    const originals = targets.map(([owner, key]) => [owner, key, Object.getOwnPropertyDescriptor(owner, key)]);
    let reads = 0;
    try {
      for (let index = 0; index < originals.length; index += 1) {
        const owner = originals[index][0];
        const key = originals[index][1];
        const descriptor = originals[index][2];
        Object.defineProperty(owner, key, {
          configurable: true,
          get() {
            reads += 1;
            return descriptor ? descriptor.value : undefined;
          },
        });
      }
      target.validateProjectLegacyRecords(records, dramaUid);
    } finally {
      for (let index = 0; index < originals.length; index += 1) {
        const owner = originals[index][0];
        const key = originals[index][1];
        const descriptor = originals[index][2];
        if (descriptor) Object.defineProperty(owner, key, descriptor);
        else delete owner[key];
      }
    }
    let calls = 0;
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { calls += 1; },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() { calls += 1; },
    });
    try {
      target.validateProjectLegacyRecords(records, dramaUid);
    } finally {
      delete Object.prototype.toJSON;
      delete Array.prototype.toJSON;
    }
    process.stdout.write(JSON.stringify({ reads, calls }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { reads: 0, calls: 0 });
});
