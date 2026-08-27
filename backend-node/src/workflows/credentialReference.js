const CREDENTIAL_REFERENCE = /^credential:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isCredentialReference(value) {
  return typeof value === 'string' && CREDENTIAL_REFERENCE.test(value);
}

module.exports = {
  CREDENTIAL_REFERENCE,
  isCredentialReference,
};
