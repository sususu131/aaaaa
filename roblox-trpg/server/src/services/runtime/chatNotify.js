/**
 * 阶段31：副本事件 → 大聊天框。
 * 副本进程以前只发 instance:* 事件（副本面板内消费），主聊天框看不到进程；
 * 现在关键节点（开始/移动/遭遇/限时/结算）同时落库为 dungeon 消息并广播
 * chat:message —— 副本主要在聊天框运行，面板只是详情/操作台。
 */
const roomManager = require('../../rooms/roomManager');

/** 持久化 + 广播一条副本进程消息（type='dungeon'，前端按事件条样式渲染）。 */
function notify(io, roomId, text, playerId = null) {
  if (!io || !roomId || !text) return null;
  const id = roomManager.saveMessage(roomId, playerId, 'dungeon', text);
  io.to(roomId).emit('chat:message', {
    id,
    type: 'dungeon',
    playerName: null,
    text,
    at: new Date().toISOString(),
  });
  return id;
}

module.exports = { notify };
