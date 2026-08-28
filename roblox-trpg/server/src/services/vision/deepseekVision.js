/**
 * DeepSeekVisionProvider：OpenAI 兼容 Chat Completions（image_url 消息）。
 * 只使用 VISION_BASE_URL / VISION_API_KEY / VISION_MODEL。
 * 绝不假设普通文字模型支持图片；只有配置的 VISION_MODEL 负责图片。
 *
 * LLM_NO_TOOLS: 多模态图像分析路径（image_url 输入）不支持工具调用，且分析对象是图片本身——
 * 无外部检索需求；websearch 能力由文字路径统一提供（aiAgent/agentRuntime/searchEnabledChat）。
 */
const { VisionError, getVisionRuntimeConfig, visionPostJson, buildVisionChatUrl } = require('./visionProvider');
const { VISION_SYSTEM_PROMPT, buildVisionUserText } = require('./visionPrompt');
const { extractJson } = require('../ai/structuredOutput');

/**
 * 服务端下载图片并转为 base64 data URI（阶段33修复）。
 * 原因：部分 Vision 网关/模型（如 InferAI + Gemini）不会主动抓取外部图片 URL，
 * 模型会报告"未接收/无法获取图片内容"（见观测日志）。内嵌 data URI 可确保图片字节随请求发送。
 * 幂等：下载失败时回退到原始 URL（兼容 mock 测试环境），不阻塞初始化流程。
 */
async function fetchImageAsDataUri(imageUrl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, { signal: ctrl.signal });
    if (!res.ok) {
      // 下载失败（如 mock URL）→ 回退到原始 URL，让模型自己抓取
      return imageUrl;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return imageUrl; // 空响应 → 回退
    const contentType = String(res.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      return imageUrl; // 非图片 → 回退
    }
    console.log(`[vision] 已下载头像图片：${String(imageUrl).slice(0, 100)}… 类型=${contentType} 大小=${buf.length} 字节`);
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch (err) {
    // 网络错误/超时 → 回退到原始 URL（兼容 mock 测试环境）
    return imageUrl;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分析 Avatar 图片（支持多张视角图：正面 + 背面/3D 等，方便查看背饰）。
 * @param {{imageUrl?:string, imageUrls?:string[], allowedTags:string[], allowedSkillIds:string[]}} p
 * @returns {{raw:object, provider:string, model:string}} raw = Vision 原始输出
 */
async function analyzeAvatar({ imageUrl, imageUrls, allowedTags, allowedSkillIds }) {
  const cfg = getVisionRuntimeConfig();
  if (!cfg.apiKey || !cfg.baseUrl) {
    throw new VisionError('unconfigured', 'Vision 服务未配置（服务端未设置 VISION_API_KEY / VISION_BASE_URL）');
  }

  // 收集所有图片 URL（兼容 imageUrl 旧参数 + imageUrls 数组 + 自动去重）
  const urls = [
    ...(imageUrl ? [imageUrl] : []),
    ...(Array.isArray(imageUrls) ? imageUrls : []),
  ].filter(Boolean);
  const unique = [...new Set(urls.map((u) => String(u).trim()).filter(Boolean))];
  if (unique.length === 0) throw new VisionError('no_image', '没有可用的 Roblox Avatar 图片');

  // 服务端下载每张图片 → base64 data URI（部分网关/模型不会抓取外部图片 URL）
  const imageDataUris = await Promise.all(unique.map((u) => fetchImageAsDataUri(u, cfg.timeoutMs)));

  const body = {
    model: cfg.model,
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildVisionUserText(allowedTags, allowedSkillIds) },
          ...imageDataUris.map((uri) => ({ type: 'image_url', image_url: { url: uri } })),
        ],
      },
    ],
  };

  // 兼容 InferAI 等网关：后台填 https://api.inferaiapi.com 时自动补 /v1（已含则保持）
  const endpoint = buildVisionChatUrl(cfg.baseUrl);
  const data = await visionPostJson(
    endpoint,
    { Authorization: `Bearer ${cfg.apiKey}` },
    body,
    cfg.timeoutMs
  );

  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && (msg.content || '');
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') {
    // 阶段30：解析失败也带出原文，日志可见 Vision 真实输出
    console.error('[vision] ❌ Vision 输出无法解析为 JSON');
    console.error('[vision] 模型:', cfg.model, '| 端点:', endpoint);
    console.error('[vision] 模型回复原文（前 2000 字符）:', String(text || '').slice(0, 2000));
    const err = new VisionError('bad_response', 'Vision 输出无法解析为 JSON');
    err.rawText = text;
    throw err;
  }
  return {
    raw,
    provider: cfg.providerName,
    model: cfg.model,
    // 阶段30：完整日志材料——网关原文与本次请求体（不含密钥）
    rawResponse: data,
    rawText: text,
    requestBody: { endpoint, model: cfg.model, temperature: body.temperature, max_tokens: body.max_tokens, image_url: String(imageUrl).slice(0, 120) + '…' },
  };
}

module.exports = { analyzeAvatar };
