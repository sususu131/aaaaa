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
 * 分析 Avatar 图片。
 * @param {{imageUrl:string, allowedTags:string[], allowedSkillIds:string[]}} p
 * @returns {{raw:object, provider:string, model:string}} raw = Vision 原始输出
 */
async function analyzeAvatar({ imageUrl, allowedTags, allowedSkillIds }) {
  const cfg = getVisionRuntimeConfig();
  if (!cfg.apiKey || !cfg.baseUrl) {
    throw new VisionError('unconfigured', 'Vision 服务未配置（服务端未设置 VISION_API_KEY / VISION_BASE_URL）');
  }
  if (!imageUrl) throw new VisionError('no_image', '没有可用的 Roblox Avatar 图片');

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
          { type: 'image_url', image_url: { url: imageUrl } },
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
    throw new VisionError('bad_response', 'Vision 输出无法解析为 JSON');
  }
  return { raw, provider: cfg.providerName, model: cfg.model };
}

module.exports = { analyzeAvatar };
