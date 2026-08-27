<template>
  <section class="selection-panel">
    <div class="block-column">
      <div class="panel-heading">
        <div>
          <h2>原文分块</h2>
          <p>按标题、段落和长度建立，可精确回溯原文位置。</p>
        </div>
        <el-tag type="info" effect="plain">{{ blocks.length }} 块</el-tag>
      </div>
      <div class="block-list">
        <article v-for="block in blocks" :key="block.uid" class="block-card">
          <div class="block-meta">
            <span>块 {{ block.ordinal + 1 }}</span>
            <span>{{ block.charStart }}–{{ block.charEnd }}</span>
            <button type="button" @click="chooseWholeBlock(block)">选择整块</button>
          </div>
          <div v-if="block.headingPath?.length" class="heading-path">
            {{ block.headingPath.join(' / ') }}
          </div>
          <pre>{{ block.text }}</pre>
        </article>
      </div>
    </div>

    <aside class="range-column">
      <div class="panel-heading compact">
        <div>
          <h2>精确选区</h2>
          <p>偏移按 Unicode 字符计算，支持跨块选择。</p>
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="起始块">
          <el-select v-model="draft.startBlockUid" @change="normalizeRange">
            <el-option
              v-for="block in blocks"
              :key="block.uid"
              :label="blockLabel(block)"
              :value="block.uid"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="起始偏移">
          <el-input-number
            v-model="draft.startOffset"
            :min="0"
            :max="startLength"
            controls-position="right"
          />
        </el-form-item>
        <el-form-item label="结束块">
          <el-select v-model="draft.endBlockUid" @change="normalizeRange">
            <el-option
              v-for="block in blocks"
              :key="block.uid"
              :label="blockLabel(block)"
              :value="block.uid"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="结束偏移（不含）">
          <el-input-number
            v-model="draft.endOffset"
            :min="0"
            :max="endLength"
            controls-position="right"
          />
        </el-form-item>
      </el-form>

      <div class="preview-label">选区预览</div>
      <el-input :model-value="preview" type="textarea" :rows="10" readonly />
      <div class="selection-actions">
        <span>{{ Array.from(preview).length }} 字符</span>
        <el-button type="primary" :disabled="!valid" :loading="saving" @click="submit">
          保存选区
        </el-button>
      </div>

      <div v-if="selections.length" class="saved-selections">
        <div class="preview-label">已保存选区</div>
        <div v-for="item in selections" :key="item.uid" class="saved-item">
          <span>{{ shortUid(item.uid) }}</span>
          <span>{{ item.startOffset }} → {{ item.endOffset }}</span>
        </div>
      </div>
    </aside>
  </section>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'

import { createSelectionPayload, previewSelection } from './sourceSelection.js'

const props = defineProps({
  blocks: { type: Array, required: true },
  selections: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['create'])

const draft = reactive({
  startBlockUid: '',
  endBlockUid: '',
  startOffset: 0,
  endOffset: 0,
})

const pointLength = (value) => Array.from(value || '').length
const startBlock = computed(() => props.blocks.find((block) => block.uid === draft.startBlockUid))
const endBlock = computed(() => props.blocks.find((block) => block.uid === draft.endBlockUid))
const startLength = computed(() => pointLength(startBlock.value?.text))
const endLength = computed(() => pointLength(endBlock.value?.text))

const valid = computed(() => {
  try {
    createSelectionPayload(props.blocks, draft)
    return true
  } catch {
    return false
  }
})

const preview = computed(() => {
  if (!valid.value) return ''
  return previewSelection(props.blocks, draft)
})

function initialize() {
  const first = props.blocks[0]
  if (!first) {
    Object.assign(draft, { startBlockUid: '', endBlockUid: '', startOffset: 0, endOffset: 0 })
    return
  }
  Object.assign(draft, {
    startBlockUid: first.uid,
    endBlockUid: first.uid,
    startOffset: 0,
    endOffset: pointLength(first.text),
  })
}

function normalizeRange() {
  const startIndex = props.blocks.findIndex((block) => block.uid === draft.startBlockUid)
  const endIndex = props.blocks.findIndex((block) => block.uid === draft.endBlockUid)
  if (startIndex >= 0 && endIndex >= 0 && endIndex < startIndex) {
    draft.endBlockUid = draft.startBlockUid
  }
  draft.startOffset = Math.min(draft.startOffset, startLength.value)
  draft.endOffset = Math.min(draft.endOffset, endLength.value)
  if (draft.startBlockUid === draft.endBlockUid && draft.endOffset <= draft.startOffset) {
    draft.endOffset = Math.min(startLength.value, draft.startOffset + 1)
  }
}

function chooseWholeBlock(block) {
  Object.assign(draft, {
    startBlockUid: block.uid,
    endBlockUid: block.uid,
    startOffset: 0,
    endOffset: pointLength(block.text),
  })
}

function submit() {
  if (!valid.value) return
  emit('create', createSelectionPayload(props.blocks, draft))
}

function blockLabel(block) {
  const path = block.headingPath?.length ? ` · ${block.headingPath.join(' / ')}` : ''
  return `块 ${block.ordinal + 1}${path}`
}

function shortUid(value) {
  return `${value.slice(0, 8)}…`
}

watch(() => props.blocks, initialize, { immediate: true })
</script>

<style scoped>
.selection-panel { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(300px, .8fr); gap: 18px; }
.block-column, .range-column { min-width: 0; }
.range-column { position: sticky; top: 88px; align-self: start; padding: 18px; border: 1px solid var(--el-border-color); border-radius: 14px; background: var(--el-bg-color); }
.panel-heading { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.panel-heading h2 { margin: 0 0 4px; font-size: 17px; }
.panel-heading p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.panel-heading.compact { margin-bottom: 8px; }
.block-list { display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow: auto; padding-right: 4px; }
.block-card { border: 1px solid var(--el-border-color); border-radius: 12px; padding: 14px; background: var(--el-fill-color-blank); }
.block-meta { display: flex; align-items: center; gap: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.block-meta button { margin-left: auto; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.heading-path { margin: 10px 0 6px; color: var(--el-color-primary); font-size: 12px; font-weight: 600; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--el-text-color-primary); font: 13px/1.75 ui-monospace, SFMono-Regular, Consolas, monospace; }
.range-column :deep(.el-select), .range-column :deep(.el-input-number) { width: 100%; }
.preview-label { margin: 8px 0; color: var(--el-text-color-regular); font-size: 13px; font-weight: 600; }
.selection-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.saved-selections { margin-top: 20px; }
.saved-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 900px) { .selection-panel { grid-template-columns: 1fr; } .range-column { position: static; } }
</style>
