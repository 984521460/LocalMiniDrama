<template>
  <section class="h3-panel" aria-labelledby="h3-panel-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">Phase 7 · MiniMax H3</p>
        <h2 id="h3-panel-title">本地生成能力状态</h2>
      </div>
      <el-tag v-if="profile" type="success">四步 · 24 FPS · 768P 档</el-tag>
    </div>

    <el-skeleton v-if="loading" :rows="3" animated />
    <el-alert
      v-else-if="error"
      title="H3 本地能力状态加载失败"
      description="系统不会在状态不明时假定工作流可用。"
      type="error"
      :closable="false"
      show-icon
    />
    <template v-else-if="profile && validation">
      <div class="status-grid">
        <article v-for="gpu in validation.gpus" :key="gpu.gpuClass" class="gpu-card">
          <div class="gpu-title">
            <strong>{{ gpuLabel(gpu.gpuClass) }}</strong>
            <span>{{ gpu.vramGiB }} GB VRAM</span>
          </div>
          <ul>
            <li v-for="mode in modeRows" :key="mode.key">
              <span>{{ mode.label }}</span>
              <el-tag :type="gpu.modes[mode.key].status === 'verified' ? 'success' : 'warning'" size="small">
                {{ gpu.modes[mode.key].status === 'verified' ? '已有实测' : '待真实验收' }}
              </el-tag>
            </li>
          </ul>
        </article>
      </div>
      <el-alert
        v-if="hasMalformedDigest"
        title="Video VAE 历史摘要证据格式异常"
        description="本地工作流保留该事实并阻止把它误报为已校验 SHA-256；正式交付前需要重新计算权重摘要。"
        type="warning"
        :closable="false"
        show-icon
      />
      <p class="status-note">
        RTX 4090 的文生、首帧、首尾帧和四图加音频多参考模式均已有真实本地证据；PRO 6000 仍保持待验收。
      </p>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { RTX_4090_GPU_CLASS } from '../../h3/gpuClasses.js'

const props = defineProps({
  profile: { type: Object, default: null },
  validation: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: Boolean, default: false },
})

const modeRows = Object.freeze([
  Object.freeze({ key: 't2v', label: '文生视频' }),
  Object.freeze({ key: 'fl2va-first', label: '单首帧' }),
  Object.freeze({ key: 'fl2va-first-last', label: '首尾帧' }),
  Object.freeze({ key: 'ref2va', label: '多参考图' }),
])

const hasMalformedDigest = computed(() => (
  props.profile?.models?.videoVae?.digestStatus === 'historical-evidence-malformed'
))

function gpuLabel(gpuClass) {
  return gpuClass === RTX_4090_GPU_CLASS ? 'RTX 4090 测试实例' : 'RTX PRO 6000 正式制作'
}
</script>

<style scoped>
.h3-panel { margin: 22px 0; padding: 22px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.panel-heading, .gpu-title, li { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.panel-heading { margin-bottom: 18px; }
.panel-heading h2 { margin: 4px 0 0; font-size: 20px; }
.eyebrow { margin: 0; color: var(--el-color-primary); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
.gpu-card { padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
.gpu-title span, .status-note { color: var(--el-text-color-secondary); }
ul { display: grid; gap: 9px; margin: 14px 0 0; padding: 0; list-style: none; }
.status-note { margin: 12px 0 0; font-size: 13px; }
@media (max-width: 720px) { .status-grid { grid-template-columns: 1fr; } }
</style>
