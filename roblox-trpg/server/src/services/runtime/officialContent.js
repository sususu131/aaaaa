/**
 * 官方可玩内容（阶段15 第五节）：新手完整流程副本（DOORS）。
 * 官方定义存于 official_dungeon_definitions（与设计流水线分离），
 * 玩家开局时按需物化为 dungeon_versions 的 PUBLISHED 版本（固定高版本号 900，
 * 不与玩家设计/测试的版本号冲突；幂等）。
 */
const { getDb } = require('@roblox-trpg/database');

const OFFICIAL_VERSION = 900;

class OfficialContentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function listOfficial() {
  return getDb().prepare('SELECT * FROM official_dungeon_definitions ORDER BY id').all();
}

function getOfficial(dungeonName) {
  return getDb().prepare('SELECT * FROM official_dungeon_definitions WHERE dungeon_name = ?').get(String(dungeonName));
}

/**
 * 物化官方定义为已发布副本版本（幂等：同副本只物化一次）。
 * @returns 版本行 { id, dungeon_id, version, ... }
 */
function materializeOfficial(dungeonName) {
  const db = getDb();
  const official = getOfficial(dungeonName);
  if (!official) throw new OfficialContentError('OFFICIAL_NOT_FOUND', `官方内容「${dungeonName}」不存在`, 404);
  const dungeon = db.prepare('SELECT * FROM dungeons WHERE roblox_experience_name = ?').get(dungeonName);
  if (!dungeon) throw new OfficialContentError('DUNGEON_NOT_FOUND', `副本「${dungeonName}」未登记`, 404);

  const existing = db.prepare('SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = ?').get(dungeon.id, OFFICIAL_VERSION);
  if (existing) return existing;
  db.prepare(
    "INSERT INTO dungeon_versions (dungeon_id, version, definition_json, status, published_at) VALUES (?, ?, ?, 'PUBLISHED', datetime('now'))"
  ).run(dungeon.id, OFFICIAL_VERSION, official.definition_json);
  return db.prepare('SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = ?').get(dungeon.id, OFFICIAL_VERSION);
}

/** 官方版本查询（供测试/前端）。 */
function officialVersionOf(dungeonName) {
  const db = getDb();
  const dungeon = db.prepare('SELECT * FROM dungeons WHERE roblox_experience_name = ?').get(dungeonName);
  if (!dungeon) return null;
  return db.prepare('SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = ?').get(dungeon.id, OFFICIAL_VERSION);
}

module.exports = { OfficialContentError, OFFICIAL_VERSION, listOfficial, getOfficial, materializeOfficial, officialVersionOf };
