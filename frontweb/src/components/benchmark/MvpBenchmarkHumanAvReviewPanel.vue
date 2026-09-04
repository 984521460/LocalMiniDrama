<template>
  <section class="mvp-human-review-panel">
    <header>
      <div>
        <strong>人工音画验收</strong>
        <small>先在“成片”页打开并完整观看当前导出，再提交一次不可变验收</small>
      </div>
      <el-button
        link
        size="small"
        :disabled="!exportReady || busy"
        @click="$emit('refresh')"
      >读取已有验收</el-button>
    </header>

    <p class="boundary-note">程序化解码只证明文件结构有效；以下三项必须由你实际观看和听取后判断。本记录不会自动把 MVP 标记为完成。</p>
    <p v-if="error" class="error-message">人工验收读取或提交失败；不会采用部分记录。</p>
    <p v-else-if="!exportReady" class="empty-message">当前批次尚无已验证成功的 1080p 成片。</p>

    <article v-else-if="review" class="review-record">
      <strong>已提交不可变验收</strong>
      <span>可播放、字幕同步、对白/BGM 平衡均已确认</span>
      <small>{{ review.reviewNote }}</small>
    </article>

    <div v-else class="review-form">
      <el-checkbox v-model="videoPlaybackAccepted">我已完整播放成片，画面和声音可正常播放</el-checkbox>
      <el-checkbox v-model="subtitleSyncAccepted">我已核对字幕，字幕与对白基本同步</el-checkbox>
      <el-checkbox v-model="bgmBalanceAccepted">我已核对混音，BGM 没有盖住对白</el-checkbox>
      <el-input
        v-model="reviewNote"
        type="textarea"
        :rows="3"
        maxlength="2048"
        show-word-limit
        placeholder="填写实际观看结果、异常或可接受偏差；不能为空"
      />
      <el-button
        type="warning"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      >提交不可变人工验收</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  run: { type: Object, default: null },
  review: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['refresh', 'review'])
const videoPlaybackAccepted = ref(false)
const subtitleSyncAccepted = ref(false)
const bgmBalanceAccepted = ref(false)
const reviewNote = ref('')

const exportReady = computed(() => Boolean(
  props.run?.status === 'succeeded' && props.run?.output,
))
const canSubmit = computed(() => Boolean(
  exportReady.value
    && !props.review
    && !props.busy
    && videoPlaybackAccepted.value
    && subtitleSyncAccepted.value
    && bgmBalanceAccepted.value
    && reviewNote.value.trim().length > 0,
))

function resetForm() {
  videoPlaybackAccepted.value = false
  subtitleSyncAccepted.value = false
  bgmBalanceAccepted.value = false
  reviewNote.value = ''
}

function submit() {
  if (!canSubmit.value) return
  emit('review', {
    videoPlaybackAccepted: true,
    subtitleSyncAccepted: true,
    bgmBalanceAccepted: true,
    reviewNote: reviewNote.value.trim(),
  })
}

watch(() => props.run?.uid || '', resetForm)
</script>

<style scoped>
.mvp-human-review-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header > div, .review-record, .review-form { display: flex; flex-direction: column; gap: 7px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #a1a1aa; font-size: 9px; line-height: 1.5; overflow-wrap: anywhere; }
.boundary-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; font-size: 10px; line-height: 1.55; }
.boundary-note { background: rgba(120, 53, 15, .2); color: #fde68a; }
.error-message { background: rgba(127, 29, 29, .18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.review-record { padding: 10px; border: 1px solid rgba(34, 197, 94, .28); border-radius: 8px; background: rgba(20, 83, 45, .2); }
.review-record span { color: #86efac; font-size: 10px; }
.review-form :deep(.el-checkbox) { height: auto; align-items: flex-start; white-space: normal; }
.review-form :deep(.el-checkbox__label) { color: #d4d4d8; font-size: 10px; line-height: 1.45; white-space: normal; }
</style>
