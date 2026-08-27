/**
 * Roblox 头像与游戏缩略图（Step 7）。全部为公开端点。
 */
const { robloxJson } = require('./robloxHttp');
const cache = require('./robloxCache');
const { ROBLOX_TTL_THUMBNAIL } = require('../../config');

async function thumb(url, key) {
  const { value, fromCache, stale } = await cache.getOrFetch(key, ROBLOX_TTL_THUMBNAIL, () => robloxJson(url));
  const first = value && value.data && value.data[0];
  if (!first) return null;
  return {
    imageUrl: first.imageUrl,
    state: first.state || null, // Completed / Pending / Blocked
    fromCache,
    stale,
  };
}

/** 用户头像：headshot + 全身。返回 { headshot, fullbody }。 */
async function getUserThumbnails(robloxUserId) {
  const id = String(robloxUserId);
  const [headshot, fullbody] = await Promise.all([
    thumb(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`,
      `thumb:hs:${id}`
    ),
    thumb(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png&isCircular=false`,
      `thumb:full:${id}`
    ),
  ]);
  return { headshot, fullbody };
}

/** 体验图标（按 universeId）。 */
async function getGameIcon(universeId, size = '512x512') {
  return thumb(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=${size}&format=Png&isCircular=false`,
    `thumb:icon:${universeId}:${size}`
  );
}

/** 体验媒体缩略图（按 universeId）。 */
async function getGameThumbnails(universeId, size = '768x432') {
  return thumb(
    `https://thumbnails.roblox.com/v1/games/thumbnails?universeIds=${universeId}&size=${size}&format=Png&isCircular=false`,
    `thumb:game:${universeId}:${size}`
  );
}

module.exports = { getUserThumbnails, getGameIcon, getGameThumbnails };
