/**
 * 预设体验路由（阶段16）：列表（Experience Select Panel 数据）+ 手动导入。
 * 图标经既有 Roblox Thumbnails Service 服务端代理获取（离线时降级为 null）。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const presetSeeder = require('../services/presets/presetSeeder');

const router = express.Router();

function authPlayer(req, res) {
  let token = (req.body && req.body.sessionToken) || (req.query && req.query.sessionToken);
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)rtp_session=([^;]+)/);
    token = m && m[1];
  }
  const sess = token ? resolveSession(token) : null;
  if (!sess) {
    res.status(401).json({ error: '无效会话', code: 'UNAUTHORIZED' });
    return null;
  }
  return sess;
}

/** GET /api/preset-experiences —— 预设体验列表（图标/名称/类型/难度/可玩版本）。 */
router.get('/api/preset-experiences', async (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const presets = await presetSeeder.presetView();
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code || 'PRESET_ERROR' });
  }
});

/** POST /api/presets/import —— 运行预设导入器（幂等；服务启动时也会自动执行一次）。 */
router.post('/api/presets/import', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const results = presetSeeder.runPresetSeeder(io);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code || 'PRESET_IMPORT_FAILED' });
  }
});

// ── 阶段17：Die of Death Civilian System（模板制身份；服务器抽取 Deck）──

/** GET /api/dod/civilian/offer —— 抽取 Ability Deck（3 个 Deck × 2 Ability；服务器随机）。 */
router.get('/api/dod/civilian/offer', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodCivilian = require('../services/presets/dodCivilian');
    const decks = dodCivilian.offerDecks(sess.playerRowId);
    res.json({ ok: true, decks, backgrounds: dodCivilian.BACKGROUNDS });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** POST /api/dod/civilian/select { deckIndex } —— 生成 Civilian 身份并获得该 Deck 的 Ability。 */
router.post('/api/dod/civilian/select', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const dodCivilian = require('../services/presets/dodCivilian');
    const result = dodCivilian.createCivilianIdentity(io, sess.playerRowId, { deckIndex: (req.body || {}).deckIndex });
    res.json({ ok: true, ...result, view: dodCivilian.civilianView(sess.playerRowId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** GET /api/dod/civilian —— 我的 Civilian 身份（可带 experience 查询跨副本倍率）。 */
router.get('/api/dod/civilian', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodCivilian = require('../services/presets/dodCivilian');
    res.json({ civilian: dodCivilian.civilianView(sess.playerRowId, req.query.experience || null) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

// ── 阶段19：Civilian Ability Lore Integration（只读 Lore 数据，非游戏技能系统）──

/** GET /api/dod/abilities/lore —— Ability Lore 数据库（为什么拥有这些 Ability；无任何数值字段）。 */
router.get('/api/dod/abilities/lore', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodAbilityLore = require('../services/presets/dodAbilityLore');
    res.json({
      rule: dodAbilityLore.ABILITY_EXPLANATION_RULE,
      note: 'Lore 数据库：解释 Civilian 为什么拥有 Ability（过去的人生经历，不是魔法）；无战斗数值、无技能UI。',
      abilities: dodAbilityLore.listAbilityLore(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });  }
});

// ── 阶段23：Civilian Ability Relationship System（Synergy Lore；只读，非技能组合/装备/升级系统）──

/** GET /api/dod/synergies —— 官方 Synergy 目录（组合来源/改变的能力/Lore 解释/描述示例）。 */
router.get('/api/dod/synergies', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodSynergy = require('../services/presets/dodSynergy');
    res.json({
      rule: 'Synergy 是 Civilian 对自身经验的极致结合（改变既有 Ability 的使用方式）：不是新职业/超能力/等级提升/技能树；只使用数据库已有组合，不创造新 Synergy。',
      synergies: dodSynergy.listSynergies(),
      mine: dodSynergy.synergyView(sess.playerRowId),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

// ── 阶段24：Civilian Fate Selection System（Deck of Death Lore；非卡牌玩法、非游戏 UI 复刻）──

/** GET /api/dod/fate —— Deck of Death Lore + 我的 Fate 选择。 */
router.get('/api/dod/fate', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodFate = require('../services/presets/dodFate');
    res.json({
      note: 'Lore 层模拟：不是复刻游戏 UI，不是卡牌玩法。能力不是魔法——潜能被激发、经历成为优势。',
      fateSystem: dodFate.getFateSystem(),
      mine: dodFate.fateView(sess.playerRowId),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** GET /api/dod/fate/offer —— 生成 3 个 Fate Options（按 Background/Traits/Personality 加权；服务器随机）。 */
router.get('/api/dod/fate/offer', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodFate = require('../services/presets/dodFate');
    res.json(dodFate.offerFate(sess.playerRowId, { background: req.query.background || null }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** POST /api/dod/fate/select { optionIndex } —— 选择 Fate Option → Final Abilities（入 character_skills）。 */
router.post('/api/dod/fate/select', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodFate = require('../services/presets/dodFate');
    const { io } = require('../index.js');
    res.json(dodFate.selectFate(io, sess.playerRowId, req.body.optionIndex, { rng: null }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

// ── 阶段25：威胁互动（居民能力 × 杀手威胁 官方对策；只读 Lore 数据）──

/** GET /api/dod/interactions —— 官方互动目录（可按 ability/threat 过滤；含 Flashlight×Pursuer 现形僵直）。 */
router.get('/api/dod/interactions', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const interactions = require('../services/presets/dodThreatInteractions');
    res.json({
      note: '官方 CANON 对策（Lore 层）：特殊效果由 GM 按此叙述；不发明数据库之外的互动。',
      interactions: interactions.findInteractions({
        ability: req.query.ability || null,
        threat: req.query.threat || null,
      }),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

// ── 阶段20：Civilian Background & Personality Simulation（只读；非职业系统）──

/** GET /api/dod/civilian/profile —— 我的 Civilian 档案（背景/特点/人格/经历/Ability 解释/背景推断）。 */
router.get('/api/dod/civilian/profile', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodLore = require('../services/presets/dodLore');
    res.json({ profile: dodLore.profileView(sess.playerRowId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

/** GET /api/dod/backgrounds —— Background 档案库（人生经历模板；无等级/技能树/装备）。 */
router.get('/api/dod/backgrounds', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const dodBackgroundProfile = require('../services/presets/dodBackgroundProfile');
    res.json({
      note: 'Background 是人生经历（不是职业）：无职业等级/职业技能树/职业装备；possible_abilities 只提高概率，不锁定。',
      personalityPool: dodBackgroundProfile.PERSONALITY_POOL,
      phrasingRule: dodBackgroundProfile.GM_PHRASING_RULE,
      backgrounds: dodBackgroundProfile.listProfiles(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

// ── 阶段21：Civilian Identity Presentation（只读外观表现档案；非装备系统）──

/** GET /api/dod/civilian/identity —— 我的外观表现档案（外观=经历可视化，无数值无穿戴加成）。 */
router.get('/api/dod/civilian/identity', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const identitySvc = require('../services/presets/dodIdentityPresentation');
    res.json({
      identity: identitySvc.ensureIdentityProfile(sess.playerRowId),
      appearanceRule: identitySvc.APPEARANCE_RULE,
      npcIdentificationRule: identitySvc.NPC_IDENTIFICATION_RULE,
      limitRule: identitySvc.IDENTITY_LIMIT_RULE,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || 'DOD_ERROR' });
  }
});

module.exports = router;
