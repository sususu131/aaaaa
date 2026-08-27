module.exports = {
  PORT: process.env.PORT || 3000,
  ROOM_MAX_PLAYERS: 3,      // 单房间容量上限（需求F6：2-3名玩家）
  PLAYER_NAME_MAX: 16,      // 名字长度上限
  MESSAGE_MAX: 2000,        // 单条消息长度上限（阶段2：防刷，2000字符）
  ROOM_CODE_LENGTH: 6,      // 房间码长度

  // ── 阶段2：AI GM（OpenAI 兼容 API，Key 只存服务端环境变量）──
  AI_BASE_URL: process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  AI_API_KEY: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'gpt-4o-mini',
  AI_TIMEOUT_MS: 25000,
  AI_CONTEXT_BUDGET: Number(process.env.AI_CONTEXT_BUDGET || 100000), // tokens

  // Context 压缩阈值（占 budget 比例）
  CONTEXT_WARN_RATIO: 0.7,
  CONTEXT_PREPARE_RATIO: 0.8,
  CONTEXT_COMPRESS_RATIO: 0.9,
  RECENT_EVENTS_KEEP: 15,   // 压缩后保留的最近消息条数

  // AI 请求频率限制
  AI_RATE_PER_PLAYER: Number(process.env.AI_RATE_PER_PLAYER || 6),   // 每玩家每分钟
  AI_RATE_PER_ROOM: Number(process.env.AI_RATE_PER_ROOM || 12),      // 每房间每分钟

  // Context Viewer 可见范围：all（开发期）/ host / none
  CONTEXT_VIEWER_SCOPE: process.env.CONTEXT_VIEWER_SCOPE || 'all',

  // Roblox 公开信息缓存 TTL（毫秒）
  ROBLOX_TTL_EXPERIENCE: 30 * 60 * 1000,   // 体验资料 30 分钟
  ROBLOX_TTL_USER: 6 * 60 * 60 * 1000,     // 用户资料 6 小时
  ROBLOX_TTL_THUMBNAIL: 12 * 60 * 60 * 1000, // 缩略图 12 小时
  ROBLOX_TIMEOUT_MS: Number(process.env.ROBLOX_TIMEOUT_MS || 8000),

  // 会话（临时身份）
  SESSION_TTL_DAYS: 30,
  COOKIE_NAME: 'rtp_session',

  // ── 阶段3：AI Agent + Tool 系统 ──
  AI_API_FORMAT: process.env.AI_API_FORMAT || 'openai', // openai | anthropic
  AI_MAX_TOOL_ROUNDS: Number(process.env.AI_MAX_TOOL_ROUNDS || 6), // 防无限 Tool Loop
  AI_MAX_FINAL_CHARS: 2000,
  WORLD_ALLOWED_FIELDS: [
    // 仅允许 AI 通过 modify_world_state 修改的 TRPG_ORIGINAL 字段（白名单）
    'door_open',
    'generator_power',
    'alarm_active',
    'current_scene',
    'dungeon_completed',
    'lights_on',
    'note_found',
  ],
  ITEM_MAX_QUANTITY: 99,        // grant_item 单次数量上限
  PLAYER_MAX_HP: 999,           // modify_player_state 数值范围上限
  SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || 'null', // null | serper
  SERPER_API_KEY: process.env.SERPER_API_KEY || '',

  // ── 阶段3b：Vision（与文字 AI 配置完全独立，绝不复用 AI_*）──
  // VISION_API_KEY / VISION_BASE_URL / VISION_MODEL 在调用时读取环境变量
  VISION_DEFAULT_MODEL: 'deepseek-v4-flash-vision-exp',

  // ── 阶段7：Agent Runtime 2.0 预算（防无限循环/成本控制）──
  AGENT_MAX_TOOL_ROUNDS: Number(process.env.AGENT_MAX_TOOL_ROUNDS || 8),
  AGENT_MAX_TOOLS: Number(process.env.AGENT_MAX_TOOLS || 16),
  AGENT_MAX_SEARCHES: Number(process.env.AGENT_MAX_SEARCHES || 4),
  AGENT_SEARCH_QUERY_MAX: 500,
  AGENT_MAX_QUERIES_PER_SEARCH: 4,
  AGENT_MAX_DURATION_MS: Number(process.env.AGENT_MAX_DURATION_MS || 60000),
  AGENT_MAX_OUTPUT_TOKENS: Number(process.env.AGENT_MAX_OUTPUT_TOKENS || 1500),
  AI_STREAM: process.env.AI_STREAM !== 'off',
  // 限时抉择（QTE）：超时未选择即承受失败后果
  TIMED_EVENT_MIN_MS: 3000,
  TIMED_EVENT_MAX_MS: 60000,

  // ── 阶段12：World Simulation & Dynamic Event System ──
  WORLD_TICK_INTERVAL_MS: Number(process.env.WORLD_TICK_INTERVAL_MS || 30000), // World Tick 周期（默认30秒）
  WORLD_EVENT_MAX_ACTIVE: Number(process.env.WORLD_EVENT_MAX_ACTIVE || 3),      // 单房间活跃事件上限
  WORLD_EVENT_MAX_DURATION_MS: Number(process.env.WORLD_EVENT_MAX_DURATION_MS || 30 * 60 * 1000), // AI 可申请的最长时长
  WORLD_EVENT_COOLDOWN_MS: Number(process.env.WORLD_EVENT_COOLDOWN_MS || 10 * 60 * 1000),         // 同类型事件冷却
};
