const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;
let binding = null;

function getDb(config, { mode = 'normal' } = {}) {
  const requested = {path: path.resolve(config.path), mode};
  if (db) {
    if(binding.path!==requested.path||binding.mode!==requested.mode){const error=new Error('Database singleton is bound to a different path or startup mode');error.code='DATABASE_BINDING_CONFLICT';throw error;}
    return db;
  }
  const dbPath = config.path;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath, {
    verbose: config.type === 'sqlite' && process.env.DEBUG ? console.log : undefined,
  });
  binding=requested;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    binding = null;
  }
}

module.exports = { getDb, closeDb };
