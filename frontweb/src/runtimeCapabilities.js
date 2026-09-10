import { ref, computed } from "vue";
export const runtimeCapabilities = ref(null);
export const offlineSafe = computed(() => runtimeCapabilities.value?.mode === "offline-safe");
export const capabilitiesReady = computed(() => runtimeCapabilities.value !== null);
export const generationAllowed = computed(() => runtimeCapabilities.value?.generation === true);
export const reviewAllowed = computed(() => runtimeCapabilities.value?.review === true);
let pending = null;
export async function loadRuntimeCapabilities() {
  if (!pending) pending = (async () => {
    try {
      const response = await fetch("/api/v1/runtime-capabilities");
      const body = await response.json();
      if (response.ok && body.data?.schemaVersion === "runtime-capabilities.v1") runtimeCapabilities.value = body.data;
    } catch { /* Unknown capability never enables a paid or review action. */ }
  })();
  return pending;
}
