import request from '../../utils/request.js'

export const narrativeReviewAPI = {
  listForDrama(dramaId) {
    return request.get(`/v2/dramas/${dramaId}/narrative-results`)
  },

  get(resultUid) {
    return request.get(`/v2/narrative-results/${resultUid}`)
  },

  review(resultUid, decision, comment) {
    return request.post(`/v2/narrative-results/${resultUid}/reviews`, {
      decision,
      ...(comment ? { comment } : {}),
    })
  },
}
