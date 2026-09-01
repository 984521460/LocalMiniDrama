'use strict';

const { createNarrativeReviewService, isNarrativeReviewError } = require('../../narrative/reviews');
const {
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../../repositories/v2/errors');
const {
  characterCandidateSourceSha256,
  parseCharacterCandidateSource,
} = require('./source');

class CharacterCandidateSourceError extends Error {
  constructor() {
    super('Character candidate source is stale');
    this.name = 'CharacterCandidateSourceError';
    Object.freeze(this);
  }
}

function stale() {
  throw new CharacterCandidateSourceError();
}

function nullableText(value) {
  return value === null || value === undefined || value === '' ? null : value;
}

function createCharacterCandidateSourceResolver({ repositories } = {}) {
  if (!repositories?.characterCandidateExecutions || !repositories?.narrativeReviews
    || !repositories?.sources) {
    throw new TypeError('Character candidate source resolver dependencies are invalid');
  }
  const reviews = createNarrativeReviewService({ repositories });

  return Object.freeze({
    resolve(request) {
      try {
        const character = repositories.characterCandidateExecutions
          .getCharacterSource(request.characterUid);
        const detail = reviews.getResult(request.extractionResultUid);
        if (character.dramaUid !== request.dramaUid
          || detail.result.dramaUid !== request.dramaUid
          || detail.result.resultType !== 'extraction'
          || detail.result.status !== 'approved'
          || detail.approval === null) stale();
        const facts = detail.result.result.output.characters;
        let fact = null;
        for (let index = 0; index < facts.length; index += 1) {
          if (facts[index].factId !== request.characterFactId) continue;
          if (fact !== null) stale();
          fact = facts[index];
        }
        if (fact === null || fact.name !== character.name) stale();
        const source = parseCharacterCandidateSource({
          schemaVersion: 'character-candidate-source.v1',
          dramaUid: request.dramaUid,
          characterUid: request.characterUid,
          characterName: character.name,
          characterDescription: nullableText(character.description),
          characterPersonality: nullableText(character.personality),
          characterAppearance: nullableText(character.appearance),
          sourceSelectionUid: detail.result.sourceSelectionUid,
          extractionResultUid: detail.result.uid,
          extractionResultHash: detail.result.resultHash,
          extractionEnvelopeHash: detail.result.envelopeHash,
          extractionApprovalRef: detail.approval.reviewRef,
          characterFactId: fact.factId,
          characterFactName: fact.name,
          characterFactDescription: fact.description,
        });
        return Object.freeze({
          source,
          sourceSha256: characterCandidateSourceSha256(source),
        });
      } catch (error) {
        if (error instanceof CharacterCandidateSourceError) throw error;
        if (error instanceof V2RepositoryNotFoundError
          || error instanceof V2RepositoryDataError
          || isNarrativeReviewError(error)) stale();
        throw error;
      }
    },
  });
}

module.exports = Object.freeze({
  CharacterCandidateSourceError,
  createCharacterCandidateSourceResolver,
});
