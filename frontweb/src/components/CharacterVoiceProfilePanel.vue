<template>
  <div class="voice-profile-panel" v-loading="loading">
    <el-alert
      v-if="!canLoad"
      type="warning"
      :closable="false"
      title="当前角色缺少 v2 身份标识，无法配置固定音色。"
    />
    <template v-else>
      <div class="voice-profile-panel__intro">
        <div>
          <strong>{{ characterName }}</strong>
          <span>按顺序创建身份版本、音色版本和 Voice Profile。</span>
        </div>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
      <el-alert
        type="info"
        :closable="false"
        title="这里只保存凭据引用，不保存密钥。Profile 创建与激活时都会重新核验本机凭据。"
      />

      <el-tabs v-model="activeTab" class="voice-profile-panel__tabs">
        <el-tab-pane label="1. 身份版本" name="identity">
          <el-form label-position="top" class="voice-profile-panel__form">
            <el-form-item label="版本名称">
              <el-input v-model="identityForm.name" maxlength="120" placeholder="例如：主角正式设定" />
            </el-form-item>
            <el-form-item label="视觉身份描述">
              <el-input
                v-model="identityForm.visualSignature"
                type="textarea"
                :rows="3"
                maxlength="4000"
                placeholder="明确填写稳定外貌特征；系统不会自动编造身份事实"
              />
            </el-form-item>
            <el-form-item label="色彩锚点">
              <el-input v-model="identityForm.colorAnchors" placeholder="#112233, #aabbcc" />
            </el-form-item>
            <el-button type="primary" :loading="saving === 'identity'" @click="createIdentity">
              创建身份版本
            </el-button>
          </el-form>
          <version-list title="已有身份版本" :items="identityItems" empty-text="尚未创建身份版本" />
        </el-tab-pane>

        <el-tab-pane label="2. 音色版本" name="voice" :disabled="!state?.identityVersions.length">
          <el-form label-position="top" class="voice-profile-panel__form">
            <el-form-item label="绑定身份版本">
              <el-select v-model="voiceForm.identityVersionUid" style="width: 100%" placeholder="选择身份版本">
                <el-option
                  v-for="item in state?.identityVersions || []"
                  :key="item.uid"
                  :label="`${item.metadata.name} · ${shortUid(item.uid)}`"
                  :value="item.uid"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="音色版本名称">
              <el-input v-model="voiceForm.name" maxlength="120" placeholder="例如：普通话沉稳声线" />
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="语言">
                  <el-input v-model="voiceForm.language" maxlength="16" placeholder="zh-CN" />
                </el-form-item>
              </el-col>
              <el-col :span="16">
                <el-form-item label="演绎风格">
                  <el-input v-model="voiceForm.style" maxlength="1000" placeholder="沉稳、克制、清晰" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-button type="primary" :loading="saving === 'voice'" @click="createVoice">
              创建音色版本
            </el-button>
          </el-form>
          <version-list title="已有音色版本" :items="voiceItems" empty-text="尚未创建音色版本" />
        </el-tab-pane>

        <el-tab-pane label="3. Voice Profile" name="profile" :disabled="!state?.voiceVersions.length">
          <el-form label-position="top" class="voice-profile-panel__form">
            <el-form-item label="绑定音色版本">
              <el-select v-model="profileForm.characterVoiceVersionUid" style="width: 100%" placeholder="选择音色版本">
                <el-option
                  v-for="item in state?.voiceVersions || []"
                  :key="item.uid"
                  :label="`${item.metadata.name} · ${shortUid(item.uid)}`"
                  :value="item.uid"
                />
              </el-select>
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="Provider">
                  <el-select v-model="profileForm.provider" style="width: 100%">
                    <el-option label="OpenAI compatible" value="openai-compatible" />
                    <el-option label="MiniMax" value="minimax" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="模型">
                  <el-input v-model="profileForm.model" maxlength="128" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="音色 ID">
                  <el-input v-model="profileForm.voiceKey" maxlength="128" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="凭据引用 credentialRef">
              <el-input
                v-model="profileForm.credentialRef"
                maxlength="50"
                autocomplete="off"
                placeholder="credential:v1:…（在 AI 配置中创建）"
              />
            </el-form-item>
            <el-row :gutter="12">
              <el-col v-for="emotion in emotions" :key="emotion" :span="8">
                <el-form-item :label="emotionLabels[emotion]">
                  <el-input v-model="profileForm.emotionMap[emotion]" maxlength="64" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="12">
              <el-col :span="8"><el-form-item label="最低语速‰"><el-input-number v-model="profileForm.minimumSpeedPermille" :min="500" :max="2000" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="默认语速‰"><el-input-number v-model="profileForm.defaultSpeedPermille" :min="500" :max="2000" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="最高语速‰"><el-input-number v-model="profileForm.maximumSpeedPermille" :min="500" :max="2000" /></el-form-item></el-col>
            </el-row>
            <el-button type="primary" :loading="saving === 'profile'" @click="createProfile">
              创建 Voice Profile
            </el-button>
          </el-form>

          <div class="voice-profile-panel__profiles">
            <div v-if="!state?.profiles.length" class="voice-profile-panel__empty">尚未创建 Voice Profile</div>
            <div v-for="profile in state?.profiles || []" :key="profile.uid" class="voice-profile-panel__profile">
              <div>
                <strong>修订 {{ profile.revision }} · {{ profile.provider }}</strong>
                <div>{{ profile.model }} / {{ profile.voiceKey }}</div>
                <small>凭据已绑定（创建时验证） · {{ shortUid(profile.uid) }}</small>
              </div>
              <el-tag v-if="state?.active?.profileUid === profile.uid" type="success">当前激活</el-tag>
              <el-button
                v-else
                size="small"
                :loading="saving === profile.uid"
                @click="activate(profile.uid)"
              >激活</el-button>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { voiceProfileAPI } from '@/api/v2/voiceProfiles'

const props = defineProps({
  dramaUid: { type: String, required: true },
  character: { type: Object, required: true },
})

const emotions = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised'])
const emotionLabels = Object.freeze({
  neutral: '中性', happy: '开心', sad: '悲伤', angry: '愤怒',
  fearful: '恐惧', surprised: '惊讶',
})

const VersionList = defineComponent({
  props: {
    title: { type: String, required: true },
    items: { type: Array, required: true },
    emptyText: { type: String, required: true },
  },
  setup(componentProps) {
    return () => h('div', { class: 'voice-profile-panel__versions' }, [
      h('h4', componentProps.title),
      componentProps.items.length === 0
        ? h('div', { class: 'voice-profile-panel__empty' }, componentProps.emptyText)
        : componentProps.items.map((item) => h('div', {
          class: 'voice-profile-panel__version', key: item.uid,
        }, [h('strong', item.title), h('small', item.detail)])),
    ])
  },
})

const loading = ref(false)
const saving = ref('')
const activeTab = ref('identity')
const state = ref(null)
const canLoad = computed(() => Boolean(props.dramaUid && props.character?.uid))
const characterName = computed(() => props.character?.name || '未命名角色')

const identityForm = reactive({ name: '', visualSignature: '', colorAnchors: '#808080' })
const voiceForm = reactive({ identityVersionUid: '', name: '', language: 'zh-CN', style: '' })
const profileForm = reactive({
  characterVoiceVersionUid: '', provider: 'openai-compatible',
  model: 'gpt-4o-mini-tts', voiceKey: 'alloy', credentialRef: '',
  defaultEmotion: 'neutral',
  emotionMap: {
    neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
    fearful: 'fearful', surprised: 'surprised',
  },
  minimumSpeedPermille: 500, defaultSpeedPermille: 1000, maximumSpeedPermille: 2000,
})

const identityItems = computed(() => (state.value?.identityVersions || []).map((item) => ({
  uid: item.uid,
  title: item.metadata.name,
  detail: `${item.metadata.visualSignature} · ${shortUid(item.uid)}`,
})))
const voiceItems = computed(() => (state.value?.voiceVersions || []).map((item) => ({
  uid: item.uid,
  title: item.metadata.name,
  detail: `${item.metadata.language} / ${item.metadata.style} · ${shortUid(item.uid)}`,
})))

function shortUid(value) {
  return typeof value === 'string' ? value.slice(0, 8) : ''
}

function seedForms() {
  identityForm.name = identityForm.name || props.character?.name || ''
  identityForm.visualSignature = identityForm.visualSignature
    || props.character?.appearance || props.character?.description || ''
  if (!voiceForm.name) voiceForm.name = `${props.character?.name || '角色'}普通话音色`
  if (!voiceForm.style) voiceForm.style = props.character?.voice_style || '自然、清晰'
  if (!voiceForm.identityVersionUid && state.value?.identityVersions.length) {
    voiceForm.identityVersionUid = state.value.identityVersions.at(-1).uid
  }
  if (!profileForm.characterVoiceVersionUid && state.value?.voiceVersions.length) {
    profileForm.characterVoiceVersionUid = state.value.voiceVersions.at(-1).uid
  }
}

function message(_error, fallback) {
  ElMessage.error(fallback)
}

async function load() {
  if (!canLoad.value) return
  loading.value = true
  try {
    state.value = await voiceProfileAPI.getConfiguration(props.dramaUid, props.character.uid)
    seedForms()
  } catch (error) {
    message(error, '音色配置加载失败')
  } finally {
    loading.value = false
  }
}

function colors() {
  return identityForm.colorAnchors.split(',').map((value) => value.trim()).filter(Boolean)
}

async function createIdentity() {
  saving.value = 'identity'
  try {
    const existing = state.value?.identityVersions || []
    await voiceProfileAPI.createIdentityVersion(props.dramaUid, props.character.uid, {
      parentUid: existing.at(-1)?.uid ?? null,
      expectedVersionCount: existing.length,
      name: identityForm.name,
      visualSignature: identityForm.visualSignature,
      colorAnchors: colors(),
    })
    await load()
    activeTab.value = 'voice'
    ElMessage.success('身份版本已创建')
  } catch (error) {
    message(error, '身份版本创建失败')
  } finally {
    saving.value = ''
  }
}

async function createVoice() {
  saving.value = 'voice'
  try {
    const existing = state.value?.voiceVersions || []
    const related = existing.filter((item) => item.identityVersionUid === voiceForm.identityVersionUid)
    await voiceProfileAPI.createVoiceVersion(props.dramaUid, props.character.uid, {
      identityVersionUid: voiceForm.identityVersionUid,
      parentUid: related.at(-1)?.uid ?? null,
      expectedVersionCount: existing.length,
      name: voiceForm.name,
      language: voiceForm.language,
      style: voiceForm.style,
    })
    await load()
    activeTab.value = 'profile'
    ElMessage.success('音色版本已创建')
  } catch (error) {
    message(error, '音色版本创建失败')
  } finally {
    saving.value = ''
  }
}

async function createProfile() {
  saving.value = 'profile'
  try {
    const existing = state.value?.profiles || []
    await voiceProfileAPI.createProfile(props.dramaUid, props.character.uid, {
      characterVoiceVersionUid: profileForm.characterVoiceVersionUid,
      parentUid: existing.at(-1)?.uid ?? null,
      expectedRevision: existing.length,
      provider: profileForm.provider,
      model: profileForm.model,
      voiceKey: profileForm.voiceKey,
      credentialRef: profileForm.credentialRef,
      defaultEmotion: profileForm.defaultEmotion,
      emotionMap: { ...profileForm.emotionMap },
      minimumSpeedPermille: profileForm.minimumSpeedPermille,
      defaultSpeedPermille: profileForm.defaultSpeedPermille,
      maximumSpeedPermille: profileForm.maximumSpeedPermille,
    })
    profileForm.credentialRef = ''
    await load()
    ElMessage.success('Voice Profile 已创建并通过凭据核验')
  } catch (error) {
    message(error, 'Voice Profile 创建失败：请核对凭据引用与当前凭据状态')
  } finally {
    saving.value = ''
  }
}

async function activate(profileUid) {
  saving.value = profileUid
  try {
    await voiceProfileAPI.activateProfile(props.dramaUid, props.character.uid, profileUid, {
      expectedStateVersion: state.value?.active?.stateVersion ?? 0,
    })
    await load()
    ElMessage.success('固定音色已激活并重新通过凭据核验')
  } catch (error) {
    message(error, 'Voice Profile 激活失败：请刷新并核对当前凭据状态')
  } finally {
    saving.value = ''
  }
}

watch(() => props.character?.uid, () => {
  state.value = null
  activeTab.value = 'identity'
  load()
})
onMounted(load)
</script>

<style scoped>
.voice-profile-panel { min-height: 260px; }
.voice-profile-panel__intro { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 12px; }
.voice-profile-panel__intro div { display: flex; flex-direction: column; gap: 4px; }
.voice-profile-panel__intro span, .voice-profile-panel small { color: var(--text-secondary, #71717a); }
.voice-profile-panel__tabs { margin-top: 14px; }
.voice-profile-panel__form { padding: 4px 2px 16px; }
.voice-profile-panel__versions, .voice-profile-panel__profiles { margin-top: 18px; border-top: 1px solid var(--border-color, #e4e4e7); padding-top: 12px; }
.voice-profile-panel__version, .voice-profile-panel__profile { display: flex; justify-content: space-between; gap: 14px; padding: 10px 12px; margin-top: 8px; border: 1px solid var(--border-color, #e4e4e7); border-radius: 8px; }
.voice-profile-panel__version { flex-direction: column; gap: 3px; }
.voice-profile-panel__profile > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.voice-profile-panel__empty { color: var(--text-secondary, #71717a); padding: 14px 0; }
</style>
