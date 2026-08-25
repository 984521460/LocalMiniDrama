const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const aiConfigService = require('../src/services/aiConfigService');
const createAiConfigRoutes = require('../src/routes/aiConfig');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, endpoint, settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'text',
    'openai',
    'fixture',
    'https://stored.invalid/v1',
    'fixture-stored-api-key',
    JSON.stringify(['fixture-model']),
    '/chat/completions',
    JSON.stringify({ timeout: 30, private_key: 'fixture-private-key' }),
    now,
    now,
  );
  return { db, id: Number(info.lastInsertRowid) };
}

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = createResponse();
  await handler(req, res);
  return res;
}

test('CRUD responses use the public projection against a real database row', async (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const routes = createAiConfigRoutes(db, { error() {}, errorw() {}, info() {} }, {});

  const list = await invoke(routes.list, { query: {} });
  const get = await invoke(routes.get, { params: { id: String(id) } });
  const serialized = JSON.stringify([list.body, get.body]);

  assert.equal(list.statusCode, 200);
  assert.equal(get.statusCode, 200);
  assert.doesNotMatch(serialized, /fixture-(stored-api-key|private-key)/);
  assert.equal(get.body.data.api_key_configured, true);
  assert.deepEqual(get.body.data.configured_secret_fields.sort(), ['api_key', 'settings.private_key']);
});

test('create and update responses stay public while the database retains blanked private fields', async (t) => {
  const { db } = createTestDb();
  t.after(() => db.close());
  const routes = createAiConfigRoutes(db, { error() {}, errorw() {}, info() {} }, {});

  const created = await invoke(routes.create, {
    body: {
      service_type: 'text',
      provider: 'openai',
      name: 'created-fixture',
      base_url: 'https://created.invalid/v1',
      api_key: 'fixture-created-api-key',
      model: ['fixture-model'],
      settings: JSON.stringify({ timeout: 15, credential: 'fixture-created-credential' }),
    },
  });
  const id = created.body.data.id;
  const updated = await invoke(routes.update, {
    params: { id: String(id) },
    body: {
      name: 'updated-fixture',
      api_key: '',
      settings: JSON.stringify({ timeout: 20, credential: '' }),
    },
  });
  const stored = db.prepare('SELECT api_key, settings FROM ai_service_configs WHERE id = ?').get(id);
  const serialized = JSON.stringify([created.body, updated.body]);

  assert.equal(created.statusCode, 201);
  assert.equal(updated.statusCode, 200);
  assert.doesNotMatch(serialized, /fixture-created-(api-key|credential)/);
  assert.equal(stored.api_key, 'fixture-created-api-key');
  assert.equal(JSON.parse(stored.settings).credential, 'fixture-created-credential');
  assert.equal(JSON.parse(stored.settings).timeout, 20);
});

test('saved config operations cannot pair stored credentials with request overrides', async (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const originalTestConnection = aiConfigService.testConnection;
  let captured = null;
  aiConfigService.testConnection = async (config) => {
    captured = config;
  };
  t.after(() => {
    aiConfigService.testConnection = originalTestConnection;
  });
  const routes = createAiConfigRoutes(db, { error() {}, errorw() {}, info() {} }, {});

  const res = await invoke(routes.testConnection, {
    body: {
      config_id: id,
      base_url: 'https://attacker.invalid/v1',
      api_key: 'fixture-temporary-key',
      endpoint: '/steal',
      settings: { private_key: 'fixture-temporary-private-key' },
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(captured.base_url, 'https://stored.invalid/v1');
  assert.equal(captured.api_key, 'fixture-stored-api-key');
  assert.equal(captured.endpoint, '/chat/completions');
  assert.equal(captured.settings.private_key, 'fixture-private-key');
});

test('operation routes distinguish malformed and missing config ids', async (t) => {
  const { db } = createTestDb();
  t.after(() => db.close());
  const routes = createAiConfigRoutes(db, { error() {}, errorw() {}, info() {} }, {});

  const malformed = await invoke(routes.testConnection, { body: { config_id: '1junk' } });
  const missing = await invoke(routes.testConnection, { body: { config_id: 999 } });

  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.error.code, 'BAD_REQUEST');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('connection errors redact stored credentials in logs and responses', async (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const originalTestConnection = aiConfigService.testConnection;
  aiConfigService.testConnection = async () => {
    throw new Error('provider echoed fixture-stored-api-key and fixture-private-key');
  };
  t.after(() => {
    aiConfigService.testConnection = originalTestConnection;
  });
  const logged = [];
  const routes = createAiConfigRoutes(db, {
    error(message, fields) { logged.push([message, fields]); },
    errorw() {},
    info() {},
  }, {});

  const res = await invoke(routes.testConnection, { body: { config_id: id } });
  const serialized = JSON.stringify([res.body, logged]);

  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(serialized, /fixture-(stored-api-key|private-key)/);
  assert.match(serialized, /\[redacted\]/);
});

test('Jimeng upstream errors are redacted before the service writes logs', async (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    async text() {
      return JSON.stringify({ detail: 'echo fixture-stored-api-key and fixture-private-key' });
    },
  });
  t.after(() => {
    global.fetch = originalFetch;
  });
  const logged = [];
  const routes = createAiConfigRoutes(db, {
    info(message, fields) { logged.push(['info', message, fields]); },
    warn(message, fields) { logged.push(['warn', message, fields]); },
    error(message, fields) { logged.push(['error', message, fields]); },
    errorw() {},
  }, {});

  const res = await invoke(routes.listJimeng2MaterialAssets, { body: { config_id: id } });
  const serialized = JSON.stringify([res.body, logged]);

  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(serialized, /fixture-(stored-api-key|private-key)/);
  assert.match(serialized, /\[redacted\]/);
});

test('ModelArk proxy logs and errors use the scoped redacted logger', async (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const proxy = require('../src/services/modelArkAssetProxyService');
  const originalCall = proxy.callModelArkAsset;
  proxy.callModelArkAsset = async (_options, log) => {
    log.warn('proxy echo fixture-stored-api-key', {
      response_preview: 'fixture-private-key',
    });
    const error = new Error('upstream fixture-stored-api-key fixture-private-key');
    error.payload = { echoed: 'fixture-stored-api-key' };
    throw error;
  };
  t.after(() => {
    proxy.callModelArkAsset = originalCall;
  });
  const logged = [];
  const routes = createAiConfigRoutes(db, {
    warn(message, fields) { logged.push(['warn', message, fields]); },
    error(message, fields) { logged.push(['error', message, fields]); },
    errorw() {},
    info() {},
  }, {});

  const res = await invoke(routes.modelArkAsset, {
    body: { config_id: id, action: 'ListAssets', payload: { PageSize: 1 } },
  });
  const serialized = JSON.stringify([res.body, logged]);

  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(serialized, /fixture-(stored-api-key|private-key)/);
  assert.match(serialized, /\[redacted\]/);
  assert.equal('details' in res.body.error, false);
});

test('reading a config registers private object, scalar, and array settings for shared log redaction', (t) => {
  const { db, id } = createTestDb();
  t.after(() => db.close());
  const originalConsoleLog = console.log;
  const captured = [];
  console.log = (...args) => captured.push(args.join(' '));
  t.after(() => {
    console.log = originalConsoleLog;
  });
  const cases = [
    ['fixture-kling-settings-access-key', { kling_access_key: 'fixture-kling-settings-access-key' }],
    ['fixture-scalar-settings-secret', 'fixture-scalar-settings-secret'],
    ['fixture-array-settings-secret', ['fixture-array-settings-secret']],
  ];
  for (const [secret, settings] of cases) {
    db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
    aiConfigService.getConfig(db, id);
    require('../src/logger').warn(`upstream echoed ${secret}`);
  }

  const output = captured.join('\n');
  assert.doesNotMatch(output, /fixture-(kling|scalar|array)-settings/);
  assert.match(output, /\[redacted\]/);
});
