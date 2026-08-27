/** get_scene：只读，当前实例场景（来自 Published Definition）。 */
const { register } = require('./index');
const { getDb } = require('@roblox-trpg/database');

register({
  name: 'get_scene',
  description: '只读：获取副本实例当前场景（名称/描述/出口/遭遇/事件）。仅副本内可用。',
  permission: 'READ_ONLY',
  inputSchema: { type: 'object', properties: {} },
  execute(ctx) {
    if (!ctx.instance) return { ok: false, error: '当前不在副本实例中', kind: 'invalid_scope' };
    const versionRow = getDb().prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(ctx.instance.dungeon_version_id);
    if (!versionRow) return { ok: false, error: '副本版本不存在', kind: 'not_found' };
    const def = JSON.parse(versionRow.definition_json);
    const scene = (def.scenes || []).find((s) => s.id === ctx.instance.current_scene_id);
    if (!scene) return { ok: false, error: '当前场景不存在', kind: 'not_found' };
    return { ok: true, scene, canonical: def.canonical_facts || [] };
  },
});
