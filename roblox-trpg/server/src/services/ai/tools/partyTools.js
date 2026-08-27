/**
 * 阶段13 队伍与决策工具。
 * 红线：AI 只能【创建选择请求】与读取状态 —— 不能强制选择、不能改倒计时、
 * 不能改投票、不能直接修改玩家关系（无任何关系写工具）。
 */
const { register, ToolError, resolveRoomPlayer } = require('./index');
const partyService = require('../../party/partyService');
const playerRelations = require('../../party/playerRelations');
const decisionEngine = require('../../party/decisionEngine');

register({
  name: 'get_party_status',
  description: '只读：获取当前房间主队伍状态（成员/叙事定位/队长/成员间关系）。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    const party = partyService.getActiveParty(ctx.room.id);
    if (!party) return { ok: true, party: null, note: '当前房间没有队伍' };
    return { ok: true, party: partyService.partyView(party.id) };
  },
});

register({
  name: 'get_player_relationship',
  description: '只读：查询两名玩家的关系（数值与类型）。关系只能由类型化事件改变，AI 无修改途径。',
  permission: 'READ_ONLY',
  inputSchema: {
    type: 'object',
    properties: {
      playerA: { type: 'string', required: true, maxLength: 64 },
      playerB: { type: 'string', required: true, maxLength: 64 },
    },
  },
  execute(ctx, args) {
    const a = resolveRoomPlayer(ctx, args.playerA);
    const b = resolveRoomPlayer(ctx, args.playerB);
    const rel = playerRelations.getRelationship(a.playerRowId, b.playerRowId);
    return { ok: true, playerA: a.name, playerB: b.name, value: rel.value, relationshipType: rel.relationshipType };
  },
});

register({
  name: 'create_decision',
  description:
    '创建一个普通剧情选择（NORMAL，无时限），由玩家选择后服务器结算。' +
    '选项 2~4 个；效果白名单：npc/quest/world_event/player_relationship/damage/heal/flag（全部由服务器验证与执行）。' +
    'AI 不能直接宣布结果 —— 必须等待玩家选择。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', required: true, maxLength: 500, description: '剧情文本（如 NPC 的提问）' },
      options: {
        type: 'string',
        required: true,
        maxLength: 800,
        description: 'JSON 数组：[{"key":"A","text":"帮助管理员"},{"key":"B","text":"离开"}]（可选 result 效果对象）',
      },
      target: { type: 'string', maxLength: 64, description: '可选：指定决策玩家（默认任何房间玩家可选）' },
      tag: { type: 'string', maxLength: 40, description: '任务联动标签（任务目标可匹配）' },
    },
  },
  execute(ctx, args) {
    let options;
    try {
      options = JSON.parse(args.options);
    } catch {
      throw new ToolError('options 必须是合法 JSON 数组', 'invalid_args');
    }
    const target = args.target ? resolveRoomPlayer(ctx, args.target) : null;
    const decision = decisionEngine.createDecision(ctx.io, ctx.room.id, {
      type: 'NORMAL',
      prompt: args.prompt,
      options,
      tag: args.tag || null,
      targetPlayerId: target ? target.playerRowId : null,
      creator: ctx.playerUid || 'ai',
    });
    return { ok: true, uid: decision.uid, type: 'NORMAL', note: '等待玩家选择；AI 不能代替玩家决定。' };
  },
});

register({
  name: 'create_timed_decision',
  description:
    '创建限时选择（TIMED）：危险场景/战斗瞬间/剧情压力。服务器计时（客户端只显示倒计时），' +
    '超时自动执行 default_option。时长由服务器钳制，AI 不能延长/取消/修改结果。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', required: true, maxLength: 500, description: '如：Rush 声音越来越近！' },
      options: { type: 'string', required: true, maxLength: 800, description: 'JSON 数组（2~4 个选项，可含 result 效果）' },
      default_option: { type: 'string', required: true, enum: ['A', 'B', 'C', 'D'], description: '超时自动执行的选项' },
      timeout_seconds: { type: 'integer', min: 1, max: 60, description: '倒计时秒数（服务器钳制）' },
      target: { type: 'string', maxLength: 64 },
      tag: { type: 'string', maxLength: 40 },
    },
  },
  execute(ctx, args) {
    let options;
    try {
      options = JSON.parse(args.options);
    } catch {
      throw new ToolError('options 必须是合法 JSON 数组', 'invalid_args');
    }
    const target = args.target ? resolveRoomPlayer(ctx, args.target) : null;
    const decision = decisionEngine.createDecision(ctx.io, ctx.room.id, {
      type: 'TIMED',
      prompt: args.prompt,
      options,
      defaultOption: args.default_option,
      timeoutMs: (args.timeout_seconds || 10) * 1000,
      tag: args.tag || null,
      targetPlayerId: target ? target.playerRowId : null,
      creator: ctx.playerUid || 'ai',
    });
    return { ok: true, uid: decision.uid, type: 'TIMED', expiresAt: decision.expires_at, timeoutMs: decision.timeout_ms, note: '服务器计时；超时自动执行默认选项。' };
  },
});

register({
  name: 'request_party_vote',
  description:
    '创建团队决策（PARTY）：仅用于真正需要全队决定的场合（如副本路线）。队伍成员投票，' +
    '达到 required_votes 或全员投票后按多数结算（平票执行默认选项）；超时执行默认选项。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', required: true, maxLength: 500 },
      options: { type: 'string', required: true, maxLength: 800, description: 'JSON 数组（2~4 个选项，可含 result 效果）' },
      default_option: { type: 'string', required: true, enum: ['A', 'B', 'C', 'D'] },
      required_votes: { type: 'integer', min: 1, max: 3, description: '达标票数（默认全员）' },
      timeout_seconds: { type: 'integer', min: 1, max: 60 },
      tag: { type: 'string', maxLength: 40 },
    },
  },
  execute(ctx, args) {
    let options;
    try {
      options = JSON.parse(args.options);
    } catch {
      throw new ToolError('options 必须是合法 JSON 数组', 'invalid_args');
    }
    try {
      const decision = decisionEngine.createDecision(ctx.io, ctx.room.id, {
        type: 'PARTY',
        prompt: args.prompt,
        options,
        defaultOption: args.default_option,
        requiredVotes: args.required_votes || null,
        resultRule: 'MAJORITY',
        timeoutMs: (args.timeout_seconds || 30) * 1000,
        tag: args.tag || null,
        creator: ctx.playerUid || 'ai',
      });
      return { ok: true, uid: decision.uid, type: 'PARTY', requiredVotes: decision.required_votes, expiresAt: decision.expires_at };
    } catch (err) {
      throw new ToolError(err.message, err.code === 'NO_PARTY' ? 'tool_error' : 'invalid_args');
    }
  },
});

register({
  name: 'resolve_decision',
  description:
    '结算决策（受限）：仅当团队投票已达标或已超时时执行结算。' +
    'AI 绝不能代替玩家选择、不能强制结算等待中的普通/限时选择。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: { decision: { type: 'string', required: true, maxLength: 32, description: '决策 uid' } },
  },
  execute(ctx, args) {
    try {
      const r = decisionEngine.resolveIfReady(ctx.io, args.decision);
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof decisionEngine.DecisionError) {
        throw new ToolError(err.message, err.code === 'PLAYER_CHOICE_PENDING' || err.code === 'VOTES_PENDING' ? 'forbidden' : 'tool_error');
      }
      throw err;
    }
  },
});
