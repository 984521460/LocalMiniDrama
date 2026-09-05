import request from './workflowRequest.js'
import {
  remoteConnectionCreatePayload,
  remoteConnectionUidPath,
  remoteConnectionUpdatePayload,
  remoteCredentialReplacementPayload,
} from '../../remote/connectionProfile.js'
import {
  hostIdentityConfirmationPayload,
  hostIdentityProbeView,
} from '../../remote/hostIdentity.js'
import {
  expertTunnelClosedView,
  expertTunnelRequestPayload,
  expertTunnelView,
} from '../../components/remote/expertTunnelContract.js'
import {
  environmentReportView,
  initializationPlanView,
  initializationRequestPayload,
  initializationResultView,
  modelVerificationRequestPayload,
} from '../../components/remote/environmentContract.js'

export const remoteConnectionAPI = Object.freeze({
  list() {
    return request.get('/v2/remote-connections')
  },

  get(connectionUid) {
    return request.get(`/v2/remote-connections/${remoteConnectionUidPath(connectionUid)}`)
  },

  create(form) {
    return request.post('/v2/remote-connections', remoteConnectionCreatePayload(form))
  },

  update(record, form) {
    return request.put(
      `/v2/remote-connections/${remoteConnectionUidPath(record.uid)}`,
      remoteConnectionUpdatePayload(record, form),
    )
  },

  replaceCredential(record, password) {
    return request.put(
      `/v2/remote-connections/${remoteConnectionUidPath(record.uid)}/credential`,
      remoteCredentialReplacementPayload(record, password),
    )
  },

  async probeHostIdentity(connectionUid) {
    return hostIdentityProbeView(await request.post(
      `/v2/remote-connections/${remoteConnectionUidPath(connectionUid)}/host-identity/probe`,
      {},
    ))
  },

  async confirmHostIdentity(candidate) {
    return hostIdentityProbeView(await request.post(
      `/v2/remote-connections/${remoteConnectionUidPath(candidate.connectionUid)}/host-identity/confirm`,
      hostIdentityConfirmationPayload(candidate),
    ))
  },

  async openExpertTunnel(connectionUid) {
    const uid = remoteConnectionUidPath(connectionUid)
    return expertTunnelView(await request.post(
      `/v2/remote-connections/${uid}/expert-tunnel`,
      expertTunnelRequestPayload({}),
    ), uid)
  },

  async closeExpertTunnel(connectionUid) {
    const uid = remoteConnectionUidPath(connectionUid)
    return expertTunnelClosedView(await request.delete(
      `/v2/remote-connections/${uid}/expert-tunnel`,
    ), uid)
  },

  async getEnvironmentReport(connectionUid) {
    const uid = remoteConnectionUidPath(connectionUid)
    return environmentReportView(await request.get(
      `/v2/remote-connections/${uid}/environment-report`,
    ))
  },

  async getInitializationPlan(connectionUid) {
    const uid = remoteConnectionUidPath(connectionUid)
    const plan = initializationPlanView(await request.get(
      `/v2/remote-connections/${uid}/initialization-plan`,
    ))
    if (plan.connectionUid !== uid) throw new TypeError('Remote environment data is invalid')
    return plan
  },

  async initializeEnvironment(connectionUid, plan) {
    const uid = remoteConnectionUidPath(connectionUid)
    return initializationResultView(await request.post(
      `/v2/remote-connections/${uid}/initialize`,
      initializationRequestPayload(plan),
    ), plan)
  },

  async verifyEnvironmentModels(connectionUid, plan) {
    const uid = remoteConnectionUidPath(connectionUid)
    return initializationResultView(await request.post(
      `/v2/remote-connections/${uid}/verify-models`,
      modelVerificationRequestPayload(plan),
    ), plan)
  },
})
