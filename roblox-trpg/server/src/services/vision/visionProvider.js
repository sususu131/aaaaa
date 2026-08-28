/**
 * Vision Provider 抽象（阶段3b）：与文字 AI Provider 完全分离。
 * 独立配置：VISION_API_KEY / VISION_BASE_URL / VISION_MODEL。
 * 绝不复用 AI_API_KEY / AI_BASE_URL / AI_MODEL —— 即使模型名相似也不自动混用。
 */
const { AI_TIMEOUT_MS } = require('../../config');

class VisionError extends Error {
  constructor(kind, playerMessage, status = null) {
    super(playerMessage);
    this.name = 'VisionError';
    this.kind = kind;
    this.status = status;
  }
}

/** 调用时读取 Vision 专属环境变量（与 AI 配置互不影响）。 */
function getVisionRuntimeConfig() {
  let baseUrl = process.env.VISION_BASE_URL || '';
  let apiKey = process.env.VISION_API_KEY || '';
  let model = process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp';
  let timeoutMs = Number(process.env.VISION_TIMEOUT_MS || Math.max(AI_TIMEOUT_MS, 30000));
  try {
    const settings = require('../settingsService');
    baseUrl = settings.getSetting('vision.base_url', baseUrl) || baseUrl;
    apiKey = settings.getSetting('vision.api_key', apiKey) || apiKey;
    model = settings.getSetting('vision.model', model) || model;
    timeoutMs = Number(settings.getSetting('vision.timeout_ms', timeoutMs) || timeoutMs);
  } catch { /* 设置层不可用 → 纯 env */ }
  return { baseUrl: String(baseUrl).replace(/\/$/, ''), apiKey, model, timeoutMs, providerName: 'deepseek_vision' };
}

/**
 * 将用户填写的 API Base URL 转成真正的 OpenAI-compatible Chat Completions URL。
 * 例如：
 *   https://api.inferaiapi.com      -> https://api.inferaiapi.com/v1/chat/completions
 *   https://api.inferaiapi.com/v1   -> https://api.inferaiapi.com/v1/chat/completions
 *   https://example.com/custom/v1    -> https://example.com/custom/v1/chat/completions
 */
function buildVisionChatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url.toString();
  } catch {
    const normalized = raw.endsWith('/v1') ? raw : `${raw}/v1`;
    return `${normalized}/chat/completions`;
  }
}

function classifyVisionStatus(status) {
  if (status === 400) return new VisionError('bad_response', 'Vision 请求无效（400）', 400);
  if (status === 401 || status === 403) return new VisionError('auth', 'Vision 服务鉴权失败（API Key 无效）', status);
  if (status === 402) return new VisionError('quota', 'Vision 服务余额不足', 402);
  if (status === 408) return new VisionError('timeout', 'Vision 服务请求超时（408）', 408);
  if (status === 429) return new VisionError('rate_limited', 'Vision 请求被限速，请稍后再试', 429);
  if (status >= 500) return new VisionError('server_error', `Vision 服务暂时不可用（${status}）`, status);
  return new VisionError('server_error', `Vision 服务异常（${status}）`, status);
}

async function visionPostJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const json = await res.json();
          detail = json.error?.message || json.error || json.message || '';
        } else {
          detail = (await res.text()).slice(0, 500);
        }
      } catch {}
      const err = classifyVisionStatus(res.status);
      if (detail) err.message += `：${detail}`;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err instanceof VisionError) throw err;
    if (err.name === 'AbortError') throw new VisionError('timeout', 'Vision 分析超时，请稍后重试');
    throw new VisionError('server_error', `Vision 服务网络错误：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VisionError, getVisionRuntimeConfig, classifyVisionStatus, visionPostJson, buildVisionChatUrl };
