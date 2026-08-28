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

/**
 * 用户头像：headshot + 全身。返回 { headshot, fullbody, fullbodyR6, fullbodyR15 }。
 * 阶段30：官方 avatar 端点支持 thumbnailFormat=r6/r15/bodyType 参数——
 * r6 = 经典六部件体型；r15 = 现代十五部件体型。绑定统一取 R6 渲染（用户要求固定 R6）。
 */
async function getUserThumbnails(robloxUserId) {
  const id = String(robloxUserId);
  const [headshot, fullbodyR6, fullbodyR15] = await Promise.all([
    thumb(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`,
      `thumb:hs:${id}`
    ),
    thumb(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png&isCircular=false&thumbnailFormat=r6`,
      `thumb:full:r6:${id}`
    ),
    thumb(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png&isCircular=false&thumbnailFormat=r15`,
      `thumb:full:r15:${id}`
    ),
  ]);
  return {
    headshot,
    fullbodyR6,
    fullbodyR15,
    // 兼容旧调用方：fullbody = R6（绑定固定 R6），R6 不可用时回落 R15
    fullbody: (fullbodyR6 && fullbodyR6.imageUrl && fullbodyR6.state !== 'Blocked' ? fullbodyR6 : fullbodyR15),
  };
}

/** 阶段30：探测用户实际体型（R6/R15）——读取用户当前佩戴的装备类型。 */
async function getUserAvatarType(robloxUserId) {
  try {
    const { robloxJson } = require('./robloxHttp');
    const cache = require('./robloxCache');
    const data = await cache.getOrFetch(`avatartype:${robloxUserId}`, 6 * 60 * 60 * 1000, () =>
      robloxJson(`https://avatar.roblox.com/v1/users/${robloxUserId}/avatar`)
    );
    return data && data.playerAvatarType ? String(data.playerAvatarType) : null; // R6 / R15
  } catch {
    return null;
  }
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

module.exports = { getUserThumbnails, getUserAvatarType, getGameIcon, getGameThumbnails };
