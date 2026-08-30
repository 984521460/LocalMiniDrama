'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  boundedUtf8Line,
  createBoundedLogWriter,
} = require('../src/utils/boundedLogFile');
const {
  LOG_DIRECTORY_LEASE_INVALID,
  acquireDirectoryLease,
} = require('../src/utils/logDirectoryLease');
const {
  boundedPrimitiveText,
  boundedRedactedStringify,
} = require('../src/utils/redactSecrets');
const {
  TEMP_WORKSPACE_ERROR,
  commitWorkspaceTransaction,
  createTempWorkspace,
  withTempWorkspace,
} = require('../src/utils/tempWorkspace');
const {
  DOWNLOAD_LIMIT_EXCEEDED,
  downloadResponseBodyToFile,
} = require('../src/utils/boundedResponseDownload');
const {
  OUTPUT_PUBLICATION_FAILED,
  publishWorkspaceFiles,
} = require('../src/utils/atomicOutputPublisher');

function taskRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('bounded log writer keeps one physical line and a fixed rotation budget', (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-log-');
  const logPath = path.join(root, 'backend.log');
  const writer = createBoundedLogWriter({
    filePath: logPath,
    maxLineBytes: 128,
    maxFileBytes: 512,
    maxBackups: 2,
  });

  for (let index = 0; index < 40; index += 1) {
    assert.equal(writer.write(`event=${index}\r\n${'x'.repeat(180)}`), true);
  }

  const files = fs.readdirSync(root).sort();
  assert.deepEqual(files, ['backend.log', 'backend.log.1', 'backend.log.2']);
  let totalBytes = 0;
  for (const name of files) {
    const filePath = path.join(root, name);
    const stat = fs.lstatSync(filePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.ok(stat.size <= 512, `${name} exceeded the per-file limit`);
    totalBytes += stat.size;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.every((line) => !line.includes('\r')));
  }
  assert.ok(totalBytes <= 3 * 512);
  assert.match(fs.readFileSync(logPath, 'utf8'), /event=39/);
  assert.equal(fs.existsSync(`${logPath}.3`), false);
});

test('bounded log writer prunes oversized history and truncates by UTF-8 bytes', (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-prune-');
  const logPath = path.join(root, 'backend.log');
  fs.writeFileSync(logPath, Buffer.alloc(900, 0x61));
  fs.writeFileSync(`${logPath}.1`, Buffer.alloc(900, 0x62));
  const writer = createBoundedLogWriter({
    filePath: logPath,
    maxLineBytes: 64,
    maxFileBytes: 128,
    maxBackups: 1,
  });

  assert.equal(writer.write('界'.repeat(100)), true);
  assert.ok(fs.statSync(logPath).size <= 128);
  assert.equal(fs.existsSync(`${logPath}.1`), false);
  assert.ok(Buffer.byteLength(boundedUtf8Line('界'.repeat(100), 64), 'utf8') <= 64);
  assert.match(fs.readFileSync(logPath, 'utf8'), /\[truncated\]/);
});

test('bounded log writer rejects direct and ancestor directory links without outside writes', (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-log-links-');
  const outside = taskRoot(t, 'localminidrama-p9-08-log-outside-');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  const directParent = path.join(root, 'direct-logs');
  fs.symlinkSync(outside, directParent, linkType);
  const directWriter = createBoundedLogWriter({ filePath: path.join(directParent, 'app.log') });
  assert.equal(directWriter.write('direct junction event'), false);
  assert.deepEqual(fs.readdirSync(outside), []);

  const ancestor = path.join(root, 'linked-ancestor');
  fs.symlinkSync(outside, ancestor, linkType);
  const ancestorWriter = createBoundedLogWriter({
    filePath: path.join(ancestor, 'nested', 'app.log'),
  });
  assert.equal(ancestorWriter.write('ancestor junction event'), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('native bounded log rotation remains inside the leased directory after path replacement', (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-log-replace-');
  const outside = taskRoot(t, 'localminidrama-p9-08-log-replace-outside-');
  const parent = path.join(root, 'logs');
  const moved = path.join(root, 'logs-moved');
  fs.mkdirSync(parent);
  const logPath = path.join(parent, 'app.log');
  fs.writeFileSync(logPath, 'x'.repeat(128));
  fs.writeFileSync(path.join(outside, 'app.log'), 'outside-current');
  fs.writeFileSync(path.join(outside, 'app.log.1'), 'outside-backup');
  const identity = fs.lstatSync(parent, { bigint: true });
  const lease = acquireDirectoryLease(parent, identity);
  let replacementCode = null;
  try {
    fs.renameSync(parent, moved);
    fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    replacementCode = 'REPLACED';
  } catch (error) {
    replacementCode = error?.code || 'UNKNOWN';
  }
  assert.match(replacementCode, /^(?:EACCES|EBUSY|EPERM)$/u);
  assert.equal(lease.appendBoundedLog(
    path.basename(logPath),
    Buffer.from('rotation replacement event\n', 'utf8'),
    128,
    1,
  ), true);
  assert.equal(lease.release(), true);
  assert.equal(fs.existsSync(moved), false);
  assert.equal(fs.readFileSync(path.join(parent, 'app.log.1'), 'utf8'), 'x'.repeat(128));
  assert.equal(fs.readFileSync(path.join(parent, 'app.log'), 'utf8'), 'rotation replacement event\n');
  assert.equal(fs.readFileSync(path.join(outside, 'app.log'), 'utf8'), 'outside-current');
  assert.equal(fs.readFileSync(path.join(outside, 'app.log.1'), 'utf8'), 'outside-backup');
});

test('native bounded log rejects hard links, missing parents, and hostile lease identities', (t) => {
  if (process.platform !== 'win32') return;
  const root = taskRoot(t, 'localminidrama-p9-08-log-hardlink-');
  const outside = taskRoot(t, 'localminidrama-p9-08-log-hardlink-outside-');
  const parent = path.join(root, 'logs');
  fs.mkdirSync(parent);
  const logPath = path.join(parent, 'app.log');
  const outsideCurrent = path.join(outside, 'outside-current.log');
  fs.writeFileSync(outsideCurrent, 'outside-current');
  fs.linkSync(outsideCurrent, logPath);
  const writer = createBoundedLogWriter({
    filePath: logPath,
    maxLineBytes: 64,
    maxFileBytes: 128,
    maxBackups: 1,
  });
  assert.equal(writer.write('must not follow a hard link'), false);
  assert.equal(fs.readFileSync(outsideCurrent, 'utf8'), 'outside-current');

  fs.unlinkSync(logPath);
  fs.writeFileSync(logPath, 'x'.repeat(128));
  const outsideBackup = path.join(outside, 'outside-backup.log');
  fs.writeFileSync(outsideBackup, 'outside-backup');
  fs.linkSync(outsideBackup, `${logPath}.1`);
  assert.equal(writer.write('must not replace a hard-linked backup'), false);
  assert.equal(fs.readFileSync(outsideBackup, 'utf8'), 'outside-backup');
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'x'.repeat(128));

  const missingParent = path.join(root, 'missing');
  const missingWriter = createBoundedLogWriter({ filePath: path.join(missingParent, 'app.log') });
  assert.equal(missingWriter.write('missing parent'), false);
  assert.equal(fs.existsSync(missingParent), false);

  let reads = 0;
  const hostileIdentity = new Proxy({}, {
    getOwnPropertyDescriptor() {
      reads += 1;
      throw new Error('identity sentinel');
    },
  });
  assert.throws(
    () => acquireDirectoryLease(parent, hostileIdentity),
    (error) => error && error.code === LOG_DIRECTORY_LEASE_INVALID
      && !String(error.message).includes('sentinel'),
  );
  assert.equal(reads, 0);
});

test('native directory leases enforce bounded depth and reject 32 KiB paths with bounded memory', (t) => {
  if (process.platform !== 'win32') return;
  const root = taskRoot(t, 'localminidrama-p9-08a-depth-');
  const rootPrefix = path.parse(root).root;
  const rootDepth = root.slice(rootPrefix.length).split(path.sep).filter(Boolean).length;
  assert.ok(rootDepth < 64);

  let maximumDepthPath = root;
  for (let depth = rootDepth; depth < 64; depth += 1) {
    maximumDepthPath = path.join(maximumDepthPath, 'd');
  }
  fs.mkdirSync(maximumDepthPath, { recursive: true });
  const maximumIdentity = fs.lstatSync(maximumDepthPath, { bigint: true });
  const lease = acquireDirectoryLease(maximumDepthPath, maximumIdentity);
  assert.equal(lease.release(), true);

  const overDepthPath = path.join(maximumDepthPath, 'd');
  fs.mkdirSync(overDepthPath);
  const overDepthIdentity = fs.lstatSync(overDepthPath, { bigint: true });
  assert.throws(
    () => acquireDirectoryLease(overDepthPath, overDepthIdentity),
    (error) => error?.code === LOG_DIRECTORY_LEASE_INVALID,
  );

  const modulePath = require.resolve('../src/utils/logDirectoryLease');
  const probe = childProcess.spawnSync(process.execPath, [
    '-e',
    `
      const { acquireDirectoryLease } = require(process.argv[1]);
      const before = process.resourceUsage().maxRSS;
      const syntheticPath = 'C:\\\\' + Array(16_300).fill('a').join('\\\\');
      const started = Date.now();
      let code = null;
      try {
        acquireDirectoryLease(syntheticPath, { dev: 0n, ino: 0n });
      } catch (error) {
        code = error && error.code;
      }
      process.stdout.write(JSON.stringify({
        code,
        elapsedMs: Date.now() - started,
        peakDeltaKiB: process.resourceUsage().maxRSS - before,
      }));
    `,
    modulePath,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.code, LOG_DIRECTORY_LEASE_INVALID);
  assert.ok(result.peakDeltaKiB < 64 * 1024, JSON.stringify(result));
  assert.ok(result.elapsedMs < 2_000, JSON.stringify(result));
});

test('bounded log serialization truncates hostile and oversized values without getters or stacks', () => {
  let getterReads = 0;
  const value = {
    apiKey: 'synthetic-secret-value',
    error: Object.defineProperty({}, 'message', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'must-not-run';
      },
    }),
    huge: 'z'.repeat(100_000),
  };
  value.self = value;
  const serialized = boundedRedactedStringify(value);

  assert.equal(getterReads, 0);
  assert.doesNotMatch(serialized, /synthetic-secret-value|must-not-run/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /\[truncated\]|\[circular\]/);
  assert.ok(serialized.length < 10_000);
  assert.ok(boundedPrimitiveText('q'.repeat(100_000), 128).length < 160);
  assert.equal(boundedPrimitiveText('D:\\Users\\fixture\\private\\file.txt'), '[path]');
  assert.equal(boundedPrimitiveText('/home/fixture/private/file.txt'), '[path]');
  assert.equal(boundedPrimitiveText('/custom/private-build/output.bin'), '[path]');
  assert.equal(
    boundedPrimitiveText('failed at C:\\Users\\fixture\\private\\file.txt after retry'),
    'failed at [path] after retry',
  );
  assert.equal(
    boundedPrimitiveText('failed at /custom/private-build/output.bin after retry'),
    'failed at [path] after retry',
  );
  assert.equal(boundedPrimitiveText('/api/v2/workflow-runs'), '/api/v2/workflow-runs');
  assert.equal(boundedPrimitiveText('/v2/workflow-runs'), '/v2/workflow-runs');

  let proxyReads = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      proxyReads += 1;
      throw new Error('must-not-run');
    },
  });
  assert.equal(boundedRedactedStringify(proxy), '"[unserializable]"');
  assert.equal(proxyReads, 0);
  const largeSparseArray = [];
  largeSparseArray.length = 10_000_000;
  const sparseResult = boundedRedactedStringify(largeSparseArray);
  assert.match(sparseResult, /\[truncated\]/);
  assert.ok(sparseResult.length < 2_000);
});

test('response downloads stream to disk within an exact byte budget', async (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-download-');
  const target = path.join(root, 'video.bin');
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  }), { headers: { 'content-length': '5' } });

  assert.deepEqual(await downloadResponseBodyToFile(response, target, { maxBytes: 5 }), { bytes: 5 });
  assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4, 5]);
});

test('response downloads cancel and remove partial files at max plus one byte', async (t) => {
  const root = taskRoot(t, 'localminidrama-p9-08-download-limit-');
  const target = path.join(root, 'video.bin');
  let cancelled = false;
  const response = {
    headers: { get() { return null; } },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  };

  await assert.rejects(
    downloadResponseBodyToFile(response, target, { maxBytes: 5 }),
    (error) => error && error.code === DOWNLOAD_LIMIT_EXCEEDED,
  );
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(target), false);
});

test('temp workspaces are unique direct children and cleanup only their owned roots', (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-temp-parent-');
  const sentinel = path.join(tempRoot, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep');
  const first = createTempWorkspace('video-merge', { tempRoot });
  const second = createTempWorkspace('video-merge', { tempRoot });

  assert.notEqual(first.root, second.root);
  assert.equal(path.dirname(first.root), path.resolve(tempRoot));
  assert.equal(path.dirname(second.root), path.resolve(tempRoot));
  fs.writeFileSync(first.resolveFile('candidate.bin'), 'first');
  fs.writeFileSync(second.resolveFile('candidate.bin'), 'second');
  assert.throws(
    () => first.resolveFile('../outside.bin'),
    (error) => error && error.code === TEMP_WORKSPACE_ERROR,
  );
  assert.equal(first.cleanup(), true);
  assert.equal(first.cleanup(), true);
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.existsSync(second.root), true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(second.cleanup(), true);
});

test('withTempWorkspace cleans return and throw paths without masking operation errors', async (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-wrapper-');
  const roots = [];
  const factory = (kind) => {
    const workspace = createTempWorkspace(kind, { tempRoot });
    roots.push(workspace.root);
    return workspace;
  };
  const log = { warn() {} };

  assert.equal(await withTempWorkspace('narration-post', log, async (workspace) => {
    fs.writeFileSync(workspace.resolveFile('one.txt'), 'one');
    return 'done';
  }, factory), 'done');
  await assert.rejects(
    withTempWorkspace('merged-post', log, async (workspace) => {
      fs.writeFileSync(workspace.resolveFile('two.txt'), 'two');
      throw new Error('synthetic-operation-failure');
    }, factory),
    /synthetic-operation-failure/,
  );
  assert.ok(roots.every((root) => !fs.existsSync(root)));
});

test('withTempWorkspace fails a successful operation when owned cleanup fails', async () => {
  const log = { warn() {} };
  await assert.rejects(
    withTempWorkspace('video-merge', log, async () => 'done', () => ({ cleanup: () => false })),
    (error) => error && error.code === TEMP_WORKSPACE_ERROR,
  );
  await assert.rejects(
    withTempWorkspace('video-merge', log, async () => {
      throw new Error('original-operation-failure');
    }, () => ({ cleanup: () => false })),
    /original-operation-failure/,
  );
});

test('workspace outputs publish as one no-overwrite bundle and roll back conflicts', (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-publish-temp-');
  const persistentRoot = taskRoot(t, 'localminidrama-p9-08-publish-storage-');
  const workspace = createTempWorkspace('video-merge', { tempRoot });
  t.after(() => workspace.cleanup());
  const videoCandidate = workspace.resolveFile('output.mp4');
  const subtitleCandidate = workspace.resolveFile('output.srt');
  fs.writeFileSync(videoCandidate, 'complete-video');
  fs.writeFileSync(subtitleCandidate, 'complete-subtitles');
  const videoTarget = path.join(persistentRoot, 'final.mp4');
  const subtitleTarget = path.join(persistentRoot, 'final.srt');

  const installed = publishWorkspaceFiles(workspace, [
    { sourcePath: videoCandidate, targetPath: videoTarget },
    { sourcePath: subtitleCandidate, targetPath: subtitleTarget },
  ]);
  assert.equal(installed.length, 2);
  assert.equal(fs.readFileSync(videoTarget, 'utf8'), 'complete-video');
  assert.equal(fs.readFileSync(subtitleTarget, 'utf8'), 'complete-subtitles');
  assert.equal(fs.lstatSync(videoTarget).nlink, 1);
  assert.deepEqual(
    fs.readdirSync(persistentRoot).sort(),
    ['final.mp4', 'final.srt'],
  );

  const secondWorkspace = createTempWorkspace('video-merge', { tempRoot });
  t.after(() => secondWorkspace.cleanup());
  const secondVideo = secondWorkspace.resolveFile('second.mp4');
  const secondSubtitle = secondWorkspace.resolveFile('second.srt');
  fs.writeFileSync(secondVideo, 'second-video');
  fs.writeFileSync(secondSubtitle, 'second-subtitles');
  const rolledBackTarget = path.join(persistentRoot, 'rolled-back.mp4');
  assert.throws(
    () => publishWorkspaceFiles(secondWorkspace, [
      { sourcePath: secondVideo, targetPath: rolledBackTarget },
      { sourcePath: secondSubtitle, targetPath: subtitleTarget },
    ]),
    (error) => error && error.code === OUTPUT_PUBLICATION_FAILED,
  );
  assert.equal(fs.existsSync(rolledBackTarget), false);
  assert.equal(fs.readFileSync(subtitleTarget, 'utf8'), 'complete-subtitles');
  assert.deepEqual(
    fs.readdirSync(persistentRoot).sort(),
    ['final.mp4', 'final.srt'],
  );
});

test('workspace cleanup failure rolls back already published media', async (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-publish-cleanup-temp-');
  const persistentRoot = taskRoot(t, 'localminidrama-p9-08-publish-cleanup-storage-');
  const target = path.join(persistentRoot, 'must-not-remain.mp4');
  const factory = (kind) => createTempWorkspace(kind, { tempRoot });

  await assert.rejects(
    withTempWorkspace('video-merge', { warn() {} }, async (workspace) => {
      const candidate = workspace.resolveFile('partial.mp4');
      fs.writeFileSync(candidate, 'complete-media');
      publishWorkspaceFiles(workspace, [{ sourcePath: candidate, targetPath: target }]);
      fs.renameSync(workspace.root, `${workspace.root}-moved`);
      fs.mkdirSync(workspace.root);
      return { ok: true };
    }, factory),
    (error) => error && error.code === TEMP_WORKSPACE_ERROR,
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(persistentRoot), []);
});

test('one outer workspace owns nested post outputs until database work commits', async (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-nested-temp-');
  const persistentRoot = taskRoot(t, 'localminidrama-p9-08-nested-storage-');
  const intermediateTarget = path.join(persistentRoot, 'merged.mp4');
  const postTarget = path.join(persistentRoot, 'merged_post.mp4');
  const subtitleTarget = path.join(persistentRoot, 'merged_narration.srt');

  await assert.rejects(
    withTempWorkspace('video-merge', { warn() {} }, async (workspace) => {
      const intermediateCandidate = workspace.resolveFile('merged-output.mp4');
      fs.writeFileSync(intermediateCandidate, 'complete-intermediate');
      publishWorkspaceFiles(workspace, [
        { sourcePath: intermediateCandidate, targetPath: intermediateTarget },
      ]);

      const postCandidate = workspace.resolveFile('post-process-output.mp4');
      const subtitleCandidate = workspace.resolveFile('narration-subtitles.srt');
      fs.writeFileSync(postCandidate, 'complete-post-output');
      fs.writeFileSync(subtitleCandidate, 'complete-subtitles');
      publishWorkspaceFiles(workspace, [
        { sourcePath: postCandidate, targetPath: postTarget },
        { sourcePath: subtitleCandidate, targetPath: subtitleTarget },
      ]);
      fs.unlinkSync(intermediateTarget);
      throw new Error('synthetic-database-failure');
    }, (kind) => createTempWorkspace(kind, { tempRoot })),
    /synthetic-database-failure/,
  );

  assert.equal(fs.existsSync(intermediateTarget), false);
  assert.equal(fs.existsSync(postTarget), false);
  assert.equal(fs.existsSync(subtitleTarget), false);
  assert.deepEqual(fs.readdirSync(persistentRoot), []);
});

test('database completion and workspace publication commit or roll back together', async (t) => {
  const Database = require('better-sqlite3');
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-commit-temp-');
  const persistentRoot = taskRoot(t, 'localminidrama-p9-08-commit-storage-');
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE completion_state (id INTEGER PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO completion_state (id, state) VALUES (1, 'processing'), (2, 'pending');
  `);

  const failedTarget = path.join(persistentRoot, 'failed.mp4');
  await assert.rejects(
    withTempWorkspace('video-merge', { warn() {} }, async (workspace) => {
      const candidate = workspace.resolveFile('failed-candidate.mp4');
      fs.writeFileSync(candidate, 'complete-media');
      publishWorkspaceFiles(workspace, [{ sourcePath: candidate, targetPath: failedTarget }]);
      commitWorkspaceTransaction(database, workspace, () => {
        database.prepare('UPDATE completion_state SET state = ? WHERE id = 1').run('completed');
        throw new Error('synthetic-second-write-failure');
      });
    }, (kind) => createTempWorkspace(kind, { tempRoot })),
    /synthetic-second-write-failure/,
  );
  assert.deepEqual(
    database.prepare('SELECT state FROM completion_state ORDER BY id').all(),
    [{ state: 'processing' }, { state: 'pending' }],
  );
  assert.equal(fs.existsSync(failedTarget), false);

  const cleanupFailureTarget = path.join(persistentRoot, 'cleanup-failure.mp4');
  await assert.rejects(
    withTempWorkspace('video-merge', { warn() {} }, async (workspace) => {
      const candidate = workspace.resolveFile('cleanup-failure-candidate.mp4');
      fs.writeFileSync(candidate, 'complete-media');
      publishWorkspaceFiles(workspace, [
        { sourcePath: candidate, targetPath: cleanupFailureTarget },
      ]);
      fs.renameSync(workspace.root, `${workspace.root}-moved`);
      fs.mkdirSync(workspace.root);
      commitWorkspaceTransaction(database, workspace, () => {
        database.prepare('UPDATE completion_state SET state = ?').run('completed');
      });
    }, (kind) => createTempWorkspace(kind, { tempRoot })),
    (error) => error && error.code === TEMP_WORKSPACE_ERROR,
  );
  assert.deepEqual(
    database.prepare('SELECT state FROM completion_state ORDER BY id').all(),
    [{ state: 'processing' }, { state: 'pending' }],
  );
  assert.equal(fs.existsSync(cleanupFailureTarget), false);

  const successTarget = path.join(persistentRoot, 'success.mp4');
  await withTempWorkspace('video-merge', { warn() {} }, async (workspace) => {
    const candidate = workspace.resolveFile('success-candidate.mp4');
    fs.writeFileSync(candidate, 'complete-media');
    publishWorkspaceFiles(workspace, [{ sourcePath: candidate, targetPath: successTarget }]);
    commitWorkspaceTransaction(database, workspace, () => {
      database.prepare('UPDATE completion_state SET state = ?').run('completed');
    });
  }, (kind) => createTempWorkspace(kind, { tempRoot }));
  assert.deepEqual(
    database.prepare('SELECT state FROM completion_state ORDER BY id').all(),
    [{ state: 'completed' }, { state: 'completed' }],
  );
  assert.equal(fs.readFileSync(successTarget, 'utf8'), 'complete-media');
});

test('temp workspace refuses cleanup after root replacement and preserves unrelated data', (t) => {
  const tempRoot = taskRoot(t, 'localminidrama-p9-08-replace-parent-');
  const workspace = createTempWorkspace('video-merge', { tempRoot });
  const moved = `${workspace.root}-moved`;
  fs.renameSync(workspace.root, moved);
  fs.mkdirSync(workspace.root);
  const sentinel = path.join(workspace.root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep');

  assert.equal(workspace.cleanup(), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(fs.existsSync(moved), true);
});

test('media services use owned temp workspaces instead of shared timestamp directories', () => {
  for (const fileName of [
    'videoMergeService.js',
    'narrationVideoPostProcess.js',
    'mergedEpisodePostProcess.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', fileName), 'utf8');
    assert.match(source, /withTempWorkspace\(/, fileName);
    assert.match(source, /publishWorkspaceFiles\(/, fileName);
    assert.doesNotMatch(source, /drama-(?:video-merge|narr-post|merged-post)/u, fileName);
    assert.doesNotMatch(source, /readdirSync\(tempRoot\)|rmdirSync\(tempRoot\)/u, fileName);
  }
  const mergeSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'videoMergeService.js'),
    'utf8',
  );
  assert.match(mergeSource, /MAX_MERGE_SCENES/u);
  assert.match(mergeSource, /MAX_REMOTE_DOWNLOAD_TOTAL_BYTES/u);
  assert.match(mergeSource, /mergeOpts,\s*workspace,\s*\}\);/u);
  assert.match(mergeSource, /commitWorkspaceTransaction\(db, workspace/u);
  assert.doesNotMatch(mergeSource, /arrayBuffer\(\)/u);
  const mergedPostSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'mergedEpisodePostProcess.js'),
    'utf8',
  );
  assert.match(mergedPostSource, /sharedWorkspace\s*\?\s*await execute\(sharedWorkspace\)/u);
});
