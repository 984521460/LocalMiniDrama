<template>
  <section class="local-package-panel">
    <div class="heading">
      <div>
        <h4>导入已下载的远端素材</h4>
        <p>选择包含 manifest 和图片的 ZIP；系统校验来源并恢复到当前角色，不会重新生图。</p>
      </div>
      <el-tag type="warning" effect="plain">本地恢复 · 未批准</el-tag>
    </div>
    <div class="actions">
      <input
        ref="fileInput"
        type="file"
        accept=".zip,application/zip"
        :disabled="busy || !selection"
        @change="choose"
      />
      <el-button
        :disabled="busy || !file || !selection"
        :loading="busy"
        @click="importPackage"
      >校验并导入</el-button>
      <el-button :disabled="busy || !selection" @click="refresh">刷新记录</el-button>
    </div>
    <el-alert
      v-if="!selection"
      type="info"
      title="先选择已批准的角色事实"
      :closable="false"
    />
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <article v-for="record in records" :key="record.uid">
      <p>
        {{ record.characterName }} · {{ record.items.length }} 张 · 未审核 ·
        包 {{ shortHash(record.packageSha256) }}
        <el-tag v-if="!record.sourceCurrent" type="info" size="small">来源已变更，仅供查看</el-tag>
      </p>
      <div class="images">
        <a
          v-for="item in record.items"
          :key="item.assetVersionUid"
          :href="`/static/${item.relativePath}`"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            :src="`/static/${item.relativePath}`"
            :alt="`${record.characterName} 素材 ${item.ordinal + 1}`"
          />
        </a>
      </div>
    </article>
  </section>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { localRecoveryPackageAPI } from '@/api/v2/localRecoveryPackages.js'

const props = defineProps({ dramaId: Number, selection: Object })
const file = ref(null)
const fileInput = ref(null)
const busy = ref(false)
const error = ref('')
const records = ref(Object.freeze([]))
let generation = 0
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024

function shortHash(value) {
  return typeof value === 'string' ? `${value.slice(0, 10)}…` : '—'
}

function choose(event) {
  file.value = event.target.files?.[0] || null
  error.value = ''
  if (file.value && (!file.value.name.toLowerCase().endsWith('.zip')
    || file.value.size < 1 || file.value.size > MAX_PACKAGE_BYTES)) {
    file.value = null
    event.target.value = ''
    error.value = '请选择不超过 64 MB 的有效 ZIP 文件。'
  }
}

async function refresh() {
  const token = ++generation
  records.value = Object.freeze([])
  error.value = ''
  const selection = props.selection
  if (!selection) return
  try {
    const response = await localRecoveryPackageAPI.list(props.dramaId, selection.characterUid)
    if (token === generation) records.value = response.records
  } catch {
    if (token === generation) error.value = '无法读取本地导入记录。'
  }
}

async function importPackage() {
  if (busy.value || !file.value || !props.selection) return
  busy.value = true
  error.value = ''
  const token = generation
  const selected = props.selection
  try {
    await localRecoveryPackageAPI.importPackage({
      dramaId: props.dramaId,
      characterUid: selected.characterUid,
      extractionResultUid: selected.extractionResultUid,
      characterFactId: selected.characterFactId,
      file: file.value,
    })
    if (token === generation) {
      file.value = null
      if (fileInput.value) fileInput.value.value = ''
      ElMessage.success('素材包已校验并写入本地恢复区，仍需人工审核。')
      busy.value = false
      await refresh()
    }
  } catch {
    if (token === generation) {
      error.value = '导入失败，请检查素材包、来源身份和当前角色是否匹配。'
    }
  } finally {
    if (token === generation) busy.value = false
  }
}

watch(() => [props.dramaId, props.selection?.identity], refresh, { immediate: true })
</script>

<style scoped>
.local-package-panel { margin: 16px 0; padding: 14px; border: 1px solid var(--el-border-color); border-radius: 10px; }
.heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heading h4 { margin: 0 0 4px; }
.heading p { margin: 0; color: var(--el-text-color-secondary); }
.actions { justify-content: flex-start; margin: 12px 0; }
.local-package-panel p { font-size: 13px; }
.error { color: var(--el-color-danger); }
.images { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.images img { width: 100%; border-radius: 6px; }
@media (max-width: 900px) { .heading, .actions { align-items: stretch; flex-direction: column; } }
</style>
