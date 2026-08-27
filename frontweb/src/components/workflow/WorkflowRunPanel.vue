<template>
  <section class="run-panel">
    <header>
      <div><strong>运行记录</strong><small>调度、重试和取消均由本地后端执行</small></div>
      <el-button link size="small" :loading="running" @click="$emit('refresh')">刷新</el-button>
    </header>
    <div v-if="runs.length" class="run-list">
      <button
        v-for="run in runs"
        :key="run.uid"
        type="button"
        class="run-item"
        :class="{ active: run.uid === activeRun?.run?.uid }"
        @click="$emit('open', run.uid)"
      >
        <span>{{ formatTime(run.createdAt) }}</span>
        <el-tag size="small" :type="runStatusMeta(run.status).tone">{{ runStatusMeta(run.status).label }}</el-tag>
      </button>
    </div>
    <el-empty v-else description="还没有运行记录" :image-size="54" />

    <template v-if="activeRun">
      <div class="run-summary">
        <div><span>运行状态</span><strong>{{ runStatusMeta(activeRun.run.status).label }}</strong></div>
        <div><span>图版本</span><strong>r{{ activeRun.run.graphRevision }}</strong></div>
        <div><span>触发方式</span><strong>{{ activeRun.run.triggerType }}</strong></div>
        <div><span>重试</span><strong>{{ activeRun.run.retryCount }}</strong></div>
      </div>
      <p v-if="activeRun.run.errorCode" class="run-error">{{ activeRun.run.errorCode }}</p>
      <div class="node-runs">
        <article v-for="node in activeRun.nodes" :key="node.uid">
          <div>
            <strong>#{{ node.ordinal + 1 }} · {{ shortUid(node.nodeUid) }}</strong>
            <span v-if="node.errorCode">{{ node.errorCode }}</span>
            <span v-else>重试 {{ node.retryCount }}</span>
          </div>
          <div class="node-run-actions">
            <el-tag size="small" :type="runStatusMeta(node.status).tone">{{ runStatusMeta(node.status).label }}</el-tag>
            <el-button v-if="node.status === 'failed'" link size="small" type="primary" :loading="running" @click="$emit('retry', node.uid)">重试</el-button>
          </div>
        </article>
      </div>
      <el-button v-if="canCancel" class="cancel-button" size="small" type="danger" plain :loading="running" @click="$emit('cancel')">取消当前运行</el-button>
    </template>
  </section>
</template>

<script setup>
import { runStatusMeta } from './workflowRuns'

defineProps({
  runs: { type: Array, default: () => [] },
  activeRun: { type: Object, default: null },
  running: { type: Boolean, default: false },
  canCancel: { type: Boolean, default: false },
})

defineEmits(['refresh', 'open', 'retry', 'cancel'])

function formatTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '未知时间' : date.toLocaleString('zh-CN', { hour12: false })
}

function shortUid(value) {
  return typeof value === 'string' ? `${value.slice(0, 8)}…` : '未知节点'
}
</script>

<style scoped>
.run-panel { padding: 13px; }
.run-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.run-panel > header div { display: flex; flex-direction: column; gap: 2px; }
.run-panel > header strong { color: #fafafa; font-size: 13px; }
.run-panel > header small { color: #52525b; font-size: 9px; }
.run-list { max-height: 132px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
.run-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #2f2f37; border-radius: 7px; background: #1c1c21; color: #a1a1aa; cursor: pointer; font-size: 9px; }
.run-item.active { border-color: #6366f1; background: rgba(99,102,241,.1); }
.run-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 13px; padding: 10px; border-radius: 9px; background: #1c1c21; }
.run-summary div { display: flex; flex-direction: column; gap: 2px; }
.run-summary span { color: #52525b; font-size: 9px; }
.run-summary strong { color: #d4d4d8; font-size: 11px; }
.run-error { padding: 8px; border-radius: 7px; background: rgba(239,68,68,.1); color: #fca5a5; font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
.node-runs { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; max-height: 260px; overflow-y: auto; }
.node-runs article { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid #27272f; }
.node-runs article > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.node-runs strong { color: #d4d4d8; font-size: 10px; }
.node-runs span { color: #71717a; font-size: 9px; }
.node-run-actions { display: flex; align-items: center; gap: 5px; }
.cancel-button { width: 100%; margin-top: 12px; }
</style>
