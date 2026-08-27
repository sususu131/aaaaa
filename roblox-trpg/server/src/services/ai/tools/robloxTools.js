/**
 * Roblox 信息工具（阶段3 第十四节）：封装阶段2 服务。
 * 所有返回数据带 [只读围栏|CANONICAL_FACT] 标记；获取失败明确返回
 * ROBLOX_DATA_UNAVAILABLE，AI 不得编造。
 */
const { register } = require('./index');
const { wrapSourceData } = require('../promptRules');
const robloxUsers = require('../../roblox/robloxUsers');
const robloxThumbnails = require('../../roblox/robloxThumbnails');
const robloxExperiences = require('../../roblox/robloxExperiences');
const robloxSearch = require('../../roblox/robloxSearch');

function fence(data) {
  return {
    ok: true,
    source: 'roblox_api',
    fence: wrapSourceData('ROBLOX_DATA | CANONICAL_FACT | 只读', JSON.stringify(data)),
    data,
  };
}

function toRobloxError(err) {
  const e = new Error(err.message || 'ROBLOX_DATA_UNAVAILABLE');
  e.kind = 'roblox_unavailable';
  return e;
}

register({
  name: 'get_roblox_experience',
  description: '获取 Roblox Experience 官方公开资料（名称/描述/创作者/统计）。优先使用房间当前绑定的体验。数据为 CANONICAL_FACT 只读。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: { universeId: { type: 'string', maxLength: 20, description: '可选；缺省用房间绑定体验' } },
  },
  async execute(ctx, args) {
    try {
      let uid = args.universeId;
      if (!uid) {
        uid =
          (ctx.room.currentExperience && ctx.room.currentExperience.universeId) ||
          (ctx.room.currentDungeon && ctx.room.currentDungeon.robloxUniverseId);
      }
      if (!uid) return { ok: false, error: 'ROBLOX_DATA_UNAVAILABLE（未绑定体验且未提供 universeId）', kind: 'roblox_unavailable' };
      return fence(await robloxExperiences.getExperienceByUniverse(uid));
    } catch (err) {
      throw toRobloxError(err);
    }
  },
});

register({
  name: 'get_roblox_user',
  description: '获取 Roblox 用户公开资料（按 User ID 或 username）。只读公开信息。',
  permission: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', maxLength: 20 },
      username: { type: 'string', maxLength: 50 },
    },
  },
  async execute(_ctx, args) {
    try {
      const profile = args.userId
        ? await robloxUsers.getUserById(args.userId)
        : await robloxUsers.getUserByUsername(args.username);
      return fence(profile);
    } catch (err) {
      throw toRobloxError(err);
    }
  },
});

register({
  name: 'get_roblox_avatar',
  description: '获取 Roblox 用户公开头像（headshot + 全身）缩略图 URL。',
  permission: 'read',
  inputSchema: { type: 'object', properties: { userId: { type: 'string', required: true, maxLength: 20 } } },
  async execute(_ctx, args) {
    try {
      return fence(await robloxThumbnails.getUserThumbnails(args.userId));
    } catch (err) {
      throw toRobloxError(err);
    }
  },
});

register({
  name: 'search_roblox_experiences',
  description: '搜索 Roblox Experience（公开信息）。返回候选列表（名称/创作者/ID）；不要替玩家自动选定。',
  permission: 'read',
  inputSchema: { type: 'object', properties: { query: { type: 'string', required: true, maxLength: 60 } } },
  async execute(_ctx, args) {
    try {
      const results = await robloxSearch.searchExperiences(args.query, 5);
      return fence(
        results.map((r) => ({
          universeId: r.universeId,
          name: r.name,
          creator: r.creator && r.creator.name,
          visits: r.stats && r.stats.visits,
        }))
      );
    } catch (err) {
      throw toRobloxError(err);
    }
  },
});
