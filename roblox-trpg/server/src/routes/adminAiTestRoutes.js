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
    // 阶段30：返回 Vision AI 真实输出 + 请求元数据（完整排查材料）
    console.log('[vision:admin-test] 请求:', JSON.stringify(result.requestBody));
    console.log('[vision:admin-test] 模型回复原文:', String(result.rawText || '').slice(0, 2000));
    res.json({
      ok: true,
      elapsedMs: Date.now() - started,
      provider: result.provider,
      model: result.model,
      raw: result.raw,                       // 解析后的 JSON
      rawText: result.rawText,               // 模型回复原文（Vision AI 真实输出）
      gatewayResponse: result.rawResponse,   // 网关完整响应
      request: result.requestBody,           // 本次请求（端点/模型/图片前缀）
      allowedTags: rules.ALLOWED_AVATAR_TAGS,
      allowedSkillIds: allowedSkillKeys,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || 'Vision 调用失败', kind: err.kind || null });
  }
});

// ── 阶段30：Vision 初始化日志（真实输出/服务器验证/最终数值）──

/** GET /api/admin/vision-logs?limit=20 —— 最近 Vision 分析日志（含 AI 原始输出与最终数值）。 */
router.get('/api/admin/vision-logs', (req, res) => {
  if (!guard(req, res)) return;
  try {
    const limit = Math.min(Number(req.query.limit || 20) || 20, 100);
    const rows = getDb()
      .prepare(
        `SELECT id, player_id, roblox_user_id, image_url, vision_provider, vision_model,
                candidate_tags, accepted_tags, rejected_tags, candidate_skills, accepted_skills, rejected_skills,
                final_attributes, final_skills, raw_response, request_meta, status, error, created_at
         FROM vision_analysis_log ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    const parse = (s2) => { try { return JSON.parse(s2 || ''); } catch { return s2 || null; } };
    res.json({
      logs: rows.map((r) => ({
        id: r.id,
        playerId: r.player_id,
        robloxUserId: r.roblox_user_id,
        imageUrl: r.image_url,
        provider: r.vision_provider,
        model: r.vision_model,
        candidateTags: parse(r.candidate_tags),
        acceptedTags: parse(r.accepted_tags),
        rejectedTags: parse(r.rejected_tags),
        candidateSkills: parse(r.candidate_skills),
        acceptedSkills: parse(r.accepted_skills),
        rejectedSkills: parse(r.rejected_skills),
        finalAttributes: parse(r.final_attributes),
        finalSkills: parse(r.final_skills),
        rawResponse: parse(r.raw_response),
        requestMeta: parse(r.request_meta),
        status: r.status,
        error: r.error,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'ADMIN_ERROR' });
  }
});

module.exports = router;
