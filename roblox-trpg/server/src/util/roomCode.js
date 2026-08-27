const crypto = require('crypto');
const { ROOM_CODE_LENGTH } = require('../config');

// 去除易混淆字符 0/O/1/I，保证房间码可口播、可手输
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成一个 6 位随机房间码。 */
function generateRoomCode() {
  const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += CHARSET[bytes[i] % CHARSET.length];
  }
  return code;
}

module.exports = { generateRoomCode };
