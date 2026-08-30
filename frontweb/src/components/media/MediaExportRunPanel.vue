<template>
  <section class="media-export-run-panel">
    <header><div><strong>成片导出</strong><small>只执行当前已完成的成片节点</small></div><el-button link size="small" @click="$emit('refresh')">刷新</el-button></header>
    <el-button type="success" :disabled="!nodeRunUid" :loading="busy" @click="$emit('start', nodeRunUid)">生成并验证 1080p 成片</el-button>
    <el-empty v-if="!runs.length" description="还没有成片导出记录" :image-size="52" />
    <p v-if="error" class="error">{{ error }}</p>
    <article v-for="entry in runs" :key="entry.uid">
      <div><strong>{{ entry.statusLabel }}</strong><small>{{ entry.errorCode || entry.executionPlanSha256.slice(0, 12) + '…' }}</small></div>
      <a v-if="entry.output" :href="`/static/${entry.output.relativePath}`" target="_blank" rel="noopener">打开成片</a>
    </article>
  </section>
</template>

<script setup>
defineProps({
  runs: { type: Array, default: () => [] },
  nodeRunUid: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
defineEmits(['refresh', 'start'])
</script>

<style scoped>
.media-export-run-panel { display: flex; flex-direction: column; gap: 10px; padding: 13px; }
header, article { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header div, article div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; } small { color: #71717a; font-size: 9px; }
article { padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1c1c21; }
a { color: #86efac; font-size: 10px; }
.error { margin: 0; color: #fca5a5; font-size: 10px; }
</style>
