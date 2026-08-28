/**
 * Avatar 初始化编排（阶段3b 核心流程）：
 *   NOT_INITIALIZED → ANALYZING → INITIALIZED（事务写入）
 *   任何失败 → FAILED（可重试；不发放随机属性/技能；房间不崩溃）
 *
 * 红线：
 * - Bacon Head 完全不调用 Vision（调用次数 = 0），默认全 5、无技能
 * - 图片只能来自 Roblox 公开资料（服务端查询），禁止玩家自带图片
 * - 重复初始化防线：player_id UNIQUE + avatar_snapshot_hash + status=INITIALIZED
 * - 最终写入使用事务：snapshot/属性/技能/状态 要么全写，要么全不写
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const { ensurePlayerState } = require('../world/playerStates');
const rules = require('./avatarRules');
const visionService = require('./visionService');
const { analyzeAvatar } = require('./deepseekVision');
const { getVisionRuntimeConfig, VisionError } = require('./visionProvider');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function getInitRow(playerRowId) {
  return getDb().prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(playerRowId);
}

function logAnalysis(entry) {
  try {
    getDb()
      .prepare(
        `INSERT INTO vision_analysis_log (player_id, roblox_user_id, vision_provider, vision_model,
          candidate_tags, accepted_tags, rejected_tags, candidate_skills, accepted_skills, rejected_skills,
          final_attributes, final_skills, status, error, raw_response, request_meta, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.player_id ?? null,
        entry.roblox_user_id ?? null,
        entry.vision_provider ?? null,
        entry.vision_model ?? null,
        JSON.stringify(entry.candidate_tags ?? []),
        JSON.stringify(entry.accepted_tags ?? []),
        JSON.stringify(entry.rejected_tags ?? []),
        JSON.stringify(entry.candidate_skills ?? []),
        JSON.stringify(entry.accepted_skills ?? []),
        JSON.stringify(entry.rejected_skills ?? []),
        JSON.stringify(entry.final_attributes ?? null),
        JSON.stringify(entry.final_skills ?? []),
        entry.status,
        entry.error ?? null,
        entry.raw_response ? JSON.stringify(entry.raw_response) : null,
        entry.request_meta ? JSON.stringify(entry.request_meta) : null,
        entry.image_url ?? null
      );
  } catch (logErr) {
    // 阶段30：日志写入失败不再静默——控制台可见（便于发现列缺失等问题）
    console.error('[vision] 日志写入失败:', logErr.message);
  }
}

/** 初始化结果 → player_skills/player_states/avatar_initialization 事务写入。 */
function commitInitialization(db, playerRowId, init) {
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO avatar_initialization
        (player_id, roblox_user_id, avatar_image_url, avatar_snapshot_hash, vision_provider, vision_model,
         vision_result, accepted_tags, rejected_tags, accepted_skills, rejected_skills,
         final_attributes, final_skill_ids, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIALIZED')
       ON CONFLICT(player_id) DO UPDATE SET
         roblox_user_id = excluded.roblox_user_id, avatar_image_url = excluded.avatar_image_url,
         avatar_snapshot_hash = excluded.avatar_snapshot_hash, vision_provider = excluded.vision_provider,
         vision_model = excluded.vision_model, vision_result = excluded.vision_result,
         accepted_tags = excluded.accepted_tags, rejected_tags = excluded.rejected_tags,
         accepted_skills = excluded.accepted_skills, rejected_skills = excluded.rejected_skills,
         final_attributes = excluded.final_attributes, final_skill_ids = excluded.final_skill_ids,
         status = 'INITIALIZED', error = NULL`
    ).run(
      playerRowId,
      init.robloxUserId || 'bacon',
      init.imageUrl || null,
      init.hash,
      init.provider || null,
      init.model || null,
      init.visionResult ? JSON.stringify(init.visionResult) : null,
      JSON.stringify(init.acceptedTags || []),
      JSON.stringify(init.rejectedTags || []),
      JSON.stringify((init.acceptedSkills || []).map((s) => s.key)),
      JSON.stringify(init.rejectedSkills || []),
      JSON.stringify(init.attributes),
      JSON.stringify((init.acceptedSkills || []).map((s) => s.skillId))
    );

    db.prepare('UPDATE player_states SET attributes = ?, updated_at = datetime(\'now\') WHERE player_id = ?').run(
      JSON.stringify(init.attributes),
      playerRowId
    );

    for (const s of init.acceptedSkills || []) {
      db.prepare(
        'INSERT OR IGNORE INTO player_skills (player_id, skill_id, obtained_from_dungeon_id) VALUES (?, ?, NULL)'
      ).run(playerRowId, s.skillId);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 标记 FAILED（允许以后重试）。 */
function markFailed(playerRowId, robloxUserId, error) {
  const db = getDb();
  db.prepare(
    `INSERT INTO avatar_initialization (player_id, roblox_user_id, avatar_snapshot_hash, status, error)
     VALUES (?, ?, ?, 'FAILED', ?)
     ON CONFLICT(player_id) DO UPDATE SET status = 'FAILED', error = excluded.error`
  ).run(playerRowId, robloxUserId || 'bacon', sha256(`failed:${playerRowId}:${Date.now()}`), error);
  logAnalysis({ player_id: playerRowId, roblox_user_id: robloxUserId, status: 'FAILED', error });
}

/**
 * 主入口。
 * @param {{playerRowId:number, robloxUserId?:string, avatarUrl?:string, forceBacon?:boolean}} p
 */
async function initializeAvatar({ playerRowId, robloxUserId = null, avatarUrl = null, forceBacon = false }) {
  const db = getDb();
  ensurePlayerState(playerRowId);

  // 重复初始化防线（刷新/重连不重复）
  const existing = getInitRow(playerRowId);
  if (existing && existing.status === 'INITIALIZED') {
    const baconUpgrade = existing.roblox_user_id === 'bacon' && robloxUserId; // 培根→Roblox 的一次性升级
    if (!baconUpgrade) {
      return {
        status: 'INITIALIZED',
        duplicate: true,
        attributes: JSON.parse(existing.final_attributes),
        acceptedTags: JSON.parse(existing.accepted_tags || '[]'),
        skills: JSON.parse(existing.accepted_skills || '[]'),
      };
    }
    // 升级路径：清掉旧的培根初始技能，重新按 Vision 结果事务写入
    db.prepare(
      `DELETE FROM player_skills WHERE player_id = ? AND skill_id IN
       (SELECT id FROM skills WHERE source_type = 'INITIAL_AVATAR')`
    ).run(playerRowId);
  }

  const isBacon = forceBacon || !robloxUserId;

  // ── Bacon Head：默认属性 + 0 技能，绝不调用 Vision ──
  if (isBacon) {
    const { attributes } = rules.baconDefaults();
    const hash = sha256(`bacon:${playerRowId}`);
    commitInitialization(db, playerRowId, {
      robloxUserId: null,
      imageUrl: null,
      hash,
      attributes,
      acceptedSkills: [],
      acceptedTags: [],
      rejectedTags: [],
      rejectedSkills: [],
    });
    logAnalysis({ player_id: playerRowId, roblox_user_id: null, status: 'INITIALIZED', final_attributes: attributes });
    return { status: 'INITIALIZED', bacon: true, attributes, acceptedTags: [], skills: [] };
  }

  // ── 标记 ANALYZING ──
  db.prepare(
    `INSERT INTO avatar_initialization (player_id, roblox_user_id, avatar_snapshot_hash, status)
     VALUES (?, ?, ?, 'ANALYZING')
     ON CONFLICT(player_id) DO UPDATE SET status = 'ANALYZING', error = NULL`
  ).run(playerRowId, robloxUserId, sha256(`analyzing:${playerRowId}`));

  if (!avatarUrl) {
    markFailed(playerRowId, robloxUserId, 'NO_AVATAR_IMAGE（无 Roblox 公开头像，Vision 初始化失败）');
    return { status: 'FAILED', error: '没有可用的 Roblox Avatar 图片（需要公开头像）' };
  }

  const snapshotHash = sha256(`${robloxUserId}|${avatarUrl}`);

  try {
    // Vision 调用（独立 Provider，独立配置）
    const allowedSkillKeys = db
      .prepare("SELECT name FROM skills WHERE source_type = 'INITIAL_AVATAR' AND status = 'approved'")
      .all()
      .map((r) => r.name);

    const { raw, provider, model, rawResponse, rawText, requestBody } = await analyzeAvatar({
      imageUrl: avatarUrl,
      allowedTags: rules.ALLOWED_AVATAR_TAGS,
      allowedSkillIds: allowedSkillKeys,
    });

    // 阶段30：Vision AI 真实输出日志（服务器控制台，便于实时排查）
    console.log('[vision] ── AI 原始输出 ──');
    console.log('[vision] 请求:', JSON.stringify(requestBody));
    console.log('[vision] 模型回复原文:', String(rawText || '').slice(0, 2000));
    console.log('[vision] 解析后 JSON:', JSON.stringify(raw));

    // 服务器验证（UNTRUSTED_MODEL_OUTPUT 二次验证）
    const validated = visionService.validateVisionOutput(raw, { allowedSkillKeys });
    console.log(
      '[vision] 服务器验证: 接受 tags =', JSON.stringify(validated.acceptedTags),
      '| 拒绝 tags =', JSON.stringify(validated.rejectedTags),
      '| 接受技能 =', JSON.stringify(validated.acceptedSkillKeys),
      '| 拒绝技能 =', JSON.stringify(validated.rejectedSkills)
    );

    const skillRows = db
      .prepare("SELECT id, name FROM skills WHERE source_type = 'INITIAL_AVATAR' AND status = 'approved'")
      .all();
    const byName = new Map(skillRows.map((r) => [r.name, r]));

    const final = visionService.computeFinalState(validated.acceptedTags, validated.acceptedSkillKeys, byName);
    console.log('[vision] 最终数值: attributes =', JSON.stringify(final.attributes), '| 技能 =', JSON.stringify(final.acceptedSkills.map((x) => x.key)));

    commitInitialization(db, playerRowId, {
      robloxUserId,
      imageUrl: avatarUrl,
      hash: snapshotHash,
      provider,
      model,
      visionResult: raw,
      acceptedTags: validated.acceptedTags,
      rejectedTags: validated.rejectedTags,
      acceptedSkills: final.acceptedSkills,
      rejectedSkills: [...validated.rejectedSkills, ...final.rejectedComputedSkills],
      attributes: final.attributes,
    });

    logAnalysis({
      player_id: playerRowId,
      roblox_user_id: robloxUserId,
      vision_provider: provider,
      vision_model: model,
      image_url: avatarUrl,
      raw_response: { gateway: rawResponse, modelText: String(rawText || '').slice(0, 8000), parsed: raw },
      request_meta: requestBody,
      candidate_tags: raw.candidate_tags || [],
      accepted_tags: validated.acceptedTags,
      rejected_tags: validated.rejectedTags,
      candidate_skills: raw.candidate_skill_ids || [],
      accepted_skills: final.acceptedSkills.map((s) => s.key),
      rejected_skills: [...validated.rejectedSkills, ...final.rejectedComputedSkills],
      final_attributes: final.attributes,
      final_skills: final.acceptedSkills.map((s) => s.key),
      status: 'INITIALIZED',
    });

    return {
      status: 'INITIALIZED',
      bacon: false,
      attributes: final.attributes,
      acceptedTags: validated.acceptedTags,
      rejectedTags: validated.rejectedTags,
      skills: final.acceptedSkills,
      rejectedSkills: [...validated.rejectedSkills, ...final.rejectedComputedSkills],
      visionModel: model,
    };
  } catch (err) {
    // Vision 错误：不崩溃、不随机发放，状态 FAILED，允许重试
    const msg = err instanceof VisionError ? err.message : `Vision 分析失败：${err.message}`;
    markFailed(playerRowId, robloxUserId, msg);
    return { status: 'FAILED', error: msg };
  }
}

module.exports = { initializeAvatar, getInitRow };
