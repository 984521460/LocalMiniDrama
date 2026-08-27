import request from '@/utils/request'

export const sourceDocumentAPI = {
  importDocument(dramaId, file, encoding) {
    const form = new FormData()
    form.append('file', file)
    if (encoding) form.append('encoding', encoding)
    return request.post(`/v2/dramas/${dramaId}/source-documents`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },

  list(dramaId) {
    return request.get(`/v2/dramas/${dramaId}/source-documents`)
  },

  get(documentUid) {
    return request.get(`/v2/source-documents/${documentUid}`)
  },

  createSelection(documentUid, selection) {
    return request.post(`/v2/source-documents/${documentUid}/selections`, {
      start_block_uid: selection.startBlockUid,
      end_block_uid: selection.endBlockUid,
      start_offset: selection.startOffset,
      end_offset: selection.endOffset,
    })
  },
}
