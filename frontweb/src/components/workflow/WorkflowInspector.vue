<template>
  <section class="workflow-inspector">
    <header><strong>检查器</strong><small>配置只在保存时提交</small></header>
    <template v-if="node">
      <div class="node-heading">
        <span>{{ node.data.title }}</span>
        <code>{{ node.data.nodeType }}</code>
      </div>
      <el-form label-position="top" size="small">
        <el-form-item label="节点状态">
          <el-select v-model="draft.status" style="width: 100%">
            <el-option label="停用（允许未连接）" value="disabled" />
            <el-option label="草稿" value="draft" />
            <el-option label="就绪" value="ready" />
          </el-select>
        </el-form-item>
        <el-form-item label="领域引用类型">
          <el-input v-model="draft.domainType" placeholder="例如 source_selection" clearable />
        </el-form-item>
        <el-form-item label="领域引用 UID">
          <el-input v-model="draft.domainUid" placeholder="UUID v4；与类型同时填写" clearable />
        </el-form-item>
        <el-form-item label="节点配置 JSON">
          <el-input v-model="draft.configText" type="textarea" :rows="7" spellcheck="false" />
        </el-form-item>
      </el-form>
      <div class="inspector-actions">
        <el-button size="small" type="primary" @click="apply">应用到画布</el-button>
        <el-button size="small" type="danger" plain @click="$emit('delete')">删除节点</el-button>
      </div>
      <div class="port-list">
        <div><strong>输入</strong><span v-for="port in node.data.definition.inputs" :key="port.id">{{ port.id }} · {{ port.valueType }}<em v-if="port.required">必填</em></span></div>
        <div><strong>输出</strong><span v-for="port in node.data.definition.outputs" :key="port.id">{{ port.id }} · {{ port.valueType }}</span></div>
      </div>
    </template>
    <template v-else-if="edgeCount">
      <p class="selection-tip">已选择 {{ edgeCount }} 条连接。</p>
      <el-button size="small" type="danger" plain @click="$emit('delete')">删除连接</el-button>
    </template>
    <p v-else class="selection-tip">选择一个节点编辑状态、领域引用与配置；选择连接可删除。画布操作不会删除角色、分镜或素材实体。</p>
  </section>
</template>

<script setup>
import { reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  node: { type: Object, default: null },
  edgeCount: { type: Number, default: 0 },
})

const emit = defineEmits(['apply', 'delete'])

const draft = reactive({
  status: 'disabled',
  domainType: '',
  domainUid: '',
  configText: '{}',
})

watch(() => props.node, (node) => {
  draft.status = node?.data?.status || 'disabled'
  draft.domainType = node?.data?.domainRef?.type || ''
  draft.domainUid = node?.data?.domainRef?.uid || ''
  draft.configText = JSON.stringify(node?.data?.config || {}, null, 2)
}, { immediate: true })

function apply() {
  let config
  try {
    config = JSON.parse(draft.configText)
  } catch {
    ElMessage.error('节点配置必须是有效 JSON')
    return
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    ElMessage.error('节点配置必须是 JSON 对象')
    return
  }
  const hasType = Boolean(draft.domainType.trim())
  const hasUid = Boolean(draft.domainUid.trim())
  if (hasType !== hasUid) {
    ElMessage.error('领域引用类型和 UID 必须同时填写或同时留空')
    return
  }
  emit('apply', {
    status: draft.status,
    config,
    domainRef: hasType ? { type: draft.domainType.trim(), uid: draft.domainUid.trim() } : null,
  })
}
</script>

<style scoped>
.workflow-inspector { padding: 13px; }
.workflow-inspector > header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
.workflow-inspector > header strong { color: #fafafa; font-size: 13px; }
.workflow-inspector > header small { color: #52525b; font-size: 9px; }
.node-heading { display: flex; flex-direction: column; gap: 4px; padding: 10px; margin-bottom: 13px; border-radius: 9px; background: rgba(129,140,248,.09); }
.node-heading span { color: #e4e4e7; font-size: 13px; font-weight: 600; }
.node-heading code { color: #818cf8; font-size: 10px; }
.inspector-actions { display: flex; gap: 8px; }
.selection-tip { color: #71717a; font-size: 11px; line-height: 1.6; }
.port-list { display: grid; gap: 12px; margin-top: 16px; padding-top: 14px; border-top: 1px solid #2f2f37; }
.port-list div, .port-list span { display: flex; flex-direction: column; gap: 3px; }
.port-list strong { color: #a1a1aa; font-size: 10px; }
.port-list span { color: #71717a; font: 9px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; }
.port-list em { display: inline; color: #f59e0b; font-style: normal; }
</style>
