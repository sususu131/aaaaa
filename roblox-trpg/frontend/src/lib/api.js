/**
 * REST 封装：所有请求走同源 /api（Vite 代理 → 服务端）。
 * Roblox 公开信息一律由服务端代理获取，浏览器不直连。
 */
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.kind = data.kind || 'error';
    throw err;
  }
  return data;
}

export const api = {
  registerSessionCookie: (token) =>
    request('/api/session/cookie', { method: 'POST', body: JSON.stringify({ token }) }),
  visionAnalyze: (sessionToken) =>
    request('/api/vision/avatar/analyze', { method: 'POST', body: JSON.stringify({ sessionToken }) }),
  robloxUserById: (userId) => request(`/api/roblox/users/${encodeURIComponent(userId)}`),
  robloxUserByUsername: (username) =>
    request('/api/roblox/users/by-username', { method: 'POST', body: JSON.stringify({ username }) }),
  resolveExperience: (input) =>
    request('/api/roblox/experiences/resolve', { method: 'POST', body: JSON.stringify({ input }) }),
  searchExperiences: (query) =>
    request('/api/roblox/experiences/search', { method: 'POST', body: JSON.stringify({ query }) }),
};
