import { useState } from 'react';
import PlayerList from './PlayerList.jsx';
import ChatPanel from './ChatPanel.jsx';
import ContextViewer from './ContextViewer.jsx';
import DungeonPanel from './DungeonPanel.jsx';
import RobloxBindPanel from './RobloxBindPanel.jsx';

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
      <div className="room-header">
        <div className="room-id-box">
          <span className="label">房间ID</span>
          <strong className="room-id">{room.id}</strong>
          <button className="btn small" onClick={copyRoomId}>
            {copied ? '已复制 ✓' : '复制'}
          </button>
        </div>
        <span className="room-count">
          {players.length}/{room.maxPlayers} 人
        </span>
        <button className="btn small" onClick={() => onOpenModal(modal === 'context' ? null : 'context')}>
          查看 Context
        </button>
        <button className="btn small" onClick={() => onOpenModal(modal === 'dungeon' ? null : 'dungeon')}>
          副本
        </button>
        <button className="btn small" onClick={() => onOpenModal(modal === 'avatar' ? null : 'avatar')}>
          Roblox形象
        </button>
        <button className="btn danger" onClick={onLeave}>
          离开
        </button>
      </div>

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
    </main>
  );
}
