const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSftpTransfer } = require('../src/remote/sftpTransfer');

const TASK_UID = '00000000-0000-4000-8000-000000006000';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

class LocalSftp {
  constructor(root) {
    this.root = root;
    this.ended = false;
  }

  local(remotePath) {
    return path.join(this.root, ...remotePath.split('/'));
  }

  lstat(remotePath, callback) {
    fs.lstat(this.local(remotePath), callback);
  }

  mkdir(remotePath, callback) {
    fs.mkdir(this.local(remotePath), callback);
  }

  realpath(remotePath, callback) {
    fs.realpath(this.local(remotePath), (error, resolved) => {
      if (error) callback(error);
      else callback(null, `/sandbox/${path.relative(this.root, resolved).replace(/\\/gu, '/')}`);
    });
  }

  fastPut(localPath, remotePath, callback) {
    fs.copyFile(localPath, this.local(remotePath), callback);
  }

  fastGet(remotePath, localPath, callback) {
    fs.copyFile(this.local(remotePath), localPath, callback);
  }

  createReadStream(remotePath) {
    return fs.createReadStream(this.local(remotePath));
  }

  rename(from, to, callback) {
    fs.rename(this.local(from), this.local(to), callback);
  }

  unlink(remotePath, callback) {
    fs.unlink(this.local(remotePath), callback);
  }

  end() {
    this.ended = true;
  }
}

function createSession(sftp) {
  return { async sftp() { return sftp; } };
}

test('SFTP upload and download keep task paths isolated and verify both hashes', async (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-local-'));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-remote-'));
  t.after(() => {
    fs.rmSync(localRoot, { force: true, recursive: true });
    fs.rmSync(remoteRoot, { force: true, recursive: true });
  });
  const content = Buffer.from('synthetic checked transfer payload');
  fs.writeFileSync(path.join(localRoot, 'source.bin'), content);
  const sftp = new LocalSftp(remoteRoot);
  const transfer = createSftpTransfer({ localRoot });
  const uploaded = await transfer.uploadFile({
    session: createSession(sftp),
    localRelativePath: 'source.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
    expectedSha256: sha256(content),
  });
  assert.deepEqual(uploaded, {
    remoteRelativePath: `ai-drama-studio/jobs/${TASK_UID}/inputs/source.bin`,
    sha256: sha256(content),
    bytes: content.length,
  });
  assert.deepEqual(
    fs.readFileSync(path.join(remoteRoot, ...uploaded.remoteRelativePath.split('/'))),
    content,
  );
  const replayed = await transfer.uploadFile({
    session: createSession(new LocalSftp(remoteRoot)),
    localRelativePath: 'source.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
    expectedSha256: sha256(content),
  });
  assert.deepEqual(replayed, uploaded);
  const changed = Buffer.from('synthetic changed transfer payload');
  fs.writeFileSync(path.join(localRoot, 'source.bin'), changed);
  await assert.rejects(transfer.uploadFile({
    session: createSession(new LocalSftp(remoteRoot)),
    localRelativePath: 'source.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
    expectedSha256: sha256(changed),
  }), { code: 'SFTP_TRANSFER_CONFLICT' });

  const inspected = await transfer.inspectRemoteFile({
    session: createSession(new LocalSftp(remoteRoot)),
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
  });
  assert.deepEqual(inspected, {
    remoteRelativePath: `ai-drama-studio/jobs/${TASK_UID}/inputs/source.bin`,
    sha256: sha256(content),
    bytes: content.length,
  });

  const downloaded = await transfer.downloadFile({
    session: createSession(new LocalSftp(remoteRoot)),
    localRelativePath: 'downloads/result.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
    expectedSha256: sha256(content),
  });
  assert.deepEqual(downloaded, {
    localRelativePath: 'downloads/result.bin',
    sha256: sha256(content),
    bytes: content.length,
  });
  assert.deepEqual(fs.readFileSync(path.join(localRoot, 'downloads', 'result.bin')), content);
});

test('SFTP transfer rejects traversal, hash drift, and symbolic remote directories', async (t) => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-local-'));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-remote-'));
  t.after(() => {
    fs.rmSync(localRoot, { force: true, recursive: true });
    fs.rmSync(remoteRoot, { force: true, recursive: true });
  });
  fs.writeFileSync(path.join(localRoot, 'source.bin'), 'payload');
  const transfer = createSftpTransfer({ localRoot });
  const sftp = new LocalSftp(remoteRoot);
  for (const relativePath of ['../outside.bin', '/absolute.bin', 'nested//file.bin', 'nested/./file.bin']) {
    await assert.rejects(transfer.uploadFile({
      session: createSession(sftp),
      localRelativePath: 'source.bin',
      remoteWorkDir: 'ai-drama-studio',
      taskUid: TASK_UID,
      relativePath,
      expectedSha256: sha256(Buffer.from('payload')),
    }), { code: 'SFTP_TRANSFER_INPUT_INVALID' });
  }
  await assert.rejects(transfer.uploadFile({
    session: createSession(sftp),
    localRelativePath: 'source.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/source.bin',
    expectedSha256: 'f'.repeat(64),
  }), { code: 'SFTP_TRANSFER_HASH_MISMATCH' });
  assert.equal(fs.existsSync(path.join(
    remoteRoot, 'ai-drama-studio', 'jobs', TASK_UID, 'inputs', 'source.bin',
  )), false);

  const symbolic = new LocalSftp(remoteRoot);
  const originalLstat = symbolic.lstat.bind(symbolic);
  symbolic.lstat = (remotePath, callback) => {
    if (remotePath === 'ai-drama-studio') {
      callback(null, { isDirectory: () => true, isSymbolicLink: () => true });
    } else originalLstat(remotePath, callback);
  };
  await assert.rejects(transfer.uploadFile({
    session: createSession(symbolic),
    localRelativePath: 'source.bin',
    remoteWorkDir: 'ai-drama-studio',
    taskUid: TASK_UID,
    relativePath: 'inputs/symbolic.bin',
    expectedSha256: sha256(Buffer.from('payload')),
  }), { code: 'SFTP_TRANSFER_PATH_UNSAFE' });
});
