/**
 * VisionProvider：OpenAI 兼容 Chat Completions（image_url 消息）。
 * 只使用 VISION_BASE_URL / VISION_API_KEY / VISION_MODEL。
 */
const { VisionError, getVisionRuntimeConfig, visionPostJson } = require('./visionProvider');
const { VISION_SYSTEM_PROMPT, buildVisionUserText } = require('./visionPrompt');
const { extractJson } = require('../ai/structuredOutput');

/**
 * 分析 Avatar 图片。
 * @param {{imageUrl:string, allowedTags:string[], allowedSkillIds:string[]}} p
 * @returns {{raw:object, provider:string, model:string}}
 */
async function analyzeAvatar({ imageUrl, allowedTags, allowedSkillIds }) {
  const cfg = getVisionRuntimeConfig();
  if (!cfg.apiKey || !cfg.baseUrl) {
    throw new VisionError('unconfigured', 'Vision 服务未配置（服务端未设置 VISION_API_KEY / VISION_BASE_URL）');
  }
  if (!imageUrl) throw new VisionError('no_image', '没有可用的 Roblox Avatar 图片');

  // 保持低随机性，避免同一张 Avatar 因语义联想产生完全不同的标签。
  const body = {
    model: cfg.model,
    temperature: 0.1,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildVisionUserText(allowedTags, allowedSkillIds) },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        ],
      },
    ],
  };

  const data = await visionPostJson(
    `${cfg.baseUrl}/chat/completions`,
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
