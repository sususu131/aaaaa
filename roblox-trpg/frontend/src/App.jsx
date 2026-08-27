import { useEffect, useRef, useState } from 'react';
import { socket } from './lib/socket.js';
import LobbyScreen from './components/LobbyScreen.jsx';
import RoomScreen from './components/RoomScreen.jsx';

export default function App() {
  const [screen, setScreen] = useState('lobby'); // lobby | room
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('rtp_name') || '');
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // 建立连接 + 绑定全部服务端事件（只绑定一次）
  useEffect(() => {
    socket.connect();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onError = ({ message }) => setError(message);
    const onRoomJoined = ({ room: r, players: ps }) => {
      setRoom(r);
      setPlayers(ps);
      setMessages([]);
      setError('');
      setScreen('room');
    };
    const onPlayerJoined = ({ players: ps }) => setPlayers(ps);
    const onPlayerLeft = ({ players: ps }) => setPlayers(ps);
    const onChatMessage = (msg) => setMessages((prev) => [...prev, msg]);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('error', onError);
    socket.on('room:joined', onRoomJoined);
    socket.on('player:joined', onPlayerJoined);
    socket.on('player:left', onPlayerLeft);
    socket.on('chat:message', onChatMessage);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('error', onError);
      socket.off('room:joined', onRoomJoined);
      socket.off('player:joined', onPlayerJoined);
      socket.off('player:left', onPlayerLeft);
      socket.off('chat:message', onChatMessage);
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
  };

  const sendMessage = (text) => {
    socket.emit('chat:send', { text });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Roblox灾变：现实崩坏</h1>
        <span className={`conn-dot ${connected ? 'on' : 'off'}`} title={connected ? '已连接' : '连接中'} />
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
          onLeave={leaveRoom}
          onSend={sendMessage}
        />
      )}
    </div>
  );
}
