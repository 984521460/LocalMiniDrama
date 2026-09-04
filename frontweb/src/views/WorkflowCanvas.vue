<template>
  <div class="workflow-canvas-page">
    <header class="page-header">
      <div class="identity">
        <button type="button" class="back-link" @click="router.push(`/drama/${dramaId}`)">← 返回剧集</button>
        <div><strong>{{ drama?.title || '剧集' }}</strong><span>v2 可执行工作流画布</span></div>
      </div>
      <div class="workflow-switcher">
        <el-select
          :model-value="canvas.activeWorkflowUid.value"
          placeholder="选择工作流"
          style="width: 230px"
          @change="selectWorkflow"
        >
          <el-option v-for="item in canvas.workflows.value" :key="item.uid" :label="item.name" :value="item.uid" />
        </el-select>
        <el-button type="primary" @click="createVisible = true"><el-icon><Plus /></el-icon>新建工作流</el-button>
        <el-tag v-if="canvas.registry.value" type="info" effect="plain">Registry {{ canvas.registry.value.registryVersion }}</el-tag>
        <el-button class="theme-button" @click="toggleTheme"><el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon></el-button>
      </div>
    </header>

    <WorkflowToolbar
      :workflow-name="canvas.activeWorkflow.value?.name || ''"
      :dirty="canvas.dirty.value"
      :saving="canvas.saving.value"
      :running="canvas.running.value"
      :selected-count="canvas.selectedNodeUids.value.length"
      :can-cancel="canvas.canCancel.value"
      :max-retries="maxRetries"
      @save="saveGraph"
      @execute="execute"
      @cancel="cancelRun"
      @update:max-retries="maxRetries = $event"
    />

    <div v-if="canvas.lastError.value" class="error-banner">
      <strong>{{ canvas.lastError.value.code }}</strong>
      <span>{{ canvas.lastError.value.message }}</span>
      <small v-if="canvas.lastError.value.code === 'WORKFLOW_EXECUTION_UNAVAILABLE'">当前阶段尚未接入生产 Provider 执行器；图编辑、保存和运行状态界面仍可验证。</small>
    </div>

    <main v-loading="canvas.loading.value" class="canvas-shell">
      <WorkflowPalette
        :definitions="canvas.registry.value?.nodes || []"
        :disabled="!canvas.activeWorkflowUid.value"
        @add="addNode"
      />

      <section class="flow-stage">
        <VueFlow
          v-if="canvas.activeWorkflowUid.value"
          v-model:nodes="canvas.nodes.value"
          v-model:edges="canvas.edges.value"
          :node-types="nodeTypes"
          :min-zoom="0.15"
          :max-zoom="2"
          :fit-view-on-init="true"
          :snap-to-grid="true"
          :snap-grid="[16, 16]"
          :connection-radius="30"
          :delete-key-code="null"
          class="workflow-flow"
          @init="onFlowInit"
          @connect="onConnect"
          @node-drag-stop="canvas.markDirty"
          @selection-change="onSelectionChange"
          @node-click="syncSelectionAfterInteraction"
          @edge-click="syncSelectionAfterInteraction"
          @pane-click="clearSelection"
        >
          <Background pattern-color="#3f3f46" :gap="20" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>
        <div v-else class="empty-workflow">
          <div class="empty-icon">⌘</div>
          <h2>建立第一个 v2 工作流</h2>
          <p>从节点注册表添加高级业务节点，自由连接后保存；前端只提交执行范围，调度由本地后端完成。</p>
          <el-button type="primary" @click="createVisible = true">新建工作流</el-button>
        </div>
      </section>

      <aside class="right-panel">
        <el-tabs v-model="rightTab" stretch>
          <el-tab-pane label="检查器" name="inspector">
            <WorkflowInspector
              :node="selectedNode"
              :edge-count="canvas.selectedEdgeUids.value.length"
              @apply="applyNodePatch"
              @delete="deleteSelection"
            />
          </el-tab-pane>
          <el-tab-pane label="运行" name="runs">
            <WorkflowRunPanel
              :runs="canvas.runs.value"
              :active-run="canvas.activeRun.value"
              :running="canvas.running.value"
              :can-cancel="canvas.canCancel.value"
              @refresh="refreshRuns"
              @open="openRun"
              @retry="retryNode"
              @cancel="cancelRun"
            />
          </el-tab-pane>
          <el-tab-pane label="成片" name="export">
            <MediaExportRunPanel
              :runs="mediaExports.runs.value"
              :node-run-uid="succeededExportNodeRunUid"
              :busy="mediaExports.busy.value"
              :error="mediaExports.error.value || ''"
              @refresh="refreshMediaExports"
              @start="startMediaExport"
            />
          </el-tab-pane>
          <el-tab-pane label="MVP" name="mvp">
            <MvpBenchmarkResumePanel
              :run="canvas.activeRun.value?.run || null"
              :snapshot="mvpResume.snapshot.value"
              :busy="mvpResume.busy.value"
              :error="mvpResume.error.value || ''"
              @resume="resumeMvpState"
            />
            <MvpBenchmarkSessionPanel
              :run="canvas.activeRun.value?.run || null"
              :session="mvpSession.session.value"
              :busy="mvpSession.busy.value"
              :error="mvpSession.error.value || ''"
              @prepare="prepareMvpSession"
            />
            <MvpBenchmarkAuthorizationPanel
              :session="mvpSession.session.value"
              :authorization="mvpAuthorization.authorization.value"
              :connections="mvpAuthorization.connections.value"
              :busy="mvpAuthorization.busy.value"
              :error="mvpAuthorization.error.value || ''"
              @authorize="authorizeMvpSession"
            />
            <MvpBenchmarkPreflightPanel
              :authorization="mvpAuthorization.authorization.value"
              :batch="mvpPreflight.batch.value"
              :busy="mvpPreflight.busy.value"
              :error="mvpPreflight.error.value || ''"
              @preflight="preflightMvpSession"
            />
            <MvpBenchmarkExecutionPanel
              :authorization="mvpAuthorization.authorization.value"
              :batch="mvpPreflight.batch.value"
              :step="mvpExecution.step.value"
              :progress="mvpExecution.progress.value"
              :busy="mvpExecution.busy.value"
              :error="mvpExecution.error.value || ''"
              @execute="executeNextMvpItem"
              @refresh="refreshMvpExecution"
            />
            <BgmLibraryPanel
              :drama-uid="canvas.activeWorkflow.value?.dramaUid || ''"
              :tracks="bgmLibrary.tracks.value"
              :selected-track-uid="bgmLibrary.selectedTrackUid.value"
              :busy="bgmLibrary.busy.value"
              :error="bgmLibrary.error.value || ''"
              @refresh="refreshBgmLibrary"
              @import="importBgmTrack"
              @select="selectBgmTrack"
            />
            <MvpBenchmarkFinalizationPanel
              :batch-complete="mvpExecutionBatchComplete"
              :selected-track-uid="bgmLibrary.selectedTrackUid.value"
              :run="mvpFinalization.run.value"
              :busy="mvpFinalization.busy.value"
              :error="mvpFinalization.error.value || ''"
              @finalize="finalizeMvpProduction"
            />
            <MvpBenchmarkHumanAvReviewPanel
              :run="mvpFinalization.run.value"
              :review="mvpHumanAvReview.review.value"
              :busy="mvpHumanAvReview.busy.value"
              :error="mvpHumanAvReview.error.value || ''"
              @refresh="refreshMvpHumanAvReview"
              @review="reviewMvpProduction"
            />
            <MvpBenchmarkAccountingStatusPanel
              :batch="mvpPreflight.batch.value"
              :status="mvpAccountingStatus.status.value"
              :busy="mvpAccountingStatus.busy.value"
              :error="mvpAccountingStatus.error.value || ''"
              @refresh="refreshMvpAccountingStatus"
            />
            <MvpBenchmarkReadinessPanel
              :readiness="mvpReadiness.readiness.value"
              :busy="mvpReadiness.busy.value"
              :error="mvpReadiness.error.value || ''"
              @refresh="refreshMvpReadiness"
            />
          </el-tab-pane>
        </el-tabs>
      </aside>
    </main>

    <el-dialog v-model="createVisible" title="新建 v2 工作流" width="430px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="名称"><el-input v-model="createForm.name" maxlength="80" show-word-limit /></el-form-item>
        <el-form-item label="说明"><el-input v-model="createForm.description" type="textarea" :rows="3" maxlength="300" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" :disabled="!createForm.name.trim()" @click="createWorkflow">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Moon, Plus, Sunny } from '@element-plus/icons-vue'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { dramaAPI } from '@/api/drama'
import WorkflowInspector from '@/components/workflow/WorkflowInspector.vue'
import WorkflowNode from '@/components/workflow/WorkflowNode.vue'
import WorkflowPalette from '@/components/workflow/WorkflowPalette.vue'
import WorkflowRunPanel from '@/components/workflow/WorkflowRunPanel.vue'
import WorkflowToolbar from '@/components/workflow/WorkflowToolbar.vue'
import MediaExportRunPanel from '@/components/media/MediaExportRunPanel.vue'
import BgmLibraryPanel from '@/components/audio/BgmLibraryPanel.vue'
import MvpBenchmarkAccountingStatusPanel from '@/components/benchmark/MvpBenchmarkAccountingStatusPanel.vue'
import MvpBenchmarkReadinessPanel from '@/components/benchmark/MvpBenchmarkReadinessPanel.vue'
import MvpBenchmarkAuthorizationPanel from '@/components/benchmark/MvpBenchmarkAuthorizationPanel.vue'
import MvpBenchmarkExecutionPanel from '@/components/benchmark/MvpBenchmarkExecutionPanel.vue'
import MvpBenchmarkFinalizationPanel from '@/components/benchmark/MvpBenchmarkFinalizationPanel.vue'
import MvpBenchmarkHumanAvReviewPanel from '@/components/benchmark/MvpBenchmarkHumanAvReviewPanel.vue'
import MvpBenchmarkPreflightPanel from '@/components/benchmark/MvpBenchmarkPreflightPanel.vue'
import MvpBenchmarkResumePanel from '@/components/benchmark/MvpBenchmarkResumePanel.vue'
import MvpBenchmarkSessionPanel from '@/components/benchmark/MvpBenchmarkSessionPanel.vue'
import { useMediaExports } from '@/composables/useMediaExports'
import { useBgmLibrary } from '@/composables/useBgmLibrary'
import { useMvpBenchmarkAccountingStatus } from '@/composables/useMvpBenchmarkAccountingStatus'
import { useMvpBenchmarkReadiness } from '@/composables/useMvpBenchmarkReadiness'
import { useMvpBenchmarkAuthorization } from '@/composables/useMvpBenchmarkAuthorization'
import { useMvpBenchmarkExecution } from '@/composables/useMvpBenchmarkExecution'
import { useMvpBenchmarkFinalization } from '@/composables/useMvpBenchmarkFinalization'
import { useMvpBenchmarkHumanAvReview } from '@/composables/useMvpBenchmarkHumanAvReview'
import { useMvpBenchmarkPreflight } from '@/composables/useMvpBenchmarkPreflight'
import { useMvpBenchmarkResume } from '@/composables/useMvpBenchmarkResume'
import { useMvpBenchmarkSession } from '@/composables/useMvpBenchmarkSession'
import { useTheme } from '@/composables/useTheme'
import { useWorkflowCanvas } from '@/composables/useWorkflowCanvas'

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)
const { isDark, toggle: toggleTheme } = useTheme()
const canvas = useWorkflowCanvas({ dramaId })
const mediaExports = useMediaExports({ dramaId })
const bgmLibrary = useBgmLibrary()
const mvpAccountingStatus = useMvpBenchmarkAccountingStatus()
const mvpReadiness = useMvpBenchmarkReadiness()
const mvpAuthorization = useMvpBenchmarkAuthorization()
const mvpExecution = useMvpBenchmarkExecution()
const mvpFinalization = useMvpBenchmarkFinalization()
const mvpHumanAvReview = useMvpBenchmarkHumanAvReview()
const mvpPreflight = useMvpBenchmarkPreflight()
const mvpResume = useMvpBenchmarkResume()
const mvpSession = useMvpBenchmarkSession()

const drama = ref(null)
const createVisible = ref(false)
const creating = ref(false)
const rightTab = ref('inspector')
const maxRetries = ref(1)
const flowApi = ref(null)
const createForm = reactive({ name: '主工作流', description: 'v2 可执行制作流程' })
const nodeTypes = { workflowNode: markRaw(WorkflowNode) }

const selectedNode = computed(() => {
  if (canvas.selectedNodeUids.value.length !== 1) return null
  return canvas.nodes.value.find((node) => node.id === canvas.selectedNodeUids.value[0]) || null
})

const succeededExportNodeRunUid = computed(() => {
  const aggregate = canvas.activeRun.value
  const graphNodes = aggregate?.run?.graphSnapshot?.snapshot?.nodes
  if (!Array.isArray(graphNodes) || !Array.isArray(aggregate?.nodes)) return ''
  const exportNodeUids = new Set(graphNodes.filter(
    (node) => node?.nodeType === 'export.final' && node.enabled === true,
  ).map((node) => node.uid))
  return aggregate.nodes.find(
    (node) => node?.status === 'succeeded' && exportNodeUids.has(node.nodeUid),
  )?.uid || ''
})

const mvpExecutionBatchComplete = computed(() => (
  mvpExecution.step.value?.batchComplete
  ?? mvpExecution.progress.value?.batchComplete
  ?? false
))

function onConnect(connection) {
  const result = canvas.connectNodes(connection)
  if (!result.ok) ElMessage.warning(result.message)
}

function onSelectionChange(selection) {
  canvas.setSelection(selection.nodes || [], selection.edges || [])
}

function onFlowInit(instance) {
  flowApi.value = instance
}

async function syncSelectionAfterInteraction() {
  await nextTick()
  canvas.setSelection(
    canvas.nodes.value.filter((node) => node.selected),
    canvas.edges.value.filter((edge) => edge.selected),
  )
}

function clearSelection() {
  canvas.setSelection([], [])
}

function addNode(definition) {
  const index = canvas.nodes.value.length
  canvas.addNode(definition, {
    x: 90 + (index % 3) * 280,
    y: 80 + Math.floor(index / 3) * 170,
  })
  nextTick(() => flowApi.value?.fitView?.({ padding: 0.18, maxZoom: 1, duration: 180 }))
}

function applyNodePatch(patch) {
  canvas.updateSelectedNode(patch)
  ElMessage.success('节点配置已应用，请保存工作流')
}

function deleteSelection() {
  canvas.deleteSelection()
}

async function createWorkflow() {
  if (!(await confirmDiscardIfDirty())) return
  creating.value = true
  try {
    await canvas.createWorkflow({
      name: createForm.name.trim(),
      description: createForm.description.trim(),
    })
    createVisible.value = false
    ElMessage.success('v2 工作流已创建')
  } catch {
    // 请求层与页面错误条已提供稳定反馈。
  } finally {
    creating.value = false
  }
}

async function confirmDiscardIfDirty() {
  if (!canvas.dirty.value) return true
  try {
    await ElMessageBox.confirm(
      '当前工作流有未保存更改，继续后这些更改会丢失。',
      '未保存更改',
      { type: 'warning', confirmButtonText: '继续', cancelButtonText: '返回保存' },
    )
    return true
  } catch {
    return false
  }
}

async function selectWorkflow(workflowUid) {
  if (!(await confirmDiscardIfDirty())) return
  await canvas.selectWorkflow(workflowUid)
}

async function saveGraph() {
  try {
    await canvas.save()
    ElMessage.success('工作流图已保存')
  } catch {
    // 请求层与页面错误条已提供稳定反馈。
  }
}

async function execute(mode) {
  try {
    await canvas.execute(mode, maxRetries.value)
    rightTab.value = 'runs'
    ElMessage.success('运行已提交给本地后端')
  } catch {
    rightTab.value = 'runs'
  }
}

async function retryNode(nodeRunUid) {
  try {
    await canvas.retryNode(nodeRunUid, maxRetries.value)
    ElMessage.success('失败分支已提交重试')
  } catch {
    // 请求层与页面错误条已提供稳定反馈。
  }
}

async function cancelRun() {
  try {
    await canvas.cancelRun()
    ElMessage.success('运行已取消')
  } catch {
    // 请求层与页面错误条已提供稳定反馈。
  }
}

async function refreshRuns() {
  try { await canvas.refreshRuns() } catch { /* request layer reports */ }
}

async function refreshMediaExports() {
  if (!(await mediaExports.load())) ElMessage.error('成片记录加载失败')
}

async function refreshMvpReadiness() {
  if (!(await mvpReadiness.load())) ElMessage.error('MVP 就绪度加载失败')
}

async function resumeMvpState() {
  const dramaUid = canvas.activeWorkflow.value?.dramaUid
  const workflowRunUid = canvas.activeRun.value?.run?.uid
  if (!dramaUid || !workflowRunUid
    || !(await mvpResume.load(dramaUid, workflowRunUid))) {
    ElMessage.error('本地执行状态恢复失败；不会采用部分状态')
    return
  }
  const snapshot = mvpResume.snapshot.value
  mvpSession.invalidate()
  mvpAuthorization.invalidate()
  mvpPreflight.invalidate()
  mvpExecution.invalidate()
  mvpFinalization.invalidate()
  mvpHumanAvReview.invalidate()
  mvpAccountingStatus.invalidate()
  mvpSession.session.value = snapshot.session
  mvpAuthorization.authorization.value = snapshot.authorization
  mvpPreflight.batch.value = snapshot.batch
  mvpExecution.progress.value = snapshot.progress
  const messages = {
    empty: '当前运行没有可恢复的本地基准会话',
    session: '已恢复本地基准会话；尚未创建外部授权',
    authorization: '已恢复本地会话与有效授权；尚未运行 live preflight',
    execution: '已恢复本地会话、授权、预检与可信执行进度；不会自动执行下一项',
  }
  ElMessage.success(messages[snapshot.state])
}

async function prepareMvpSession() {
  const dramaUid = canvas.activeWorkflow.value?.dramaUid
  const workflowRunUid = canvas.activeRun.value?.run?.uid
  if (!(await mvpSession.prepare(dramaUid, workflowRunUid))) {
    ElMessage.error('本地基准会话准备失败')
    return
  }
  mvpResume.invalidate()
  mvpFinalization.invalidate()
  mvpHumanAvReview.invalidate()
  mvpAccountingStatus.invalidate()
  await mvpAuthorization.refreshConnections()
  ElMessage.success('本地基准会话已冻结；尚未创建外部授权')
}

async function authorizeMvpSession(seed) {
  const session = mvpSession.session.value
  const connection = mvpAuthorization.connections.value.find(
    (candidate) => candidate.uid === seed.connectionUid,
  )
  if (!session || !connection) {
    ElMessage.error('本地授权参数无效')
    return
  }
  const expiresAt = new Date(Date.now() + seed.validityDurationMs).toLocaleString()
  try {
    await ElMessageBox.confirm(
      `确认仅创建本地不可变授权记录？连接：${connection.name}；费用硬上限：¥${(seed.maximumCostCnyFen / 100).toFixed(2)}；预计失效：${expiresAt}。该操作不会访问 SSH、Vault、Provider 或 GPU，也不会创建实例或产生费用。`,
      '确认本地外部授权',
      { type: 'warning', confirmButtonText: '确认创建', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (await mvpAuthorization.authorize(session, seed.connectionUid, seed)) {
    mvpResume.invalidate()
    mvpExecution.invalidate()
    mvpFinalization.invalidate()
    mvpHumanAvReview.invalidate()
    mvpPreflight.invalidate()
    mvpAccountingStatus.invalidate()
    ElMessage.success('本地授权记录已创建；尚未执行预检或任何外部动作')
  } else {
    ElMessage.error('本地授权创建失败')
  }
}

async function preflightMvpSession() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  if (!session || !authorization) {
    ElMessage.error('请先创建有效的本地外部授权记录')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认运行 live preflight？连接：${authorization.connectionUid}；授权费用上限：¥${(authorization.maximumCostCnyFen / 100).toFixed(2)}；授权失效：${new Date(authorization.expiresAtEpochMs).toLocaleString()}。本动作将读取本地 Vault 中该连接的凭据并发起 SSH 环境检查，同时写入本地预检、预约和归还义务证据；不会提交 H3/TTS Provider 作业，不会创建或租用 GPU 实例，也不会产生模型生成费用。`,
      '确认 live 环境预检',
      { type: 'warning', confirmButtonText: '确认预检', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  mvpExecution.invalidate()
  mvpFinalization.invalidate()
  mvpHumanAvReview.invalidate()
  mvpAccountingStatus.invalidate()
  if (await mvpPreflight.preflight(session, authorization)) {
    mvpResume.invalidate()
    ElMessage.success('live preflight 已完成；尚未执行任何生成任务')
  } else {
    ElMessage.error('live preflight 失败')
  }
}

async function executeNextMvpItem() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  const completedCount = mvpExecution.step.value?.completedCount
    ?? mvpExecution.progress.value?.completedCount
    ?? 0
  const reservation = batch?.reservations?.[completedCount]
  if (!session || !authorization || !batch || !reservation
    || mvpExecution.step.value?.batchComplete
    || mvpExecution.progress.value?.batchComplete) {
    ElMessage.error('当前没有可安全确认的下一项')
    return
  }
  let completedEstimateCnyFen = 0
  for (let index = 0; index < completedCount; index += 1) {
    completedEstimateCnyFen += batch.reservations[index].estimatedCostCnyFen
  }
  const remainingCnyFen = Math.max(
    0, authorization.maximumCostCnyFen - completedEstimateCnyFen,
  )
  try {
    await ElMessageBox.confirm(
      `确认执行第 ${completedCount + 1}/${batch.reservations.length} 项？类型：${reservation.itemKind.toUpperCase()}；项目 UID：${reservation.itemUid}；本项预检估算：¥${(reservation.estimatedCostCnyFen / 100).toFixed(2)}；按预检估算的授权剩余额度：¥${(remainingCnyFen / 100).toFixed(2)}。本动作会重新读取本地 Vault 凭据、进行 SSH live environment 检查，并提交恰好一个真实 H3 或 TTS Provider 作业，可能消耗 GPU/API 资源并产生费用。不会自动执行下一项，本项成功也不代表费用已结算或实例已归还。`,
      '确认逐项付费执行',
      { type: 'error', confirmButtonText: '确认执行这一项', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  mvpAccountingStatus.invalidate()
  mvpFinalization.invalidate()
  mvpHumanAvReview.invalidate()
  if (await mvpExecution.executeNext(session, authorization, batch)) {
    mvpResume.invalidate()
    if (mvpExecution.step.value?.batchComplete) {
      ElMessage.success('预检批次项目均已完成；费用结算与实例归还仍待后续验证')
    } else {
      ElMessage.success('本项已取得可信成功回执；下一项不会自动执行')
    }
  } else {
    ElMessage.error('本项执行失败或回执不可信；请刷新可信进度核对持久结果，不会自动重试')
  }
}

async function refreshMvpExecution() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  if (!session || !authorization || !batch) {
    ElMessage.error('请先完成有效的本地授权与 live preflight')
    return
  }
  if (await mvpExecution.refresh(session, authorization, batch)) {
    mvpResume.invalidate()
    mvpAccountingStatus.invalidate()
    ElMessage.success('已从本地持久成功证据重建进度；未提交任务、结算费用或归还实例')
  } else {
    ElMessage.error('可信进度刷新失败；不会自动重试')
  }
}

async function finalizeMvpProduction() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  const bgmTrackUid = bgmLibrary.selectedTrackUid.value
  if (!session || !authorization || !batch || !mvpExecutionBatchComplete.value
    || !bgmTrackUid) {
    ElMessage.error('请先完成全部批次项目并显式选择可导出的本地 BGM')
    return
  }
  try {
    await ElMessageBox.confirm(
      '确认编译并导出当前生产成片？系统会从本地持久成功证据重建镜头和对白时间线，重新校验 BGM 权利与全部本地媒体，执行完整解码和 FFmpeg 1080p 导出，并写入最终成片资产。不会再次访问 SSH、Vault、Provider 或 GPU，不会创建生成任务，也不会自动重试失败导出。',
      '确认本地成片编译',
      { type: 'warning', confirmButtonText: '确认编译并导出', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  mvpHumanAvReview.invalidate()
  if (await mvpFinalization.finalize(session, authorization, batch, bgmTrackUid)) {
    await Promise.allSettled([
      mediaExports.load(),
      canvas.loadRun(session.workflowRunUid),
    ])
    rightTab.value = 'export'
    ElMessage.success('成片时间线已编译，导出结果已完成本地验证')
  } else {
    ElMessage.error('成片编译或导出失败；不会采用部分状态，也不会自动重试')
  }
}

async function refreshMvpHumanAvReview() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  const exportRun = mvpFinalization.run.value
  if (!session || !authorization || !batch || exportRun?.status !== 'succeeded') {
    ElMessage.error('请先恢复或完成当前批次的成功成片导出')
    return
  }
  if (await mvpHumanAvReview.load(session, authorization, batch, exportRun)) {
    ElMessage.success('已读取与当前成片精确绑定的人工验收记录')
  } else {
    ElMessage.error('未找到可信人工验收，或持久证据已经变化')
  }
}

async function reviewMvpProduction(seed) {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  const exportRun = mvpFinalization.run.value
  if (!session || !authorization || !batch || exportRun?.status !== 'succeeded') {
    ElMessage.error('请先完成当前批次的成功成片导出')
    return
  }
  try {
    await ElMessageBox.confirm(
      '确认提交不可变人工音画验收？你确认已经实际完整播放当前成片，并核对字幕同步和 BGM/对白平衡。提交后不能修改；该记录只证明本次人工观看结论，不会自动把 MVP 标记为完成。',
      '确认人工音画验收',
      { type: 'warning', confirmButtonText: '确认提交验收', cancelButtonText: '继续检查' },
    )
  } catch {
    return
  }
  if (await mvpHumanAvReview.submit(session, authorization, batch, exportRun, seed)) {
    ElMessage.success('人工音画验收已与当前成片不可变绑定')
  } else {
    ElMessage.error('人工音画验收提交失败；不会采用部分记录')
  }
}

async function refreshMvpAccountingStatus() {
  const session = mvpSession.session.value
  const authorization = mvpAuthorization.authorization.value
  const batch = mvpPreflight.batch.value
  if (!session || !authorization || !batch) {
    ElMessage.error('请先恢复或完成有效的会话、授权与 live preflight')
    return
  }
  if (await mvpAccountingStatus.load(session, authorization, batch)) {
    const status = mvpAccountingStatus.status.value
    const releaseText = status.releaseState === 'released' ? '已有可信归还回执' : '仍需归还'
    ElMessage.success(
      `已读取本地会计状态：${status.settledCount}/${status.totalCount} 项已结算，${releaseText}；未执行结算或归还`,
    )
  } else {
    ElMessage.error('结算与归还状态读取失败；不会采用部分结果')
  }
}

async function refreshBgmLibrary() {
  const dramaUid = canvas.activeWorkflow.value?.dramaUid
  if (!dramaUid || !(await bgmLibrary.load(dramaUid))) {
    ElMessage.error('本地 BGM 素材库读取失败')
  }
}

async function importBgmTrack(input) {
  const dramaUid = canvas.activeWorkflow.value?.dramaUid
  if (!dramaUid) {
    ElMessage.error('请先选择当前剧集的工作流')
    return
  }
  const rights = input.commercialUseAllowed && input.derivativesAllowed
    ? '已声明允许商业使用和衍生编辑，验证通过后可作为成片候选'
    : '未同时声明商业使用和衍生编辑，将仅导入但不可用于成片'
  try {
    await ElMessageBox.confirm(
      `确认导入本地音频“${input.title}”？${rights}。此为你的权利声明，系统不会将其表述为法律审查结论；本操作只读取该本地文件并执行本机媒体验证，不会联网获取音乐。`,
      '确认 BGM 权利声明',
      { type: 'warning', confirmButtonText: '确认导入', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (await bgmLibrary.importTrack(dramaUid, input)) {
    ElMessage.success('本地 BGM 已完成哈希、容器探测和全解码验证；未自动选择')
  } else {
    ElMessage.error('BGM 导入或本地媒体验证失败')
  }
}

function selectBgmTrack(trackUid) {
  if (bgmLibrary.select(trackUid)) {
    ElMessage.success('已显式选择该 BGM；尚未创建成片导出计划')
  } else {
    ElMessage.error('该曲目权利声明不足，不能作为成片候选')
  }
}

async function startMediaExport(nodeRunUid) {
  if (await mediaExports.start(nodeRunUid)) {
    ElMessage.success('成片导出已完成验证')
  } else {
    ElMessage.error('成片导出失败')
  }
}

async function openRun(runUid) {
  try { await canvas.loadRun(runUid) } catch { /* request layer reports */ }
}

function warnBeforeUnload(event) {
  if (!canvas.dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave(async () => confirmDiscardIfDirty())

watch(
  () => `${canvas.activeRun.value?.run?.uid || ''}:${canvas.activeRun.value?.run?.status || ''}`,
  () => {
    mvpSession.invalidate()
    mvpAuthorization.invalidate()
    mvpPreflight.invalidate()
    mvpExecution.invalidate()
    mvpFinalization.invalidate()
    mvpHumanAvReview.invalidate()
    mvpResume.invalidate()
    mvpAccountingStatus.invalidate()
  },
)

onMounted(async () => {
  if (!Number.isSafeInteger(dramaId) || dramaId < 1) {
    router.replace('/')
    return
  }
  const [dramaResult] = await Promise.allSettled([
    dramaAPI.get(dramaId), canvas.load(), mediaExports.load(), mvpReadiness.load(),
  ])
  if (dramaResult.status === 'fulfilled') drama.value = dramaResult.value
  window.addEventListener('beforeunload', warnBeforeUnload)
})

onBeforeUnmount(() => {
  mediaExports.invalidate()
  bgmLibrary.invalidate()
  mvpReadiness.invalidate()
  mvpAuthorization.invalidate()
  mvpPreflight.invalidate()
  mvpExecution.invalidate()
  mvpFinalization.invalidate()
  mvpHumanAvReview.invalidate()
  mvpResume.invalidate()
  mvpAccountingStatus.invalidate()
  mvpSession.invalidate()
  window.removeEventListener('beforeunload', warnBeforeUnload)
})
</script>

<style scoped>
.workflow-canvas-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: #0d0d11; color: #e4e4e7; }
.page-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 18px; border-bottom: 1px solid #2f2f37; background: linear-gradient(120deg, #18181d, #111117); }
.identity { display: flex; align-items: center; gap: 16px; }
.identity > div { display: flex; flex-direction: column; gap: 2px; }
.identity strong { max-width: 280px; overflow: hidden; text-overflow: ellipsis; color: #fafafa; font-size: 15px; white-space: nowrap; }
.identity span { color: #818cf8; font-size: 10px; }
.back-link { padding: 0; border: 0; background: none; color: #a5b4fc; cursor: pointer; font-size: 11px; }
.workflow-switcher { display: flex; align-items: center; gap: 8px; }
.theme-button { width: 34px; padding: 0; }
.error-banner { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid rgba(239,68,68,.24); background: rgba(127,29,29,.18); color: #fca5a5; font-size: 11px; }
.error-banner strong { font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
.error-banner small { margin-left: auto; color: #fcd34d; }
.canvas-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 230px minmax(0, 1fr) 310px; }
.flow-stage { min-width: 0; position: relative; }
.workflow-flow { width: 100%; height: 100%; background: radial-gradient(circle at 50% 40%, #171720, #0c0c10 70%); }
.right-panel { min-height: 0; overflow-y: auto; border-left: 1px solid #2f2f37; background: #151519; }
.right-panel :deep(.el-tabs__header) { margin: 0; padding: 0 12px; position: sticky; top: 0; z-index: 2; background: #151519; }
.empty-workflow { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; text-align: center; }
.empty-icon { width: 62px; height: 62px; display: grid; place-items: center; border: 1px solid #3f3f46; border-radius: 18px; background: #18181d; color: #818cf8; font-size: 28px; }
.empty-workflow h2 { margin: 18px 0 8px; color: #fafafa; font-size: 20px; }
.empty-workflow p { max-width: 470px; margin: 0 0 18px; color: #71717a; font-size: 12px; line-height: 1.65; }
:deep(.vue-flow__minimap) { border: 1px solid #3f3f46; background: rgba(24,24,27,.92); }
:deep(.vue-flow__controls) { border: 1px solid #3f3f46; box-shadow: none; }
:deep(.vue-flow__controls button) { border-color: #3f3f46; background: #18181b; color: #e4e4e7; }
:deep(.vue-flow__edge.selected .vue-flow__edge-path) { stroke: #f59e0b; stroke-width: 3; }
@media (max-width: 1050px) { .canvas-shell { grid-template-columns: 190px minmax(0, 1fr); } .right-panel { position: absolute; right: 0; bottom: 0; top: 114px; width: 300px; z-index: 4; box-shadow: -8px 0 24px rgba(0,0,0,.35); } .workflow-switcher .el-tag { display: none; } }
</style>
