const { createCompatibilityError } = require('./errors');

function invalid() {
  throw createCompatibilityError();
}

function readExactDataObject(value, requiredFields, optionalFields = []) {
  let isArray;
  let prototype;
  let keys;
  try {
    isArray = Array.isArray(value);
    prototype = value && typeof value === 'object' ? Reflect.getPrototypeOf(value) : undefined;
    keys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  } catch {
    invalid();
  }
  if (!value || typeof value !== 'object' || isArray) invalid();
  if (prototype !== Object.prototype && prototype !== null) invalid();

  const allowedFields = new Set([...requiredFields, ...optionalFields]);
  const snapshot = Object.create(null);
  if (keys.length > allowedFields.size) invalid();
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedFields.has(key)) invalid();
    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      invalid();
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    snapshot[key] = descriptor.value;
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(snapshot, field)) invalid();
  }
  return Object.freeze(snapshot);
}

module.exports = {
  readExactDataObject,
};
