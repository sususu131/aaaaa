/** create_option：AI 在工具循环中追加行动选项（最终随结构化回复发出）。 */
const { register } = require('./index');

register({
  name: 'create_option',
  description: '为最终回复追加一个玩家行动选项。点击选项只会填入玩家输入框（可编辑），不会直接执行任何动作。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      label: { type: 'string', required: true, maxLength: 40 },
      value: { type: 'string', required: true, maxLength: 200, description: '点击后填入输入框的完整行动文本' },
    },
  },
  execute(ctx, args) {
    const opts = ctx.pendingOptions || (ctx.pendingOptions = []);
    if (opts.length >= 6) return { ok: false, error: '选项已达上限（6个）', kind: 'invalid_args' };
    opts.push({ label: args.label, action: args.value });
    return { ok: true, totalOptions: opts.length };
  },
});
