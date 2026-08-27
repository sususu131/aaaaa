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
  return {
    baseUrl: (process.env.VISION_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VISION_API_KEY || '',
    model: process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp',
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS || Math.max(AI_TIMEOUT_MS, 30000)),
    providerName: 'deepseek_vision',
  };
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
    if (!res.ok) throw classifyVisionStatus(res.status);
    return await res.json();
  } catch (err) {
    if (err instanceof VisionError) throw err;
    if (err.name === 'AbortError') throw new VisionError('timeout', 'Vision 分析超时，请稍后重试');
    throw new VisionError('server_error', `Vision 服务网络错误：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { VisionError, getVisionRuntimeConfig, classifyVisionStatus, visionPostJson };
