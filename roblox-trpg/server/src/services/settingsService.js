/**
 * 阶段25：系统设置（后端 Admin Web UI 的持久层）。
 * 键值存 system_settings 表；读取顺序：DB 设置 > 环境变量 > 默认值。
 * 白名单键（防止任意键写入）：
 *   ai.base_url / ai.api_key / ai.model / ai.api_format / ai.timeout_ms /
 *   ai.stream / ai.context_budget
 */
const { getDb } = require('@roblox-trpg/database');

const SETTING_KEYS = [
  'ai.base_url',
  'ai.api_key',
  'ai.model',
  'ai.api_format',
  'ai.timeout_ms',
  'ai.stream',
  'ai.context_budget',
];

function isValidKey(key) {
  return SETTING_KEYS.includes(key);
}

/** 读单个设置（仅 DB 值；不合并 env）。 */
function getRawSetting(key) {
  if (!isValidKey(key)) return null;
  const row = getDb().prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** 读配置值：DB 设置 > fallback（调用方传 env/默认值）。 */
function getSetting(key, fallback = null) {
  const v = getRawSetting(key);
  return v === null || v === '' ? fallback : v;
}

/** 写设置（白名单校验；空值 = 删除，回落到 env）。 */
function setSetting(key, value) {
  if (!isValidKey(key)) {
    const err = new Error(`不支持的设置键：${key}（允许：${SETTING_KEYS.join('/')}）`);
    err.code = 'SETTING_KEY_NOT_ALLOWED';
    throw err;
  }
  const db = getDb();
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(key);
    return { key, cleared: true };
  }
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value));
  return { key, value: String(value) };
}

/** 批量写。 */
function setSettings(obj = {}) {
  const results = [];
  for (const [k, v] of Object.entries(obj)) results.push(setSetting(k, v));
  return results;
}

/** 当前生效的 AI 运行时配置快照（DB > env > 默认；供 Admin UI 展示与 provider 读取）。 */
function aiRuntimeConfig() {
  const { getAiRuntimeConfig } = require('./ai/providers/AiProvider');
  return getAiRuntimeConfig();
}

/** Admin 展示视图（密钥打码）。 */
function adminView() {
  const cfg = aiRuntimeConfig();
  const masked = cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : '';
  const dbKeys = Object.fromEntries(
    getDb().prepare('SELECT key FROM system_settings').all().map((r) => [r.key, true])
  );
  return {
    ai: {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      format: cfg.format,
      timeoutMs: cfg.timeoutMs,
      apiKeyMasked: masked,
      hasApiKey: Boolean(cfg.apiKey),
      stream: getSetting('ai.stream', process.env.AI_STREAM || 'on'),
    },
    context: {
      budget: Number(
        getSetting('ai.context_budget', process.env.AI_CONTEXT_BUDGET || require('../config').AI_CONTEXT_BUDGET)
      ),
    },
    overriddenKeys: dbKeys,
  };
}

module.exports = {
  SETTING_KEYS,
  isValidKey,
  getSetting,
  getRawSetting,
  setSetting,
  setSettings,
  aiRuntimeConfig,
  adminView,
};
