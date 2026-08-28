'use strict';

const { types: { isProxy } } = require('node:util');

const { createMinimaxH3ApiService } = require('./apiService');

const DEPENDENCY_KEYS = Object.freeze(new Set(['fetchImpl', 'timeoutMs']));

function dependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Production H3 runtime dependencies are invalid');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError('Production H3 runtime dependencies are invalid');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== 'string' || !DEPENDENCY_KEYS.has(key)
    ))) throw new TypeError('Production H3 runtime dependencies are invalid');
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Production H3 runtime dependencies are invalid');
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function createProductionH3Runtime({ database, storageBaseUrl = '', dependencies: input = {} }) {
  const configured = dependencies(input);
  const fetchImpl = configured.fetchImpl ?? globalThis.fetch;
  return Object.freeze({
    apiService: createMinimaxH3ApiService({
      database,
      storageBaseUrl,
      fetchImpl,
      ...(configured.timeoutMs === undefined ? {} : { timeoutMs: configured.timeoutMs }),
    }),
  });
}

module.exports = Object.freeze({ createProductionH3Runtime });
