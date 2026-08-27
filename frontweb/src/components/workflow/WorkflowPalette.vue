<template>
  <aside class="workflow-palette">
    <div class="palette-heading">
      <div><strong>节点库</strong><small>{{ filtered.length }} 种</small></div>
      <el-input v-model="query" size="small" clearable placeholder="搜索节点" />
    </div>
    <div class="palette-list">
      <button
        v-for="definition in filtered"
        :key="definition.type"
        class="palette-node"
        type="button"
        :disabled="disabled"
        @click="$emit('add', definition)"
      >
        <span class="palette-dot" :class="`group-${groupFor(definition.type)}`" />
        <span><strong>{{ definition.title }}</strong><small>{{ definition.type }}</small></span>
        <span class="add-mark">＋</span>
      </button>
    </div>
    <p class="palette-tip">新增节点默认停用；连接、绑定并确认配置后再启用。拖动画布可自由布局。</p>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  definitions: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
})

defineEmits(['add'])

const query = ref('')
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.definitions
  return props.definitions.filter((definition) => (
    definition.title.toLowerCase().includes(keyword)
    || definition.type.toLowerCase().includes(keyword)
  ))
})

function groupFor(type) {
  return type.split('.')[0]
}
</script>

<style scoped>
.workflow-palette { display: flex; flex-direction: column; min-height: 0; height: 100%; background: #151519; border-right: 1px solid #2f2f37; }
.palette-heading { padding: 14px 12px 10px; border-bottom: 1px solid #27272f; }
.palette-heading > div { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.palette-heading strong { color: #fafafa; font-size: 13px; }
.palette-heading small { color: #71717a; font-size: 10px; }
.palette-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.palette-node { width: 100%; display: grid; grid-template-columns: 9px 1fr auto; align-items: center; gap: 9px; padding: 9px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #e4e4e7; text-align: left; cursor: pointer; }
.palette-node:hover { border-color: rgba(129,140,248,.35); background: rgba(129,140,248,.09); }
.palette-node:disabled { cursor: not-allowed; opacity: .45; }
.palette-node strong, .palette-node small { display: block; }
.palette-node strong { font-size: 12px; font-weight: 600; }
.palette-node small { margin-top: 2px; color: #71717a; font-size: 9px; }
.palette-dot { width: 8px; height: 8px; border-radius: 99px; background: #818cf8; box-shadow: 0 0 12px currentColor; }
.group-asset, .group-shot { background: #22d3ee; }
.group-audio, .group-subtitle, .group-bgm { background: #f59e0b; }
.group-export { background: #22c55e; }
.add-mark { color: #71717a; font-size: 14px; }
.palette-tip { margin: 0; padding: 10px 12px 14px; color: #52525b; font-size: 10px; line-height: 1.5; border-top: 1px solid #27272f; }
</style>
