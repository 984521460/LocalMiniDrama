<template>
  <section class="environment-panel">
    <header>
      <div>
        <h3>远程环境</h3>
        <p>仅显示脱敏能力信息，不显示远端路径、凭据或命令输出。</p>
      </div>
      <el-button :disabled="!available" :loading="checking" @click="$emit('check')">检查环境</el-button>
    </header>

    <el-empty v-if="!safeReport" description="尚未检查环境" :image-size="72" />
    <template v-else>
      <el-alert
        :title="safeReport.ready ? '环境符合固定版本基线' : '环境需要初始化或修复'"
        :type="safeReport.ready ? 'success' : 'warning'"
        :closable="false"
        show-icon
      />
      <dl>
        <div><dt>GPU</dt><dd>{{ safeReport.gpuVendor }} · {{ safeReport.gpuCount }} 张 · {{ safeReport.totalVramMiB }} MiB</dd></div>
        <div><dt>Python / PyTorch</dt><dd>{{ safeReport.pythonVersion || '缺失' }} / {{ safeReport.torchVersion || '缺失' }}</dd></div>
        <div><dt>CUDA</dt><dd>{{ safeReport.cudaVersion || '缺失' }}</dd></div>
        <div><dt>FFmpeg</dt><dd>{{ safeReport.ffmpegVersion || '缺失' }}</dd></div>
        <div><dt>ComfyUI</dt><dd>{{ safeReport.comfyUiVersion || '缺失' }}</dd></div>
        <div><dt>工作目录</dt><dd>{{ safeReport.directoriesReady && safeReport.workspaceWritable ? '就绪' : '未就绪' }}</dd></div>
      </dl>
    </template>

    <footer v-if="safePlan">
      <el-button type="primary" :disabled="!available" :loading="initializing" @click="$emit('initialize', safePlan)">
        执行固定版本初始化
      </el-button>
      <el-button
        v-if="safePlan.requiresLargeModelConfirmation"
        :disabled="!available"
        :loading="installingModels"
        @click="confirmModelInstall"
      >
        单独安装大型模型
      </el-button>
      <small>计划 {{ safePlan.profileVersion }} · {{ safePlan.steps.length }} 个内置步骤</small>
    </footer>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'

import { environmentReportView, initializationPlanView } from './environmentContract.js'

const props = defineProps({
  report: { type: Object, default: null },
  plan: { type: Object, default: null },
  checking: { type: Boolean, default: false },
  initializing: { type: Boolean, default: false },
  installingModels: { type: Boolean, default: false },
  available: { type: Boolean, default: true },
})
const emit = defineEmits(['check', 'initialize', 'install-models'])

const safeReport = computed(() => (props.report ? environmentReportView(props.report) : null))
const safePlan = computed(() => (props.plan ? initializationPlanView(props.plan) : null))

async function confirmModelInstall() {
  if (!safePlan.value?.requiresLargeModelConfirmation) return
  const totalGiB = safePlan.value.modelDownloads
    .reduce((total, model) => total + model.sizeBytes, 0) / (1024 ** 3)
  try {
    await ElMessageBox.confirm(
      `将安装 ${safePlan.value.modelDownloads.length} 个大型模型，约 ${totalGiB.toFixed(1)} GiB。请先确认许可证和磁盘空间。`,
      '单独确认大型模型下载',
      { confirmButtonText: '确认安装', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  emit('install-models', safePlan.value)
}
</script>

<style scoped>
.environment-panel { display: grid; gap: 16px; padding: 18px; border: 1px solid var(--el-border-color-light); border-radius: 12px; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
h3 { margin: 0 0 4px; }
p, small { margin: 0; color: var(--el-text-color-secondary); }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin: 0; }
dl div { padding: 10px; border-radius: 8px; background: var(--el-fill-color-light); }
dt { color: var(--el-text-color-secondary); font-size: 12px; }
dd { margin: 4px 0 0; overflow-wrap: anywhere; }
</style>
