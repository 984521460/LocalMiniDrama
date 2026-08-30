const path = require('path');
const fs = require('fs');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');
const { publishWorkspaceFiles } = require('../utils/atomicOutputPublisher');
const { commitWorkspaceTransaction, withTempWorkspace } = require('../utils/tempWorkspace');
const { downloadResponseBodyToFile } = require('../utils/boundedResponseDownload');

const MAX_MERGE_SCENES = 100;
const MAX_REMOTE_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_REMOTE_DOWNLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(
  videoUrl,
  baseUrl,
  storageRoot,
  workspace,
  downloadBudget,
  index,
  log,
) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = workspace.resolveFile(`download-${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const allowance = Math.min(MAX_REMOTE_VIDEO_BYTES, downloadBudget.remainingBytes);
    if (allowance <= 0) throw new Error('download budget exhausted');
    const result = await downloadResponseBodyToFile(res, destPath, { maxBytes: allowance });
    downloadBudget.remainingBytes -= result.bytes;
    log.info('Video merge: downloaded to temp', { index, bytes: result.bytes });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/** 使用 ffmpeg concat 合并多个视频文件 */
function runFfmpegConcat(localPaths, outputPath, workspace, log) {
  const ffmpegBin = getFfmpegPath();
  const listFile = workspace.resolveFile('concat-list.txt');
  try {
    const lines = localPaths.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    const { spawnSync } = require('child_process');
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      outputPath,
    ];
    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) {
      log.warn('Video merge: ffmpeg spawn error', { error: result.error.message });
      return false;
    }
    if (result.status !== 0) {
      log.warn('Video merge: ffmpeg failed', { stderr: result.stderr?.slice(-500) });
      return false;
    }
    return true;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/**
 * 异步处理视频合成：优先使用 ffmpeg 真正合并多段视频；失败或无 ffmpeg 时用首段作为 merged_url。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '无有效视频片段', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '无有效视频片段');
    return;
  }
  const first = scenes[0];
  const mergedUrlFallback = first && first.video_url ? first.video_url : null;
  if (!mergedUrlFallback) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '首段无视频地址', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '首段无视频地址');
    return;
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const storageRoot = getStorageRoot();
  return withTempWorkspace('video-merge', log, async (workspace) => {
    const localPaths = [];
    const ffmpegAvailable = hasLocalFfmpeg();
    if (ffmpegAvailable && scenes.length <= MAX_MERGE_SCENES) {
      const downloadBudget = { remainingBytes: MAX_REMOTE_DOWNLOAD_TOTAL_BYTES };
      for (let i = 0; i < scenes.length; i++) {
        const p = await resolveVideoToLocalPath(
          scenes[i].video_url,
          baseUrl,
          storageRoot,
          workspace,
          downloadBudget,
          i,
          log
        );
        if (p) localPaths.push(p);
      }
    }

    log.info('Video merge: ffmpeg check', {
      merge_id: mergeId,
      has_ffmpeg: ffmpegAvailable,
      local_video_count: localPaths.length,
    });

    let mergedRelativePath = null;
    if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= MAX_MERGE_SCENES) {
      const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
      const sub = projectSubdir && String(projectSubdir).trim();
      const mergedDir = sub
        ? path.join(storageRoot, sub, 'videos', 'merged')
        : path.join(storageRoot, 'videos', 'merged');
      if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
      const outputFileName = `merged_${Date.now()}.mp4`;
      const outputPath = path.join(mergedDir, outputFileName);
      const candidateOutputPath = workspace.resolveFile('merged-output.mp4');
      const ok = runFfmpegConcat(localPaths, candidateOutputPath, workspace, log);
      if (ok && fs.existsSync(candidateOutputPath)) {
        publishWorkspaceFiles(workspace, [
          { sourcePath: candidateOutputPath, targetPath: outputPath },
        ]);
        mergedRelativePath = sub
          ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
          : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
        log.info('Video merge completed (ffmpeg)', {
          merge_id: mergeId,
          episode_id: episodeId,
          output: mergedRelativePath,
        });
      }
    }

    let mergeOpts = {};
    try {
      mergeOpts = JSON.parse(r.merge_options || '{}');
    } catch (_) {
      mergeOpts = {};
    }
    const postNeed =
      !!mergeOpts.burn_narration_subtitles
      || !!mergeOpts.burn_dialogue_audio
      || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
    if (mergedRelativePath && ffmpegAvailable && postNeed) {
      const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
      if (fs.existsSync(mergedAbsPath)) {
        const mergedPP = require('./mergedEpisodePostProcess');
        const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
          mergedAbsPath,
          storageRoot,
          scenes,
          episodeId,
          mergeOpts,
          workspace,
        });
        if (post.ok && post.relativePath) {
          mergedRelativePath = post.relativePath;
          log.info('Video merge: merged episode post-process', {
            merge_id: mergeId,
            out: mergedRelativePath,
          });
        } else if (post.error && post.error !== 'NO_POST_OPTS') {
          log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
        }
      }
    }

    const finalMergedUrl = mergedRelativePath || mergedUrlFallback;
    commitWorkspaceTransaction(db, workspace, () => {
      db.prepare(
        'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
      ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);
      db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
      if (taskId) {
        taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
      }
    });
    if (!mergedRelativePath) {
      log.info('Video merge completed (first-clip fallback)', { merge_id: mergeId, episode_id: episodeId });
    }
  });
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
};
