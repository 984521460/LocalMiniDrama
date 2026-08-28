<template>
  <section class="reference-package" aria-label="角色参考包">
    <header class="reference-package__header">
      <div>
        <p class="reference-package__eyebrow">已锁定身份版本</p>
        <h3>{{ view.title }}</h3>
      </div>
      <span class="reference-package__version">v{{ view.lockStateVersion }}</span>
    </header>

    <div class="reference-package__summary">
      <article>
        <h4>{{ view.appearance.name }}</h4>
        <p>{{ view.appearance.description }}</p>
        <div class="reference-package__colors" aria-label="外貌颜色锚点">
          <span
            v-for="color in view.appearance.colorAnchors"
            :key="color"
            :style="{ backgroundColor: color }"
            :title="color"
          />
        </div>
      </article>
      <article>
        <h4>{{ view.defaultCostume.name }}</h4>
        <p>{{ view.defaultCostume.description }}</p>
        <div class="reference-package__colors" aria-label="服装颜色锚点">
          <span
            v-for="color in view.defaultCostume.colorAnchors"
            :key="color"
            :style="{ backgroundColor: color }"
            :title="color"
          />
        </div>
      </article>
    </div>

    <ol class="reference-package__items">
      <li v-for="item in view.items" :key="item.uid">
        <strong>{{ item.label }}</strong>
        <span>{{ item.dimensions }}</span>
        <code :title="item.assetVersionUid">{{ shortUid(item.assetVersionUid) }}</code>
      </li>
    </ol>
  </section>
</template>

<script setup>
import { computed } from 'vue'

import { characterReferencePackageView } from '../../assets/characterReferencePackage.js'

const props = defineProps({
  packageRecord: {
    type: Object,
    required: true,
  },
})

const view = computed(() => characterReferencePackageView(props.packageRecord))

function shortUid(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}
</script>

<style scoped>
.reference-package {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 14px;
  background: var(--el-bg-color);
}

.reference-package__header,
.reference-package__summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.reference-package__header h3,
.reference-package__summary h4,
.reference-package__summary p,
.reference-package__eyebrow {
  margin: 0;
}

.reference-package__eyebrow,
.reference-package__version,
.reference-package__items span,
.reference-package__items code {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.reference-package__version {
  align-self: start;
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.reference-package__summary article {
  flex: 1;
  min-width: 0;
  padding: 12px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}

.reference-package__summary p {
  margin-top: 6px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.reference-package__colors {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.reference-package__colors span {
  width: 18px;
  height: 18px;
  border: 1px solid rgb(0 0 0 / 12%);
  border-radius: 50%;
}

.reference-package__items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.reference-package__items li {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 9px;
}

@media (max-width: 700px) {
  .reference-package__summary {
    flex-direction: column;
  }
}
</style>
