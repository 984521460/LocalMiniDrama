'use strict';

function isInsecureTlsEnabled(serverConfig = {}) {
  const flag = serverConfig.insecure_tls ?? serverConfig.INSECURE_TLS;
  return flag === true || flag === 1 || flag === '1' || String(flag).toLowerCase() === 'true';
}

function resolveServerHost(serverConfig = {}) {
  return String(serverConfig.host || '').trim() || '127.0.0.1';
}

module.exports = { isInsecureTlsEnabled, resolveServerHost };
