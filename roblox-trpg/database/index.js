/**
 * SQLite 数据层：单例连接 + 启动自动建表 + 种子数据。
 * 使用 Node 22 内置 node:sqlite（DatabaseSync），零外部依赖。
 * 阶段1 只暴露 db 与 initDb，业务读写由 server 端完成。
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('./migrations');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'roblox_trpg.db');

let db = null;

/** 初始化数据库：建目录、建表、灌入种子数据（幂等）。 */
function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // 迁移先于种子（种子可能引用迁移新增的列）；全部幂等
  runMigrations(db);

  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  db.exec(seed);

  return db;
}

/** 获取已初始化的数据库连接。 */
function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb, DB_FILE };
