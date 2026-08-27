/**
 * Roblox Experience 公开资料（Step 3/4/5）。
 * URL解析 → placeId → universeId → 体验详情（官方 API 优先，不做 HTML 抓取）。
 */
const { robloxJson, RobloxApiError } = require('./robloxHttp');
const cache = require('./robloxCache');
const { getGameIcon } = require('./robloxThumbnails');
const { ROBLOX_TTL_EXPERIENCE, ROBLOX_TTL_THUMBNAIL } = require('../../config');

/**
 * 从玩家粘贴的文本中解析 Roblox Experience URL。
 * 支持：
 *   https://www.roblox.com/games/6516141723/DOORS
 *   https://www.roblox.com/game/6516141723
 *   https://www.roblox.com/games/?placeId=6516141723
 * 返回 { placeId } 或 null。
 */
function parseExperienceUrl(text) {
  const s = String(text || '').trim();
  let m = s.match(/roblox\.com\/games\/(\d{1,20})/i);
  if (m) return { placeId: m[1] };
  m = s.match(/roblox\.com\/game\/(\d{1,20})/i);
  if (m) return { placeId: m[1] };
  m = s.match(/placeId=(\d{1,20})/i);
  if (m) return { placeId: m[1] };
  return null;
}

/** placeId → universeId（新端点优先，旧端点兜底）。 */
async function getUniverseIdByPlace(placeId) {
  const { value } = await cache.getOrFetch(`p2u:${placeId}`, ROBLOX_TTL_THUMBNAIL, async () => {
    try {
      const modern = await robloxJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
      const uid = modern && (modern.universeId ?? modern.UniverseId ?? (modern.data && modern.data.universeId));
      if (uid) return { universeId: String(uid) };
    } catch (err) {
      if (err instanceof RobloxApiError && err.kind === 'not_found') throw err;
      // 新端点不可用 → 旧端点兜底
    }
    const legacy = await robloxJson(
      `https://api.roblox.com/universes/get-universe-containing-place?placeid=${placeId}`
    );
    const uid = legacy && (legacy.UniverseId ?? legacy.universeId);
    if (!uid) throw new RobloxApiError('bad_response', '无法解析该 Place 对应的 Universe');
    return { universeId: String(uid) };
  });
  return value.universeId;
}

/** 按 universeId 获取体验详情（含公开统计与图标）。 */
async function getExperienceByUniverse(universeId) {
  const { value, fromCache, stale, fetchedAt } = await cache.getOrFetch(
    `exp:${universeId}`,
    ROBLOX_TTL_EXPERIENCE,
    async () => {
      const games = await robloxJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
      const g = games && games.data && games.data[0];
      if (!g) throw new RobloxApiError('not_found', `未找到 universeId=${universeId} 的体验`);

      // 公开统计（点赞）——失败不影响主流程
      let votes = null;
      try {
        const v = await robloxJson(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`);
        const vd = v && v.data && v.data[0];
        if (vd) votes = { upVotes: vd.upVotes, downVotes: vd.downVotes };
      } catch {
        votes = null;
      }

      return { g, votes };
    }
  );

  const { g, votes } = value;

  // 图标（独立缓存）
  let iconUrl = null;
  try {
    const icon = await getGameIcon(universeId);
    if (icon && icon.state !== 'Blocked') iconUrl = icon.imageUrl;
  } catch {
    iconUrl = null;
  }

  return {
    source: 'roblox_api',
    fromCache,
    stale,
    fetchedAt: new Date(fetchedAt).toISOString(),
    universeId: String(g.id),
    rootPlaceId: String(g.rootPlaceId || ''),
    name: g.name,
    description: g.description || '',
    creator: g.creator ? { id: String(g.creator.id || ''), name: g.creator.name || '', type: g.creator.type || '' } : null,
    stats: {
      playing: g.playing ?? null,
      visits: g.visits ?? null,
      votes,
      created: g.created || null,
      updated: g.updated || null,
    },
    iconUrl,
    webUrl: `https://www.roblox.com/games/${g.rootPlaceId || ''}`,
  };
}

/**
 * 统一解析入口：接受 URL / placeId / universeId。
 * 返回完整体验公开资料。
 */
async function resolveExperience(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new RobloxApiError('bad_input', '请提供 Roblox Experience URL 或 ID');

  // URL → placeId
  const parsed = parseExperienceUrl(text);
  if (parsed) {
    const universeId = await getUniverseIdByPlace(parsed.placeId);
    return getExperienceByUniverse(universeId);
  }

  if (/^\d{1,20}$/.test(text)) {
    // 纯数字：先按 universeId 尝试；失败再按 placeId 解析
    try {
      return await getExperienceByUniverse(text);
    } catch (err) {
      if (err instanceof RobloxApiError && err.kind === 'not_found') {
        const universeId = await getUniverseIdByPlace(text);
        return getExperienceByUniverse(universeId);
      }
      throw err;
    }
  }

  throw new RobloxApiError('bad_input', '无法识别的输入：请粘贴 Roblox Experience URL 或数字 ID');
}

module.exports = { parseExperienceUrl, getUniverseIdByPlace, getExperienceByUniverse, resolveExperience };
