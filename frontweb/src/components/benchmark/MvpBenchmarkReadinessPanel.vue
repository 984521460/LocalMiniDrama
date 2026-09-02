<template>
  <section class="mvp-readiness-panel">
    <header class="panel-heading">
      <div>
        <strong>MVP 就绪度</strong>
        <small>只读检查，不会启动任务或产生外部费用</small>
      </div>
      <el-button link size="small" :loading="busy" @click="$emit('refresh')">刷新</el-button>
    </header>

    <div class="completion-banner">
      <span class="status-dot" />
      <div>
        <strong>MVP 尚未完成</strong>
        <small v-if="readiness?.readyForBenchmark">本地能力已具备，仍需发行证据与人工音画验收。</small>
        <small v-else>仍有 {{ readiness?.blockedCapabilityIds.length || 0 }} 项能力受阻，不能进入正式基准验收。</small>
      </div>
    </div>

    <p v-if="error" class="error-message">就绪度读取失败；未把未知响应当作有效证据。</p>
    <div v-else-if="!readiness && !busy" class="empty-message">尚未读取本地就绪度。</div>

    <template v-if="readiness">
      <section class="summary-grid" aria-label="MVP 就绪度摘要">
        <div><strong>{{ readyCount }}</strong><small>已具备</small></div>
        <div><strong>{{ readiness.blockedCapabilityIds.length }}</strong><small>受阻</small></div>
        <div><strong>{{ readiness.pendingCapabilityIds.length }}</strong><small>待取证</small></div>
      </section>

      <section class="capability-section">
        <div class="section-title"><strong>能力门禁</strong><small>12 项固定合同</small></div>
        <article v-for="item in readiness.capabilities" :key="item.id" class="capability-row">
          <div>
            <strong>{{ mvpCapabilityLabel(item.id) }}</strong>
            <small>{{ item.kind }}</small>
          </div>
          <el-tag :type="mvpCapabilityStatusMeta(item.status).tone" effect="dark" size="small">
            {{ mvpCapabilityStatusMeta(item.status).label }}
          </el-tag>
          <code v-if="item.blockerCode">{{ item.blockerCode }}</code>
        </article>
      </section>

      <section class="checklist-section">
        <div class="section-title"><strong>34 项验收清单</strong><small>当前均为待提交证据</small></div>
        <div v-for="group in checklistGroups" :key="group.section" class="checklist-group">
          <header>
            <strong>{{ mvpChecklistSectionMeta(group.section).label }}</strong>
            <el-tag :type="mvpChecklistSectionMeta(group.section).tone" effect="plain" size="small">
              {{ group.items.length }} 项待验收
            </el-tag>
          </header>
          <ol>
            <li v-for="item in group.items" :key="item.id">
              <span>{{ mvpChecklistLabel(item.id) }}</span>
              <small>{{ item.evidenceKind }}</small>
            </li>
          </ol>
        </div>
      </section>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'

import {
  mvpCapabilityLabel,
  mvpCapabilityStatusMeta,
  mvpChecklistLabel,
  mvpChecklistSectionMeta,
} from '../../benchmark/mvpReadiness.js'

const props = defineProps({
  readiness: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['refresh'])

const readyCount = computed(() => {
  if (!props.readiness) return 0
  let count = 0
  for (let index = 0; index < props.readiness.capabilities.length; index += 1) {
    if (props.readiness.capabilities[index].status === 'ready') count += 1
  }
  return count
})

const checklistGroups = computed(() => {
  if (!props.readiness) return []
  const groups = [
    { section: 'function', items: [] },
    { section: 'reliability', items: [] },
    { section: 'quality', items: [] },
  ]
  const bySection = Object.create(null)
  for (let index = 0; index < groups.length; index += 1) {
    bySection[groups[index].section] = groups[index]
  }
  for (let index = 0; index < props.readiness.checklist.length; index += 1) {
    const item = props.readiness.checklist[index]
    bySection[item.section].items.push(item)
  }
  return groups
})
</script>

<style scoped>
.mvp-readiness-panel { display: flex; flex-direction: column; gap: 12px; padding: 13px; color: #e4e4e7; }
.panel-heading, .section-title, .checklist-group > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.panel-heading > div, .completion-banner > div, .capability-row > div { display: flex; flex-direction: column; gap: 3px; }
strong { color: #fafafa; font-size: 12px; }
small { color: #71717a; font-size: 9px; line-height: 1.45; }
.completion-banner { display: flex; align-items: flex-start; gap: 9px; padding: 11px; border: 1px solid rgba(245, 158, 11, .3); border-radius: 10px; background: rgba(120, 53, 15, .16); }
.completion-banner strong { color: #fcd34d; }
.status-dot { width: 8px; height: 8px; margin-top: 4px; flex: 0 0 auto; border-radius: 999px; background: #f59e0b; box-shadow: 0 0 10px rgba(245,158,11,.65); }
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.summary-grid > div { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; border: 1px solid #2f2f37; border-radius: 8px; background: #1c1c21; }
.summary-grid strong { font-size: 18px; }
.capability-section, .checklist-section { display: flex; flex-direction: column; gap: 7px; }
.capability-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 8px; padding: 8px; border: 1px solid #2f2f37; border-radius: 8px; background: #1a1a1f; }
.capability-row code { grid-column: 1 / -1; overflow: hidden; color: #fca5a5; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.checklist-group { border: 1px solid #2f2f37; border-radius: 9px; background: #1a1a1f; overflow: hidden; }
.checklist-group > header { padding: 8px 9px; border-bottom: 1px solid #2f2f37; }
.checklist-group ol { margin: 0; padding: 6px 9px 8px 28px; }
.checklist-group li { padding: 3px 0; color: #a1a1aa; font-size: 10px; }
.checklist-group li span { display: block; color: #d4d4d8; }
.checklist-group li small { display: block; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.error-message, .empty-message { margin: 0; padding: 9px; border-radius: 7px; background: rgba(127,29,29,.18); color: #fca5a5; font-size: 10px; line-height: 1.5; }
.empty-message { background: #1c1c21; color: #71717a; }
</style>
