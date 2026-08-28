'use strict';

const { isProviderNeutralText } = require('../narrative/tasks/providerNeutralText');
const {
  boundedText,
  exactKeys,
  sha256Canonical,
  sha256Text,
  snapshot,
  uid,
} = require('./contract');
const { fail } = require('./errors');
const { H3_PROFILE } = require('./profile');

const CODE = 'H3_PROMPT_INVALID';
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const ENUMS = Object.freeze({
  shotSize: new Set(['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS']),
  cameraAngle: new Set(['eye_level', 'high', 'low', 'dutch', 'overhead', 'pov']),
  cameraMovement: new Set(['static', 'pan', 'tilt', 'dolly', 'truck', 'crane', 'handheld', 'orbit']),
  quality: new Set(['soft', 'hard', 'mixed', 'natural', 'practical']),
  direction: new Set(['front', 'side', 'back', 'top', 'ambient', 'mixed']),
  colorTemperature: new Set(['warm', 'neutral', 'cool', 'mixed']),
  transitionFromPrevious: new Set(['start', 'cut', 'match_cut', 'dissolve']),
  screenDirection: new Set(['left_to_right', 'right_to_left', 'neutral']),
  axisStrategy: new Set(['establish', 'maintain', 'intentional_cross']),
});
const WORDS = Object.freeze({
  shotSize: Object.freeze({ ECU: 'extreme close-up', CU: 'close-up', MCU: 'medium close-up', MS: 'medium shot', MLS: 'medium long shot', LS: 'long shot', ELS: 'extreme long shot' }),
  cameraAngle: Object.freeze({ eye_level: 'eye-level view', high: 'high-angle view', low: 'low-angle view', dutch: 'canted view', overhead: 'overhead view', pov: 'point-of-view framing' }),
  cameraMovement: Object.freeze({ static: 'locked camera', pan: 'panning movement', tilt: 'tilting movement', dolly: 'dolly movement', truck: 'lateral tracking movement', crane: 'crane movement', handheld: 'handheld movement', orbit: 'orbiting movement' }),
  transitionFromPrevious: Object.freeze({ start: 'opening image', cut: 'direct cut', match_cut: 'matched cut', dissolve: 'dissolve' }),
  screenDirection: Object.freeze({ left_to_right: 'movement reads from left to right', right_to_left: 'movement reads from right to left', neutral: 'neutral screen direction' }),
  axisStrategy: Object.freeze({ establish: 'establish the action axis', maintain: 'maintain the action axis', intentional_cross: 'cross the action axis deliberately' }),
});

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(CODE);
  return value;
}

function neutralText(value) {
  const text = boundedText(value, 4000, 16 * 1024, CODE);
  if (!isProviderNeutralText(text)) fail(CODE);
  return text;
}

function enumValue(value, kind) {
  if (!ENUMS[kind].has(value)) fail(CODE);
  return value;
}

function referenceArray(value, kind) {
  if (!Array.isArray(value) || value.length > 128) fail(CODE);
  const facts = new Set();
  return value.map((record) => {
    if (kind === 'character') {
      exactKeys(record, ['factRef', 'characterUid', 'referencePackageUid', 'identityVersionUid', 'costumeVersionUid'], CODE);
      const result = {
        factRef: identifier(record.factRef),
        characterUid: uid(record.characterUid, CODE),
        referencePackageUid: uid(record.referencePackageUid, CODE),
        identityVersionUid: uid(record.identityVersionUid, CODE),
        costumeVersionUid: uid(record.costumeVersionUid, CODE),
      };
      if (facts.has(result.factRef)) fail(CODE);
      facts.add(result.factRef);
      return result;
    }
    exactKeys(record, ['factRef', 'propUid', 'versionUid'], CODE);
    const result = {
      factRef: identifier(record.factRef),
      propUid: uid(record.propUid, CODE),
      versionUid: uid(record.versionUid, CODE),
    };
    if (facts.has(result.factRef)) fail(CODE);
    facts.add(result.factRef);
    return result;
  });
}

function validatedSemanticShot(value) {
  exactKeys(value, [
    'shotId', 'ordinal', 'durationSeconds', 'continuitySnapshotUid', 'subjects',
    'environment', 'action', 'camera', 'lighting', 'continuity',
  ], CODE);
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 6
    || !Number.isSafeInteger(value.durationSeconds)
    || value.durationSeconds < 1 || value.durationSeconds > 60) fail(CODE);
  exactKeys(value.subjects, ['description', 'characters'], CODE);
  exactKeys(value.environment, ['sceneId', 'description', 'scene', 'props'], CODE);
  exactKeys(value.environment.scene, ['sceneUid', 'versionUid'], CODE);
  exactKeys(value.camera, ['shotSize', 'cameraAngle', 'cameraMovement', 'composition'], CODE);
  exactKeys(value.lighting, ['quality', 'direction', 'colorTemperature', 'description'], CODE);
  exactKeys(value.continuity, ['transitionFromPrevious', 'screenDirection', 'axisStrategy', 'notes'], CODE);
  referenceArray(value.subjects.characters, 'character');
  referenceArray(value.environment.props, 'prop');
  const textFields = [
    value.subjects.description, value.environment.description, value.action,
    value.camera.composition, value.lighting.description, value.continuity.notes,
  ];
  textFields.forEach(neutralText);
  identifier(value.shotId);
  uid(value.continuitySnapshotUid, CODE);
  identifier(value.environment.sceneId);
  uid(value.environment.scene.sceneUid, CODE);
  uid(value.environment.scene.versionUid, CODE);
  enumValue(value.camera.shotSize, 'shotSize');
  enumValue(value.camera.cameraAngle, 'cameraAngle');
  enumValue(value.camera.cameraMovement, 'cameraMovement');
  enumValue(value.lighting.quality, 'quality');
  enumValue(value.lighting.direction, 'direction');
  enumValue(value.lighting.colorTemperature, 'colorTemperature');
  enumValue(value.continuity.transitionFromPrevious, 'transitionFromPrevious');
  enumValue(value.continuity.screenDirection, 'screenDirection');
  enumValue(value.continuity.axisStrategy, 'axisStrategy');
  return value;
}

function compileH3ShotPrompt(input) {
  const root = snapshot(input, CODE);
  exactKeys(root, ['dramaUid', 'semanticShot'], CODE);
  const dramaUid = uid(root.dramaUid, CODE);
  const shot = validatedSemanticShot(root.semanticShot);
  const text = [
    `Subjects: ${shot.subjects.description}`,
    `Environment: ${shot.environment.description}`,
    `Action: ${shot.action}`,
    `Shot composition: ${WORDS.shotSize[shot.camera.shotSize]}, ${WORDS.cameraAngle[shot.camera.cameraAngle]}, ${WORDS.cameraMovement[shot.camera.cameraMovement]}; ${shot.camera.composition}`,
    `Lighting: ${shot.lighting.quality} ${shot.lighting.direction} light with a ${shot.lighting.colorTemperature} color balance; ${shot.lighting.description}`,
    `Continuity: ${WORDS.transitionFromPrevious[shot.continuity.transitionFromPrevious]}, ${WORDS.screenDirection[shot.continuity.screenDirection]}, ${WORDS.axisStrategy[shot.continuity.axisStrategy]}; ${shot.continuity.notes}`,
  ].join(' ');
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024 || !isProviderNeutralText(text)) fail(CODE);
  return snapshot({
    schemaVersion: 'h3-shot-prompt.v1',
    profileUid: H3_PROFILE.uid,
    dramaUid,
    shotId: shot.shotId,
    continuitySnapshotUid: shot.continuitySnapshotUid,
    semanticSha256: sha256Canonical(shot),
    promptSha256: sha256Text(text),
    text,
  }, CODE);
}

module.exports = Object.freeze({ compileH3ShotPrompt });
