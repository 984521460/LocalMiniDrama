<template>
  <section class="character-recovery-panel">
    <h4>已提交候选 · 继续回收</h4>
    <p>只下载原已提交作业，不会补发生成。缺少提交确认的项目不能推测恢复；素材仍需人工审核。</p>
    <el-button :disabled="busy" @click="refresh">刷新续收状态</el-button>
    <p v-if="error" role="alert">续收未完成；请核对来源、连接和本地文件，系统不会重新提交生成。</p>
    <article v-for="row in records" :key="row.operationUid">
      <p>{{ row.operationUid }} · 已保存 {{ row.receivedCount }}/4 · {{ row.batchReady ? '完整候选批次，待人工选择' : row.state }}</p>
      <p>{{ row.jobs.map(j => `${j.ordinal + 1}: ${labels[j.state]}`).join(' / ') }}</p>
      <el-button :disabled="busy || !row.canRecover || safe" @click="recover(row)">继续回收（不重新生成）</el-button>
      <p v-if="!row.recoveryEnabled">离线安全模式：仅显示已落盘素材，未检验远端连接。</p>
      <p v-if="row.bindingState === 'needs_rebind'">导入的历史回收快照：需要重新绑定，当前不会执行远端操作。</p>
      <el-button v-if="row.batchReady" :disabled="busy" @click="emit('recovered', row)">载入完整候选批次</el-button>
      <div class="recovery-images"><figure v-for="item in row.items" :key="item.assetVersionUid"><img :src="`/static/${item.relativePath}`" :alt="`已回收候选 ${item.ordinal + 1}`" /><figcaption>候选 {{ item.ordinal + 1 }} · 未批准</figcaption></figure></div>
    </article>
  </section>
</template>
<script setup>
import { ref, watch } from "vue";
import { characterRecoveryAPI } from "../../characterCandidates/characterRecovery.js";
import { offlineSafe } from "../../runtimeCapabilities.js";
const props = defineProps({ dramaId: Number, selection: Object, revision: Number });
const emit = defineEmits(["recovered"]);
const safe = offlineSafe, records = ref([]), busy = ref(false), error = ref(false);
const labels = { not_submitted: "未提交", submitting: "提交确认未知", submitted: "已提交待回收",
output_bound: "输出已绑定待下载", collected: "已保存" };
let generation = 0;
async function refresh() {
  const token = ++generation;
  records.value = [];
  error.value = false;
  if (!props.selection) return;
  try {
    const rows = await characterRecoveryAPI.list(props.dramaId, props.selection.characterUid);
    if (token === generation) records.value = rows;
  } catch {
    if (token === generation) error.value = true;
  }
}
async function recover(row) {
  const token = generation;
  busy.value = true;
  error.value = false;
  try {
    const result = await characterRecoveryAPI.recover(props.dramaId, row.characterUid, row.operationUid);
    if (token === generation) {
      await refresh();
      emit("recovered", result);
    }
  } catch {
    if (token === generation) error.value = true;
  } finally {
    busy.value = false;
  }
}
watch(() => [props.dramaId, props.selection?.characterUid, props.revision], refresh, { immediate: true });
defineExpose({ refresh });
</script>
<style scoped>.character-recovery-panel{margin-top:20px;padding:16px;border:1px solid #ddd;border-radius:8px}.recovery-images{display:flex;gap:12px;flex-wrap:wrap}.recovery-images img{width:160px;height:160px;object-fit:contain}figure{margin:8px}</style>
