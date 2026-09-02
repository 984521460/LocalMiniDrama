const {
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
  is: OBJECT_IS,
} = Object
const { isArray: IS_ARRAY } = Array
const { ownKeys: OWN_KEYS } = Reflect

const SCHEMA_VERSION = 'mvp-benchmark-readiness.v1'
const CHECKLIST_VERSION = 'mvp-section-19.v1'
const ERROR_MESSAGE = 'MVP benchmark readiness data is invalid'

export const MVP_CAPABILITY_SPECS = FREEZE([
  FREEZE({ id: 'database-contracts', kind: 'local', blockerCode: 'MVP_DATABASE_CONTRACTS_UNAVAILABLE' }),
  FREEZE({ id: 'narrative-execution', kind: 'local', blockerCode: 'MVP_NARRATIVE_EXECUTOR_UNAVAILABLE' }),
  FREEZE({ id: 'character-candidate-execution', kind: 'local', blockerCode: 'MVP_CHARACTER_CANDIDATE_EXECUTOR_UNAVAILABLE' }),
  FREEZE({ id: 'workflow-execution', kind: 'local', blockerCode: 'MVP_WORKFLOW_EXECUTOR_UNAVAILABLE' }),
  FREEZE({ id: 'remote-execution', kind: 'local', blockerCode: 'MVP_REMOTE_EXECUTION_UNAVAILABLE' }),
  FREEZE({ id: 'ready-gpu-connection', kind: 'external', blockerCode: 'MVP_READY_GPU_CONNECTION_REQUIRED' }),
  FREEZE({ id: 'h3-local-execution', kind: 'external', blockerCode: 'MVP_H3_LOCAL_EXECUTION_UNAVAILABLE' }),
  FREEZE({ id: 'tts-execution', kind: 'external', blockerCode: 'MVP_TTS_EXECUTION_UNAVAILABLE' }),
  FREEZE({ id: 'media-export', kind: 'local', blockerCode: 'MVP_MEDIA_EXPORT_UNAVAILABLE' }),
  FREEZE({ id: 'project-archive-v21', kind: 'local', blockerCode: 'MVP_PROJECT_ARCHIVE_V21_UNAVAILABLE' }),
  FREEZE({ id: 'windows-release-evidence', kind: 'release', blockerCode: 'MVP_WINDOWS_RELEASE_EVIDENCE_PENDING' }),
  FREEZE({ id: 'human-av-review', kind: 'human', blockerCode: 'MVP_HUMAN_AV_REVIEW_PENDING' }),
])

export const MVP_CHECKLIST_SPECS = FREEZE([
  ['windows-package-start', 'function', 'system-test'],
  ['source-import-encoding', 'function', 'project-evidence'],
  ['source-selection', 'function', 'project-evidence'],
  ['source-evidence-trace', 'function', 'project-evidence'],
  ['facts-decision-separation', 'function', 'project-evidence'],
  ['narrative-sixty-seconds', 'function', 'project-evidence'],
  ['script-shot-schema', 'function', 'project-evidence'],
  ['character-four-candidates', 'function', 'project-evidence'],
  ['character-lock-reference-pack', 'function', 'project-evidence'],
  ['scene-prop-version-bindings', 'function', 'project-evidence'],
  ['workflow-canvas-roundtrip-execution', 'function', 'localhost-and-project-evidence'],
  ['remote-ssh-sftp-tunnel', 'function', 'external-receipt'],
  ['comfy-health-dependencies', 'function', 'external-receipt'],
  ['storyboard-image-generation', 'function', 'project-media-evidence'],
  ['h3-local-video-generation', 'function', 'project-media-evidence'],
  ['character-voice-tts', 'function', 'project-media-evidence'],
  ['subtitle-final-audio', 'function', 'project-media-evidence'],
  ['bgm-replace-ducking', 'function', 'project-media-evidence'],
  ['shot-reordering', 'function', 'project-evidence'],
  ['final-1080p-export', 'function', 'project-media-evidence'],
  ['uuid-entities', 'reliability', 'database-evidence'],
  ['asset-logical-uri-version', 'reliability', 'database-evidence'],
  ['immutable-generation-results', 'reliability', 'database-evidence'],
  ['archive-v21-roundtrip', 'reliability', 'roundtrip-receipt'],
  ['secret-free-persistence', 'reliability', 'scan-receipt'],
  ['remote-prompt-stage', 'reliability', 'database-evidence'],
  ['startup-recovery', 'reliability', 'restart-receipt'],
  ['failure-not-complete', 'reliability', 'fault-receipt'],
  ['engineering-gates', 'quality', 'test-receipt'],
  ['same-project-full-run', 'quality', 'benchmark-receipt'],
  ['final-video-decode', 'quality', 'media-receipt'],
  ['human-subtitle-sync-bgm', 'quality', 'human-review'],
  ['licenses-and-sources', 'quality', 'license-receipt'],
  ['accepted-residual-risks', 'quality', 'approval'],
].map(([id, section, evidenceKind]) => FREEZE({ id, section, evidenceKind })))

const CAPABILITY_LABELS = FREEZE({
  'database-contracts': '数据库合同',
  'narrative-execution': '叙事任务执行',
  'character-candidate-execution': '角色候选执行',
  'workflow-execution': '工作流执行',
  'remote-execution': '远程执行闭环',
  'ready-gpu-connection': '可用 GPU 连接',
  'h3-local-execution': 'H3 本地执行',
  'tts-execution': '角色声线与 TTS',
  'media-export': '成片导出',
  'project-archive-v21': '项目归档 2.1',
  'windows-release-evidence': 'Windows 发行证据',
  'human-av-review': '人工音画验收',
})

const CHECKLIST_LABELS = FREEZE({
  'windows-package-start': 'Windows 安装包启动',
  'source-import-encoding': '原文导入与编码',
  'source-selection': '原文选区',
  'source-evidence-trace': '原文证据追溯',
  'facts-decision-separation': '事实与创作决策分离',
  'narrative-sixty-seconds': '一分钟叙事闭环',
  'script-shot-schema': '剧本与镜头结构',
  'character-four-candidates': '角色四候选',
  'character-lock-reference-pack': '角色锁定与参考包',
  'scene-prop-version-bindings': '场景道具版本绑定',
  'workflow-canvas-roundtrip-execution': '画布往返与执行',
  'remote-ssh-sftp-tunnel': 'SSH / SFTP / 隧道',
  'comfy-health-dependencies': 'Comfy 健康与依赖',
  'storyboard-image-generation': '分镜图生成',
  'h3-local-video-generation': 'H3 视频生成',
  'character-voice-tts': '角色声线与 TTS',
  'subtitle-final-audio': '字幕与最终音频',
  'bgm-replace-ducking': 'BGM 替换与闪避',
  'shot-reordering': '镜头重排',
  'final-1080p-export': '1080p 成片导出',
  'uuid-entities': 'UUID 实体约束',
  'asset-logical-uri-version': '资产逻辑 URI 与版本',
  'immutable-generation-results': '不可变生成结果',
  'archive-v21-roundtrip': '归档 2.1 往返',
  'secret-free-persistence': '持久层无秘密',
  'remote-prompt-stage': '远程提示词阶段',
  'startup-recovery': '启动恢复',
  'failure-not-complete': '失败不冒充完成',
  'engineering-gates': '工程质量门禁',
  'same-project-full-run': '同项目完整运行',
  'final-video-decode': '最终视频完整解码',
  'human-subtitle-sync-bgm': '人工字幕/同步/BGM 验收',
  'licenses-and-sources': '许可证与来源',
  'accepted-residual-risks': '剩余风险签收',
})

const SECTION_META = FREEZE({
  function: FREEZE({ label: '功能闭环', tone: 'warning' }),
  reliability: FREEZE({ label: '可靠性与可恢复性', tone: 'info' }),
  quality: FREEZE({ label: '质量与验收', tone: 'danger' }),
})

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function append(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const actualKeys = OWN_KEYS(descriptors)
  if (actualKeys.length !== expectedKeys.length) invalid()
  const result = Object.create(null)
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string' || !HAS_OWN(result, actualKeys[index])) invalid()
  }
  return result
}

function denseArray(value, expectedLength) {
  if (!IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = GET_PROTOTYPE_OF(value)
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value)
  } catch {
    invalid()
  }
  if (prototype !== Array.prototype
    || descriptors.length?.value !== expectedLength
    || OWN_KEYS(descriptors).length !== expectedLength + 1) invalid()
  const result = []
  for (let index = 0; index < expectedLength; index += 1) {
    const key = String(index)
    if (!HAS_OWN(descriptors, key)) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !HAS_OWN(descriptor, 'value')) invalid()
    append(result, descriptor.value)
  }
  return result
}

function exactStringArray(value, expected) {
  const items = denseArray(value, expected.length)
  const result = []
  for (let index = 0; index < expected.length; index += 1) {
    if (items[index] !== expected[index]) invalid()
    append(result, items[index])
  }
  return FREEZE(result)
}

function capabilityList(value) {
  const source = denseArray(value, MVP_CAPABILITY_SPECS.length)
  const result = []
  const blocked = []
  for (let index = 0; index < MVP_CAPABILITY_SPECS.length; index += 1) {
    const spec = MVP_CAPABILITY_SPECS[index]
    const item = exactObject(source[index], ['id', 'kind', 'status', 'blockerCode'])
    if (item.id !== spec.id || item.kind !== spec.kind) invalid()
    const pending = index >= 10
    if (pending) {
      if (item.status !== 'pending' || item.blockerCode !== spec.blockerCode) invalid()
    } else if (item.status === 'ready') {
      if (item.blockerCode !== null) invalid()
    } else if (item.status === 'blocked') {
      if (item.blockerCode !== spec.blockerCode) invalid()
      append(blocked, spec.id)
    } else {
      invalid()
    }
    append(result, FREEZE({
      id: spec.id,
      kind: spec.kind,
      status: item.status,
      blockerCode: item.blockerCode,
    }))
  }
  return FREEZE({ items: FREEZE(result), blocked: FREEZE(blocked) })
}

function checklist(value) {
  const source = denseArray(value, MVP_CHECKLIST_SPECS.length)
  const result = []
  for (let index = 0; index < MVP_CHECKLIST_SPECS.length; index += 1) {
    const spec = MVP_CHECKLIST_SPECS[index]
    const item = exactObject(source[index], ['id', 'section', 'evidenceKind', 'status'])
    if (item.id !== spec.id || item.section !== spec.section
      || item.evidenceKind !== spec.evidenceKind || item.status !== 'pending') invalid()
    append(result, FREEZE({ ...spec, status: 'pending' }))
  }
  return FREEZE(result)
}

export function mvpBenchmarkReadinessView(value) {
  const root = exactObject(value, [
    'schemaVersion', 'checklistVersion', 'readyForBenchmark', 'mvpComplete',
    'capabilities', 'blockedCapabilityIds', 'pendingCapabilityIds', 'checklist',
  ])
  if (root.schemaVersion !== SCHEMA_VERSION || root.checklistVersion !== CHECKLIST_VERSION
    || root.mvpComplete !== false) invalid()
  const capabilities = capabilityList(root.capabilities)
  if (root.readyForBenchmark !== (capabilities.blocked.length === 0)) invalid()
  const blockedCapabilityIds = exactStringArray(root.blockedCapabilityIds, capabilities.blocked)
  const pendingCapabilityIds = exactStringArray(root.pendingCapabilityIds, [
    'windows-release-evidence', 'human-av-review',
  ])
  return FREEZE({
    schemaVersion: SCHEMA_VERSION,
    checklistVersion: CHECKLIST_VERSION,
    readyForBenchmark: root.readyForBenchmark,
    mvpComplete: false,
    capabilities: capabilities.items,
    blockedCapabilityIds,
    pendingCapabilityIds,
    checklist: checklist(root.checklist),
  })
}

export function mvpCapabilityLabel(id) {
  if (typeof id !== 'string' || !HAS_OWN(CAPABILITY_LABELS, id)) invalid()
  return CAPABILITY_LABELS[id]
}

export function mvpChecklistLabel(id) {
  if (typeof id !== 'string' || !HAS_OWN(CHECKLIST_LABELS, id)) invalid()
  return CHECKLIST_LABELS[id]
}

export function mvpChecklistSectionMeta(section) {
  if (typeof section !== 'string' || !HAS_OWN(SECTION_META, section)) invalid()
  return SECTION_META[section]
}

export function mvpCapabilityStatusMeta(status) {
  if (status === 'ready') return FREEZE({ label: '已具备', tone: 'success' })
  if (status === 'blocked') return FREEZE({ label: '受阻', tone: 'danger' })
  if (status === 'pending') return FREEZE({ label: '待取证', tone: 'warning' })
  return invalid()
}
