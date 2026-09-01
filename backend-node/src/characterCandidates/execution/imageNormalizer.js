'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { MAX_IMAGE_BYTES } = require('./boundedImageSource');

function exactBuffer(value) {
  if (isProxy(value) || !Buffer.isBuffer(value)
    || Object.getPrototypeOf(value) !== Buffer.prototype
    || value.length < 1 || value.length > MAX_IMAGE_BYTES) {
    throw new TypeError('Character candidate image is invalid');
  }
  return Buffer.from(value);
}

function createCharacterCandidateImageNormalizer({ sharpFactory = require('sharp') } = {}) {
  if (typeof sharpFactory !== 'function') {
    throw new TypeError('Character candidate image normalizer is invalid');
  }
  return async function normalizeCharacterCandidateImage(value, width, height) {
    const input = exactBuffer(value);
    try {
      const pipeline = sharpFactory(input, {
        failOn: 'error',
        limitInputPixels: 4_194_304,
        sequentialRead: true,
      });
      const metadata = await pipeline.metadata();
      if (metadata.width !== width || metadata.height !== height
        || (metadata.format !== 'png' && metadata.format !== 'jpeg' && metadata.format !== 'webp')
        || metadata.pages !== undefined && metadata.pages !== 1) {
        throw new TypeError('Character candidate image dimensions are invalid');
      }
      const output = await pipeline
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toBuffer();
      if (!Buffer.isBuffer(output) || output.length < 1 || output.length > MAX_IMAGE_BYTES) {
        throw new TypeError('Character candidate image is invalid');
      }
      return Object.freeze({
        bytes: output,
        mediaType: 'image/png',
        width,
        height,
        contentSha256: createHash('sha256').update(output).digest('hex'),
      });
    } finally {
      input.fill(0);
    }
  };
}

module.exports = Object.freeze({ createCharacterCandidateImageNormalizer });
