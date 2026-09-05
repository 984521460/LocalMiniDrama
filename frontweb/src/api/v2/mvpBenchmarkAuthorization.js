import { mvpBenchmarkAuthorizationSeed, mvpBenchmarkAuthorizationView } from '../../benchmark/mvpAuthorization.js'
import { mvpBenchmarkSessionView } from '../../benchmark/mvpSession.js'
import { remoteConnectionListView, remoteConnectionView } from '../../remote/connectionProfile.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

export const mvpBenchmarkAuthorizationAPI = Object.freeze({
  async listConnections() {
    return remoteConnectionListView(parseStrictJson(
      await workflowJsonTextRequest.get('/v2/remote-connections'),
    ))
  },

  async createAuthorization(sessionValue, connectionValue, seedValue) {
    const session = mvpBenchmarkSessionView(sessionValue)
    const connection = remoteConnectionView(connectionValue)
    const seed = mvpBenchmarkAuthorizationSeed(seedValue)
    const text = await workflowJsonTextRequest.post(
      `/v2/dramas/${encodeURIComponent(session.dramaUid)}/mvp-benchmark/sessions/${encodeURIComponent(session.uid)}/connections/${encodeURIComponent(connection.uid)}/authorization`,
      seed,
    )
    return mvpBenchmarkAuthorizationView(parseStrictJson(text), {
      dramaUid: session.dramaUid,
      sessionUid: session.uid,
      sessionPlanSha256: session.planSha256,
      connectionUid: connection.uid,
      connectionEvidenceSha256: connection.connectionEvidenceSha256,
      maximumCostCnyFen: seed.maximumCostCnyFen,
      validityDurationMs: seed.validityDurationMs,
      operatorAttestation: seed.operatorAttestation,
    })
  },
})
