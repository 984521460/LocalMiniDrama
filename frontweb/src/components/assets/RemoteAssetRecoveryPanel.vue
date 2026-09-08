<template>
  <section class="recovery-panel">
    <div class="recovery-heading">
      <div>
        <h4>远端资产恢复</h4>
        <p>读取远端任务的 manifest 和图片，校验后保存到本地隔离库；不会重新生图。</p>
      </div>
      <el-tag type="warning" effect="plain">隔离 · 未批准</el-tag>
    </div>

    <div class="recovery-form">
      <el-form-item label="远程连接">
        <el-select v-model="connectionUid" placeholder="选择已就绪连接" :disabled="recovery.busy.value">
          <el-option
            v-for="item in readyConnections"
            :key="item.uid"
            :label="item.name"
            :value="item.uid"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="远端任务 UID">
        <el-input v-model="remoteTaskUid" placeholder="xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx" />
      </el-form-item>
      <el-button
        type="warning"
        plain
        :loading="recovery.busy.value"
        :disabled="!canRecover"
        @click="recover"
      >恢复到本地隔离库</el-button>
    </div>

    <el-alert
      v-if="!selection"
      type="info"
      title="先在上方选择对应的已批准角色事实"
      :closable="false"
    />
    <p v-if="connectionError" class="recovery-error">无法读取远程连接配置。</p>
    <p v-if="recovery.error.value" class="recovery-error">
      恢复失败；请确认实例可连接、任务 UID 正确且远端 manifest/文件未变化。
    </p>

    <div v-for="record in succeeded" :key="record.operationUid" class="recovery-record">
      <div class="recovery-record-title">
        <strong>已保存 {{ record.items.length }} 项本地恢复素材</strong>
        <span>
          <el-tag v-if="!record.sourceCurrent" type="info" size="small">来源已变更，仅供查看</el-tag>
          {{ record.manifest.sourceFormat }} · {{ shortHash(record.manifest.sourceManifestSha256) }}
        </span>
      </div>
      <div class="recovery-grid">
        <figure v-for="item in record.items" :key="item.assetVersionUid">
          <a :href="`/static/${item.relativePath}`" target="_blank" rel="noopener noreferrer">
            <img :src="`/static/${item.relativePath}`" :alt="`恢复素材 ${item.ordinal + 1}`" />
          </a>
          <figcaption>素材 {{ item.ordinal + 1 }} · {{ item.width }}×{{ item.height }}</figcaption>
        </figure>
      </div>
      <p class="recovery-warning">这些素材尚未通过角色候选审核，不能锁定身份或进入参考包。</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { remoteConnectionAPI } from '@/api/v2/remoteConnections.js'
import { useRemoteAssetRecovery } from '@/composables/useRemoteAssetRecovery.js'
import { remoteConnectionListView } from '@/remote/connectionProfile.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  selection: { type: Object, default: null },
})

const recovery = useRemoteAssetRecovery()
const connections = ref(Object.freeze([]))
const connectionUid = ref('')
const remoteTaskUid = ref('')
const connectionError = ref(false)
const readyConnections = computed(() => connections.value.filter((item) => (
  item.status === 'ready' && item.credentialConfigured
)))
const selectedConnection = computed(() => readyConnections.value.find((item) => (
  item.uid === connectionUid.value
)) || null)
const canRecover = computed(() => Boolean(
  props.selection && selectedConnection.value
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(remoteTaskUid.value),
))
const succeeded = computed(() => recovery.recoveries.value.filter((item) => (
  item.state === 'succeeded'
)))

function shortHash(value) {
  return typeof value === 'string' ? `${value.slice(0, 10)}…` : '—'
}

async function loadConnections() {
  connectionError.value = false
  try {
    connections.value = remoteConnectionListView(await remoteConnectionAPI.list())
    if (!readyConnections.value.some((item) => item.uid === connectionUid.value)) {
      connectionUid.value = readyConnections.value[0]?.uid || ''
    }
  } catch {
    connectionError.value = true
    connections.value = Object.freeze([])
  }
}

async function refreshHistory() {
  if (!props.selection) {
    recovery.invalidate()
    return
  }
  await recovery.refresh({
    dramaId: props.dramaId,
    dramaUid: props.dramaUid,
    characterUid: props.selection.characterUid,
  })
}

async function recover() {
  if (!canRecover.value || recovery.busy.value) return
  try {
    await ElMessageBox.confirm(
      '将通过已信任的 SSH 连接只读下载该任务的 manifest 和图片，并写入本地隔离库。不会发起新的生图调用。确认继续？',
      '确认恢复远端资产',
      { type: 'warning', confirmButtonText: '确认恢复', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const connection = selectedConnection.value
  const selection = props.selection
  const result = await recovery.execute({
    dramaId: props.dramaId,
    dramaUid: props.dramaUid,
    characterUid: selection.characterUid,
    extractionResultUid: selection.extractionResultUid,
    characterFactId: selection.characterFactId,
    connectionUid: connection.uid,
    connectionEvidenceSha256: connection.connectionEvidenceSha256,
    remoteTaskUid: remoteTaskUid.value,
  })
  if (result) ElMessage.success(`已把 ${result.recovery.items.length} 项远端素材保存到本地隔离库`)
}

onMounted(loadConnections)
watch(() => props.selection?.identity || '', refreshHistory, { immediate: true })
</script>

<style scoped>
.recovery-panel { margin-top: 18px; padding: 14px; border: 1px dashed var(--el-color-warning-light-5); border-radius: 12px; background: var(--el-color-warning-light-9); }
.recovery-heading, .recovery-record-title { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.recovery-heading h4 { margin: 0 0 4px; }
.recovery-heading p, .recovery-record-title span, .recovery-warning { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.recovery-form { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(260px, 2fr) auto; align-items: end; gap: 10px; margin-top: 14px; }
.recovery-form :deep(.el-select) { width: 100%; }
.recovery-record { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.recovery-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.recovery-grid figure { margin: 0; }
.recovery-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 1px solid var(--el-border-color); }
.recovery-grid figcaption { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; }
.recovery-warning { margin-top: 9px; }
.recovery-error { color: var(--el-color-danger); font-size: 12px; }
@media (max-width: 900px) { .recovery-form { grid-template-columns: 1fr; } .recovery-grid { grid-template-columns: 1fr 1fr; } }
</style>
