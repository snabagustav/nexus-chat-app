require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_dev_secret_change_me';

// ── In-memory stores (no DB needed for local use) ──────────────────────────
const users = new Map();       // id → user object
const emailIndex = new Map();  // email → id
const rooms = new Map([        // roomId → room object
  ['general',  { id: 'general',  name: 'General',   icon: '💬', desc: 'Main hangout', messages: [], members: new Set() }],
  ['gaming',   { id: 'gaming',   name: 'Gaming',    icon: '🎮', desc: 'Game talk',    messages: [], members: new Set() }],
  ['music',    { id: 'music',    name: 'Music',     icon: '🎵', desc: 'Share tunes',  messages: [], members: new Set() }],
  ['random',   { id: 'random',   name: 'Random',    icon: '🎲', desc: 'Anything goes',messages: [], members: new Set() }],
]);
const onlineUsers = new Map(); // socketId → { userId, username, roomId }
const callRooms   = new Map(); // callId → Set of socketIds
const gameRooms   = new Map(); // gameId → game state

// ── Auth helpers ────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── REST: Auth endpoints ─────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (emailIndex.has(email))
    return res.status(400).json({ error: 'Email already registered' });
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  const user = { id, username, email, passwordHash: hash, avatar: username[0].toUpperCase(), createdAt: Date.now() };
  users.set(id, user);
  emailIndex.set(email, id);
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const id = emailIndex.get(email);
  if (!id) return res.status(401).json({ error: 'Invalid credentials' });
  const user = users.get(id);
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/anonymous', (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 2)
    return res.status(400).json({ error: 'Name must be at least 2 characters' });
  const id = 'anon_' + uuidv4();
  const user = { id, username: username.trim(), email: null, passwordHash: null, avatar: username[0].toUpperCase(), anon: true, createdAt: Date.now() };
  users.set(id, user);
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/google', (req, res) => {
  // Client-side Google Sign-In sends us the decoded profile
  const { googleId, email, name, picture } = req.body;
  if (!googleId || !email) return res.status(400).json({ error: 'Invalid Google data' });
  let id = emailIndex.get(email);
  let user;
  if (id) {
    user = users.get(id);
  } else {
    id = 'google_' + googleId;
    user = { id, username: name, email, passwordHash: null, avatar: name[0].toUpperCase(), picture, googleId, createdAt: Date.now() };
    users.set(id, user);
    emailIndex.set(email, id);
  }
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    id: r.id, name: r.name, icon: r.icon, desc: r.desc,
    memberCount: r.members.size
  }));
  res.json(list);
});

function safeUser(u) {
  return { id: u.id, username: u.username, avatar: u.avatar, anon: !!u.anon, picture: u.picture };
}

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const decoded = verifyToken(token);
  if (!decoded) return next(new Error('Unauthorized'));
  const user = users.get(decoded.id);
  if (!user) return next(new Error('User not found'));
  socket.user = safeUser(user);
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  onlineUsers.set(socket.id, { userId: user.id, username: user.username, roomId: null });
  broadcastOnlineCount();

  // ── Room management ──────────────────────────────────────────────────────
  socket.on('join_room', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const prev = onlineUsers.get(socket.id);
    if (prev?.roomId) {
      socket.leave(prev.roomId);
      rooms.get(prev.roomId)?.members.delete(socket.id);
      io.to(prev.roomId).emit('room_members', getRoomMembers(prev.roomId));
      socket.to(prev.roomId).emit('user_left', { username: user.username });
    }
    socket.join(roomId);
    room.members.add(socket.id);
    onlineUsers.get(socket.id).roomId = roomId;
    socket.emit('room_history', room.messages.slice(-50));
    io.to(roomId).emit('room_members', getRoomMembers(roomId));
    socket.to(roomId).emit('user_joined', { username: user.username });
  });

  socket.on('send_message', ({ roomId, content }) => {
    if (!content?.trim() || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = {
      id: uuidv4(),
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      content: content.trim(),
      timestamp: Date.now(),
      roomId
    };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(roomId).emit('new_message', msg);
  });

  socket.on('typing', ({ roomId, typing }) => {
    socket.to(roomId).emit('user_typing', { username: user.username, typing });
  });

  // ── Voice/Video calls (WebRTC signalling) ────────────────────────────────
  socket.on('call_join', ({ callId }) => {
    if (!callRooms.has(callId)) callRooms.set(callId, new Set());
    const peers = Array.from(callRooms.get(callId));
    callRooms.get(callId).add(socket.id);
    socket.join('call_' + callId);
    // Tell existing peers about the new joiner
    peers.forEach(peerId => {
      io.to(peerId).emit('call_peer_joined', { peerId: socket.id, username: user.username });
    });
    socket.emit('call_existing_peers', { peers, callId });
  });

  socket.on('call_offer',     ({ to, offer })     => io.to(to).emit('call_offer',     { from: socket.id, offer,     username: user.username }));
  socket.on('call_answer',    ({ to, answer })    => io.to(to).emit('call_answer',    { from: socket.id, answer }));
  socket.on('call_ice',       ({ to, candidate }) => io.to(to).emit('call_ice',       { from: socket.id, candidate }));
  socket.on('call_leave',     ({ callId })        => leaveCall(socket, callId));

  // ── Games ────────────────────────────────────────────────────────────────
  socket.on('game_create', ({ type }) => {
    const gameId = uuidv4().slice(0, 6).toUpperCase();
    const game = createGame(type, gameId, user);
    gameRooms.set(gameId, game);
    socket.join('game_' + gameId);
    socket.emit('game_created', { gameId, game: publicGame(game) });
  });

  socket.on('game_join', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return socket.emit('game_error', 'Game not found');
    if (game.players.length >= 2) return socket.emit('game_error', 'Game is full');
    if (game.players.find(p => p.id === user.id)) return socket.emit('game_error', 'Already in game');
    game.players.push({ id: user.id, username: user.username, avatar: user.avatar });
    game.status = 'playing';
    socket.join('game_' + gameId);
    io.to('game_' + gameId).emit('game_updated', publicGame(game));
  });

  socket.on('game_move', ({ gameId, move }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    const result = applyMove(game, move, user.id);
    if (result.error) return socket.emit('game_error', result.error);
    io.to('game_' + gameId).emit('game_updated', publicGame(game));
  });

  socket.on('game_rematch', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    resetGame(game);
    io.to('game_' + gameId).emit('game_updated', publicGame(game));
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    if (info?.roomId) {
      rooms.get(info.roomId)?.members.delete(socket.id);
      io.to(info.roomId).emit('room_members', getRoomMembers(info.roomId));
      socket.to(info.roomId).emit('user_left', { username: user.username });
    }
    // Leave any calls
    callRooms.forEach((set, callId) => {
      if (set.has(socket.id)) leaveCall(socket, callId);
    });
    onlineUsers.delete(socket.id);
    broadcastOnlineCount();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function broadcastOnlineCount() {
  io.emit('online_count', onlineUsers.size);
}
function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members).map(sid => {
    const info = onlineUsers.get(sid);
    const u = info ? users.get(info.userId) : null;
    return u ? safeUser(u) : null;
  }).filter(Boolean);
}
function leaveCall(socket, callId) {
  const set = callRooms.get(callId);
  if (!set) return;
  set.delete(socket.id);
  socket.leave('call_' + callId);
  io.to('call_' + callId).emit('call_peer_left', { peerId: socket.id });
  if (set.size === 0) callRooms.delete(callId);
}

// ── Game logic ───────────────────────────────────────────────────────────────
function createGame(type, id, user) {
  const base = { id, type, players: [{ id: user.id, username: user.username, avatar: user.avatar }], status: 'waiting', winner: null, createdAt: Date.now() };
  if (type === 'tictactoe') return { ...base, board: Array(9).fill(null), turn: 0 };
  if (type === 'connect4')  return { ...base, board: Array(42).fill(null), turn: 0 };
  if (type === 'chess')     return { ...base, ...initChess() };
  return base;
}
function publicGame(g) { return { ...g, players: g.players }; }
function resetGame(game) {
  game.winner = null; game.status = 'playing';
  if (game.type === 'tictactoe') { game.board = Array(9).fill(null); game.turn = 0; }
  if (game.type === 'connect4')  { game.board = Array(42).fill(null); game.turn = 0; }
  if (game.type === 'chess')     { Object.assign(game, initChess()); }
}
function applyMove(game, move, userId) {
  if (game.status !== 'playing') return { error: 'Game not active' };
  const pidx = game.players.findIndex(p => p.id === userId);
  if (pidx < 0) return { error: 'Not a player' };
  if (game.type === 'tictactoe') return moveTTT(game, move, pidx);
  if (game.type === 'connect4')  return moveC4(game, move, pidx);
  if (game.type === 'chess')     return moveChess(game, move, userId);
  return { error: 'Unknown game' };
}
function moveTTT(game, { index }, pidx) {
  if (game.turn % 2 !== pidx) return { error: 'Not your turn' };
  if (game.board[index] !== null) return { error: 'Cell taken' };
  game.board[index] = pidx;
  game.turn++;
  const winner = checkTTT(game.board);
  if (winner !== null) { game.winner = winner; game.status = 'ended'; }
  else if (game.turn === 9) { game.winner = 'draw'; game.status = 'ended'; }
  return {};
}
function checkTTT(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,c,d] of lines) if (b[a]!==null && b[a]===b[c] && b[a]===b[d]) return b[a];
  return null;
}
function moveC4(game, { col }, pidx) {
  if (game.turn % 2 !== pidx) return { error: 'Not your turn' };
  const COLS = 7, ROWS = 6;
  let row = -1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (game.board[r * COLS + col] === null) { row = r; break; }
  }
  if (row < 0) return { error: 'Column full' };
  game.board[row * COLS + col] = pidx;
  game.turn++;
  if (checkC4(game.board, row, col, pidx)) { game.winner = pidx; game.status = 'ended'; }
  else if (game.turn === 42) { game.winner = 'draw'; game.status = 'ended'; }
  return {};
}
function checkC4(b, r, c, p) {
  const COLS = 7, ROWS = 6;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr,dc] of dirs) {
    let cnt = 1;
    for (let d = 1; d < 4; d++) { const nr=r+dr*d,nc=c+dc*d; if(nr<0||nr>=ROWS||nc<0||nc>=COLS||b[nr*COLS+nc]!==p) break; cnt++; }
    for (let d = 1; d < 4; d++) { const nr=r-dr*d,nc=c-dc*d; if(nr<0||nr>=ROWS||nc<0||nc>=COLS||b[nr*COLS+nc]!==p) break; cnt++; }
    if (cnt >= 4) return true;
  }
  return false;
}

// ── Chess (simplified legal-move subset) ────────────────────────────────────
function initChess() {
  const board = Array(64).fill(null);
  const back = ['R','N','B','Q','K','B','N','R'];
  for (let i=0;i<8;i++) { board[i]=`b${back[i]}`; board[8+i]=`bP`; board[48+i]=`wP`; board[56+i]=`w${back[i]}`; }
  return { board, turn: 0, castling: { wK:true,wQ:true,bK:true,bQ:true }, enPassant: null, check: false };
}
function moveChess(game, { from, to }, userId) {
  const pidx = game.players.findIndex(p => p.id === userId);
  const color = pidx === 0 ? 'w' : 'b';
  if ((game.turn % 2 === 0 && color !== 'w') || (game.turn % 2 === 1 && color !== 'b'))
    return { error: 'Not your turn' };
  const piece = game.board[from];
  if (!piece || piece[0] !== color) return { error: 'Not your piece' };
  // Basic move — just place (simplified, no full validation)
  const captured = game.board[to];
  game.board[to] = piece;
  game.board[from] = null;
  // Pawn promotion
  if (piece === 'wP' && Math.floor(to/8) === 0) game.board[to] = 'wQ';
  if (piece === 'bP' && Math.floor(to/8) === 7) game.board[to] = 'bQ';
  game.turn++;
  if (captured === 'wK') { game.winner = 1; game.status = 'ended'; }
  if (captured === 'bK') { game.winner = 0; game.status = 'ended'; }
  return {};
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🚀 Nexus Chat running → http://localhost:${PORT}\n`));
