<template>
  <section class="mvp-preflight-panel">
    <header>
      <div>
        <strong>Live 环境预检</strong>
        <small>显式检查授权连接，并冻结一次执行批次的本地证据</small>
      </div>
      <el-button size="small" :loading="busy" :disabled="!canPreflight" @click="$emit('preflight')">
        运行 live preflight
      </el-button>
    </header>

    <p class="external-note">本动作会读取本地 Vault 中该连接的凭据并发起 SSH 环境检查，也会写入本地预检/预约/归还义务证据；不会提交 H3/TTS Provider 作业，不会创建或租用 GPU 实例，也不会产生模型生成费用。</p>
    <p v-if="error" class="error-message">预检失败；不会显示成功批次，也不会自动执行任何生成任务。</p>
    <p v-else-if="!authorization" class="empty-message">请先创建本地外部授权记录。</p>

    <dl v-if="batch" class="preflight-receipt">
      <dt>批次</dt><dd>{{ batch.batchSha256 }}</dd>
      <dt>环境回执</dt><dd>{{ batch.attestationUid }}</dd>
      <dt>预约项目</dt><dd>{{ batch.reservations.length }}</dd>
      <dt>估算费用</dt><dd>¥{{ (batch.estimatedCostCnyFen / 100).toFixed(2) }}</dd>
      <dt>准备时间</dt><dd>{{ new Date(batch.preparedAtEpochMs).toLocaleString() }}</dd>
    </dl>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  authorization: { type: Object, default: null },
  batch: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['preflight'])

const canPreflight = computed(() => Boolean(props.authorization) && !props.batch && !props.busy)
</script>

<style scoped>
.mvp-preflight-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.external-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(120, 53, 15, .2); color: #fcd34d; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.preflight-receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; margin: 0; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.preflight-receipt dt { color: #71717a; font-size: 9px; }
.preflight-receipt dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 9px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
