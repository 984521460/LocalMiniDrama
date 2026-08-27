const { sourceTextImportError } = require('./errors');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const EXPLICIT_ENCODINGS = new Set(['utf-8', 'gb18030', 'gbk']);

function decodeStrict(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  }
}

function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function analyzeGb18030Bytes(bytes, allowFourByte) {
  let index = 0;
  let hasDoubleByte = false;
  let hasFourByte = false;

  while (index < bytes.length) {
    const first = bytes[index];
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    if (first === 0x80) {
      hasDoubleByte = true;
      index += 1;
      continue;
    }
    if (first < 0x81 || first > 0xfe || index + 1 >= bytes.length) return null;

    const second = bytes[index + 1];
    if (second >= 0x40 && second <= 0xfe && second !== 0x7f) {
      hasDoubleByte = true;
      index += 2;
      continue;
    }
    if (!allowFourByte
      || second < 0x30
      || second > 0x39
      || index + 3 >= bytes.length) return null;

    const third = bytes[index + 2];
    const fourth = bytes[index + 3];
    if (third < 0x81 || third > 0xfe || fourth < 0x30 || fourth > 0x39) return null;
    hasFourByte = true;
    index += 4;
  }

  return Object.freeze({ hasDoubleByte, hasFourByte });
}

function assertDecodedTextIsSafe(text) {
  if (text.length === 0 || text.includes('\u0000')) {
    throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  }
  let disallowedControls = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      disallowedControls += 1;
    }
  }
  if (disallowedControls > 0) {
    throw sourceTextImportError('SOURCE_TEXT_BINARY_REJECTED');
  }
}

function normalizeText(text) {
  const withoutBom = text.startsWith('\ufeff') ? text.slice(1) : text;
  const normalized = withoutBom.replace(/\r\n?/gu, '\n');
  assertDecodedTextIsSafe(normalized);
  return normalized;
}

function decodeWithExplicitEncoding(bytes, requestedEncoding, hasUtf8Bom) {
  const encoding = requestedEncoding.toLowerCase();
  if (requestedEncoding !== requestedEncoding.trim()
    || requestedEncoding !== encoding
    || !EXPLICIT_ENCODINGS.has(encoding)) {
    throw sourceTextImportError('SOURCE_TEXT_ENCODING_UNSUPPORTED');
  }

  if (hasUtf8Bom && encoding !== 'utf-8') {
    throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  }
  if (encoding === 'gbk' && analyzeGb18030Bytes(bytes, false) === null) {
    throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  }
  if (encoding === 'gb18030' && analyzeGb18030Bytes(bytes, true) === null) {
    throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  }

  const payload = hasUtf8Bom && encoding === 'utf-8' ? bytes.subarray(UTF8_BOM.length) : bytes;
  return Object.freeze({
    encoding: hasUtf8Bom ? 'utf-8-bom' : encoding,
    text: normalizeText(decodeStrict(payload, encoding)),
  });
}

function inspectTextEncoding(bytes, requestedEncoding) {
  const hasUtf8Bom = bytes.length >= UTF8_BOM.length
    && bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);

  if (requestedEncoding !== undefined) {
    return decodeWithExplicitEncoding(bytes, requestedEncoding, hasUtf8Bom);
  }

  if (hasUtf8Bom) {
    return Object.freeze({
      encoding: 'utf-8-bom',
      text: normalizeText(decodeStrict(bytes.subarray(UTF8_BOM.length), 'utf-8')),
    });
  }

  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) {
    const normalizedUtf8 = normalizeText(utf8);
    const gbAnalysis = analyzeGb18030Bytes(bytes, true);
    if (gbAnalysis !== null && bytes.some((byte) => byte > 0x7f)) {
      const gbText = tryDecode(bytes, 'gb18030');
      if (gbText !== null && normalizeText(gbText) !== normalizedUtf8) {
        return Object.freeze({
          encodingRequired: true,
          encodingOptions: Object.freeze(gbAnalysis.hasFourByte
            ? ['utf-8', 'gb18030']
            : ['utf-8', 'gb18030', 'gbk']),
        });
      }
    }
    return Object.freeze({ encoding: 'utf-8', text: normalizedUtf8 });
  }

  const gbAnalysis = analyzeGb18030Bytes(bytes, true);
  if (gbAnalysis === null) throw sourceTextImportError('SOURCE_TEXT_DECODE_FAILED');
  if (!gbAnalysis.hasFourByte) {
    return Object.freeze({
      encodingRequired: true,
      encodingOptions: Object.freeze(['gb18030', 'gbk']),
    });
  }

  return Object.freeze({
    encoding: 'gb18030',
    text: normalizeText(decodeStrict(bytes, 'gb18030')),
  });
}

module.exports = {
  inspectTextEncoding,
};
