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
    this.kind = kind; // unconfigured | timeout | auth | quota | rate_limited | server_error | bad_response | no_image
    this.status = status;
  }
}

/** 调用时读取 Vision 专属环境变量（与 AI 配置互不影响）。 */
function getVisionRuntimeConfig() {
  // 阶段26：DB 设置（Admin Web UI）> 环境变量 > 默认值
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
  } catch { /* 设置层不可用 → 纯 env */
  }
  return { baseUrl: String(baseUrl).replace(/\/$/, ''), apiKey, model, timeoutMs, providerName: 'deepseek_vision' };
}

/**
 * 将用户填写的 API Base URL 转成真正的 OpenAI-compatible Chat Completions URL（用户 3689b46）。
 * https://api.inferaiapi.com -> .../v1/chat/completions；已含 /v1 或自定义路径则保持。
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

/** Vision HTTP 状态码 → 错误分类（覆盖 400/401/402/403/408/429/5xx）。 */
function classifyVisionStatus(status) {
  if (status === 400) return new VisionError('bad_response', 'Vision 请求无效（400）', 400);
  if (status === 401 || status === 403) return new VisionError('auth', 'Vision 服务鉴权失败（API Key 无效）', status);
  if (status === 402) return new VisionError('quota', 'Vision 服务余额不足', 402);
  if (status === 408) return new VisionError('timeout', 'Vision 服务请求超时（408）', 408);
  if (status === 429) return new VisionError('rate_limited', 'Vision 请求被限速，请稍后再试', 429);
  if (status >= 500) return new VisionError('server_error', `Vision 服务暂时不可用（${status}）`, status);
  return new VisionError('server_error', `Vision 服务异常（${status}）`, status);
}

/** Vision 专用 POST（超时 + 错误分类），与 AI Provider 的 postJson 互不依赖。 */
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
    const text = await res.text();
    if (!res.ok) {
      const err = classifyVisionStatus(res.status);
      const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (t) err.message = `${err.message}（服务端响应：${t}）`;
      throw err;
    }
    // 阶段29加固：HTML / 非 JSON / 空体 → 明确报错（Base URL 检查提示）
    const respBody = String(text || '').trim();
    if (!respBody) throw new VisionError('bad_response', 'Vision 服务返回空响应（模型或路径可能不正确）', 502);
    if (respBody.startsWith('<!') || /^<html/i.test(respBody)) {
      throw new VisionError('bad_base_url', 'Vision 服务返回了HTML页面而非JSON——Base URL 很可能不正确（请检查是否缺少 /v1，端点应为 {Base URL}/chat/completions）', 502);
    }
    try {
      return JSON.parse(respBody);
    } catch {
      throw new VisionError('bad_response', `Vision 服务响应不是合法JSON（前120字符：${respBody.replace(/\s+/g, ' ').slice(0, 120)}）`, 502);
    }
  } catch (err) {
    if (err instanceof VisionError) throw err;
    if (err.name === 'AbortError') throw new VisionError('timeout', 'Vision 分析超时，请稍后重试');
    throw new VisionError('server_error', `Vision 服务网络错误：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VisionError, getVisionRuntimeConfig, classifyVisionStatus, visionPostJson, buildVisionChatUrl };
