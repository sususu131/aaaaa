/** roblox_search：Roblox 专用搜索（与 web_search 区分；优先 Roblox API，阶段2 服务复用）。 */
const { register } = require('./index');
const robloxSearchService = require('../../roblox/robloxSearch');

register({
  name: 'roblox_search',
  description:
    '搜索 Roblox Experience（公开官方数据，优先于 web_search）。询问"这个 Roblox 体验是什么"类问题优先使用本工具；' +
    '只有需要公开互联网信息（攻略/新闻）才用 web_search。结果标记 CANONICAL_FACT。',
  permission: 'ROBLOX',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', required: true, maxLength: 60 } },
  },
  async execute(_ctx, args) {
    try {
      const results = await robloxSearchService.searchExperiences(args.query, 5);
      return {
        ok: true,
        source: 'roblox_api',
        results: results.map((r) => ({
          universeId: r.universeId,
          placeId: r.rootPlaceId || null,
          name: r.name,
          creator: r.creator && r.creator.name,
          description: (r.description || '').slice(0, 200),
          visits: r.stats && r.stats.visits,
        })),
        canonical: true,
      };
    } catch (err) {
      return { ok: false, error: `ROBLOX_DATA_UNAVAILABLE（${err.message}）`, kind: 'roblox_unavailable' };
    }
  },
});
