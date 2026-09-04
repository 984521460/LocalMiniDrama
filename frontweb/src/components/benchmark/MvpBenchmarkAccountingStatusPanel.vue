<template>
  <section class="mvp-accounting-status-panel">
    <header>
      <div>
        <strong>结算与归还状态</strong>
        <small>只读核对不可变本地证据，不执行结算或归还</small>
      </div>
      <el-button
        size="small"
        :loading="busy"
        :disabled="!batch || busy"
        @click="$emit('refresh')"
      >读取状态</el-button>
    </header>

    <p class="safety-note">本动作只读取逐项 settlement 与 release obligation/receipt；不会访问 SSH、Vault、Provider、GPU 或媒体，不会结算费用，也不会归还实例。</p>
    <p v-if="error" class="error-message">状态证据缺失、错配或不完整，未采用部分结果。</p>
    <p v-else-if="!batch" class="empty-message">请先完成 live preflight。</p>

    <template v-if="status">
      <dl class="summary">
        <dt>已结算</dt><dd>{{ status.settledCount }} / {{ status.totalCount }}</dd>
        <dt>累计实际费用</dt><dd>¥{{ (status.actualCostCnyFen / 100).toFixed(2) }}</dd>
        <dt>归还状态</dt><dd>{{ releaseLabel }}</dd>
        <dt>义务摘要</dt><dd>{{ status.obligationSha256 }}</dd>
        <dt v-if="status.receiptSha256">回执摘要</dt><dd v-if="status.receiptSha256">{{ status.receiptSha256 }}</dd>
      </dl>
      <ol class="items">
        <li v-for="item in status.items" :key="item.reservationUid">
          <span>{{ item.ordinal + 1 }}. {{ item.itemKind.toUpperCase() }}</span>
          <span :class="item.settlementState">{{ itemLabel(item) }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  batch: { type: Object, default: null },
  status: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['refresh'])

const releaseLabel = computed(() => (
  props.status?.releaseState === 'released' ? '已有可信归还回执' : '仍需归还'
))

function itemLabel(item) {
  return item.settlementState === 'settled'
    ? `已结算 ¥${(item.actualCostCnyFen / 100).toFixed(2)}`
    : '待结算'
}
</script>

<style scoped>
.mvp-accounting-status-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.safety-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(30, 58, 138, .16); color: #a5b4fc; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; margin: 0; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.summary dt { color: #71717a; font-size: 9px; }
.summary dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 9px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.items { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.items li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 7px; background: #18181d; color: #a1a1aa; font-size: 9px; }
.items .settled { color: #86efac; }
.items .pending { color: #fcd34d; }
</style>
