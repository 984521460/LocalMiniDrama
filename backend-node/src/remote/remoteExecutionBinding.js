'use strict';

const { remoteConnectionEvidenceSha256 } = require('./connectionProfile');

const NODE_MEDIA_TYPES = Object.freeze({
  'shot.image': 'image',
  'shot.video': 'video',
});

function resolveRemoteExecutionBinding({ planNode, task, connection, asset }) {
  const mediaKind = NODE_MEDIA_TYPES[planNode?.nodeType];
  const config = planNode?.config;
  const domainRef = planNode?.domainRef;
  let currentConnectionEvidence;
  try {
    currentConnectionEvidence = remoteConnectionEvidenceSha256(connection);
  } catch {
    return null;
  }
  if (!mediaKind || planNode.enabled !== true
    || !config || !domainRef
    || domainRef.type !== 'asset' || domainRef.uid !== asset?.uid
    || config.manifestUid !== task?.workflowManifestUid
    || config.connectionUid !== task?.connectionUid
    || config.connectionEvidenceSha256 !== task?.connectionEvidenceSha256
    || config.connectionEvidenceSha256 !== currentConnectionEvidence
    || config.credentialRef !== connection?.credentialRef
    || connection?.uid !== task?.connectionUid
    || connection.status !== 'ready'
    || connection.hostFingerprint === null
    || asset?.ownerType !== 'drama'
    || asset.assetType !== mediaKind
    || asset.status === 'deleted') return null;
  return Object.freeze({ mediaKind });
}

module.exports = Object.freeze({
  NODE_MEDIA_TYPES,
  resolveRemoteExecutionBinding,
});
