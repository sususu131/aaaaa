/**
 * Tool Registry（阶段3 第三节）：统一注册、参数验证、权限验证、审计。
 * AI 永远不能直接执行 SQL —— 只能通过白名单 Tool，由服务器完成校验与写库。
 */
const { getDb } = require('@roblox-trpg/database');

const registry = new Map();

/** Tool 错误（会作为 tool result 返回给 AI，让它调整而非崩溃）。 */
class ToolError extends Error {
  constructor(message, kind = 'tool_error') {
    super(message);
    this.name = 'ToolError';
    this.kind = kind; // invalid_args | unknown_tool | forbidden | version_conflict | not_found
  }
}

/** 简易 schema 校验：type / required / enum / min / max / maxLength。 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || { properties: {} };
  const props = schema.properties || {};
  if (args && args.__parse_error) throw new ToolError('工具参数不是合法 JSON', 'invalid_args');
  const a = args || {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new ToolError('工具参数必须是对象', 'invalid_args');

  for (const [key, rule] of Object.entries(props)) {
    const v = a[key];
    if (v === undefined || v === null || v === '') {
      if (rule.required) throw new ToolError(`缺少必填参数 "${key}"`, 'invalid_args');
      continue;
    }
    if (rule.type === 'integer' && (!Number.isInteger(v) || Number.isNaN(v)))
      throw new ToolError(`参数 "${key}" 必须是整数`, 'invalid_args');
    if (rule.type === 'number' && (typeof v !== 'number' || Number.isNaN(v)))
      throw new ToolError(`参数 "${key}" 必须是数字`, 'invalid_args');
    if (rule.type === 'string' && typeof v !== 'string') throw new ToolError(`参数 "${key}" 必须是字符串`, 'invalid_args');
    if (rule.type === 'boolean' && typeof v !== 'boolean') throw new ToolError(`参数 "${key}" 必须是布尔值`, 'invalid_args');
    if (rule.enum && !rule.enum.includes(v))
      throw new ToolError(`参数 "${key}" 必须是 [${rule.enum.join('|')}] 之一`, 'invalid_args');
    if (rule.min !== undefined && Number(v) < rule.min) throw new ToolError(`参数 "${key}" 不能小于 ${rule.min}`, 'invalid_args');
    if (rule.max !== undefined && Number(v) > rule.max) throw new ToolError(`参数 "${key}" 不能大于 ${rule.max}`, 'invalid_args');
    if (rule.maxLength !== undefined && String(v).length > rule.maxLength)
      throw new ToolError(`参数 "${key}" 过长（最多${rule.maxLength}字符）`, 'invalid_args');
  }
  return a;
}

/** 参数脱敏：绝不把 Key/token/密码写进审计日志。 */
function sanitizeArgs(args) {
  try {
    const s = JSON.stringify(args || {});
    return s
      .replace(/("(?:[^"]*(?:key|token|secret|password|cookie)[^"]*)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
      .slice(0, 800);
  } catch {
    return '[unserializable]';
  }
}

/** 注册 Tool。 */
function register(tool) {
  if (!tool.name || typeof tool.execute !== 'function') throw new Error('非法 Tool 定义');
  registry.set(tool.name, tool);
}

function getRegistry() {
  return [...registry.values()];
}

/** 给 provider 的工具描述列表。 */
function toolDefinitions() {
  return getRegistry().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

/**
 * 执行 Tool（统一入口）：校验 → 权限 → 执行 → 审计。
 * ctx: { io, room, playerUid, actingPlayerName, pendingOptions }
 */
async function runTool(ctx, name, args) {
  const tool = registry.get(name);
  if (!tool) {
    audit(ctx, name, args, `未知工具 ${name}`, false);
    throw new ToolError(`工具 "${name}" 不存在`, 'unknown_tool');
  }

  try {
    const validArgs = validateArgs(tool, args); // 参数非法同样进入审计
    const result = await tool.execute(ctx, validArgs);
    audit(ctx, name, args, result, true);
    return result;
  } catch (err) {
    audit(ctx, name, args, err.message, false);
    if (err instanceof ToolError) throw err;
    throw new ToolError(err.message || '工具执行失败', err.kind || 'tool_error');
  }
}

/** 审计落库（roomId/playerUid/toolName/args/result/success/timestamp；已脱敏）。 */
function audit(ctx, name, args, result, success) {
  try {
    getDb()
      .prepare(
        'INSERT INTO tool_calls (room_id, player_uid, tool_name, arguments, result, success) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        ctx.room ? ctx.room.id : null,
        ctx.playerUid || null,
        name,
        sanitizeArgs(args),
        String(typeof result === 'object' ? JSON.stringify(result) : result).slice(0, 500),
        success ? 1 : 0
      );
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 在房间内解析目标玩家（仅限当前房间，禁止跨房间读取）。 */
function resolveRoomPlayer(ctx, playerIdRef) {
  const ref = String(playerIdRef || '').trim();
  const p = ctx.room.players.find((x) => x.name === ref || x.uid === ref);
  if (!p) throw new ToolError(`玩家 "${ref}" 不在当前房间（禁止访问其他房间玩家）`, 'forbidden');
  const row = getDb().prepare('SELECT * FROM players WHERE socket_id = ?').get(p.socketId);
  if (!row) throw new ToolError('玩家记录不存在', 'not_found');
  return { name: p.name, uid: row.uid, playerRowId: row.id };
}

// ── 阶段7：权限模型 + Context-aware 工具可见性 ──
const PERMISSION_LEVELS = ['READ_ONLY', 'GAME_ACTION', 'REWARD', 'ADMIN', 'WEB', 'ROBLOX', 'AI_INTERNAL'];

/** 每个工具的权限与可用范围（Lobby/房间/副本/结算）。 */
const TOOL_META = {
  get_world_state: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  get_player_state: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  get_dungeon_state: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  get_character: { permission: 'READ_ONLY', scopes: ['lobby', 'room', 'dungeon'] },
  get_scene: { permission: 'READ_ONLY', scopes: ['dungeon'] },
  roll_dice: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  skill_check: { permission: 'GAME_ACTION', scopes: ['dungeon'] },
  use_skill: { permission: 'GAME_ACTION', scopes: ['dungeon'] },
  damage_player: { permission: 'GAME_ACTION', scopes: ['dungeon'] },
  heal_player: { permission: 'GAME_ACTION', scopes: ['dungeon'] },
  modify_world_state: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  modify_player_state: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  grant_item: { permission: 'REWARD', scopes: ['dungeon'] },
  grant_skill: { permission: 'REWARD', scopes: ['dungeon'] },
  complete_dungeon: { permission: 'GAME_ACTION', scopes: ['dungeon'] },
  create_option: { permission: 'AI_INTERNAL', scopes: ['room', 'dungeon'] },
  web_search: { permission: 'WEB', scopes: ['lobby', 'room', 'dungeon'] },
  roblox_search: { permission: 'ROBLOX', scopes: ['lobby', 'room', 'dungeon'] },
  search_roblox_experiences: { permission: 'ROBLOX', scopes: ['lobby', 'room', 'dungeon'] },
  get_roblox_experience: { permission: 'ROBLOX', scopes: ['lobby', 'room', 'dungeon'] },
  get_roblox_user: { permission: 'ROBLOX', scopes: ['lobby', 'room', 'dungeon'] },
  get_roblox_avatar: { permission: 'ROBLOX', scopes: ['lobby', 'room', 'dungeon'] },
  // 阶段8：Quest 工具
  get_active_quests: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  get_quest: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  get_quest_progress: { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] },
  start_quest: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  abandon_quest: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  advance_quest: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
  submit_quest_choice: { permission: 'GAME_ACTION', scopes: ['room', 'dungeon'] },
};

function toolMeta(name) {
  return TOOL_META[name] || { permission: 'READ_ONLY', scopes: ['room', 'dungeon'] };
}

/** Context-aware：按当前范围过滤可见工具（第九节）。 */
function toolsForScope(scope) {
  return getRegistry().filter((t) => (toolMeta(t.name).scopes || []).includes(scope));
}

function toolDefinitionsForScope(scope) {
  return toolsForScope(scope).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    permission: toolMeta(t.name).permission,
  }));
}

module.exports = {
  register,
  runTool,
  getRegistry,
  toolDefinitions,
  resolveRoomPlayer,
  ToolError,
  PERMISSION_LEVELS,
  toolMeta,
  toolsForScope,
  toolDefinitionsForScope,
};

// 注册全部工具
require('./getWorldState');
require('./getPlayerState');
require('./getDungeonState');
require('./rollDice');
require('./skillCheck');
require('./modifyWorldState');
require('./modifyPlayerState');
require('./grantItem');
require('./grantSkill');
require('./completeDungeon');
require('./createOption');
require('./robloxTools');
require('./webSearch');
// 阶段7 新增
require('./getCharacter');
require('./getScene');
require('./damageHeal');
require('./useSkill');
require('./robloxSearch');
// 阶段8 新增
require('./questTools');
