/**
 * Web Search 适配层（阶段3 第十三节）。
 * 结构：AI → web_search Tool → Server Search Adapter → 搜索服务 → 结果 → AI。
 * AI 绝不直接联网。Provider 可替换（Serper / Bing / Brave / 自建）。
 * 未配置时返回 SEARCH_UNAVAILABLE —— AI 不得编造搜索结果。
 */
const { SEARCH_PROVIDER, SERPER_API_KEY } = require('../../config');

class SearchProvider {
  async search() {
    throw new Error('not implemented');
  }
}

/** 无可用搜索服务：明确不可用，而非编造。 */
class NullSearchProvider extends SearchProvider {
  async search() {
    const err = new Error('SEARCH_UNAVAILABLE（服务端未配置搜索服务）');
    err.kind = 'search_unavailable';
    throw err;
  }
}

/** Serper.dev（Google 搜索 API）适配。Key 调用时读取（DB 设置 > env，Admin UI 可改）。 */
class SerperSearchProvider extends SearchProvider {
  constructor(apiKey = null) {
    super();
    this.apiKey = apiKey;
  }
  async search(query) {
    const key = this.apiKey || resolveSerperKey();
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn', num: 5 }),
    });
    if (!res.ok) {
      const err = new Error(`搜索服务异常（${res.status}）`);
      err.kind = 'search_unavailable';
      throw err;
    }
    const data = await res.json();
    return (data.organic || []).slice(0, 5).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet || '',
      source: 'web_search',
    }));
  }
}

/** Serper Key 解析：DB 设置（Admin UI）> env。 */
function resolveSerperKey() {
  try {
    const settings = require('../settingsService');
    return settings.getSetting('search.serper_api_key', SERPER_API_KEY) || SERPER_API_KEY;
  } catch {
    return SERPER_API_KEY;
  }
}

/** 搜索 Provider 解析：DB 设置 > env；serper 需要可用 Key。 */
function resolveSearchProviderName() {
  try {
    const settings = require('../settingsService');
    return String(settings.getSetting('search.provider', SEARCH_PROVIDER) || SEARCH_PROVIDER);
  } catch {
    return SEARCH_PROVIDER;
  }
}

function getSearchProvider() {
  const provider = resolveSearchProviderName();
  const key = resolveSerperKey();
  if (provider === 'serper' && key) return new SerperSearchProvider(key);
  return new NullSearchProvider();
}

module.exports = { SearchProvider, NullSearchProvider, SerperSearchProvider, getSearchProvider, resolveSerperKey, resolveSearchProviderName };
