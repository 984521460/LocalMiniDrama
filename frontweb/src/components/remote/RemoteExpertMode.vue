<template>
  <section class="expert-mode">
    <el-alert
      title="专家模式仅通过本机受管 SSH 隧道打开 ComfyUI；不会公开远端端口。"
      type="warning"
      :closable="false"
      show-icon
    />
    <div class="expert-actions">
      <el-button
        :disabled="!canOpen"
        :loading="loading"
        @click="start"
      >
        启动专家模式隧道
      </el-button>
      <el-link
        v-if="safeTunnel"
        :href="safeTunnel.origin"
        target="_blank"
        rel="noopener noreferrer"
        type="primary"
      >
        打开本地 ComfyUI（专家模式）
      </el-link>
      <el-button v-if="safeTunnel" :loading="loading" @click="stop">
        关闭专家模式隧道
      </el-button>
      <small v-else>{{ canOpen ? '启动后会显示本机回环地址。' : '连接就绪并确认主机指纹后才能使用。' }}</small>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'

import { expertTunnelView } from './expertTunnelContract.js'

const props = defineProps({
  connectionUid: { type: String, required: true },
  connectionStatus: { type: String, required: true },
  tunnel: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['start', 'stop'])

const canOpen = computed(() => props.connectionStatus === 'ready')
const safeTunnel = computed(() => (props.tunnel
  ? expertTunnelView(props.tunnel, props.connectionUid)
  : null))

function start() {
  if (!canOpen.value || props.loading) return
  emit('start', props.connectionUid)
}

function stop() {
  if (!safeTunnel.value || props.loading) return
  emit('stop', props.connectionUid)
}
</script>

<style scoped>
.expert-mode { display: grid; gap: 10px; }
.expert-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
small { color: var(--el-text-color-secondary); }
</style>
