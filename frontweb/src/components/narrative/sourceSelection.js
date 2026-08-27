function codePointLength(value) {
  return Array.from(value).length
}

function invalidSelection() {
  throw new TypeError('Source selection range is invalid')
}

function validateSelection(blocks, range) {
  if (!Array.isArray(blocks) || !range || typeof range !== 'object') invalidSelection()
  const startIndex = blocks.findIndex((block) => block.uid === range.startBlockUid)
  const endIndex = blocks.findIndex((block) => block.uid === range.endBlockUid)
  if (startIndex < 0
    || endIndex < startIndex
    || !Number.isSafeInteger(range.startOffset)
    || !Number.isSafeInteger(range.endOffset)
    || range.startOffset < 0
    || range.endOffset < 0) invalidSelection()
  const startLength = codePointLength(blocks[startIndex].text)
  const endLength = codePointLength(blocks[endIndex].text)
  const absoluteStart = blocks[startIndex].charStart + range.startOffset
  const absoluteEnd = blocks[endIndex].charStart + range.endOffset
  if (range.startOffset > startLength
    || range.endOffset > endLength
    || !Number.isSafeInteger(absoluteStart)
    || !Number.isSafeInteger(absoluteEnd)
    || absoluteStart >= absoluteEnd) invalidSelection()
  return { startIndex, endIndex }
}

export function createSelectionPayload(blocks, range) {
  validateSelection(blocks, range)
  return Object.freeze({
    startBlockUid: range.startBlockUid,
    endBlockUid: range.endBlockUid,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
  })
}

export function previewSelection(blocks, range) {
  const { startIndex, endIndex } = validateSelection(blocks, range)
  const pieces = []
  for (let index = startIndex; index <= endIndex; index += 1) {
    const points = Array.from(blocks[index].text)
    pieces.push(points.slice(
      index === startIndex ? range.startOffset : 0,
      index === endIndex ? range.endOffset : points.length,
    ).join(''))
  }
  return pieces.join('')
}
