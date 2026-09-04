<template>
  <section class="continuity-workspace" aria-label="资产版本与跨镜头连续性">
    <header class="continuity-workspace__header">
      <div>
        <p class="continuity-workspace__eyebrow">已批准分镜 · 不可变版本证据</p>
        <h2>资产版本与连续性</h2>
        <p>查看每个镜头绑定的身份、服装、场景和道具版本；旧参考包与旧镜头快照会保留在历史中。</p>
      </div>
      <el-button
        :loading="workspace.loading.value"
        :disabled="workspace.materializing.value"
        @click="workspace.load"
      >刷新版本证据</el-button>
    </header>

    <el-alert
      v-if="workspace.error.value"
      type="error"
      title="版本证据加载失败"
      description="本地持久化数据未通过完整性校验，请先修复数据后再继续制作。"
      :closable="false"
      show-icon
    />

    <div v-loading="workspace.loading.value" class="continuity-workspace__body">
      <el-empty
        v-if="workspace.emptyReason.value === 'SHOT_APPROVAL_REQUIRED'"
        description="请先批准镜头规划，再建立连续性快照"
        :image-size="64"
      />
      <el-empty
        v-else-if="workspace.emptyReason.value === 'CONTINUITY_SNAPSHOTS_EMPTY'"
        description="已批准分镜尚未建立连续性快照"
        :image-size="64"
      >
        <template #default>
          <div class="continuity-workspace__materialize">
            <p>仅在本地建立不可变场景、角色和道具版本引用，不调用模型或产生费用。</p>
            <el-button
              type="primary"
              :loading="workspace.materializing.value"
              :disabled="workspace.loading.value"
              @click="workspace.materialize"
            >建立镜头版本引用</el-button>
          </div>
        </template>
      </el-empty>

      <template v-else-if="workspace.snapshots.value.length">
        <div class="continuity-workspace__metrics">
          <article>
            <strong>{{ workspace.snapshots.value.length }}</strong>
            <span>已封账镜头</span>
          </article>
          <article class="is-success">
            <strong>{{ workspace.reuse.value.stableCharacters.length }}</strong>
            <span>锁定身份复用</span>
          </article>
          <article :class="{ 'is-warning': workspace.reuse.value.conflictCount > 0 }">
            <strong>{{ workspace.reuse.value.conflictCount }}</strong>
            <span>连续性冲突</span>
          </article>
        </div>

        <div v-if="workspace.reuse.value.stableCharacters.length" class="continuity-workspace__reuse">
          <h3>锁定身份复用</h3>
          <div v-for="item in workspace.reuse.value.stableCharacters" :key="item.characterUid">
            <el-tag type="success" effect="plain">连续 {{ item.shotCount }} 镜</el-tag>
            <span>角色 {{ shortUid(item.characterUid) }}</span>
            <code>Identity {{ shortUid(item.identityVersionUid) }}</code>
            <code>Package {{ shortUid(item.referencePackageUid) }}</code>
            <code>Costume {{ shortUid(item.costumeVersionUid) }}</code>
          </div>
        </div>

        <ol class="continuity-workspace__shots">
          <li v-for="(snapshot, index) in workspace.snapshots.value" :key="snapshot.snapshotUid">
            <div class="continuity-workspace__shot-title">
              <div>
                <span>镜头 {{ snapshot.shotOrdinal }}</span>
                <strong>{{ snapshot.shotId }}</strong>
              </div>
              <el-tag v-if="index === 0" type="info" effect="plain">连续性起点</el-tag>
              <el-tag
                v-else-if="workspace.reuse.value.comparisons[index - 1].hasConflict"
                type="warning"
                effect="dark"
              >连续性冲突</el-tag>
              <el-tag v-else type="success" effect="plain">版本连续</el-tag>
            </div>

            <div
              v-if="index > 0 && workspace.reuse.value.comparisons[index - 1].changedLabels.length"
              class="continuity-workspace__changes"
            >
              <span
                v-for="label in workspace.reuse.value.comparisons[index - 1].changedLabels"
                :key="label"
              >{{ label }}</span>
            </div>

            <dl>
              <div><dt>场景版本</dt><dd>{{ snapshot.scene.name }} · {{ shortUid(snapshot.scene.versionUid) }}</dd></div>
              <div v-for="character in snapshot.characters" :key="character.characterUid">
                <dt>角色版本</dt>
                <dd>
                  {{ shortUid(character.characterUid) }} · Identity {{ shortUid(character.identityVersionUid) }}
                  · Costume {{ shortUid(character.costumeVersionUid) }}
                </dd>
              </div>
              <div v-for="prop in snapshot.props" :key="prop.propUid">
                <dt>道具版本</dt><dd>{{ prop.name }} · {{ shortUid(prop.versionUid) }}</dd>
              </div>
            </dl>
          </li>
        </ol>

        <section v-if="workspace.characterHistories.value.length" class="continuity-workspace__history">
          <h3>角色参考包历史</h3>
          <p>每次重新生成都会追加新参考包；旧包保留，可核对镜头实际引用的锁定版本。</p>
          <details
            v-for="history in workspace.characterHistories.value"
            :key="history.characterUid"
            open
          >
            <summary>
              角色 {{ shortUid(history.characterUid) }} · {{ history.packages.length }} 个历史参考包
            </summary>
            <div class="continuity-workspace__packages">
              <CharacterReferencePackageCard
                v-for="record in history.packages"
                :key="record.view.packageUid"
                :package-record="record.source"
              />
            </div>
          </details>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup>
import { onMounted, watch } from 'vue'

import CharacterReferencePackageCard from './CharacterReferencePackageCard.vue'
import { useAssetVersionContinuity } from '../../composables/useAssetVersionContinuity.js'

const props = defineProps({
  dramaId: { type: Number, required: true },
})

const workspace = useAssetVersionContinuity({ dramaId: () => props.dramaId })

function shortUid(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

onMounted(workspace.load)
watch(() => props.dramaId, () => {
  workspace.invalidate()
  workspace.load()
})
</script>

<style scoped>
.continuity-workspace { padding: 20px; border: 1px solid var(--el-border-color); border-radius: 16px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); }
.continuity-workspace__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.continuity-workspace__header h2, .continuity-workspace__header p, .continuity-workspace__reuse h3, .continuity-workspace__history h3, .continuity-workspace__history p { margin: 0; }
.continuity-workspace__header > div > p:last-child, .continuity-workspace__history p { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 12px; }
.continuity-workspace__eyebrow { color: var(--el-color-primary); font-size: 12px; font-weight: 700; }
.continuity-workspace__body { min-height: 90px; margin-top: 16px; }
.continuity-workspace__materialize { display: grid; justify-items: center; gap: 10px; }
.continuity-workspace__materialize p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.continuity-workspace__metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.continuity-workspace__metrics article { display: grid; gap: 3px; padding: 14px; border-radius: 12px; background: var(--el-fill-color-light); }
.continuity-workspace__metrics strong { font-size: 24px; }
.continuity-workspace__metrics span { color: var(--el-text-color-secondary); font-size: 12px; }
.continuity-workspace__metrics .is-success strong { color: var(--el-color-success); }
.continuity-workspace__metrics .is-warning strong { color: var(--el-color-warning); }
.continuity-workspace__reuse, .continuity-workspace__history { margin-top: 18px; }
.continuity-workspace__reuse > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 9px; padding: 10px; border-radius: 10px; background: var(--el-color-success-light-9); font-size: 12px; }
.continuity-workspace__reuse code { color: var(--el-text-color-secondary); }
.continuity-workspace__shots { display: grid; gap: 10px; margin: 18px 0 0; padding: 0; list-style: none; }
.continuity-workspace__shots > li { padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; }
.continuity-workspace__shot-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.continuity-workspace__shot-title > div { display: flex; align-items: baseline; gap: 9px; }
.continuity-workspace__shot-title span { color: var(--el-color-primary); font-size: 12px; }
.continuity-workspace__changes { display: flex; gap: 6px; margin-top: 9px; }
.continuity-workspace__changes span { padding: 3px 7px; border-radius: 999px; background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); font-size: 11px; }
.continuity-workspace__shots dl { display: grid; gap: 7px; margin: 12px 0 0; }
.continuity-workspace__shots dl > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.continuity-workspace__shots dt { color: var(--el-text-color-secondary); }
.continuity-workspace__shots dd { margin: 0; overflow-wrap: anywhere; }
.continuity-workspace__history details { margin-top: 12px; }
.continuity-workspace__history summary { cursor: pointer; font-weight: 700; }
.continuity-workspace__packages { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; margin-top: 12px; }
@media (max-width: 760px) { .continuity-workspace__header { flex-direction: column; } .continuity-workspace__metrics { grid-template-columns: 1fr; } .continuity-workspace__packages { grid-template-columns: 1fr; } }
</style>
