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
  name: 'get_world_simulation',
  description:
    '只读：获取世界模拟快照 —— 当前世界事件 / 阵营关系 / NPC 活动（行为状态与位置）/ 副本变体 / 调度器状态。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    return { ok: true, ...worldSim.worldSnapshot(ctx.room.id) };
  },
});
