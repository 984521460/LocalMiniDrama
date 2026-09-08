'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const missing = (error) => error.code === 'ENOENT';
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function managedFile(filename) {
  let stat;
  try { stat = await fs.promises.lstat(filename, { bigint: true }); } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || ![1n, 2n].includes(stat.nlink)) {
    throw Error('Unsafe managed download file');
  }
  return stat;
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size;
}

async function unchanged(filename, before) {
  const current = await managedFile(filename);
  if (!sameFile(current, before) || current.nlink !== before.nlink) throw Error('Managed file changed');
}

async function assertCopiedPrefix(priorFile, prior, temporary, partial) {
  if (prior.size > partial.size) throw Error('Invalid interrupted prefix copy');
  const handles = [];
  try {
    for (const [filename, stat] of [[priorFile, prior], [temporary, partial]]) {
      const handle = await fs.promises.open(filename, 'r');
      handles.push(handle);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, stat)) throw Error('Copied prefix changed');
    }
    const a = Buffer.alloc(64 * 1024);
    const b = Buffer.alloc(a.length);
    for (let offset = 0; offset < Number(prior.size);) {
      const length = Math.min(a.length, Number(prior.size) - offset);
      const [left, right] = await Promise.all([
        handles[0].read(a, 0, length, offset), handles[1].read(b, 0, length, offset),
      ]);
      if (left.bytesRead !== length || right.bytesRead !== length
        || !a.subarray(0, length).equals(b.subarray(0, length))) throw Error('Unrelated partial');
      offset += length;
    }
    await unchanged(priorFile, prior);
    await unchanged(temporary, partial);
  } finally { for (const handle of handles) await handle.close(); }
}

async function reconcileDataNames(priorFile, temporary, allowResume) {
  const prior = await managedFile(priorFile);
  const partial = await managedFile(temporary);
  if (!prior) {
    if (partial && partial.nlink !== 1n) throw Error('Unknown partial links');
    return;
  }
  if (prior.nlink === 2n) {
    // The one permitted two-link state is exactly the dead owner's private
    // name and the deterministic partial. Re-enter after either link/unlink.
    if (!partial || partial.nlink !== 2n || !sameFile(prior, partial)) throw Error('Unknown private links');
    await unchanged(priorFile, prior);
    await unchanged(temporary, partial);
  } else if (partial) {
    if (partial.nlink !== 1n || sameFile(prior, partial)) throw Error('Unknown partial links');
    // An interruption while copying the previous resume prefix has two
    // different single-link files. Preserve the complete original prefix.
    await assertCopiedPrefix(priorFile, prior, temporary, partial);
  } else if (allowResume) {
    await unchanged(priorFile, prior);
    await fs.promises.link(priorFile, temporary);
    const linked = await managedFile(temporary);
    const original = await managedFile(priorFile);
    if (!sameFile(linked, prior) || !sameFile(original, prior)
      || linked.nlink !== 2n || original.nlink !== 2n) throw Error('Private publication changed');
  }
  await fs.promises.unlink(priorFile);
}

// The OS releases the IPC listener on process termination. Unlike an exclusive
// file create, this serializes both normal owners and crash reclamation without
// a check/unlink/recreate race or time-based stale-lock guesses.
async function acquireDownloadOwnership({ target, temporary, privateFile, binding, allowResume }) {
  const identity = process.platform === 'win32' ? target.toLowerCase() : target;
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\lmd-download-${hash(identity)}` : `\0lmd-download-${hash(identity)}`;
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  const close = () => new Promise((resolve) => server.close(resolve));
  const lockPath = `${temporary}.lock`;
  let owned = false;
  try {
    let existing;
    try { existing = await fs.promises.lstat(lockPath, { bigint: true }); } catch (error) {
      if (!missing(error)) throw error;
    }
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || ![1n, 2n].includes(existing.nlink)
        || existing.size < 1n || existing.size > 1024n) throw Error('Unsafe download ownership');
      const handle = await fs.promises.open(lockPath, 'r');
      let metadata;
      try {
        const st = await handle.stat({ bigint: true });
        if (st.dev !== existing.dev || st.ino !== existing.ino || st.nlink !== existing.nlink
          || st.size !== existing.size) throw Error('Changed download ownership');
        const bytes = Buffer.alloc(Number(st.size));
        const result = await handle.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead !== bytes.length) throw Error('Truncated ownership');
        const text = bytes.toString('utf8');
        metadata = JSON.parse(text);
        if (JSON.stringify(metadata) !== text || Object.keys(metadata).sort().join(',') !== 'binding,pid,token'
          || !Number.isSafeInteger(metadata.pid) || metadata.pid < 1 || !UUID.test(metadata.token)
          || metadata.binding !== binding || alive(metadata.pid)) throw Error('Active or unknown owner');
      } finally { await handle.close(); }
      if (existing.nlink === 2n) {
        const publishedFrom = `${lockPath}.${metadata.pid}.${metadata.token}.pending`;
        const published = await fs.promises.lstat(publishedFrom, { bigint: true });
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 2n
          || published.dev !== existing.dev || published.ino !== existing.ino) throw Error('Unknown ownership link');
        await fs.promises.unlink(publishedFrom);
      }
      await reconcileDataNames(`${temporary}.${metadata.token}`, temporary, allowResume);
      await fs.promises.unlink(lockPath);
    }
    const token = privateFile.slice(temporary.length + 1);
    if (!UUID.test(token)) throw Error('Invalid ownership token');
    const pending = `${lockPath}.${process.pid}.${token}.pending`;
    const handle = await fs.promises.open(pending, 'wx');
    try {
      try {
        await handle.writeFile(JSON.stringify({ binding, pid: process.pid, token }));
        await handle.sync();
      } finally { await handle.close(); }
      // Publish only a complete, durable record, without replacing another name.
      await fs.promises.link(pending, lockPath);
      owned = true;
    } finally { await fs.promises.unlink(pending); }
    return Object.freeze({ async release() {
      try { if (owned) await fs.promises.unlink(lockPath); } finally { await close(); }
    } });
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = Object.freeze({ acquireDownloadOwnership });
