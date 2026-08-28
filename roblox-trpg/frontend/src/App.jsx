import { useEffect, useRef, useState } from 'react';
import { socket } from './lib/socket.js';
import { api } from './lib/api.js';
import LobbyScreen from './components/LobbyScreen.jsx';
import RoomScreen from './components/RoomScreen.jsx';

export default function App() {
  const [screen, setScreen] = useState('lobby'); // lobby | room
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('rtp_name') || '');
  const [playerId, setPlayerId] = useState(null); // 临时身份 player_xxxx（服务器生成）
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState(null); // null | context | dungeon | avatar
  const [chatDraft, setChatDraft] = useState(''); // 输入框内容（AI选项点击后填入，可编辑）
  const [gmStatus, setGmStatus] = useState(''); // 「GM 掷骰中…」等（不含内部推理）
  const [hasOlder, setHasOlder] = useState(false); // 阶段31：还有更早的历史可上滑加载
  const sessionTokenRef = useRef(null); // 只存内存，不进 URL / localStorage
  const roomRef = useRef(null); // 阶段32：重连自动回房用（当前房间）
  const myNameRef = useRef(''); // 阶段32：重连回房用的名字
  const everJoinedRef = useRef(false); // 阶段32：是否曾入房（区分首连与断线重连）

  // 建立连接 + 绑定全部服务端事件（只绑定一次）
  useEffect(() => {
    if (sessionTokenRef.current) socket.auth = { sessionToken: sessionTokenRef.current };
    socket.connect();

    const onConnect = () => {
      setConnected(true);
      // 阶段32：断线重连（浏览器休眠唤醒/网络恢复）→ 自动回到原房间
      // （服务端座位有保留期，同会话/同名复活原座位；room:joined 会重拉历史消息）
      if (everJoinedRef.current && roomRef.current) {
        socket.emit('room:join', { playerName: myNameRef.current, roomId: roomRef.current.id });
      }
    };
    const onDisconnect = () => setConnected(false);
    const onError = ({ message }) => setError(message);

    const onRoomJoined = ({ room: r, players: ps, playerId: pid, sessionToken }) => {
      setRoom(r);
      setPlayers(ps);
      setMessages([]);
      setHasOlder(false);
      setError('');
      setScreen('room');
      roomRef.current = r; // 阶段32：记录当前房间（断线重连自动回房）
      everJoinedRef.current = true;
      if (pid) setPlayerId(pid);
      if (sessionToken) {
        sessionTokenRef.current = sessionToken;
        socket.auth = { sessionToken }; // 重连/刷新后保持身份
        api.registerSessionCookie(sessionToken).catch(() => {}); // HttpOnly Cookie（服务端设置）
      }
      // 阶段31：入房拉取最近历史（服务器持久消息），实时消息再增量追加
      socket.emit('chat:history', { limit: 50 }, (res) => {
        if (res && res.ok && res.messages) {
          setMessages(res.messages);
          setHasOlder(res.hasMore);
        }
      });
    };
    const onPlayers = ({ players: ps }) => setPlayers(ps);
    // 阶段31：按 id 去重（历史分页加载与实时推送可能交叠）
    const appendMessage = (msg) =>
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    const onChatMessage = (msg) => appendMessage(msg);
    const onGmResponse = (gm) => {
      setGmStatus('');
      appendMessage({ ...gm, type: 'gm' });
    };
    const onDungeonSet = ({ experience, dungeon }) =>
      setRoom((prev) => (prev ? { ...prev, experience, dungeon } : prev));
    const onGmStatus = ({ status }) => setGmStatus(status || '');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('error', onError);
    socket.on('room:joined', onRoomJoined);
    socket.on('player:joined', onPlayers);
    socket.on('player:left', onPlayers);
    socket.on('players:update', onPlayers);
    socket.on('chat:message', onChatMessage);
    socket.on('gm:response', onGmResponse);
    socket.on('gm:status', onGmStatus);
    socket.on('dungeon:set', onDungeonSet);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('error', onError);
      socket.off('room:joined', onRoomJoined);
      socket.off('player:joined', onPlayers);
      socket.off('player:left', onPlayers);
      socket.off('players:update', onPlayers);
      socket.off('chat:message', onChatMessage);
      socket.off('gm:response', onGmResponse);
      socket.off('gm:status', onGmStatus);
      socket.off('dungeon:set', onDungeonSet);
      socket.disconnect();
    };
  }, []);

  const createRoom = (name) => {
    setError('');
    localStorage.setItem('rtp_name', name);
    myNameRef.current = name; // 阶段32：重连回房用
    socket.emit('room:create', { playerName: name });
  };

  const joinRoom = (name, roomId) => {
    setError('');
    localStorage.setItem('rtp_name', name);
    myNameRef.current = name; // 阶段32：重连回房用
    socket.emit('room:join', { playerName: name, roomId });
  };

  const leaveRoom = () => {
    socket.emit('room:leave');
    everJoinedRef.current = false; // 阶段32：主动离开后不再自动回房
    roomRef.current = null;
    setScreen('lobby');
    setRoom(null);
    setPlayers([]);
    setMessages([]);
    setModal(null);
  };

  const sendMessage = (text) => {
    socket.emit('chat:send', { text });
    setChatDraft('');
  };

  /**
   * AI 行动选项：填入输入框并自动带上 @AI（阶段31 修复：以前不带 @AI，
   * 发送后不会触发 GM/副本运行时）。玩家仍可编辑后自行发送，不直接发送。
   */
  const pickOption = (action) => {
    const text = String(action || '').trim();
    setChatDraft(/^\s*@AI\b/i.test(text) ? text : `@AI ${text}`);
    setModal(null);
  };

  /** 阶段31：上滑加载更早的历史消息（ChatPanel 调用；返回结果供其恢复滚动位置）。 */
  const loadOlderHistory = (beforeId) =>
    new Promise((resolve) => {
      socket.emit('chat:history', { beforeId, limit: 50 }, (res) => {
        if (res && res.ok && res.messages) {
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.id));
            return [...res.messages.filter((m) => !known.has(m.id)), ...prev];
          });
          setHasOlder(res.hasMore);
          resolve({ ok: true, hasMore: res.hasMore });
        } else {
          resolve({ ok: false, hasMore: false });
        }
      });
    });

  return (
    <div className="app">
      <header className="app-header">
        <h1>Roblox灾变：现实崩坏</h1>
        <span className={`conn-dot ${connected ? 'on' : 'off'}`} title={connected ? '已连接' : '连接中'} />
        {playerId && <span className="player-id-badge" title="临时玩家身份（服务器生成）">{playerId}</span>}
      </header>

      {error && (
        <div className="error-bar" onClick={() => setError('')}>
          ⚠ {error}（点击关闭）
        </div>
      )}

      {screen === 'lobby' ? (
        <LobbyScreen initialName={playerName} onCreate={createRoom} onJoin={joinRoom} connected={connected} />
      ) : (
        <RoomScreen
          room={room}
          myName={playerName}
          players={players}
          messages={messages}
          chatDraft={chatDraft}
          onChatDraftChange={setChatDraft}
          onLeave={leaveRoom}
          onSend={sendMessage}
          onPickOption={pickOption}
          onLoadOlder={loadOlderHistory}
          hasOlder={hasOlder}
          gmStatus={gmStatus}
          modal={modal}
          onOpenModal={setModal}
          getSessionToken={() => sessionTokenRef.current}
        />
      )}
    </div>
  );
}
