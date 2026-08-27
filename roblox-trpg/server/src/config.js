module.exports = {
  PORT: process.env.PORT || 3000,
  ROOM_MAX_PLAYERS: 3,      // 单房间容量上限（需求F6：2-3名玩家）
  PLAYER_NAME_MAX: 16,      // 名字长度上限
  MESSAGE_MAX: 500,         // 单条消息长度上限
  ROOM_CODE_LENGTH: 6,      // 房间码长度
};
