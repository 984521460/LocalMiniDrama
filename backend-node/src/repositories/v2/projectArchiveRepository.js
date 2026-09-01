const { RECORD_NAMES, RECORD_SPECS } = require('../../adapters/v2/zip/manifest');
const {
  createProjectArchiveV21StructuredData,
} = require('../../adapters/v2/zip/projectArchiveV21StructuredData');
const { assertDatabase } = require('./repositorySupport');
const { createWorkflowRunArchiveReplay } = require('./workflowRunArchiveReplay');

const CORE_TABLES = Object.freeze(['dramas', 'episodes', 'characters', 'scenes', 'props', 'storyboards']);
const GLOBAL_V2_TABLES = Object.freeze(['remote_connections', 'remote_tasks']);
const ALL_UID_TABLES = Object.freeze([
  ...CORE_TABLES,
  ...RECORD_NAMES.map((name) => RECORD_SPECS[name].table),
  ...GLOBAL_V2_TABLES,
]);
const UNIQUE_UID_TABLES = Object.freeze([
  ...CORE_TABLES,
  ...RECORD_NAMES.filter((name) => !RECORD_SPECS[name].sharedUidWith)
    .map((name) => RECORD_SPECS[name].table),
  ...GLOBAL_V2_TABLES,
]);

function sortByUid(rows) {
  return rows.sort((left, right) => left.uid.localeCompare(right.uid));
}

function uniqueRows(rows) {
  const byUid = new Map();
  for (const row of rows) byUid.set(row.uid, row);
  return sortByUid([...byUid.values()]);
}

function createInsert(database, spec, { omit = [] } = {}) {
  const omitted = new Set(omit);
  const columns = spec.columns.filter((column) => !omitted.has(column));
  return database.prepare(`
    INSERT INTO ${spec.table} (${columns.join(', ')})
    VALUES (${columns.map((column) => `@${column}`).join(', ')})
  `);
}

function importRow(stage, statement, row) {
  try {
    return statement.run(row);
  } catch (error) {
    throw new TypeError(`Project archive ${stage} import failed`, { cause: error });
  }
}

function createProjectArchiveRepository(database) {
  assertDatabase(database);
  let structuredV21;

  function exportStructuredV21(dramaUid) {
    if (!structuredV21) structuredV21 = createProjectArchiveV21StructuredData(database);
    return structuredV21.exportForDrama(dramaUid);
  }

  const getDrama = database.prepare('SELECT id, uid FROM dramas WHERE id = ? AND deleted_at IS NULL');
  const listCharacters = database.prepare('SELECT id, uid FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id');
  const listScenes = database.prepare('SELECT id, uid, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id');
  const listProps = database.prepare('SELECT id, uid FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id');
  const listEpisodes = database.prepare('SELECT id, uid FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number');
  const listStoryboards = database.prepare('SELECT id, uid FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number');

  const listSourceDocuments = database.prepare(`
    SELECT uid, drama_uid, source_type, original_name, encoding, content_sha256,
           full_text, block_count, created_at
    FROM source_documents
    WHERE drama_uid = ?
    ORDER BY created_at, uid
  `);
  const listSourceBlocks = database.prepare('SELECT * FROM source_blocks WHERE document_uid = ? ORDER BY ordinal, uid');
  const listSourceSelections = database.prepare('SELECT * FROM source_selections WHERE document_uid = ? ORDER BY created_at, uid');
  const listWorkflowDefinitions = database.prepare(`
    SELECT uid, drama_uid, name, version, status, description, created_at, updated_at
    FROM workflow_definitions
    WHERE drama_uid = ?
    ORDER BY name, version, uid
  `);
  const listCanvasNodes = database.prepare('SELECT * FROM canvas_nodes WHERE workflow_uid = ? ORDER BY created_at, uid');
  const listCanvasEdges = database.prepare('SELECT * FROM canvas_edges WHERE workflow_uid = ? ORDER BY created_at, uid');
  const listWorkflowRuns = database.prepare('SELECT * FROM workflow_runs WHERE workflow_uid = ? ORDER BY created_at, uid');
  const listNodeRuns = database.prepare('SELECT * FROM node_runs WHERE workflow_run_uid = ? ORDER BY created_at, uid');
  const listExportRuns = database.prepare('SELECT * FROM export_runs WHERE drama_uid = ? ORDER BY created_at, uid');
  const listAllMediaExportRunSeals = database.prepare('SELECT * FROM media_export_run_seals ORDER BY uid');
  const listAllAssets = database.prepare('SELECT * FROM assets ORDER BY uid');
  const listAllAssetVersions = database.prepare('SELECT * FROM asset_versions ORDER BY uid');
  const listAllGenerationRuns = database.prepare('SELECT * FROM generation_runs ORDER BY uid');
  const listAllWorkflowManifests = database.prepare('SELECT * FROM workflow_manifests ORDER BY uid');
  const listAllPromptSemanticVersions = database.prepare('SELECT * FROM prompt_semantic_versions ORDER BY uid');
  const listAllGenerationHistory = database.prepare('SELECT * FROM asset_generation_history ORDER BY uid');
  const listAllSelectionEvents = database.prepare(`
    SELECT * FROM asset_version_selection_events ORDER BY asset_uid, state_version
  `);

  const uidConflict = database.prepare(`
    ${ALL_UID_TABLES.map((table) => `SELECT 1 AS found FROM ${table} WHERE uid = @uid`).join('\nUNION ALL\n')}
    LIMIT 1
  `);
  const uidOccurrenceReaders = Object.freeze(UNIQUE_UID_TABLES.map((table) => (
    database.prepare(`SELECT count(*) AS count FROM ${table} WHERE uid = ?`)
  )));
  const importedCore = Object.freeze({
    dramas: database.prepare('SELECT id, uid FROM dramas WHERE id = ? AND deleted_at IS NULL'),
    characters: database.prepare('SELECT id, uid FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id'),
    scenes: database.prepare('SELECT id, uid FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id'),
    props: database.prepare('SELECT id, uid FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id'),
    episodes: database.prepare('SELECT id, uid FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number'),
    storyboards: database.prepare('SELECT id, uid FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number'),
  });
  const updateCoreUid = Object.freeze(Object.fromEntries(CORE_TABLES.map((table) => [
    table,
    database.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`),
  ])));
  const insertRecords = Object.freeze(Object.fromEntries(RECORD_NAMES.map((name) => [
    name,
    createInsert(database, RECORD_SPECS[name], name === 'assets' ? { omit: ['current_version_uid'] } : undefined),
  ])));
  const insertSourceDocument = database.prepare(`
    INSERT INTO source_documents
      (uid, drama_uid, source_type, original_name, encoding, content_sha256, full_text, block_count, created_at)
    VALUES
      (@uid, @drama_uid, @source_type, @original_name, @encoding, @content_sha256, @full_text, @block_count, @created_at)
  `);
  const setCurrentAssetVersion = database.prepare('UPDATE assets SET current_version_uid = ? WHERE uid = ?');
  const workflowRunArchiveReplay = createWorkflowRunArchiveReplay(database);

  function exportCore(dramaId) {
    const drama = getDrama.get(dramaId);
    if (!drama) return null;
    const seenSceneKeys = new Set();
    const scenes = [];
    for (const scene of listScenes.all(dramaId)) {
      const key = `${String(scene.location || '').trim()}|${String(scene.time || '').trim()}`;
      if (seenSceneKeys.has(key)) continue;
      seenSceneKeys.add(key);
      scenes.push(scene.uid);
    }
    return {
      dramaUid: drama.uid,
      characters: listCharacters.all(dramaId).map((row) => row.uid),
      scenes,
      props: listProps.all(dramaId).map((row) => row.uid),
      episodes: listEpisodes.all(dramaId).map((episode) => ({
        uid: episode.uid,
        storyboards: listStoryboards.all(episode.id).map((row) => row.uid),
      })),
    };
  }

  function exportSnapshot(dramaId) {
    const project = exportCore(dramaId);
    if (!project) return null;

    const sourceDocuments = listSourceDocuments.all(project.dramaUid);
    const sourceBlocks = sourceDocuments.flatMap((document) => listSourceBlocks.all(document.uid));
    const sourceSelections = sourceDocuments.flatMap((document) => listSourceSelections.all(document.uid));
    const workflowDefinitions = listWorkflowDefinitions.all(project.dramaUid);
    const canvasNodes = workflowDefinitions.flatMap((workflow) => listCanvasNodes.all(workflow.uid));
    const canvasEdges = workflowDefinitions.flatMap((workflow) => listCanvasEdges.all(workflow.uid));
    const workflowRuns = workflowDefinitions.flatMap((workflow) => listWorkflowRuns.all(workflow.uid));
    const nodeRuns = workflowRuns.flatMap((run) => listNodeRuns.all(run.uid));
    const allExportRuns = listExportRuns.all(project.dramaUid);
    const exportRunByUid = new Map(allExportRuns.map((row) => [row.uid, row]));
    const allMediaExportRunSeals = listAllMediaExportRunSeals.all()
      .filter((row) => exportRunByUid.has(row.uid));
    const sealedUids = new Set(allMediaExportRunSeals.map((row) => row.uid));
    const exportRuns = allExportRuns.filter((row) => (
      !sealedUids.has(row.uid) || row.status === 'succeeded' || row.status === 'failed'
    ));
    const exportedRunUids = new Set(exportRuns.map((row) => row.uid));
    const mediaExportRunSeals = allMediaExportRunSeals.filter(
      (row) => exportedRunUids.has(row.uid),
    );

    const owned = new Map([
      ['drama', new Set([project.dramaUid])],
      ['character', new Set(project.characters)],
      ['scene', new Set(project.scenes)],
      ['prop', new Set(project.props)],
      ['episode', new Set(project.episodes.map((episode) => episode.uid))],
      ['storyboard', new Set(project.episodes.flatMap((episode) => episode.storyboards))],
      ['source_document', new Set(sourceDocuments.map((row) => row.uid))],
      ['source_block', new Set(sourceBlocks.map((row) => row.uid))],
      ['source_selection', new Set(sourceSelections.map((row) => row.uid))],
      ['workflow_definition', new Set(workflowDefinitions.map((row) => row.uid))],
      ['canvas_node', new Set(canvasNodes.map((row) => row.uid))],
      ['canvas_edge', new Set(canvasEdges.map((row) => row.uid))],
      ['workflow_run', new Set(workflowRuns.map((row) => row.uid))],
      ['node_run', new Set(nodeRuns.map((row) => row.uid))],
      ['export_run', new Set(exportRuns.map((row) => row.uid))],
      ['asset', new Set()],
      ['asset_version', new Set()],
      ['generation_run', new Set()],
    ]);
    const owns = (type, uid) => owned.get(type)?.has(uid) === true;

    const availableAssets = listAllAssets.all();
    const availableVersions = listAllAssetVersions.all();
    const availableGenerations = listAllGenerationRuns.all();
    const assets = [];
    const generationRuns = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const asset of availableAssets) {
        if (owned.get('asset').has(asset.uid) || !owns(asset.owner_type, asset.owner_uid)) continue;
        assets.push(asset);
        owned.get('asset').add(asset.uid);
        for (const version of availableVersions) {
          if (version.asset_uid === asset.uid) owned.get('asset_version').add(version.uid);
        }
        changed = true;
      }
      for (const run of availableGenerations) {
        if (owned.get('generation_run').has(run.uid) || !owns(run.owner_type, run.owner_uid)) continue;
        generationRuns.push(run);
        owned.get('generation_run').add(run.uid);
        changed = true;
      }
    }
    const assetUids = new Set(assets.map((asset) => asset.uid));
    const assetVersions = availableVersions.filter((version) => assetUids.has(version.asset_uid));
    const assetGenerationHistory = listAllGenerationHistory.all()
      .filter((history) => assetUids.has(history.asset_uid));
    const historyUids = new Set(assetGenerationHistory.map((history) => history.uid));
    const promptUids = new Set(
      assetGenerationHistory.map((history) => history.prompt_semantic_uid),
    );
    const manifestUids = new Set(
      assetGenerationHistory.map((history) => history.manifest_uid),
    );
    const promptSemanticVersions = listAllPromptSemanticVersions.all()
      .filter((prompt) => promptUids.has(prompt.uid));
    const workflowManifests = listAllWorkflowManifests.all()
      .filter((manifest) => manifestUids.has(manifest.uid));
    const assetVersionSelectionEvents = listAllSelectionEvents.all()
      .filter((event) => historyUids.has(event.history_uid));

    return {
      project,
      records: {
        sourceDocuments: uniqueRows(sourceDocuments),
        sourceBlocks: uniqueRows(sourceBlocks),
        sourceSelections: uniqueRows(sourceSelections),
        assets: uniqueRows(assets),
        assetVersions: uniqueRows(assetVersions),
        workflowDefinitions: uniqueRows(workflowDefinitions),
        canvasNodes: uniqueRows(canvasNodes),
        canvasEdges: uniqueRows(canvasEdges),
        generationRuns: uniqueRows(generationRuns),
        workflowRuns: uniqueRows(workflowRuns),
        nodeRuns: uniqueRows(nodeRuns),
        exportRuns: uniqueRows(exportRuns),
        mediaExportRunSeals: uniqueRows(mediaExportRunSeals),
        workflowManifests: uniqueRows(workflowManifests),
        promptSemanticVersions: uniqueRows(promptSemanticVersions),
        assetGenerationHistory: uniqueRows(assetGenerationHistory),
        assetVersionSelectionEvents: uniqueRows(assetVersionSelectionEvents),
      },
    };
  }

  function allManifestUids(manifest) {
    return [
      manifest.project.dramaUid,
      ...manifest.project.characters,
      ...manifest.project.scenes,
      ...manifest.project.props,
      ...manifest.project.episodes.flatMap((episode) => [episode.uid, ...episode.storyboards]),
      ...RECORD_NAMES.filter((name) => !RECORD_SPECS[name].sharedUidWith)
        .flatMap((name) => manifest.records[name].map((row) => row.uid)),
    ];
  }

  function hasUidConflict(manifest) {
    return allManifestUids(manifest).some((uid) => Boolean(uidConflict.get({ uid })));
  }

  function assertImportedUidSnapshot(manifest) {
    for (const uid of allManifestUids(manifest)) {
      const occurrences = uidOccurrenceReaders.reduce((total, statement) => total + statement.get(uid).count, 0);
      if (occurrences !== 1) throw new TypeError('Imported project identifier snapshot is not exclusive');
    }
  }

  function assertCoreShape(dramaId, project) {
    const drama = importedCore.dramas.get(dramaId);
    const characters = importedCore.characters.all(dramaId);
    const scenes = importedCore.scenes.all(dramaId);
    const props = importedCore.props.all(dramaId);
    const episodes = importedCore.episodes.all(dramaId);
    if (!drama || characters.length !== project.characters.length || scenes.length !== project.scenes.length
      || props.length !== project.props.length || episodes.length !== project.episodes.length) {
      throw new TypeError('Imported v1 project shape does not match the v2 manifest');
    }
    const storyboards = episodes.map((episode, index) => {
      const rows = importedCore.storyboards.all(episode.id);
      if (rows.length !== project.episodes[index].storyboards.length) {
        throw new TypeError('Imported v1 project shape does not match the v2 manifest');
      }
      return rows;
    });
    return { drama, characters, scenes, props, episodes, storyboards };
  }

  function applyCoreUids(dramaId, project) {
    const rows = assertCoreShape(dramaId, project);
    updateCoreUid.dramas.run(project.dramaUid, rows.drama.id);
    for (let index = 0; index < rows.characters.length; index++) {
      updateCoreUid.characters.run(project.characters[index], rows.characters[index].id);
    }
    for (let index = 0; index < rows.scenes.length; index++) {
      updateCoreUid.scenes.run(project.scenes[index], rows.scenes[index].id);
    }
    for (let index = 0; index < rows.props.length; index++) {
      updateCoreUid.props.run(project.props[index], rows.props[index].id);
    }
    for (let index = 0; index < rows.episodes.length; index++) {
      updateCoreUid.episodes.run(project.episodes[index].uid, rows.episodes[index].id);
      for (let storyboardIndex = 0; storyboardIndex < rows.storyboards[index].length; storyboardIndex++) {
        updateCoreUid.storyboards.run(
          project.episodes[index].storyboards[storyboardIndex],
          rows.storyboards[index][storyboardIndex].id,
        );
      }
    }
  }

  function insertVersionGraph(rows) {
    const remaining = new Map(rows.map((row) => [row.uid, row]));
    const inserted = new Set();
    while (remaining.size) {
      let progressed = false;
      for (const [uid, row] of remaining) {
        if (row.parent_uid !== null && remaining.has(row.parent_uid) && !inserted.has(row.parent_uid)) continue;
        insertRecords.assetVersions.run(row);
        inserted.add(uid);
        remaining.delete(uid);
        progressed = true;
      }
      if (!progressed) throw new TypeError('Asset version ancestry is not importable');
    }
  }

  const applySnapshotTransaction = database.transaction((dramaId, manifest) => {
    applyCoreUids(dramaId, manifest.project);
    const sourceBlockCounts = new Map(manifest.records.sourceDocuments.map((row) => [row.uid, 0]));
    for (const block of manifest.records.sourceBlocks) {
      sourceBlockCounts.set(block.document_uid, sourceBlockCounts.get(block.document_uid) + 1);
    }
    for (const row of manifest.records.sourceDocuments) {
      insertSourceDocument.run({ ...row, block_count: sourceBlockCounts.get(row.uid) });
    }
    const orderedSourceBlocks = [...manifest.records.sourceBlocks].sort((left, right) => (
      left.document_uid.localeCompare(right.document_uid) || left.ordinal - right.ordinal
    ));
    for (const row of orderedSourceBlocks) insertRecords.sourceBlocks.run(row);
    for (const name of ['sourceSelections', 'workflowDefinitions', 'canvasNodes', 'canvasEdges']) {
      for (const row of manifest.records[name]) insertRecords[name].run(row);
    }
    for (const row of manifest.records.workflowManifests) {
      importRow('workflow manifest', insertRecords.workflowManifests, row);
    }
    for (const row of manifest.records.assets) {
      insertRecords.assets.run({ ...row, current_version_uid: null });
    }
    insertVersionGraph(manifest.records.assetVersions);
    const firstSelectionByAsset = new Map();
    for (const event of [...manifest.records.assetVersionSelectionEvents]
      .sort((left, right) => left.state_version - right.state_version)) {
      if (!firstSelectionByAsset.has(event.asset_uid)) {
        firstSelectionByAsset.set(event.asset_uid, event.previous_version_uid);
      }
    }
    for (const row of manifest.records.assets) {
      const initialVersionUid = firstSelectionByAsset.has(row.uid)
        ? firstSelectionByAsset.get(row.uid)
        : row.current_version_uid;
      if (initialVersionUid !== null) setCurrentAssetVersion.run(initialVersionUid, row.uid);
    }
    for (const row of manifest.records.promptSemanticVersions) {
      importRow('Prompt Semantic version', insertRecords.promptSemanticVersions, row);
    }
    for (const name of ['generationRuns']) {
      for (const row of manifest.records[name]) importRow('generation run', insertRecords[name], row);
    }
    for (const row of manifest.records.assetGenerationHistory) {
      importRow('generation history', insertRecords.assetGenerationHistory, row);
    }
    for (const row of [...manifest.records.assetVersionSelectionEvents]
      .sort((left, right) => (
        left.asset_uid.localeCompare(right.asset_uid) || left.state_version - right.state_version
      ))) {
      importRow('asset version selection', insertRecords.assetVersionSelectionEvents, row);
    }
    workflowRunArchiveReplay.importHistory(
      manifest.records.workflowRuns,
      manifest.records.nodeRuns,
    );
    for (const name of ['exportRuns']) {
      for (const row of manifest.records[name]) insertRecords[name].run(row);
    }
    for (const row of manifest.records.mediaExportRunSeals) {
      importRow('media export seal', insertRecords.mediaExportRunSeals, row);
    }
    assertImportedUidSnapshot(manifest);
    if (database.pragma('foreign_key_check').length !== 0) {
      throw new TypeError('Imported project violates database relationships');
    }
  });

  return Object.freeze({
    exportSnapshot,
    exportStructuredV21,
    hasUidConflict,
    importSnapshot(dramaId, manifest) {
      applySnapshotTransaction(dramaId, manifest);
    },
  });
}

module.exports = { createProjectArchiveRepository };
