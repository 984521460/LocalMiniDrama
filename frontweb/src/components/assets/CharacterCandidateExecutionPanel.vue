<template>
  <section class="candidate-panel">
    <div class="candidate-heading">
      <div>
        <h3>角色四候选</h3>
        <p>绑定当前已批准的事实提取结果；一次执行会独立生成四张单人肖像。</p>
      </div>
      <el-tag type="warning" effect="plain">配置的图片模型</el-tag>
    </div>

    <div class="candidate-form">
      <el-form-item label="角色事实">
        <el-select v-model="selectedIdentity" placeholder="选择已批准角色事实" :disabled="busy">
          <el-option
            v-for="item in options"
            :key="item.identity"
            :label="`${item.characterName} · ${item.characterFactId}`"
            :value="item.identity"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="宽度"><el-input-number v-model="width" :min="256" :max="2048" :step="64" /></el-form-item>
      <el-form-item label="高度"><el-input-number v-model="height" :min="256" :max="2048" :step="64" /></el-form-item>
      <el-form-item label="种子"><el-input-number v-model="seed" :min="0" :max="4294967295" /></el-form-item>
    </div>

    <el-alert
      v-if="options.length === 0"
      type="info"
      title="先批准事实提取结果，并确保角色名称与事实名称一致"
      :closable="false"
      show-icon
    />
    <p v-if="error" class="candidate-error">执行失败；请检查当前审批、图片模型配置和本地后端状态。</p>

    <div v-if="candidates.length" class="candidate-grid">
      <figure v-for="item in candidates" :key="item.assetVersionUid">
        <img
          :src="`/static/${item.relativePath}`"
          :alt="`${selected.characterName}候选 ${item.ordinal + 1}`"
        />
        <figcaption>候选 {{ item.ordinal + 1 }} · {{ item.provider }} / {{ item.model }}</figcaption>
      </figure>
    </div>

    <div class="candidate-actions">
      <span>提交前会再次确认四次外部生图调用及可能费用。</span>
      <el-button type="primary" :loading="busy" :disabled="!selected" @click="run">
        生成四候选
      </el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { useCharacterCandidateExecution } from '@/composables/useCharacterCandidateExecution.js'
import {
  approvedCharacterCandidateOptions,
} from '@/characterCandidates/characterCandidateExecution.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  characters: { type: Array, default: () => [] },
  results: { type: Array, default: () => [] },
})
const execution = useCharacterCandidateExecution()
const { busy, error } = execution
const selectedIdentity = ref('')
const width = ref(512)
const height = ref(512)
const seed = ref(42)
const completedByIdentity = ref([])
const options = computed(() => {
  try {
    return approvedCharacterCandidateOptions({
      dramaUid: props.dramaUid,
      characters: props.characters,
      results: props.results,
    })
  } catch {
    return []
  }
})
const selected = computed(() => {
  const items = options.value
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].identity === selectedIdentity.value) return items[index]
  }
  return null
})
const candidates = computed(() => {
  const identity = selected.value?.identity
  if (!identity) return []
  const values = completedByIdentity.value
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].identity === identity) return values[index].response.execution.items
  }
  return []
})

function remember(identity, response) {
  const current = completedByIdentity.value
  const next = []
  let replaced = false
  for (let index = 0; index < current.length; index += 1) {
    if (current[index].identity === identity) {
      next[next.length] = Object.freeze({ identity, response })
      replaced = true
    } else {
      next[next.length] = current[index]
    }
  }
  if (!replaced) next[next.length] = Object.freeze({ identity, response })
  completedByIdentity.value = Object.freeze(next)
}

async function run() {
  if (!selected.value) return
  const selection = selected.value
  if (width.value * height.value > 4_194_304) {
    ElMessage.error('候选图片总像素不能超过 4194304')
    return
  }
  try {
    await ElMessageBox.confirm(
      '本次将向当前配置的图片服务独立提交 4 次生成请求，可能产生服务费用。确认继续？',
      '确认四候选生成',
      { type: 'warning', confirmButtonText: '确认生成', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const response = await execution.execute({
    dramaId: props.dramaId,
    dramaUid: props.dramaUid,
    characterUid: selection.characterUid,
    extractionResultUid: selection.extractionResultUid,
    characterFactId: selection.characterFactId,
    width: width.value,
    height: height.value,
    seed: seed.value,
  })
  if (response) {
    remember(selection.identity, response)
    ElMessage.success(`${selection.characterName}的四张角色候选已生成并保存`)
  }
}

watch(options, (items) => {
  let present = false
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].identity === selectedIdentity.value) present = true
  }
  if (!present) {
    selectedIdentity.value = items[0]?.identity || ''
  }
}, { immediate: true })

watch(() => props.dramaUid, () => {
  execution.invalidate()
  completedByIdentity.value = Object.freeze([])
  selectedIdentity.value = options.value[0]?.identity || ''
})
</script>

<style scoped>
.candidate-panel { margin-top: 16px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 13px; background: var(--el-fill-color-light); }
.candidate-heading, .candidate-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.candidate-heading h3 { margin: 0 0 5px; font-size: 16px; }
.candidate-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.candidate-form { display: grid; grid-template-columns: 2fr repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.candidate-form :deep(.el-select), .candidate-form :deep(.el-input-number) { width: 100%; }
.candidate-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.candidate-grid figure { margin: 0; min-width: 0; }
.candidate-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); }
.candidate-grid figcaption { margin-top: 6px; overflow: hidden; color: var(--el-text-color-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.candidate-actions { margin-top: 14px; color: var(--el-text-color-secondary); font-size: 12px; }
.candidate-error { color: var(--el-color-danger); font-size: 12px; }
@media (max-width: 900px) { .candidate-form, .candidate-grid { grid-template-columns: 1fr 1fr; } .candidate-heading, .candidate-actions { align-items: flex-start; flex-direction: column; } }
</style>
