/**
 * Legendary NPC Tools（阶段10）。
 * 安全：无 spawn 工具（服务器专属）；无倍率修改工具；装备只能购买；战斗仅类型化动作。
 */
const { register, ToolError } = require('./index');
const legendEngine = require('../../legends/legendEngine');
const npcEngine = require('../../npcs/npcEngine');
const { getDb } = require('@roblox-trpg/database');

function safeResolve(ctx, ref) {
  try {
    return resolveLegend(ctx, ref);
  } catch (err) {
    return { __error: true, message: err.message, code: err.kind || 'not_found' };
  }
}

function resolveLegend(ctx, ref) {
  // 仅当前房间的传奇（Room Isolation）
  const legend = legendEngine.getLegendByNpcUid(String(ref)) || (() => {
    const byId = /^\d+$/.test(String(ref)) ? legendEngine.getLegendById(Number(ref)) : null;
    return byId;
  })();
  if (!legend) throw new ToolError('传奇人物不存在', 'not_found');
  const present = npcEngine.findNpcInstanceInRoom(ctx.room.id, legend.npc_uid);
  if (!present) throw new ToolError('该传奇人物不在当前房间', 'not_found');
  return legend;
}

register({
  name: 'get_legendary_status',
  description:
    '只读：获取传奇人物状态（身份/称号/来源体验/稀有度/当前能力倍率与实际战力/关系/能力列表）。' +
    'AI 不能创造传奇人物、不能修改能力倍率。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: {
      legend: { type: 'string', required: true, maxLength: 64 },
      experienceName: { type: 'string', maxLength: 60, description: '当前所在体验名（用于能力倍率）' },
    },
  },
  execute(ctx, args) {
    const legend = safeResolve(ctx, args.legend);
    if (legend.__error) return { ok: false, error: legend.message, error_code: legend.code, success: false };
    const power = legendEngine.realPower(legend, args.experienceName || null);
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    const rel = playerRow ? npcEngine.getRelationship('npc', legend.npc_id, 'player', playerRow.id) : { value: 0, relationshipType: '陌生' };
    return {
      ok: true,
      displayName: legend.display_name,
      title: legend.title,
      originType: legend.origin_type,
      originExperience: legend.origin_experience,
      rarity: legend.rarity,
      abilities: JSON.parse(legend.ability_json || '[]'),
      power,
      relationship: { value: rel.value, type: rel.relationshipType },
      equipmentPolicy: legendEngine.equipmentPolicy(legend, args.experienceName || null),
    };
  },
});

register({
  name: 'legendary_dialog',
  description: '与传奇人物对话：服务器记录对话并微调关系（+2 固定值），产生 LEGENDARY_DIALOG 事件。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      legend: { type: 'string', required: true, maxLength: 64 },
      topic: { type: 'string', required: true, maxLength: 200 },
    },
  },
  execute(ctx, args) {
    const legend = safeResolve(ctx, args.legend);
    if (legend.__error) return { ok: false, error: legend.message, error_code: legend.code, success: false };
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) return { ok: false, error: '玩家不存在', error_code: 'not_found', success: false };
    try {
      const res = legendEngine.legendaryDialog(ctx.io, legend.id, playerRow.id, ctx.room.id, args.topic);
      return { ...res, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'buy_legendary_item',
  description:
    '从传奇商店购买物品：服务器验证关系等级/阵营声望/任务前置 + 金币余额，扣款并发放。' +
    'AI 不能直接给予装备。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      legend: { type: 'string', required: true, maxLength: 64 },
      itemName: { type: 'string', required: true, maxLength: 60 },
    },
  },
  execute(ctx, args) {
    const legend = safeResolve(ctx, args.legend);
    if (legend.__error) return { ok: false, error: legend.message, error_code: legend.code, success: false };
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) return { ok: false, error: '玩家不存在', error_code: 'not_found', success: false };
    const item = getDb().prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(String(args.itemName));
    if (!item) return { ok: false, error: `物品「${args.itemName}」不存在或未审核（不能凭空购买）`, error_code: 'ITEM_NOT_APPROVED', success: false };
    try {
      const res = legendEngine.purchaseShopItem(ctx.io, legend.id, playerRow.id, item.id, ctx.room.id);
      return { ...res, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'legendary_battle_action',
  description:
    '请求传奇人物战斗动作（服务器掷骰与判定，AI 只描述）：attack/defend/flee/skill。' +
    'AI 不能直接控制传奇人物结果。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      legend: { type: 'string', required: true, maxLength: 64 },
      action: { type: 'string', required: true, enum: ['attack', 'defend', 'flee', 'skill'] },
      target: { type: 'string', maxLength: 64 },
    },
  },
  execute(ctx, args) {
    const legend = safeResolve(ctx, args.legend);
    if (legend.__error) return { ok: false, error: legend.message, error_code: legend.code, success: false };
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    try {
      const outcome = legendEngine.legendaryBattleAction(ctx.io, legend.id, args.action, {
        roomId: ctx.room.id,
        targetName: args.target || null,
        byPlayerId: playerRow ? playerRow.id : null,
      });
      return { ok: true, outcome, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'get_legendary_shop',
  description: '只读：查看传奇商店商品与当前玩家的可购买状态（服务器计算条件）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { legend: { type: 'string', required: true, maxLength: 64 } },
  },
  execute(ctx, args) {
    const legend = safeResolve(ctx, args.legend);
    if (legend.__error) return { ok: false, error: legend.message, error_code: legend.code, success: false };
    const playerRow = getDb().prepare('SELECT id FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    const shop = legendEngine.getShop(legend.id, playerRow ? playerRow.id : null);
    return { ok: true, shop: shop.map((s) => ({ item: s.item_name, price: s.price, currency: s.currency, rarity: s.item_rarity, eligible: s.eligible })) };
  },
});
