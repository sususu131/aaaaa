/**
 * 持久背包 REST（阶段14 第十二节）：查看/使用/装备（玩家操作自己的背包）。
 * 物品的增减发放仍由服务器规则驱动（奖励/商店/工具），本路由无"直接加物品"端点。
 */
const express = require('express');
const { resolveSession } = require('../sessions/sessionManager');
const inventoryService = require('../services/inventory/inventoryService');

const router = express.Router();

function authPlayer(req, res) {
  let token = (req.body && req.body.sessionToken) || (req.query && req.query.sessionToken);
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)rtp_session=([^;]+)/);
    token = m && m[1];
  }
  const sess = token ? resolveSession(token) : null;
  if (!sess) {
    res.status(401).json({ error: '无效会话', code: 'UNAUTHORIZED' });
    return null;
  }
  return sess;
}

function fail(res, err) {
  res.status(err.status || 400).json({ error: err.message, code: err.code || 'BAD_REQUEST' });
}

/** GET /api/inventory —— 我的背包（分类数据由前端按 type 组织）。 */
router.get('/api/inventory', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  res.json({ inventory: inventoryService.getInventory(sess.playerRowId), types: inventoryService.ITEM_TYPES, rarities: inventoryService.RARITIES });
});

/** POST /api/inventory/use { itemKey } —— 使用消耗品（服务器结算效果）。 */
router.post('/api/inventory/use', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const r = inventoryService.useItem(io, sess.playerRowId, String((req.body && req.body.itemKey) || ''));
    res.json({ ok: true, ...r, inventory: inventoryService.getInventory(sess.playerRowId) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/inventory/equip { itemKey } —— 装备（同槽位自动换装）。 */
router.post('/api/inventory/equip', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const r = inventoryService.equipItem(io, sess.playerRowId, String((req.body && req.body.itemKey) || ''));
    res.json({ ok: true, ...r, inventory: inventoryService.getInventory(sess.playerRowId) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/inventory/unequip { itemKeyOrSlot } —— 卸下装备。 */
router.post('/api/inventory/unequip', (req, res) => {
  const sess = authPlayer(req, res);
  if (!sess) return;
  try {
    const { io } = require('../index.js');
    const r = inventoryService.unequipItem(io, sess.playerRowId, String((req.body && req.body.itemKeyOrSlot) || ''));
    res.json({ ok: true, ...r, inventory: inventoryService.getInventory(sess.playerRowId) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
