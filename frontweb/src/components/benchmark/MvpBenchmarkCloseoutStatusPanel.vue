<template>
  <section class="mvp-closeout-status-panel">
    <header>
      <div>
        <strong>MVP 收尾证据</strong>
        <small>只读汇总本次基准闭环，不执行任务、结算或归还</small>
      </div>
      <el-button
        size="small"
        :loading="busy"
        :disabled="!batch || busy"
        @click="$emit('refresh')"
      >读取汇总</el-button>
    </header>

    <p class="safety-note">本动作只读取本地不可变证据；不会访问 SSH、Vault、Provider、GPU 或媒体，不会提交任务、结算费用或归还实例。</p>
    <p v-if="error" class="error-message">收尾证据缺失、错配或不完整，未采用部分结果。</p>
    <p v-else-if="!batch" class="empty-message">请先完成 live preflight。</p>

    <template v-if="status">
      <p :class="status.benchmarkEvidenceComplete ? 'complete-message' : 'pending-message'">
        {{ headline }}
      </p>
      <ul class="gates">
        <li v-for="gate in status.gates" :key="gate.id">
          <span>{{ gateLabel(gate.id) }}</span>
          <span :class="gate.status">{{ statusLabel(gate.status) }}</span>
        </li>
      </ul>
      <div class="remaining">
        <strong>项目级 MVP 仍缺</strong>
        <span v-for="item in globalRemaining" :key="item">{{ evidenceLabel(item) }}</span>
      </div>
      <p class="mvp-warning">即使本次五项基准证据齐全，也不等于项目 MVP 已完成。</p>
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

const GLOBAL_IDS = new Set([
  'windows-release-lifecycle', 'section-19-project-evidence',
  'licenses-and-sources', 'accepted-residual-risks',
])

const headline = computed(() => (
  props.status?.benchmarkEvidenceComplete
    ? '本次基准收尾证据已闭环；项目 MVP 仍未完成'
    : `本次基准已完成 ${props.status?.completedGateCount ?? 0} / 5 项收尾证据`
))

const globalRemaining = computed(() => (
  props.status?.remainingMvpEvidenceIds.filter((id) => GLOBAL_IDS.has(id)) ?? []
))

const GATE_LABELS = Object.freeze({
  'production-execution': '生成执行',
  'final-export': '最终成片',
  'human-av-review': '人工音画验收',
  'accounting-settlement': '费用结算',
  'resource-release': '资源归还',
})

const EVIDENCE_LABELS = Object.freeze({
  'windows-release-lifecycle': 'Windows 安装/升级/卸载证据',
  'section-19-project-evidence': '第 19 节项目级验收证据',
  'licenses-and-sources': '许可证与素材来源闭包',
  'accepted-residual-risks': '剩余风险明确接受记录',
})

function gateLabel(id) { return GATE_LABELS[id] }
function evidenceLabel(id) { return EVIDENCE_LABELS[id] }
function statusLabel(status) {
  if (status === 'complete') return '完整'
  if (status === 'failed') return '失败'
  return '待补'
}
</script>

<style scoped>
.mvp-closeout-status-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.safety-note, .error-message, .empty-message, .complete-message, .pending-message, .mvp-warning { margin: 0; padding: 8px 9px; border-radius: 8px; font-size: 10px; line-height: 1.55; }
.safety-note { background: rgba(30, 58, 138, .16); color: #a5b4fc; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.complete-message { background: rgba(20, 83, 45, .2); color: #86efac; }
.pending-message, .mvp-warning { background: rgba(120, 53, 15, .16); color: #fcd34d; }
.gates { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.gates li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 7px; background: #18181d; color: #a1a1aa; font-size: 9px; }
.gates .complete { color: #86efac; }
.gates .pending { color: #fcd34d; }
.gates .failed { color: #fca5a5; }
.remaining { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.remaining strong { font-size: 10px; }
.remaining span { color: #a1a1aa; font-size: 9px; }
</style>
