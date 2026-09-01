'use strict';

const { createHash } = require('node:crypto');

function createCharacterCandidatePrompt(source, ordinal, seed) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 3) {
    throw new TypeError('Character candidate prompt ordinal is invalid');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) {
    throw new TypeError('Character candidate prompt seed is invalid');
  }
  const candidates = [
    source.characterFactDescription,
    source.characterDescription,
    source.characterPersonality,
    source.characterAppearance,
  ];
  const details = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    if (item !== null && item !== source.characterFactDescription) {
      details[details.length] = item;
    }
  }
  let prompt = `Create independent character portrait candidate ${ordinal + 1} of 4.`
    + `\nVariation seed request: ${seed}.`
    + `\nCharacter name: ${source.characterName}.`
    + `\nCanonical description: ${source.characterFactDescription}`;
  if (details.length > 0) {
    let joined = details[0];
    for (let index = 1; index < details.length; index += 1) joined += ` | ${details[index]}`;
    prompt += `\nAdditional approved character notes: ${joined}`;
  }
  prompt += '\nOne character only. Single continuous portrait image.'
    + '\nNo grid, collage, split panel, comparison sheet, text, watermark, border, or contact sheet.'
    + '\nPreserve a production-ready face, hair, costume, palette, age, and silhouette that can be locked as identity evidence.';
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    throw new TypeError('Character candidate prompt exceeds the local bound');
  }
  return Object.freeze({
    prompt,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
  });
}

module.exports = Object.freeze({ createCharacterCandidatePrompt });
