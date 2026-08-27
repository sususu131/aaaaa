/**
 * Roblox Experience 搜索（Step 6 配套）。
 * 官方没有正式文档化的公开游戏搜索端点，这里实现 fallback 链并做防御式解析：
 *   1) games-autocomplete（apis.roblox.com）
 *   2) 旧版 search.roblox.com 结果接口
 * 任何一步拿到 universeId 候选后，统一用官方 games API 补全权威详情。
 * 多结果时不自动选定——由玩家选择（见 handlers: dungeon:search）。
 */
const { robloxJson, RobloxApiError } = require('./robloxHttp');
const { getExperienceByUniverse } = require('./robloxExperiences');

/** 从未知结构的响应里尽力提取 {universeId, name} 候选。 */
function extractCandidates(payload, out) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const item of payload) extractCandidates(item, out);
    return;
  }
  const uid = payload.universeId ?? payload.UniverseId ?? payload.gameUniverseId;
  if (uid && /^\d+$/.test(String(uid))) {
    if (!out.some((c) => c.universeId === String(uid))) {
      out.push({ universeId: String(uid), name: payload.name || payload.title || '' });
    }
  }
  for (const key of ['data', 'results', 'suggestion', 'suggestions', 'items', 'games', 'response']) {
    if (payload[key]) extractCandidates(payload[key], out);
  }
}

async function searchAutocomplete(query) {
  const payload = await robloxJson(
    `https://apis.roblox.com/games-autocomplete/v1/get-suggestion/${encodeURIComponent(query)}`
  );
  const out = [];
  extractCandidates(payload, out);
  return out;
}

async function searchLegacy(query) {
  const payload = await robloxJson(
    `https://search.roblox.com/search/v1/search/games?searchQuery=${encodeURIComponent(query)}&sessionID=trpg&sortRelevance=true`
  );
  const out = [];
  extractCandidates(payload, out);
  return out;
}

/**
 * 搜索体验。返回经官方 games API 补全的候选列表（最多 limit 条）。
 * 失败抛出 RobloxApiError（上层提示改用 URL 粘贴）。
 */
async function searchExperiences(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) throw new RobloxApiError('bad_input', '搜索词不能为空');

  const strategies = [searchAutocomplete, searchLegacy];
  let candidates = [];
  let lastErr = null;
  for (const strategy of strategies) {
    try {
      candidates = await strategy(q);
      if (candidates.length) break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!candidates.length) {
    const err =
      lastErr instanceof RobloxApiError
        ? lastErr
        : new RobloxApiError('network', '搜索未返回结果');
    err.message += '（可改为直接粘贴 Roblox Experience URL）';
    throw err;
  }

  // 用官方 games API 补全权威详情；单个候选失败跳过
  const enriched = [];
  for (const c of candidates.slice(0, limit)) {
    try {
      enriched.push(await getExperienceByUniverse(c.universeId));
    } catch {
      /* 跳过无效候选 */
    }
  }
  if (!enriched.length) {
    throw new RobloxApiError('bad_response', '搜索到的候选无法解析为有效体验');
  }
  return enriched;
}

module.exports = { searchExperiences };
