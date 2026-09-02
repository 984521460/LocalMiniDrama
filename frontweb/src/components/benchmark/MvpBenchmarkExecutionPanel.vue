<template>
  <section class="mvp-execution-panel">
    <header>
      <div>
        <strong>逐项付费执行</strong>
        <small>每次明确确认并仅执行这一项；不会自动继续下一项</small>
      </div>
      <el-button
        v-if="nextReservation"
        type="danger"
        size="small"
        :loading="busy"
        :disabled="!canExecute"
        @click="$emit('execute')"
      >确认这一项</el-button>
    </header>

    <p class="external-note">执行会重新读取本地 Vault 凭据、进行 SSH live environment 检查，并提交一个真实 H3 或 TTS Provider 作业，可能消耗 GPU/API 资源并产生费用。完成一项不代表费用已经结算，也不代表实例已经归还。</p>
    <p v-if="error" class="error-message">本项未取得可信成功回执；界面不会推进，也不会自动重试。</p>
    <p v-else-if="!batch" class="empty-message">请先完成 live preflight。</p>
    <p v-else-if="step?.batchComplete" class="complete-message">预检批次内 {{ step.totalCount }} 项均已有可信成功结果；仍未结算，实例尚未归还。</p>

    <dl v-if="nextReservation" class="execution-receipt">
      <dt>下一项</dt><dd>{{ completedCount + 1 }} / {{ batch.reservations.length }}</dd>
      <dt>类型</dt><dd>{{ nextReservation.itemKind.toUpperCase() }}</dd>
      <dt>项目 UID</dt><dd>{{ nextReservation.itemUid }}</dd>
      <dt>本项估算</dt><dd>¥{{ (nextReservation.estimatedCostCnyFen / 100).toFixed(2) }}</dd>
      <dt>按预检估算剩余额度</dt><dd>¥{{ (remainingAuthorizationCnyFen / 100).toFixed(2) }}</dd>
    </dl>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  authorization: { type: Object, default: null },
  batch: { type: Object, default: null },
  step: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['execute'])

const completedCount = computed(() => props.step?.completedCount ?? 0)
const nextReservation = computed(() => {
  if (!props.batch || props.step?.batchComplete) return null
  return props.batch.reservations[completedCount.value] ?? null
})
const completedEstimateCnyFen = computed(() => {
  if (!props.batch) return 0
  let total = 0
  for (let index = 0; index < completedCount.value; index += 1) {
    total += props.batch.reservations[index].estimatedCostCnyFen
  }
  return total
})
const remainingAuthorizationCnyFen = computed(() => Math.max(
  0,
  (props.authorization?.maximumCostCnyFen ?? 0) - completedEstimateCnyFen.value,
))
const canExecute = computed(() => Boolean(
  props.authorization && nextReservation.value && !props.busy,
))
</script>

<style scoped>
.mvp-execution-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.external-note, .error-message, .empty-message, .complete-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(120, 53, 15, .2); color: #fcd34d; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.complete-message { background: rgba(20, 83, 45, .2); color: #86efac; }
.execution-receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; margin: 0; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.execution-receipt dt { color: #71717a; font-size: 9px; }
.execution-receipt dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 9px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
