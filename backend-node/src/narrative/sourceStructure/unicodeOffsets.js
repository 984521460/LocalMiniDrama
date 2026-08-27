function codePointLength(text) {
  let length = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
    length += 1;
  }
  return length;
}

function countCodePointsBetween(text, start, end) {
  let length = 0;
  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
    length += 1;
  }
  return length;
}

function scanSourceLines(text, maxLines) {
  const lines = [];
  let unitStart = 0;
  let pointStart = 0;
  let unitOffset = 0;
  let pointOffset = 0;

  while (unitOffset < text.length) {
    const codePoint = text.codePointAt(unitOffset);
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x0a) {
      if (lines.length >= maxLines) return null;
      lines.push(Object.freeze({
        text: text.slice(unitStart, unitOffset),
        unitStart,
        unitEnd: unitOffset,
        sourceStart: pointStart,
        sourceEnd: pointOffset,
      }));
      unitOffset += 1;
      pointOffset += 1;
      unitStart = unitOffset;
      pointStart = pointOffset;
      continue;
    }
    unitOffset += width;
    pointOffset += 1;
  }

  if (lines.length >= maxLines) return null;
  lines.push(Object.freeze({
    text: text.slice(unitStart),
    unitStart,
    unitEnd: text.length,
    sourceStart: pointStart,
    sourceEnd: pointOffset,
  }));
  return Object.freeze(lines);
}

module.exports = {
  codePointLength,
  countCodePointsBetween,
  scanSourceLines,
};
