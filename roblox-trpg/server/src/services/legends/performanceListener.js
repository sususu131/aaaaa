/**
 * 表现追踪监听器（阶段11）：监听 Game Event Bus，记录副本表现（完成度评分依据）。
 */
const encounter = require('./legendEncounter');
const gameEvents = require('../quests/gameEvents');

let registered = false;

function registerPerformanceListener() {
  if (registered) return;
  registered = true;

  gameEvents.onEvent((io, evt) => {
    try {
      const instanceId = evt.instanceId || null;
      if (!instanceId) return;
      if (evt.type === 'PLAYER_DIED') {
        encounter.trackDeath(instanceId);
      } else if (evt.type === 'ENEMY_DEFEATED') {
        encounter.trackCombat(instanceId, true);
      } else if (evt.type === 'PLAYER_ENTERED_SCENE') {
        if (evt.data && evt.data.scene) encounter.trackScene(instanceId, evt.data.scene);
      } else if (evt.type === 'QUEST_COMPLETED') {
        encounter.trackQuestDone(instanceId);
      }
    } catch { /* 追踪失败不阻塞主流程 */ }
  });
}

module.exports = { registerPerformanceListener };
