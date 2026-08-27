/**
 * 阶段25：后端 Admin Web UI + 设置 API。
 * - GET  /admin                     → 管理页（无构建步骤的纯 HTML）
 * - GET  /api/admin/settings        → 当前生效配置（密钥打码）
 * - POST /api/admin/settings        → 批量保存（白名单键；空值=清除回落 env）
 * - POST /api/admin/ai/test         → 测试 AI 连通性（GET {base}/models，不发对话请求）
 * 鉴权：设置了 ADMIN_TOKEN 环境变量时要求 X-Admin-Token / ?admin_token=。
 */
const express = require('express');
const path = require('path');
const settingsService = require('../services/settingsService');

const router = express.Router();

function authorized(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true; // 未配置 = 开发模式开放
  const provided = req.get('X-Admin-Token') || req.query.admin_token || '';
  return provided === token;
}

function guard(req, res) {
  if (!authorized(req)) {
    res.status(401).json({ error: '需要管理员令牌（X-Admin-Token）', code: 'ADMIN_UNAUTHORIZED' });
    return false;
  }
  return true;
}

/** GET /admin —— 管理页。 */
router.get('/admin', (req, res) => {
  if (!guard(req, res)) return;
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});

/** GET /api/admin/settings —— 当前生效配置（密钥打码）+ 可调项。 */
router.get('/api/admin/settings', (req, res) => {
  if (!guard(req, res)) return;
  try {
    res.json({
      view: settingsService.adminView(),
      keys: settingsService.SETTING_KEYS,
      presets: {
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', format: 'anthropic' },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
        gemini_compat: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

/** POST /api/admin/settings { ai: { base_url, api_key, model, api_format, timeout_ms, stream }, context: { budget } } */
router.post('/api/admin/settings', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { ai = {}, context = {} } = req.body || {};
    const patch = {};
    const map = {
      base_url: 'ai.base_url',
      api_key: 'ai.api_key',
      model: 'ai.model',
      api_format: 'ai.api_format',
      timeout_ms: 'ai.timeout_ms',
      stream: 'ai.stream',
    };
    for (const [field, key] of Object.entries(map)) {
      if (ai[field] !== undefined) patch[key] = ai[field];
    }
    if (context.budget !== undefined) patch['ai.context_budget'] = context.budget;
    const results = settingsService.setSettings(patch);
    res.json({ saved: results, view: settingsService.adminView() });
  } catch (err) {
    res.status(err.code === 'SETTING_KEY_NOT_ALLOWED' ? 400 : 500).json({ error: err.message, code: err.code || 'ADMIN_ERROR' });
  }
});

/** POST /api/admin/ai/test —— 连通性测试（对 {base}/models 发 GET；不消耗对话 token）。 */
router.post('/api/admin/ai/test', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const cfg = settingsService.aiRuntimeConfig();
    if (!cfg.apiKey) return res.json({ ok: false, reason: '未配置 API Key' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      res.json({ ok: r.ok, status: r.status, baseUrl: cfg.baseUrl, model: cfg.model });
    } catch (err) {
      clearTimeout(timer);
      res.json({ ok: false, reason: err.name === 'AbortError' ? '超时（8s）' : err.message, baseUrl: cfg.baseUrl });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

module.exports = router;
