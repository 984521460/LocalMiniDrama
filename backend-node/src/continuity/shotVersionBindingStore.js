const { V2RepositoryDataError } = require('../repositories/v2/errors');
const { assertDatabase } = require('../repositories/v2/repositorySupport');

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createShotVersionBindingStore(database) {
  assertDatabase(database);
  const statements = Object.freeze({
    charactersByName: database.prepare(`
      SELECT character.uid
      FROM characters AS character
      JOIN dramas AS drama ON drama.id = character.drama_id
      WHERE drama.uid = @dramaUid
        AND drama.deleted_at IS NULL
        AND character.deleted_at IS NULL
        AND character.name = @name
      ORDER BY character.uid
      LIMIT 2
    `),
    scenesByFact: database.prepare(`
      SELECT scene.uid
      FROM scenes AS scene
      JOIN dramas AS drama ON drama.id = scene.drama_id
      WHERE drama.uid = @dramaUid
        AND drama.deleted_at IS NULL
        AND scene.deleted_at IS NULL
        AND scene.location = @location
        AND scene.time = @time
      ORDER BY scene.uid
      LIMIT 2
    `),
    propsByName: database.prepare(`
      SELECT prop.uid
      FROM props AS prop
      JOIN dramas AS drama ON drama.id = prop.drama_id
      WHERE drama.uid = @dramaUid
        AND drama.deleted_at IS NULL
        AND prop.deleted_at IS NULL
        AND prop.name = @name
      ORDER BY prop.uid
      LIMIT 2
    `),
  });

  function rows(statement, parameters, entity) {
    const records = statement.all(parameters);
    if (!Array.isArray(records) || records.some((row) => (
      !row || typeof row !== 'object' || !UID.test(row.uid)
    ))) throw new V2RepositoryDataError(entity, 'persisted record');
    return Object.freeze(records.map((row) => row.uid));
  }

  return Object.freeze({
    findCharacterUids(dramaUid, name) {
      return rows(statements.charactersByName, { dramaUid, name }, 'character');
    },

    findSceneUids(dramaUid, location, time) {
      return rows(statements.scenesByFact, { dramaUid, location, time }, 'scene');
    },

    findPropUids(dramaUid, name) {
      return rows(statements.propsByName, { dramaUid, name }, 'prop');
    },

    immediate(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Shot version binding transaction is invalid');
      }
      return database.transaction(callback).immediate();
    },
  });
}

module.exports = { createShotVersionBindingStore };
