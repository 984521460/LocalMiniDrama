<template>
  <div class="workflow-toolbar">
    <div class="toolbar-title">
      <strong>{{ workflowName || '尚未选择工作流' }}</strong>
      <span v-if="dirty" class="dirty">有未保存更改</span>
      <span v-else-if="workflowName" class="saved">已同步</span>
    </div>
    <div class="toolbar-actions">
      <el-button size="small" :loading="saving" :disabled="!dirty" @click="$emit('save')">保存图</el-button>
      <el-divider direction="vertical" />
      <span class="selection-count">已选 {{ selectedCount }} 节点</span>
      <el-button size="small" type="primary" :loading="running" :disabled="!workflowName" @click="$emit('execute', 'full')">整图执行</el-button>
      <el-button size="small" :loading="running" :disabled="selectedCount !== 1" @click="$emit('execute', 'node')">单节点</el-button>
      <el-button size="small" :loading="running" :disabled="selectedCount !== 1" @click="$emit('execute', 'downstream')">向下执行</el-button>
      <el-button size="small" :loading="running" :disabled="selectedCount < 1" @click="$emit('execute', 'selection')">选区执行</el-button>
      <el-input-number
        :model-value="maxRetries"
        size="small"
        :min="0"
        :max="3"
        controls-position="right"
        aria-label="自动重试次数"
        @update:model-value="$emit('update:maxRetries', $event)"
      />
      <el-button size="small" type="danger" plain :loading="running" :disabled="!canCancel" @click="$emit('cancel')">取消运行</el-button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  workflowName: { type: String, default: '' },
  dirty: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  running: { type: Boolean, default: false },
  selectedCount: { type: Number, default: 0 },
  canCancel: { type: Boolean, default: false },
  maxRetries: { type: Number, default: 0 },
})

defineEmits(['save', 'execute', 'cancel', 'update:maxRetries'])
</script>

<style scoped>
.workflow-toolbar { min-height: 48px; display: flex; align-items: center; gap: 14px; padding: 7px 14px; border-bottom: 1px solid #2f2f37; background: rgba(24,24,27,.96); }
.toolbar-title { min-width: 160px; display: flex; flex-direction: column; gap: 2px; }
.toolbar-title strong { max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: #fafafa; font-size: 13px; white-space: nowrap; }
.toolbar-title span { font-size: 9px; }
.dirty { color: #fbbf24; }
.saved { color: #4ade80; }
.toolbar-actions { margin-left: auto; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
.selection-count { color: #71717a; font-size: 10px; }
.toolbar-actions :deep(.el-input-number) { width: 84px; }
@media (max-width: 1150px) { .workflow-toolbar { align-items: flex-start; flex-direction: column; } .toolbar-actions { margin-left: 0; justify-content: flex-start; } }
</style>
