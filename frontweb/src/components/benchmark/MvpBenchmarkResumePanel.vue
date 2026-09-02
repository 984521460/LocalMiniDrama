<template>
  <section class="mvp-resume-panel">
    <header>
      <div>
        <strong>重启后本地恢复</strong>
        <small>按当前工作流运行读取可验证的本地证据前缀</small>
      </div>
      <el-button
        size="small"
        :loading="busy"
        :disabled="!run || busy"
        @click="$emit('resume')"
      >恢复本地执行状态</el-button>
    </header>

    <p class="safety-note">只读取本地数据库中的会话、授权、预检与持久成功进度；不会访问 SSH、Vault、Provider 或 GPU，不会提交任务、结算费用或归还实例。</p>
    <p v-if="error" class="error-message">恢复失败；来源过期、漂移、运行中或证据不完整时不会采用部分状态。</p>
    <p v-else-if="!run" class="empty-message">请先打开一个工作流运行。</p>
    <p v-else-if="snapshot" class="state-message">已恢复到：{{ stateLabel }}</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  run: { type: Object, default: null },
  snapshot: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['resume'])

const labels = Object.freeze({
  empty: '未找到本地基准会话',
  session: '本地会话',
  authorization: '本地会话与有效授权',
  execution: '本地会话、授权、预检与可信执行进度',
})
const stateLabel = computed(() => labels[props.snapshot?.state] || '未知状态')
</script>

<style scoped>
.mvp-resume-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.safety-note, .error-message, .empty-message, .state-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(30, 58, 138, .16); color: #a5b4fc; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.state-message { background: rgba(20, 83, 45, .2); color: #86efac; }
</style>
