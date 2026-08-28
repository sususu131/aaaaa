import { useEffect, useState } from 'react';
import PlayerList from './PlayerList.jsx';
import ChatPanel from './ChatPanel.jsx';
import InstanceBar from './InstanceBar.jsx';
import ContextViewer from './ContextViewer.jsx';
import DungeonPanel from './DungeonPanel.jsx';
import DungeonDesigner from './DungeonDesigner.jsx';
import DungeonRuntime from './DungeonRuntime.jsx';
import CharacterPanel from './CharacterPanel.jsx';
import RobloxBindPanel from './RobloxBindPanel.jsx';
import QuestPanel from './QuestPanel.jsx';
import NpcPanel from './NpcPanel.jsx';
import LegendPanel from './LegendPanel.jsx';
import WorldPanel from './WorldPanel.jsx';
import PartyPanel from './PartyPanel.jsx';
import DecisionPanel from './DecisionPanel.jsx';
import InventoryPanel from './InventoryPanel.jsx';
import ExperienceSelectPanel from './ExperienceSelectPanel.jsx';
import { socket } from '../lib/socket.js';

/**
 * 房间视图：房间ID / 副本卡片 / 玩家列表 / 聊天区 + 三个功能面板。
 */
export default function RoomScreen({
  room,
  myName,
  players,
  messages,
  chatDraft,
  onChatDraftChange,
  onLeave,
  onSend,
  onPickOption,
  onLoadOlder,
  hasOlder,
  gmStatus,
  modal,
  onOpenModal,
  getSessionToken,
}) {
  const [copied, setCopied] = useState(false);
  const [toasts, setToasts] = useState([]);

  // 任务通知（第三十二节）：QUEST_STARTED / OBJECTIVE_COMPLETED / COMPLETED / FAILED / BRANCH / REWARD
  useEffect(() => {
    const label = {
      QUEST_STARTED: '📜 新任务开始',
      QUEST_OBJECTIVE_COMPLETED: '✓ 任务目标完成',
      QUEST_COMPLETED: '🎉 任务完成！',
      QUEST_FAILED: '❌ 任务失败',
      QUEST_BRANCH: '🔀 任务出现分支',
      QUEST_REWARD: '🎁 任务奖励结算',
    };
    const onQuestEvent = (e) => {
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: `${label[e.type] || e.type}${e.objective ? `：${e.objective}` : ''}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    socket.on('quest:event', onQuestEvent);

    // 阶段9：NPC 关系变化提示
    const npcLabel = {
      NPC_SPAWNED: '🧍 NPC 出现',
      NPC_DEAD: '💀 NPC 死亡',
      NPC_HELP: '💚 关系变化：帮助',
      NPC_CONVERSATION: '💬 关系变化：交谈',
      NPC_DECEIVE: '💔 关系变化：欺骗',
      NPC_ATTACK: '⚔ 关系变化：攻击',
      NPC_BETRAY: '🗡 关系变化：背叛',
      NPC_QUEST_COMPLETE: '🤝 关系变化：任务完成',
    };
    const onNpcEvent = (e) => {
      const base = npcLabel[e.type] || e.type;
      const extra = e.relationship !== undefined ? `（关系 ${e.relationship}）` : e.name ? `：${e.name}` : '';
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: `${base}${extra}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    socket.on('npc:event', onNpcEvent);

    // 阶段12：世界模拟事件提示（世界事件起止/NPC移动/阵营关系/副本变体/传奇现身）
    const worldLabel = {
      WORLD_EVENT_STARTED: '🌩 世界事件发生',
      WORLD_EVENT_EXPIRED: '🌤 世界事件结束',
      NPC_MOVED: '🚶 NPC 移动',
      NPC_BEHAVIOR_CHANGED: '🧠 NPC 行为变化',
      FACTION_RELATION_CHANGED: '⚔ 阵营关系变化',
      DUNGEON_VARIANT_CHANGED: '🌀 副本形态变化',
      LEGEND_WORLD_SPAWN: '⭐ 传奇人物现身',
      WORLD_SCHEDULER: '⏯ 世界模拟调度',
    };
    const onWorldEvent = (e) => {
      const base = worldLabel[e.type] || e.type;
      const extra =
        e.label || e.locationName
          ? `：${e.label || e.locationName}`
          : e.factionA
            ? `：${e.factionA}↔${e.factionB} ${e.to}`
            : e.npc
              ? `：${e.npc}`
              : e.name
                ? `：${e.name}`
                : '';
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: `${base}${extra}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    socket.on('world:event', onWorldEvent);

    // 阶段13：新抉择提示（限时选择尤其需要玩家注意）
    const onDecisionNew = (d) => {
      const label = d.type === 'TIMED' ? '⏱ 限时抉择！' : d.type === 'PARTY' ? '🗳 团队决策' : '🎭 剧情抉择';
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: `${label}：${String(d.prompt || '').slice(0, 30)}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    };
    const onPartyUpdate = () => {
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: '🤝 队伍状态已更新' }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
    };
    socket.on('decision:new', onDecisionNew);
    socket.on('party:update', onPartyUpdate);

    // 阶段14：物品获得/使用/装备提示
    const itemLabel = { ITEM_ACQUIRED: '🎁 获得物品', ITEM_USED: '🧪 使用物品', ITEM_EQUIPPED: '🛡 装备物品', ITEM_REMOVED: '🗑 失去物品' };
    const onItemEvent = (e) => {
      if (!itemLabel[e.type]) return;
      const id = `${Date.now()}_${Math.random()}`;
      setToasts((t) => [...t.slice(-4), { id, text: `${itemLabel[e.type]}：${e.data && e.data.item ? e.data.item : ''}${e.data && e.data.amount > 1 ? ` ×${e.data.amount}` : ''}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    socket.on('game:event', onItemEvent);
    return () => {
      socket.off('quest:event', onQuestEvent);
      socket.off('npc:event', onNpcEvent);
      socket.off('world:event', onWorldEvent);
      socket.off('decision:new', onDecisionNew);
      socket.off('party:update', onPartyUpdate);
      socket.off('game:event', onItemEvent);
    };
  }, []);

  const copyRoomId = async () => {
    // 修复：navigator.clipboard 仅在安全上下文（HTTPS/localhost）可用；
    // 从局域网 IP 访问（非安全上下文）时静默失败 → 加 execCommand 兜底 + 明确反馈。
    const text = String(room?.id || '');
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fall through to legacy copy */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1500);
    else alert('复制失败，请手动复制房间号：' + text);
  };

  // 修复退出空白页：leaveRoom 后 room 会被置 null，此时若本组件仍短暂渲染，
  // 直接访问 room.id 会抛错导致整页白屏。加空值防护，回到 lobby 由 App 接管。
  if (!room) return null;

  return (
    <main className="room">
      <div className="room-header-bar">
        <div className="room-id-box">
          <span className="label">房间</span>
          <strong className="room-id">{room.id}</strong>
          <button className="btn tiny" onClick={copyRoomId}>
            {copied ? '✓' : '复制'}
          </button>
        </div>
        <span className="room-count">
          {players.length}/{room.maxPlayers}
        </span>
        <div className="toolbar">
          <button className={`btn tiny ${modal === 'runtime' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'runtime' ? null : 'runtime')}>
            ⚔ 副本
          </button>
          <button className={`btn tiny ${modal === 'quest' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'quest' ? null : 'quest')}>
            📜 任务
          </button>
          <button className={`btn tiny ${modal === 'npc' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'npc' ? null : 'npc')}>
            🧍 NPC
          </button>
          <button className={`btn tiny ${modal === 'legend' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'legend' ? null : 'legend')}>
            ⭐ 传奇
          </button>
          <button className={`btn tiny ${modal === 'world' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'world' ? null : 'world')}>
            🌍 世界
          </button>
          <button className={`btn tiny ${modal === 'party' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'party' ? null : 'party')}>
            🤝 队伍
          </button>
          <button className={`btn tiny ${modal === 'decision' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'decision' ? null : 'decision')}>
            🎭 抉择
          </button>
          <button className={`btn tiny ${modal === 'inventory' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'inventory' ? null : 'inventory')}>
            🎒 背包
          </button>
          <button className={`btn tiny ${modal === 'experiences' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'experiences' ? null : 'experiences')}>
            ⭐ 体验
          </button>
          <button className={`btn tiny ${modal === 'character' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'character' ? null : 'character')}>
            👤 角色
          </button>
          <button className={`btn tiny ${modal === 'context' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'context' ? null : 'context')}>
            🧠 Context
          </button>
          <button className={`btn tiny ${modal === 'dungeon' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'dungeon' ? null : 'dungeon')}>
            🗺 绑定
          </button>
          <button className={`btn tiny ${modal === 'designer' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'designer' ? null : 'designer')}>
            🛠 设计
          </button>
          <button className={`btn tiny ${modal === 'avatar' ? 'active' : ''}`} onClick={() => onOpenModal(modal === 'avatar' ? null : 'avatar')}>
            🥓 形象
          </button>
        </div>
        <button className="btn tiny danger" onClick={onLeave}>
          离开
        </button>
      </div>

      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className="quest-toast">
              {t.text}
            </div>
          ))}
        </div>
      )}

      {(room.experience || room.dungeon) && (
        <div className="dungeon-banner">
          {room.experience && room.experience.iconUrl && (
            <img src={room.experience.iconUrl} alt="" className="dungeon-icon" />
          )}
          <div>
            <strong>
              当前副本：{room.dungeon ? room.dungeon.name : room.experience.name}
            </strong>
            {room.experience ? (
              <span className="source-badge">source=roblox_api</span>
            ) : (
              <span className="source-badge db">database</span>
            )}
            <p className="dungeon-desc">
              {room.experience
                ? `universeId=${room.experience.universeId} · 创作者：${room.experience.creator ? room.experience.creator.name : '未知'}`
                : '数据库登记副本（离线绑定）'}
            </p>
          </div>
        </div>
      )}

      {gmStatus && <div className="gm-status">🎲 {gmStatus}</div>}

      <div className="room-body">
        <PlayerList players={players} myName={myName} maxPlayers={room.maxPlayers} />
        <div className="chat-column">
          {/* 阶段31：副本主要在大聊天框运行——常驻状态条（场景/出口/遭遇/限时抉择） */}
          <InstanceBar getSessionToken={getSessionToken} onOpenRuntime={() => onOpenModal('runtime')} />
          <ChatPanel
            messages={messages}
            myName={myName}
            players={players}
            chatDraft={chatDraft}
            onChatDraftChange={onChatDraftChange}
            onSend={onSend}
            onPickOption={onPickOption}
            onLoadOlder={onLoadOlder}
            hasOlder={hasOlder}
          />
        </div>
      </div>

      {modal === 'context' && <ContextViewer onClose={() => onOpenModal(null)} />}
      {modal === 'designer' && <DungeonDesigner onClose={() => onOpenModal(null)} />}
      {modal === 'runtime' && (
        <DungeonRuntime onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} onPickOption={onPickOption} />
      )}
      {modal === 'character' && (
        <CharacterPanel
          onClose={() => onOpenModal(null)}
          getSessionToken={getSessionToken}
          headshotUrl={(players.find((p) => p.name === myName) || {}).headshotUrl}
        />
      )}
      {modal === 'dungeon' && (
        <DungeonPanel current={room.experience} currentDungeon={room.dungeon} onClose={() => onOpenModal(null)} />
      )}
      {modal === 'avatar' && (
        <RobloxBindPanel
          players={players}
          myName={myName}
          onClose={() => onOpenModal(null)}
          getSessionToken={getSessionToken}
        />
      )}
      {modal === 'quest' && <QuestPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'npc' && <NpcPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'legend' && <LegendPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'world' && <WorldPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'party' && <PartyPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} myName={myName} />}
      {modal === 'decision' && <DecisionPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'inventory' && <InventoryPanel onClose={() => onOpenModal(null)} getSessionToken={getSessionToken} />}
      {modal === 'experiences' && (
        <ExperienceSelectPanel
          onClose={() => onOpenModal(null)}
          getSessionToken={getSessionToken}
          onStarted={() => onOpenModal('runtime')}
        />
      )}
    </main>
  );
}
