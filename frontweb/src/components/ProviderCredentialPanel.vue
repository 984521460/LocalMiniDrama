<template>
  <section class="provider-credential-panel" aria-labelledby="provider-credential-title">
    <div class="panel-heading">
      <div>
        <h2 id="provider-credential-title">Provider 凭据</h2>
        <p>秘密只写入本机 Windows 凭据管理器；项目数据库和页面响应只保留不透明引用。</p>
      </div>
      <el-tag type="success" effect="plain">本机安全存储</el-tag>
    </div>

    <el-alert
      v-if="message"
      :title="message"
      :type="messageType"
      :closable="false"
      show-icon
      class="status-message"
    />

    <el-form label-position="top" @submit.prevent>
      <div class="form-grid">
        <el-form-item label="凭据类型">
          <el-select v-model="kind" :disabled="busy">
            <el-option label="API Key" value="api_key" />
            <el-option label="Provider Token" value="provider_token" />
          </el-select>
        </el-form-item>
        <el-form-item label="秘密值">
          <el-input
            v-model="secret"
            type="password"
            autocomplete="new-password"
            show-password
            :disabled="busy"
            placeholder="仅在保存请求中发送一次"
          />
        </el-form-item>
      </div>
      <el-button type="primary" :loading="busy" :disabled="secret.length === 0" @click="store">
        安全保存
      </el-button>
    </el-form>

    <el-divider />

    <el-form label-position="top" @submit.prevent>
      <el-form-item label="凭据引用">
        <el-input
          v-model="credentialRef"
          :disabled="busy"
          spellcheck="false"
          placeholder="credential:v1:…"
        />
      </el-form-item>
      <div class="actions">
        <el-button :loading="busy" :disabled="credentialRef.length === 0" @click="inspect">
          检查状态
        </el-button>
        <el-button
          type="danger"
          plain
          :loading="busy"
          :disabled="credentialRef.length === 0"
          @click="requestRemove"
        >
          {{ removeArmed ? '确认移除' : '从凭据库移除' }}
        </el-button>
        <el-button v-if="removeArmed" :disabled="busy" @click="cancelRemove">取消</el-button>
      </div>
    </el-form>

    <dl v-if="current" class="credential-summary">
      <div><dt>状态</dt><dd>{{ current.configured ? '已配置' : '未配置' }}</dd></div>
      <div><dt>类型</dt><dd>{{ kindLabel(current.kind) }}</dd></div>
      <div><dt>引用</dt><dd><code>{{ current.ref }}</code></dd></div>
    </dl>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import {
  cleanupRequiredFromError,
  providerCredentialAPI,
} from '@/api/v2/providerCredentials.js'

const busy = ref(false)
const credentialRef = ref('')
const current = ref(null)
const kind = ref('api_key')
const message = ref('')
const messageType = ref('success')
const removeArmed = ref(false)
const secret = ref('')

function kindLabel(value) {
  return value === 'provider_token' ? 'Provider Token' : 'API Key'
}

function showError() {
  messageType.value = 'error'
  message.value = '凭据操作失败；秘密未在页面中保留。'
}

async function store() {
  busy.value = true
  message.value = ''
  try {
    const saved = await providerCredentialAPI.store({ kind: kind.value, secret: secret.value })
    current.value = saved
    credentialRef.value = saved.ref
    messageType.value = 'success'
    message.value = '凭据已安全保存。请在音色配置中使用此引用。'
  } catch (error) {
    current.value = null
    const cleanup = cleanupRequiredFromError(error)
    if (cleanup) {
      credentialRef.value = cleanup.ref
      messageType.value = 'warning'
      message.value = '凭据存储结果无法确认。请检查此引用；如存在，请移除后再保存。'
    } else {
      showError()
    }
  } finally {
    secret.value = ''
    busy.value = false
  }
}

async function inspect() {
  removeArmed.value = false
  busy.value = true
  message.value = ''
  try {
    current.value = await providerCredentialAPI.inspect(credentialRef.value)
    kind.value = current.value.kind
    messageType.value = 'success'
    message.value = '凭据引用有效。'
  } catch {
    current.value = null
    showError()
  } finally {
    busy.value = false
  }
}

function cancelRemove() {
  removeArmed.value = false
  message.value = ''
}

async function requestRemove() {
  if (!removeArmed.value) {
    removeArmed.value = true
    messageType.value = 'warning'
    message.value = '再次点击“确认移除”才会删除本机凭据；已有音色配置随后将无法执行。'
    return
  }
  busy.value = true
  message.value = ''
  try {
    await providerCredentialAPI.remove(credentialRef.value)
    current.value = null
    credentialRef.value = ''
    messageType.value = 'success'
    message.value = '凭据已从本机凭据库移除。'
  } catch {
    showError()
  } finally {
    removeArmed.value = false
    busy.value = false
  }
}
</script>

<style scoped>
.provider-credential-panel {
  padding: 20px;
  margin-bottom: 24px;
  border: 1px solid rgba(139, 92, 246, 0.28);
  border-radius: 14px;
  background: rgba(15, 15, 18, 0.48);
}
.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.panel-heading h2 { margin: 0 0 6px; font-size: 18px; color: #f4f4f5; }
.panel-heading p { margin: 0; color: #a1a1aa; line-height: 1.6; }
.form-grid { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; }
.status-message { margin-bottom: 16px; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
.credential-summary { margin: 18px 0 0; display: grid; gap: 8px; }
.credential-summary div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; }
.credential-summary dt { color: #71717a; }
.credential-summary dd { margin: 0; color: #d4d4d8; min-width: 0; }
.credential-summary code { overflow-wrap: anywhere; }
html.light .provider-credential-panel { background: rgba(250, 250, 255, 0.8); }
html.light .panel-heading h2 { color: #27272a; }
html.light .panel-heading p,
html.light .credential-summary dd { color: #52525b; }
@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; gap: 0; }
  .panel-heading { flex-direction: column; }
}
</style>
