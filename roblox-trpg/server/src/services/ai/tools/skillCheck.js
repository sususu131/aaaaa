/** skill_check：双骰拼点。服务器验证玩家/技能所有权并生成双方骰子。 */
const crypto = require('crypto');
const { register, resolveRoomPlayer, ToolError } = require('./index');
const playerStates = require('../../world/playerStates');
const { getDb } = require('@roblox-trpg/database');

register({
  name: 'skill_check',
  description:
    '技能检定（双骰拼点）：服务器验证玩家拥有该技能后，生成玩家骰(1d20)与难度骰(1d20)。' +
    'playerTotal > difficultyRoll 成功，小于失败，相等为平局/特殊结果。' +
    '可选 difficulty(-5..5) 作为玩家方情境修正。结果必须如实叙事，不得篡改。',
  permission: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      playerId: { type: 'string', required: true, maxLength: 64 },
      skill: { type: 'string', required: true, maxLength: 64, description: '技能名称或ID' },
      difficulty: { type: 'integer', min: -5, max: 5, description: '玩家方情境修正，默认0' },
      reason: { type: 'string', maxLength: 120, description: '检定原因（审计用）' },
    },
  },
  execute(ctx, args) {
    const target = resolveRoomPlayer(ctx, args.playerId);

    if (!playerStates.playerHasSkill(target.playerRowId, args.skill)) {
      throw new ToolError(`玩家 ${target.name} 未拥有技能「${args.skill}」，无法进行该检定`, 'forbidden');
    }
    const skill = playerStates.findApprovedSkill(args.skill);

    const playerRoll = crypto.randomInt(1, 21);
    const difficultyRoll = crypto.randomInt(1, 21);
    const modifier = args.difficulty || 0;
    const playerTotal = playerRoll + modifier;

    const success = playerTotal > difficultyRoll;
    const draw = playerTotal === difficultyRoll;
    const margin = playerTotal - difficultyRoll;

    const data = {
      skill: skill ? skill.name : args.skill,
      playerRoll,
      difficultyRoll,
      modifier,
      playerTotal,
      success,
      draw,
      margin,
      reason: args.reason || '',
    };
    getDb()
      .prepare('INSERT INTO dice_rolls (room_id, player_id, kind, data) VALUES (?, ?, ?, ?)')
      .run(ctx.room.id, target.playerRowId, 'skill_check', JSON.stringify(data));

    ctx.broadcast && ctx.broadcast('skill:check', { playerName: target.name, ...data, at: new Date().toISOString() });

    return {
      ok: true,
      playerName: target.name,
      skill: data.skill,
      playerRoll,
      difficultyRoll,
      playerTotal,
      success,
      draw,
      margin,
      note: '服务器双骰拼点结果，叙事时必须如实引用。',
    };
  },
});
