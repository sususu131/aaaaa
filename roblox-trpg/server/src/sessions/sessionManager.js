/**
 * 临时玩家身份（Step 19）：无账号登录。
 * - 服务器生成 playerId（player_xxxx）+ 高熵 sessionToken
 * - 数据库只存 token 的 SHA-256 哈希
 * - 客户端不得指定 playerId；token 不进 URL
 * - Cookie：HttpOnly + SameSite=Lax（开发环境无 HTTPS 时不设 Secure）
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const { SESSION_TTL_DAYS } = require('../config');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function newPlayerUid() {
  return `player_${crypto.randomBytes(4).toString('hex')}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bit 高熵
}

function expiryDate() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** 为玩家行创建会话，返回 { playerId(uid), token }。 */
function createSession(playerRowId) {
  const db = getDb();
  let uid;
  do {
    uid = newPlayerUid();
  } while (db.prepare('SELECT 1 FROM players WHERE uid = ?').get(uid));

  db.prepare('UPDATE players SET uid = ? WHERE id = ? AND uid IS NULL').run(uid, playerRowId);

  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    playerRowId,
    expiryDate().toISOString()
  );

  const row = db.prepare('SELECT uid FROM players WHERE id = ?').get(playerRowId);
  return { playerId: row.uid, token };
}

/** 校验 token。合法返回 { playerRowId, playerId }，否则 null。 */
function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const db = getDb();
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return null;
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(s.player_id);
  if (!player) return null;
  db.prepare('UPDATE sessions SET last_seen_at = datetime(\'now\') WHERE token_hash = ?').run(sha256(token));
  return { playerRowId: player.id, playerId: player.uid || `player#${player.id}` };
}

module.exports = { createSession, resolveSession };
