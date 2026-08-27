const DEFINITIONS = Object.freeze([
  Object.freeze({ type: 'extraction', title: '事实提取', description: '核对人物、场景、道具、事件、对白及原文证据。' }),
  Object.freeze({ type: 'adaptation', title: '改编方案', description: '核对事实、推断、改编标记与一分钟节奏。' }),
  Object.freeze({ type: 'script', title: '剧本格式', description: '核对场次、动作、对白、角色及改编依据。' }),
  Object.freeze({ type: 'shot', title: '镜头规划', description: '核对镜头顺序、时长、资产引用与连续性。' }),
])

const STATUS = Object.freeze({
  pending_review: Object.freeze({ label: '待审核', tone: 'warning' }),
  approved: Object.freeze({ label: '已批准', tone: 'success' }),
  rejected: Object.freeze({ label: '已驳回', tone: 'danger' }),
  stale: Object.freeze({ label: '已失效', tone: 'info' }),
})

export function reviewStatusMeta(status) {
  const meta = STATUS[status]
  if (!meta) throw new TypeError('Narrative review status is invalid')
  return { ...meta }
}

export function createLatestRequestGuard() {
  let epoch = 0
  return Object.freeze({
    begin() {
      epoch += 1
      return epoch
    },
    invalidate() {
      epoch += 1
    },
    isCurrent(token) {
      return Number.isSafeInteger(token) && token === epoch
    },
  })
}

export function groupNarrativeResults(results) {
  if (!Array.isArray(results)) throw new TypeError('Narrative results must be an array')
  const supportedTypes = new Set(DEFINITIONS.map((definition) => definition.type))
  const byUid = new Map()
  let anchor = null
  for (const result of results) {
    if (!supportedTypes.has(result?.resultType) || typeof result.uid !== 'string') continue
    byUid.set(result.uid, result)
    const key = `${result.createdAt || ''}\0${result.uid}`
    const anchorKey = anchor ? `${anchor.createdAt || ''}\0${anchor.uid}` : ''
    if (!anchor || key > anchorKey) anchor = result
  }

  const chain = new Map()
  const visited = new Set()
  let current = anchor
  while (current && !visited.has(current.uid)) {
    chain.set(current.resultType, current)
    visited.add(current.uid)
    current = typeof current.upstreamResultUid === 'string'
      ? byUid.get(current.upstreamResultUid) || null
      : null
  }

  return Object.freeze(DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    result: chain.get(definition.type) || null,
  })))
}
