const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  inspectSourceTextFile,
  isSourceTextImportError,
} = require('../src/narrative/sourceImport');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function expectImportError(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(isSourceTextImportError(error), true);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
}

test('imports UTF-8 BOM Markdown from an immutable byte snapshot and normalizes newlines', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 第一章\r\n\r\n两个人在雨夜相遇。\r第二段。', 'utf8'),
  ]);
  const expectedHash = sha256(bytes);

  const result = inspectSourceTextFile({
    fileName: 'story.MD',
    bytes,
  });
  bytes.fill(0);

  assert.equal(result.status, 'ready');
  assert.equal(result.sourceType, 'markdown');
  assert.equal(result.originalName, 'story.MD');
  assert.equal(result.encoding, 'utf-8-bom');
  assert.equal(result.contentSha256, expectedHash);
  assert.equal(result.rawByteLength > 0, true);
  assert.equal(result.text, '# 第一章\n\n两个人在雨夜相遇。\n第二段。');
  assert.equal(result.normalizedTextSha256, sha256(Buffer.from(result.text, 'utf8')));
  assert.equal(result.copyOriginalBytes().toString('hex').startsWith('efbbbf'), true);
  const firstCopy = result.copyOriginalBytes();
  firstCopy.fill(0);
  assert.notEqual(result.copyOriginalBytes()[0], 0);
});

test('treats ASCII text as deterministic UTF-8', () => {
  const result = inspectSourceTextFile({
    fileName: 'notes.txt',
    bytes: Buffer.from('plain text\r\nsecond line', 'ascii'),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.sourceType, 'txt');
  assert.equal(result.text, 'plain text\nsecond line');
});

test('requires an explicit choice for two-byte GBK/GB18030 ambiguity', () => {
  const bytes = Buffer.from('c4e3bac30acac0bde7', 'hex');
  const pending = inspectSourceTextFile({ fileName: '中文.txt', bytes });

  assert.deepEqual(pending, {
    status: 'encoding_required',
    sourceType: 'txt',
    originalName: '中文.txt',
    rawByteLength: bytes.length,
    contentSha256: sha256(bytes),
    encodingOptions: ['gb18030', 'gbk'],
  });

  const selected = inspectSourceTextFile({
    fileName: '中文.txt',
    bytes,
    encoding: 'gbk',
  });
  assert.equal(selected.status, 'ready');
  assert.equal(selected.encoding, 'gbk');
  assert.equal(selected.text, '你好\n世界');
});

test('requires a choice when no-BOM bytes decode differently as UTF-8 and GBK', () => {
  const bytes = Buffer.from('c2a3', 'hex');
  const pending = inspectSourceTextFile({ fileName: 'ambiguous.txt', bytes });

  assert.deepEqual(pending.encodingOptions, ['utf-8', 'gb18030', 'gbk']);
  assert.equal(pending.status, 'encoding_required');
  assert.equal(inspectSourceTextFile({
    fileName: 'ambiguous.txt', bytes, encoding: 'utf-8',
  }).text, '£');
  assert.equal(inspectSourceTextFile({
    fileName: 'ambiguous.txt', bytes, encoding: 'gbk',
  }).text, '拢');
});

test('recognizes a valid four-byte GB18030 sequence without guessing GBK', () => {
  const bytes = Buffer.concat([
    Buffer.from('表情：', 'utf8'),
    Buffer.from('9439fc36', 'hex'),
  ]);

  // Mixed UTF-8 and GB18030 bytes are not a valid text encoding.
  expectImportError('SOURCE_TEXT_DECODE_FAILED', () => inspectSourceTextFile({
    fileName: 'mixed.txt',
    bytes,
    encoding: 'gb18030',
  }));

  const gb18030 = inspectSourceTextFile({
    fileName: 'emoji.txt',
    bytes: Buffer.from('9439fc36', 'hex'),
  });
  assert.equal(gb18030.status, 'ready');
  assert.equal(gb18030.encoding, 'gb18030');
  assert.equal(gb18030.text, '😀');
});

test('rejects unsupported or disguised file names', () => {
  for (const fileName of [
    'story.md.exe',
    'story.docx',
    '../story.txt',
    'folder/story.md',
    'story.txt.',
    'story.txt:stream',
    '.txt',
  ]) {
    expectImportError('SOURCE_TEXT_TYPE_UNSUPPORTED', () => inspectSourceTextFile({
      fileName,
      bytes: Buffer.from('safe text', 'utf8'),
    }));
  }
});

test('rejects empty, oversized, binary, NUL and UTF-16 payloads before decoding', () => {
  expectImportError('SOURCE_TEXT_FILE_INVALID', () => inspectSourceTextFile({
    fileName: 'empty.txt',
    bytes: Buffer.alloc(0),
  }));
  expectImportError('SOURCE_TEXT_FILE_TOO_LARGE', () => inspectSourceTextFile({
    fileName: 'large.txt',
    bytes: Buffer.alloc(DEFAULT_SOURCE_TEXT_MAX_BYTES + 1, 0x61),
  }));
  expectImportError('SOURCE_TEXT_BINARY_REJECTED', () => inspectSourceTextFile({
    fileName: 'private.txt',
    bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  }));
  expectImportError('SOURCE_TEXT_BINARY_REJECTED', () => inspectSourceTextFile({
    fileName: 'private.md',
    bytes: Buffer.from('safe\0tail', 'utf8'),
  }));
  for (const bytes of [
    Buffer.from('\n%PDF-1.7 fake payload', 'ascii'),
    Buffer.from('\v%PDF-1.7 fake payload', 'ascii'),
    Buffer.concat([Buffer.from('efbbbf', 'hex'), Buffer.from('%PDF-1.7', 'ascii')]),
    Buffer.concat([Buffer.from('efbbbf0b', 'hex'), Buffer.from('%PDF-1.7', 'ascii')]),
    Buffer.from('\u00a0%PDF-1.7 fake payload', 'utf8'),
    Buffer.from(`${' '.repeat(5000)}%PDF-1.7 fake payload`, 'ascii'),
    Buffer.concat([Buffer.from(' \t', 'ascii'), Buffer.from('504b0304', 'hex'), Buffer.from('AAAA')]),
    Buffer.concat([Buffer.from('efbbbf', 'hex'), Buffer.from('\r\n%PDF-1.7', 'ascii')]),
  ]) {
    expectImportError('SOURCE_TEXT_BINARY_REJECTED', () => inspectSourceTextFile({
      fileName: 'private.txt',
      bytes,
    }));
  }
  expectImportError('SOURCE_TEXT_ENCODING_UNSUPPORTED', () => inspectSourceTextFile({
    fileName: 'utf16.txt',
    bytes: Buffer.from('fffe61000000', 'hex'),
  }));
});

test('validates caller-provided limits and explicit encodings', () => {
  expectImportError('SOURCE_TEXT_FILE_INVALID', () => inspectSourceTextFile({
    fileName: 'story.txt',
    bytes: Buffer.from('abc', 'utf8'),
    maxBytes: 0,
  }));
  expectImportError('SOURCE_TEXT_ENCODING_UNSUPPORTED', () => inspectSourceTextFile({
    fileName: 'story.txt',
    bytes: Buffer.from('abc', 'utf8'),
    encoding: 'utf16le',
  }));
  expectImportError('SOURCE_TEXT_DECODE_FAILED', () => inspectSourceTextFile({
    fileName: 'story.txt',
    bytes: Buffer.from('c4e3bac3', 'hex'),
    encoding: 'utf-8',
  }));
});

test('fails closed on hostile input shapes without reflecting caller values', () => {
  for (const input of [
    null,
    {},
    { fileName: 'private.txt', bytes: 'not-bytes' },
    { fileName: new String('private.txt'), bytes: Buffer.from('text') },
  ]) {
    expectImportError('SOURCE_TEXT_FILE_INVALID', () => inspectSourceTextFile(input));
  }
});

test('rejects typed-array accessors and SharedArrayBuffer before copying bytes', () => {
  const hostile = new Uint8Array([0x61, 0x62]);
  let lengthReads = 0;
  Object.defineProperty(hostile, 'length', {
    configurable: true,
    get() {
      lengthReads += 1;
      return 1024 * 1024 * 1024;
    },
  });
  expectImportError('SOURCE_TEXT_FILE_INVALID', () => inspectSourceTextFile({
    fileName: 'private.txt',
    bytes: hostile,
  }));
  assert.equal(lengthReads, 0);

  if (typeof SharedArrayBuffer === 'function') {
    expectImportError('SOURCE_TEXT_FILE_INVALID', () => inspectSourceTextFile({
      fileName: 'private.txt',
      bytes: new Uint8Array(new SharedArrayBuffer(8)),
    }));
  }
});

test('checks the earliest binary signature with one bounded prefix decode', () => {
  const NativeTextDecoder = global.TextDecoder;
  let decodeCalls = 0;
  let decodedBytes = 0;
  global.TextDecoder = class CountingTextDecoder {
    constructor(...args) {
      this.decoder = new NativeTextDecoder(...args);
    }

    decode(bytes) {
      decodeCalls += 1;
      decodedBytes += bytes.byteLength;
      return this.decoder.decode(bytes);
    }
  };

  const prefix = Buffer.alloc(1024 * 1024, 0x20);
  const bytes = Buffer.concat([
    prefix,
    Buffer.from('%PDF-1.7', 'ascii'),
    Buffer.from('504b0304d0cf11e0a1b11ae1', 'hex'),
  ]);
  try {
    expectImportError('SOURCE_TEXT_BINARY_REJECTED', () => inspectSourceTextFile({
      fileName: 'private.txt',
      bytes,
    }));
  } finally {
    global.TextDecoder = NativeTextDecoder;
  }

  assert.equal(decodeCalls, 1);
  assert.equal(decodedBytes, prefix.length);
});
