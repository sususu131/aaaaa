import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';

/**
 * 副本状态条（阶段31）：副本主要在大聊天框运行——
 * 这里常驻显示实例进度（场景/出口/遭遇/战斗/限时抉择），
 * 聊天框 @AI 提交行动即可推进（triggerGm 已路由到 Runtime GM）。
 * 「副本」按钮的面板保留为详情/管理台（创建实例、战斗操作、事件日志）。
 */
export default function InstanceBar({ getSessionToken, onOpenRuntime }) {
  const [uid, setUid] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [timedEvent, setTimedEvent] = useState(null);
  const [timedLeft, setTimedLeft] = useState(1);
  const uidRef = useRef(null);

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async (targetUid) => {
    const id = targetUid || uidRef.current;
    if (!id) return;
    try {
      const snap = await api.getInstance(id);
      setSnapshot(snap);
      setError('');
    } catch (e) {
      // 实例已结束/不存在 → 收起状态条
      const msg = String(e.message || '');
      if (e.code === 'NOT_FOUND' || /不存在|not found/i.test(msg)) {
        uidRef.current = null;
        setUid(null);
        setSnapshot(null);
      } else {
        setError(msg);
      }
    }
  }, []);

  // 挂载：同步房间活跃实例 + 监听实例事件（聊天框不需要打开副本面板也能看到进度）
  useEffect(() => {
    socket.emit('instance:sync', {}, (res) => {
      if (res && res.ok && res.instance) {
        uidRef.current = res.instance.uid;
        setUid(res.instance.uid);
        refresh(res.instance.uid);
      }
    });
    const onUpdate = () => refresh();
    const onTimed = (d) => setTimedEvent({ ...d, receivedAt: Date.now() });
    const onTimedExpired = () => {
      setTimedEvent(null);
      refresh();
    };
    socket.on('instance:update', onUpdate);
    socket.on('instance:scene', onUpdate);
    socket.on('instance:combat', onUpdate);
    socket.on('instance:completed', onUpdate);
    socket.on('instance:failed', onUpdate);
    socket.on('instance:timedEvent', onTimed);
    socket.on('instance:timedExpired', onTimedExpired);
    return () => {
      socket.off('instance:update', onUpdate);
      socket.off('instance:scene', onUpdate);
      socket.off('instance:combat', onUpdate);
      socket.off('instance:completed', onUpdate);
      socket.off('instance:failed', onUpdate);
      socket.off('instance:timedEvent', onTimed);
      socket.off('instance:timedExpired', onTimedExpired);
    };
  }, [refresh]);

  // 限时抉择倒计时（进度条）
  useEffect(() => {
    if (!timedEvent) return undefined;
    const tick = () => {
      const left = Math.max(0, timedEvent.expiresAt - Date.now());
      setTimedLeft(Math.max(0, Math.min(1, left / timedEvent.deadlineMs)));
      if (left <= 0) setTimedEvent(null); // 服务器会广播 timedExpired
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [timedEvent]);

  const chooseTimed = async (index) => {
    if (!timedEvent || !uidRef.current) return;
    setTimedEvent(null);
    try {
      const r = await api.timedChoice(uidRef.current, index, token());
      if (!r.ok) setError(`选择被拒：${r.reason}`);
    } catch (e) {
      setError(e.message);
    }
  };

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!uid) return null;

  const status = snapshot ? snapshot.instance.status : '加载中…';
  const scene = snapshot && snapshot.scene ? snapshot.scene : null;
  const combat = snapshot && snapshot.combat ? snapshot.combat : null;

  return (
    <div className="instance-bar">
      <div className="instance-bar-head">
        <strong>
          ⚔ {snapshot ? snapshot.dungeon.name : '副本'}{' '}
          <span className={`inst-status ${String(status).toLowerCase()}`}>{status}</span>
        </strong>
        <div className="instance-bar-actions">
          {status === 'RUNNING' && (
            <button className="btn tiny danger" disabled={busy} onClick={() => run(() => api.stopInstance(uid, token()))}>
              停止
            </button>
          )}
          <button className="btn tiny" onClick={onOpenRuntime}>
            详情/战斗
          </button>
        </div>
      </div>

      {error && <p className="instance-bar-error">⚠ {error}</p>}

      {!snapshot && <p className="muted small">正在同步实例状态…</p>}

      {snapshot && status === 'WAITING' && (
        <div className="instance-bar-row">
          <span className="muted small">等待玩家加入（≥2 人可开始）</span>
          <button className="btn tiny" disabled={busy} onClick={() => run(() => api.joinInstance(uid, token()))}>
            加入实例
          </button>
          <button className="btn tiny primary" disabled={busy} onClick={() => run(() => api.startInstance(uid, token()))}>
            开始
          </button>
        </div>
      )}

      {snapshot && status === 'RUNNING' && scene && !combat && (
        <div className="instance-bar-scene">
          <div className="instance-bar-row">
            <strong>📍 {scene.name}</strong>
            <span className="muted small">{scene.description}</span>
          </div>
          <div className="instance-bar-row">
            {(scene.exits || []).map((exitId) => (
              <button key={exitId} className="btn tiny" disabled={busy} onClick={() => run(() => api.moveScene(uid, exitId, token()))}>
                🚪 前往 {exitId}
              </button>
            ))}
            {(scene.encounters || []).map((encId) => (
              <button key={encId} className="btn tiny warn" disabled={busy} onClick={() => run(() => api.startEncounter(uid, encId, token()))}>
                ⚔ 迎战 {encId}
              </button>
            ))}
            <span className="muted small">在下方聊天框 @AI 提交行动</span>
          </div>
        </div>
      )}

      {snapshot && status === 'RUNNING' && combat && (
        <div className="instance-bar-row">
          <span>
            ⚔ 战斗进行中（回合 {combat.round ?? '?'}）——战斗操作在副本面板
          </span>
          <button className="btn tiny primary" onClick={onOpenRuntime}>
            打开战斗
          </button>
        </div>
      )}

      {snapshot && (status === 'COMPLETED' || status === 'FAILED') && (
        <p className="instance-bar-row">{status === 'COMPLETED' ? '🏁 副本已完成，奖励已结算（明细见副本面板）' : '💀 副本失败——角色进度与永久物品已保留'}</p>
      )}

      {timedEvent && (
        <div className="timed-event">
          <h4>⚠ {timedEvent.prompt}</h4>
          <div className="timed-bar">
            <div className={`timed-fill ${timedLeft < 0.3 ? 'danger' : ''}`} style={{ width: `${timedLeft * 100}%` }} />
          </div>
          <div className="action-options">
            {timedEvent.options.map((o, i) => (
              <button key={i} className="option-btn timed" onClick={() => chooseTimed(i)}>
                {o.label}
              </button>
            ))}
          </div>
          <p className="muted small">倒计时结束前未选择将承受后果！</p>
        </div>
      )}
    </div>
  );
}
