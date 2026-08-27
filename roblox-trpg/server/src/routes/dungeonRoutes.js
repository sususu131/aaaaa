/**
 * Dungeon Design Pipeline REST（阶段4 第四十三~四十六节）。
 * 错误一律带明确 code（禁止 500 Unknown，除非真正未处理异常）。
 */
const express = require('express');
const pipeline = require('../services/dungeon/dungeonPipeline');
const { analyzeAvatar } = require('../services/vision/deepseekVision');

const router = express.Router();

function fail(res, err) {
  if (err instanceof pipeline.PipelineError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[dungeon-pipeline] 未处理异常:', err);
  res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
}

/**
 * POST /api/dungeons/design
 * { source: { type: 'roblox_experience', url|placeId|universeId }, force?, includeVisionIcon? }
 */
router.post('/api/dungeons/design', async (req, res) => {
  try {
    const { source, force, includeVisionIcon } = req.body || {};

    // Vision（独立 Provider）：可选地把体验图标分析为 CANONICAL_FACT_CANDIDATE
    let visionObservations = null;
    if (includeVisionIcon) {
      try {
        const exp = await pipeline.resolveExperienceForVision(source);
        if (exp && exp.iconUrl) {
          const { raw } = await analyzeAvatar({
            imageUrl: exp.iconUrl,
            allowedTags: [],
            allowedSkillIds: [],
          });
          visionObservations = Array.isArray(raw.observations) ? raw.observations : [];
        }
      } catch {
        visionObservations = null; // Vision 失败不阻塞设计（标记为无视觉候选）
      }
    }

    const result = await pipeline.designDungeon({ source, force: Boolean(force), visionObservations });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeons/:id */
router.get('/api/dungeons/:id', (req, res) => {
  try {
    res.json({ dungeon: pipeline.getDungeon(req.params.id), versions: pipeline.listVersions(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeons/:id/versions */
router.get('/api/dungeons/:id/versions', (req, res) => {
  try {
    res.json({ versions: pipeline.listVersions(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeons/:id/versions/:version */
router.get('/api/dungeons/:id/versions/:version', (req, res) => {
  try {
    const v = pipeline.getVersionByNumber(req.params.id, req.params.version);
    res.json({ version: { ...v, definition: JSON.parse(v.definition_json) } });
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeons/:id/diff?from=1&to=2 */
router.get('/api/dungeons/:id/diff', (req, res) => {
  try {
    res.json(pipeline.diffVersions(req.params.id, Number(req.query.from), Number(req.query.to)));
  } catch (err) {
    fail(res, err);
  }
});

/** GET /api/dungeon-design-runs/:id */
router.get('/api/dungeon-design-runs/:id', (req, res) => {
  try {
    res.json({ run: pipeline.getDesignRun(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-versions/:id/submit-review（DRAFT → REVIEW） */
router.post('/api/dungeon-versions/:id/submit-review', (req, res) => {
  try {
    res.json(pipeline.submitReview(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-versions/:id/review（REVIEW → APPROVED/REJECTED；禁止 DRAFT→PUBLISHED） */
router.post('/api/dungeon-versions/:id/review', (req, res) => {
  try {
    const { status, reason, reviewer } = req.body || {};
    res.json(pipeline.reviewVersion(req.params.id, { status, reason, reviewer }));
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/dungeon-versions/:id/publish（仅 APPROVED → PUBLISHED；发布后 immutable） */
router.post('/api/dungeon-versions/:id/publish', (req, res) => {
  try {
    res.json(pipeline.publishVersion(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
