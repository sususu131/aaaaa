/**
 * Stage 11 Encounter Tools。
 * 安全：无发放永久装备工具；无修改价格/概率工具；物品查询只读数据库。
 */
const { register } = require('./index');
const encounter = require('../../legends/legendEncounter');
const legendEngine = require('../../legends/legendEngine');
const { getDb } = require('@roblox-trpg/database');

register({
  name: 'get_permanent_items',
  description: '只读：获取玩家永久物品列表（含跨副本有效强度倍率）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { targetExperience: { type: 'string', maxLength: 60, description: '当前体验名（计算削弱倍率）' } },
  },
  execute(ctx, args) {
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) return { ok: false, error: '玩家不存在', error_code: 'not_found', success: false };
    const items = encounter.getPermanentItems(playerRow.id, args.targetExperience || null);
    return { ok: true, items: items.map((i) => ({ name: i.name, rarity: i.rarity, acquiredFrom: i.acquired_from, multiplier: i.effectiveMultiplier })) };
  },
});

register({
  name: 'get_item_power',
  description: '只读：计算物品在目标体验中的有效强度（跨副本削弱规则，服务器计算，AI 不可修改）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: {
      itemName: { type: 'string', required: true, maxLength: 60 },
      basePower: { type: 'integer', required: true, min: 0, max: 10000 },
      sourceExperience: { type: 'string', required: true, maxLength: 60 },
      targetExperience: { type: 'string', required: true, maxLength: 60 },
    },
  },
  execute(ctx, args) {
    const res = encounter.effectiveItemPower(args.itemName, args.basePower, args.sourceExperience, args.targetExperience);
    return { ok: true, ...res, itemName: args.itemName };
  },
});

register({
  name: 'get_experience_swords',
  description: '只读：获取某体验真实存在的剑列表（来自 experience_items 数据库；资料不足标记 UNKNOWN；AI 禁止编造剑）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { experience: { type: 'string', required: true, maxLength: 60 } },
  },
  execute(ctx, args) {
    const rows = getDb().prepare('SELECT * FROM experience_items WHERE source_experience = ?').all(String(args.experience));
    return {
      ok: true,
      experience: args.experience,
      swords: rows.map((r) => ({ name: r.name, rarity: r.rarity, ability: r.original_ability, status: r.status })),
    };
  },
});

register({
  name: 'request_combat_reward',
  description:
    '请求发放传奇战斗胜利奖励（服务器从奖励池随机选择 + 验证 + 发放；幂等）。' +
    'AI 不能指定奖励内容，不能直接给予永久装备。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: { legend: { type: 'string', required: true, maxLength: 64 } },
  },
  execute(ctx, args) {
    const legend = legendEngine.getLegendByNpcUid(String(args.legend));
    if (!legend) return { ok: false, error: '传奇人物不存在', error_code: 'not_found', success: false };
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) return { ok: false, error: '玩家不存在', error_code: 'not_found', success: false };
    const npcEngine = require('../../npcs/npcEngine');
    const inst = npcEngine.findNpcInstanceInRoom(ctx.room.id, legend.npc_uid);
    if (!inst) return { ok: false, error: '该传奇人物不在当前房间', error_code: 'not_found', success: false };
    try {
      const res = encounter.grantCombatReward(ctx.io, legend.id, playerRow.id, ctx.room.id, { instanceId: inst.dungeon_instance_id });
      return { ...res, success: res.ok };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});
