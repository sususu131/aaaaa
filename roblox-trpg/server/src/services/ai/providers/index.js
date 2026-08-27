/**
 * Provider 选择：
 *   AI_API_FORMAT=openai（默认，OpenAI/DeepSeek 兼容）| anthropic | responses
 * Text 与 Vision 严格分离：Vision 走 services/vision/*（VISION_* 配置），本模块永不处理图片。
 */
const { OpenAIProvider } = require('./OpenAIProvider');
const { AnthropicProvider } = require('./AnthropicProvider');
const { ResponsesProvider } = require('./responsesAdapter');

function getProvider() {
  const format = (process.env.AI_API_FORMAT || 'openai').toLowerCase();
  if (format === 'anthropic') return new AnthropicProvider();
  if (format === 'responses') return new ResponsesProvider();
  return new OpenAIProvider();
}

module.exports = { getProvider };
module.exports.AiError = require('./AiProvider').AiError;
module.exports.getAiRuntimeConfig = require('./AiProvider').getAiRuntimeConfig;
