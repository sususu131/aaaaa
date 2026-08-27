/**
 * REST API：Roblox 公开信息代理 + 会话 Cookie。
 * 浏览器不直连 Roblox API；AI 也不直连。
 */
const express = require('express');
const { COOKIE_NAME } = require('../config');
const { resolveSession } = require('../sessions/sessionManager');
const robloxUsers = require('../services/roblox/robloxUsers');
const robloxThumbnails = require('../services/roblox/robloxThumbnails');
const robloxExperiences = require('../services/roblox/robloxExperiences');
const robloxSearch = require('../services/roblox/robloxSearch');

const router = express.Router();

function fail(res, err) {
  const kind = err.kind || 'error';
  const status = kind === 'not_found' ? 404 : kind === 'bad_input' ? 400 : kind === 'rate_limited' ? 429 : 502;
  res.status(status).json({ error: err.message || 'Roblox 信息获取失败', kind });
}

// ── 会话：把 socket 发放的 token 落到 HttpOnly Cookie ──
router.post('/session/cookie', (req, res) => {
  const token = (req.body && req.body.token) || '';
  const session = resolveSession(token);
  if (!session) return res.status(401).json({ error: '无效会话' });
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd, // 开发环境无 HTTPS 时例外
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, playerId: session.playerId });
});

// ── Roblox 用户公开资料（按 ID / 按用户名）──
router.get('/roblox/users/:userId', async (req, res) => {
  try {
    const profile = await robloxUsers.getUserById(req.params.userId);
    const thumbnails = await robloxThumbnails.getUserThumbnails(profile.userId).catch(() => ({ headshot: null, fullbody: null }));
    res.json({
      profile,
      headshotUrl: thumbnails.headshot && thumbnails.headshot.state !== 'Blocked' ? thumbnails.headshot.imageUrl : null,
      fullbodyUrl: thumbnails.fullbody && thumbnails.fullbody.state !== 'Blocked' ? thumbnails.fullbody.imageUrl : null,
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/roblox/users/by-username', async (req, res) => {
  try {
    const username = (req.body && req.body.username) || '';
    const profile = await robloxUsers.getUserByUsername(username);
    const thumbnails = await robloxThumbnails.getUserThumbnails(profile.userId).catch(() => ({ headshot: null, fullbody: null }));
    res.json({
      profile,
      headshotUrl: thumbnails.headshot && thumbnails.headshot.state !== 'Blocked' ? thumbnails.headshot.imageUrl : null,
      fullbodyUrl: thumbnails.fullbody && thumbnails.fullbody.state !== 'Blocked' ? thumbnails.fullbody.imageUrl : null,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ── Roblox Experience：URL/ID 解析 ──
router.post('/roblox/experiences/resolve', async (req, res) => {
  try {
    const input = (req.body && (req.body.url || req.body.input)) || '';
    res.json({ experience: await robloxExperiences.resolveExperience(input) });
  } catch (err) {
    fail(res, err);
  }
});

// ── Roblox Experience：搜索（多结果交玩家选择）──
router.post('/roblox/experiences/search', async (req, res) => {
  try {
    const query = (req.body && req.body.query) || '';
    res.json({ results: await robloxSearch.searchExperiences(query) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
