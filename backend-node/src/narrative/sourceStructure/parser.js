const crypto = require('node:crypto');

const {
  blockPrefixEnd,
  createMarkdownBudget,
  fencedCodeMapping,
  identityMapping,
  parseBlockPrefix,
  sameBlockContainer,
  sanitizeMarkdown,
} = require('./markdownSanitizer');
const { sourceStructureError } = require('./errors');
const { codePointLength, scanSourceLines } = require('./unicodeOffsets');

const trustedParagraphs = new WeakSet();
const MAX_SOURCE_TEXT_CODE_UNITS = 50 * 1024 * 1024;
const MAX_SOURCE_LINES = 200000;
const MAX_SOURCE_HEADINGS = 50000;
const MAX_SOURCE_PARAGRAPHS = 100000;
const MAX_PARAGRAPH_FRAGMENT_CODE_POINTS = 3000;

function snapshotInput(input) {
  if (input === null || typeof input !== 'object') throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
    || (key !== 'text' && key !== 'sourceType'))) {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  const textDescriptor = descriptors.text;
  const typeDescriptor = descriptors.sourceType;
  if (!textDescriptor || !typeDescriptor
    || !Object.hasOwn(textDescriptor, 'value')
    || !Object.hasOwn(typeDescriptor, 'value')) {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  const text = textDescriptor.value;
  const sourceType = typeDescriptor.value;
  if (typeof text !== 'string' || text.length === 0 || typeof sourceType !== 'string') {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  if (text.length > MAX_SOURCE_TEXT_CODE_UNITS) {
    throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
  }
  if ((sourceType !== 'txt' && sourceType !== 'markdown') || /[\r\u0000]/u.test(text)) {
    throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
  }
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw sourceStructureError('SOURCE_STRUCTURE_INVALID');
    }
  }
  return Object.freeze({ text, sourceType });
}

function atxHeading(line) {
  const prefixEnd = blockPrefixEnd(line.text, 0, line.text.length);
  const content = line.text.slice(prefixEnd);
  const match = /^( {0,3})(#{1,6})(?:([ \t]+)(.*)|$)/u.exec(content);
  if (!match) return null;
  const headingContent = match[4] || '';
  const withoutClosing = headingContent.replace(/[ \t]+#+[ \t]*$/u, '');
  const title = withoutClosing.trim();
  if (!title) return Object.freeze({ kind: 'formatting' });
  const contentStart = match[1].length + match[2].length + (match[3] || '').length;
  const leading = withoutClosing.length - withoutClosing.trimStart().length;
  const titleUnitStart = prefixEnd + contentStart + leading;
  const titleUnitEnd = titleUnitStart + title.length;
  return Object.freeze({
    kind: 'heading',
    level: match[2].length,
    title,
    titleUnitStart,
    titleUnitEnd,
  });
}

function classifyMarkdownLines(lines) {
  const annotations = [];
  let fence = null;
  for (const line of lines) {
    const prefix = parseBlockPrefix(line.text, 0, line.text.length);
    const content = line.text.slice(prefix.end);
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(content);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`, 'u');
      if (sameBlockContainer(prefix.tokens, fence.containerTokens) && closing.test(content)) {
        annotations.push({ kind: 'formatting' });
        fence = null;
      } else {
        annotations.push({
          kind: 'text',
          inFence: true,
          fenceContainerTokens: fence.containerTokens,
        });
      }
      continue;
    }
    if (opening) {
      fence = {
        character: opening[1][0],
        length: opening[1].length,
        containerTokens: prefix.tokens,
      };
      annotations.push({ kind: 'formatting' });
      continue;
    }
    if (line.text.trim().length === 0) {
      annotations.push({ kind: 'blank' });
      continue;
    }
    annotations.push(atxHeading(line) || { kind: 'text', inFence: false });
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (annotations[index].kind !== 'text' || annotations[index].inFence) continue;
    const markerPrefix = parseBlockPrefix(lines[index].text, 0, lines[index].text.length);
    const marker = /^ {0,3}(=+|-+)[ \t]*$/u.exec(lines[index].text.slice(markerPrefix.end));
    if (!marker) continue;
    const previous = annotations[index - 1];
    if (previous.kind !== 'text' || previous.inFence || lines[index - 1].text.trim().length === 0) continue;
    const titlePrefix = parseBlockPrefix(lines[index - 1].text, 0, lines[index - 1].text.length);
    if (!sameBlockContainer(titlePrefix.tokens, markerPrefix.tokens)) continue;
    const titleContent = lines[index - 1].text.slice(titlePrefix.end);
    const title = titleContent.trim();
    if (!title) continue;
    const leading = titleContent.length - titleContent.trimStart().length;
    annotations[index - 1] = {
      kind: 'heading',
      level: marker[1][0] === '=' ? 1 : 2,
      title,
      titleUnitStart: titlePrefix.end + leading,
      titleUnitEnd: titlePrefix.end + leading + title.length,
    };
    annotations[index] = { kind: 'formatting' };
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (annotations[index].kind !== 'text' || annotations[index].inFence) continue;
    const prefixEnd = blockPrefixEnd(lines[index].text, 0, lines[index].text.length);
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(lines[index].text.slice(prefixEnd))) {
      annotations[index] = { kind: 'formatting' };
    }
  }
  return annotations;
}

function createHeading(line, annotation, ordinal, stack) {
  stack.length = annotation.level - 1;
  stack[annotation.level - 1] = annotation.title;
  const path = Object.freeze(stack.filter((part) => typeof part === 'string'));
  const titlePrefix = line.text.slice(0, annotation.titleUnitStart);
  const titleText = line.text.slice(annotation.titleUnitStart, annotation.titleUnitEnd);
  return Object.freeze({
    ordinal,
    level: annotation.level,
    title: annotation.title,
    path,
    sourceStart: line.sourceStart,
    sourceEnd: line.sourceEnd,
    titleStart: line.sourceStart + codePointLength(titlePrefix),
    titleEnd: line.sourceStart + codePointLength(titlePrefix) + codePointLength(titleText),
  });
}

function paragraphHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function createFragmentBoundaries(rawText, sourceStart) {
  const boundaries = [];
  let unitStart = 0;
  let pointStart = sourceStart;
  while (unitStart < rawText.length) {
    let unitEnd = unitStart;
    let pointLength = 0;
    while (unitEnd < rawText.length && pointLength < MAX_PARAGRAPH_FRAGMENT_CODE_POINTS) {
      const codePoint = rawText.codePointAt(unitEnd);
      unitEnd += codePoint > 0xffff ? 2 : 1;
      pointLength += 1;
    }
    boundaries.push(Object.freeze({
      unitStart,
      unitEnd,
      sourceStart: pointStart,
      sourceEnd: pointStart + pointLength,
    }));
    unitStart = unitEnd;
    pointStart += pointLength;
  }
  return boundaries;
}

function fragmentModel(rawText, boundary, sourceRuns, budget) {
  const pieces = [];
  const offsetMap = [];
  let modelCursor = 0;
  for (const run of sourceRuns) {
    if (run.unitEnd <= boundary.unitStart) continue;
    if (run.unitStart >= boundary.unitEnd) break;
    const unitStart = Math.max(run.unitStart, boundary.unitStart);
    const unitEnd = Math.min(run.unitEnd, boundary.unitEnd);
    if (unitEnd <= unitStart) continue;
    const piece = rawText.slice(unitStart, unitEnd);
    const points = codePointLength(piece);
    const sourceStart = Math.max(run.sourceStart, boundary.sourceStart);
    budget.consumeMapping();
    offsetMap.push(Object.freeze({
      modelStart: modelCursor,
      modelEnd: modelCursor + points,
      sourceStart,
      sourceEnd: sourceStart + points,
    }));
    pieces.push(piece);
    modelCursor += points;
  }
  return Object.freeze({
    modelText: pieces.join(''),
    offsetMap: Object.freeze(offsetMap),
  });
}

function createParagraphFragments(
  text,
  sourceType,
  lines,
  headingPath,
  paragraphOrdinal,
  inFence,
  fenceContainerTokens,
  budget,
  firstOrdinal,
  availableFragments,
) {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const rawText = text.slice(first.unitStart, last.unitEnd);
  let mapping;
  if (sourceType === 'markdown' && inFence) {
    mapping = fencedCodeMapping(rawText, first.sourceStart, fenceContainerTokens, budget);
  } else if (sourceType === 'markdown') {
    mapping = sanitizeMarkdown(rawText, first.sourceStart, budget);
  } else {
    mapping = identityMapping(rawText, first.sourceStart, budget);
  }
  const boundaries = createFragmentBoundaries(rawText, first.sourceStart);
  if (boundaries.length > availableFragments) {
    throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
  }
  const frozenHeadingPath = Object.freeze([...headingPath]);
  const fragments = boundaries.map((boundary, fragmentOrdinal) => {
    const fragmentRawText = rawText.slice(boundary.unitStart, boundary.unitEnd);
    const fragmentMapping = fragmentModel(rawText, boundary, mapping.sourceRuns, budget);
    const paragraph = Object.freeze({
      ordinal: firstOrdinal + fragmentOrdinal,
      paragraphOrdinal,
      fragmentOrdinal,
      fragmentCount: boundaries.length,
      contentKind: inFence ? 'fenced_code' : 'prose',
      headingPath: frozenHeadingPath,
      sourceStart: boundary.sourceStart,
      sourceEnd: boundary.sourceEnd,
      rawText: fragmentRawText,
      rawTextSha256: paragraphHash(fragmentRawText),
      modelText: fragmentMapping.modelText,
      modelTextSha256: paragraphHash(fragmentMapping.modelText),
      offsetMap: fragmentMapping.offsetMap,
    });
    trustedParagraphs.add(paragraph);
    return paragraph;
  });
  return fragments;
}

function parseSourceStructure(input) {
  const { text, sourceType } = snapshotInput(input);
  const lines = scanSourceLines(text, MAX_SOURCE_LINES);
  if (lines === null) throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
  const annotations = sourceType === 'markdown'
    ? classifyMarkdownLines(lines)
    : lines.map((line) => ({ kind: line.text.trim().length === 0 ? 'blank' : 'text' }));
  const headings = [];
  const paragraphs = [];
  const headingStack = [];
  const budget = createMarkdownBudget();
  let paragraphLines = [];
  let paragraphInFence = false;
  let paragraphFenceContainerTokens = Object.freeze([]);
  let logicalParagraphCount = 0;

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    const fragments = createParagraphFragments(
      text,
      sourceType,
      paragraphLines,
      headingStack.filter((part) => typeof part === 'string'),
      logicalParagraphCount,
      paragraphInFence,
      paragraphFenceContainerTokens,
      budget,
      paragraphs.length,
      MAX_SOURCE_PARAGRAPHS - paragraphs.length,
    );
    paragraphs.push(...fragments);
    logicalParagraphCount += 1;
    paragraphLines = [];
    paragraphInFence = false;
    paragraphFenceContainerTokens = Object.freeze([]);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const annotation = annotations[index];
    if (annotation.kind === 'text') {
      const inFence = annotation.inFence === true;
      const fenceContainerTokens = annotation.fenceContainerTokens || Object.freeze([]);
      if (paragraphLines.length > 0 && (paragraphInFence !== inFence
        || (inFence && !sameBlockContainer(paragraphFenceContainerTokens, fenceContainerTokens)))) {
        flushParagraph();
      }
      paragraphInFence = inFence;
      paragraphFenceContainerTokens = fenceContainerTokens;
      paragraphLines.push(line);
      continue;
    }
    flushParagraph();
    if (annotation.kind === 'heading') {
      if (headings.length >= MAX_SOURCE_HEADINGS) {
        throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
      }
      headings.push(createHeading(line, annotation, headings.length, headingStack));
    }
  }
  flushParagraph();

  return Object.freeze({
    schemaVersion: 'source-structure.v1',
    sourceType,
    textCodePoints: codePointLength(text),
    logicalParagraphCount,
    headings: Object.freeze(headings),
    paragraphs: Object.freeze(paragraphs),
  });
}

function mapModelRangeToSource(paragraph, modelStart, modelEnd) {
  if (!trustedParagraphs.has(paragraph)
    || !Number.isSafeInteger(modelStart)
    || !Number.isSafeInteger(modelEnd)
    || modelStart < 0
    || modelEnd <= modelStart) {
    throw sourceStructureError('SOURCE_STRUCTURE_OFFSET_INVALID');
  }
  let sourceStart = null;
  let sourceEnd = null;
  let covered = 0;
  for (const segment of paragraph.offsetMap) {
    const overlapStart = Math.max(modelStart, segment.modelStart);
    const overlapEnd = Math.min(modelEnd, segment.modelEnd);
    if (overlapStart >= overlapEnd) continue;
    const mappedStart = segment.sourceStart + (overlapStart - segment.modelStart);
    const mappedEnd = segment.sourceStart + (overlapEnd - segment.modelStart);
    if (sourceStart === null) sourceStart = mappedStart;
    sourceEnd = mappedEnd;
    covered += overlapEnd - overlapStart;
  }
  const modelLength = codePointLength(paragraph.modelText);
  if (sourceStart === null
    || sourceEnd === null
    || modelEnd > modelLength
    || covered !== modelEnd - modelStart) {
    throw sourceStructureError('SOURCE_STRUCTURE_OFFSET_INVALID');
  }
  return Object.freeze({ sourceStart, sourceEnd });
}

module.exports = {
  mapModelRangeToSource,
  parseSourceStructure,
};
