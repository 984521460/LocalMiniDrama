<template>
  <section class="review-workspace">
    <div class="review-heading">
      <div>
        <h2>叙事审核</h2>
        <p>结果按事实 → 改编 → 剧本 → 分镜逐级批准；未批准或已失效的结果不会进入下游生成。</p>
      </div>
      <el-button text :loading="loading" @click="load">刷新审核</el-button>
    </div>

    <el-alert
      v-if="loadError"
      class="review-alert"
      type="error"
      title="审核数据加载失败"
      description="请确认本地后端已启动，然后重新刷新审核。"
      show-icon
      :closable="false"
    />

    <NarrativeExecutionPanel
      :drama-id="dramaId"
      :drama-uid="dramaUid"
      :selections="selections"
      :results="results"
      @completed="load"
    />

    <CharacterCandidateExecutionPanel
      :drama-id="dramaId"
      :drama-uid="dramaUid"
      :characters="characters"
      :results="results"
    />

    <div class="review-grid" v-loading="loading">
      <article v-for="group in groups" :key="group.type" class="review-card">
        <div class="card-title">
          <div>
            <h3>{{ group.title }}</h3>
            <p>{{ group.description }}</p>
          </div>
          <el-tag v-if="group.result" :type="statusMeta(group.result.status).tone" effect="plain">
            {{ statusMeta(group.result.status).label }}
          </el-tag>
          <el-tag v-else type="info" effect="plain">暂无结果</el-tag>
        </div>

        <template v-if="group.result">
          <dl class="result-meta">
            <div><dt>输入哈希</dt><dd>{{ shortHash(group.result.inputHash) }}</dd></div>
            <div><dt>结果哈希</dt><dd>{{ shortHash(group.result.resultHash) }}</dd></div>
            <div><dt>Schema</dt><dd>{{ group.result.schemaVersion }}</dd></div>
          </dl>
          <el-input
            v-model="comments[group.type]"
            type="textarea"
            :rows="2"
            maxlength="1000"
            show-word-limit
            placeholder="记录审核意见（可选）"
            :disabled="group.result.status === 'stale'"
          />
          <div class="review-actions">
            <el-button @click="viewEvidence(group.result.uid)">查看证据</el-button>
            <el-button
              type="danger"
              plain
              :disabled="group.result.status === 'stale'"
              :loading="submittingUid === group.result.uid"
              @click="submit(group, 'reject')"
            >驳回</el-button>
            <el-button
              type="success"
              :disabled="group.result.status === 'stale'"
              :loading="submittingUid === group.result.uid"
              @click="submit(group, 'approve')"
            >批准</el-button>
          </div>
        </template>
        <el-empty v-else description="等待上游任务生成结果" :image-size="54" />
      </article>
    </div>

    <section v-if="history.length" class="version-history" aria-labelledby="narrative-history-title">
      <div class="version-history-heading">
        <div>
          <h3 id="narrative-history-title">历史测试作品</h3>
          <p>错误、驳回或被新版替代的结果只读保留；可重开原证据和完整结构，不会参与当前生成链。</p>
        </div>
        <el-tag type="info" effect="plain">{{ history.length }} 个旧版本</el-tag>
      </div>
      <div class="version-history-grid">
        <article
          v-for="entry in history"
          :key="entry.result.uid"
          class="version-history-card"
        >
          <header>
            <div>
              <el-tag size="small" effect="plain">{{ entry.title }}</el-tag>
              <el-tag
                size="small"
                :type="statusMeta(entry.result.status).tone"
                effect="plain"
              >{{ statusMeta(entry.result.status).label }}</el-tag>
            </div>
            <time>{{ entry.result.createdAt }}</time>
          </header>
          <dl class="version-history-meta">
            <div><dt>结果 UID</dt><dd><code>{{ entry.result.uid }}</code></dd></div>
            <div><dt>结果哈希</dt><dd>{{ shortHash(entry.result.resultHash) }}</dd></div>
            <div><dt>完整封装</dt><dd>{{ shortHash(entry.result.envelopeHash) }}</dd></div>
            <div><dt>来源选区</dt><dd>{{ shortHash(entry.result.sourceSelectionUid) }}</dd></div>
          </dl>
          <div class="version-history-actions">
            <span v-if="entry.result.status === 'stale'">只读保留 · {{ entry.result.updatedAt }}</span>
            <span v-else>历史只读版本</span>
            <el-button text type="primary" @click="viewEvidence(entry.result.uid)">
              查看旧版证据与完整结果
            </el-button>
          </div>
        </article>
      </div>
    </section>

    <el-dialog
      v-model="evidenceVisible"
      class="evidence-dialog"
      title="审核证据"
      width="min(860px, 92vw)"
      top="5vh"
    >
      <template v-if="activeDetail">
        <div class="evidence-summary">
          <el-tag :type="statusMeta(activeDetail.result.status).tone">
            {{ statusMeta(activeDetail.result.status).label }}
          </el-tag>
          <span>结果 {{ shortHash(activeDetail.result.resultHash) }}</span>
          <span>完整封装 {{ shortHash(activeDetail.result.envelopeHash) }}</span>
        </div>
        <section v-if="extractionFacts.length" class="fact-trace-section">
          <div class="fact-trace-heading">
            <div>
              <h4>事实与原文</h4>
              <p>点击某条事实，核对它的原文块、位置和摘录。</p>
            </div>
          </div>
          <div class="fact-list">
            <button
              v-for="fact in extractionFacts"
              :key="fact.factId"
              type="button"
              class="fact-row"
              :class="{ active: activeTrace?.factId === fact.factId }"
              :disabled="traceLoadingFactId === fact.factId"
              @click="loadFactTrace(fact.factId)"
            >
              <span>{{ fact.typeLabel }}</span>
              <strong>{{ fact.label }}</strong>
              <small>{{ traceLoadingFactId === fact.factId ? '正在定位…' : '定位原文' }}</small>
            </button>
          </div>
        </section>
        <section v-if="activeDetail.result.resultType === 'adaptation'" class="adaptation-comparison-section">
          <div class="adaptation-comparison-heading">
            <div>
              <h4>原著事实与改编决策</h4>
              <p>原著事实可定位原文；推断保留依据；改编内容单独标记并说明理由。</p>
            </div>
            <el-button
              type="primary"
              plain
              :loading="comparisonLoading"
              @click="loadAdaptationComparison"
            >{{ activeComparison ? '重新核对' : '查看对照' }}</el-button>
          </div>
          <el-alert
            v-if="comparisonError"
            type="error"
            title="事实与改编对照加载失败"
            :closable="false"
            show-icon
          />
          <template v-if="activeComparison">
            <div class="comparison-columns">
              <section class="comparison-column source-column">
                <h5>原著事实</h5>
                <button
                  v-for="fact in activeComparison.sourceFacts"
                  :key="fact.factId"
                  type="button"
                  class="comparison-item fact-source-item"
                  @click="loadFactTrace(fact.factId, activeComparison.sourceResultUid)"
                >
                  <span class="classification-badge source">原著</span>
                  <strong>{{ fact.factLabel }}</strong>
                  <small>{{ fact.factSummary }}</small>
                  <em>定位原文</em>
                </button>
              </section>
              <section class="comparison-column decision-column">
                <h5>改编决策</h5>
                <article
                  v-for="decision in activeComparison.adaptationDecisions"
                  :key="decision.decisionId"
                  class="comparison-item"
                >
                  <span class="classification-badge adaptation">改编</span>
                  <strong>{{ decision.summary }}</strong>
                  <small>{{ adaptationCategoryLabel(decision.category) }} · {{ decision.rationale }}</small>
                  <p>依据事实：{{ decision.factRefs.join('、') || '无直接事实引用' }}</p>
                </article>
              </section>
            </div>
            <section class="beat-comparison">
              <h5>剧情节拍分类 · {{ activeComparison.durationSummary.totalSeconds }} 秒</h5>
              <article
                v-for="beat in activeComparison.beats"
                :key="beat.beatId"
                class="beat-comparison-item"
              >
                <span class="classification-badge" :class="beat.classification">
                  {{ classificationLabel(beat.classification) }}
                </span>
                <div>
                  <strong>{{ beatKindLabel(beat.kind) }} · {{ beat.summary }}</strong>
                  <small v-if="beat.inferenceRationale">推断依据：{{ beat.inferenceRationale }}</small>
                  <small v-else-if="beat.adaptationDecisionRefs.length">改编决策：{{ beat.adaptationDecisionRefs.join('、') }}</small>
                  <small v-else>原著事实：{{ beat.factRefs.join('、') }}</small>
                </div>
                <em>{{ beat.estimatedDurationSeconds }} 秒</em>
              </article>
            </section>
          </template>
        </section>
        <el-alert
          v-if="traceError"
          type="error"
          title="原文证据加载失败"
          :closable="false"
          show-icon
        />
        <section v-if="activeTrace" class="fact-trace-section active-source-trace">
          <article class="fact-trace-card">
            <header>
              <div>
                <el-tag effect="plain">{{ factTypeLabel(activeTrace.factType) }}</el-tag>
                <h4>{{ activeTrace.factLabel }}</h4>
              </div>
              <span>{{ activeTrace.evidenceCount }} 处证据</span>
            </header>
            <p class="fact-summary">{{ activeTrace.factSummary }}</p>
            <dl class="trace-meta">
              <div><dt>事实哈希</dt><dd>{{ shortHash(activeTrace.factSha256) }}</dd></div>
              <div><dt>原文哈希</dt><dd>{{ shortHash(activeTrace.sourceDocumentSha256) }}</dd></div>
              <div><dt>选区哈希</dt><dd>{{ shortHash(activeTrace.selectedTextSha256) }}</dd></div>
            </dl>
            <div
              v-for="item in activeTrace.evidence"
              :key="`${item.blockUid}:${item.startOffset}:${item.endOffset}`"
              class="source-evidence"
            >
              <div class="source-evidence-meta">
                <span>原文块 #{{ item.blockOrdinal + 1 }}</span>
                <span v-if="item.headingPath.length">{{ item.headingPath.join(' / ') }}</span>
                <span>码点 {{ item.startOffset }}–{{ item.endOffset }}</span>
              </div>
              <blockquote><span>{{ item.beforeText }}</span><mark>{{ item.quote }}</mark><span>{{ item.afterText }}</span></blockquote>
            </div>
          </article>
        </section>
        <details class="evidence-raw">
          <summary>查看完整结构化结果</summary>
          <pre class="evidence-json">{{ prettyOutput }}</pre>
        </details>
        <div v-if="activeDetail.reviews.length" class="review-history">
          <h4>审核记录</h4>
          <div v-for="review in activeDetail.reviews" :key="review.uid" class="history-row">
            <strong>{{ review.decision === 'approve' ? '批准' : '驳回' }}</strong>
            <span>{{ review.comment || '无附加意见' }}</span>
            <time>{{ review.createdAt }}</time>
          </div>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { narrativeReviewAPI } from '@/api/v2/narrativeReviews'
import CharacterCandidateExecutionPanel from '@/components/assets/CharacterCandidateExecutionPanel.vue'
import NarrativeExecutionPanel from './NarrativeExecutionPanel.vue'
import {
  createLatestRequestGuard,
  groupNarrativeHistory,
  groupNarrativeResults,
  reviewStatusMeta,
} from './narrativeReview.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  characters: { type: Array, default: () => [] },
  selections: { type: Array, default: () => [] },
})

const results = ref([])
const loading = ref(false)
const loadError = ref(false)
const submittingUid = ref('')
const evidenceVisible = ref(false)
const activeDetail = ref(null)
const activeTrace = ref(null)
const traceLoadingFactId = ref('')
const traceError = ref(false)
const activeComparison = ref(null)
const comparisonLoading = ref(false)
const comparisonError = ref(false)
const comments = reactive({ extraction: '', adaptation: '', script: '', shot: '' })
const loadGuard = createLatestRequestGuard()
const evidenceGuard = createLatestRequestGuard()
const traceGuard = createLatestRequestGuard()
const comparisonGuard = createLatestRequestGuard()
const groups = computed(() => groupNarrativeResults(results.value))
const history = computed(() => groupNarrativeHistory(results.value))
const prettyOutput = computed(() => JSON.stringify(activeDetail.value?.result?.result?.output || {}, null, 2))
const FACT_GROUPS = Object.freeze([
  Object.freeze({ key: 'characters', type: 'character' }),
  Object.freeze({ key: 'scenes', type: 'scene' }),
  Object.freeze({ key: 'props', type: 'prop' }),
  Object.freeze({ key: 'relationships', type: 'relationship' }),
  Object.freeze({ key: 'events', type: 'event' }),
  Object.freeze({ key: 'dialogue', type: 'dialogue' }),
])
const FACT_TYPE_LABELS = Object.freeze({
  character: '人物', scene: '场景', prop: '道具', relationship: '关系', event: '事件', dialogue: '对白',
})
const CLASSIFICATION_LABELS = Object.freeze({ fact: '原著事实', inference: '推断', adaptation: '改编' })
const BEAT_KIND_LABELS = Object.freeze({ hook: '开场钩子', setup: '铺垫', escalation: '升级', climax: '高潮', cliffhanger: '悬念' })
const ADAPTATION_CATEGORY_LABELS = Object.freeze({
  'invented-event': '新增事件',
  'compressed-timeline': '压缩时间线',
  'merged-character': '合并角色',
  'changed-setting': '改变场景',
  'added-dialogue': '新增对白',
  other: '其他改编',
})
const extractionFacts = computed(() => {
  if (activeDetail.value?.result?.resultType !== 'extraction') return []
  const output = activeDetail.value?.result?.result?.output
  if (!output || typeof output !== 'object') return []
  const facts = []
  for (let groupIndex = 0; groupIndex < FACT_GROUPS.length; groupIndex += 1) {
    const group = FACT_GROUPS[groupIndex]
    const entries = Array.isArray(output[group.key]) ? output[group.key] : []
    for (let index = 0; index < entries.length; index += 1) {
      const fact = entries[index]
      if (!fact || typeof fact.factId !== 'string') continue
      facts.push(Object.freeze({
        factId: fact.factId,
        typeLabel: FACT_TYPE_LABELS[group.type],
        label: fact.name || fact.location || fact.summary || fact.content
          || `${fact.fromCharacterFactId || ''} → ${fact.toCharacterFactId || ''}`,
      }))
    }
  }
  return facts
})

const statusMeta = reviewStatusMeta
const shortHash = (value) => value ? `${value.slice(0, 12)}…` : '—'
const factTypeLabel = (value) => FACT_TYPE_LABELS[value] || '事实'
const classificationLabel = (value) => CLASSIFICATION_LABELS[value] || '未知'
const beatKindLabel = (value) => BEAT_KIND_LABELS[value] || value
const adaptationCategoryLabel = (value) => ADAPTATION_CATEGORY_LABELS[value] || '其他改编'

async function load() {
  const requestToken = loadGuard.begin()
  const requestedDramaId = props.dramaId
  loading.value = true
  try {
    const loadedResults = await narrativeReviewAPI.listForDrama(requestedDramaId)
    if (!loadGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    results.value = loadedResults
    loadError.value = false
    return true
  } catch {
    if (!loadGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    results.value = []
    loadError.value = true
    return false
  } finally {
    if (loadGuard.isCurrent(requestToken)) loading.value = false
  }
}

async function viewEvidence(resultUid) {
  const requestToken = evidenceGuard.begin()
  const requestedDramaId = props.dramaId
  traceGuard.invalidate()
  activeTrace.value = null
  traceLoadingFactId.value = ''
  traceError.value = false
  comparisonGuard.invalidate()
  activeComparison.value = null
  comparisonLoading.value = false
  comparisonError.value = false
  try {
    const detail = await narrativeReviewAPI.get(resultUid)
    if (!evidenceGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    activeDetail.value = detail
    evidenceVisible.value = true
    return true
  } catch {
    if (!evidenceGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    ElMessage.error('审核证据加载失败')
    return false
  }
}

async function loadFactTrace(factId, sourceResultUid = null) {
  const resultUid = sourceResultUid || activeDetail.value?.result?.uid
  if (!resultUid) return false
  const requestToken = traceGuard.begin()
  const requestedDramaId = props.dramaId
  traceLoadingFactId.value = factId
  traceError.value = false
  try {
    const trace = await narrativeReviewAPI.getFactEvidence(resultUid, factId)
    if (!traceGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    activeTrace.value = trace
    return true
  } catch {
    if (!traceGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    activeTrace.value = null
    traceError.value = true
    return false
  } finally {
    if (traceGuard.isCurrent(requestToken)) traceLoadingFactId.value = ''
  }
}

async function loadAdaptationComparison() {
  const resultUid = activeDetail.value?.result?.uid
  if (!resultUid || activeDetail.value?.result?.resultType !== 'adaptation') return false
  const requestToken = comparisonGuard.begin()
  const requestedDramaId = props.dramaId
  comparisonLoading.value = true
  comparisonError.value = false
  try {
    const comparison = await narrativeReviewAPI.getAdaptationComparison(resultUid)
    if (!comparisonGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    activeComparison.value = comparison
    return true
  } catch {
    if (!comparisonGuard.isCurrent(requestToken) || requestedDramaId !== props.dramaId) return false
    activeComparison.value = null
    comparisonError.value = true
    return false
  } finally {
    if (comparisonGuard.isCurrent(requestToken)) comparisonLoading.value = false
  }
}

function resetForDrama() {
  loadGuard.invalidate()
  evidenceGuard.invalidate()
  traceGuard.invalidate()
  comparisonGuard.invalidate()
  results.value = []
  loadError.value = false
  loading.value = false
  submittingUid.value = ''
  activeDetail.value = null
  activeTrace.value = null
  traceLoadingFactId.value = ''
  traceError.value = false
  activeComparison.value = null
  comparisonLoading.value = false
  comparisonError.value = false
  evidenceVisible.value = false
  for (const key of Object.keys(comments)) comments[key] = ''
}

async function submit(group, decision) {
  const result = group.result
  if (!result || result.status === 'stale') return
  submittingUid.value = result.uid
  try {
    await narrativeReviewAPI.review(result.uid, decision, comments[group.type].trim())
    comments[group.type] = ''
    ElMessage.success(decision === 'approve' ? '结果已批准' : '结果已驳回')
    await load()
    return true
  } catch {
    ElMessage.error(decision === 'approve' ? '批准失败' : '驳回失败')
    return false
  } finally {
    submittingUid.value = ''
  }
}

onMounted(load)
watch(() => props.dramaId, () => {
  resetForDrama()
  load()
})
</script>

<style scoped>
.review-workspace { padding: 20px; border: 1px solid var(--el-border-color); border-radius: 16px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.review-heading, .card-title, .review-actions, .evidence-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.review-heading h2, .card-title h3 { margin: 0 0 5px; }
.review-heading p, .card-title p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.review-alert { margin-top: 16px; }
.review-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.review-card { min-width: 0; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 13px; background: var(--el-fill-color-blank); }
.card-title { align-items: flex-start; min-height: 52px; }
.card-title h3 { font-size: 16px; }
.result-meta { display: grid; gap: 6px; margin: 14px 0; }
.result-meta div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.result-meta dt { color: var(--el-text-color-secondary); }
.result-meta dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.review-actions { justify-content: flex-end; margin-top: 12px; }
.evidence-summary { justify-content: flex-start; flex-wrap: wrap; margin-bottom: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.evidence-raw { margin-top: 16px; }
.evidence-raw summary { color: var(--el-color-primary); font-size: 12px; cursor: pointer; }
.evidence-json { max-height: 36vh; overflow: auto; padding: 14px; border-radius: 10px; background: var(--el-fill-color-light); white-space: pre-wrap; word-break: break-word; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
.fact-trace-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.adaptation-comparison-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.adaptation-comparison-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.adaptation-comparison-heading h4, .comparison-column h5, .beat-comparison h5 { margin: 0; }
.adaptation-comparison-heading p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.comparison-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.comparison-column { min-width: 0; padding: 12px; border-radius: 10px; }
.source-column { background: var(--el-color-success-light-9); }
.decision-column { background: var(--el-color-warning-light-9); }
.comparison-item { position: relative; display: grid; gap: 5px; margin-top: 9px; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 9px; background: var(--el-bg-color); color: var(--el-text-color-primary); text-align: left; }
button.comparison-item { width: 100%; cursor: pointer; }
.comparison-item strong { padding-right: 44px; font-size: 13px; }
.comparison-item small, .comparison-item p { margin: 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.55; }
.comparison-item em { color: var(--el-color-primary); font-size: 11px; font-style: normal; }
.classification-badge { width: fit-content; padding: 2px 6px; border-radius: 999px; font-size: 10px; font-weight: 700; }
.classification-badge.source, .classification-badge.fact { background: var(--el-color-success-light-8); color: var(--el-color-success-dark-2); }
.classification-badge.inference { background: var(--el-color-info-light-8); color: var(--el-color-info-dark-2); }
.classification-badge.adaptation { background: var(--el-color-warning-light-8); color: var(--el-color-warning-dark-2); }
.beat-comparison { margin-top: 14px; }
.beat-comparison-item { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.beat-comparison-item div { display: grid; gap: 4px; }
.beat-comparison-item strong { font-size: 12px; }
.beat-comparison-item small, .beat-comparison-item em { color: var(--el-text-color-secondary); font-size: 11px; font-style: normal; }
.active-source-trace { margin-top: 12px; }
.fact-trace-heading h4, .fact-trace-card h4 { margin: 0; }
.fact-trace-heading p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.fact-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.fact-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 10px 11px; border: 1px solid var(--el-border-color-lighter); border-radius: 9px; background: var(--el-fill-color-blank); color: var(--el-text-color-primary); text-align: left; cursor: pointer; }
.fact-row:hover, .fact-row.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.fact-row:disabled { cursor: wait; opacity: .7; }
.fact-row > span, .fact-row > small { color: var(--el-text-color-secondary); font-size: 11px; }
.fact-row > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.fact-trace-card { margin-top: 12px; padding: 14px; border: 1px solid var(--el-color-primary-light-7); border-radius: 11px; background: var(--el-fill-color-extra-light); }
.fact-trace-card header { display: flex; justify-content: space-between; gap: 12px; }
.fact-trace-card header > div { display: flex; align-items: center; gap: 9px; }
.fact-trace-card header > span { color: var(--el-text-color-secondary); font-size: 12px; }
.fact-summary { margin: 10px 0; font-size: 13px; line-height: 1.6; }
.trace-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
.trace-meta div { min-width: 0; }
.trace-meta dt { color: var(--el-text-color-secondary); font-size: 11px; }
.trace-meta dd { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.source-evidence { margin-top: 9px; padding: 11px; border-radius: 9px; background: var(--el-bg-color); }
.source-evidence-meta { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 7px; color: var(--el-text-color-secondary); font-size: 11px; }
.source-evidence blockquote { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.8; }
.source-evidence mark { padding: 2px 1px; border-radius: 3px; background: var(--el-color-warning-light-7); color: inherit; }
.review-history h4 { margin: 18px 0 8px; }
.history-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 12px; }
.history-row time { color: var(--el-text-color-secondary); }
.version-history { margin-top: 20px; padding: 18px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-fill-color-extra-light); }
.version-history-heading, .version-history-card header, .version-history-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.version-history-heading h3 { margin: 0; }
.version-history-heading p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.version-history-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.version-history-card { min-width: 0; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: var(--el-bg-color); }
.version-history-card header > div { display: flex; gap: 6px; }
.version-history-card time, .version-history-actions > span { color: var(--el-text-color-secondary); font-size: 11px; }
.version-history-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 12px; margin: 13px 0; }
.version-history-meta div { min-width: 0; }
.version-history-meta dt { color: var(--el-text-color-secondary); font-size: 11px; }
.version-history-meta dd { margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.version-history-actions { padding-top: 10px; border-top: 1px solid var(--el-border-color-lighter); }
@media (max-width: 900px) { .review-grid, .fact-list, .trace-meta, .comparison-columns, .version-history-grid, .version-history-meta { grid-template-columns: 1fr; } .version-history-heading, .version-history-card header, .version-history-actions { align-items: flex-start; flex-direction: column; } .history-row { grid-template-columns: 48px 1fr; } .history-row time { grid-column: 2; } .beat-comparison-item { grid-template-columns: 72px minmax(0, 1fr); } .beat-comparison-item > em { grid-column: 2; } }
</style>

<style>
.evidence-dialog .el-dialog__body { max-height: calc(90vh - 74px); overflow-y: auto; }
</style>
