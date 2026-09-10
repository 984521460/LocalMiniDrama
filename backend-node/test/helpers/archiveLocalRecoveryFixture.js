'use strict';
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const { createLocalPackageImportService } = require('../../src/remoteAssets/localPackageImportService');
const { LocalStorageProvider } = require('../../src/adapters/v2/storage/localStorageProvider');
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function seedArchiveLocalRecovery(t, fixture, storageRoot) {
  const { database, repositories, dramaUid } = fixture;
  if (!storageRoot) {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-archive-local-fixture-'));
    t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  }
  const characterUid = randomUUID();
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(dramaUid);
  database.prepare('INSERT INTO characters (drama_id,name,uid) VALUES (?,?,?)').run(dramaId, '赵云', characterUid);
  const extractionResultUid = database.prepare("SELECT uid FROM narrative_results WHERE drama_uid=? AND result_type='extraction' ORDER BY uid LIMIT 1").pluck().get(dramaUid);
  const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#4980ab' } }).png().toBuffer();
  const operationUid = randomUUID();
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    schemaVersion: 'project-character-candidate-emergency-run.v1', runUid: randomUUID(),
    checkpoint: 'synthetic.safetensors', width: 256, height: 256, sampler: 'euler', scheduler: 'normal', steps: 20, cfg: 6,
    items: [{ slug: 'zhao', name: '赵云', operationUid, ordinal: 0, seed: 1,
      promptSha256: 'a'.repeat(64), promptId: randomUUID(), state: 'succeeded', filename: '0_00002_.png',
      subfolder: `character-candidates/${operationUid}`, type: 'output', bytes: bytes.length, sha256: sha(bytes),
      localPackageName: 'zhao-1.png', verifiedWidth: 256, verifiedHeight: 256 }],
  })));
  zip.addFile('zhao-1.png', bytes);
  const imported=await createLocalPackageImportService({ repositories, storage: new LocalStorageProvider({ projectRoot: storageRoot }) })
    .execute({ dramaUid, characterUid, extractionResultUid, characterFactId: 'character-zhao-yun' }, zip.toBuffer());
  const source=require('../../src/characterCandidates/execution/sourceResolver').createCharacterCandidateSourceResolver({repositories}).resolve({dramaUid,characterUid,extractionResultUid,characterFactId:'character-zhao-yun'});
  const request={schemaVersion:'character-candidate-execution-request.v1',operationUid:randomUUID(),dramaUid,characterUid,extractionResultUid,characterFactId:'character-zhao-yun',width:256,height:256,seed:42};
  const requestJson=require('../../src/characterCandidates/execution/request').canonicalCharacterCandidateExecutionRequest(request);
  const profile=require('../../src/characterCandidates/execution/profile');
  repositories.withTransaction(scoped=>{
    scoped.characterCandidateExecutions.reserve({request,requestSha256:sha(requestJson),source:source.source,sourceSha256:source.sourceSha256,profileJson:profile.PROFILE_JSON,profileSha256:profile.PROFILE_SHA256,manifestJson:profile.MANIFEST_JSON,manifestSha256:profile.MANIFEST_SHA256});
    scoped.characterRemoteCollections.create(requestJson,source.sourceSha256,{connectionUid:randomUUID(),connectionEvidenceSha256:'a'.repeat(64),profileSha256:'b'.repeat(64)},source.source);
    scoped.characterRemoteCollections.begin(request.operationUid,0,require('../../src/characterCandidates/execution/prompt').createCharacterCandidatePrompt(source.source,0,42).promptSha256);
  });
  return imported;
}
module.exports = { seedArchiveLocalRecovery };
