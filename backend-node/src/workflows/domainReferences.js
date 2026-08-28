const {
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('../repositories/v2/errors');
const {
  createNarrativeReviewService,
  isNarrativeReviewError,
} = require('../narrative/reviews');

const NARRATIVE_RESULT_TYPES = Object.freeze({
  'story.facts': 'extraction',
  'episode.adaptation': 'adaptation',
  'script.structured': 'script',
  'shot.plan': 'shot',
});
const REMOTE_ASSET_TYPES = Object.freeze({
  'shot.image': 'image',
  'shot.video': 'video',
});

function sameDrama(value, dramaUid) {
  return value?.dramaUid === dramaUid;
}

function validateSourceSelection(repositories, uid, dramaUid) {
  const selection = repositories.sources.getSelection(uid);
  const document = repositories.sources.getDocument(selection.documentUid);
  return sameDrama(document, dramaUid);
}

function validateNarrativeResult(repositories, uid, dramaUid, expectedType) {
  const result = repositories.narrativeReviews.getResult(uid);
  if (!sameDrama(result, dramaUid) || result.resultType !== expectedType) return false;
  createNarrativeReviewService({ repositories }).requireApproved(uid, expectedType);
  return true;
}

function validateRemoteAsset(repositories, uid, dramaUid, expectedType) {
  const asset = repositories.assets.get(uid);
  return asset.ownerType === 'drama'
    && asset.ownerUid === dramaUid
    && asset.assetType === expectedType
    && asset.status !== 'deleted';
}

function isValidBoundDomainReference(node, repositories, dramaUid) {
  if (!node.domainRefType || !node.domainRefUid) return false;
  try {
    if (node.nodeType === 'source.selection') {
      return node.domainRefType === 'source_selection'
        && validateSourceSelection(repositories, node.domainRefUid, dramaUid);
    }
    const expectedAssetType = REMOTE_ASSET_TYPES[node.nodeType];
    if (expectedAssetType) {
      return node.domainRefType === 'asset'
        && validateRemoteAsset(repositories, node.domainRefUid, dramaUid, expectedAssetType);
    }
    const expectedResultType = NARRATIVE_RESULT_TYPES[node.nodeType];
    if (expectedResultType) {
      return node.domainRefType === 'narrative_result'
        && validateNarrativeResult(repositories, node.domainRefUid, dramaUid, expectedResultType);
    }
    return false;
  } catch (error) {
    if (
      error instanceof V2RepositoryNotFoundError
      || error instanceof V2RepositoryDataError
      || isNarrativeReviewError(error)
    ) return false;
    throw error;
  }
}

module.exports = { isValidBoundDomainReference };
