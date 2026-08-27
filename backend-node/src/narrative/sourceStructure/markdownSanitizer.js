const { countCodePointsBetween } = require('./unicodeOffsets');
const { sourceStructureError } = require('./errors');

const MAX_MARKDOWN_SKIP_RANGES = 100000;
const MAX_MARKDOWN_MAPPING_OBJECTS = 100000;

function createMarkdownBudget() {
  let remainingRanges = MAX_MARKDOWN_SKIP_RANGES;
  let remainingMappings = MAX_MARKDOWN_MAPPING_OBJECTS;

  function consume(kind) {
    if (kind === 'range') {
      if (remainingRanges <= 0) throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
      remainingRanges -= 1;
      return;
    }
    if (remainingMappings <= 0) throw sourceStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED');
    remainingMappings -= 1;
  }

  return Object.freeze({
    consumeMapping() {
      consume('mapping');
    },
    consumeRange() {
      consume('range');
    },
  });
}

function addSkipRange(ranges, start, end, budget) {
  if (end <= start) return;
  budget.consumeRange();
  ranges.push({ start, end });
}

function parseBlockPrefix(text, lineStart, lineEnd, allowMarkerOnlyList = false) {
  let cursor = lineStart;
  const tokens = [];
  let changed = true;
  while (changed && cursor < lineEnd) {
    changed = false;
    let probe = cursor;
    let spaces = 0;
    while (probe < lineEnd && spaces < 3 && text.charCodeAt(probe) === 0x20) {
      probe += 1;
      spaces += 1;
    }
    if (text.charCodeAt(probe) === 0x3e) {
      probe += 1;
      if (text.charCodeAt(probe) === 0x20 || text.charCodeAt(probe) === 0x09) probe += 1;
      tokens.push('quote');
      cursor = probe;
      changed = true;
      continue;
    }
    const remainder = text.slice(probe, lineEnd);
    const list = (allowMarkerOnlyList
      ? /^([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/u
      : /^([-+*]|\d{1,9}[.)])[ \t]+/u).exec(remainder);
    if (list) {
      const marker = list[1];
      tokens.push(/^\d/u.test(marker) ? `ordered:${marker.at(-1)}` : `unordered:${marker}`);
      cursor = probe + list[0].length;
      changed = true;
    }
  }
  return Object.freeze({ end: cursor, tokens: Object.freeze(tokens) });
}

function sameBlockContainer(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function blockPrefixEnd(text, lineStart, lineEnd) {
  return parseBlockPrefix(text, lineStart, lineEnd).end;
}

function scanInlineLink(text, index, lineEnd) {
  const image = text[index] === '!' && text[index + 1] === '[';
  if (!image && text[index] !== '[') return null;
  const open = image ? index + 1 : index;
  let cursor = open + 1;
  for (; cursor < lineEnd; cursor += 1) {
    if (text[cursor] === '\\' && cursor + 1 < lineEnd) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '[') return Object.freeze({ kind: 'malformed' });
    if (text[cursor] === ']') break;
  }
  if (cursor >= lineEnd || text[cursor + 1] !== '(') return null;

  const labelEnd = cursor;
  cursor += 2;
  let depth = 1;
  for (; cursor < lineEnd; cursor += 1) {
    if (text[cursor] === '\\' && cursor + 1 < lineEnd) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '(') depth += 1;
    if (text[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        return Object.freeze({
          kind: 'link',
          open,
          labelEnd,
          end: cursor + 1,
        });
      }
    }
  }
  return Object.freeze({ kind: 'unterminated' });
}

function collectLineSkipRanges(text, lineStart, lineEnd, ranges, budget) {
  const prefixEnd = blockPrefixEnd(text, lineStart, lineEnd);
  addSkipRange(ranges, lineStart, prefixEnd, budget);

  let index = prefixEnd;
  let linkSearchExhausted = false;
  let tagSearchExhausted = false;
  const scheduledClosings = new Map();
  while (index < lineEnd) {
    const character = text[index];
    const scheduledLength = scheduledClosings.get(index);
    if (scheduledLength) {
      index += scheduledLength;
      continue;
    }
    if (character === '\\' && index + 1 < lineEnd && /[\\`*_[\]{}()#+.!~>-]/u.test(text[index + 1])) {
      addSkipRange(ranges, index, index + 1, budget);
      index += 2;
      continue;
    }

    if (!linkSearchExhausted && (character === '[' || (character === '!' && text[index + 1] === '['))) {
      const candidate = scanInlineLink(text, index, lineEnd);
      if (candidate?.kind === 'link') {
        addSkipRange(ranges, index, candidate.open + 1, budget);
        addSkipRange(ranges, candidate.labelEnd, candidate.end, budget);
        scheduledClosings.set(candidate.labelEnd, candidate.end - candidate.labelEnd);
        index = candidate.open + 1;
        continue;
      }
      if (candidate?.kind === 'unterminated') linkSearchExhausted = true;
    }

    if (!tagSearchExhausted && character === '<' && /[A-Za-z!/]/u.test(text[index + 1] || '')) {
      const close = text.indexOf('>', index + 1);
      if (close >= 0 && close < lineEnd) {
        const candidate = text.slice(index, close + 1);
        if (/^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?>$/u.test(candidate)
          || /^<!--(?:[^-]|-(?!->))*-->$/u.test(candidate)) {
          addSkipRange(ranges, index, close + 1, budget);
          index = close + 1;
          continue;
        }
        const nestedOpen = candidate.lastIndexOf('<');
        if (nestedOpen > 0) {
          index += nestedOpen;
          continue;
        }
      }
      if (close < 0 || close >= lineEnd) tagSearchExhausted = true;
    }

    if (character === '*' || character === '_' || character === '`') {
      let end = index + 1;
      while (end < lineEnd && text[end] === character) end += 1;
      const marker = text.slice(index, end);
      const close = text.indexOf(marker, end);
      if (close >= end && close < lineEnd) {
        addSkipRange(ranges, index, end, budget);
        addSkipRange(ranges, close, close + marker.length, budget);
        scheduledClosings.set(close, marker.length);
      }
      index = end;
      continue;
    }
    if (character === '~' && text[index + 1] === '~') {
      let end = index + 2;
      while (end < lineEnd && text[end] === '~') end += 1;
      const marker = text.slice(index, end);
      const close = text.indexOf(marker, end);
      if (close >= end && close < lineEnd) {
        addSkipRange(ranges, index, end, budget);
        addSkipRange(ranges, close, close + marker.length, budget);
        scheduledClosings.set(close, marker.length);
      }
      index = end;
      continue;
    }

    const codePoint = text.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function mergeSkipRanges(ranges) {
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function mappingFromSkipRanges(rawText, sourceStart, ranges, budget) {
  const merged = mergeSkipRanges(ranges);
  const sourceRuns = [];
  let unitCursor = 0;
  let sourceCursor = sourceStart;

  function advance(to) {
    const points = countCodePointsBetween(rawText, unitCursor, to);
    sourceCursor += points;
    unitCursor = to;
    return points;
  }

  function append(to) {
    if (to <= unitCursor) return;
    const unitStart = unitCursor;
    const sourceRunStart = sourceCursor;
    const points = advance(to);
    if (points > 0) {
      budget.consumeMapping();
      sourceRuns.push(Object.freeze({
        unitStart,
        unitEnd: to,
        sourceStart: sourceRunStart,
        sourceEnd: sourceCursor,
      }));
    }
  }

  for (const range of merged) {
    append(range.start);
    advance(range.end);
  }
  append(rawText.length);

  return Object.freeze({
    sourceRuns: Object.freeze(sourceRuns),
  });
}

function sanitizeMarkdown(rawText, sourceStart, budget = createMarkdownBudget()) {
  const ranges = [];
  let lineStart = 0;
  for (let index = 0; index <= rawText.length; index += 1) {
    if (index === rawText.length || rawText.charCodeAt(index) === 0x0a) {
      collectLineSkipRanges(rawText, lineStart, index, ranges, budget);
      lineStart = index + 1;
    }
  }
  return mappingFromSkipRanges(rawText, sourceStart, ranges, budget);
}

function fencedCodeMapping(rawText, sourceStart, containerTokens, budget = createMarkdownBudget()) {
  const ranges = [];
  let lineStart = 0;
  for (let index = 0; index <= rawText.length; index += 1) {
    if (index === rawText.length || rawText.charCodeAt(index) === 0x0a) {
      const prefix = parseBlockPrefix(rawText, lineStart, index, true);
      if (sameBlockContainer(prefix.tokens, containerTokens)) {
        addSkipRange(ranges, lineStart, prefix.end, budget);
      }
      lineStart = index + 1;
    }
  }
  return mappingFromSkipRanges(rawText, sourceStart, ranges, budget);
}

function identityMapping(rawText, sourceStart, budget = createMarkdownBudget()) {
  const length = countCodePointsBetween(rawText, 0, rawText.length);
  if (length > 0) budget.consumeMapping();
  return Object.freeze({
    sourceRuns: Object.freeze(length === 0 ? [] : [Object.freeze({
      unitStart: 0,
      unitEnd: rawText.length,
      sourceStart,
      sourceEnd: sourceStart + length,
    })]),
  });
}

module.exports = {
  blockPrefixEnd,
  createMarkdownBudget,
  fencedCodeMapping,
  identityMapping,
  parseBlockPrefix,
  sameBlockContainer,
  sanitizeMarkdown,
};
