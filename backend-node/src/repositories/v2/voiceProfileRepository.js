const { createCharacterVersionRecord } = require('../../assets/characterVersions');
const {
  createVoiceProfileDraft,
  createVoiceProfileRecord,
  createVoiceProfileSelectionRecord,
} = require('../../audio/voiceProfile');
const { V2RepositoryDataError } = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');
const { freezeSnapshot } = require('./rowMapping');

function createVoiceProfileRepository(database) {
  let statements;

  function getStatements() {
    if (!statements) {
      const profileProjection = `
        SELECT profile.*
        FROM voice_profiles AS profile
      `;
      statements = Object.freeze({
        insertProfile: database.prepare(`
          INSERT INTO voice_profiles (
            uid,drama_uid,character_uid,character_voice_version_uid,
            voice_identity_version_uid,voice_parent_uid,parent_uid,revision,
            provider,model,voice_key,credential_ref,source_kind,voice_name,voice_language,
            voice_style,status,default_emotion,emotion_map_json,minimum_speed_permille,
            default_speed_permille,maximum_speed_permille,voice_version_created_at_epoch_ms,
            created_at_epoch_ms
          ) VALUES (
            @uid,@dramaUid,@characterUid,@characterVoiceVersionUid,
            @voiceIdentityVersionUid,@voiceParentUid,@parentUid,@revision,
            @provider,@model,@voiceKey,@credentialRef,@sourceKind,@voiceName,@voiceLanguage,
            @voiceStyle,@status,@defaultEmotion,@emotionMapJson,@minimumSpeedPermille,
            @defaultSpeedPermille,@maximumSpeedPermille,@voiceVersionCreatedAtEpochMs,
            @createdAtEpochMs
          )
        `),
        getProfile: database.prepare(`${profileProjection} WHERE profile.uid=?`),
        listProfiles: database.prepare(`
          ${profileProjection}
          WHERE profile.character_uid=? ORDER BY profile.revision,profile.uid
        `),
        getVoice: database.prepare(`SELECT * FROM character_voice_versions WHERE uid=?`),
        getIdentity: database.prepare(`SELECT * FROM character_identity_versions WHERE uid=?`),
        insertSelection: database.prepare(`
          INSERT INTO voice_profile_selection_events (
            uid,drama_uid,character_uid,voice_profile_uid,previous_voice_profile_uid,
            state_version,changed_at_epoch_ms
          ) VALUES (
            @uid,@dramaUid,@characterUid,@voiceProfileUid,@previousVoiceProfileUid,
            @stateVersion,@changedAtEpochMs
          )
        `),
        getSelection: database.prepare(`
          SELECT * FROM voice_profile_selection_events WHERE uid=?
        `),
        listSelections: database.prepare(`
          SELECT * FROM voice_profile_selection_events
          WHERE character_uid=? ORDER BY state_version,uid
        `),
      });
    }
    return statements;
  }

  function mapLiveVoice(row) {
    try {
      const rawMetadata = row.metadata_json;
      const metadata = JSON.parse(rawMetadata);
      if (JSON.stringify(metadata) !== rawMetadata) throw new TypeError('noncanonical voice metadata');
      const voice = createCharacterVersionRecord({
        schemaVersion: '5.0',
        kind: 'voice',
        uid: row.uid,
        characterUid: row.character_uid,
        identityVersionUid: row.identity_version_uid,
        parentUid: row.parent_uid,
        metadata,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
      return Object.freeze({
        uid: voice.uid,
        identityVersionUid: voice.identityVersionUid,
        parentUid: voice.parentUid,
        name: voice.metadata.name,
        language: voice.metadata.language,
        style: voice.metadata.style,
        createdAtEpochMs: voice.createdAtEpochMs,
      });
    } catch {
      throw new V2RepositoryDataError('voice profile', 'character voice evidence');
    }
  }

  function mapLiveIdentity(row) {
    try {
      const metadata = JSON.parse(row.metadata_json);
      if (JSON.stringify(metadata) !== row.metadata_json) {
        throw new TypeError('noncanonical identity metadata');
      }
      return createCharacterVersionRecord({
        schemaVersion: '5.0',
        kind: 'identity',
        uid: row.uid,
        characterUid: row.character_uid,
        parentUid: row.parent_uid,
        metadata,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch {
      throw new V2RepositoryDataError('voice profile', 'character identity evidence');
    }
  }

  function validateIdentityLineage(identityUid, characterUid, validated) {
    let currentUid = identityUid;
    const seen = new Set();
    while (currentUid !== null) {
      if (seen.has(currentUid)) {
        throw new V2RepositoryDataError('voice profile', 'character identity lineage');
      }
      seen.add(currentUid);
      if (validated.has(currentUid)) return;
      const row = getStatements().getIdentity.get(currentUid);
      if (!row) throw new V2RepositoryDataError('voice profile', 'character identity evidence');
      const identity = mapLiveIdentity(row);
      if (identity.characterUid !== characterUid) {
        throw new V2RepositoryDataError('voice profile', 'character identity owner');
      }
      validated.add(identity.uid);
      currentUid = identity.parentUid;
    }
  }

  function validateVoiceLineage(voiceUid, characterUid) {
    let currentUid = voiceUid;
    let child = null;
    let leaf = null;
    const seen = new Set();
    const validatedIdentities = new Set();
    while (currentUid !== null) {
      if (seen.has(currentUid)) {
        throw new V2RepositoryDataError('voice profile', 'character voice lineage');
      }
      seen.add(currentUid);
      const row = getStatements().getVoice.get(currentUid);
      if (!row) throw new V2RepositoryDataError('voice profile', 'character voice evidence');
      const voice = mapLiveVoice(row);
      if (
        row.character_uid !== characterUid
        || (child && child.identityVersionUid !== voice.identityVersionUid)
      ) throw new V2RepositoryDataError('voice profile', 'character voice owner');
      validateIdentityLineage(voice.identityVersionUid, characterUid, validatedIdentities);
      if (!leaf) leaf = voice;
      child = voice;
      currentUid = voice.parentUid;
    }
    return leaf;
  }

  function mapProfile(row) {
    try {
      const parsedEmotionMap = JSON.parse(row.emotion_map_json);
      const record = createVoiceProfileRecord({
        schemaVersion: '8.0',
        uid: row.uid,
        dramaUid: row.drama_uid,
        characterUid: row.character_uid,
        characterVoiceVersionUid: row.character_voice_version_uid,
        parentUid: row.parent_uid,
        revision: row.revision,
        provider: row.provider,
        model: row.model,
        voiceKey: row.voice_key,
        credentialRef: row.credential_ref,
        sourceKind: row.source_kind,
        status: row.status,
        defaultEmotion: row.default_emotion,
        emotionMap: parsedEmotionMap,
        minimumSpeedPermille: row.minimum_speed_permille,
        defaultSpeedPermille: row.default_speed_permille,
        maximumSpeedPermille: row.maximum_speed_permille,
        voiceVersion: {
          uid: row.character_voice_version_uid,
          identityVersionUid: row.voice_identity_version_uid,
          parentUid: row.voice_parent_uid,
          name: row.voice_name,
          language: row.voice_language,
          style: row.voice_style,
          createdAtEpochMs: row.voice_version_created_at_epoch_ms,
        },
        createdAtEpochMs: row.created_at_epoch_ms,
      });
      if (JSON.stringify(record.emotionMap) !== row.emotion_map_json) {
        throw new TypeError('emotion map is not canonical');
      }
      const live = validateVoiceLineage(record.characterVoiceVersionUid, record.characterUid);
      if (
        live.uid !== record.voiceVersion.uid
        || live.identityVersionUid !== record.voiceVersion.identityVersionUid
        || live.parentUid !== record.voiceVersion.parentUid
        || live.name !== record.voiceVersion.name
        || live.language !== record.voiceVersion.language
        || live.style !== record.voiceVersion.style
        || live.createdAtEpochMs !== record.voiceVersion.createdAtEpochMs
      ) throw new TypeError('voice evidence drift');
      return record;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError('voice profile', 'persisted record');
    }
  }

  function mapSelection(row) {
    try {
      return createVoiceProfileSelectionRecord({
        schemaVersion: '8.0',
        uid: row.uid,
        dramaUid: row.drama_uid,
        characterUid: row.character_uid,
        voiceProfileUid: row.voice_profile_uid,
        previousVoiceProfileUid: row.previous_voice_profile_uid,
        stateVersion: row.state_version,
        changedAtEpochMs: row.changed_at_epoch_ms,
      });
    } catch {
      throw new V2RepositoryDataError('voice profile selection', 'persisted record');
    }
  }

  function mapProfileChain(rows, characterUid) {
    const records = rows.map(mapProfile);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const parent = index === 0 ? null : records[index - 1];
      if (
        record.characterUid !== characterUid
        || record.revision !== index + 1
        || record.createdAtEpochMs < record.voiceVersion.createdAtEpochMs
        || (parent === null && record.parentUid !== null)
        || (parent !== null && (
          record.parentUid !== parent.uid
          || record.dramaUid !== parent.dramaUid
          || record.characterUid !== parent.characterUid
          || record.createdAtEpochMs < parent.createdAtEpochMs
        ))
      ) throw new V2RepositoryDataError('voice profile', 'revision chain');
    }
    return freezeSnapshot(records);
  }

  function get(uid) {
    const row = requiredRow(getStatements().getProfile.get(uid), 'voice profile', uid);
    const record = mapProfile(row);
    const matched = list(record.characterUid).find((candidate) => candidate.uid === record.uid);
    if (!matched) throw new V2RepositoryDataError('voice profile', 'revision chain');
    return matched;
  }

  function list(characterUid) {
    return mapProfileChain(getStatements().listProfiles.all(characterUid), characterUid);
  }

  function getSelectionState(characterUid) {
    const profiles = list(characterUid);
    const profilesByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    const selections = getStatements().listSelections.all(characterUid).map(mapSelection);
    for (let index = 0; index < selections.length; index += 1) {
      const selection = selections[index];
      const previous = index === 0 ? null : selections[index - 1];
      const profile = profilesByUid.get(selection.voiceProfileUid);
      if (
        !profile
        || selection.characterUid !== characterUid
        || selection.dramaUid !== profile.dramaUid
        || selection.stateVersion !== index + 1
        || selection.changedAtEpochMs < profile.createdAtEpochMs
        || (previous === null && selection.previousVoiceProfileUid !== null)
        || (previous !== null && (
          selection.previousVoiceProfileUid !== previous.voiceProfileUid
          || selection.dramaUid !== previous.dramaUid
          || selection.characterUid !== previous.characterUid
          || selection.changedAtEpochMs < previous.changedAtEpochMs
        ))
      ) throw new V2RepositoryDataError('voice profile selection', 'selection chain');
    }
    const selection = selections.at(-1);
    if (!selection) return null;
    return Object.freeze({
      selection,
      profile: profilesByUid.get(selection.voiceProfileUid),
    });
  }

  function getActive(characterUid) {
    return getSelectionState(characterUid);
  }

  function insertProfile(record) {
    getStatements().insertProfile.run({
      uid: record.uid,
      dramaUid: record.dramaUid,
      characterUid: record.characterUid,
      characterVoiceVersionUid: record.characterVoiceVersionUid,
      voiceIdentityVersionUid: record.voiceVersion.identityVersionUid,
      voiceParentUid: record.voiceVersion.parentUid,
      parentUid: record.parentUid,
      revision: record.revision,
      provider: record.provider,
      model: record.model,
      voiceKey: record.voiceKey,
      credentialRef: record.credentialRef,
      sourceKind: record.sourceKind,
      status: record.status,
      defaultEmotion: record.defaultEmotion,
      emotionMapJson: JSON.stringify(record.emotionMap),
      minimumSpeedPermille: record.minimumSpeedPermille,
      defaultSpeedPermille: record.defaultSpeedPermille,
      maximumSpeedPermille: record.maximumSpeedPermille,
      voiceName: record.voiceVersion.name,
      voiceLanguage: record.voiceVersion.language,
      voiceStyle: record.voiceVersion.style,
      voiceVersionCreatedAtEpochMs: record.voiceVersion.createdAtEpochMs,
      createdAtEpochMs: record.createdAtEpochMs,
    });
  }

  function insertSelection(record) {
    getStatements().insertSelection.run({
      uid: record.uid,
      dramaUid: record.dramaUid,
      characterUid: record.characterUid,
      voiceProfileUid: record.voiceProfileUid,
      previousVoiceProfileUid: record.previousVoiceProfileUid,
      stateVersion: record.stateVersion,
      changedAtEpochMs: record.changedAtEpochMs,
    });
  }

  const createProfileTransaction = database.transaction((record) => {
    list(record.characterUid);
    insertProfile(record);
    return get(record.uid);
  });

  const activateTransaction = database.transaction((record) => {
    getSelectionState(record.characterUid);
    insertSelection(record);
    requiredRow(getStatements().getSelection.get(record.uid), 'voice profile selection', record.uid);
    const active = getSelectionState(record.characterUid);
    if (!active || active.selection.uid !== record.uid) {
      throw new V2RepositoryDataError('voice profile selection', 'selection chain');
    }
    return active.selection;
  });

  return Object.freeze({
    create(value) {
      const draft = createVoiceProfileDraft(value);
      const voiceRow = requiredRow(
        getStatements().getVoice.get(draft.characterVoiceVersionUid),
        'character voice version',
        draft.characterVoiceVersionUid,
      );
      const voiceVersion = mapLiveVoice(voiceRow);
      const record = createVoiceProfileRecord({ ...draft, voiceVersion });
      return executeWrite('voice profile', 'created', () => createProfileTransaction(record));
    },

    get,
    list,

    activate(value) {
      const record = createVoiceProfileSelectionRecord(value);
      return executeWrite(
        'voice profile selection',
        'created',
        () => activateTransaction(record),
      );
    },

    getActive,
  });
}

module.exports = { createVoiceProfileRepository };
