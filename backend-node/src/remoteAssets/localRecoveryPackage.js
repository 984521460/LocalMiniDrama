'use strict';

const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { parseStrictJson } = require('../security/strictJson');

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ROOT_KEYS = ['schemaVersion', 'runUid', 'checkpoint', 'width', 'height',
  'sampler', 'scheduler', 'steps', 'cfg', 'items'];
const ITEM_KEYS = ['slug', 'name', 'operationUid', 'ordinal', 'seed', 'promptSha256',
  'promptId', 'state', 'filename', 'subfolder', 'type', 'bytes', 'sha256',
  'localPackageName', 'verifiedWidth', 'verifiedHeight'];

function invalid() { throw new TypeError('Local recovery package is invalid'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}
function text(value) {
  if (typeof value !== 'string' || !value.length || value.length > 1024
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.from(value).toString('utf8') !== value) invalid();
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

// Accept bytes, never caller paths. Entries are decoded in memory, never extracted.
async function readLocalRecoveryPackage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PACKAGE_BYTES) invalid();
  const input = Buffer.from(bytes);
  try {
    const zip = new AdmZip(input);
    const entries = zip.getEntries();
    if (entries.length < 2 || entries.length > 17) invalid();
    const files = new Map();
    let total = 0;
    for (const entry of entries) {
      const name = entry.entryName;
      const limit = name === 'manifest.json' ? 256 * 1024 : MAX_IMAGE_BYTES;
      const mode = (entry.attr >>> 16) & 0xf000;
      if (!NAME.test(name) || entry.isDirectory || files.has(name)
        || (mode !== 0 && mode !== 0x8000) || (entry.header.flags & 1)
        || !Number.isSafeInteger(entry.header.size) || entry.header.size < 1
        || entry.header.size > limit) invalid();
      total += entry.header.size;
      if (total > MAX_PACKAGE_BYTES) invalid();
      files.set(name, entry);
    }
    const manifestEntry = files.get('manifest.json');
    if (!manifestEntry) invalid();
    const manifestBytes = manifestEntry.getData();
    const manifestText = manifestBytes.toString('utf8');
    if (!Buffer.from(manifestText).equals(manifestBytes)) invalid();
    const manifest = parseStrictJson(manifestText, 256 * 1024);
    exact(manifest, ROOT_KEYS);
    if (manifest.schemaVersion !== 'project-character-candidate-emergency-run.v1'
      || !UUID.test(manifest.runUid)
      || !Number.isInteger(manifest.width) || manifest.width < 256 || manifest.width > 2048
      || !Number.isInteger(manifest.height) || manifest.height < 256 || manifest.height > 2048
      || !Number.isInteger(manifest.steps) || manifest.steps < 1 || manifest.steps > 100
      || typeof manifest.cfg !== 'number' || !Number.isFinite(manifest.cfg)
      || manifest.cfg < 0 || manifest.cfg > 30
      || !Array.isArray(manifest.items) || !manifest.items.length
      || manifest.items.length > 16 || entries.length !== manifest.items.length + 1) invalid();
    for (const key of ['checkpoint', 'sampler', 'scheduler']) text(manifest[key]);
    const names = new Set();
    const groups = new Map();
    const owners = new Map();
    const items = [];
    for (const item of manifest.items) {
      exact(item, ITEM_KEYS);
      text(item.name);
      if (!NAME.test(item.slug) || !UUID.test(item.operationUid) || !UUID.test(item.promptId)
        || !SHA.test(item.promptSha256) || !SHA.test(item.sha256)
        || item.state !== 'succeeded' || item.type !== 'output'
        || !Number.isInteger(item.seed) || item.seed < 0 || item.seed > 4294967295
        || !Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal > 15
        || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_IMAGE_BYTES
        || !NAME.test(item.filename)
        || item.subfolder !== `character-candidates/${item.operationUid}`
        || item.localPackageName !== `${item.slug}-${item.ordinal + 1}.png`
        || !NAME.test(item.localPackageName) || names.has(item.localPackageName)
        || item.verifiedWidth !== manifest.width || item.verifiedHeight !== manifest.height) invalid();
      names.add(item.localPackageName);
      const group = groups.get(item.name) || { operationUid: item.operationUid, slug: item.slug, count: 0 };
      if (group.operationUid !== item.operationUid || group.slug !== item.slug
        || group.count !== item.ordinal
        || (owners.has(item.operationUid) && owners.get(item.operationUid) !== item.name)) invalid();
      group.count += 1;
      groups.set(item.name, group);
      owners.set(item.operationUid, item.name);
      const entry = files.get(item.localPackageName);
      if (!entry || entry.header.size !== item.bytes) invalid();
      const image = entry.getData();
      if (image.length !== item.bytes || hash(image) !== item.sha256) invalid();
      const decoder = sharp(image, { failOn: 'error', limitInputPixels: 4194304 });
      const metadata = await decoder.metadata();
      if (metadata.format !== 'png' || metadata.width !== manifest.width
        || metadata.height !== manifest.height || (metadata.pages || 1) !== 1) invalid();
      await decoder.raw().toBuffer();
      items.push(Object.freeze({ ...item, bytes: image }));
    }
    return Object.freeze({
      schemaVersion: 'local-recovery-package.v1',
      packageSha256: hash(input),
      sourceManifestSha256: hash(manifestBytes),
      remoteTaskUid: manifest.runUid,
      items: Object.freeze(items),
    });
  } catch { return invalid(); }
}

module.exports = Object.freeze({ MAX_PACKAGE_BYTES, readLocalRecoveryPackage });
