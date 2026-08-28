import { workflowJsonTextRequest } from './workflowRequest.js'
import {
  h3ExecutionIntentView,
  h3ProfileView,
  h3RealValidationMatrixView,
} from '../../h3/contracts.js'

export const h3API = Object.freeze({
  async status() {
    const profile = h3ProfileView(await workflowJsonTextRequest.get('/v2/h3/profile'))
    const validation = h3RealValidationMatrixView(
      await workflowJsonTextRequest.get('/v2/h3/real-validation'),
      profile.uid,
    )
    return Object.freeze({ profile, validation })
  },
  async prepareT2VIntent(input) {
    return h3ExecutionIntentView(
      await workflowJsonTextRequest.post('/v2/h3/prepare-t2v-intent', input),
    )
  },
})
