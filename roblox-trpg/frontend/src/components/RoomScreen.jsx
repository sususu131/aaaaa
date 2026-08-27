import { useState } from 'react';
import PlayerList from './PlayerList.jsx';
import ChatPanel from './ChatPanel.jsx';

/**
 * 房间视图：房间ID + 玩家列表 + 聊天区。
 */
export default function RoomScreen({ room, myName, players, messages, onLeave, onSend }) {
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
        <button className="btn danger" onClick={onLeave}>
          离开房间
        </button>
      </div>

      <div className="room-body">
        <PlayerList players={players} myName={myName} maxPlayers={room.maxPlayers} />
        <ChatPanel messages={messages} myName={myName} onSend={onSend} />
      </div>
    </main>
  );
}
