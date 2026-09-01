<template>
  <section class="execution-panel">
    <div class="execution-heading">
      <div>
        <h3>本地叙事执行</h3>
        <p>只使用已保存选区和当前批准链；生成结果始终进入人工审核，不会自动批准。</p>
      </div>
      <el-tag type="info" effect="plain">配置的文本模型</el-tag>
    </div>

    <div class="execution-form">
      <el-form-item label="原文选区">
        <el-select v-model="selectionUid" placeholder="选择已保存选区" :disabled="busy">
          <el-option
            v-for="item in selections"
            :key="item.uid"
            :label="selectionLabel(item)"
            :value="item.uid"
          />
        </el-select>
      </el-form-item>

      <template v-if="status?.state === 'ready' && status.resultType === 'adaptation'">
        <el-form-item label="目标时长（秒）">
          <el-input-number v-model="duration.targetSeconds" :min="45" :max="75" />
        </el-form-item>
        <el-form-item label="允许误差（秒）">
          <el-input-number v-model="duration.toleranceSeconds" :min="0" :max="15" />
        </el-form-item>
        <el-form-item label="类型"><el-input v-model="style.genre" maxlength="128" /></el-form-item>
        <el-form-item label="语气"><el-input v-model="style.tone" maxlength="128" /></el-form-item>
        <el-form-item label="受众"><el-input v-model="style.audience" maxlength="128" /></el-form-item>
      </template>
    </div>

    <el-alert
      v-if="status?.state === 'review_required'"
      type="warning"
      :title="`${stageLabel(status.resultType)}结果仍需人工审核`"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="status?.state === 'complete'"
      type="success"
      title="当前选区的事实、改编、剧本和分镜链已全部批准"
      :closable="false"
      show-icon
    />
    <p v-if="error" class="execution-error">执行失败；请检查模型配置、审核链和本地后端状态。</p>

    <div class="execution-actions">
      <span>{{ statusText }}</span>
      <el-button
        type="primary"
        :loading="busy"
        :disabled="status?.state !== 'ready'"
        @click="run"
      >生成{{ stageLabel(status?.resultType) }}</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { useNarrativeExecution } from '@/composables/useNarrativeExecution.js'
import { narrativeExecutionStatus } from '@/narrative/narrativeExecution.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  selections: { type: Array, default: () => [] },
  results: { type: Array, default: () => [] },
})
const emit = defineEmits(['completed'])
const execution = useNarrativeExecution()
const { busy, error } = execution
const selectionUid = ref('')
const duration = reactive({ targetSeconds: 60, toleranceSeconds: 5 })
const style = reactive({ genre: '漫剧', tone: '紧凑', audience: '大众' })
const LABELS = Object.freeze({
  extraction: '事实提取', adaptation: '改编方案', script: '格式化剧本', shot: '镜头规划',
})

const status = computed(() => {
  if (!selectionUid.value || !props.dramaUid) return null
  try {
    return narrativeExecutionStatus({
      dramaUid: props.dramaUid,
      sourceSelectionUid: selectionUid.value,
      results: props.results,
    })
  } catch {
    return null
  }
})

const statusText = computed(() => {
  if (!selectionUid.value) return '请先选择一个已保存选区'
  if (!status.value) return '叙事证据无效，请刷新后重试'
  if (status.value.state === 'ready') return `下一步：${stageLabel(status.value.resultType)}`
  if (status.value.state === 'review_required') return '必须先批准当前结果，才能进入下游'
  return '当前叙事链已完成'
})

function stageLabel(value) {
  return LABELS[value] || '叙事结果'
}

function selectionLabel(item) {
  return `${String(item.uid).slice(0, 8)}… · ${item.startOffset} → ${item.endOffset}`
}

async function run() {
  if (status.value?.state !== 'ready') return
  const response = await execution.execute({
    dramaId: props.dramaId,
    dramaUid: props.dramaUid,
    sourceSelectionUid: selectionUid.value,
    results: props.results,
    durationBudget: { ...duration },
    style: { ...style },
    assetVersions: [],
  })
  if (!response) return
  ElMessage.success(`${stageLabel(status.value?.resultType)}已生成，等待人工审核`)
  emit('completed', response)
}

watch(() => props.selections, (items) => {
  const currentExists = items.some((item) => item.uid === selectionUid.value)
  if (!currentExists) selectionUid.value = items[0]?.uid || ''
}, { immediate: true })

watch(() => props.dramaUid, () => {
  execution.invalidate()
  selectionUid.value = props.selections[0]?.uid || ''
})
</script>

<style scoped>
.execution-panel { margin-top: 16px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 13px; background: var(--el-fill-color-light); }
.execution-heading, .execution-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.execution-heading h3 { margin: 0 0 5px; font-size: 16px; }
.execution-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.execution-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; margin-top: 16px; }
.execution-form :deep(.el-form-item) { margin-bottom: 4px; }
.execution-form :deep(.el-select), .execution-form :deep(.el-input-number) { width: 100%; }
.execution-actions { margin-top: 14px; color: var(--el-text-color-secondary); font-size: 12px; }
.execution-error { margin: 10px 0 0; color: var(--el-color-danger); font-size: 12px; }
@media (max-width: 900px) { .execution-form { grid-template-columns: 1fr; } .execution-heading, .execution-actions { align-items: flex-start; flex-direction: column; } }
</style>
