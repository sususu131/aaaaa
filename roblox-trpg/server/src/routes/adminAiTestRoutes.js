const express = require('express');
const path = require('path');
const settingsService = require('../services/settingsService');
const { OpenAIProvider } = require('../services/ai/providers/OpenAIProvider');
const { getVisionRuntimeConfig } = require('../services/vision/visionProvider');
const { analyzeAvatar } = require('../services/vision/deepseekVision');
const rules = require('../services/vision/avatarRules');
const { getDb } = require('@roblox-trpg/database');

const router = express.Router();

// 本地/个人测试项目：Admin AI 测试接口不启用鉴权。
function guard(_req, _res) {
  return true;
}

router.get('/admin/ai-test', (req, res) => {
  if (!guard(req, res)) return;
  res.sendFile(path.join(__dirname, '../admin/ai-test.html'));
});

router.get('/api/admin/ai-test/config', (req, res) => {
  if (!guard(req, res)) return;
  const view = settingsService.adminView();
  res.json({
    ai: { model: view.ai.model, format: view.ai.format, baseUrl: view.ai.baseUrl, hasApiKey: view.ai.hasApiKey },
    vision: { model: view.vision.model, baseUrl: view.vision.baseUrl, hasApiKey: view.vision.hasApiKey },
  });
});

router.post('/api/admin/ai-test/text', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const text = String(req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: '文本不能为空' });
    const provider = new OpenAIProvider();
    const session = provider.startSession({ system: '你是一个 API 测试助手。请直接、简洁地回答用户。', userContent: text });
    const started = Date.now();
    const result = await provider.chat(session, []);
    res.json({ ok: true, elapsedMs: Date.now() - started, text: result.content, reasoning: result.normalized && result.normalized.reasoning || '', usage: result.usage || null, raw: result.normalized && result.normalized.raw || null });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || 'AI 调用失败', kind: err.kind || null });
  }
});

router.post('/api/admin/ai-test/vision', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const imageUrl = String(req.body && req.body.imageUrl || '').trim();
    const prompt = String(req.body && req.body.prompt || '').trim();
    if (!imageUrl) return res.status(400).json({ error: '图片不能为空' });
    const cfg = getVisionRuntimeConfig();
    if (!cfg.baseUrl || !cfg.apiKey) return res.status(400).json({ error: 'Vision API 未配置 Base URL 或 API Key' });
    const allowedSkillKeys = getDb()
      .prepare("SELECT name FROM skills WHERE source_type = 'INITIAL_AVATAR' AND status = 'approved'")
      .all().map(r => r.name);
    const started = Date.now();
    const result = await analyzeAvatar({
      imageUrl,
      prompt,
      allowedTags: rules.ALLOWED_AVATAR_TAGS,
      allowedSkillIds: allowedSkillKeys,
    });
    res.json({ ok: true, elapsedMs: Date.now() - started, provider: result.provider, model: result.model, raw: result.raw, allowedTags: rules.ALLOWED_AVATAR_TAGS, allowedSkillIds: allowedSkillKeys });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || 'Vision 调用失败', kind: err.kind || null });
  }
});

module.exports = router;
