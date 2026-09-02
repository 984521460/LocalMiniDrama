import { parseStrictJson } from '../../security/strictJson.js'
import {
  characterIdentityVersionView,
  characterVoiceVersionView,
  createIdentityVersionRequest,
  createVoiceProfileActivationRequest,
  createVoiceProfileRequest,
  createVoiceVersionRequest,
  voiceConfigurationPath,
  voiceProfileActivationResultView,
  voiceProfileConfigurationView,
  voiceProfileUidPath,
  voiceProfileView,
} from '../../audio/voiceProfileConfiguration.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

function parsed(operation, view) {
  return operation.then((text) => view(parseStrictJson(text)))
}

export const voiceProfileAPI = Object.freeze({
  getConfiguration(dramaUid, characterUid) {
    const root = voiceConfigurationPath(dramaUid, characterUid)
    return parsed(
      workflowJsonTextRequest.get(`${root}/voice-configuration`),
      voiceProfileConfigurationView,
    )
  },

  createIdentityVersion(dramaUid, characterUid, input) {
    const root = voiceConfigurationPath(dramaUid, characterUid)
    return parsed(
      workflowJsonTextRequest.post(`${root}/identity-versions`, createIdentityVersionRequest(input)),
      characterIdentityVersionView,
    )
  },

  createVoiceVersion(dramaUid, characterUid, input) {
    const root = voiceConfigurationPath(dramaUid, characterUid)
    return parsed(
      workflowJsonTextRequest.post(`${root}/voice-versions`, createVoiceVersionRequest(input)),
      characterVoiceVersionView,
    )
  },

  createProfile(dramaUid, characterUid, input) {
    const root = voiceConfigurationPath(dramaUid, characterUid)
    return parsed(
      workflowJsonTextRequest.post(`${root}/voice-profiles`, createVoiceProfileRequest(input)),
      voiceProfileView,
    )
  },

  activateProfile(dramaUid, characterUid, profileUid, input) {
    const root = voiceConfigurationPath(dramaUid, characterUid)
    const profilePath = voiceProfileUidPath(profileUid)
    return parsed(
      workflowJsonTextRequest.post(
        `${root}/voice-profiles/${profilePath}/activate`,
        createVoiceProfileActivationRequest(input),
      ),
      voiceProfileActivationResultView,
    )
  },
})
