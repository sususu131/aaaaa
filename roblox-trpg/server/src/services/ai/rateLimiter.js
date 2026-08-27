/**
 * AI 请求频率限制（Step 18 配套）：单玩家 / 单房间 滑动窗口。
 */
const { AI_RATE_PER_PLAYER, AI_RATE_PER_ROOM } = require('../../config');

const WINDOW_MS = 60 * 1000;
const playerHits = new Map(); // key -> [timestamps]
const roomHits = new Map();

function take(map, key, now) {
  const arr = map.get(key) || [];
  const fresh = arr.filter((t) => now - t < WINDOW_MS);
  map.set(key, fresh);
  return fresh;
}

/** 尝试消耗一次额度。返回 { ok, retryAfterSec? }。 */
function tryConsumeAiRequest(playerKey, roomKey) {
  const now = Date.now();

  const pArr = take(playerHits, playerKey, now);
  if (pArr.length >= AI_RATE_PER_PLAYER) {
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - pArr[0])) / 1000);
    return { ok: false, scope: 'player', retryAfterSec };
  }
  const rArr = take(roomHits, roomKey, now);
  if (rArr.length >= AI_RATE_PER_ROOM) {
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - rArr[0])) / 1000);
    return { ok: false, scope: 'room', retryAfterSec };
  }

  pArr.push(now);
  rArr.push(now);
  return { ok: true };
}

function reset() {
  playerHits.clear();
  roomHits.clear();
}

module.exports = { tryConsumeAiRequest, reset };
