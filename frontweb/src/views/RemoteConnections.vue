<template>
  <div class="remote-page">
    <header class="remote-header">
      <div>
        <button class="back-link" type="button" @click="router.push('/')">← 返回项目列表</button>
        <h1>远程算力连接</h1>
        <p>凭据只写入 Windows 凭据管理器；数据库、日志和项目导出只保存不透明引用。</p>
      </div>
      <el-button type="primary" @click="openCreate">新增连接</el-button>
    </header>

    <main class="remote-main" v-loading="loading">
      <el-alert
        title="安全模式：ComfyUI 必须监听远端 127.0.0.1，并通过本地 SSH 隧道访问。首次连接还需确认主机指纹。"
        type="info"
        :closable="false"
        show-icon
      />

      <section v-if="connections.length" class="connection-grid">
        <article v-for="item in connections" :key="item.uid" class="connection-card">
          <div class="card-title">
            <div><h2>{{ item.name }}</h2><p>{{ item.username }}@{{ item.host }}:{{ item.port }}</p></div>
            <el-tag :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag>
          </div>
          <dl>
            <div><dt>凭据</dt><dd>{{ item.credentialConfigured ? '已配置' : '未配置' }}</dd></div>
            <div><dt>主机指纹</dt><dd>{{ item.hostFingerprint ? '已确认' : '待确认' }}</dd></div>
            <div><dt>ComfyUI</dt><dd>{{ item.comfyHost }}:{{ item.comfyPort }}</dd></div>
            <div><dt>远程目录</dt><dd>{{ item.remoteWorkDir }}</dd></div>
          </dl>
          <div class="card-actions">
            <el-button @click="openEdit(item)">编辑配置</el-button>
            <el-button @click="openCredential(item)">更新凭据</el-button>
            <el-button :loading="probingUid === item.uid" @click="probeHostIdentity(item)">验证主机</el-button>
          </div>
          <div class="remote-tools">
            <RemoteEnvironmentPanel
              :available="item.status === 'ready'"
              :report="environmentReportFor(item.uid)"
              :plan="initializationPlanFor(item.uid)"
              :checking="checkingEnvironmentUid === item.uid"
              :initializing="initializingEnvironmentUid === item.uid"
              :installing-models="installingModelsUid === item.uid"
              @check="checkEnvironment(item)"
              @initialize="initializeEnvironment(item, $event)"
              @install-models="installEnvironmentModels(item, $event)"
            />
            <RemoteExpertMode
              :connection-uid="item.uid"
              :connection-status="item.status"
              :tunnel="expertTunnelFor(item.uid)"
              :loading="openingExpertTunnelUid === item.uid"
              @start="openExpertTunnel"
              @stop="closeExpertTunnel"
            />
          </div>
        </article>
      </section>
      <el-empty v-else-if="!loading" description="尚未配置远程算力连接">
        <el-button type="primary" @click="openCreate">新增连接</el-button>
      </el-empty>
    </main>

    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑远程连接' : '新增远程连接'"
      width="min(560px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @closed="resetForm"
    >
      <el-form label-position="top" :model="form">
        <el-form-item label="连接名称" required><el-input v-model="form.name" maxlength="120" /></el-form-item>
        <div class="form-row">
          <el-form-item label="SSH 主机" required><el-input v-model="form.host" placeholder="workspace.example.invalid" /></el-form-item>
          <el-form-item label="端口" required><el-input-number v-model="form.port" :min="1" :max="65535" /></el-form-item>
        </div>
        <el-form-item label="用户名" required><el-input v-model="form.username" autocomplete="username" /></el-form-item>
        <el-form-item v-if="!editing" label="SSH 密码" required>
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="提交后只保存到 Windows 凭据管理器"
          />
        </el-form-item>
        <el-alert v-else title="凭据已配置；编辑连接不会读取或回填密码。" type="success" :closable="false" />
        <div class="form-row">
          <el-form-item label="远端 ComfyUI"><el-input model-value="127.0.0.1" disabled /></el-form-item>
          <el-form-item label="ComfyUI 端口"><el-input-number v-model="form.comfyPort" :min="1" :max="65535" /></el-form-item>
        </div>
        <el-form-item label="远程工作目录" required>
          <el-input v-model="form.remoteWorkDir" placeholder="ai-drama-studio" />
          <small>只能填写相对目录，任务将放在该目录的 jobs 子目录中。</small>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="credentialDialogVisible"
      title="更新 SSH 凭据"
      width="min(480px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @closed="resetCredentialForm"
    >
      <p>系统不会读取旧密码；新密码写入 Windows 凭据管理器后，将移除旧凭据。</p>
      <el-form label-position="top">
        <el-form-item label="新 SSH 密码" required>
          <el-input
            v-model="credentialPassword"
            type="password"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="credentialSaving" @click="saveCredential">更新凭据</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="hostIdentityDialogVisible"
      title="确认 SSH 主机指纹"
      width="min(560px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      @closed="hostIdentityCandidate = null"
    >
      <el-alert
        title="请将下方指纹与算力平台实例页面显示的 SSH 指纹逐字核对。只有完全一致时才能确认。"
        type="warning"
        :closable="false"
        show-icon
      />
      <dl v-if="hostIdentityCandidate" class="fingerprint-detail">
        <div><dt>密钥算法</dt><dd>{{ hostIdentityCandidate.algorithm }}</dd></div>
        <div><dt>SHA-256 指纹</dt><dd><code>{{ hostIdentityCandidate.fingerprint }}</code></dd></div>
      </dl>
      <template #footer>
        <el-button @click="hostIdentityDialogVisible = false">暂不确认</el-button>
        <el-button type="primary" :loading="confirmingHostIdentity" @click="confirmHostIdentity">
          指纹一致，确认信任
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import { remoteConnectionAPI } from '@/api/v2/remoteConnections.js'
import RemoteEnvironmentPanel from '@/components/remote/RemoteEnvironmentPanel.vue'
import RemoteExpertMode from '@/components/remote/RemoteExpertMode.vue'
import { remoteConnectionListView, remoteConnectionView } from '@/remote/connectionProfile.js'

const router = useRouter()
const connections = ref([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editing = ref(null)
const credentialDialogVisible = ref(false)
const credentialSaving = ref(false)
const credentialConnection = ref(null)
const credentialPassword = ref('')
const probingUid = ref(null)
const hostIdentityDialogVisible = ref(false)
const hostIdentityCandidate = ref(null)
const confirmingHostIdentity = ref(false)
const environmentReports = ref(new Map())
const initializationPlans = ref(new Map())
const expertTunnels = ref(new Map())
const checkingEnvironmentUid = ref(null)
const initializingEnvironmentUid = ref(null)
const installingModelsUid = ref(null)
const openingExpertTunnelUid = ref(null)
const form = reactive({
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  comfyPort: 8188,
  remoteWorkDir: 'ai-drama-studio',
})

function resetForm() {
  editing.value = null
  Object.assign(form, {
    name: '', host: '', port: 22, username: '', password: '',
    comfyPort: 8188, remoteWorkDir: 'ai-drama-studio',
  })
}

function openCreate() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(item) {
  editing.value = remoteConnectionView(item)
  Object.assign(form, {
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    password: '',
    comfyPort: item.comfyPort,
    remoteWorkDir: item.remoteWorkDir,
  })
  dialogVisible.value = true
}

function resetCredentialForm() {
  credentialConnection.value = null
  credentialPassword.value = ''
}

function openCredential(item) {
  credentialConnection.value = remoteConnectionView(item)
  credentialPassword.value = ''
  credentialDialogVisible.value = true
}

function replaceMapValue(target, uid, value) {
  const next = new Map(target.value)
  if (value === null) next.delete(uid)
  else next.set(uid, value)
  target.value = next
}

function clearRuntimeState() {
  environmentReports.value = new Map()
  initializationPlans.value = new Map()
  expertTunnels.value = new Map()
  checkingEnvironmentUid.value = null
  initializingEnvironmentUid.value = null
  installingModelsUid.value = null
  openingExpertTunnelUid.value = null
}

function environmentReportFor(uid) {
  return environmentReports.value.get(uid) || null
}

function initializationPlanFor(uid) {
  return initializationPlans.value.get(uid) || null
}

function expertTunnelFor(uid) {
  return expertTunnels.value.get(uid) || null
}

async function load() {
  loading.value = true
  await closeAllExpertTunnels()
  clearRuntimeState()
  try {
    connections.value = remoteConnectionListView(await remoteConnectionAPI.list())
  } catch {
    connections.value = []
    ElMessage.error('远程连接列表加载失败')
  } finally {
    loading.value = false
  }
}

async function checkEnvironment(item) {
  if (item.status !== 'ready' || checkingEnvironmentUid.value) return
  checkingEnvironmentUid.value = item.uid
  try {
    const [report, plan] = await Promise.all([
      remoteConnectionAPI.getEnvironmentReport(item.uid),
      remoteConnectionAPI.getInitializationPlan(item.uid),
    ])
    replaceMapValue(environmentReports, item.uid, report)
    replaceMapValue(initializationPlans, item.uid, plan)
    ElMessage.success(report.ready ? '远程环境检查通过' : '远程环境需要初始化或修复')
  } catch {
    replaceMapValue(environmentReports, item.uid, null)
    replaceMapValue(initializationPlans, item.uid, null)
    ElMessage.error('远程环境检查失败，请确认连接和远端服务状态')
  } finally {
    checkingEnvironmentUid.value = null
  }
}

async function initializeEnvironment(item, plan) {
  if (item.status !== 'ready' || initializingEnvironmentUid.value) return
  initializingEnvironmentUid.value = item.uid
  try {
    const result = await remoteConnectionAPI.initializeEnvironment(item.uid, plan)
    replaceMapValue(environmentReports, item.uid, result.report)
    ElMessage.success('固定版本环境初始化完成')
  } catch {
    ElMessage.error('环境初始化失败；系统未执行请求方提供的命令')
  } finally {
    initializingEnvironmentUid.value = null
  }
}

async function installEnvironmentModels(item, plan) {
  if (item.status !== 'ready' || installingModelsUid.value) return
  installingModelsUid.value = item.uid
  try {
    await remoteConnectionAPI.installEnvironmentModels(item.uid, plan)
    ElMessage.success('已完成本次确认的大型模型安装计划')
  } catch {
    ElMessage.error('大型模型安装失败，请检查许可证、磁盘和远端状态')
  } finally {
    installingModelsUid.value = null
  }
}

async function openExpertTunnel(connectionUid) {
  if (openingExpertTunnelUid.value) return
  openingExpertTunnelUid.value = connectionUid
  try {
    const tunnel = await remoteConnectionAPI.openExpertTunnel(connectionUid)
    replaceMapValue(expertTunnels, connectionUid, tunnel)
    ElMessage.success('专家模式隧道已就绪，请点击本地链接打开')
  } catch {
    replaceMapValue(expertTunnels, connectionUid, null)
    ElMessage.error('专家模式隧道建立失败，请重新验证连接')
  } finally {
    openingExpertTunnelUid.value = null
  }
}

async function closeExpertTunnel(connectionUid) {
  if (openingExpertTunnelUid.value) return
  openingExpertTunnelUid.value = connectionUid
  try {
    await remoteConnectionAPI.closeExpertTunnel(connectionUid)
    replaceMapValue(expertTunnels, connectionUid, null)
    ElMessage.success('专家模式隧道已关闭')
  } catch {
    replaceMapValue(expertTunnels, connectionUid, null)
    ElMessage.error('隧道关闭状态不确定；再次启动前系统会先重试清理')
  } finally {
    openingExpertTunnelUid.value = null
  }
}

async function closeAllExpertTunnels() {
  const connectionUids = [...new Set([
    ...expertTunnels.value.keys(),
    openingExpertTunnelUid.value,
  ].filter(Boolean))]
  expertTunnels.value = new Map()
  await Promise.allSettled(connectionUids.map((uid) => remoteConnectionAPI.closeExpertTunnel(uid)))
}

async function save() {
  saving.value = true
  const wasEditing = Boolean(editing.value)
  try {
    if (editing.value) await remoteConnectionAPI.update(editing.value, form)
    else await remoteConnectionAPI.create(form)
    form.password = ''
    dialogVisible.value = false
    ElMessage.success(wasEditing ? '连接配置已更新' : '远程连接已创建')
    await load()
  } catch {
    form.password = ''
    ElMessage.error('连接配置保存失败，请检查字段后重试')
  } finally {
    saving.value = false
  }
}

async function saveCredential() {
  credentialSaving.value = true
  try {
    await remoteConnectionAPI.replaceCredential(credentialConnection.value, credentialPassword.value)
    credentialPassword.value = ''
    credentialDialogVisible.value = false
    ElMessage.success('SSH 凭据已更新')
    await load()
  } catch {
    credentialPassword.value = ''
    ElMessage.error('SSH 凭据更新失败，请重试')
  } finally {
    credentialSaving.value = false
  }
}

async function probeHostIdentity(item) {
  probingUid.value = item.uid
  try {
    const candidate = await remoteConnectionAPI.probeHostIdentity(item.uid)
    if (candidate.requiresConfirmation) {
      hostIdentityCandidate.value = candidate
      hostIdentityDialogVisible.value = true
    } else {
      ElMessage.success('SSH 主机指纹与已确认记录一致')
    }
    await load()
  } catch (error) {
    await load()
    const code = error?.response?.data?.error?.code
    if (code === 'REMOTE_HOST_FINGERPRINT_CHANGED') {
      ElMessage.error('主机指纹已变化，连接已阻断；请核对实例身份')
    } else {
      ElMessage.error('主机指纹探测失败，请确认实例在线和连接配置正确')
    }
  } finally {
    probingUid.value = null
  }
}

async function confirmHostIdentity() {
  if (!hostIdentityCandidate.value) return
  confirmingHostIdentity.value = true
  try {
    await remoteConnectionAPI.confirmHostIdentity(hostIdentityCandidate.value)
    hostIdentityDialogVisible.value = false
    ElMessage.success('SSH 主机指纹已确认')
    await load()
  } catch {
    ElMessage.error('确认失败：远端指纹或连接状态已发生变化')
    await load()
  } finally {
    confirmingHostIdentity.value = false
  }
}

function statusLabel(status) {
  return ({ unverified: '待验证', ready: '可用', changed: '指纹变化', disabled: '已停用', error: '异常' })[status] || '未知'
}

function statusType(status) {
  return ({ ready: 'success', changed: 'danger', error: 'danger', disabled: 'info' })[status] || 'warning'
}

onMounted(load)
onBeforeUnmount(() => { void closeAllExpertTunnels() })
</script>

<style scoped>
.remote-page { min-height: 100vh; background: var(--el-bg-color-page); color: var(--el-text-color-primary); }
.remote-header { display: flex; justify-content: space-between; gap: 24px; align-items: end; padding: 28px 40px; border-bottom: 1px solid var(--el-border-color-light); background: var(--el-bg-color); }
.remote-header h1 { margin: 10px 0 6px; font-size: 28px; }
.remote-header p { margin: 0; color: var(--el-text-color-secondary); }
.back-link { border: 0; padding: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.remote-main { padding: 28px 40px; }
.connection-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; margin-top: 22px; }
.connection-card { padding: 20px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.card-title { display: flex; justify-content: space-between; gap: 16px; }
.card-title h2 { margin: 0 0 6px; font-size: 19px; }
.card-title p { margin: 0; color: var(--el-text-color-secondary); }
dl { display: grid; gap: 10px; margin: 20px 0; }
dl div { display: flex; justify-content: space-between; gap: 16px; }
dt { color: var(--el-text-color-secondary); }
dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.card-actions { display: flex; gap: 10px; }
.remote-tools { display: grid; gap: 14px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--el-border-color-lighter); }
.form-row { display: grid; grid-template-columns: 1fr 180px; gap: 16px; }
small { display: block; margin-top: 6px; color: var(--el-text-color-secondary); }
.fingerprint-detail { margin-top: 20px; }
.fingerprint-detail code { font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .remote-header { align-items: stretch; flex-direction: column; padding: 22px; }
  .remote-main { padding: 20px; }
  .connection-grid, .form-row { grid-template-columns: 1fr; }
}
</style>
