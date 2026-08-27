/**
 * Roblox 信息缓存（内存 + TTL + LRU 上限）。
 * 策略：
 *  - 命中且未过期 → 直接返回
 *  - 过期 → 尝试刷新；刷新失败时回退旧值（stale fallback）
 *  - 无缓存且请求失败 → 抛出错误（上层转 ROBLOX_DATA_UNAVAILABLE）
 */
const MAX_ENTRIES = 500;

const store = new Map(); // key -> { value, fetchedAt, ttl }

function now() {
  return Date.now();
}

function touch(key) {
  const v = store.get(key);
  if (v) {
    store.delete(key);
    store.set(key, v); // Map 保持插入序 → 最旧在前
  }
}

function evictIfNeeded() {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/** 同步读缓存（可能返回过期值，由调用方判断）。 */
function peek(key) {
  const entry = store.get(key);
  if (!entry) return null;
  touch(key);
  return { ...entry, fresh: now() - entry.fetchedAt < entry.ttl };
}

/** 写缓存。 */
function put(key, value, ttl) {
  store.delete(key);
  store.set(key, { value, fetchedAt: now(), ttl });
  evictIfNeeded();
}

/**
 * 取值：缓存优先；过期/缺失时调用 fetcher。
 * fetcher 失败时若有旧缓存则返回 { value, fromCache:true, stale:true }。
 * @returns {Promise<{value:any, fromCache:boolean, stale:boolean, fetchedAt:number}>}
 */
async function getOrFetch(key, ttl, fetcher) {
  const entry = peek(key);
  if (entry && entry.fresh) {
    return { value: entry.value, fromCache: true, stale: false, fetchedAt: entry.fetchedAt };
  }
  try {
    const value = await fetcher();
    put(key, value, ttl);
    return { value, fromCache: false, stale: false, fetchedAt: now() };
  } catch (err) {
    if (entry) {
      // API 失败：优先使用缓存（即使过期）
      return { value: entry.value, fromCache: true, stale: true, fetchedAt: entry.fetchedAt };
    }
    throw err; // 无缓存 → 上层必须告知 ROBLOX_DATA_UNAVAILABLE
  }
}

function clear() {
  store.clear();
}

function stats() {
  return { entries: store.size, max: MAX_ENTRIES };
}

module.exports = { getOrFetch, peek, put, clear, stats };
