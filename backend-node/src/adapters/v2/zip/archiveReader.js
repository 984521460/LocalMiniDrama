const AdmZip = require('adm-zip');

const { archiveError, isProjectArchiveError } = require('./errors');

const LIMITS = Object.freeze({
  archiveBytes: 256 * 1024 * 1024,
  entries: 2048,
  entryNameBytes: 1024,
  fileBytes: 256 * 1024 * 1024,
  projectJsonBytes: 8 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  compressionRatio: 200,
});

function unsafePath() {
  throw archiveError('PROJECT_ARCHIVE_UNSAFE_PATH');
}

function assertPortableEntryName(name, isDirectory) {
  if (typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name, 'utf8') > LIMITS.entryNameBytes) {
    unsafePath();
  }
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name)) {
    unsafePath();
  }
  const normalized = isDirectory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (!normalized || (!isDirectory && name.endsWith('/'))) unsafePath();
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) unsafePath();
  if (segments.some((segment) => /%(?:2e|2f|5c)/i.test(segment))) unsafePath();
  return normalized;
}

function headerInteger(entry, field) {
  const value = entry?.header?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  return value;
}

function readEntry(entry, expectedSize) {
  let value;
  try {
    value = entry.getData();
  } catch {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  if (!Buffer.isBuffer(value) || value.length !== expectedSize) {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  return value;
}

function readProjectArchive(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  if (zipBuffer.length > LIMITS.archiveBytes) {
    throw archiveError('PROJECT_ARCHIVE_LIMIT_EXCEEDED');
  }

  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > LIMITS.entries) {
    throw archiveError(entries?.length > LIMITS.entries
      ? 'PROJECT_ARCHIVE_LIMIT_EXCEEDED'
      : 'PROJECT_ARCHIVE_INVALID');
  }

  const names = new Set();
  const portableNames = new Set();
  let declaredTotal = 0;
  const fileEntries = [];
  for (const entry of entries) {
    const name = assertPortableEntryName(entry.entryName, entry.isDirectory === true);
    const portableKey = name.toLocaleLowerCase('en-US');
    if (names.has(name) || portableNames.has(portableKey)) unsafePath();
    names.add(name);
    portableNames.add(portableKey);
    if (entry.isDirectory) continue;

    const size = headerInteger(entry, 'size');
    const compressedSize = headerInteger(entry, 'compressedSize');
    const entryLimit = name === 'project.json' || name === 'v2/manifest.json'
      ? LIMITS.projectJsonBytes
      : LIMITS.fileBytes;
    declaredTotal += size;
    if (size > entryLimit || declaredTotal > LIMITS.totalBytes) {
      throw archiveError('PROJECT_ARCHIVE_LIMIT_EXCEEDED');
    }
    if (size > 0 && (compressedSize === 0 || size / compressedSize > LIMITS.compressionRatio)) {
      throw archiveError('PROJECT_ARCHIVE_LIMIT_EXCEEDED');
    }
    fileEntries.push({ entry, name, size });
  }

  const project = fileEntries.find(({ name }) => name === 'project.json');
  if (!project) throw archiveError('PROJECT_ARCHIVE_INVALID');
  const files = new Map();
  let actualTotal = 0;
  let projectData;
  let manifestData = null;
  try {
    for (const item of fileEntries) {
      const value = readEntry(item.entry, item.size);
      actualTotal += value.length;
      if (actualTotal > LIMITS.totalBytes) throw archiveError('PROJECT_ARCHIVE_LIMIT_EXCEEDED');
      if (item.name === 'project.json') projectData = JSON.parse(value.toString('utf8'));
      else if (item.name === 'v2/manifest.json') manifestData = JSON.parse(value.toString('utf8'));
      else files.set(item.name, value);
    }
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
  if (!projectData || typeof projectData !== 'object' || Array.isArray(projectData)
    || !projectData.drama || typeof projectData.drama !== 'object'
    || typeof projectData.drama.title !== 'string' || projectData.drama.title.trim() === '') {
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }

  return Object.freeze({
    files,
    legacyProject: projectData,
    manifestData,
  });
}

module.exports = {
  LIMITS,
  readProjectArchive,
};
