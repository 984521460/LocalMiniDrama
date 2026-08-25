export const PRODUCT_IDENTITY = Object.freeze({
  displayName: 'AI漫剧工作台',
  legacyName: 'LocalMiniDrama',
  appId: 'com.localminidrama.desktop',
  userDataDirectory: 'localminidrama-desktop',
})

export const PRODUCT_NAME = PRODUCT_IDENTITY.displayName
export const PRODUCT_LEGACY_NAME = PRODUCT_IDENTITY.legacyName

export function formatDocumentTitle(pageTitle) {
  const normalizedPageTitle = String(pageTitle ?? '').trim()
  return normalizedPageTitle
    ? `${normalizedPageTitle} - ${PRODUCT_NAME}`
    : PRODUCT_NAME
}
