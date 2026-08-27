/**
 * 阶段14 持久背包工具。
 * 红线（第八节）：AI 不能创建物品定义（无 create_item 类工具）；
 * add_item 必须引用已存在且审核的定义；一切数值经服务器验证；跨房间目标拒绝。
 */
const { register, ToolError, resolveRoomPlayer } = require('./index');
const inventoryService = require('../../inventory/inventoryService');

function resolveTarget(ctx, targetRef) {
  return resolveRoomPlayer(ctx, targetRef); // 房间隔离：跨房间玩家自动拒绝
}

register({
  name: 'get_inventory',
  description: '只读：查看玩家背包（物品/数量/品质/装备状态/容量）。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string', required: true, maxLength: 64, description: '玩家名字或 uid（限当前房间）' } },
  },
  execute(ctx, args) {
    const target = resolveTarget(ctx, args.target);
    return { ok: true, target: target.name, inventory: inventoryService.getInventory(target.playerRowId) };
  },
});

register({
  name: 'add_item',
  description:
    '给玩家添加物品（服务器验证：物品定义必须已存在且审核通过；数量 1~99；堆叠/容量/唯一规则由服务器执行）。' +
    '禁止创造不存在的物品（如 god_sword）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      item_key: { type: 'string', required: true, maxLength: 40, description: '物品定义键（item_definitions.item_key）' },
      amount: { type: 'integer', min: 1, max: 99, description: '数量（默认1）' },
      reason: { type: 'string', maxLength: 120 },
    },
  },
  execute(ctx, args) {
    const target = resolveTarget(ctx, args.target);
    const valid = inventoryService.validateItemReward(args.item_key, args.amount || 1);
    if (!valid.ok) throw new ToolError(`奖励验证失败：${valid.reason}`, 'forbidden');
    try {
      const r = inventoryService.addItem(ctx.io, target.playerRowId, args.item_key, {
        amount: args.amount || 1,
        sourceType: 'AI_GRANT',
        sourceId: args.reason || null,
      });
      return { ok: true, target: target.name, ...r };
    } catch (err) {
      throw new ToolError(err.message, err.code === 'ITEM_NOT_FOUND' ? 'not_found' : 'tool_error');
    }
  },
});

register({
  name: 'remove_item',
  description: '移除玩家物品（服务器验证：持有数量；永久物品与绑定物品不可移除）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      item_key: { type: 'string', required: true, maxLength: 40 },
      amount: { type: 'integer', min: 1, max: 99 },
      reason: { type: 'string', maxLength: 120 },
    },
  },
  execute(ctx, args) {
    const target = resolveTarget(ctx, args.target);
    try {
      const r = inventoryService.removeItem(ctx.io, target.playerRowId, args.item_key, { amount: args.amount || 1 });
      return { ok: true, target: target.name, ...r };
    } catch (err) {
      throw new ToolError(err.message, err.code === 'PERMANENT_ITEM' || err.code === 'BOUND_ITEM' ? 'forbidden' : 'tool_error');
    }
  },
});

register({
  name: 'use_item',
  description: '玩家使用消耗品（服务器结算效果，如恢复生命；非消耗品拒绝）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      item_key: { type: 'string', required: true, maxLength: 40 },
    },
  },
  execute(ctx, args) {
    const target = resolveTarget(ctx, args.target);
    try {
      const r = inventoryService.useItem(ctx.io, target.playerRowId, args.item_key);
      return { ok: true, target: target.name, ...r };
    } catch (err) {
      throw new ToolError(err.message, 'tool_error');
    }
  },
});

register({
  name: 'equip_item',
  description: '玩家装备武器/护甲（同槽位自动换装；其他类型拒绝）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', required: true, maxLength: 64 },
      item_key: { type: 'string', required: true, maxLength: 40 },
    },
  },
  execute(ctx, args) {
    const target = resolveTarget(ctx, args.target);
    try {
      const r = inventoryService.equipItem(ctx.io, target.playerRowId, args.item_key);
      return { ok: true, target: target.name, ...r };
    } catch (err) {
      throw new ToolError(err.message, 'tool_error');
    }
  },
});
