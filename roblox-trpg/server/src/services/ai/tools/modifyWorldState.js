/**
 * modify_world_state：高风险工具，严格白名单 + 乐观锁。
 * 禁止修改：玩家身份/房间所有权/管理员权限/服务器配置/Canonical Roblox 数据。
 */
const { register, ToolError } = require('./index');
const worldState = require('../../world/worldState');
const { WORLD_ALLOWED_FIELDS } = require('../../../config');

register({
  name: 'modify_world_state',
  description:
    '修改共享世界状态（乐观锁，版本冲突需重新读取）。仅允许白名单字段：' +
    WORLD_ALLOWED_FIELDS.join(' / ') +
    '。禁止修改金币、玩家身份、权限、Canonical Roblox 数据等。',
  permission: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      field: { type: 'string', required: true, enum: WORLD_ALLOWED_FIELDS },
      value: { type: 'string', required: true, maxLength: 120, description: '布尔写 true/false，数字写字符串形式' },
      action: { type: 'string', maxLength: 60, description: '审计动作名，如 open_door' },
    },
  },
  execute(ctx, args) {
    if (!WORLD_ALLOWED_FIELDS.includes(args.field)) {
      throw new ToolError(`字段 "${args.field}" 不在白名单内，拒绝修改`, 'forbidden');
    }
    // 规范化值类型
    let value = args.value;
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);

    const result = worldState.setWorldField(ctx.room.id, args.field, value, {
      actor: ctx.playerUid || 'ai_tool',
      action: args.action || 'modify_world_state',
    });

    ctx.broadcast &&
      ctx.broadcast('world:changed', {
        version: result.version,
        field: args.field,
        value,
        actor: ctx.actingPlayerName || 'GM',
        at: new Date().toISOString(),
      });

    return { ok: true, field: args.field, value, worldVersion: result.version };
  },
});
