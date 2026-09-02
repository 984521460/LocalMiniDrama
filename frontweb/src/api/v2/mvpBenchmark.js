import { mvpBenchmarkReadinessView } from '../../benchmark/mvpReadiness.js'
import { parseStrictJson } from '../../security/strictJson.js'
import { workflowJsonTextRequest } from './workflowRequest.js'

export const mvpBenchmarkAPI = Object.freeze({
  async getReadiness() {
    const text = await workflowJsonTextRequest.get('/v2/mvp-benchmark/readiness')
    return mvpBenchmarkReadinessView(parseStrictJson(text))
  },
})
