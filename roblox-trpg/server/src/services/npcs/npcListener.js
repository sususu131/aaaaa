/**
 * NPC Listener（阶段9 第八节）：监听 Game Event Bus，服务器决定 NPC 反应。
 * 流程：玩家行为 → Event Bus → NPC Listener → 修改关系/记忆 → AI 读取状态 → 生成剧情。
 * AI 不在此处直接改数据 —— 全部由服务器规则执行。
 */
const npcEngine = require('./npcEngine');
const gameEvents = require('../quests/gameEvents');

let registered = false;

function registerNpcListener() {
  if (registered) return;
  registered = true;

  gameEvents.onEvent((io, evt) => {
    try {
      // 任务完成 → 房间内存活 NPC 感恩（服务器固定 +15）
      if (evt.type === 'QUEST_COMPLETED' && evt.roomId) {
        for (const ni of npcEngine.npcInstancesInRoom(evt.roomId)) {
          if (!ni.alive || !evt.actorPlayerId) continue;
          try {
            npcEngine.applyRelationshipEvent(io, {
              npcInstanceId: ni.id,
              playerId: evt.actorPlayerId,
              action: 'quest_complete',
              reason: '任务完成',
            });
          } catch { /* NPC 反应失败不阻塞 */ }
        }
        return;
      }
      // NPC 死亡长期事件：检查任务门控（死亡可能关闭/开启任务线）
      if (evt.type === 'NPC_DEAD' && evt.roomId) {
        try {
          npcEngine.checkQuestGates(io, evt.roomId);
        } catch { /* ignore */ }
      }
    } catch { /* listener 永不崩溃主流程 */ }
  });
}

module.exports = { registerNpcListener };
