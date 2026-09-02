<template>
  <section class="mvp-authorization-panel">
    <header>
      <div>
        <strong>本地外部授权</strong>
        <small>显式冻结单次基准会话的连接、费用上限与有效期</small>
      </div>
      <el-button size="small" :loading="busy" :disabled="!canAuthorize" @click="submit">
        创建本地授权记录
      </el-button>
    </header>

    <p class="safety-note">仅写入本地不可变授权记录；不会执行预检，不会访问 SSH、Vault、Provider 或 GPU，不会创建实例或产生费用。</p>
    <p v-if="error" class="error-message">授权创建失败；连接、会话或当前来源发生漂移时不会留下部分记录。</p>
    <p v-else-if="!session" class="empty-message">请先准备本地基准会话。</p>
    <p v-else-if="!authorization && connections.length === 0" class="empty-message">没有已确认凭据且状态为 ready 的远程连接。</p>

    <el-form v-if="session && !authorization" label-position="top" size="small">
      <el-form-item label="远程连接">
        <el-select v-model="connectionUid" placeholder="请选择 ready 连接" style="width: 100%">
          <el-option
            v-for="connection in connections"
            :key="connection.uid"
            :label="`${connection.name} · ${connection.uid}`"
            :value="connection.uid"
          />
        </el-select>
      </el-form-item>
      <div class="limits">
        <el-form-item label="费用上限（分）">
          <el-input-number v-model="maximumCostCnyFen" :min="1" :max="1000000" :step="1" />
        </el-form-item>
        <el-form-item label="有效期（分钟）">
          <el-input-number v-model="validityMinutes" :min="1" :max="1440" :step="1" />
        </el-form-item>
      </div>
    </el-form>

    <dl v-if="authorization" class="authorization-receipt">
      <dt>授权</dt><dd>{{ authorization.uid }}</dd>
      <dt>连接</dt><dd>{{ authorization.connectionUid }}</dd>
      <dt>费用上限</dt><dd>¥{{ (authorization.maximumCostCnyFen / 100).toFixed(2) }}</dd>
      <dt>失效时间</dt><dd>{{ new Date(authorization.expiresAtEpochMs).toLocaleString() }}</dd>
    </dl>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  session: { type: Object, default: null },
  authorization: { type: Object, default: null },
  connections: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['authorize'])
const connectionUid = ref('')
const maximumCostCnyFen = ref(null)
const validityMinutes = ref(null)

const canAuthorize = computed(() => (
  Boolean(props.session)
  && !props.authorization
  && !props.busy
  && props.connections.some((connection) => connection.uid === connectionUid.value)
  && Number.isSafeInteger(maximumCostCnyFen.value)
  && maximumCostCnyFen.value >= 1
  && maximumCostCnyFen.value <= 1_000_000
  && Number.isSafeInteger(validityMinutes.value)
  && validityMinutes.value >= 1
  && validityMinutes.value <= 1440
))

function submit() {
  if (!canAuthorize.value) return
  emit('authorize', {
    connectionUid: connectionUid.value,
    maximumCostCnyFen: maximumCostCnyFen.value,
    validityDurationMs: validityMinutes.value * 60_000,
  })
}
</script>

<style scoped>
.mvp-authorization-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.safety-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(30, 58, 138, .16); color: #a5b4fc; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.limits { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.authorization-receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; margin: 0; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.authorization-receipt dt { color: #71717a; font-size: 9px; }
.authorization-receipt dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 9px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
