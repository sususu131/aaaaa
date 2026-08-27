/**
 * Roblox 用户公开资料（Step 6）。
 * 只读公开信息：User ID / Username / Display Name / 公开简介。
 * 铁律：数据库主键用 Roblox User ID，username 可变只做展示。
 */
const { robloxJson } = require('./robloxHttp');
const cache = require('./robloxCache');
const { ROBLOX_TTL_USER } = require('../../config');

/** 按 Roblox User ID 获取公开资料。 */
async function getUserById(robloxUserId) {
  const id = String(robloxUserId).trim();
  if (!/^\d{1,20}$/.test(id)) {
    const err = new Error('Roblox User ID 必须是数字');
    err.kind = 'bad_input';
    throw err;
  }
  const { value, fromCache, stale, fetchedAt } = await cache.getOrFetch(`user:${id}`, ROBLOX_TTL_USER, () =>
    robloxJson(`https://users.roblox.com/v1/users/${id}`)
  );
  return {
    source: 'roblox_api',
    fromCache,
    stale,
    fetchedAt: new Date(fetchedAt).toISOString(),
    userId: String(value.id),
    username: value.name,
    displayName: value.displayName || value.name,
    description: value.description || '',
    isVerified: Boolean(value.isVerified),
  };
}

/** 按 username 解析用户（username 不稳定，仅用于找到 User ID）。 */
async function getUserByUsername(username) {
  const name = String(username).trim();
  if (!name || name.length > 50) {
    const err = new Error('用户名不合法');
    err.kind = 'bad_input';
    throw err;
  }
  const { value } = await cache.getOrFetch(`uname:${name.toLowerCase()}`, ROBLOX_TTL_USER, () =>
    robloxJson('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      body: { usernames: [name], excludeBannedUsers: true },
    })
  );
  const hit = value && value.data && value.data[0];
  if (!hit) {
    const err = new Error(`未找到用户名 "${name}" 对应的 Roblox 用户`);
    err.kind = 'not_found';
    throw err;
  }
  return getUserById(hit.id);
}

module.exports = { getUserById, getUserByUsername };
