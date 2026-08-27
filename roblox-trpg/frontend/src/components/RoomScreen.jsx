import { useEffect, useState } from 'react';
import PlayerList from './PlayerList.jsx';
import ChatPanel from './ChatPanel.jsx';
import ContextViewer from './ContextViewer.jsx';
import DungeonPanel from './DungeonPanel.jsx';
import DungeonDesigner from './DungeonDesigner.jsx';
import DungeonRuntime from './DungeonRuntime.jsx';
import CharacterPanel from './CharacterPanel.jsx';
import RobloxBindPanel from './RobloxBindPanel.jsx';
import QuestPanel from './QuestPanel.jsx';
import NpcPanel from './NpcPanel.jsx';
import LegendPanel from './LegendPanel.jsx';
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
    return () => {
      socket.off('quest:event', onQuestEvent);
      socket.off('npc:event', onNpcEvent);
    };
  }, []);

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(room.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

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
        <ChatPanel
          messages={messages}
          myName={myName}
          players={players}
          chatDraft={chatDraft}
          onChatDraftChange={onChatDraftChange}
          onSend={onSend}
          onPickOption={onPickOption}
        />
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
    </main>
  );
}
