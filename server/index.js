require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'gustavenglund69@gmail.com';
const ADMIN_PIN = process.env.ADMIN_PIN || '5693';

const users = new Map();
const emailIndex = new Map();
const moderators = new Set();
const mutedUsers = new Set();
const bannedEmails = new Set();
const adminSessions = new Set();
const onlineUsers = new Map();
const callRooms = new Map();
const gameRooms = new Map();

const rooms = new Map([
  ['general', {
    id: 'general',
    name: 'General Chat',
    desc: 'Main chat',
    private: false,
    ownerId: null,
    messages: [],
    members: new Set(),
  }],
]);

function signToken(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function getRole(user) {
  if (!user) return 'user';
  if (user.email === ADMIN_EMAIL || adminSessions.has(user.id)) return 'admin';
  if (moderators.has(user.id)) return 'moderator';
  return 'user';
}

function isAdmin(user) {
  return getRole(user) === 'admin';
}

function isMod(user) {
  const role = getRole(user);
  return role === 'admin' || role === 'moderator';
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    picture: user.picture,
    anon: !!user.anon,
    role: getRole(user),
    muted: mutedUsers.has(user.id),
    banned: user.email ? bannedEmails.has(user.email) : false,
  };
}

function authFromReq(req) {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = verifyToken(token);
  return decoded ? users.get(decoded.id) : null;
}

function adminAuth(req, res, next) {
  const user = authFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAdmin(user)) return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  next();
}

function modAuth(req, res, next) {
  const user = authFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isMod(user)) return res.status(403).json({ error: 'Moderator only' });
  req.user = user;
  next();
}

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !email || password.length < 6) return res.status(400).json({ error: 'Fill in all fields' });
  if (emailIndex.has(email)) return res.status(400).json({ error: 'Email already registered' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  const user = {
    id: uuidv4(),
    username,
    email,
    avatar: username[0].toUpperCase(),
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  emailIndex.set(email, user.id);
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const id = emailIndex.get(email);
  const user = id ? users.get(id) : null;
  if (!user || !await bcrypt.compare(password, user.passwordHash || '')) return res.status(401).json({ error: 'Invalid credentials' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/anonymous', (req, res) => {
  const username = String(req.body.username || '').trim();
  if (username.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  const user = {
    id: 'anon_' + uuidv4(),
    username,
    email: null,
    avatar: username[0].toUpperCase(),
    anon: true,
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/google', (req, res) => {
  const googleId = String(req.body.googleId || '');
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || 'Google User').trim();
  const picture = req.body.picture;
  if (!googleId || !email) return res.status(400).json({ error: 'Invalid Google login' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  let user = users.get(emailIndex.get(email));
  if (!user) {
    user = {
      id: 'google_' + googleId,
      username: name,
      email,
      avatar: name[0].toUpperCase(),
      picture,
      googleId,
      createdAt: Date.now(),
    };
    users.set(user.id, user);
    emailIndex.set(email, user.id);
  }
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/admin/unlock-pin', (req, res) => {
  const user = authFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login first' });
  if (String(req.body.pin || '') !== ADMIN_PIN) return res.status(403).json({ error: 'Wrong PIN' });
  adminSessions.add(user.id);
  res.json({ success: true, user: safeUser(user) });
});

app.get('/api/rooms', (req, res) => {
  res.json(Array.from(rooms.values())
    .filter(room => !room.private)
    .map(room => ({
      id: room.id,
      name: room.name,
      desc: room.desc,
      private: room.private,
      memberCount: room.members.size,
    })));
});

app.get('/api/admin/stats', modAuth, (req, res) => {
  res.json({
    totalUsers: users.size,
    onlineUsers: onlineUsers.size,
    bannedUsers: bannedEmails.size,
    moderators: moderators.size,
    totalRooms: rooms.size,
    totalMessages: Array.from(rooms.values()).reduce((sum, room) => sum + room.messages.length, 0),
  });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  res.json(Array.from(users.values()).map(safeUser));
});

app.get('/api/admin/rooms', adminAuth, (req, res) => {
  res.json(Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    private: room.private,
    ownerId: room.ownerId,
    memberCount: room.members.size,
    messageCount: room.messages.length,
  })));
});

app.post('/api/admin/ban', modAuth, (req, res) => {
  const user = users.get(req.body.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isAdmin(user)) return res.status(403).json({ error: 'Cannot ban admin' });
  if (user.email) bannedEmails.add(user.email);
  kickUserSockets(user.id, 'You have been banned');
  res.json({ success: true });
});

app.post('/api/admin/unban', modAuth, (req, res) => {
  const user = users.get(req.body.userId);
  if (user?.email) bannedEmails.delete(user.email);
  res.json({ success: true });
});

app.post('/api/admin/kick', modAuth, (req, res) => {
  kickUserSockets(req.body.userId, 'You have been kicked');
  res.json({ success: true });
});

app.post('/api/admin/mute', modAuth, (req, res) => {
  const user = users.get(req.body.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isAdmin(user)) return res.status(403).json({ error: 'Cannot mute admin' });
  mutedUsers.add(user.id);
  io.emit('user_muted', { userId: user.id });
  res.json({ success: true });
});

app.post('/api/admin/unmute', modAuth, (req, res) => {
  mutedUsers.delete(req.body.userId);
  io.emit('user_unmuted', { userId: req.body.userId });
  res.json({ success: true });
});

app.post('/api/admin/add-mod', adminAuth, (req, res) => {
  if (!users.has(req.body.userId)) return res.status(404).json({ error: 'User not found' });
  moderators.add(req.body.userId);
  res.json({ success: true });
});

app.post('/api/admin/remove-mod', adminAuth, (req, res) => {
  moderators.delete(req.body.userId);
  res.json({ success: true });
});

app.post('/api/admin/delete-message', modAuth, (req, res) => {
  const room = rooms.get(req.body.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.messages = room.messages.filter(message => message.id !== req.body.messageId);
  io.to(req.body.roomId).emit('message_deleted', { messageId: req.body.messageId });
  res.json({ success: true });
});

app.post('/api/admin/clear-room', modAuth, (req, res) => {
  const room = rooms.get(req.body.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.messages = [];
  io.to(req.body.roomId).emit('room_cleared');
  res.json({ success: true });
});

app.post('/api/admin/delete-room', adminAuth, (req, res) => {
  const roomId = req.body.roomId;
  if (roomId === 'general') return res.status(403).json({ error: 'General chat cannot be deleted' });
  if (!rooms.has(roomId)) return res.status(404).json({ error: 'Room not found' });
  io.to(roomId).emit('room_deleted', { roomId });
  rooms.delete(roomId);
  io.emit('rooms_updated');
  res.json({ success: true });
});

io.use((socket, next) => {
  const decoded = verifyToken(socket.handshake.auth.token);
  const user = decoded ? users.get(decoded.id) : null;
  if (!user) return next(new Error('Unauthorized'));
  socket.userFull = user;
  socket.user = safeUser(user);
  next();
});

io.on('connection', socket => {
  const user = socket.user;
  onlineUsers.set(socket.id, { userId: user.id, username: user.username, roomId: null });
  broadcastOnlineCount();

  socket.on('join_room', roomId => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_msg', 'Room not found');
    leaveTextRoom(socket);
    socket.join(roomId);
    room.members.add(socket.id);
    onlineUsers.get(socket.id).roomId = roomId;
    socket.emit('room_history', room.messages.slice(-80));
    io.to(roomId).emit('room_members', getRoomMembers(roomId));
  });

  socket.on('create_room', data => {
    const name = String(data?.name || '').trim().slice(0, 32);
    if (name.length < 2) return socket.emit('error_msg', 'Room name must be at least 2 characters');
    const room = {
      id: uuidv4().slice(0, 8).toLowerCase(),
      name,
      desc: data.private ? 'Private room' : 'Public room',
      private: !!data.private,
      ownerId: user.id,
      messages: [],
      members: new Set(),
    };
    rooms.set(room.id, room);
    io.emit('rooms_updated');
    socket.emit('room_created', { id: room.id, name: room.name, private: room.private });
  });

  socket.on('delete_room', data => {
    const roomId = data?.roomId;
    if (!isMod(socket.userFull)) return socket.emit('error_msg', 'Admin only');
    if (roomId === 'general') return socket.emit('error_msg', 'General chat cannot be deleted');
    if (!rooms.has(roomId)) return socket.emit('error_msg', 'Room not found');
    io.to(roomId).emit('room_deleted', { roomId });
    rooms.delete(roomId);
    io.emit('rooms_updated');
  });

  socket.on('send_message', data => {
    const room = rooms.get(data?.roomId);
    const content = String(data?.content || '').trim().slice(0, 500);
    if (!room || !content) return;
    if (mutedUsers.has(user.id)) return socket.emit('error_msg', 'You are muted');
    const message = {
      id: uuidv4(),
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      content,
      timestamp: Date.now(),
      roomId: room.id,
      role: getRole(socket.userFull),
    };
    room.messages.push(message);
    if (room.messages.length > 300) room.messages.shift();
    io.to(room.id).emit('new_message', message);
  });

  socket.on('typing', data => {
    socket.to(data.roomId).emit('user_typing', { username: user.username, typing: !!data.typing });
  });

  socket.on('mod_delete_message', data => {
    if (!isMod(socket.userFull)) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.messages = room.messages.filter(message => message.id !== data.messageId);
    io.to(data.roomId).emit('message_deleted', { messageId: data.messageId });
  });

  socket.on('call_join', data => {
    const callId = String(data.callId || 'general');
    if (!callRooms.has(callId)) callRooms.set(callId, new Set());
    const peers = Array.from(callRooms.get(callId));
    callRooms.get(callId).add(socket.id);
    socket.join('call_' + callId);
    peers.forEach(peerId => io.to(peerId).emit('call_peer_joined', { peerId: socket.id, username: user.username }));
    socket.emit('call_existing_peers', { peers, callId });
  });
  socket.on('call_offer', data => io.to(data.to).emit('call_offer', { from: socket.id, offer: data.offer, username: user.username }));
  socket.on('call_answer', data => io.to(data.to).emit('call_answer', { from: socket.id, answer: data.answer }));
  socket.on('call_ice', data => io.to(data.to).emit('call_ice', { from: socket.id, candidate: data.candidate }));
  socket.on('call_leave', data => leaveCall(socket, data.callId));

  socket.on('game_create', data => {
    const gameId = uuidv4().slice(0, 6).toUpperCase();
    const game = createGame(data.type, gameId, user);
    gameRooms.set(gameId, game);
    socket.join('game_' + gameId);
    socket.emit('game_created', { gameId, game });
  });
  socket.on('game_join', data => {
    const game = gameRooms.get(String(data.gameId || '').toUpperCase());
    if (!game) return socket.emit('game_error', 'Game not found');
    if (game.players.length >= 2) return socket.emit('game_error', 'Game is full');
    game.players.push({ id: user.id, username: user.username, avatar: user.avatar });
    game.status = 'playing';
    socket.join('game_' + game.id);
    io.to('game_' + game.id).emit('game_updated', game);
  });
  socket.on('game_move', data => {
    const game = gameRooms.get(data.gameId);
    if (!game) return;
    const result = applyMove(game, data.move, user.id);
    if (result.error) return socket.emit('game_error', result.error);
    io.to('game_' + game.id).emit('game_updated', game);
  });
  socket.on('game_rematch', data => {
    const game = gameRooms.get(data.gameId);
    if (!game) return;
    resetGame(game);
    io.to('game_' + game.id).emit('game_updated', game);
  });

  socket.on('disconnect', () => {
    leaveTextRoom(socket);
    callRooms.forEach((_, callId) => leaveCall(socket, callId));
    onlineUsers.delete(socket.id);
    broadcastOnlineCount();
  });
});

function kickUserSockets(userId, reason) {
  for (const [socketId, info] of onlineUsers) {
    if (info.userId === userId) io.to(socketId).emit('force_logout', { reason });
  }
}

function broadcastOnlineCount() {
  io.emit('online_count', onlineUsers.size);
}

function leaveTextRoom(socket) {
  const info = onlineUsers.get(socket.id);
  if (!info?.roomId) return;
  const room = rooms.get(info.roomId);
  if (room) {
    room.members.delete(socket.id);
    io.to(info.roomId).emit('room_members', getRoomMembers(info.roomId));
  }
  socket.leave(info.roomId);
  info.roomId = null;
}

function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members)
    .map(socketId => users.get(onlineUsers.get(socketId)?.userId))
    .filter(Boolean)
    .map(safeUser);
}

function leaveCall(socket, callId) {
  const set = callRooms.get(callId);
  if (!set) return;
  set.delete(socket.id);
  socket.leave('call_' + callId);
  io.to('call_' + callId).emit('call_peer_left', { peerId: socket.id });
  if (set.size === 0) callRooms.delete(callId);
}

function createGame(type, id, user) {
  const base = { id, type, players: [{ id: user.id, username: user.username, avatar: user.avatar }], status: 'waiting', winner: null, turn: 0 };
  if (type === 'connect4') return { ...base, board: Array(42).fill(null) };
  if (type === 'chess') return { ...base, board: initChess() };
  return { ...base, type: 'tictactoe', board: Array(9).fill(null) };
}

function resetGame(game) {
  game.status = 'playing';
  game.winner = null;
  game.turn = 0;
  game.board = game.type === 'connect4' ? Array(42).fill(null) : game.type === 'chess' ? initChess() : Array(9).fill(null);
}

function applyMove(game, move, userId) {
  if (game.status !== 'playing') return { error: 'Game not active' };
  const playerIndex = game.players.findIndex(player => player.id === userId);
  if (playerIndex < 0) return { error: 'Not a player' };
  if (game.turn % 2 !== playerIndex) return { error: 'Not your turn' };
  if (game.type === 'connect4') return moveConnect4(game, move, playerIndex);
  if (game.type === 'chess') return moveChess(game, move, playerIndex);
  return moveTicTacToe(game, move, playerIndex);
}

function moveTicTacToe(game, move, playerIndex) {
  const index = Number(move.index);
  if (index < 0 || index > 8 || game.board[index] !== null) return { error: 'Invalid move' };
  game.board[index] = playerIndex;
  game.turn++;
  const winner = checkTicTacToe(game.board);
  if (winner !== null) { game.winner = winner; game.status = 'ended'; }
  else if (game.turn >= 9) { game.winner = 'draw'; game.status = 'ended'; }
  return {};
}

function checkTicTacToe(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}

function moveConnect4(game, move, playerIndex) {
  const col = Number(move.col);
  if (col < 0 || col > 6) return { error: 'Invalid column' };
  let row = -1;
  for (let r = 5; r >= 0; r--) if (game.board[r * 7 + col] === null) { row = r; break; }
  if (row < 0) return { error: 'Column full' };
  game.board[row * 7 + col] = playerIndex;
  game.turn++;
  if (checkConnect4(game.board, row, col, playerIndex)) { game.winner = playerIndex; game.status = 'ended'; }
  else if (game.turn >= 42) { game.winner = 'draw'; game.status = 'ended'; }
  return {};
}

function checkConnect4(board, row, col, playerIndex) {
  const directions = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of directions) {
    let count = 1;
    for (let step = 1; step < 4; step++) {
      const r = row + dr * step, c = col + dc * step;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r * 7 + c] !== playerIndex) break;
      count++;
    }
    for (let step = 1; step < 4; step++) {
      const r = row - dr * step, c = col - dc * step;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r * 7 + c] !== playerIndex) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

function initChess() {
  const board = Array(64).fill(null);
  const back = ['R','N','B','Q','K','B','N','R'];
  for (let i = 0; i < 8; i++) {
    board[i] = 'b' + back[i];
    board[8 + i] = 'bP';
    board[48 + i] = 'wP';
    board[56 + i] = 'w' + back[i];
  }
  return board;
}

function moveChess(game, move, playerIndex) {
  const from = Number(move.from), to = Number(move.to);
  const color = playerIndex === 0 ? 'w' : 'b';
  const piece = game.board[from];
  if (!piece || piece[0] !== color) return { error: 'Invalid piece' };
  const captured = game.board[to];
  game.board[to] = piece;
  game.board[from] = null;
  game.turn++;
  if (captured === 'wK') { game.winner = 1; game.status = 'ended'; }
  if (captured === 'bK') { game.winner = 0; game.status = 'ended'; }
  return {};
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nexus Chat running on port ${PORT}`));
