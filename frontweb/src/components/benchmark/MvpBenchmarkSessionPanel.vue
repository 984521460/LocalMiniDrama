<template>
  <section class="mvp-session-panel">
    <header>
      <div>
        <strong>本地基准会话</strong>
        <small>从当前 queued 工作流自动冻结 H3 与 TTS 清单</small>
      </div>
      <el-button
        type="primary"
        size="small"
        :loading="busy"
        :disabled="!canPrepare"
        @click="$emit('prepare')"
      >准备本地会话</el-button>
    </header>

    <p class="safety-note">只写入本地不可变会话；不会创建外部授权，不访问 SSH、Vault、Provider 或 GPU，也不会产生费用。</p>
    <p v-if="error" class="error-message">会话准备失败；来源不完整、已运行或发生漂移时不会写入部分结果。</p>
    <p v-else-if="!run" class="empty-message">请先打开一个工作流运行。</p>
    <p v-else-if="run.status !== 'queued'" class="empty-message">只有 queued 运行可冻结基准会话，当前状态：{{ run.status }}</p>

    <section v-if="currentSession" class="session-receipt" aria-label="本地基准会话回执">
      <div><span>H3 镜头</span><strong>{{ currentSession.h3Tasks.length }}</strong></div>
      <div><span>TTS 意图</span><strong>{{ currentSession.audioIntents.length }}</strong></div>
      <dl>
        <dt>会话</dt><dd>{{ currentSession.uid }}</dd>
        <dt>计划摘要</dt><dd>{{ currentSession.planSha256 }}</dd>
      </dl>
    </section>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  run: { type: Object, default: null },
  session: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['prepare'])

const canPrepare = computed(() => props.run?.status === 'queued' && !props.busy)
const currentSession = computed(() => (
  props.run?.status === 'queued' && props.session?.workflowRunUid === props.run?.uid
    ? props.session
    : null
))
</script>

<style scoped>
.mvp-session-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.safety-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(30, 58, 138, .16); color: #a5b4fc; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.session-receipt { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.session-receipt > div { display: flex; align-items: center; justify-content: space-between; padding: 8px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.session-receipt span { color: #a1a1aa; font-size: 10px; }
.session-receipt dl { grid-column: 1 / -1; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 8px; margin: 0; padding: 8px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.session-receipt dt { color: #71717a; font-size: 9px; }
.session-receipt dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 8px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
