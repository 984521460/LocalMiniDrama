function codePointLength(text) {
  let length = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index);
    index += point > 0xffff ? 2 : 1;
    length += 1;
  }
  return length;
}

function sliceCodePoints(text, start, end) {
  let pointOffset = 0;
  let unitOffset = 0;
  let unitStart = start === 0 ? 0 : null;
  while (unitOffset < text.length && pointOffset < end) {
    if (pointOffset === start) unitStart = unitOffset;
    const point = text.codePointAt(unitOffset);
    unitOffset += point > 0xffff ? 2 : 1;
    pointOffset += 1;
  }
  if (pointOffset === start && unitStart === null) unitStart = unitOffset;
  if (unitStart === null || pointOffset !== end) return null;
  return text.slice(unitStart, unitOffset);
}

module.exports = { codePointLength, sliceCodePoints };
