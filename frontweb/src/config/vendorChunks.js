const ELEMENT_PLUS_SEGMENTS = Object.freeze([
  '/node_modules/element-plus/',
  '/node_modules/@element-plus/icons-vue/',
])

const VUE_RUNTIME_SEGMENTS = Object.freeze([
  '/node_modules/@vue/',
  '/node_modules/vue/',
  '/node_modules/vue-router/',
  '/node_modules/pinia/',
])

export function vendorChunkName(moduleId) {
  if (typeof moduleId !== 'string') return undefined
  const normalized = moduleId.replaceAll('\\', '/')
  if (ELEMENT_PLUS_SEGMENTS.some((segment) => normalized.includes(segment))) {
    return 'element-plus'
  }
  if (VUE_RUNTIME_SEGMENTS.some((segment) => normalized.includes(segment))) {
    return 'vue-runtime'
  }
  return undefined
}
