/**
 * 阶段12 世界模拟工具。
 * 红线：AI 不能直接创造事件（无 spawn_monster / change_world / give_item 之类工具），
 * 只能通过 request_world_event 提交【申请】，由服务器世界事件系统审核并执行。
 * SYSTEM 类事件与 NPC 生死类事件为服务器专属，AI 申请直接拒绝。
 */
const { register, ToolError } = require('./index');
const worldEvents = require('../../world/worldEvents');
const worldSim = require('../../world/worldSim');

register({
  name: 'request_world_event',
  description:
    '请求触发一个世界事件（服务器审核后才生效）。允许类型：' +
    worldEvents.AI_REQUESTABLE_TYPES.join(' / ') +
    '。SYSTEM 类（副本变化）与剧情生死类（NPC死亡/阵营战争）事件只能由服务器规则触发。' +
    '禁止在事件中夹带 NPC/物品操作。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      event_type: { type: 'string', required: true, enum: worldEvents.AI_REQUESTABLE_TYPES, description: '事件类型（白名单）' },
      duration_minutes: { type: 'integer', min: 1, max: 30, description: '持续分钟数（默认按事件目录）' },
      reason: { type: 'string', required: true, maxLength: 200, description: '触发理由（进入审计）' },
      description: { type: 'string', maxLength: 300, description: '叙事描述（仅文本，不产生规则效果）' },
    },
  },
  execute(ctx, args) {
    const roomId = ctx.room.id;
    const durationMs = args.duration_minutes ? args.duration_minutes * 60 * 1000 : null;
    try {
      // 服务器审核：类型白名单 / 时长上限 / 活跃数上限 / 冷却 / 禁止夹带
      worldEvents.validateAiEventRequest(roomId, { type: args.event_type, durationMs, data: {} });
    } catch (err) {
      throw new ToolError(err.message, err.code === 'EVENT_NOT_REQUESTABLE' || err.code === 'FORBIDDEN_DATA' ? 'forbidden' : 'tool_error');
    }
    const result = worldEvents.triggerWorldEvent(ctx.io, roomId, {
      type: args.event_type,
      data: { requested_by: ctx.playerUid || 'ai', reason: args.reason, description: args.description || '' },
      source: 'ai_request',
      durationMs,
    });
    if (!result.triggered) {
      throw new ToolError(`事件未触发：${result.reason}（同类型事件已在进行中）`, 'tool_error');
    }
    return {
      ok: true,
      event: result.event.event_type,
      category: result.event.category,
      uid: result.event.uid,
      expiresAt: result.event.expires_at,
      note: '事件由服务器规则执行；AI 仅提供请求与叙事描述。',
    };
  },
});

register({
  name: 'request_random_world_event',
  description:
    '请求随机世界事件：AI 提供候选事件（白名单内，2~4 个）与可选权重，抽签由服务器执行（服务器随机数），' +
    '选中后仍走常规审核（冷却/上限）。AI 不能扩大候选范围，也不能宣称自己决定了结果。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'string',
        required: true,
        maxLength: 200,
        description: `JSON 数组，候选事件类型（限：${worldEvents.AI_REQUESTABLE_TYPES.join(' / ')}），至少2个`,
      },
      weights: { type: 'string', maxLength: 100, description: '可选：JSON 权重数组（与候选等长，1~100）' },
      duration_minutes: { type: 'integer', min: 1, max: 30 },
      reason: { type: 'string', required: true, maxLength: 200 },
    },
  },
  execute(ctx, args) {
    let candidates;
    let weights = null;
    try {
      candidates = JSON.parse(args.candidates);
    } catch {
      throw new ToolError('candidates 必须是合法 JSON 数组', 'invalid_args');
    }
    if (args.weights) {
      try {
        weights = JSON.parse(args.weights);
      } catch {
        throw new ToolError('weights 必须是合法 JSON 数组', 'invalid_args');
      }
    }
    try {
      const r = worldEvents.requestRandomEvent(ctx.io, ctx.room.id, {
        candidates,
        weights,
        durationMs: args.duration_minutes ? args.duration_minutes * 60 * 1000 : null,
        reason: args.reason,
      });
      return {
        ok: true,
        chosenByServer: r.type,
        triggered: r.triggered,
        reason: r.reason || null,
        note: '抽签与执行均由服务器完成；AI 仅提供候选。',
      };
    } catch (err) {
      throw new ToolError(err.message, err.code === 'CANDIDATE_NOT_REQUESTABLE' ? 'forbidden' : 'tool_error');
    }
  },
});

register({
  name: 'get_world_simulation',
  description:
    '只读：获取世界模拟快照 —— 当前世界事件 / 阵营关系 / NPC 活动（行为状态与位置）/ 副本变体 / 调度器状态。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    return { ok: true, ...worldSim.worldSnapshot(ctx.room.id) };
  },
});
