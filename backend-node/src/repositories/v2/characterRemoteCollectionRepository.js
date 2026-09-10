"use strict";
const { createHash } = require("node:crypto");
const { parseCharacterCandidateExecutionRequestJson } = require("../../characterCandidates/execution/request");
const { canonicalCharacterCandidateSource, parseCharacterCandidateSourceJson, characterCandidateSourceSha256 } = require(
"../../characterCandidates/execution/source");
const hash = (s) => createHash("sha256").update(s).digest("hex");
function createCharacterRemoteCollectionRepository(database) {
  function get(uid) {
    const row = database.prepare("SELECT * FROM character_remote_collections WHERE operation_uid=?").get(uid);
    if (!row) return null;
    const request = parseCharacterCandidateExecutionRequestJson(row.request_json);
    if (hash(row.request_json) !== row.request_sha256 || request.operationUid !== uid || request.dramaUid !== row.
    drama_uid || request.characterUid !== row.character_uid) throw Error("Remote collection data invalid");
    const source = parseCharacterCandidateSourceJson(row.source_json);
    if (characterCandidateSourceSha256(source) !== row.source_sha256) throw Error("Remote collection source in\
valid");
    return {
      request,
      requestSha256: row.request_sha256,
      sourceSha256: row.source_sha256,
      binding: JSON.parse(row.binding_json),
      bindingState: row.binding_state,
      source,
      createdAt: row.created_at,
      jobs: database.prepare("SELECT * FROM character_remote_collection_jobs WHERE operation_uid=? ORDER BY or\
dinal").all(uid).map((j) => ({ ordinal: j.ordinal, state: j.state, promptSha256: j.prompt_sha256, promptId: j.
      prompt_id, output: j.output_json ? JSON.parse(j.output_json) : null, item: j.item_json ? JSON.parse(j.item_json) :
      null }))
    };
  }
  function transition(sql, args) {
    if (database.prepare(sql).run(...args).changes !== 1) throw Error("Remote collection transition conflict");
  }
  return Object.freeze({
    get,
    isComplete(uid) {
      return database.prepare("SELECT state FROM character_candidate_executions WHERE operation_uid=?").pluck().
      get(uid) === "succeeded";
    },
    pathHasVersion(relativePath) {
      return Boolean(database.prepare("SELECT 1 FROM asset_versions WHERE relative_path=? LIMIT 1").get(relativePath));
    },
    create(requestJson, sourceSha256, binding, source) {
      const request = parseCharacterCandidateExecutionRequestJson(requestJson);
      database.prepare("INSERT INTO character_remote_collections(operation_uid,drama_uid,character_uid,request\
_json,request_sha256,source_sha256,source_json,binding_json) VALUES (?,?,?,?,?,?,?,?)").run(request.operationUid,
      request.dramaUid, request.characterUid, requestJson, hash(requestJson), sourceSha256, canonicalCharacterCandidateSource(
      source), JSON.stringify(binding));
      return get(request.operationUid);
    },
    begin(uid, ordinal, promptSha256) {
      database.prepare("INSERT INTO character_remote_collection_jobs(operation_uid,ordinal,state,prompt_sha256\
) VALUES (?,?,'submitting',?)").run(uid, ordinal, promptSha256);
    },
    accepted(uid, ordinal, promptId) {
      if (typeof promptId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(promptId)) throw Error("Invalid acc\
epted prompt");
      transition("UPDATE character_remote_collection_jobs SET state='submitted',prompt_id=? WHERE operation_ui\
d=? AND ordinal=? AND state='submitting'", [promptId, uid, ordinal]);
    },
    bindOutput(uid, ordinal, output) {
      const job = get(uid).jobs.find((j) => j.ordinal === ordinal);
      if (job.output) {
        if (JSON.stringify(job.output) !== JSON.stringify(output)) throw Error("Remote output drift");
        return;
      }
      transition("UPDATE character_remote_collection_jobs SET state='output_bound',output_json=? WHERE operati\
on_uid=? AND ordinal=? AND state='submitted'", [JSON.stringify(output), uid, ordinal]);
    },
    collected(uid, ordinal, item) {
      transition("UPDATE character_remote_collection_jobs SET state='collected',item_json=? WHERE operation_ui\
d=? AND ordinal=? AND state='output_bound'", [JSON.stringify(item), uid, ordinal]);
    },
    list(dramaUid, characterUid) {
      return database.prepare("SELECT operation_uid FROM character_remote_collections WHERE drama_uid=? AND ch\
aracter_uid=? ORDER BY created_at DESC,operation_uid DESC LIMIT 50").all(dramaUid, characterUid).map((r) => get(
      r.operation_uid));
    }
  });
}
module.exports = { createCharacterRemoteCollectionRepository };
