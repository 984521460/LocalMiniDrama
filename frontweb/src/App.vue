<template>
  <div class="app">
    <div v-if="offlineSafe" class="safe-mode-banner" role="status">离线安全模式 · 生成、审核和外部恢复已由后端禁用 · 仅本地查看与离线导入</div>
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { offlineSafe, loadRuntimeCapabilities } from './runtimeCapabilities.js'
onMounted(loadRuntimeCapabilities)
</script>

<style>
.safe-mode-banner { padding: 12px; background: #fff3cd; color: #332700; text-align: center; }
* {
  box-sizing: border-box;
}
html, body, #app, .app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: background 0.25s, color 0.25s;
}
</style>
