const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COLOR = /^#[0-9a-f]{6}$/u;

function createVersionValidation(errorMessage) {
  function fail() {
    throw new TypeError(errorMessage);
  }

  function ownDataSnapshot(value) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const snapshot = Object.create(null);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') fail();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        snapshot[key] = descriptor.value;
      }
      return snapshot;
    } catch (error) {
      if (error instanceof TypeError && error.message === errorMessage) throw error;
      fail();
    }
  }

  function assertExactKeys(snapshot, expectedKeys) {
    const keys = Object.keys(snapshot).sort();
    const expected = [...expectedKeys].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
    return snapshot;
  }

  function exactObject(value, expectedKeys) {
    return assertExactKeys(ownDataSnapshot(value), expectedKeys);
  }

  function requiredString(value, maxLength) {
    if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail();
    let length = 0;
    for (const _character of value) {
      length += 1;
      if (length > maxLength) fail();
    }
    if (length < 1) fail();
    return value;
  }

  function optionalEpoch(value) {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail();
    return value;
  }

  function canonicalUid(value, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
    return value;
  }

  function colorAnchors(value) {
    let descriptors;
    try {
      if (!Array.isArray(value)) fail();
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch (error) {
      if (error instanceof TypeError && error.message === errorMessage) throw error;
      fail();
    }
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > 16
    ) fail();
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (keys.length !== lengthDescriptor.value) fail();
    const snapshot = Array.from({ length: lengthDescriptor.value }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      const entry = descriptor.value;
      if (typeof entry !== 'string' || !COLOR.test(entry)) fail();
      return entry;
    });
    if (new Set(snapshot).size !== snapshot.length) fail();
    return Object.freeze(snapshot);
  }

  return Object.freeze({
    assertExactKeys,
    canonicalUid,
    colorAnchors,
    exactObject,
    fail,
    optionalEpoch,
    ownDataSnapshot,
    requiredString,
  });
}

module.exports = { createVersionValidation };
