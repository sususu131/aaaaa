/**
 * 阶段22：阵营关系 AI 工具 —— AI 可以"申请"变更关系（不写死）。
 * 纪律：AI 不能直接写库；本工具做三重验证后走 factionRelations.setFactionRelation
 * （唯一合法写入口：Event Bus + world_events 审计），且只能操作当前房间世界范围内的阵营。
 */
const { register, ToolError } = require('./index');
const { getDb } = require('@roblox-trpg/database');

const RELATIONS = ['HOSTILE', 'NEUTRAL', 'ALLIED'];

register({
  name: 'request_faction_relation_change',
  description:
    '申请变更两个阵营之间的关系（HOSTILE/NEUTRAL/ALLIED）。服务器验证：阵营必须存在且属于当前副本世界；' +
    '必须给出剧情理由；变更由服务器执行并记录审计事件（AI 不能直接写库，也不能跨世界操作）。',
  permission: 'GAME_ACTION',
  inputSchema: {
    type: 'object',
    properties: {
      factionA: { type: 'string', required: true, maxLength: 64, description: '阵营 A 名称' },
      factionB: { type: 'string', required: true, maxLength: 64, description: '阵营 B 名称' },
      relation: { type: 'string', required: true, enum: RELATIONS, description: '目标关系' },
      reason: { type: 'string', required: true, maxLength: 200, description: '剧情理由（必填，写入审计）' },
    },
  },
  execute(ctx, args) {
    const factionRelations = require('../../world/factionRelations');
    const worldSim = require('../../world/worldSim');
    const db = getDb();
    const roomId = ctx.room && ctx.room.id;
    if (!roomId) throw new ToolError('缺少房间上下文', 'no_room');

    const relation = String(args.relation || '').toUpperCase();
    if (!RELATIONS.includes(relation)) throw new ToolError(`非法关系（允许：${RELATIONS.join('/')}`, 'invalid_relation');
    const reason = String(args.reason || '').trim();
    if (!reason) throw new ToolError('必须提供剧情理由（reason）', 'reason_required');

    // 范围验证：只能操作当前房间世界的阵营（防止跨世界误操作）
    const scope = worldSim.roomFactionScope(roomId);
    const findFaction = (name) => {
      const row = db.prepare('SELECT * FROM factions WHERE name = ? OR uid = ?').get(String(name), String(name));
      if (!row) throw new ToolError(`阵营「${name}」不存在（不能凭空创建）`, 'faction_not_found');
      if (!scope.factionIds.includes(row.id)) {
        throw new ToolError(`阵营「${row.name}」不属于当前世界（跨世界关系操作被拒绝）`, 'faction_out_of_scope');
      }
      return row;
    };
    const fa = findFaction(args.factionA);
    const fb = findFaction(args.factionB);
    if (fa.id === fb.id) throw new ToolError('需要两个不同的阵营', 'invalid_pair');

    try {
      const res = factionRelations.setFactionRelation(ctx.io, fa.id, fb.id, relation, {
        source: 'ai_gm',
        reason,
        roomId,
      });
      return {
        ok: true,
        changed: res.changed,
        previous: res.previous,
        relation,
        factionA: fa.name,
        factionB: fb.name,
        note: '关系由服务器唯一写入口执行，已记录审计事件。',
        success: true,
      };
    } catch (err) {
      return { ok: false, error: err.message, error_code: err.code || 'RELATION_ERROR', success: false };
    }
  },
});
