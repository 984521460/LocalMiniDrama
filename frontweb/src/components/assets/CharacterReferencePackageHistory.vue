<template>
  <section class="reference-history">
    <div class="reference-history__heading">
      <div>
        <h3>参考包测试历史</h3>
        <p>成功项保留 10 张原始参考图；失败和状态不确定项只展示证据，不伪造图片。</p>
      </div>
      <el-select v-model="selectedCharacterUid" placeholder="选择角色" class="reference-history__character">
        <el-option
          v-for="character in availableCharacters"
          :key="character.uid"
          :label="character.name"
          :value="character.uid"
        />
      </el-select>
    </div>

    <div v-loading="history.busy.value" class="reference-history__body">
      <el-alert
        v-if="history.error.value"
        type="error"
        title="参考包历史读取失败；没有把损坏或跨剧证据显示为可信结果"
        :closable="false"
        show-icon
      />
      <el-empty
        v-else-if="selectedCharacterUid && history.entries.value.length === 0"
        description="这个角色还没有参考包测试记录"
        :image-size="72"
      />

      <article
        v-for="entry in history.entries.value"
        :key="entry.operationUid"
        class="reference-history__entry"
      >
        <header>
          <div>
            <strong>{{ characterName(entry.request.characterUid) }}</strong>
            <span>{{ formatTime(entry.createdAtEpochMs) }}</span>
          </div>
          <div class="reference-history__tags">
            <el-tag :type="stateTagType(entry.state)" size="small">{{ stateLabel(entry.state) }}</el-tag>
            <el-tag :type="entry.candidateSourceCurrent ? 'success' : 'warning'" size="small" effect="plain">
              {{ entry.candidateSourceCurrent ? '候选来源仍有效' : '候选来源已失效 · 历史只读' }}
            </el-tag>
            <el-tag
              v-if="entry.packageCurrent !== null"
              :type="entry.packageCurrent ? 'success' : 'warning'"
              size="small"
              effect="plain"
            >
              {{ entry.packageCurrent ? '参考包仍为当前版本' : '参考包已非当前版本 · 原图保留' }}
            </el-tag>
          </div>
        </header>

        <p class="reference-history__source">
          执行 {{ shortUid(entry.operationUid) }} · 候选 {{ shortUid(entry.request.candidateUid) }} ·
          候选内容 SHA-256 {{ entry.candidateContentSha256.slice(0, 12) }}…
        </p>

        <div v-if="entry.state === 'succeeded'" class="reference-history__grid">
          <figure v-for="item in entry.packageView.items" :key="item.assetVersionUid">
            <a
              :href="originalImageUrl(entry, item)"
              target="_blank"
              rel="noopener noreferrer"
              title="打开原始参考图"
            >
              <img :src="originalImageUrl(entry, item)" :alt="`${characterName(entry.request.characterUid)} ${item.label}`" />
            </a>
            <figcaption>
              <strong>{{ item.label }}</strong>
              <span>{{ item.dimensions }}</span>
              <span>AssetVersion {{ shortUid(item.assetVersionUid) }}</span>
              <span>SHA-256 {{ item.contentSha256.slice(0, 12) }}…</span>
            </figcaption>
          </figure>
        </div>

        <el-alert
          v-else
          :type="entry.state === 'reserved' ? 'info' : 'warning'"
          :title="failureLabel(entry)"
          :closable="false"
          show-icon
        />
      </article>
    </div>

    <div v-if="history.nextCursor.value" class="reference-history__more">
      <el-button :loading="history.busy.value" @click="loadMore">加载更多参考包历史</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

import { useCharacterReferencePackageHistory } from '@/composables/useCharacterReferencePackageHistory.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
  dramaUid: { type: String, required: true },
  characters: { type: Array, default: () => [] },
})

const history = useCharacterReferencePackageHistory()
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

async function refresh(characterUid = null) {
  if (characterUid !== null && characterUid !== selectedCharacterUid.value) {
    let present = false
    for (let index = 0; index < availableCharacters.value.length; index += 1) {
      if (availableCharacters.value[index].uid === characterUid) present = true
    }
    if (!present) return null
    selectedCharacterUid.value = characterUid
    return null
  }
  const value = query()
  return value ? history.refresh(value) : null
}

async function loadMore() {
  const value = query()
  return value ? history.loadMore(value) : null
}

function characterName(characterUid) {
  for (let index = 0; index < availableCharacters.value.length; index += 1) {
    if (availableCharacters.value[index].uid === characterUid) return availableCharacters.value[index].name
  }
  return '历史角色'
}

function originalImageUrl(entry, item) {
  return `/static/characters/${entry.request.characterUid}`
    + `/reference-packages/${entry.operationUid}/${item.kind}.png`
}

function shortUid(value) { return `${value.slice(0, 8)}…${value.slice(-4)}` }
function formatTime(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function stateLabel(value) {
  if (value === 'succeeded') return '成功 · 10 张原图'
  if (value === 'failed') return '失败'
  if (value === 'submission_unknown') return '提交状态不确定'
  return '执行中断'
}
function stateTagType(value) {
  if (value === 'succeeded') return 'success'
  if (value === 'failed') return 'danger'
  return 'warning'
}
function failureLabel(entry) {
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
.reference-history { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.reference-history__heading, .reference-history__entry header { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.reference-history__heading h3 { margin: 0 0 5px; font-size: 16px; }
.reference-history__heading p, .reference-history__source { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.reference-history__character { width: 220px; }
.reference-history__body { min-height: 84px; margin-top: 14px; }
.reference-history__entry { margin-top: 12px; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-bg-color); }
.reference-history__entry header > div:first-child { display: grid; gap: 3px; }
.reference-history__entry header span { color: var(--el-text-color-secondary); font-size: 11px; }
.reference-history__tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.reference-history__source { margin-top: 8px; overflow-wrap: anywhere; }
.reference-history__grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.reference-history__grid figure { margin: 0; min-width: 0; }
.reference-history__grid img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border: 1px solid var(--el-border-color); border-radius: 9px; background: var(--el-fill-color-light); }
.reference-history__grid figcaption { display: grid; gap: 3px; margin-top: 7px; color: var(--el-text-color-secondary); font-size: 10px; overflow-wrap: anywhere; }
.reference-history__grid figcaption strong { color: var(--el-text-color-primary); font-size: 11px; }
.reference-history__entry :deep(.el-alert) { margin-top: 12px; }
.reference-history__more { display: flex; justify-content: center; margin-top: 14px; }
@media (max-width: 900px) { .reference-history__heading, .reference-history__entry header { align-items: flex-start; flex-direction: column; } .reference-history__character { width: 100%; } .reference-history__grid { grid-template-columns: 1fr 1fr; } .reference-history__tags { justify-content: flex-start; } }
</style>
