'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createSftpTransfer } = require('../src/remote/sftpTransfer');
const body = Buffer.from('synthetic-output-for-crash-recovery');
const taskUid = '00000000-0000-4000-8000-000000000111';

function fakeSftp(hang) {
  return {
    lstat(name, callback) {
      callback(null, name.endsWith('/output.bin')
        ? { size: body.length, mtime: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
        : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false });
    },
    realpath(name, callback) { callback(null, `/sandbox/${name}`); },
    createReadStream(_name, options) {
      if (!hang) return Readable.from([body.subarray(options?.start || 0)]);
      let started = false;
      return new Readable({ read() {
        if (!started) {
          started = true;
          this.push(body.subarray(0, 3));
          process.send('download-open');
        }
      } });
    },
    end() {},
  };
}

function download(localRoot, hang = false) {
  return createSftpTransfer({ localRoot }).downloadFile({
    session: { async sftp() { return fakeSftp(hang); } },
    localRelativePath: 'downloads/output.bin', remoteWorkDir: 'jobs-root',
    taskUid, relativePath: 'output.bin', expectedSha256: createHash('sha256').update(body).digest('hex'),
  });
}

if (process.argv[2] === 'download-child' || process.argv[2] === 'publish-child'
  || process.argv[2]?.startsWith('takeover-')) {
  if (process.argv[2]?.startsWith('takeover-')) {
    const mode = process.argv[2];
    const link = fs.promises.link;
    const unlink = fs.promises.unlink;
    const pause = () => { process.send('takeover-paused'); return new Promise(() => {}); };
    fs.promises.link = async (from, to) => {
      const result = await link(from, to);
      if (mode === 'takeover-link' && String(to).endsWith('.part')) return pause();
      return result;
    };
    fs.promises.unlink = async (name) => {
      const result = await unlink(name);
      if ((mode === 'takeover-private-unlink' && /[.]part[.][0-9a-f-]{36}$/u.test(name))
        || (mode === 'takeover-lock-unlink' && name.endsWith('.part.lock'))
        || (mode === 'takeover-pending-unlink' && name.endsWith('.pending'))) return pause();
      return result;
    };
  }
  if (process.argv[2] === 'publish-child') {
    const link = fs.promises.link;
    fs.promises.link = async (from, to) => {
      if (String(to).endsWith('.part.lock')) {
        process.send('metadata-ready');
        return new Promise(() => {});
      }
      return link(from, to);
    };
  }
  setInterval(() => {}, 1000);
  download(process.argv[3], true).catch(() => process.exit(2));
} else {
  for (const mode of ['takeover-link', 'takeover-private-unlink', 'takeover-lock-unlink', 'takeover-pending-unlink']) {
    test(`two actual process exits remain retryable at ${mode}`, { timeout: 15000 }, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-takeover-reentry-'));
      let child;
      const stop = async () => { const done = once(child, 'exit'); child.kill(); await done; };
      try {
        child = fork(__filename, ['download-child', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        assert.equal((await once(child, 'message'))[0], 'download-open');
        await stop();
        if (mode === 'takeover-pending-unlink') {
          const lock = path.join(root, 'downloads', '.output.bin.part.lock');
          const metadata = JSON.parse(fs.readFileSync(lock));
          fs.linkSync(lock, `${lock}.${metadata.pid}.${metadata.token}.pending`);
        }
        child = fork(__filename, [mode, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        assert.equal((await once(child, 'message'))[0], 'takeover-paused');
        await assert.rejects(download(root), { code: 'SFTP_TRANSFER_CONFLICT' });
        await stop();
        await download(root);
        assert.deepEqual(fs.readFileSync(path.join(root, 'downloads', 'output.bin')), body);
        assert.deepEqual(fs.readdirSync(path.join(root, 'downloads')), ['output.bin']);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) await stop();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('metadata ENOSPC leaves no published owner and permits the same request retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-metadata-'));
    const originalOpen = fs.promises.open;
    let hits = 0;
    try {
      fs.promises.open = async (...args) => {
        const handle = await originalOpen(...args);
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (data, ...options) => {
          let metadata;
          try { metadata = JSON.parse(data); } catch {}
          if (metadata?.pid === process.pid && metadata.token && metadata.binding) {
            hits += 1;
            throw Object.assign(new Error('metadata disk full'), { code: 'ENOSPC' });
          }
          return write(data, ...options);
        };
        return handle;
      };
      await assert.rejects(download(root));
      assert.equal(hits, 1);
      fs.promises.open = originalOpen;
      assert.equal(fs.existsSync(path.join(root, 'downloads', '.output.bin.part.lock')), false);
      await download(root);
      assert.deepEqual(fs.readFileSync(path.join(root, 'downloads', 'output.bin')), body);
    } finally { fs.promises.open = originalOpen; fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('termination after metadata sync but before publication cannot block restart', { timeout: 15000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sftp-before-publish-'));
    let child;
    try {
      child = fork(__filename, ['publish-child', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      assert.equal((await once(child, 'message'))[0], 'metadata-ready');
      assert.equal(fs.existsSync(path.join(root, 'downloads', '.output.bin.part.lock')), false);
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      await download(root);
      assert.deepEqual(fs.readFileSync(path.join(root, 'downloads', 'output.bin')), body);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('same download is retryable after its actual process is terminated', { timeout: 15000 }, async () => {
    const tempBase = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tempBase, 'lmd-director-sftp-crash-'));
    let child;
    try {
      child = fork(__filename, ['download-child', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const [message] = await once(child, 'message');
      assert.equal(message, 'download-open');
      const lockFile = path.join(root, 'downloads', '.output.bin.part.lock');
      assert.equal(fs.existsSync(lockFile), true, 'setup must interrupt an acquired transfer lock');
      await assert.rejects(download(root), { code: 'SFTP_TRANSFER_CONFLICT' });
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      assert.equal(child.exitCode !== null || child.signalCode !== null, true);
      // No operator deletes/edits the crashed process's artifacts before retry.
      await assert.doesNotReject(download(root), 'a dead transfer owner must not permanently block this asset');
      assert.deepEqual(fs.readFileSync(path.join(root, 'downloads', 'output.bin')), body);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('lmd-director-sftp-crash-')) {
        throw new Error('Unsafe test cleanup');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
}
