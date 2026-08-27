const crypto = require('node:crypto');

const { sourceDocumentError } = require('./errors');
const { codePointLength } = require('./unicodeText');

const MIN_BLOCK_CODE_POINTS = 1500;
const MAX_BLOCK_CODE_POINTS = 3000;
const MAX_HEADING_COMPONENT_CODE_POINTS = 1000;
const MAX_HEADING_PATH_CODE_POINTS = 3000;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertHeadingPath(path) {
  if (!Array.isArray(path)) throw sourceDocumentError('SOURCE_DOCUMENT_LIMIT_EXCEEDED');
  let total = 0;
  for (const component of path) {
    if (typeof component !== 'string') throw sourceDocumentError('SOURCE_DOCUMENT_LIMIT_EXCEEDED');
    const length = codePointLength(component);
    total += length;
    if (length > MAX_HEADING_COMPONENT_CODE_POINTS || total > MAX_HEADING_PATH_CODE_POINTS) {
      throw sourceDocumentError('SOURCE_DOCUMENT_LIMIT_EXCEEDED');
    }
  }
}

function chooseRanges(totalCodePoints, preferredEnds, hardBoundaries) {
  const ends = [...new Set(preferredEnds
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= totalCodePoints))]
    .sort((left, right) => left - right);
  const boundaries = [
    0,
    ...new Set(hardBoundaries
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value < totalCodePoints)),
    totalCodePoints,
  ].sort((left, right) => left - right);
  const ranges = [];
  let preferredIndex = 0;

  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    let cursor = boundaries[boundaryIndex];
    const hardEnd = boundaries[boundaryIndex + 1];
    while (cursor < hardEnd) {
      const maximum = Math.min(cursor + MAX_BLOCK_CODE_POINTS, hardEnd);
      if (maximum === hardEnd) {
        ranges.push(Object.freeze({ start: cursor, end: maximum }));
        break;
      }

      while (preferredIndex < ends.length && ends[preferredIndex] < cursor + MIN_BLOCK_CODE_POINTS) {
        preferredIndex += 1;
      }
      let selected = null;
      let probe = preferredIndex;
      while (probe < ends.length && ends[probe] <= maximum) {
        selected = ends[probe];
        probe += 1;
      }
      const end = selected || maximum;
      ranges.push(Object.freeze({ start: cursor, end }));
      cursor = end;
    }
  }
  return ranges;
}

function validatedHeadingBoundaries(headings, totalCodePoints) {
  let previousStart = -1;
  const boundaries = [];
  for (const heading of headings) {
    if (!heading
      || !Number.isSafeInteger(heading.sourceStart)
      || heading.sourceStart < 0
      || heading.sourceStart >= totalCodePoints
      || heading.sourceStart <= previousStart) {
      throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
    }
    assertHeadingPath(heading.path);
    previousStart = heading.sourceStart;
    boundaries.push(heading.sourceStart);
  }
  return boundaries;
}

function headingPathForRange(headings, range, state) {
  while (state.index < headings.length && headings[state.index].sourceStart <= range.start) {
    state.lastPath = headings[state.index].path;
    state.index += 1;
  }
  assertHeadingPath(state.lastPath || []);
  return Object.freeze([...(state.lastPath || [])]);
}

function sliceRanges(text, ranges) {
  const slices = [];
  let pointOffset = 0;
  let unitOffset = 0;
  let unitStart = 0;
  for (const range of ranges) {
    if (range.start !== pointOffset) throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
    while (pointOffset < range.end && unitOffset < text.length) {
      const point = text.codePointAt(unitOffset);
      unitOffset += point > 0xffff ? 2 : 1;
      pointOffset += 1;
    }
    if (pointOffset !== range.end) throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
    slices.push(text.slice(unitStart, unitOffset));
    unitStart = unitOffset;
  }
  if (unitOffset !== text.length) throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  return slices;
}

function buildSourceBlocks({ text, structure, createUid }) {
  if (typeof text !== 'string'
    || !structure
    || !Array.isArray(structure.headings)
    || !Array.isArray(structure.paragraphs)
    || typeof createUid !== 'function') {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
  const totalCodePoints = codePointLength(text);
  if (totalCodePoints < 1) throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  const headingBoundaries = validatedHeadingBoundaries(structure.headings, totalCodePoints);
  const ranges = chooseRanges(
    totalCodePoints,
    structure.paragraphs.map((paragraph) => paragraph.sourceEnd),
    headingBoundaries,
  );
  const slices = sliceRanges(text, ranges);
  const headingState = { index: 0, lastPath: Object.freeze([]) };

  return Object.freeze(ranges.map((range, ordinal) => {
    const blockText = slices[ordinal];
    return Object.freeze({
      uid: createUid(),
      ordinal,
      headingPath: headingPathForRange(structure.headings, range, headingState),
      charStart: range.start,
      charEnd: range.end,
      text: blockText,
      textSha256: sha256(blockText),
    });
  }));
}

module.exports = {
  MAX_HEADING_COMPONENT_CODE_POINTS,
  MAX_HEADING_PATH_CODE_POINTS,
  MAX_BLOCK_CODE_POINTS,
  MIN_BLOCK_CODE_POINTS,
  buildSourceBlocks,
};
