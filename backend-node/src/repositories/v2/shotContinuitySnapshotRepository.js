const {
  compareShotContinuitySnapshots,
  createShotContinuitySnapshot,
  createShotContinuitySnapshotInput,
} = require('../../assets/shotContinuitySnapshot');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');
const { createVersionValidation } = require('../../assets/versionValidation');
const { sha256Canonical } = require('../../narrative/tasks/jsonSnapshot');

const validation = createVersionValidation('Shot continuity snapshot input is invalid');

function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function createShotContinuitySnapshotRepository(database, dependencies) {
  const {
    characterReferencePackages,
    characterVersions,
    requireApprovedShot,
    scenePropVersions,
  } = dependencies || {};
  if (!characterReferencePackages
    || !characterVersions
    || typeof requireApprovedShot !== 'function'
    || !scenePropVersions) {
    throw new TypeError('Shot continuity snapshot repository dependencies are invalid');
  }
  let statements;

  function getStatements() {
    if (statements) return statements;
    statements = Object.freeze({
      insertCharacter: database.prepare(`
        INSERT INTO shot_continuity_character_refs
          (snapshot_uid, ordinal, fact_ref, character_uid, reference_package_uid,
           identity_version_uid, costume_version_uid, package_lock_event_uid,
           package_lock_state_version, package_appearance_version_uid,
           package_appearance_metadata_json, costume_metadata_json)
        VALUES
          (@snapshotUid, @ordinal, @factRef, @characterUid, @referencePackageUid,
           @identityVersionUid, @costumeVersionUid, @packageLockEventUid,
           @packageLockStateVersion, @packageAppearanceVersionUid,
           @packageAppearanceMetadataJson, @costumeMetadataJson)
      `),
      insertProp: database.prepare(`
        INSERT INTO shot_continuity_prop_refs
          (snapshot_uid, ordinal, fact_ref, prop_uid, prop_version_uid, prop_metadata_json)
        VALUES
          (@snapshotUid, @ordinal, @factRef, @propUid, @versionUid, @metadataJson)
      `),
      insertSnapshot: database.prepare(`
        INSERT INTO shot_continuity_snapshots
          (uid, drama_uid, shot_result_uid, shot_result_hash, shot_envelope_hash,
           shot_review_uid, shot_id, shot_ordinal, scene_uid, scene_version_uid,
           scene_metadata_json, created_at_epoch_ms)
        VALUES
          (@snapshotUid, @dramaUid, @shotResultUid, @shotResultHash, @shotEnvelopeHash,
           @shotReviewUid, @shotId, @shotOrdinal, @sceneUid, @sceneVersionUid,
           @sceneMetadataJson, @createdAtEpochMs)
      `),
      getSnapshot: database.prepare('SELECT * FROM shot_continuity_snapshots WHERE uid = ?'),
      listSnapshots: database.prepare(`
        SELECT * FROM shot_continuity_snapshots
        WHERE shot_result_uid = ? ORDER BY shot_ordinal, created_at_epoch_ms, uid
      `),
      listCharacters: database.prepare(`
        SELECT * FROM shot_continuity_character_refs
        WHERE snapshot_uid = ? ORDER BY ordinal
      `),
      listProps: database.prepare(`
        SELECT * FROM shot_continuity_prop_refs
        WHERE snapshot_uid = ? ORDER BY ordinal
      `),
      approvedShot: database.prepare(`
        SELECT result.result_json AS resultJson
        FROM narrative_results AS result
        JOIN narrative_review_events AS review ON review.uid = @shotReviewUid
        WHERE result.uid = @shotResultUid
          AND result.drama_uid = @dramaUid
          AND result.result_type = 'shot'
          AND result.task_type = 'ShotPlanningTask'
          AND result.schema_version = 'shot-planning.v1'
          AND result.result_hash = @shotResultHash
          AND result.envelope_hash = @shotEnvelopeHash
          AND result.status = 'approved'
          AND result.current_review_uid = @shotReviewUid
          AND review.result_uid = result.uid
          AND review.decision = 'approve'
          AND review.result_hash = result.result_hash
          AND review.envelope_hash = result.envelope_hash
      `),
      historicalShot: database.prepare(`
        SELECT result.result_json AS resultJson
        FROM narrative_results AS result
        JOIN narrative_review_events AS review ON review.uid = @shotReviewUid
        WHERE result.uid = @shotResultUid
          AND result.drama_uid = @dramaUid
          AND result.result_type = 'shot'
          AND result.task_type = 'ShotPlanningTask'
          AND result.schema_version = 'shot-planning.v1'
          AND result.result_hash = @shotResultHash
          AND result.envelope_hash = @shotEnvelopeHash
          AND review.result_uid = result.uid
          AND review.decision = 'approve'
          AND review.result_hash = result.result_hash
          AND review.envelope_hash = result.envelope_hash
      `),
      sceneEvidence: database.prepare(`
        SELECT version.metadata_json AS metadataJson
        FROM scene_versions AS version
        JOIN scenes AS scene ON scene.uid = version.scene_uid
        JOIN dramas AS drama ON drama.id = scene.drama_id
        WHERE version.uid = @versionUid AND version.scene_uid = @sceneUid
          AND version.state = 'ready' AND drama.uid = @dramaUid
          AND scene.deleted_at IS NULL AND drama.deleted_at IS NULL
      `),
      characterCreateEvidence: database.prepare(`
        SELECT package.identity_version_uid AS identityVersionUid,
               package.lock_event_uid AS packageLockEventUid,
               package.lock_state_version AS packageLockStateVersion,
               package.appearance_version_uid AS packageAppearanceVersionUid,
               package.appearance_metadata_json AS packageAppearanceMetadataJson,
               costume.metadata_json AS costumeMetadataJson
        FROM character_reference_packages AS package
        JOIN character_identity_lock_events AS lock_event ON lock_event.uid = package.lock_event_uid
        JOIN character_costume_versions AS costume ON costume.uid = @costumeVersionUid
        JOIN characters AS character ON character.uid = package.character_uid
        JOIN dramas AS drama ON drama.id = character.drama_id
        WHERE package.uid = @referencePackageUid
          AND package.character_uid = @characterUid
          AND costume.character_uid = package.character_uid
          AND costume.identity_version_uid = package.identity_version_uid
          AND lock_event.operation = 'lock'
          AND lock_event.character_uid = package.character_uid
          AND lock_event.identity_version_uid = package.identity_version_uid
          AND lock_event.state_version = package.lock_state_version
          AND NOT EXISTS (
            SELECT 1 FROM character_identity_lock_events AS newer
            WHERE newer.character_uid = package.character_uid
              AND newer.state_version > package.lock_state_version
          )
          AND drama.uid = @dramaUid
          AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
      `),
      characterHistoricalEvidence: database.prepare(`
        SELECT package.identity_version_uid AS identityVersionUid,
               package.lock_event_uid AS packageLockEventUid,
               package.lock_state_version AS packageLockStateVersion,
               package.appearance_version_uid AS packageAppearanceVersionUid,
               package.appearance_metadata_json AS packageAppearanceMetadataJson,
               costume.metadata_json AS costumeMetadataJson
        FROM character_reference_packages AS package
        JOIN character_costume_versions AS costume ON costume.uid = @costumeVersionUid
        JOIN characters AS character ON character.uid = package.character_uid
        JOIN dramas AS drama ON drama.id = character.drama_id
        WHERE package.uid = @referencePackageUid
          AND package.character_uid = @characterUid
          AND costume.character_uid = package.character_uid
          AND costume.identity_version_uid = package.identity_version_uid
          AND drama.uid = @dramaUid
          AND character.deleted_at IS NULL AND drama.deleted_at IS NULL
      `),
      propEvidence: database.prepare(`
        SELECT version.metadata_json AS metadataJson
        FROM prop_versions AS version
        JOIN props AS prop ON prop.uid = version.prop_uid
        JOIN dramas AS drama ON drama.id = prop.drama_id
        WHERE version.uid = @versionUid AND version.prop_uid = @propUid
          AND version.state = 'ready' AND drama.uid = @dramaUid
          AND prop.deleted_at IS NULL AND drama.deleted_at IS NULL
      `),
    });
    return statements;
  }

  function reviewUid(reviewRef) {
    return validation.canonicalUid(reviewRef.slice('review:v1:'.length));
  }

  function plannedShot(resultJson, resultHash, envelopeHash, shotId, shotOrdinal) {
    let result;
    try {
      result = JSON.parse(resultJson);
      if (sha256Canonical(result?.output) !== resultHash
        || sha256Canonical(result) !== envelopeHash) return null;
    } catch {
      return null;
    }
    const shots = result?.output?.shots;
    if (!Array.isArray(shots)) return null;
    const shot = shots.find((entry) => entry?.shotId === shotId && entry?.ordinal === shotOrdinal);
    if (!shot || !Array.isArray(shot.characterFactRefs) || !Array.isArray(shot.propFactRefs)) return null;
    return shot;
  }

  function assertPlannedBindings(shot, characters, props, ErrorClass) {
    const characterFacts = characters.map((entry) => entry.factRef).sort();
    const propFacts = props.map((entry) => entry.factRef).sort();
    if (!sameValues(characterFacts, [...shot.characterFactRefs].sort())
      || !sameValues(propFacts, [...shot.propFactRefs].sort())) {
      throw new ErrorClass('shot continuity snapshot', 'referenced');
    }
  }

  const insertTransaction = database.transaction((input) => {
    const prepared = getStatements();
    const approved = requireApprovedShot(input.shotResultUid);
    if (approved.approval.resultHash !== input.shotResultHash
      || approved.approval.envelopeHash !== input.shotEnvelopeHash
      || approved.approval.reviewRef !== input.shotApprovalRef) {
      throw new V2RepositoryConflictError('shot continuity snapshot', 'created');
    }
    const shotReviewUid = reviewUid(input.shotApprovalRef);
    const shotEvidence = prepared.approvedShot.get({ ...input, shotReviewUid });
    const shot = shotEvidence && plannedShot(
      shotEvidence.resultJson,
      input.shotResultHash,
      input.shotEnvelopeHash,
      input.shotId,
      input.shotOrdinal,
    );
    if (!shot) throw new V2RepositoryConflictError('shot continuity snapshot', 'created');
    const approvedShot = approved.result.output.shots.find(
      (entry) => entry.shotId === input.shotId && entry.ordinal === input.shotOrdinal,
    );
    if (!approvedShot
      || sha256Canonical(approved.result.output) !== input.shotResultHash
      || sha256Canonical(approved.result) !== input.shotEnvelopeHash
      || !sameValues(approvedShot.characterFactRefs, shot.characterFactRefs)
      || !sameValues(approvedShot.propFactRefs, shot.propFactRefs)) {
      throw new V2RepositoryConflictError('shot continuity snapshot', 'created');
    }
    assertPlannedBindings(shot, input.characters, input.props, V2RepositoryConflictError);

    const sceneVersion = scenePropVersions.requireReferenceable(
      'scene', input.scene.versionUid, input.scene.sceneUid,
    );
    const sceneEvidence = prepared.sceneEvidence.get({
      ...input.scene,
      dramaUid: input.dramaUid,
    });
    if (!sceneEvidence || sceneEvidence.metadataJson !== JSON.stringify(sceneVersion.metadata)) {
      throw new V2RepositoryConflictError('shot continuity scene version', 'referenced');
    }

    input.characters.forEach((entry, ordinal) => {
      const packageRecord = characterReferencePackages.get(entry.referencePackageUid);
      const costume = characterVersions.get('costume', entry.costumeVersionUid);
      const evidence = prepared.characterCreateEvidence.get({
        ...entry,
        dramaUid: input.dramaUid,
      });
      if (!evidence
        || packageRecord.characterUid !== entry.characterUid
        || packageRecord.identityVersionUid !== evidence.identityVersionUid
        || packageRecord.lockEventUid !== evidence.packageLockEventUid
        || packageRecord.lockStateVersion !== evidence.packageLockStateVersion
        || packageRecord.appearanceVersion.uid !== evidence.packageAppearanceVersionUid
        || JSON.stringify({
          name: packageRecord.appearanceVersion.name,
          description: packageRecord.appearanceVersion.description,
          colorAnchors: packageRecord.appearanceVersion.colorAnchors,
        }) !== evidence.packageAppearanceMetadataJson
        || costume.characterUid !== entry.characterUid
        || costume.identityVersionUid !== packageRecord.identityVersionUid
        || JSON.stringify(costume.metadata) !== evidence.costumeMetadataJson) {
        throw new V2RepositoryConflictError('shot continuity character version', 'referenced');
      }
      prepared.insertCharacter.run({
        ...entry,
        ...evidence,
        snapshotUid: input.snapshotUid,
        ordinal,
      });
    });

    input.props.forEach((entry, ordinal) => {
      const version = scenePropVersions.requireReferenceable('prop', entry.versionUid, entry.propUid);
      const evidence = prepared.propEvidence.get({ ...entry, dramaUid: input.dramaUid });
      if (!evidence || evidence.metadataJson !== JSON.stringify(version.metadata)) {
        throw new V2RepositoryConflictError('shot continuity prop version', 'referenced');
      }
      prepared.insertProp.run({
        ...entry,
        snapshotUid: input.snapshotUid,
        ordinal,
        metadataJson: evidence.metadataJson,
      });
    });

    prepared.insertSnapshot.run({
      ...input,
      shotReviewUid,
      sceneUid: input.scene.sceneUid,
      sceneVersionUid: input.scene.versionUid,
      sceneMetadataJson: sceneEvidence.metadataJson,
    });
  });

  function mapSnapshot(row) {
    try {
      const prepared = getStatements();
      const evidenceInput = {
        shotResultUid: row.shot_result_uid,
        dramaUid: row.drama_uid,
        shotResultHash: row.shot_result_hash,
        shotEnvelopeHash: row.shot_envelope_hash,
        shotReviewUid: row.shot_review_uid,
      };
      const shotEvidence = prepared.historicalShot.get(evidenceInput);
      const shot = shotEvidence && plannedShot(
        shotEvidence.resultJson,
        row.shot_result_hash,
        row.shot_envelope_hash,
        row.shot_id,
        row.shot_ordinal,
      );
      if (!shot) throw new TypeError();

      const sceneVersion = scenePropVersions.get('scene', row.scene_version_uid);
      const sceneEvidence = prepared.sceneEvidence.get({
        versionUid: row.scene_version_uid,
        sceneUid: row.scene_uid,
        dramaUid: row.drama_uid,
      });
      if (!sceneEvidence
        || sceneEvidence.metadataJson !== row.scene_metadata_json
        || sceneEvidence.metadataJson !== JSON.stringify(sceneVersion.metadata)) throw new TypeError();

      const characterRows = prepared.listCharacters.all(row.uid);
      const characters = characterRows.map((entry) => {
        const packageRecord = characterReferencePackages.get(entry.reference_package_uid);
        const costume = characterVersions.get('costume', entry.costume_version_uid);
        const evidence = prepared.characterHistoricalEvidence.get({
          referencePackageUid: entry.reference_package_uid,
          characterUid: entry.character_uid,
          costumeVersionUid: entry.costume_version_uid,
          dramaUid: row.drama_uid,
        });
        if (!evidence
          || packageRecord.characterUid !== entry.character_uid
          || packageRecord.identityVersionUid !== entry.identity_version_uid
          || packageRecord.lockEventUid !== entry.package_lock_event_uid
          || packageRecord.lockStateVersion !== entry.package_lock_state_version
          || packageRecord.appearanceVersion.uid !== entry.package_appearance_version_uid
          || evidence.identityVersionUid !== entry.identity_version_uid
          || evidence.packageLockEventUid !== entry.package_lock_event_uid
          || evidence.packageLockStateVersion !== entry.package_lock_state_version
          || evidence.packageAppearanceVersionUid !== entry.package_appearance_version_uid
          || evidence.packageAppearanceMetadataJson !== entry.package_appearance_metadata_json
          || evidence.costumeMetadataJson !== entry.costume_metadata_json
          || JSON.stringify(costume.metadata) !== entry.costume_metadata_json) throw new TypeError();
        return {
          factRef: entry.fact_ref,
          characterUid: entry.character_uid,
          referencePackageUid: entry.reference_package_uid,
          identityVersionUid: entry.identity_version_uid,
          costumeVersionUid: entry.costume_version_uid,
        };
      });
      const propRows = prepared.listProps.all(row.uid);
      const props = propRows.map((entry) => {
        const version = scenePropVersions.get('prop', entry.prop_version_uid);
        const evidence = prepared.propEvidence.get({
          versionUid: entry.prop_version_uid,
          propUid: entry.prop_uid,
          dramaUid: row.drama_uid,
        });
        if (!evidence
          || evidence.metadataJson !== entry.prop_metadata_json
          || evidence.metadataJson !== JSON.stringify(version.metadata)) throw new TypeError();
        return {
          factRef: entry.fact_ref,
          propUid: entry.prop_uid,
          versionUid: entry.prop_version_uid,
          name: version.metadata.name,
          visualDescription: version.metadata.visualDescription,
          colorAnchors: version.metadata.colorAnchors,
        };
      });
      assertPlannedBindings(shot, characters, props, V2RepositoryDataError);
      return createShotContinuitySnapshot({
        schemaVersion: '5.0',
        snapshotUid: row.uid,
        dramaUid: row.drama_uid,
        shotResultUid: row.shot_result_uid,
        shotResultHash: row.shot_result_hash,
        shotEnvelopeHash: row.shot_envelope_hash,
        shotApprovalRef: `review:v1:${row.shot_review_uid}`,
        shotId: row.shot_id,
        shotOrdinal: row.shot_ordinal,
        scene: {
          sceneUid: row.scene_uid,
          versionUid: row.scene_version_uid,
          name: sceneVersion.metadata.name,
          visualDescription: sceneVersion.metadata.visualDescription,
          lighting: sceneVersion.metadata.lighting,
          colorAnchors: sceneVersion.metadata.colorAnchors,
        },
        characters,
        props,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError('shot continuity snapshot', 'persisted record');
    }
  }

  function get(snapshotUid) {
    const canonicalUid = validation.canonicalUid(snapshotUid);
    return mapSnapshot(requiredRow(
      getStatements().getSnapshot.get(canonicalUid),
      'shot continuity snapshot',
      canonicalUid,
    ));
  }

  return Object.freeze({
    create(value) {
      const input = createShotContinuitySnapshotInput(value);
      executeWrite('shot continuity snapshot', 'created', () => insertTransaction(input));
      return get(input.snapshotUid);
    },

    get,

    list(shotResultUid) {
      const canonicalUid = validation.canonicalUid(shotResultUid);
      return Object.freeze(getStatements().listSnapshots.all(canonicalUid).map(mapSnapshot));
    },

    compare(fromSnapshotUid, toSnapshotUid) {
      return compareShotContinuitySnapshots(get(fromSnapshotUid), get(toSnapshotUid));
    },
  });
}

module.exports = { createShotContinuitySnapshotRepository };
