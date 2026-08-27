const { V2RepositoryDataError } = require('./errors');

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseJson(value, entity, field) {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new V2RepositoryDataError(entity, field);
  }
}

function assertJsonKind(value, expectedKind, entity, field) {
  if (!expectedKind) return value;
  const nullable = expectedKind.endsWith('?');
  const kind = nullable ? expectedKind.slice(0, -1) : expectedKind;
  if (value === null && nullable) return value;
  const matches = kind === 'array'
    ? Array.isArray(value)
    : value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!matches) throw new V2RepositoryDataError(entity, field);
  return value;
}

function freezeSnapshot(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  return Object.freeze(value);
}

function mapRow(row, { entity, jsonFields = {}, jsonKinds = {} } = {}) {
  if (!row) return null;
  const mapped = {};
  for (const [column, value] of Object.entries(row)) {
    const target = jsonFields[column] || snakeToCamel(column);
    mapped[target] = Object.hasOwn(jsonFields, column)
      ? assertJsonKind(parseJson(value, entity, column), jsonKinds[column], entity, column)
      : value;
  }
  return freezeSnapshot(mapped);
}

function mapRows(rows, options) {
  return freezeSnapshot(rows.map((row) => mapRow(row, options)));
}

function serializeJson(value, fallback) {
  const candidate = value === undefined ? fallback : value;
  return JSON.stringify(candidate);
}

module.exports = {
  freezeSnapshot,
  mapRow,
  mapRows,
  serializeJson,
};
