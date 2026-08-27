/** roll_dice：服务器生成随机数。AI 绝不能自己编造骰子结果。 */
const crypto = require('crypto');
const { register } = require('./index');
const { getDb } = require('@roblox-trpg/database');

register({
  name: 'roll_dice',
  description: '由服务器掷骰（真实随机数）。禁止 AI 自行编造骰子结果。返回每次点数与总和。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      sides: { type: 'integer', required: true, min: 2, max: 100, description: '骰子面数，如 20' },
      count: { type: 'integer', min: 1, max: 10, description: '骰子数量，默认1' },
    },
  },
  execute(ctx, args) {
    const sides = args.sides;
    const count = args.count || 1;
    const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
    const total = rolls.reduce((a, b) => a + b, 0);

    const data = { sides, count, rolls, total };
    getDb().prepare('INSERT INTO dice_rolls (room_id, kind, data) VALUES (?, ?, ?)').run(ctx.room.id, 'roll', JSON.stringify(data));

    ctx.broadcast && ctx.broadcast('dice:rolled', { ...data, at: new Date().toISOString() });
    return { ok: true, rolls, total, sides, count, note: '此结果由服务器随机数生成，叙事时必须如实引用。' };
  },
});
