/**
 * Provider 选择：AI_API_FORMAT=openai | anthropic。
 * 业务层：const provider = getProvider(); provider.startSession/chat/appendToolResults。
 */
const { OpenAIProvider } = require('./OpenAIProvider');
const { AnthropicProvider } = require('./AnthropicProvider');

function getProvider() {
  const format = (process.env.AI_API_FORMAT || 'openai').toLowerCase();
  if (format === 'anthropic') return new AnthropicProvider();
  return new OpenAIProvider();
}

module.exports = { getProvider };
module.exports.AiError = require('./AiProvider').AiError;
module.exports.getAiRuntimeConfig = require('./AiProvider').getAiRuntimeConfig;
