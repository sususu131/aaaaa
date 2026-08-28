/**
 * 阶段25：后端 Admin Web UI + 设置 API。
 * 本地/个人测试项目：Admin 接口不启用鉴权。
 */
const express = require('express');
const path = require('path');
const settingsService = require('../services/settingsService');

const router = express.Router();

// 本地/个人测试项目：Admin 接口完全开放。
function guard(_req, _res) {
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
    const { ai = {}, context = {}, vision = {}, search = {} } = req.body || {};
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
    for (const [section, fieldMap] of Object.entries(FIELD_MAP_EXTRA)) {
      const body = section === 'vision' ? vision : search;
      for (const [field, key] of Object.entries(fieldMap)) {
        if (body[field] !== undefined) patch[key] = body[field];
      }
    }
    const results = settingsService.setSettings(patch);
    res.json({ saved: results, view: settingsService.adminView() });
  } catch (err) {
    res.status(err.code === 'SETTING_KEY_NOT_ALLOWED' ? 400 : 500).json({ error: err.message, code: err.code || 'ADMIN_ERROR' });
  }
});

const FIELD_MAP_EXTRA = {
  vision: {
    base_url: 'vision.base_url',
    api_key: 'vision.api_key',
    model: 'vision.model',
    timeout_ms: 'vision.timeout_ms',
  },
  search: {
    provider: 'search.provider',
    serper_api_key: 'search.serper_api_key',
    bing_api_key: 'search.bing_api_key',
    brave_api_key: 'search.brave_api_key',
    tavily_api_key: 'search.tavily_api_key',
  },
};

router.get('/api/admin/status', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { getDb } = require('@roblox-trpg/database');
    const db = getDb();
    const count = (sql) => { try { return db.prepare(sql).get().c; } catch { return null; } };
    const worldSim = require('../services/world/worldSim');
    const fs = require('fs');
    let dbSize = null;
    try { dbSize = fs.statSync(require('path').join(process.cwd(), '../../database/data/roblox_trpg.db')).size; } catch { /* ignore */ }
    res.json({
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      db: {
        sizeBytes: dbSize,
        players: count('SELECT COUNT(*) c FROM players'),
        rooms: count('SELECT COUNT(*) c FROM rooms'),
        dungeons: count('SELECT COUNT(*) c FROM dungeons'),
        runningInstances: count("SELECT COUNT(*) c FROM dungeon_instances WHERE status IN ('WAITING','RUNNING','PAUSED')"),
        events: count('SELECT COUNT(*) c FROM game_events'),
        skills: count('SELECT COUNT(*) c FROM skills'),
        items: count('SELECT COUNT(*) c FROM items'),
      },
      worldScheduler: worldSim.getSchedulerState(),
      config: require('../services/settingsService').adminView(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

router.get('/api/admin/events', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { getDb } = require('@roblox-trpg/database');
    const limit = Math.min(Number(req.query.limit || 20) || 20, 100);
    const rows = getDb().prepare('SELECT uid, type, actor, data, created_at FROM game_events ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ events: rows });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

for (const [action, fn] of [['pause', 'pause'], ['resume', 'resume']]) {
  router.post(`/api/admin/world/${action}`, (req, res) => {
    if (!guard(req, res)) return;
    try {
      const worldSim = require('../services/world/worldSim');
      const { io } = require('../index.js');
      worldSim[fn](io);
      res.json({ ok: true, worldScheduler: worldSim.getSchedulerState() });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
    }
  });
}

router.post('/api/admin/presets/reimport', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { io } = require('../index.js');
    const results = require('../services/presets/presetSeeder').runPresetSeeder(io);
    res.json({ ok: true, results: results.map((r) => ({ key: r.key, error: r.error || null })) });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

router.post('/api/admin/vision/test', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { getVisionRuntimeConfig } = require('../services/vision/visionProvider');
    const cfg = getVisionRuntimeConfig();
    if (!cfg.baseUrl || !cfg.apiKey) return res.json({ ok: false, reason: '未配置 Vision Base URL 或 API Key' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: controller.signal });
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

router.post('/api/admin/search/test', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { getSearchProvider } = require('../services/search/SearchProvider');
    const provider = getSearchProvider();
    try {
      const results = await provider.search('roblox');
      res.json({ ok: true, provider: provider.constructor.name, resultCount: results.length });
    } catch (err) {
      res.json({ ok: false, provider: provider.constructor.name, reason: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

router.post('/api/admin/ai/test', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const cfg = settingsService.aiRuntimeConfig();
    if (!cfg.apiKey) return res.json({ ok: false, reason: '未配置 API Key' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: controller.signal });
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
