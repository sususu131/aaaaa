/**
 * Vision REST（阶段3b）：前端只请求自己的服务器，服务器再请求 Vision Provider。
 * VISION_API_KEY / AI_API_KEY 绝不下发前端。
 */
const express = require('express');
const { getDb } = require('@roblox-trpg/database');
const { resolveSession } = require('../sessions/sessionManager');
const { initializeAvatar, getInitRow } = require('../services/vision/initializeAvatar');
const { getVisionRuntimeConfig } = require('../services/vision/visionProvider');
const robloxThumbnails = require('../services/roblox/robloxThumbnails');
const rules = require('../services/vision/visualRules');

const router = express.Router();

/** 从 cookie 或 body 解析会话。 */
function authPlayer(req) {
  let token = (req.query && req.query.sessionToken) || (req.query && req.query.token) || '';
  if (!token && req.headers && req.headers['x-session-token']) token = req.headers['x-session-token'];
  if (!token && req.body && req.body.sessionToken) token = req.body.sessionToken;
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)rtp_session=([^;]+)/);
    token = m && m[1];
  }
  const sess = token ? resolveSession(token) : null;
  return sess;
}

/**
 * POST /api/vision/avatar/analyze { sessionToken? , playerId? }
 * 服务器自行：查会话 → 查玩家 → 查 Roblox 资料 → 取头像 → 调用 Vision。
 * 玩家不能提交任意技能/属性。
 */
router.post('/api/vision/avatar/analyze', async (req, res) => {
  try {
    const sess = authPlayer(req);
    if (!sess) return res.status(401).json({ error: '无效会话' });

    const db = getDb();
    const player = db
      .prepare(
        `SELECT p.*, rp.roblox_user_id, rp.headshot_url, rp.fullbody_url
         FROM players p LEFT JOIN roblox_profiles rp ON rp.id = p.roblox_profile_id
         WHERE p.id = ?`
      )
      .get(sess.playerRowId);
    if (!player) return res.status(404).json({ error: '玩家不存在' });

    let avatarUrl = player.fullbody_url || player.headshot_url || null;
    let avatarExtraViews = [];
    // 优先全身，其次 headshot；两者都无 → 服务端再尝试拉一次公开缩略图
    if (!avatarUrl && player.roblox_user_id) {
      try {
        const t = await robloxThumbnails.getUserThumbnails(player.roblox_user_id);
        avatarUrl =
          (t.fullbody && t.fullbody.state !== 'Blocked' && t.fullbody.imageUrl) ||
          (t.headshot && t.headshot.state !== 'Blocked' && t.headshot.imageUrl) ||
          null;
      } catch {
        avatarUrl = null;
      }
    }
    // 阶段34：附加多视角（正面全身 + headshot + 3D 渲染，能看到背饰/侧面）
    if (player.roblox_user_id) {
      try {
        const t = await robloxThumbnails.getUserThumbnails(player.roblox_user_id);
        const extra = [];
        if (t.fullbody && t.fullbody.state !== 'Blocked' && t.fullbody.imageUrl && t.fullbody.imageUrl !== avatarUrl) extra.push(t.fullbody.imageUrl);
        if (t.headshot && t.headshot.state !== 'Blocked' && t.headshot.imageUrl) extra.push(t.headshot.imageUrl);
        const render3d = await robloxThumbnails.getUserRender3D(player.roblox_user_id);
        if (render3d && render3d.imageUrl) extra.push(render3d.imageUrl);
        avatarExtraViews = extra;
      } catch { /* 附加视角获取失败不影响主流程 */ }
    }

    const result = await initializeAvatar({
      playerRowId: player.id,
      robloxUserId: player.roblox_user_id,
      avatarUrl,
      avatarExtraViews,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Vision 初始化失败' });
  }
});

/** 查询初始化状态（刷新后回显）。 */
router.post('/api/vision/avatar/status', (req, res) => {
  const sess = authPlayer(req);
  if (!sess) return res.status(401).json({ error: '无效会话' });
  const row = getInitRow(sess.playerRowId);
  if (!row) return res.json({ status: 'NOT_INITIALIZED' });
  res.json({
    status: row.status,
    attributes: row.final_attributes ? JSON.parse(row.final_attributes) : null,
    acceptedTags: row.accepted_tags ? JSON.parse(row.accepted_tags) : [],
    skills: row.accepted_skills ? JSON.parse(row.accepted_skills) : [],
    visionModel: row.vision_model,
    error: row.error,
  });
});

/**
 * GET /vision-test：仅开发环境的 Vision 调试页。
 * 显示 Provider / Base URL / Model（不显示 API Key）、原始输出、解析结果、
 * 服务器验证、最终属性与技能。
 */
router.get('/vision-test', (_req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  const cfg = getVisionRuntimeConfig();
  res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Vision Test（开发调试）</title>
<style>
 body{font-family:system-ui;background:#14161c;color:#e6e8ee;max-width:860px;margin:20px auto;padding:0 16px}
 h1{font-size:18px} h2{font-size:14px;color:#9aa3b8;border-bottom:1px solid #2c3242;padding-bottom:4px}
 input,button{background:#1d212b;border:1px solid #333b4e;color:#e6e8ee;padding:8px;border-radius:8px}
 button{cursor:pointer} pre{background:#1d212b;border:1px solid #2c3242;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word}
 .muted{color:#67718a;font-size:12px}
</style></head><body>
<h1>Vision Test（仅开发环境）</h1>
<p class="muted">输入图片 URL 或上传图片（上传将转为 data URL 直接发给 Vision）。此页仅用于调试 Vision Provider，不参与正式初始化流程。</p>
<input id="url" style="width:60%" placeholder="https://...avatar.png" />
<input id="file" type="file" accept="image/*" />
<button onclick="run()">分析</button>
<div id="out"></div>
<script>
const OUT = document.getElementById('out');
const section = (t, c) => '<h2>'+t+'</h2><pre>'+c+'</pre>';
async function run() {
  let url = document.getElementById('url').value.trim();
  const f = document.getElementById('file').files[0];
  if (f) url = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(f); });
  if (!url) return;
  OUT.innerHTML = '<p>分析中…</p>';
  try {
    const r = await fetch('/api/vision/dev-analyze', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ imageUrl: url }) });
    const d = await r.json();
    let html = '';
    html += section('Vision Request', 'Provider: ' + d.provider + '\\nBase URL: ' + d.baseUrl + '\\nModel: ' + d.model + '\\nAPI Key: [不显示]');
    html += section('Raw Output', JSON.stringify(d.raw, null, 2));
    html += section('Parsed Output', JSON.stringify({ observations: d.parsed.observations, themes: d.parsed.themes, candidate_tags: d.parsed.candidate_tags, candidate_skill_ids: d.parsed.candidate_skill_ids, confidence: d.parsed.confidence }, null, 2));
    html += section('Server Validation', 'Accepted Tags: ' + JSON.stringify(d.validation.acceptedTags) + '\\nRejected Tags: ' + JSON.stringify(d.validation.rejectedTags) + '\\nAccepted Skills: ' + JSON.stringify(d.validation.acceptedSkillKeys) + '\\nRejected Skills: ' + JSON.stringify(d.validation.rejectedSkills));
    html += section('Final Result', 'Attributes: ' + JSON.stringify(d.final.attributes) + '\\nSkills: ' + JSON.stringify(d.final.acceptedSkills.map(s=>s.key)));
    OUT.innerHTML = html;
  } catch (e) { OUT.innerHTML = '<pre>错误：' + e.message + '</pre>'; }
}
</script></body></html>`);
});

/** POST /api/vision/dev-analyze：vision-test 页专用（开发环境）。 */
router.post('/api/vision/dev-analyze', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'not found' });
  try {
    const imageUrl = (req.body && req.body.imageUrl) || '';
    const cfg = getVisionRuntimeConfig();
    const { analyzeAvatar } = require('../services/vision/deepseekVision');
    const visionService = require('../services/vision/visionService');
    const { getDb } = require('@roblox-trpg/database');

    const allowedSkillKeys = getDb()
      .prepare("SELECT name FROM skills WHERE source_type = 'INITIAL_AVATAR' AND status = 'approved'")
      .all()
      .map((r) => r.name);

    const { raw, provider, model } = await analyzeAvatar({
      imageUrl,
      allowedTags: rules.ALLOWED_AVATAR_TAGS,
      allowedSkillIds: allowedSkillKeys,
    });
    const validation = visionService.validateVisionOutput(raw, { allowedSkillKeys });
    const byName = new Map(
      getDb()
        .prepare("SELECT id, name FROM skills WHERE source_type = 'INITIAL_AVATAR' AND status = 'approved'")
        .all()
        .map((r) => [r.name, r])
    );
    const final = visionService.computeFinalState(validation.acceptedTags, validation.acceptedSkillKeys, byName);

    res.json({
      provider,
      baseUrl: cfg.baseUrl,
      model,
      raw,
      parsed: {
        observations: raw.observations || [],
        themes: raw.themes || [],
        candidate_tags: raw.candidate_tags || [],
        candidate_skill_ids: raw.candidate_skill_ids || [],
        confidence: raw.confidence || {},
      },
      validation,
      final,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Vision 调用失败', kind: err.kind });
  }
});

module.exports = router;
