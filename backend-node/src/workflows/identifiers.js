const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORT_ID = /^[a-z][a-z0-9_]{0,63}$/u;

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isPortId(value) {
  return typeof value === 'string' && PORT_ID.test(value);
}

module.exports = { isCanonicalUuid, isPortId };
