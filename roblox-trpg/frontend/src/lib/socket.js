import { io } from 'socket.io-client';

// 同源连接：开发环境由 Vite 代理 /socket.io 到后端，生产环境同源直连。
export const socket = io({ autoConnect: false });
