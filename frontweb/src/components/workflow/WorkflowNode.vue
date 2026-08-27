<template>
  <article class="workflow-node" :class="[`run-${data.runStatus || 'idle'}`, { selected }]">
    <Handle
      v-for="(port, index) in data.definition.inputs"
      :id="`in:${port.id}`"
      :key="`in:${port.id}`"
      type="target"
      :position="Position.Left"
      :style="portStyle(index, data.definition.inputs.length)"
      :title="`${port.id} · ${port.valueType}`"
    />
    <header>
      <span class="node-kicker">{{ data.nodeType }}</span>
      <span class="node-status" :class="`tone-${status.tone}`">{{ status.label }}</span>
    </header>
    <strong>{{ data.title }}</strong>
    <div class="node-meta">
      <span>{{ data.definition.inputs.length }} 入 / {{ data.definition.outputs.length }} 出</span>
      <span v-if="data.domainRef" class="bound">已绑定</span>
      <span v-else-if="data.status === 'disabled'">未启用</span>
    </div>
    <p v-if="data.errorCode" class="node-error">{{ data.errorCode }}</p>
    <Handle
      v-for="(port, index) in data.definition.outputs"
      :id="`out:${port.id}`"
      :key="`out:${port.id}`"
      type="source"
      :position="Position.Right"
      :style="portStyle(index, data.definition.outputs.length)"
      :title="`${port.id} · ${port.valueType}`"
    />
  </article>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'

import { runStatusMeta } from './workflowRuns'

const props = defineProps({
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const status = computed(() => props.data.runStatus
  ? runStatusMeta(props.data.runStatus)
  : props.data.status === 'disabled'
    ? { label: '已停用', tone: 'info' }
    : { label: '待运行', tone: 'info' })

function portStyle(index, count) {
  return { top: `${((index + 1) / (count + 1)) * 100}%` }
}
</script>

<style scoped>
.workflow-node { width: 220px; min-height: 96px; padding: 13px 15px; border: 1px solid #3f3f46; border-radius: 13px; background: linear-gradient(145deg, #202027, #151519); color: #f4f4f5; box-shadow: 0 8px 24px rgba(0,0,0,.24); }
.workflow-node.selected { border-color: #818cf8; box-shadow: 0 0 0 2px rgba(129,140,248,.25), 0 10px 30px rgba(0,0,0,.34); }
.workflow-node.run-running { border-color: #f59e0b; }
.workflow-node.run-succeeded { border-color: #22c55e; }
.workflow-node.run-failed, .workflow-node.run-blocked { border-color: #ef4444; }
.workflow-node header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.node-kicker { max-width: 135px; overflow: hidden; text-overflow: ellipsis; color: #71717a; font-size: 10px; letter-spacing: .03em; white-space: nowrap; }
.node-status { padding: 2px 6px; border-radius: 99px; background: rgba(113,113,122,.16); color: #a1a1aa; font-size: 10px; }
.tone-success { background: rgba(34,197,94,.16); color: #86efac; }
.tone-warning { background: rgba(245,158,11,.17); color: #fcd34d; }
.tone-danger { background: rgba(239,68,68,.17); color: #fca5a5; }
.workflow-node strong { display: block; margin-bottom: 9px; font-size: 14px; }
.node-meta { display: flex; justify-content: space-between; gap: 8px; color: #71717a; font-size: 10px; }
.node-meta .bound { color: #67e8f9; }
.node-error { margin: 9px 0 0; color: #fca5a5; font: 10px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; }
:deep(.vue-flow__handle) { width: 9px; height: 9px; border: 2px solid #18181b; background: #818cf8; }
:deep(.vue-flow__handle-left) { left: -5px; }
:deep(.vue-flow__handle-right) { right: -5px; background: #22d3ee; }
</style>
