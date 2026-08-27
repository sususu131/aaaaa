/**
 * 玩家管理：本阶段玩家 = 一次浏览器会话（socket_id 为身份）。
 * 负责名字校验与会话元数据。
 */
const { PLAYER_NAME_MAX } = require('../config');

/** 校验并规范化玩家名字。合法返回 { name }，否则 { error }。 */
function validateName(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) return { error: '请输入名字' };
  if (name.length > PLAYER_NAME_MAX) return { error: `名字不能超过${PLAYER_NAME_MAX}个字符` };
  return { name };
}

/** 构造进入房间的玩家对象。 */
function makePlayer(socketId, name) {
  return { socketId, name };
}

module.exports = { validateName, makePlayer };
