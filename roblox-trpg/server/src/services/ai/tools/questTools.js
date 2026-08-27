/**
 * Quest AI Tools（阶段8 第二十二节）：全部走 Tool Registry 验证。
 * AI 不能直接 UPDATE quest 表 / grant_reward；advance_quest 需服务器取证。
 */
const { register, ToolError } = require('./index');
const questEngine = require('../../quests/questEngine');
const { getDb } = require('@roblox-trpg/database');

function roomQuests(ctx) {
  return questEngine.activeInstancesInRoom(ctx.room.id);
}

function findInstance(ctx, questInstanceId) {
  const db = getDb();
  const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ? OR uid = ?').get(Number(questInstanceId) || -1, String(questInstanceId || ''));
  if (!qi) throw new ToolError('任务实例不存在', 'not_found');
  if (qi.room_id !== ctx.room.id) throw new ToolError('不能访问其他房间的任务（Room Isolation）', 'forbidden');
  return qi;
}

register({
  name: 'get_active_quests',
  description: '只读：列出当前房间全部进行中/可用任务（含目标与进度）。隐藏任务在未触发前不可见。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    const list = roomQuests(ctx).map((qi) => {
      const full = questEngine.getInstanceFull(qi.id);
      return {
        questInstanceId: qi.id,
        uid: qi.uid,
        name: full.quest.name,
        type: full.quest.type,
        status: qi.status,
        scope: qi.progress_scope,
        deadlineAt: qi.deadline_at,
        objectives: full.objectives.map((o) => ({
          key: o.objective_key,
          name: o.name,
          type: o.type,
          status: o.status,
          count: `${o.current_count}/${o.required_count}`,
          optional: Boolean(o.is_optional),
        })),
      };
    });
    return { ok: true, quests: list };
  },
});

register({
  name: 'get_quest',
  description: '只读：获取指定任务实例详情（定义/目标/参与者/选择）。只能访问当前房间任务。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: { questInstanceId: { type: 'string', required: true, maxLength: 40 } } },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    const full = questEngine.getInstanceFull(qi.id);
    return {
      ok: true,
      quest: { id: qi.id, uid: qi.uid, name: full.quest.name, description: full.quest.description, status: qi.status, scope: qi.progress_scope },
      objectives: full.objectives.map((o) => ({ key: o.objective_key, name: o.name, type: o.type, status: o.status, count: o.current_count, required: o.required_count })),
      participants: full.participants.length,
      pendingChoices: full.choices.filter((c) => c.status === 'PENDING').map((c) => ({ key: c.choice_key, options: JSON.parse(c.options_json) })),
    };
  },
});

register({
  name: 'get_quest_progress',
  description: '只读：获取指定任务的逐目标进度。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: { questInstanceId: { type: 'string', required: true, maxLength: 40 } } },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    const full = questEngine.getInstanceFull(qi.id);
    return {
      ok: true,
      questInstanceId: qi.id,
      status: qi.status,
      objectives: full.objectives.map((o) => ({ key: o.objective_key, name: o.name, status: o.status, count: o.current_count, required: o.required_count })),
    };
  },
});

register({
  name: 'start_quest',
  description: '开始一个 AVAILABLE 任务实例（服务器验证状态机）。',
  permission: 'GAME_ACTION',
  inputSchema: { type: 'object', properties: { questInstanceId: { type: 'string', required: true, maxLength: 40 } } },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    try {
      const updated = questEngine.startQuest(ctx.io, qi.id);
      return { ok: true, status: updated.status };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'abandon_quest',
  description: '放弃任务（服务器验证状态机；COMPLETED/FAILED 不可放弃）。',
  permission: 'GAME_ACTION',
  inputSchema: { type: 'object', properties: { questInstanceId: { type: 'string', required: true, maxLength: 40 } } },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    try {
      const updated = questEngine.abandonQuest(ctx.io, qi.id);
      return { ok: true, status: updated.status };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'advance_quest',
  description:
    '请求推进任务目标。服务器会检查 Game Event Log 取证：目标对应事件必须真实发生过，否则拒绝。' +
    'AI 的叙事不是事实，不能用本工具"宣布完成"未实际发生的进度。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      questInstanceId: { type: 'string', required: true, maxLength: 40 },
      objectiveKey: { type: 'string', required: true, maxLength: 60 },
    },
  },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    const playerRow = getDb().prepare('SELECT * FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    try {
      const res = questEngine.advanceQuest(ctx.io, qi.id, playerRow ? playerRow.id : null, args.objectiveKey);
      return { ok: true, ...res, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});

register({
  name: 'submit_quest_choice',
  description: '提交任务分支选择（服务器重新验证：选择是否存在/是否已决定/分支条件是否满足）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      questInstanceId: { type: 'string', required: true, maxLength: 40 },
      choiceKey: { type: 'string', required: true, maxLength: 60 },
      optionId: { type: 'string', required: true, maxLength: 60 },
    },
  },
  execute(ctx, args) {
    const qi = findInstance(ctx, args.questInstanceId);
    const playerRow = getDb().prepare('SELECT * FROM players WHERE uid = ?').get(ctx.playerUid || '__none__');
    if (!playerRow) return { ok: false, error: '玩家不存在', error_code: 'not_found', success: false };
    try {
      const res = questEngine.submitChoice(ctx.io, qi.id, playerRow.id, args.choiceKey, args.optionId);
      return { ...res, success: true };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code, success: false };
    }
  },
});
