/**
 * Roblox 公开 API 统一 HTTP 封装。
 * - 所有请求从服务端发起（浏览器与 AI 均不直连）
 * - 超时控制 + 错误分类（404 / 429 / 5xx / timeout / network）
 * - 只访问无鉴权公开端点，不携带任何登录态
 */
const { ROBLOX_TIMEOUT_MS } = require('../../config');

const USER_AGENT = 'RobloxTrpg-InfoService/0.2 (public-data-only)';

/** Roblox API 错误（带分类，便于上层提示与缓存兜底）。 */
class RobloxApiError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'RobloxApiError';
    this.kind = kind; // not_found | rate_limited | server_error | timeout | network | bad_response
    this.status = status;
  }
}

/**
 * 请求 JSON。失败抛出 RobloxApiError。
 * @param {string} url
 * @param {{method?:string, body?:any, timeoutMs?:number}} [opts]
 */
async function robloxJson(url, opts = {}) {
  const { method = 'GET', body, timeoutMs = ROBLOX_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    if (res.status === 404) throw new RobloxApiError('not_found', 'Roblox 资料不存在', 404);
    if (res.status === 429) throw new RobloxApiError('rate_limited', 'Roblox 请求过多（429）', 429);
    if (res.status >= 500) throw new RobloxApiError('server_error', `Roblox 服务暂时不可用（${res.status}）`, res.status);
    if (!res.ok) throw new RobloxApiError('bad_response', `Roblox API 异常（${res.status}）`, res.status);

    return await res.json();
  } catch (err) {
    if (err instanceof RobloxApiError) throw err;
    if (err.name === 'AbortError') throw new RobloxApiError('timeout', 'Roblox API 请求超时');
    throw new RobloxApiError('network', `无法连接 Roblox API：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { robloxJson, RobloxApiError, USER_AGENT };
