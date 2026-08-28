'use strict';

const COMPATIBLE_ASSET_TYPES = Object.freeze({
  image: Object.freeze(new Set([
    'image', 'reference_image', 'poster', 'character_candidate',
    'character_reference', 'character', 'scene', 'prop',
  ])),
  audio: Object.freeze(new Set(['audio', 'reference_audio', 'voice', 'character_voice'])),
});

function createReferenceOwnershipResolver(database) {
  const owners = Object.freeze({
    drama: database.prepare(`
      SELECT uid AS drama_uid FROM dramas
      WHERE uid=? AND deleted_at IS NULL
    `),
    character: database.prepare(`
      SELECT drama.uid AS drama_uid
      FROM characters AS owner
      JOIN dramas AS drama ON drama.id=owner.drama_id
      WHERE owner.uid=? AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL
    `),
    scene: database.prepare(`
      SELECT drama.uid AS drama_uid
      FROM scenes AS owner
      JOIN dramas AS drama ON drama.id=owner.drama_id
      WHERE owner.uid=? AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL
    `),
    prop: database.prepare(`
      SELECT drama.uid AS drama_uid
      FROM props AS owner
      JOIN dramas AS drama ON drama.id=owner.drama_id
      WHERE owner.uid=? AND owner.deleted_at IS NULL AND drama.deleted_at IS NULL
    `),
    shot: database.prepare(`
      SELECT owner.drama_uid AS drama_uid
      FROM narrative_results AS owner
      JOIN dramas AS drama ON drama.uid=owner.drama_uid
      WHERE owner.uid=? AND owner.result_type='shot' AND drama.deleted_at IS NULL
    `),
  });

  return Object.freeze({
    accepts(asset, expectedDramaUid, mediaKind) {
      const statement = owners[asset?.ownerType];
      const compatibleTypes = COMPATIBLE_ASSET_TYPES[mediaKind];
      if (!statement || !compatibleTypes || asset.status === 'deleted'
        || !compatibleTypes.has(asset.assetType)) return false;
      const owner = statement.get(asset.ownerUid);
      return owner?.drama_uid === expectedDramaUid;
    },
  });
}

module.exports = Object.freeze({ createReferenceOwnershipResolver });
