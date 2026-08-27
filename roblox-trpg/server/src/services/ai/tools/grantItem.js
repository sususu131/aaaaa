/** grant_item：奖励数据库驱动。物品必须存在且 approved；数量有上限。 */
const { register, resolveRoomPlayer, ToolError } = require('./index');
const { getDb } = require('@roblox-trpg/database');
const worldState = require('../../world/worldState');
const { ITEM_MAX_QUANTITY } = require('../../../config');

register({
  name: 'grant_item',
  description: `发放物品（数据库驱动）：物品必须是数据库中 approved 的物品，单次数量 1..${ITEM_MAX_QUANTITY}。AI 不能凭空创造物品或金币。`,
  permission: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64 },
      itemId: { type: 'integer', required: true, min: 1, description: '物品数据库ID' },
      quantity: { type: 'integer', min: 1, max: ITEM_MAX_QUANTITY },
      reason: { type: 'string', maxLength: 120 },
    },
  },
  execute(ctx, args) {
    const db = getDb();
    const target = resolveRoomPlayer(ctx, args.playerId);

    const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'approved'").get(args.itemId);
    if (!item) throw new ToolError(`物品 #${args.itemId} 不存在或未审核，拒绝发放`, 'not_found');

    const qty = args.quantity || 1;
    const source = ctx.room.currentDungeon ? `dungeon:${ctx.room.currentDungeon.dungeonId}` : 'ai_tool';

    db.prepare(
      `INSERT INTO player_items (player_id, item_id, quantity, source, reason) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id, item_id) DO UPDATE SET quantity = MIN(quantity + excluded.quantity, ${ITEM_MAX_QUANTITY})`
    ).run(target.playerRowId, item.id, qty, source, args.reason || '');

    const owned = db.prepare('SELECT quantity FROM player_items WHERE player_id = ? AND item_id = ?').get(target.playerRowId, item.id);

    worldState.appendEvent(ctx.room.id, ctx.playerUid || 'ai_tool', 'grant_item', null, { item: item.name, quantity: qty, to: target.name }, 'ai_tool');
    ctx.broadcast &&
      ctx.broadcast('item:gained', { playerName: target.name, itemName: item.name, quantity: qty, at: new Date().toISOString() });

    return { ok: true, playerName: target.name, item: item.name, quantity: qty, totalOwned: owned.quantity };
  },
});
