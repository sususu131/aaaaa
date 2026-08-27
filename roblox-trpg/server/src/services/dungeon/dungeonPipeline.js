/**
 * Dungeon Design Pipeline（阶段4 核心）：
 *   Roblox Experience → Canonical Snapshot → Dungeon Designer AI
 *   → Schema/Semantic/Rules Validation → DRAFT → Review → Approved → Publish
 *
 * 复用：阶段2 Roblox Information Service（不新建 HTTP 客户端）、
 *       阶段3 Provider 抽象、structuredOutput。
 * 纪律：AI 不得自动发布；PUBLISHED 版本 immutable；修改 = 新 version。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const robloxExperiences = require('../roblox/robloxExperiences');
const { RobloxApiError } = require('../roblox/robloxHttp');
const designer = require('./dungeonDesigner');
const { validateDraft } = require('./dungeonValidation');

class PipelineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code; // INVALID_SOURCE | ROBLOX_DATA_UNAVAILABLE | DUNGEON_DESIGN_AI_FAILED | DUNGEON_VALIDATION_FAILED | ...
    this.status = status;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newDungeonUid(db) {
  let uid;
  do {
    uid = `dungeon_${crypto.randomBytes(4).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM dungeons WHERE uid = ?').get(uid));
  return uid;
}

/** 把阶段2 的体验详情转成 Canonical Snapshot（含 hash，供复现与幂等）。 */
function buildCanonicalSnapshot(experience) {
  const canonicalCore = {
    universeId: experience.universeId,
    placeId: experience.rootPlaceId || null,
    name: experience.name,
    description: experience.description,
    creator: experience.creator ? experience.creator.name : null,
  };
  return {
    source: 'roblox_api',
    fetchedAt: experience.fetchedAt || new Date().toISOString(),
    snapshotHash: sha256(JSON.stringify(canonicalCore)),
    experience: {
      ...canonicalCore,
      stats: experience.stats || null,
      iconUrl: experience.iconUrl || null,
      webUrl: experience.webUrl || null,
    },
  };
}

/** 解析输入（url / placeId / universeId）→ 体验详情。复用阶段2 服务 + 缓存。 */
async function resolveExperienceSource(source) {
  if (!source || source.type !== 'roblox_experience') {
    throw new PipelineError('INVALID_SOURCE', '当前仅支持 source.type = roblox_experience');
  }
  const input = source.url || source.placeId || source.universeId;
  if (!input) throw new PipelineError('INVALID_SOURCE', '缺少 url / placeId / universeId');
  try {
    return await robloxExperiences.resolveExperience(input);
  } catch (err) {
    if (err instanceof RobloxApiError || err instanceof PipelineError) {
      throw new PipelineError('ROBLOX_DATA_UNAVAILABLE', `Roblox 资料不可用：${err.message}`, 502);
    }
    throw err;
  }
}

/** Vision 图标分析专用解析（不抛业务错误给调用方）。 */
async function resolveExperienceForVision(source) {
  try {
    return await resolveExperienceSource(source);
  } catch {
    return null;
  }
}

/**
 * 设计副本（幂等：同 source + snapshotHash + prompt_version + model 已有成功 Draft → 复用）。
 * @returns {{designRunId, dungeonId, dungeonUid, versionId, version, status, reused}}
 */
async function designDungeon({ source, force = false, visionObservations = null }) {
  const db = getDb();
  const experience = await resolveExperienceSource(source);
  const snapshot = buildCanonicalSnapshot(experience);

  // 内部 dungeon 主键（不用 placeId；同一体验可多版本）
  let dungeon = db.prepare('SELECT * FROM dungeons WHERE roblox_universe_id = ?').get(experience.universeId);
  if (!dungeon) {
    const uid = newDungeonUid(db);
    db.prepare(
      `INSERT INTO dungeons (uid, roblox_experience_name, roblox_universe_id, roblox_place_id, dungeon_name, difficulty, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid,
      experience.name,
      experience.universeId,
      experience.rootPlaceId || null,
      experience.name,
      3,
      (experience.description || '').slice(0, 500)
    );
    dungeon = db.prepare('SELECT * FROM dungeons WHERE roblox_universe_id = ?').get(experience.universeId);
  }

  const model = process.env.AI_MODEL || 'unknown';

  // 幂等复用（除非 force）
  if (!force) {
    const existing = db
      .prepare(
        `SELECT * FROM dungeon_design_runs
         WHERE dungeon_id = ? AND canonical_snapshot_hash = ? AND prompt_version = ? AND model = ? AND status = 'SUCCEEDED'
         ORDER BY id DESC LIMIT 1`
      )
      .get(dungeon.id, snapshot.snapshotHash, designer.PROMPT_VERSION, model);
    if (existing && existing.dungeon_version_id) {
      const v = db.prepare('SELECT * FROM dungeon_versions WHERE id = ?').get(existing.dungeon_version_id);
      if (v) {
        return {
          designRunId: existing.id,
          dungeonId: dungeon.id,
          dungeonUid: dungeon.uid,
          versionId: v.id,
          version: v.version,
          status: v.status,
          reused: true,
        };
      }
    }
  }

  // 创建 design run（RUNNING）
  const runInfo = db
    .prepare(
      `INSERT INTO dungeon_design_runs (dungeon_id, source_type, source_ref, input_snapshot, canonical_snapshot_hash, provider, model, prompt_version, status)
       VALUES (?, 'ROBLOX_EXPERIENCE', ?, ?, ?, 'ai_provider', ?, ?, 'RUNNING')`
    )
    .run(
      dungeon.id,
      String(source.url || source.placeId || source.universeId),
      JSON.stringify({ ...snapshot, visionObservations }),
      snapshot.snapshotHash,
      model,
      designer.PROMPT_VERSION
    );
  const runId = runInfo.lastInsertRowid;

  // Vision 观察（可选）：作为 CANONICAL_FACT_CANDIDATE 注入，不是 canonical 本身
  let designInput = snapshot;
  if (visionObservations && Array.isArray(visionObservations.length ? visionObservations : [])) {
    designInput = {
      ...snapshot,
      visionFactCandidates: visionObservations.map((o) => ({ value: o, source: 'CANONICAL_FACT_CANDIDATE' })),
    };
  }

  // AI 生成
  let generated;
  try {
    generated = await designer.generateDraft(designInput);
  } catch (err) {
    db.prepare("UPDATE dungeon_design_runs SET status = 'FAILED', error = ? WHERE id = ?").run(
      `DUNGEON_DESIGN_AI_FAILED: ${err.message}`,
      runId
    );
    throw new PipelineError('DUNGEON_DESIGN_AI_FAILED', `AI 设计失败：${err.message}`, 502);
  }

  // 验证：Schema → Semantic → Rules → Canonical
  const validation = validateDraft(generated.draft, snapshot);
  if (!validation.ok) {
    db.prepare("UPDATE dungeon_design_runs SET status = 'FAILED', error = ?, output = ? WHERE id = ?").run(
      `DUNGEON_VALIDATION_FAILED [${validation.stage}]: ${validation.errors.join(' | ').slice(0, 1500)}`,
      JSON.stringify(generated.draft).slice(0, 20000),
      runId
    );
    throw new PipelineError('DUNGEON_VALIDATION_FAILED', validation.errors.join(' | '), 422);
  }

  // 持久化为 DRAFT 版本（version + 1）
  const maxV = db.prepare('SELECT MAX(version) m FROM dungeon_versions WHERE dungeon_id = ?').get(dungeon.id).m || 0;
  const definition = {
    id: dungeon.uid,
    source_type: 'ROBLOX_EXPERIENCE',
    roblox_universe_id: experience.universeId,
    roblox_place_id: experience.rootPlaceId || null,
    version: maxV + 1,
    status: 'DRAFT',
    canonical_snapshot_hash: snapshot.snapshotHash,
    canonical_facts: validation.definition.canonical_facts,
    vision_fact_candidates: designInput.visionFactCandidates || [],
    trpg_original: validation.definition.trpg_original,
    ...validation.definition,
    created_at: new Date().toISOString(),
  };

  const vInfo = db
    .prepare(
      `INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status)
       VALUES (?, ?, ?, ?, 'DRAFT')`
    )
    .run(dungeon.id, maxV + 1, JSON.stringify(definition), snapshot.snapshotHash);

  db.prepare(
    `UPDATE dungeon_design_runs SET status = 'SUCCEEDED', output = ?, dungeon_version_id = ?,
       prompt_tokens = ?, completion_tokens = ?, total_tokens = ? WHERE id = ?`
  ).run(
    JSON.stringify(generated.draft).slice(0, 20000),
    vInfo.lastInsertRowid,
    generated.usage ? generated.usage.prompt_tokens ?? null : null,
    generated.usage ? generated.usage.completion_tokens ?? null : null,
    generated.usage ? generated.usage.total_tokens ?? null : null,
    runId
  );

  return {
    designRunId: runId,
    dungeonId: dungeon.id,
    dungeonUid: dungeon.uid,
    versionId: vInfo.lastInsertRowid,
    version: maxV + 1,
    status: 'DRAFT',
    reused: false,
    warnings: validation.warnings,
  };
}

// ── 生命周期：DRAFT → REVIEW → APPROVED/REJECTED → PUBLISHED（immutable）──

function getVersion(versionId) {
  const v = getDb().prepare('SELECT * FROM dungeon_versions WHERE id = ?').get(Number(versionId));
  if (!v) throw new PipelineError('VERSION_NOT_FOUND', `版本 #${versionId} 不存在`, 404);
  return v;
}

function assertNotPublished(v, action) {
  if (v.status === 'PUBLISHED') {
    throw new PipelineError('IMMUTABLE_VERSION', `PUBLISHED 版本不可${action}（immutable，请创建新版本）`, 409);
  }
}

/** DRAFT → REVIEW */
function submitReview(versionId) {
  const db = getDb();
  const v = getVersion(versionId);
  assertNotPublished(v, '提交审核');
  if (v.status !== 'DRAFT') {
    throw new PipelineError('INVALID_TRANSITION', `只有 DRAFT 可提交审核（当前 ${v.status}）`, 409);
  }
  db.prepare("UPDATE dungeon_versions SET status = 'REVIEW' WHERE id = ?").run(v.id);
  return { versionId: v.id, status: 'REVIEW' };
}

/** REVIEW → APPROVED / REJECTED（禁止 DRAFT → PUBLISHED 跳级）。 */
function reviewVersion(versionId, { status, reason = '', reviewer = 'admin' }) {
  const db = getDb();
  const v = getVersion(versionId);
  assertNotPublished(v, '审核');
  if (v.status !== 'REVIEW') {
    throw new PipelineError('INVALID_TRANSITION', `只有 REVIEW 状态可审核（当前 ${v.status}；禁止 DRAFT 直接发布）`, 409);
  }
  if (status !== 'APPROVED' && status !== 'REJECTED') {
    throw new PipelineError('INVALID_REVIEW_STATUS', '审核结果必须是 APPROVED 或 REJECTED');
  }
  db.prepare('INSERT INTO dungeon_reviews (dungeon_version_id, status, reason, reviewer) VALUES (?, ?, ?, ?)').run(
    v.id,
    status,
    String(reason || '').slice(0, 500),
    String(reviewer || '').slice(0, 60)
  );
  db.prepare('UPDATE dungeon_versions SET status = ? WHERE id = ?').run(status, v.id);
  return { versionId: v.id, status, reason };
}

/** APPROVED → PUBLISHED（发布后 immutable）。 */
function publishVersion(versionId) {
  const db = getDb();
  const v = getVersion(versionId);
  assertNotPublished(v, '重复发布');
  if (v.status !== 'APPROVED') {
    throw new PipelineError('INVALID_TRANSITION', `只有 APPROVED 可发布（当前 ${v.status}；AI 永不自动发布）`, 409);
  }
  db.prepare("UPDATE dungeon_versions SET status = 'PUBLISHED', published_at = datetime('now') WHERE id = ?").run(v.id);
  return { versionId: v.id, status: 'PUBLISHED' };
}

// ── 查询 ──

function getDungeon(uidOrId) {
  const db = getDb();
  const row = /^\d+$/.test(String(uidOrId))
    ? db.prepare('SELECT * FROM dungeons WHERE id = ?').get(Number(uidOrId))
    : db.prepare('SELECT * FROM dungeons WHERE uid = ?').get(String(uidOrId));
  if (!row) throw new PipelineError('DUNGEON_NOT_FOUND', `副本 "${uidOrId}" 不存在`, 404);
  return row;
}

function listVersions(dungeonRef) {
  const d = getDungeon(dungeonRef);
  return getDb()
    .prepare('SELECT id, dungeon_id, version, status, canonical_snapshot_hash, created_at, published_at FROM dungeon_versions WHERE dungeon_id = ? ORDER BY version')
    .all(d.id);
}

function getVersionByNumber(dungeonRef, version) {
  const d = getDungeon(dungeonRef);
  const v = getDb()
    .prepare('SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = ?')
    .get(d.id, Number(version));
  if (!v) throw new PipelineError('VERSION_NOT_FOUND', `副本 ${dungeonRef} 没有 v${version}`, 404);
  return v;
}

function getDesignRun(runId) {
  const row = getDb().prepare('SELECT * FROM dungeon_design_runs WHERE id = ?').get(Number(runId));
  if (!row) throw new PipelineError('RUN_NOT_FOUND', `design run #${runId} 不存在`, 404);
  return row;
}

/** v1 → v2 差异（新增/删除/修改摘要）。 */
function diffVersions(dungeonRef, v1num, v2num) {
  const def1 = JSON.parse(getVersionByNumber(dungeonRef, v1num).definition_json);
  const def2 = JSON.parse(getVersionByNumber(dungeonRef, v2num).definition_json);
  const ids = (def, key) => new Set((def[key] || []).map((x) => x.id));
  const diffSet = (key, label) => {
    const a = ids(def1, key);
    const b = ids(def2, key);
    return {
      added: [...b].filter((x) => !a.has(x)),
      removed: [...a].filter((x) => !b.has(x)),
    };
  };
  return {
    from: v1num,
    to: v2num,
    scenes: diffSet('scenes'),
    encounters: diffSet('encounters'),
    npcs: diffSet('npcs'),
    enemies: diffSet('enemies'),
    events: diffSet('events'),
    reward_candidates: diffSet('reward_candidates'),
    bossChanged: JSON.stringify(def1.boss || {}) !== JSON.stringify(def2.boss || {}),
    difficultyChanged: (def1.dungeon || {}).difficulty !== (def2.dungeon || {}).difficulty,
  };
}

module.exports = {
  designDungeon,
  buildCanonicalSnapshot,
  resolveExperienceForVision,
  submitReview,
  reviewVersion,
  publishVersion,
  getDungeon,
  listVersions,
  getVersionByNumber,
  getVersion,
  getDesignRun,
  diffVersions,
  PipelineError,
};
