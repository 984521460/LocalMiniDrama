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

    <el-dialog v-model="evidenceVisible" title="审核证据" width="min(860px, 92vw)">
      <template v-if="activeDetail">
        <div class="evidence-summary">
          <el-tag :type="statusMeta(activeDetail.result.status).tone">
            {{ statusMeta(activeDetail.result.status).label }}
          </el-tag>
          <span>结果 {{ shortHash(activeDetail.result.resultHash) }}</span>
          <span>完整封装 {{ shortHash(activeDetail.result.envelopeHash) }}</span>
        </div>
        <pre class="evidence-json">{{ prettyOutput }}</pre>
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
const comments = reactive({ extraction: '', adaptation: '', script: '', shot: '' })
const loadGuard = createLatestRequestGuard()
const evidenceGuard = createLatestRequestGuard()
const groups = computed(() => groupNarrativeResults(results.value))
const prettyOutput = computed(() => JSON.stringify(activeDetail.value?.result?.result?.output || {}, null, 2))

const statusMeta = reviewStatusMeta
const shortHash = (value) => value ? `${value.slice(0, 12)}…` : '—'

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

function resetForDrama() {
  loadGuard.invalidate()
  evidenceGuard.invalidate()
  results.value = []
  loadError.value = false
  loading.value = false
  submittingUid.value = ''
  activeDetail.value = null
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
.evidence-json { max-height: 48vh; overflow: auto; padding: 14px; border-radius: 10px; background: var(--el-fill-color-light); white-space: pre-wrap; word-break: break-word; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
.review-history h4 { margin: 18px 0 8px; }
.history-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 12px; }
.history-row time { color: var(--el-text-color-secondary); }
@media (max-width: 900px) { .review-grid { grid-template-columns: 1fr; } .history-row { grid-template-columns: 48px 1fr; } .history-row time { grid-column: 2; } }
</style>
