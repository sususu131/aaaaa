/**
 * AI Provider 抽象层（阶段3 第十一节）。
 * 业务层只依赖统一接口，不触碰 choices[0].message / content[].tool_use 等原生格式。
 *
 * 统一接口：
 *   - startSession({ system, userContent })  → 会话（持有 provider 原生消息历史）
 *   - chat(session, tools)                    → { content, toolCalls, finish }
 *   - appendToolResults(session, results)     → 追加工具结果（原生格式）
 *
 * 工具结果归一：toolCalls = [{ id, name, args(object) }]；无工具调用时为 []。
 */
const { AI_TIMEOUT_MS } = require('../../../config');

/** AI 调用错误（面向玩家的真实原因分类）。 */
class AiError extends Error {
  constructor(kind, playerMessage) {
    super(playerMessage);
    this.name = 'AiError';
    this.kind = kind; // unconfigured | timeout | auth | quota | rate_limited | server_error | bad_format
  }
}

/** 调用时读取环境变量（测试可改），绝不把 Key 传出服务端。 */
function getAiRuntimeConfig() {
  // 阶段25：DB 设置（Admin Web UI）> 环境变量 > 默认值
  let baseUrl = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  let apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
  let model = process.env.AI_MODEL || 'gpt-4o-mini';
  let format = process.env.AI_API_FORMAT || 'openai';
  let timeoutMs = Number(process.env.AI_TIMEOUT_MS || AI_TIMEOUT_MS);
  try {
    const settings = require('../../settingsService');
    baseUrl = settings.getSetting('ai.base_url', baseUrl) || baseUrl;
    apiKey = settings.getSetting('ai.api_key', apiKey) || apiKey;
    model = settings.getSetting('ai.model', model) || model;
    format = settings.getSetting('ai.api_format', format) || format;
    timeoutMs = Number(settings.getSetting('ai.timeout_ms', timeoutMs) || timeoutMs);
  } catch { /* 设置层不可用（如初始化前）→ 纯 env */
  }
  return { baseUrl: String(baseUrl).replace(/\/$/, ''), apiKey, model, format, timeoutMs };
}

/** 阶段25：AI 流式开关（DB 设置 > env；默认开）。 */
function aiStreamEnabled() {
  try {
    const settings = require('../../settingsService');
    const v = settings.getSetting('ai.stream', process.env.AI_STREAM || 'on');
    return String(v) !== 'off';
  } catch {
    return process.env.AI_STREAM !== 'off';
  }
}

/** 响应体片段（错误信息附加；截断并压平换行）。 */
function snippet(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : '';
}

/**
 * 阶段29：解析 AI 响应体。HTML / 非 JSON / 空体 → 明确的 AiError（bad_base_url 提示）。
 */
function parseJsonBody(text, url = '') {
  const t = String(text || '').trim();
  if (!t) throw new AiError('bad_format', 'AI服务返回空响应（模型或路径可能不正确）');
  if (t.startsWith('<!') || /^<html/i.test(t)) {
    throw new AiError(
      'bad_base_url',
      `AI服务返回了HTML页面而非JSON——Base URL 很可能不正确（请检查是否缺少 /v1，端点应为 {Base URL}/chat/completions）`
    );
  }
  try {
    return JSON.parse(t);
  } catch {
    throw new AiError('bad_format', `AI服务响应不是合法JSON（前160字符：${snippet(t)}）`);
  }
}

/** HTTP 状态码 → 统一错误分类。 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return new AiError('auth', 'AI服务鉴权失败（API Key 无效）');
  if (status === 402) return new AiError('quota', 'AI服务余额不足');
  if (status === 429) return new AiError('rate_limited', 'AI请求被限速，请稍后再试');
  if (status >= 500) return new AiError('server_error', 'AI服务暂时不可用（服务器错误）');
  return new AiError('server_error', `AI服务返回异常状态（${status}）`);
}

/**
 * 统一 fetch（超时 + 错误分类）。返回已解析 JSON。
 * 阶段29 加固：网关返回 HTML（Base URL 缺 /v1、路径错误、被首页兜底）时，
 * 明确报"HTML 而非 JSON"而不是裸 SyntaxError: Unexpected token '<'。
 */
async function postJson(url, headers, body, timeoutMs) {
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
      const detail = snippet(text);
      const err = classifyStatus(res.status);
      if (detail) err.message = `${err.message}（服务端响应：${detail}）`;
      throw err;
    }
    return parseJsonBody(text, url);
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err.name === 'AbortError') throw new AiError('timeout', 'GM暂时无法回应，请稍后再试（请求超时）');
    throw new AiError('server_error', `GM暂时无法回应（网络错误：${err.message}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 安全解析工具参数（AI 可能产出非法 JSON）。 */
function safeParseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __parse_error: true, __raw: String(raw).slice(0, 200) };
  }
}

class AiProvider {
  /** 子类实现。 */
  startSession() {
    throw new Error('not implemented');
  }
  chat() {
    throw new Error('not implemented');
  }
  appendToolResults() {
    throw new Error('not implemented');
  }
}

module.exports = { AiProvider, AiError, getAiRuntimeConfig, aiStreamEnabled, classifyStatus, postJson, parseJsonBody, snippet, safeParseArgs };
