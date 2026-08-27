# Roblox灾变：现实崩坏 — 阶段1 MVP 需求分析

## 项目背景（上下文，本阶段不实现玩法）
全球突变，Roblox降临现实。所有人变成自己的Roblox形象，无账号者变培根头。
每个Roblox体验变成危险副本，玩家通过副本获得装备、能力与奖励。

## 阶段1 功能清单（F1-F9）
- F1 打开网页看到入口界面
- F2 输入名字（1~16字符，非空校验）
- F3 创建房间
- F4 获得 6 位房间ID（大写字母+数字，去除易混淆字符）
- F5 输入房间ID加入；房间不存在/已满时给出明确错误
- F6 单房间上限 3 人；玩家列表实时同步
- F7 发送聊天消息（按钮 + 回车）
- F8 所有玩家实时收到消息（玩家名 + 时间 + 内容）
- F9 玩家进入/离开时同步更新玩家列表并广播系统消息

## 非功能需求
- 前端 React + Vite；后端 Node.js + Express；实时通信 Socket.io；SQLite；JavaScript
- 实时推送，禁止轮询
- 单进程即可支撑，不需要 Redis
- 开发环境：前端 5173，后端 3000，Vite 代理 /socket.io

## 本阶段红线（不做）
AI聊天、大模型API、Roblox头像、战斗、骰子、装备、副本、技能逻辑、复杂UI

## 数据模型（建表但本阶段只使用 players/rooms/messages）
- players：socket_id、名字、所属房间、加入时间
- rooms：房间ID、创建者、状态、人数上限、创建时间
- messages：消息持久化（chat / system）
- skills（预留）：技能名、描述、来源副本
- dungeons（预留）：Roblox体验 → 副本映射
- dungeon_rewards（预留）：副本可掉落技能、稀有度
- player_skills（预留）：玩家×技能多对多，含获得来源副本与时间

未来成长逻辑：完成副本 → 获得该体验相关技能
（Doors→危险感知；Jailbreak→开锁；Blox Fruits→果实能力）

## 技术架构
- 运行时房间状态存内存 Map（权威、低延迟），SQLite 持久化
- better-sqlite3，启动时自动建表
- 所有游戏通信走 Socket.io 事件，MVP 不引入额外 REST

## Socket.io 事件协议
| 方向 | 事件 | 载荷 |
|------|------|------|
| C→S | room:create | { playerName } |
| C→S | room:join | { playerName, roomId } |
| C→S | room:leave | {} |
| C→S | chat:send | { text } |
| S→C | room:joined | { room, players } |
| S→C | player:joined | { playerName, players } |
| S→C | player:left | { playerName, players } |
| S→C | chat:message | { id, playerName, text, at, type } |
| S→C | error | { message } |
