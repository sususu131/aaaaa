/**
 * Web Search 适配层（阶段3 第十三节；阶段26/27 扩展多 Provider）。
 * 结构：AI → web_search Tool → Server Search Adapter → 搜索服务 → 结果 → AI。
 * AI 绝不直接联网。Provider 可替换：serper / bing / brave / tavily / duckduckgo（免 Key）/ null。
 * 配置读取顺序：DB 设置（Admin UI）> 环境变量；未配置时返回 SEARCH_UNAVAILABLE —— AI 不得编造搜索结果。
 */
const { SEARCH_PROVIDER, SERPER_API_KEY } = require('../../config');

/** 懒加载设置层（避免初始化顺序依赖）。 */
function resolveSetting(key, fallback) {
  try {
    return require('../settingsService').getSetting(key, fallback) || fallback;
  } catch {
    return fallback;
  }
}

/** Provider 名解析（DB > env）。 */
function resolveSearchProviderName() {
  return String(resolveSetting('search.provider', SEARCH_PROVIDER) || 'null');
}

/** 各 Provider 的 Key 解析（DB > env）。 */
function resolveSearchKey(provider) {
  const envKey = { serper: SERPER_API_KEY, bing: process.env.BING_API_KEY, brave: process.env.BRAVE_API_KEY, tavily: process.env.TAVILY_API_KEY }[provider] || '';
  return String(resolveSetting(`search.${provider}_api_key`, envKey) || '');
}

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

const unavailable = (msg) => {
  const err = new Error(msg);
  err.kind = 'search_unavailable';
  return err;
};

/** Serper.dev（Google 搜索 API）适配。Key/BaseUrl 调用时读取（Admin UI 可改）。 */
class SerperSearchProvider extends SearchProvider {
  constructor(apiKey = null, baseUrl = 'https://google.serper.dev/search') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  async search(query) {
    const key = this.apiKey || resolveSearchKey('serper');
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn', num: 5 }),
    });
    if (!res.ok) throw unavailable(`搜索服务异常（${res.status}）`);
    const data = await res.json();
    return (data.organic || []).slice(0, 5).map((r) => ({ title: r.title, link: r.link, snippet: r.snippet || '', source: 'web_search' }));
  }
}

/** Microsoft Bing Web Search API v7（Azure）。 */
class BingSearchProvider extends SearchProvider {
  constructor(apiKey = null, baseUrl = 'https://api.bing.microsoft.com/v7.0/search') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  async search(query) {
    const key = this.apiKey || resolveSearchKey('bing');
    const url = `${this.baseUrl}?q=${encodeURIComponent(query)}&count=5&responseFilter=Webpages&textDecorations=false`;
    const res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (!res.ok) throw unavailable(`Bing 搜索异常（${res.status}）`);
    const data = await res.json();
    return ((data.webPages && data.webPages.value) || []).slice(0, 5).map((r) => ({
      title: r.name, link: r.url, snippet: r.snippet || '', source: 'web_search',
    }));
  }
}

/** Brave Search API（https://api.search.brave.com）。 */
class BraveSearchProvider extends SearchProvider {
  constructor(apiKey = null, baseUrl = 'https://api.search.brave.com/res/v1/web/search') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  async search(query) {
    const key = this.apiKey || resolveSearchKey('brave');
    const url = `${this.baseUrl}?q=${encodeURIComponent(query)}&count=5`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
    if (!res.ok) throw unavailable(`Brave 搜索异常（${res.status}）`);
    const data = await res.json();
    const rows = (data.web && data.web.results) || [];
    return rows.slice(0, 5).map((r) => ({ title: r.title, link: r.url, snippet: r.description || '', source: 'web_search' }));
  }
}

/** Tavily Search API（https://api.tavily.com；LLM 友好搜索）。 */
class TavilySearchProvider extends SearchProvider {
  constructor(apiKey = null, baseUrl = 'https://api.tavily.com/search') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  async search(query) {
    const key = this.apiKey || resolveSearchKey('tavily');
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5 }),
    });
    if (!res.ok) throw unavailable(`Tavily 搜索异常（${res.status}）`);
    const data = await res.json();
    return (data.results || []).slice(0, 5).map((r) => ({ title: r.title, link: r.url, snippet: (r.content || '').slice(0, 300), source: 'web_search' }));
  }
}

/** DuckDuckGo HTML 端点（免 Key；解析结果页而非官方 API）。 */
class DuckDuckGoSearchProvider extends SearchProvider {
  constructor(baseUrl = 'https://html.duckduckgo.com/html/') {
    super();
    this.baseUrl = baseUrl;
  }
  async search(query) {
    const res = await fetch(`${this.baseUrl}?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (roblox-trpg search adapter)' },
    });
    if (!res.ok) throw unavailable(`DuckDuckGo 搜索异常（${res.status}）`);
    const html = await res.text();
    return parseDuckDuckGoHtml(html);
  }
}

const decodeEntities = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

/** DDG 结果链接形如 //duckduckgo.com/l/?uddg=<encoded>&rut=… → 还原真实 URL。 */
function unwrapDdgLink(href) {
  const m = String(href || '').match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return '';
    }
  }
  return String(href || '').startsWith('http') ? href : '';
}

/** 解析 DuckDuckGo HTML 结果页（导出供测试）。 */
function parseDuckDuckGoHtml(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const link = unwrapDdgLink(m[1]);
    const title = decodeEntities(m[2]);
    if (!link || !title) continue;
    out.push({ title, link, snippet: '', source: 'web_search' });
  }
  // 摘要与标题同序：result__snippet 块
  if (out.length) {
    const sre = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let sm;
    let i = 0;
    while ((sm = sre.exec(html)) && i < out.length) {
      out[i].snippet = decodeEntities(sm[1]).slice(0, 300);
      i += 1;
    }
  }
  return out;
}

function getSearchProvider() {
  const provider = resolveSearchProviderName();
  const key = resolveSearchKey(provider);
  if (provider === 'serper' && key) return new SerperSearchProvider(key);
  if (provider === 'bing' && key) return new BingSearchProvider(key);
  if (provider === 'brave' && key) return new BraveSearchProvider(key);
  if (provider === 'tavily' && key) return new TavilySearchProvider(key);
  if (provider === 'duckduckgo') return new DuckDuckGoSearchProvider();
  return new NullSearchProvider();
}

module.exports = {
  SearchProvider,
  NullSearchProvider,
  SerperSearchProvider,
  BingSearchProvider,
  BraveSearchProvider,
  TavilySearchProvider,
  DuckDuckGoSearchProvider,
  getSearchProvider,
  resolveSerperKey: () => resolveSearchKey('serper'),
  resolveSearchProviderName,
  resolveSearchKey,
  parseDuckDuckGoHtml,
  unwrapDdgLink,
};
