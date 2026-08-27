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
  const sessionTokenRef = useRef(null); // 只存内存，不进 URL / localStorage

  // 建立连接 + 绑定全部服务端事件（只绑定一次）
  useEffect(() => {
    if (sessionTokenRef.current) socket.auth = { sessionToken: sessionTokenRef.current };
    socket.connect();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onError = ({ message }) => setError(message);

    const onRoomJoined = ({ room: r, players: ps, playerId: pid, sessionToken }) => {
      setRoom(r);
      setPlayers(ps);
      setMessages([]);
      setError('');
      setScreen('room');
      if (pid) setPlayerId(pid);
      if (sessionToken) {
        sessionTokenRef.current = sessionToken;
        socket.auth = { sessionToken }; // 重连/刷新后保持身份
        api.registerSessionCookie(sessionToken).catch(() => {}); // HttpOnly Cookie（服务端设置）
      }
    };
    const onPlayers = ({ players: ps }) => setPlayers(ps);
    const onChatMessage = (msg) => setMessages((prev) => [...prev, msg]);
    const onGmResponse = (gm) => {
      setGmStatus('');
      setMessages((prev) => [...prev, { ...gm, type: 'gm' }]);
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
    socket.emit('room:create', { playerName: name });
  };

  const joinRoom = (name, roomId) => {
    setError('');
    localStorage.setItem('rtp_name', name);
    socket.emit('room:join', { playerName: name, roomId });
  };

  const leaveRoom = () => {
    socket.emit('room:leave');
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

  /** AI 行动选项：只填入输入框，玩家可编辑后自行发送（不直接发送）。 */
  const pickOption = (action) => {
    setChatDraft(action);
    setModal(null);
  };

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
          gmStatus={gmStatus}
          modal={modal}
          onOpenModal={setModal}
          getSessionToken={() => sessionTokenRef.current}
        />
      )}
    </div>
  );
}
