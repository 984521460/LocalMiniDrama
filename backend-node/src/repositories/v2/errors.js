class V2RepositoryError extends Error {
  constructor(message, { code, entity, operation } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.entity = entity;
    this.operation = operation;
  }
}

class V2RepositoryNotFoundError extends V2RepositoryError {
  constructor(entity) {
    super(`${entity} was not found`, {
      code: 'V2_REPOSITORY_NOT_FOUND',
      entity,
      operation: 'read',
    });
  }
}

class V2RepositoryConflictError extends V2RepositoryError {
  constructor(entity, operation) {
    super(`${entity} could not be ${operation} because its repository contract was not satisfied`, {
      code: 'V2_REPOSITORY_CONFLICT',
      entity,
      operation,
    });
  }
}

class V2RepositoryDataError extends V2RepositoryError {
  constructor(entity, field) {
    super(`${entity} contains invalid persisted data`, {
      code: 'V2_REPOSITORY_DATA_INVALID',
      entity,
      operation: `map:${field}`,
    });
  }
}

module.exports = {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryError,
  V2RepositoryNotFoundError,
};
