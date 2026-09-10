import { workflowJsonTextRequest } from "../api/v2/workflowRequest.js";
import { parseStrictJson } from "../security/strictJson.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid() {
  throw new TypeError("Character recovery response is invalid");
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(d).length !== keys.length || keys.some((k) => !d[k]?.enumerable || !Object.hasOwn(d[k], "\
value"))) invalid();
}
export function recoveryView(value) {
  exact(value, ["schemaVersion", "operationUid", "dramaUid", "characterUid", "requestedCount", "receivedCount",
  "state", "sourceCurrent", "connectionCurrent", "recoveryEnabled", "bindingState", "batchReady", "canRecover",
  "quarantineStatus", "jobs", "items"]);
  if (!["bound", "needs_rebind"].includes(value.bindingState)) invalid();
  if (typeof value.recoveryEnabled !== "boolean" || !(value.connectionCurrent === null || typeof value.connectionCurrent ===
  "boolean")) invalid();
  if (value.schemaVersion !== "character-candidate-recovery.v1" || ![value.operationUid, value.dramaUid, value.
  characterUid].every((x) => uuid.test(x)) || value.requestedCount !== 4 || !["collected", "partial", "recover\
able", "submission_unknown"].includes(value.state) || value.quarantineStatus !== "unapproved" || !["sourceCurr\
ent", "batchReady", "canRecover"].every((k) => typeof value[k] === "boolean") || !Array.isArray(value.jobs) ||
  value.jobs.length !== 4 || !Array.isArray(value.items) || value.items.length > 4 || value.receivedCount !== value.
  items.length) invalid();
  value.jobs.forEach((j, index) => {
    exact(j, ["ordinal", "state"]);
    if (j.ordinal !== index || !["not_submitted", "submitting", "submitted", "output_bound", "collected"].includes(
    j.state)) invalid();
  });
  const seen = /* @__PURE__ */ new Set();
  value.items.forEach((item) => {
    exact(item, ["ordinal", "assetUid", "assetVersionUid", "logicalUri", "relativePath", "contentSha256", "byt\
eLength", "width", "height"]);
    const relative = `characters/${value.characterUid}/candidate-batches/${value.operationUid}/${item.ordinal}\
.png`;
    if (!Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal > 3 || seen.has(item.ordinal) || !uuid.
    test(item.assetUid) || !uuid.test(item.assetVersionUid) || item.relativePath !== relative || item.logicalUri !==
    `asset://characters/${value.characterUid}/candidate-batches/${value.operationUid}/${item.ordinal}` || !/^[0-9a-f]{64}$/.
    test(item.contentSha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength >
    16777216 || ![item.width, item.height].every((n) => Number.isInteger(n) && n >= 256 && n <= 2048) || value.
    jobs[item.ordinal].state !== "collected") invalid();
    seen.add(item.ordinal);
  });
  if (value.batchReady && value.receivedCount !== 4) invalid();
  return Object.freeze(value);
}
function base(dramaId, characterUid) {
  if (!Number.isSafeInteger(dramaId) || dramaId < 1 || !uuid.test(characterUid)) invalid();
  return `/v2/dramas/${dramaId}/characters/${characterUid}/candidate-recoveries`;
}
export const characterRecoveryAPI = Object.freeze({
  async list(dramaId, characterUid) {
    const value = parseStrictJson(await workflowJsonTextRequest.get(base(dramaId, characterUid)));
    exact(value, ["schemaVersion", "records"]);
    if (value.schemaVersion !== "character-candidate-recovery-list.v1" || !Array.isArray(value.records) || value.
    records.length > 50) invalid();
    return value.records.map((r) => {
      const item = recoveryView(r);
      if (item.characterUid !== characterUid) invalid();
      return item;
    });
  },
  async recover(dramaId, characterUid, operationUid) {
    if (!uuid.test(operationUid)) invalid();
    const value = recoveryView(parseStrictJson(await workflowJsonTextRequest.post(`${base(dramaId, characterUid)}\
/${operationUid}/recover`, {})));
    if (value.characterUid !== characterUid || value.operationUid !== operationUid) invalid();
    return value;
  }
});
