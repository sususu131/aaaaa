/** roll_dice：服务器生成随机数。AI 绝不能自己编造骰子结果。 */
const { register } = require('./index');
const diceEngine = require('../../world/diceEngine');

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
    const { sides, count, rolls, total } = diceEngine.roll(ctx.room.id, { sides: args.sides, count: args.count || 1 });
    ctx.broadcast && ctx.broadcast('dice:rolled', { sides, count, rolls, total, at: new Date().toISOString() });
    return { ok: true, rolls, total, sides, count, note: '此结果由服务器随机数生成，叙事时必须如实引用。' };
  },
});
