/** web_search：AI 经服务器搜索适配器联网（绝不直连）。 */
const { register } = require('./index');
const { getSearchProvider } = require('../../search/SearchProvider');

register({
  name: 'web_search',
  description: '通过服务器搜索适配器进行 Web 搜索（AI 不直接联网）。返回标题/链接/摘要；未配置搜索服务时返回 SEARCH_UNAVAILABLE。',
  permission: 'read',
  inputSchema: { type: 'object', properties: { query: { type: 'string', required: true, maxLength: 120 } } },
  async execute(_ctx, args) {
    const results = await getSearchProvider().search(args.query);
    return { ok: true, source: 'web_search', results };
  },
});
