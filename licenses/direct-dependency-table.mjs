function markdownRowCells(line) {
  if (typeof line !== 'string') {
    return null
  }

  let content = line.trim()
  if (!content.includes('|')) {
    return null
  }

  if (content.startsWith('|')) {
    content = content.slice(1)
  }
  if (content.endsWith('|')) {
    content = content.slice(0, -1)
  }

  const cells = content
    .split('|')
    .map((cell) => cell.trim())
  return cells.length > 1 ? cells : null
}

function markdownRowsHaveSameCells(left, right) {
  const leftCells = markdownRowCells(left)
  const rightCells = markdownRowCells(right)
  return leftCells !== null
    && rightCells !== null
    && leftCells.length === rightCells.length
    && leftCells.every((cell, index) => cell === rightCells[index])
}

export function extractContiguousMarkdownTable(lines, header) {
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!markdownRowsHaveSameCells(lines[index], header)) {
      continue
    }
    if (start >= 0) {
      return []
    }
    start = index
  }
  if (start < 0) {
    return []
  }

  let end = start
  while (end < lines.length && markdownRowCells(lines[end]) !== null) {
    end += 1
  }
  return lines.slice(start, end)
}

export function markdownTablesEqual(actual, expected) {
  return actual.length === expected.length
    && actual.every((line, index) => line === expected[index])
}
