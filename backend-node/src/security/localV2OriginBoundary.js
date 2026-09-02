'use strict';

const response = require('../response');

const URL_CONSTRUCTOR = URL;
const { apply: REFLECT_APPLY } = Reflect;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;

const API_ROOT = '/api/v1/v2';
const MAX_ORIGIN_LENGTH = 256;
const MAX_REQUEST_HEADERS_LENGTH = 256;
const LOOPBACK_IPV4 = /^127(?:\.[0-9]{1,3}){3}$/u;
const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_METHODS_HEADER = 'GET,POST,PUT,PATCH,DELETE';
const ALLOWED_REQUEST_HEADERS = Object.freeze(['content-type']);

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function localV2ApiPath(pathname) {
  return typeof pathname === 'string'
    && (pathname === API_ROOT
      || REFLECT_APPLY(STRING_STARTS_WITH, pathname, [`${API_ROOT}/`]));
}

function trustedLoopbackOrigin(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL_CONSTRUCTOR(value);
  } catch {
    return false;
  }
  const hostname = REFLECT_APPLY(STRING_TO_LOWER_CASE, parsed.hostname, []);
  const loopbackHost = hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || REFLECT_APPLY(REGEXP_TEST, LOOPBACK_IPV4, [hostname]);
  if (!loopbackHost
    || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.origin === 'null') return false;
  return parsed.origin;
}

function validRequestedHeaders(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > MAX_REQUEST_HEADERS_LENGTH) return false;
  const parts = REFLECT_APPLY(STRING_SPLIT, value, [',']);
  if (parts.length < 1 || parts.length > ALLOWED_REQUEST_HEADERS.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const trimmed = REFLECT_APPLY(STRING_TRIM, parts[index], []);
    const normalized = REFLECT_APPLY(STRING_TO_LOWER_CASE, trimmed, []);
    if (normalized === '' || !includes(ALLOWED_REQUEST_HEADERS, normalized)) return false;
  }
  return true;
}

function forbidden(res) {
  return response.error(
    res,
    403,
    'LOCAL_V2_ORIGIN_FORBIDDEN',
    'Local v2 API origin is not allowed',
  );
}

function installLocalV2OriginBoundary(app) {
  if (!app || typeof app.use !== 'function') {
    throw new TypeError('Local v2 origin boundary application is invalid');
  }
  app.use((req, res, next) => {
    if (!localV2ApiPath(req.path)) return next();
    const trustedOrigin = trustedLoopbackOrigin(req.headers.origin);
    if (trustedOrigin === false) return forbidden(res);
    if (trustedOrigin === null) return next();

    res.setHeader('Access-Control-Allow-Origin', trustedOrigin);
    res.setHeader('Vary', 'Origin');
    if (req.method !== 'OPTIONS') return next();

    const requestedMethod = req.headers['access-control-request-method'];
    if (typeof requestedMethod !== 'string' || !includes(ALLOWED_METHODS, requestedMethod)
      || !validRequestedHeaders(req.headers['access-control-request-headers'])) {
      res.removeHeader('Access-Control-Allow-Origin');
      res.removeHeader('Vary');
      return forbidden(res);
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS_HEADER);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  });
}

module.exports = Object.freeze({
  installLocalV2OriginBoundary,
  localV2ApiPath,
  trustedLoopbackOrigin,
});
