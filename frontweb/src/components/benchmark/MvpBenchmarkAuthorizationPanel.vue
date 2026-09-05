<template>
  <section class="mvp-authorization-panel">
    <header>
      <div>
        <strong>本地外部授权</strong>
        <small>显式冻结单次基准会话的连接、费用上限、有效期与操作者声明</small>
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
      <fieldset class="attestation-block">
        <legend>MiniMax H3 操作者自我声明</legend>
        <p>这是付费执行前的自我声明，不是平台或本项目提供的法律审查；所有项目默认不选。</p>
        <p>当前固定许可版本的适用地域不包括欧盟、英国、韩国和美国；如果实际使用涉及这些地域，不要确认并继续。</p>
        <el-form-item label="商业使用资格依据">
          <el-radio-group v-model="commercialEligibilityBasis">
            <el-radio value="annual-revenue-not-over-usd-20000000">
              年商业营收不超过 2,000 万美元
            </el-radio>
            <el-radio value="written-minimax-authorization">
              已取得 MiniMax 书面授权
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <div class="attestation-checks">
          <el-checkbox v-model="territoryEligibilityConfirmed">
            我确认本次实际使用不发生在欧盟、英国、韩国或美国
          </el-checkbox>
          <el-checkbox v-model="commercialUiAttributionAccepted">
            我接受在商业界面保留醒目的 “Powered by MiniMax H3” 署名
          </el-checkbox>
          <el-checkbox v-model="acceptableUseAndSafeguardsAccepted">
            我接受遵守适用使用政策并维持必要的安全措施
          </el-checkbox>
          <el-checkbox v-model="downstreamUseRestrictionsAccepted">
            我接受将适用限制传递给下游用户
          </el-checkbox>
          <el-checkbox v-model="publicAiContentDisclosureAccepted">
            我接受对公开发布内容作必要的 AI 生成披露
          </el-checkbox>
          <el-checkbox v-model="benchmarkInputRightsConfirmed">
            我确认本次基准输入、素材和 BGM 具备必要使用权
          </el-checkbox>
        </div>
      </fieldset>
    </el-form>

    <dl v-if="authorization" class="authorization-receipt">
      <dt>授权</dt><dd>{{ authorization.uid }}</dd>
      <dt>连接</dt><dd>{{ authorization.connectionUid }}</dd>
      <dt>费用上限</dt><dd>¥{{ (authorization.maximumCostCnyFen / 100).toFixed(2) }}</dd>
      <dt>失效时间</dt><dd>{{ new Date(authorization.expiresAtEpochMs).toLocaleString() }}</dd>
      <dt>操作者声明</dt><dd>已作为不可变授权请求封存</dd>
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
const commercialEligibilityBasis = ref('')
const territoryEligibilityConfirmed = ref(false)
const commercialUiAttributionAccepted = ref(false)
const acceptableUseAndSafeguardsAccepted = ref(false)
const downstreamUseRestrictionsAccepted = ref(false)
const publicAiContentDisclosureAccepted = ref(false)
const benchmarkInputRightsConfirmed = ref(false)

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
  && [
    'annual-revenue-not-over-usd-20000000',
    'written-minimax-authorization',
  ].includes(commercialEligibilityBasis.value)
  && territoryEligibilityConfirmed.value
  && commercialUiAttributionAccepted.value
  && acceptableUseAndSafeguardsAccepted.value
  && downstreamUseRestrictionsAccepted.value
  && publicAiContentDisclosureAccepted.value
  && benchmarkInputRightsConfirmed.value
))

function submit() {
  if (!canAuthorize.value) return
  emit('authorize', {
    connectionUid: connectionUid.value,
    maximumCostCnyFen: maximumCostCnyFen.value,
    validityDurationMs: validityMinutes.value * 60_000,
    operatorAttestation: {
      schemaVersion: 'mvp-benchmark-operator-attestation-seed.v1',
      territoryEligibilityConfirmed: territoryEligibilityConfirmed.value,
      commercialEligibilityBasis: commercialEligibilityBasis.value,
      commercialUiAttributionAccepted: commercialUiAttributionAccepted.value,
      acceptableUseAndSafeguardsAccepted: acceptableUseAndSafeguardsAccepted.value,
      downstreamUseRestrictionsAccepted: downstreamUseRestrictionsAccepted.value,
      publicAiContentDisclosureAccepted: publicAiContentDisclosureAccepted.value,
      benchmarkInputRightsConfirmed: benchmarkInputRightsConfirmed.value,
    },
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
.attestation-block { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 10px; border: 1px solid #3f3f46; border-radius: 8px; }
.attestation-block legend { padding: 0 5px; color: #f4f4f5; font-size: 11px; font-weight: 700; }
.attestation-block p { margin: 0; color: #fbbf24; font-size: 10px; line-height: 1.55; }
.attestation-checks { display: grid; gap: 7px; }
.attestation-checks :deep(.el-checkbox), .attestation-block :deep(.el-radio) { height: auto; margin-right: 0; white-space: normal; }
.attestation-checks :deep(.el-checkbox__label), .attestation-block :deep(.el-radio__label) { color: #d4d4d8; font-size: 10px; line-height: 1.45; white-space: normal; }
.attestation-block :deep(.el-radio-group) { display: grid; gap: 7px; }
.authorization-receipt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 8px; margin: 0; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.authorization-receipt dt { color: #71717a; font-size: 9px; }
.authorization-receipt dd { overflow: hidden; margin: 0; color: #d4d4d8; font: 9px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
