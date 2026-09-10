"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { types: { isProxy } } = require("node:util");
const { trustedLoopbackOrigin } = require('../security/localV2OriginBoundary');
function invalid() {
  const error = new Error("Offline-safe startup requires an explicit isolated data root and configuration");
  error.code = "STARTUP_POLICY_INVALID";
  throw error;
}
function data(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value) || ![Object.prototype, null].
  includes(Object.getPrototypeOf(value))) invalid();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(d).some((k) => typeof k !== "string" || !keys.includes(k) || !d[k].enumerable || !Object.
  hasOwn(d[k], "value"))) invalid();
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]));
}
function checkedPath(root, value, { directory = false, rootOnly = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) invalid();
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(value)) invalid();
  const target = path.resolve(value);
  if(rootOnly && target===path.parse(target).root)invalid();
  if (!rootOnly && (target === root || !target.startsWith(root + path.sep))) invalid();
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = fs.lstatSync(cursor);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      invalid();
    }
    if (st.isSymbolicLink() || !st.isDirectory() && (!st.isFile() || st.nlink !== 1)) invalid();
    if (cursor !== target && !st.isDirectory()) invalid();
    if (cursor === target && directory && !st.isDirectory()) invalid();
  }
  if (rootOnly && (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory())) invalid();
  return target;
}
function resolveStartup(value) {
  if (value === void 0) return null;
  const input = data(value, ["mode", "dataRoot", "config"]);
  if (input.mode === "normal" && Object.keys(input).length === 1) return null;
  if (input.mode !== "offline-safe") invalid();
  // Validate every lexical path before the first filesystem probe (including
  // unrelated valid roots), so UNC/device mistakes cannot perform SMB I/O.
  const lexical=[input.dataRoot];
  const preliminary=data(input.config,['app','server','database','storage']);
  lexical.push(data(preliminary.database,['type','path']).path,data(preliminary.storage,['local_path','base_url']).local_path);
  if(lexical.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p.includes('\0')||(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(p))))invalid();
  const root = checkedPath(null, input.dataRoot, { directory: true, rootOnly: true });
  const config = data(input.config, ["app", "server", "database", "storage"]);
  const app = data(config.app, ["name", "version"]);
  const server = data(config.server, ["host", "port", "insecure_tls"]);
  const database = data(config.database, ["type", "path"]);
  const storage = data(config.storage, ["local_path", "base_url"]);
  if (typeof app.name !== "string" || !app.name || server.host !== "127.0.0.1" || !Number.isInteger(server.port) ||
  server.port < 1024 || server.port > 65535 || server.insecure_tls === true || database.type !== "sqlite") invalid();
  const dbPath = checkedPath(root, database.path);
  const storagePath = checkedPath(root, storage.local_path, { directory: true });
  if (dbPath === storagePath || dbPath.startsWith(storagePath + path.sep) || storagePath.startsWith(dbPath + path.
  sep)) invalid();
  return Object.freeze({ mode: "offline-safe", dataRoot: root, config: Object.freeze({ app: Object.freeze(app),
  server: Object.freeze({ ...server, insecure_tls: false }), database: Object.freeze({ type: "sqlite", path: dbPath }),
  storage: Object.freeze({ local_path: storagePath, base_url: "/static" }) }) });
}
function startupFromEnvironment(env = process.env) {
  if (env.LMD_STARTUP_MODE === void 0 || env.LMD_STARTUP_MODE === "normal") return void 0;
  if (env.LMD_STARTUP_MODE !== "offline-safe") invalid();
  for(const value of [env.LMD_DATA_ROOT,env.LMD_SAFE_CONFIG])if(typeof value!=='string'||!path.isAbsolute(value)||(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(value)))invalid();
  const root = checkedPath(null, env.LMD_DATA_ROOT, { directory: true, rootOnly: true });
  const configPath = checkedPath(root, env.LMD_SAFE_CONFIG);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    invalid();
  }
  return { mode: "offline-safe", dataRoot: root, config };
}
function capabilities(safe) {
  return Object.freeze({ schemaVersion: "runtime-capabilities.v1", mode: safe ? "offline-safe" : "normal", generation: !safe,
  externalOperations: !safe, review: !safe, localImport: true, startupExternalRecovery: !safe });
}
function installSafeHttpBoundary(app) {
  app.use((req, res, next) => {
    const host = typeof req.headers.host === 'string'
      ? trustedLoopbackOrigin(`http://${req.headers.host}`) : false;
    const origin = trustedLoopbackOrigin(req.headers.origin);
    if (!host || origin === false || (req.headers['sec-fetch-site'] === 'cross-site' && origin === null)) {
      return res.status(403).json({success:false,error:{code:'OFFLINE_SAFE_ORIGIN_FORBIDDEN',message:'离线安全模式仅允许本机来源'}});
    }
    if (origin !== null) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    const read = req.method === "GET" || req.method === "HEAD";
    // Express mounts API routers case-insensitively. Identify that namespace
    // with the same semantics; noncanonical paths still fail the exact allowlist.
    if (!/^\/api(?:\/|$)/i.test(req.path)) return read ? next() : res.status(403).json({ success: false, error: { code: "\
OFFLINE_SAFE_MODE", message: "安全模式禁止此操作" } });
    const allowedRead = /^\/api\/v1\/(?:runtime-capabilities|dramas(?:\/stats|\/[1-9]\d*(?:\/(?:characters|props))?)?|(?:character|scene|prop)-library|v2\/(?:dramas\/[0-9a-f-]+\/(?:source-documents|narrative-results|characters\/[0-9a-f-]+\/(?:candidate-executions\/history|reference-package-executions\/history|local-recovery-packages|candidate-recoveries))|(?:source-documents|narrative-results)\/[0-9a-f-]+))$/u.
    test(req.path);
    const localImport = req.method === "POST" && /^\/api\/v1\/v2\/dramas\/[1-9]\d*\/characters\/[0-9a-f-]+\/local-recovery-packages$/u.
    test(req.path);
    const candidateRead = /^\/api\/v1\/v2\/character-candidate-executions\/[0-9a-f-]+$/.test(req.path);
    if (read && (allowedRead || candidateRead) || localImport) return next();
    return res.status(403).json({ success: false, error: { code: "OFFLINE_SAFE_MODE", message: "离线安全模式禁止生成、审核及\
外部操作" }, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  });
}
module.exports = { resolveStartup, startupFromEnvironment, capabilities, installSafeHttpBoundary };
