import { ref } from 'vue'

import { mvpBenchmarkAuthorizationAPI } from '../api/v2/mvpBenchmarkAuthorization.js'
import { mvpBenchmarkAuthorizationSeed, mvpBenchmarkAuthorizationView } from '../benchmark/mvpAuthorization.js'
import { createLatestRequestGuard } from '../components/narrative/narrativeReview.js'

const ERROR_CODE = 'MVP_BENCHMARK_AUTHORIZATION_REQUEST_FAILED'
const ARRAY_IS_ARRAY = Array.isArray
const OBJECT_DEFINE_PROPERTY = Object.defineProperty

function append(target, value) {
  Reflect.apply(OBJECT_DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  }])
}

export function createMvpBenchmarkAuthorizationState({
  listConnections,
  createAuthorization,
}) {
  if (typeof listConnections !== 'function' || typeof createAuthorization !== 'function') {
    throw new TypeError('MVP benchmark authorization state is invalid')
  }
  const authorization = ref(null)
  const connections = ref(Object.freeze([]))
  const busy = ref(false)
  const error = ref(null)
  const connectionGuard = createLatestRequestGuard()
  const authorizationGuard = createLatestRequestGuard()

  async function refreshConnections() {
    const token = connectionGuard.begin()
    busy.value = true
    error.value = null
    try {
      const source = await listConnections()
      if (!ARRAY_IS_ARRAY(source)) throw new TypeError('MVP benchmark authorization state is invalid')
      const ready = []
      for (let index = 0; index < source.length; index += 1) {
        const connection = source[index]
        if (connection?.status === 'ready' && connection.credentialConfigured === true) {
          append(ready, connection)
        }
      }
      if (!connectionGuard.isCurrent(token)) return false
      connections.value = Object.freeze(ready)
      return true
    } catch {
      if (!connectionGuard.isCurrent(token)) return false
      connections.value = Object.freeze([])
      error.value = ERROR_CODE
      return false
    } finally {
      if (connectionGuard.isCurrent(token)) busy.value = false
    }
  }

  async function authorize(session, connectionUid, seedValue) {
    const token = authorizationGuard.begin()
    busy.value = true
    error.value = null
    try {
      const seed = mvpBenchmarkAuthorizationSeed(seedValue)
      let connection = null
      for (let index = 0; index < connections.value.length; index += 1) {
        if (connections.value[index]?.uid === connectionUid) connection = connections.value[index]
      }
      if (!connection) throw new TypeError('MVP benchmark authorization state is invalid')
      const result = mvpBenchmarkAuthorizationView(
        await createAuthorization(session, connection, seed),
        {
          dramaUid: session?.dramaUid,
          sessionUid: session?.uid,
          sessionPlanSha256: session?.planSha256,
          connectionUid,
          connectionEvidenceSha256: connection.connectionEvidenceSha256,
          maximumCostCnyFen: seed.maximumCostCnyFen,
          validityDurationMs: seed.validityDurationMs,
          operatorAttestation: seed.operatorAttestation,
        },
      )
      if (!authorizationGuard.isCurrent(token)) return false
      authorization.value = result
      return true
    } catch {
      if (!authorizationGuard.isCurrent(token)) return false
      authorization.value = null
      error.value = ERROR_CODE
      return false
    } finally {
      if (authorizationGuard.isCurrent(token)) busy.value = false
    }
  }

  function invalidate() {
    connectionGuard.invalidate()
    authorizationGuard.invalidate()
    authorization.value = null
    connections.value = Object.freeze([])
    busy.value = false
    error.value = null
  }

  return Object.freeze({ authorization, connections, busy, error, refreshConnections, authorize, invalidate })
}

export function useMvpBenchmarkAuthorization({ api = mvpBenchmarkAuthorizationAPI } = {}) {
  return createMvpBenchmarkAuthorizationState({
    listConnections: () => api.listConnections(),
    createAuthorization: (session, connection, seed) => (
      api.createAuthorization(session, connection, seed)
    ),
  })
}
