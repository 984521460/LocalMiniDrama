<template>
  <section class="mvp-finalization-panel">
    <header>
      <div>
        <strong>生产成片编译</strong>
        <small>把当前批次的可信 H3/TTS 结果与显式 BGM 编入同一运行的 export.final</small>
      </div>
      <el-button
        type="success"
        size="small"
        :loading="busy"
        :disabled="!canFinalize"
        @click="$emit('finalize')"
      >编译并导出成片</el-button>
    </header>
    <div v-if="shotTaskOrder.length" class="shot-order">
      <div class="shot-order-heading">
        <span>成片镜头顺序（从上到下）</span>
        <el-button size="small" text :disabled="orderLocked" @click="$emit('reset-order')">恢复原顺序</el-button>
      </div>
      <ol>
        <li v-for="(taskUid, index) in shotTaskOrder" :key="taskUid">
          <span><b>{{ index + 1 }}</b> 原镜头 {{ originalOrdinal(taskUid) }}</span>
          <small>{{ shortUid(taskUid) }}</small>
          <div>
            <el-button size="small" text :disabled="orderLocked || index === 0" @click="$emit('move-shot', taskUid, -1)">上移</el-button>
            <el-button size="small" text :disabled="orderLocked || index === shotTaskOrder.length - 1" @click="$emit('move-shot', taskUid, 1)">下移</el-button>
          </div>
        </li>
      </ol>
    </div>
    <p class="local-note">该操作只读取本地持久证据和媒体，执行本机完整解码、时间线编译与 FFmpeg 导出；不会再次访问 SSH、Vault、Provider 或 GPU，也不会创建新生成任务。</p>
    <p v-if="error" class="error-message">成片编译或导出失败；不会采用部分状态，也不会自动重试。</p>
    <p v-else-if="!batchComplete" class="empty-message">所有预检批次项目取得可信成功结果后才可编译成片。</p>
    <p v-else-if="!selectedTrackUid" class="empty-message">请先显式选择一条具备可导出权利声明的本地 BGM。</p>
    <p v-else-if="run" class="complete-message">成片导出状态：{{ run.statusLabel }}。</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  batchComplete: { type: Boolean, default: false },
  selectedTrackUid: { type: String, default: '' },
  shotTaskOrder: { type: Array, default: () => [] },
  plannedShotTaskOrder: { type: Array, default: () => [] },
  run: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['finalize', 'move-shot', 'reset-order'])

function originalOrdinal(taskUid) {
  const index = props.plannedShotTaskOrder.indexOf(taskUid)
  return index < 0 ? '？' : index + 1
}

function shortUid(taskUid) {
  return typeof taskUid === 'string' ? taskUid.slice(-8) : 'unknown'
}

const orderLocked = computed(() => Boolean(props.busy || props.run))
const canFinalize = computed(() => Boolean(
  props.batchComplete && props.selectedTrackUid && props.shotTaskOrder.length > 0
    && !props.busy && !props.run,
))
</script>

<style scoped>
.mvp-finalization-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.local-note, .error-message, .empty-message, .complete-message { margin: 0; padding: 8px 9px; border-radius: 8px; font-size: 10px; line-height: 1.55; }
.local-note { background: rgba(30, 64, 175, .15); color: #bfdbfe; }
.shot-order { display: flex; flex-direction: column; gap: 6px; padding: 9px; border: 1px solid #33333b; border-radius: 8px; background: #17171c; }
.shot-order-heading, .shot-order li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.shot-order-heading { color: #d4d4d8; font-size: 10px; }
.shot-order ol { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.shot-order li { padding: 5px 7px; border-radius: 6px; background: #202027; font-size: 10px; }
.shot-order li > span { min-width: 92px; color: #e4e4e7; }
.shot-order li > span b { display: inline-flex; justify-content: center; min-width: 17px; margin-right: 5px; color: #93c5fd; }
.shot-order li > small { flex: 1; color: #71717a; font-family: ui-monospace, monospace; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.complete-message { background: rgba(20, 83, 45, .2); color: #86efac; }
</style>
