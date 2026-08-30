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
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
import { useMediaExports } from '@/composables/useMediaExports'
import { useTheme } from '@/composables/useTheme'
import { useWorkflowCanvas } from '@/composables/useWorkflowCanvas'

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)
const { isDark, toggle: toggleTheme } = useTheme()
const canvas = useWorkflowCanvas({ dramaId })
const mediaExports = useMediaExports({ dramaId })

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

onMounted(async () => {
  if (!Number.isSafeInteger(dramaId) || dramaId < 1) {
    router.replace('/')
    return
  }
  const [dramaResult] = await Promise.allSettled([
    dramaAPI.get(dramaId), canvas.load(), mediaExports.load(),
  ])
  if (dramaResult.status === 'fulfilled') drama.value = dramaResult.value
  window.addEventListener('beforeunload', warnBeforeUnload)
})

onBeforeUnmount(() => {
  mediaExports.invalidate()
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
