<template>
  <section class="bgm-library-panel">
    <header>
      <div>
        <strong>本地 BGM 素材库</strong>
        <small>只导入本机文件；不会联网获取音乐，也不会自动选择曲目</small>
      </div>
      <el-button link size="small" :loading="busy" :disabled="!dramaUid" @click="$emit('refresh')">刷新</el-button>
    </header>

    <p class="rights-note">以下权利信息是你的明确声明，不是系统完成的法律审查。只有同时声明允许商业使用和衍生编辑的曲目，才能被选作后续成片候选。</p>
    <p v-if="error" class="error-message">导入或读取失败；未采用部分或未验证的数据。</p>

    <div class="import-form">
      <label class="file-field">
        <span>本地音频文件（最大 32 MiB）</span>
        <input type="file" accept="audio/aac,audio/flac,audio/mpeg,audio/wav" :disabled="busy" @change="onFile" />
      </label>
      <el-input v-model="form.title" size="small" maxlength="256" placeholder="曲目标题" />
      <el-select v-model="form.licenseBasis" size="small" aria-label="权利依据">
        <el-option label="本人拥有" value="user-owned" />
        <el-option label="已获许可" value="licensed" />
        <el-option label="公有领域" value="public-domain" />
        <el-option label="服务商授权" value="provider-grant" />
      </el-select>
      <el-checkbox v-model="form.commercialUseAllowed">我声明允许商业使用</el-checkbox>
      <el-checkbox v-model="form.derivativesAllowed">我声明允许剪辑、混音等衍生编辑</el-checkbox>
      <el-button type="primary" size="small" :loading="busy" :disabled="!canImport" @click="submit">导入并完整验证</el-button>
    </div>

    <p v-if="tracks.length === 0 && !busy" class="empty-message">当前尚无已验证的本地 BGM。</p>
    <article v-for="track in tracks" :key="track.uid" class="track-row">
      <div>
        <strong>{{ track.title }}</strong>
        <small>{{ (track.durationMs / 1000).toFixed(2) }} 秒 · {{ basisLabel(track.license.basis) }}</small>
      </div>
      <el-tag :type="track.exportEligible ? 'success' : 'warning'" size="small" effect="plain">
        {{ track.exportEligible ? '可用于成片' : '权利不足' }}
      </el-tag>
      <el-button
        size="small"
        :type="selectedTrackUid === track.uid ? 'success' : 'default'"
        :disabled="busy || !track.exportEligible"
        @click="$emit('select', track.uid)"
      >{{ selectedTrackUid === track.uid ? '已显式选择' : '选择此曲目' }}</el-button>
    </article>
  </section>
</template>

<script setup>
import { computed, reactive, shallowRef } from 'vue'

const props = defineProps({
  dramaUid: { type: String, default: '' },
  tracks: { type: Array, default: () => [] },
  selectedTrackUid: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['refresh', 'import', 'select'])
const file = shallowRef(null)
const form = reactive({
  title: '',
  licenseBasis: 'user-owned',
  commercialUseAllowed: false,
  derivativesAllowed: false,
})

const canImport = computed(() => Boolean(
  props.dramaUid && file.value && form.title.trim() && !props.busy,
))

function onFile(event) {
  const candidate = event?.target?.files?.[0] ?? null
  file.value = candidate
  if (candidate && !form.title.trim()) {
    form.title = candidate.name.replace(/\.[^.]+$/u, '').slice(0, 256)
  }
}

function submit() {
  if (!canImport.value) return
  emit('import', {
    file: file.value,
    title: form.title.trim(),
    licenseBasis: form.licenseBasis,
    commercialUseAllowed: form.commercialUseAllowed,
    derivativesAllowed: form.derivativesAllowed,
  })
}

function basisLabel(value) {
  return {
    'user-owned': '本人拥有',
    licensed: '已获许可',
    'public-domain': '公有领域',
    'provider-grant': '服务商授权',
  }[value] ?? '未知'
}
</script>

<style scoped>
.bgm-library-panel { display: flex; flex-direction: column; gap: 9px; padding: 13px; border-bottom: 1px solid #2f2f37; color: #e4e4e7; }
header, .track-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
header > div, .track-row > div, .file-field { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
strong { overflow: hidden; color: #fafafa; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
small, .file-field span { color: #71717a; font-size: 9px; line-height: 1.45; }
.rights-note, .error-message, .empty-message { margin: 0; padding: 8px 9px; border-radius: 8px; background: rgba(30, 58, 138, .16); color: #a5b4fc; font-size: 10px; line-height: 1.55; }
.error-message { background: rgba(127,29,29,.18); color: #fca5a5; }
.empty-message { background: #1c1c21; color: #71717a; }
.import-form { display: flex; flex-direction: column; gap: 7px; padding: 9px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.file-field input { max-width: 100%; color: #a1a1aa; font-size: 9px; }
.track-row { padding: 8px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.track-row > div { flex: 1; }
</style>
