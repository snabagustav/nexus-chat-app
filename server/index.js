require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_PIN_HASH = process.env.ADMIN_PIN_HASH || '';

const users = new Map();
const emails = new Map();
const adminSessions = new Set();
const moderators = new Set();
const mutedUsers = new Set();
const bannedEmails = new Set();
const onlineUsers = new Map();
const callRooms = new Map();
const games = new Map();
const failedPins = new Map();
const swearCooldowns = new Map();

const rooms = new Map([
  ['general', { id: 'general', name: 'General', private: false, ownerId: null, messages: [], members: new Set() }],
]);

function sign(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

function verify(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function userFromReq(req) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  const decoded = verify(token);
  return decoded ? users.get(decoded.id) : null;
}

function roleOf(user) {
  if (!user) return 'user';
  if (adminSessions.has(user.id)) return 'admin';
  if (moderators.has(user.id)) return 'moderator';
  return 'user';
}

function isMod(user) {
  const role = roleOf(user);
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
    role: roleOf(user),
    theme: user.theme || 'midnight',
    muted: mutedUsers.has(user.id),
    banned: user.email ? bannedEmails.has(user.email) : false,
  };
}

function requireAdmin(req, res, next) {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (roleOf(user) !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  next();
}

function requireMod(req, res, next) {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isMod(user)) return res.status(403).json({ error: 'Moderator only' });
  req.user = user;
  next();
}

function verifyAdminPin(pin) {
  const parts = ADMIN_PIN_HASH.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!iterations || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(pin || ''), salt, iterations, 32, 'sha256').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

const blockedTerms = [
  'damn', 'hell', 'crap', 'bloody', 'piss', 'bugger', 'bastard', 'ass', 'asshole',
  'jerk', 'douche', 'prick', 'nigger', 'nigga', 'faggot', 'retard', 'kys',
  'fuck', 'fucking', 'motherfucker', 'shit', 'bullshit',
  'piss off', 'son of a bitch', 'dick', 'cock', 'cunt', 'twat', 'wanker', 'slut',
  'whore', 'skank', 'dickhead', 'pussy', 'ballsack', 'scumbag', 'goddamn',
  'jesus christ', 'holy shit', "for christ's sake", 'for christs sake', 'fuck off',
  'fuck you', 'eat shit', 'go to hell', 'screw you', 'fan', 'fan också', 'förbannat',
  'jävlar', 'jävla', 'helvete', 'skit', 'skitsamma', 'kuk', 'fitta', 'rövhål',
  'arsle', 'hora', 'slyna', 'idiot', 'svin', 'kärring', 'as', 'satan', 'förbannad',
  'knulle', 'kuksugare', 'rövknull', 'runkare', 'dra åt helvete', 'håll käften',
  'vad fan', 'jävla idiot', 'stick åt helvete', 'skit ner dig',
];

const blockedPatterns = blockedTerms.map(term => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
});

function containsBlockedWord(text) {
  const value = String(text || '').normalize('NFC');
  return blockedPatterns.some(pattern => pattern.test(value));
}

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 32);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !email || password.length < 6) return res.status(400).json({ error: 'Fill in all fields' });
  if (emails.has(email)) return res.status(400).json({ error: 'Email already exists' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  const user = {
    id: uuid(),
    username,
    email,
    avatar: username[0].toUpperCase(),
    passwordHash: await bcrypt.hash(password, 10),
    theme: 'midnight',
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  emails.set(email, user.id);
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = users.get(emails.get(email));
  if (!user || !await bcrypt.compare(password, user.passwordHash || '')) return res.status(401).json({ error: 'Invalid login' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/anonymous', (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 32);
  if (username.length < 2) return res.status(400).json({ error: 'Enter a display name' });
  const user = { id: 'anon_' + uuid(), username, email: null, avatar: username[0].toUpperCase(), anon: true, theme: 'midnight', createdAt: Date.now() };
  users.set(user.id, user);
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/google', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || 'Google User').trim().slice(0, 32);
  const googleId = String(req.body.googleId || uuid());
  if (!email) return res.status(400).json({ error: 'Invalid Google login' });
  if (bannedEmails.has(email)) return res.status(403).json({ error: 'This account is banned' });
  let user = users.get(emails.get(email));
  if (!user) {
    user = { id: 'google_' + googleId, username: name, email, avatar: name[0].toUpperCase(), picture: req.body.picture, theme: 'midnight', createdAt: Date.now() };
    users.set(user.id, user);
    emails.set(email, user.id);
  }
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/user/theme', (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  user.theme = String(req.body.theme || 'midnight');
  res.json({ success: true, user: safeUser(user) });
});

app.post('/api/admin/unlock-pin', (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login first' });
  if (!ADMIN_PIN_HASH) return res.status(503).json({ error: 'Admin PIN is not configured in Railway' });
  const now = Date.now();
  const attempt = failedPins.get(user.id) || { count: 0, until: 0 };
  if (attempt.until > now) return res.status(429).json({ error: 'Too many wrong attempts. Wait 10 minutes.' });
  if (!verifyAdminPin(req.body.pin)) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.count = 0;
      attempt.until = now + 10 * 60 * 1000;
    }
    failedPins.set(user.id, attempt);
    return res.status(403).json({ error: 'Wrong PIN' });
  }
  failedPins.delete(user.id);
  adminSessions.add(user.id);
  res.json({ success: true, user: safeUser(user) });
});

app.get('/api/rooms', (req, res) => {
  res.json(Array.from(rooms.values()).filter(r => !r.private).map(r => ({
    id: r.id, name: r.name, private: r.private, memberCount: r.members.size,
  })));
});

app.get('/api/admin/stats', requireMod, (req, res) => {
  res.json({
    totalUsers: users.size,
    onlineUsers: onlineUsers.size,
    totalRooms: rooms.size,
    totalMessages: Array.from(rooms.values()).reduce((sum, room) => sum + room.messages.length, 0),
    games: games.size,
    muted: mutedUsers.size,
    mods: moderators.size,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => res.json(Array.from(users.values()).map(safeUser)));
app.get('/api/admin/rooms', requireAdmin, (req, res) => res.json(Array.from(rooms.values()).map(r => ({
  id: r.id, name: r.name, private: r.private, memberCount: r.members.size, messageCount: r.messages.length,
}))));

app.post('/api/admin/mute', requireMod, (req, res) => { mutedUsers.add(req.body.userId); res.json({ success: true }); });
app.post('/api/admin/unmute', requireMod, (req, res) => { mutedUsers.delete(req.body.userId); res.json({ success: true }); });
app.post('/api/admin/kick', requireMod, (req, res) => { kickUser(req.body.userId, 'You were kicked'); res.json({ success: true }); });
app.post('/api/admin/ban', requireMod, (req, res) => {
  const user = users.get(req.body.userId);
  if (user && user.email) bannedEmails.add(user.email);
  kickUser(req.body.userId, 'You were banned');
  res.json({ success: true });
});
app.post('/api/admin/unban', requireMod, (req, res) => {
  const user = users.get(req.body.userId);
  if (user && user.email) bannedEmails.delete(user.email);
  res.json({ success: true });
});
app.post('/api/admin/add-mod', requireAdmin, (req, res) => { moderators.add(req.body.userId); res.json({ success: true }); });
app.post('/api/admin/remove-mod', requireAdmin, (req, res) => { moderators.delete(req.body.userId); res.json({ success: true }); });
app.post('/api/admin/clear-room', requireMod, (req, res) => {
  const room = rooms.get(req.body.roomId);
  if (room) room.messages = [];
  io.to(req.body.roomId).emit('room_cleared');
  res.json({ success: true });
});
app.post('/api/admin/rename-room', requireAdmin, (req, res) => {
  const room = rooms.get(req.body.roomId);
  const name = String(req.body.name || '').trim().slice(0, 32);
  if (!room || name.length < 2) return res.status(400).json({ error: 'Bad room' });
  room.name = name;
  io.emit('rooms_updated');
  res.json({ success: true });
});
app.post('/api/admin/delete-room', requireAdmin, (req, res) => {
  const id = req.body.roomId;
  if (id === 'general') return res.status(403).json({ error: 'Cannot delete General' });
  rooms.delete(id);
  io.emit('rooms_updated');
  res.json({ success: true });
});

io.use((socket, next) => {
  const decoded = verify(socket.handshake.auth.token);
  const user = decoded ? users.get(decoded.id) : null;
  if (!user) return next(new Error('Unauthorized'));
  socket.userFull = user;
  socket.user = safeUser(user);
  next();
});

io.on('connection', socket => {
  const user = socket.userFull;
  onlineUsers.set(socket.id, { userId: user.id, roomId: null });
  io.emit('online_count', onlineUsers.size);

  socket.on('join_room', roomId => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_msg', 'Room not found');
    leaveTextRoom(socket);
    socket.join(roomId);
    room.members.add(socket.id);
    onlineUsers.get(socket.id).roomId = roomId;
    socket.emit('room_history', room.messages.slice(-100));
    io.to(roomId).emit('room_members', roomMembers(roomId));
  });

  socket.on('create_room', data => {
    const name = String(data.name || '').trim().slice(0, 32);
    if (name.length < 2) return socket.emit('error_msg', 'Room name too short');
    const room = { id: uuid().slice(0, 8), name, private: !!data.private, ownerId: user.id, messages: [], members: new Set() };
    rooms.set(room.id, room);
    io.emit('rooms_updated');
    socket.emit('room_created', { id: room.id, name: room.name, private: room.private });
  });

  socket.on('send_message', data => {
    const room = rooms.get(data.roomId);
    const content = String(data.content || '').trim().slice(0, 500);
    if (!room || !content) return;
    if (mutedUsers.has(user.id)) return socket.emit('error_msg', 'You are muted');
    const cooldownUntil = swearCooldowns.get(user.id) || 0;
    if (!isMod(user) && cooldownUntil > Date.now()) {
      const seconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
      return socket.emit('error_msg', `Language cooldown: wait ${seconds}s`);
    }
    if (!isMod(user) && containsBlockedWord(content)) {
      swearCooldowns.set(user.id, Date.now() + 60 * 1000);
      return socket.emit('error_msg', 'Message blocked. 60 second language cooldown started.');
    }
    const message = {
      id: uuid(), userId: user.id, username: user.username, avatar: user.avatar,
      content, timestamp: Date.now(), roomId: room.id, role: roleOf(user),
    };
    room.messages.push(message);
    if (room.messages.length > 300) room.messages.shift();
    io.to(room.id).emit('new_message', message);
  });

  socket.on('typing', data => socket.to(data.roomId).emit('user_typing', { username: user.username, typing: !!data.typing }));
  socket.on('mod_delete_message', data => {
    if (!isMod(user)) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    room.messages = room.messages.filter(m => m.id !== data.messageId);
    io.to(data.roomId).emit('message_deleted', { messageId: data.messageId });
  });

  socket.on('call_join', data => {
    const callId = String(data.callId || 'general');
    if (!callRooms.has(callId)) callRooms.set(callId, new Set());
    const peers = Array.from(callRooms.get(callId));
    const peerList = peers.map(peerId => {
      const peerUser = users.get(onlineUsers.get(peerId)?.userId);
      return { peerId, username: peerUser?.username || 'User', avatar: peerUser?.avatar || '?' };
    });
    callRooms.get(callId).add(socket.id);
    socket.join('call_' + callId);
    peers.forEach(peerId => io.to(peerId).emit('call_peer_joined', { peerId: socket.id, username: user.username, avatar: user.avatar }));
    socket.emit('call_existing_peers', { peers: peerList, callId });
  });
  socket.on('call_offer', data => io.to(data.to).emit('call_offer', { from: socket.id, offer: data.offer, username: user.username, avatar: user.avatar }));
  socket.on('call_answer', data => io.to(data.to).emit('call_answer', { from: socket.id, answer: data.answer }));
  socket.on('call_ice', data => io.to(data.to).emit('call_ice', { from: socket.id, candidate: data.candidate }));
  socket.on('call_leave', data => leaveCall(socket, data.callId));

  socket.on('game_create', data => {
    const game = createGame(data.type, user);
    games.set(game.id, game);
    socket.join('game_' + game.id);
    socket.emit('game_created', { game });
  });
  socket.on('game_join', data => {
    const game = games.get(String(data.gameId || '').toUpperCase());
    if (!game || game.players.length >= 2) return socket.emit('game_error', 'Game not found or full');
    game.players.push({ id: user.id, username: user.username });
    game.status = 'playing';
    socket.join('game_' + game.id);
    io.to('game_' + game.id).emit('game_updated', game);
  });
  socket.on('game_move', data => {
    const game = games.get(data.gameId);
    if (!game) return;
    const error = applyMove(game, data.move, user.id);
    if (error) return socket.emit('game_error', error);
    io.to('game_' + game.id).emit('game_updated', game);
  });

  socket.on('disconnect', () => {
    leaveTextRoom(socket);
    callRooms.forEach((_, callId) => leaveCall(socket, callId));
    onlineUsers.delete(socket.id);
    io.emit('online_count', onlineUsers.size);
  });
});

function kickUser(userId, reason) {
  for (const [socketId, info] of onlineUsers) {
    if (info.userId === userId) io.to(socketId).emit('force_logout', { reason });
  }
}

function leaveTextRoom(socket) {
  const info = onlineUsers.get(socket.id);
  if (!info || !info.roomId) return;
  const room = rooms.get(info.roomId);
  if (room) {
    room.members.delete(socket.id);
    io.to(info.roomId).emit('room_members', roomMembers(info.roomId));
  }
  socket.leave(info.roomId);
  info.roomId = null;
}

function roomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members).map(socketId => users.get(onlineUsers.get(socketId)?.userId)).filter(Boolean).map(safeUser);
}

function leaveCall(socket, callId) {
  const set = callRooms.get(callId);
  if (!set) return;
  set.delete(socket.id);
  socket.leave('call_' + callId);
  io.to('call_' + callId).emit('call_peer_left', { peerId: socket.id });
  if (!set.size) callRooms.delete(callId);
}

function createGame(type, user) {
  const id = uuid().slice(0, 6).toUpperCase();
  const base = { id, type, players: [{ id: user.id, username: user.username }], status: 'waiting', turn: 0, winner: null };
  if (type === 'connect4') return { ...base, board: Array(42).fill(null) };
  if (type === 'rps') return { ...base, choices: {} };
  if (type === 'memory') return { ...base, board: [...Array(8).keys(), ...Array(8).keys()].sort(() => Math.random() - 0.5), flipped: [], matched: [], scores: [0, 0] };
  return { ...base, type: 'tictactoe', board: Array(9).fill(null) };
}

function applyMove(game, move, userId) {
  const player = game.players.findIndex(p => p.id === userId);
  if (player < 0) return 'Not a player';
  if (game.status !== 'playing') return 'Game not active';
  if (game.type === 'rps') {
    game.choices[userId] = move.choice;
    if (Object.keys(game.choices).length === 2) {
      const a = game.choices[game.players[0].id];
      const b = game.choices[game.players[1].id];
      game.winner = a === b ? 'draw' : ((a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper')) ? 0 : 1;
      game.status = 'ended';
    }
    return null;
  }
  if (game.turn % 2 !== player) return 'Not your turn';
  if (game.type === 'connect4') return moveConnect4(game, move, player);
  if (game.type === 'memory') return moveMemory(game, move, player);
  return moveTtt(game, move, player);
}

function moveTtt(game, move, player) {
  const index = Number(move.index);
  if (index < 0 || index > 8 || game.board[index] !== null) return 'Taken';
  game.board[index] = player;
  game.turn += 1;
  const winner = winTtt(game.board);
  if (winner !== null) { game.winner = winner; game.status = 'ended'; }
  else if (game.turn >= 9) { game.winner = 'draw'; game.status = 'ended'; }
  return null;
}

function moveConnect4(game, move, player) {
  const col = Number(move.col);
  let row = -1;
  for (let r = 5; r >= 0; r--) if (game.board[r * 7 + col] === null) { row = r; break; }
  if (row < 0) return 'Column full';
  game.board[row * 7 + col] = player;
  game.turn += 1;
  if (winC4(game.board, row, col, player)) { game.winner = player; game.status = 'ended'; }
  else if (game.turn >= 42) { game.winner = 'draw'; game.status = 'ended'; }
  return null;
}

function moveMemory(game, move, player) {
  const index = Number(move.index);
  if (game.matched.includes(index) || game.flipped.includes(index)) return 'Invalid';
  game.flipped.push(index);
  if (game.flipped.length === 2) {
    const [a, b] = game.flipped;
    if (game.board[a] === game.board[b]) {
      game.matched.push(a, b);
      game.scores[player] += 1;
      if (game.matched.length === game.board.length) {
        game.winner = game.scores[0] === game.scores[1] ? 'draw' : game.scores[0] > game.scores[1] ? 0 : 1;
        game.status = 'ended';
      }
    } else {
      game.turn += 1;
    }
    setTimeout(() => { game.flipped = []; io.to('game_' + game.id).emit('game_updated', game); }, 800);
  }
  return null;
}

function winTtt(board) {
  for (const line of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) {
    if (board[line[0]] !== null && board[line[0]] === board[line[1]] && board[line[0]] === board[line[2]]) return board[line[0]];
  }
  return null;
}

function winC4(board, row, col, player) {
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    let count = 1;
    for (let d = 1; d < 4; d++) {
      const r = row + dr * d, c = col + dc * d;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r * 7 + c] !== player) break;
      count++;
    }
    for (let d = 1; d < 4; d++) {
      const r = row - dr * d, c = col - dc * d;
      if (r < 0 || r > 5 || c < 0 || c > 6 || board[r * 7 + c] !== player) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

server.listen(process.env.PORT || 3000, () => console.log('Nexus Chat App running'));
