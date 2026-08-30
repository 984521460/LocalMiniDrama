'use strict';

const { types } = require('node:util');

const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;

const MIGRATION_BACKUP_CODE = 'V2_MIGRATION_BACKUP_INVALID';
const MIGRATION_BACKUP_MESSAGE = '迁移前数据库安全副本无效或无法验证；请停止反复启动并保留数据库、副本和 Manifest。';
const GENERIC_CODE = 'BACKEND_STARTUP_FAILED';
const GENERIC_MESSAGE = '后端服务未能启动。';

function ownDataCode(error) {
  if ((typeof error !== 'object' && typeof error !== 'function')
    || error === null
    || types.isProxy(error)) return null;
  try {
    const descriptor = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTOR, Object, [error, 'code']);
    return descriptor
      && REFLECT_APPLY(HAS_OWN, Object, [descriptor, 'value'])
      && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function formatStartupError(error) {
  const knownMigrationFailure = ownDataCode(error) === MIGRATION_BACKUP_CODE;
  const code = knownMigrationFailure ? MIGRATION_BACKUP_CODE : GENERIC_CODE;
  const message = knownMigrationFailure ? MIGRATION_BACKUP_MESSAGE : GENERIC_MESSAGE;
  return Object.freeze({ code, message, text: `${code}: ${message}` });
}

module.exports = Object.freeze({
  GENERIC_CODE,
  GENERIC_MESSAGE,
  MIGRATION_BACKUP_CODE,
  MIGRATION_BACKUP_MESSAGE,
  formatStartupError,
});
