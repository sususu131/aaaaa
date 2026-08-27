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
  // ── 阶段4：Dungeon Design Pipeline ──
  designDungeon: (source, opts = {}) =>
    request('/api/dungeons/design', { method: 'POST', body: JSON.stringify({ source, ...opts }) }),
  getDungeon: (id) => request(`/api/dungeons/${encodeURIComponent(id)}`),
  getVersions: (id) => request(`/api/dungeons/${encodeURIComponent(id)}/versions`),
  getVersion: (id, version) => request(`/api/dungeons/${encodeURIComponent(id)}/versions/${version}`),
  getVersionDiff: (id, from, to) => request(`/api/dungeons/${encodeURIComponent(id)}/diff?from=${from}&to=${to}`),
  getDesignRun: (id) => request(`/api/dungeon-design-runs/${id}`),
  submitReview: (versionId) =>
    request(`/api/dungeon-versions/${versionId}/submit-review`, { method: 'POST', body: '{}' }),
  reviewVersion: (versionId, status, reason) =>
    request(`/api/dungeon-versions/${versionId}/review`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    }),
  publishVersion: (versionId) =>
    request(`/api/dungeon-versions/${versionId}/publish`, { method: 'POST', body: '{}' }),
  // ── 阶段5：Dungeon Runtime ──
  listDungeons: () => request('/api/dungeons'),
  createInstance: (dungeonVersionId, sessionToken) =>
    request('/api/dungeon-instances', { method: 'POST', body: JSON.stringify({ dungeonVersionId, sessionToken }) }),
  joinInstance: (id, sessionToken) =>
    request(`/api/dungeon-instances/${id}/join`, { method: 'POST', body: JSON.stringify({ sessionToken }) }),
  startInstance: (id, sessionToken) =>
    request(`/api/dungeon-instances/${id}/start`, { method: 'POST', body: JSON.stringify({ sessionToken }) }),
  submitAction: (id, action, sessionToken, clientActionId) =>
    request(`/api/dungeon-instances/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action, sessionToken, clientActionId }),
    }),
  getInstance: (id) => request(`/api/dungeon-instances/${id}`),
  getInstanceEvents: (id) => request(`/api/dungeon-instances/${id}/events`),
  leaveInstance: (id, sessionToken) =>
    request(`/api/dungeon-instances/${id}/leave`, { method: 'POST', body: JSON.stringify({ sessionToken }) }),
  // ── 阶段6：Persistent Character ──
  getCharacter: () => request('/api/character'),
  getCharacterStats: () => request('/api/character/stats'),
  getCharacterSkills: () => request('/api/character/skills'),
  getCharacterInventory: () => request('/api/character/inventory'),
  getCharacterEquipment: () => request('/api/character/equipment'),
  useSkill: (holdId, sessionToken, turn) =>
    request(`/api/character/skills/${holdId}/use`, { method: 'POST', body: JSON.stringify({ sessionToken, turn }) }),
  equipItem: (itemId, sessionToken) =>
    request('/api/character/equipment/equip', { method: 'POST', body: JSON.stringify({ itemId, sessionToken }) }),
  unequipSlot: (slot, sessionToken) =>
    request('/api/character/equipment/unequip', { method: 'POST', body: JSON.stringify({ slot, sessionToken }) }),
};
