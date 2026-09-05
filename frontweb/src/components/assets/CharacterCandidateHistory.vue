<template>
  <section class="candidate-history">
    <div class="history-heading">
      <div>
        <h3>历史测试作品</h3>
        <p>持久保留成功、失败和状态不确定的测试；这里只读展示，不参与角色锁定。</p>
      </div>
      <el-select v-model="selectedCharacterUid" placeholder="选择角色" class="history-character">
        <el-option
          v-for="character in availableCharacters"
          :key="character.uid"
          :label="character.name"
          :value="character.uid"
        />
      </el-select>
    </div>

    <div v-loading="history.busy.value" class="history-body">
      <el-alert
        v-if="history.error.value"
        type="error"
        title="历史作品读取失败；没有把损坏或跨剧证据显示为可信结果"
        :closable="false"
        show-icon
      />
      <el-empty
        v-else-if="selectedCharacterUid && history.entries.value.length === 0"
        description="这个角色还没有持久测试作品"
        :image-size="72"
      />

      <article
        v-for="entry in history.entries.value"
        :key="entry.operationUid"
        class="history-entry"
      >
        <header>
          <div>
            <strong>{{ entry.source.characterName }}</strong>
            <span>{{ formatTime(entry.createdAtEpochMs) }}</span>
          </div>
          <div class="history-tags">
            <el-tag :type="stateTagType(entry.state)" size="small">{{ stateLabel(entry.state) }}</el-tag>
            <el-tag :type="entry.sourceCurrent ? 'success' : 'warning'" size="small" effect="plain">
              {{ entry.sourceCurrent ? '来源仍有效' : '来源已失效 · 历史只读' }}
            </el-tag>
          </div>
        </header>

        <p class="history-source">
          extraction {{ shortUid(entry.source.extractionResultUid) }} ·
          {{ entry.source.characterFactId }} · 执行 {{ shortUid(entry.operationUid) }}
        </p>

        <div v-if="entry.state === 'succeeded'" class="history-grid">
          <figure v-for="item in entry.items" :key="item.assetVersionUid">
            <a
              :href="`/static/${item.relativePath}`"
              target="_blank"
              rel="noopener noreferrer"
              title="打开原始测试作品"
            >
              <img
                :src="`/static/${item.relativePath}`"
                :alt="`${entry.source.characterName}历史候选 ${item.ordinal + 1}`"
              />
            </a>
            <figcaption>
              <strong>候选 {{ item.ordinal + 1 }}</strong>
              <span>{{ item.width }}×{{ item.height }} · seed {{ item.seed }}</span>
              <span>{{ item.provider }} / {{ item.model }}</span>
              <span>AssetVersion {{ shortUid(item.assetVersionUid) }}</span>
              <span>SHA-256 {{ item.contentSha256.slice(0, 12) }}…</span>
              <el-tag v-if="!item.currentVersion" type="warning" size="small" effect="plain">
                非当前资产版本
              </el-tag>
            </figcaption>
          </figure>
        </div>

        <el-alert
          v-else
          :type="entry.state === 'reserved' ? 'info' : 'warning'"
          :title="historyFailureLabel(entry)"
          :closable="false"
          show-icon
        />
      </article>
    </div>

    <div v-if="history.nextCursor.value" class="history-more">
      <el-button :loading="history.busy.value" @click="loadMore">加载更多历史作品</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

import { useCharacterCandidateHistory } from '@/composables/useCharacterCandidateHistory.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  characters: { type: Array, default: () => [] },
})

const history = useCharacterCandidateHistory()
const selectedCharacterUid = ref('')
const availableCharacters = computed(() => {
  const output = []
  for (let index = 0; index < props.characters.length; index += 1) {
    const character = props.characters[index]
    if (typeof character?.uid === 'string' && typeof character?.name === 'string') {
      output[output.length] = Object.freeze({ uid: character.uid, name: character.name })
    }
  }
  return Object.freeze(output)
})

function query() {
  if (!selectedCharacterUid.value) return null
  return Object.freeze({
    dramaId: props.dramaId,
    dramaUid: props.dramaUid,
    characterUid: selectedCharacterUid.value,
  })
}

async function refresh() {
  const value = query()
  if (!value) return null
  return history.refresh(value)
}

async function loadMore() {
  const value = query()
  if (!value) return null
  return history.loadMore(value)
}

function shortUid(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function stateLabel(value) {
  if (value === 'succeeded') return '成功 · 4 张原图'
  if (value === 'failed') return '失败'
  if (value === 'submission_unknown') return '提交状态不确定'
  return '执行中断'
}

function stateTagType(value) {
  if (value === 'succeeded') return 'success'
  if (value === 'failed') return 'danger'
  return 'warning'
}

function historyFailureLabel(entry) {
  if (entry.state === 'reserved') return '执行尚未形成结果；没有伪造图片'
  return `保留的失败证据：${entry.errorCode || '状态未知'}；没有伪造图片`
}

watch(availableCharacters, (characters) => {
  let present = false
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index].uid === selectedCharacterUid.value) present = true
  }
  if (!present) selectedCharacterUid.value = characters[0]?.uid || ''
}, { immediate: true })

watch([() => props.dramaUid, selectedCharacterUid], () => {
  history.invalidate()
  void refresh()
}, { immediate: true })

defineExpose({ refresh })
</script>

<style scoped>
.candidate-history { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.history-heading, .history-entry header { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.history-heading h3 { margin: 0 0 5px; font-size: 16px; }
.history-heading p, .history-source { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.history-character { width: 220px; }
.history-body { min-height: 84px; margin-top: 14px; }
.history-entry { margin-top: 12px; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-bg-color); }
.history-entry header > div:first-child { display: grid; gap: 3px; }
.history-entry header span { color: var(--el-text-color-secondary); font-size: 11px; }
.history-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.history-source { margin-top: 8px; }
.history-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.history-grid figure { margin: 0; min-width: 0; }
.history-grid img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border: 1px solid var(--el-border-color); border-radius: 9px; background: var(--el-fill-color-light); }
.history-grid figcaption { display: grid; gap: 3px; margin-top: 7px; color: var(--el-text-color-secondary); font-size: 10px; overflow-wrap: anywhere; }
.history-grid figcaption strong { color: var(--el-text-color-primary); font-size: 11px; }
.history-entry :deep(.el-alert) { margin-top: 12px; }
.history-more { display: flex; justify-content: center; margin-top: 14px; }
@media (max-width: 900px) { .history-heading, .history-entry header { align-items: flex-start; flex-direction: column; } .history-character { width: 100%; } .history-grid { grid-template-columns: 1fr 1fr; } .history-tags { justify-content: flex-start; } }
</style>
