<template>
  <div class="narrative-workflow">
    <header class="workflow-header">
      <div>
        <button class="back-link" type="button" @click="router.push(`/drama/${dramaId}`)">← 返回剧集</button>
        <h1>原文与选区</h1>
        <p>{{ drama?.title || '剧集' }} · 导入 TXT / Markdown，建立后续叙事任务的证据源。</p>
      </div>
      <el-tag type="success" effect="dark">本地处理</el-tag>
    </header>

    <main class="workflow-main" v-loading="loading">
      <section class="import-card">
        <div>
          <h2>导入小说原文</h2>
          <p>支持 .txt / .md，单文件不超过 50 MiB。编码不确定时会先让你选择，不会写入数据库。</p>
        </div>
        <div class="import-actions">
          <input ref="fileInput" class="file-input" type="file" accept=".txt,.md,text/plain,text/markdown" @change="onFileSelected" />
          <el-button @click="fileInput?.click()">选择文件</el-button>
          <span class="file-name">{{ pendingFile?.name || '尚未选择文件' }}</span>
          <el-button type="primary" :disabled="!pendingFile" :loading="importing" @click="importFile()">导入并解析</el-button>
        </div>
        <div v-if="encodingOptions.length" class="encoding-choice">
          <span>该文件存在多种有效解码，请确认：</span>
          <el-select v-model="selectedEncoding" placeholder="选择编码">
            <el-option v-for="encoding in encodingOptions" :key="encoding" :label="encoding" :value="encoding" />
          </el-select>
          <el-button type="primary" :disabled="!selectedEncoding" :loading="importing" @click="importFile(selectedEncoding)">按此编码导入</el-button>
        </div>
      </section>

      <section class="document-strip">
        <div class="section-title">
          <div><h2>已导入文档</h2><p>选择一个文档查看分块并保存精确选区。</p></div>
          <el-button text :loading="loadingDocuments" @click="loadDocuments">刷新</el-button>
        </div>
        <div v-if="documents.length" class="document-list">
          <button
            v-for="item in documents"
            :key="item.uid"
            type="button"
            class="document-card"
            :class="{ active: item.uid === activeDocumentUid }"
            @click="openDocument(item.uid)"
          >
            <strong>{{ item.originalName }}</strong>
            <span>{{ item.sourceType }} · {{ item.encoding }} · {{ item.blockCount }} 块</span>
            <small>{{ item.contentSha256.slice(0, 12) }}…</small>
          </button>
        </div>
        <el-empty v-else description="尚未导入原文" :image-size="72" />
      </section>

      <SourceSelectionPanel
        v-if="activeDocument"
        :blocks="activeDocument.blocks"
        :selections="activeDocument.selections"
        :saving="savingSelection"
        @create="saveSelection"
      />

      <NarrativeReviewWorkspace
        v-if="drama?.uid"
        :drama-id="dramaId"
        :drama-uid="drama.uid"
        :selections="activeDocument?.selections || []"
      />
      <AssetVersionContinuityWorkspace :drama-id="dramaId" />
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import { dramaAPI } from '@/api/drama'
import { sourceDocumentAPI } from '@/api/v2/sourceDocuments'
import SourceSelectionPanel from '@/components/narrative/SourceSelectionPanel.vue'
import NarrativeReviewWorkspace from '@/components/narrative/NarrativeReviewWorkspace.vue'
import AssetVersionContinuityWorkspace from '@/components/assets/AssetVersionContinuityWorkspace.vue'

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)
const drama = ref(null)
const documents = ref([])
const activeDocumentUid = ref('')
const activeDocument = ref(null)
const loading = ref(false)
const loadingDocuments = ref(false)
const importing = ref(false)
const savingSelection = ref(false)
const pendingFile = ref(null)
const fileInput = ref(null)
const encodingOptions = ref([])
const selectedEncoding = ref('')

function onFileSelected(event) {
  const file = event.target.files?.[0] || null
  if (file && file.size > 50 * 1024 * 1024) {
    ElMessage.error('文件不能超过 50 MiB')
    event.target.value = ''
    pendingFile.value = null
    return
  }
  pendingFile.value = file
  encodingOptions.value = []
  selectedEncoding.value = ''
}

async function importFile(encoding) {
  if (!pendingFile.value) return
  importing.value = true
  try {
    const result = await sourceDocumentAPI.importDocument(dramaId, pendingFile.value, encoding)
    if (result.status === 'encoding_required') {
      encodingOptions.value = result.encodingOptions || []
      ElMessage.warning('请确认文本编码后继续导入')
      return
    }
    encodingOptions.value = []
    selectedEncoding.value = ''
    ElMessage.success('原文已导入并完成分块')
    await loadDocuments()
    await openDocument(result.document.uid)
    return true
  } catch {
    return false
  } finally {
    importing.value = false
  }
}

async function loadDocuments() {
  loadingDocuments.value = true
  try {
    documents.value = await sourceDocumentAPI.list(dramaId)
    if (!activeDocumentUid.value && documents.value.length) {
      await openDocument(documents.value[0].uid)
    }
    return true
  } catch {
    return false
  } finally {
    loadingDocuments.value = false
  }
}

async function openDocument(uid) {
  try {
    const result = await sourceDocumentAPI.get(uid)
    activeDocumentUid.value = uid
    activeDocument.value = result
    return true
  } catch {
    return false
  }
}

async function saveSelection(selection) {
  if (!activeDocument.value) return
  savingSelection.value = true
  try {
    await sourceDocumentAPI.createSelection(activeDocument.value.document.uid, selection)
    ElMessage.success('选区已保存，可用于下一步事实提取')
    await openDocument(activeDocument.value.document.uid)
    return true
  } catch {
    return false
  } finally {
    savingSelection.value = false
  }
}

onMounted(async () => {
  if (!Number.isSafeInteger(dramaId) || dramaId < 1) {
    router.replace('/')
    return
  }
  loading.value = true
  try {
    drama.value = await dramaAPI.get(dramaId)
    await loadDocuments()
  } catch {
    // 请求层已展示可读错误；这里吸收异常，避免 Vue mounted 钩子产生未处理拒绝。
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.narrative-workflow { min-height: 100vh; padding-bottom: 48px; background: var(--el-bg-color-page); color: var(--el-text-color-primary); }
.workflow-header { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 28px max(24px, calc((100vw - 1200px) / 2)); border-bottom: 1px solid var(--el-border-color); background: linear-gradient(135deg, color-mix(in srgb, var(--el-color-primary) 12%, var(--el-bg-color)), var(--el-bg-color)); }
.workflow-header h1 { margin: 8px 0 4px; font-size: 28px; }
.workflow-header p, .import-card p, .section-title p { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.back-link { padding: 0; border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.workflow-main { width: min(1200px, calc(100% - 32px)); margin: 22px auto 0; display: flex; flex-direction: column; gap: 18px; }
.import-card, .document-strip { padding: 20px; border: 1px solid var(--el-border-color); border-radius: 16px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.import-card h2, .section-title h2 { margin: 0 0 5px; font-size: 18px; }
.import-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.file-input { display: none; }
.file-name { min-width: 180px; color: var(--el-text-color-secondary); font-size: 13px; }
.encoding-choice { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; padding: 12px; border-radius: 10px; background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); font-size: 13px; }
.encoding-choice :deep(.el-select) { width: 160px; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.document-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; margin-top: 15px; }
.document-card { display: flex; flex-direction: column; gap: 5px; padding: 13px; text-align: left; border: 1px solid var(--el-border-color); border-radius: 11px; background: var(--el-fill-color-blank); color: var(--el-text-color-primary); cursor: pointer; }
.document-card.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-8); }
.document-card span, .document-card small { color: var(--el-text-color-secondary); }
</style>
