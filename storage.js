// 存储层：有 DATABASE_URL 就用 Postgres（持久化，部署用）；否则退回本地 JSON 文件（本地开发用）。
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "records.json");
function fileLoad() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { children: {}, records: [] }; }
}
function fileSave(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function initStorage() {
  if (!DATABASE_URL) {
    console.log(`  存储：本地文件 ${DB_FILE}（未设 DATABASE_URL）`);
    return "file";
  }
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, child_id TEXT NOT NULL, date TIMESTAMPTZ NOT NULL, data JSONB NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_child ON records (child_id)`);
  console.log("  存储：Postgres 数据库（持久化）");
  return "postgres";
}

async function getChildren() {
  if (pool) {
    const r = await pool.query("SELECT id, data FROM children");
    const m = {};
    r.rows.forEach((x) => (m[x.id] = { id: x.id, ...x.data }));
    return m;
  }
  return fileLoad().children;
}
async function getChild(id) {
  if (pool) {
    const r = await pool.query("SELECT id, data FROM children WHERE id = $1", [id]);
    return r.rows[0] ? { id, ...r.rows[0].data } : null;
  }
  return fileLoad().children[id] || null;
}
async function addChild(child) {
  if (pool) {
    const { id, ...data } = child;
    await pool.query("INSERT INTO children (id, data) VALUES ($1, $2)", [id, data]);
    return child;
  }
  const db = fileLoad(); db.children[child.id] = child; fileSave(db); return child;
}
async function addRecord(rec) {
  if (pool) {
    const { id, childId, date, ...data } = rec;
    await pool.query("INSERT INTO records (id, child_id, date, data) VALUES ($1, $2, $3, $4)", [id, childId, date, data]);
    return rec;
  }
  const db = fileLoad(); db.records.push(rec); fileSave(db); return rec;
}
async function getRecords(childId) {
  if (pool) {
    const r = await pool.query("SELECT id, child_id, date, data FROM records WHERE child_id = $1 ORDER BY date", [childId]);
    return r.rows.map((x) => ({ id: x.id, childId: x.child_id, date: x.date instanceof Date ? x.date.toISOString() : x.date, ...x.data }));
  }
  return fileLoad().records.filter((r) => r.childId === childId);
}

module.exports = { initStorage, getChildren, getChild, addChild, addRecord, getRecords };
