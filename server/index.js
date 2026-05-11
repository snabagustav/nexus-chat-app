require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling'],
  upgrade: false,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_PIN_HASH = process.env.ADMIN_PIN_HASH || '';
const dbPath = path.join(__dirname, 'data', 'db.json');

const defaultDb = {
  users: [],
  rooms: [{ id: 'general', name: 'general', private: false, ownerId: null, createdAt: 0, topic: 'Main chat' }],
  messages: [],
  dmThreads: [],
  friendRequests: [],
  friends: [],
  invites: [],
  moderators: [],
  muted: {},
  bannedEmails: [],
  auditLogs: [],
  games: [],
};

let db = loadDb();
let saveTimer = null;

const onlineUsers = new Map();
const callRooms = new Map();
const failedPins = new Map();
const adminSessions = new Set();
const swearCooldowns = new Map();

function loadDb() {
  try {
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
    }
    return { ...defaultDb, ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) };
  } catch {
    return JSON.parse(JSON.stringify(defaultDb));
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  }, 100);
}

function logAdmin(actor, action, target = '', detail = '') {
  db.auditLogs.unshift({
    id: uuid(),
    actorId: actor?.id || null,
    actor: actor?.username || 'system',
    action,
    target,
    detail,
    timestamp: Date.now(),
  });
  db.auditLogs = db.auditLogs.slice(0, 400);
  saveSoon();
}

function sign(user, admin = false) {
  return jwt.sign({ id: user.id, admin: !!admin }, JWT_SECRET, { expiresIn: '30d' });
}

function verify(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function getUser(id) {
  return db.users.find(user => user.id === id);
}

function userFromReq(req) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  const decoded = verify(token);
  const user = decoded ? getUser(decoded.id) : null;
  if (user && decoded.admin) adminSessions.add(user.id);
  return user;
}

function roleOf(user) {
  if (!user) return 'user';
  if (adminSessions.has(user.id) || user.admin) return 'admin';
  if (db.moderators.includes(user.id)) return 'moderator';
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
    avatar: user.avatar || (user.username || '?')[0].toUpperCase(),
    picture: user.picture || '',
    banner: user.banner || '',
    bio: user.bio || '',
    status: user.status || 'Online',
    theme: user.theme || 'midnight',
    accent: user.accent || '#5865f2',
    anon: !!user.anon,
    role: roleOf(user),
    mutedUntil: db.muted[user.id] || 0,
    banned: user.email ? db.bannedEmails.includes(user.email) : false,
    createdAt: user.createdAt,
  };
}

function publicUser(user) {
  const safe = safeUser(user);
  delete safe.email;
  return safe;
}

function requireUser(req, res, next) {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
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
  'fuck', 'fucking', 'motherfucker', 'shit', 'bullshit', 'piss off',
  'son of a bitch', 'dick', 'cock', 'cunt', 'twat', 'wanker', 'slut',
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

function cleanName(value, fallback = 'User') {
  const text = String(value || '').trim().slice(0, 32);
  return text || fallback;
}

function cleanImage(value) {
  const picture = String(value || '');
  if (!picture) return '';
  if (picture.length > 350000) throw new Error('Image is too large');
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(picture)) throw new Error('Bad image');
  return picture;
}

function cleanAttachment(file) {
  if (!file) return null;
  const name = String(file.name || 'file').slice(0, 80);
  const type = String(file.type || 'application/octet-stream').slice(0, 80);
  const data = String(file.data || '');
  if (data.length > 700000) throw new Error('Attachment is too large');
  if (!/^data:[a-z0-9.+/-]+;base64,[a-z0-9+/=]+$/i.test(data)) throw new Error('Bad attachment');
  return { name, type, data, size: Number(file.size || 0) };
}

function emailTaken(email) {
  return db.users.some(user => user.email === email);
}

function friendKey(a, b) {
  return [a, b].sort().join(':');
}

function areFriends(a, b) {
  return db.friends.some(friend => friend.key === friendKey(a, b));
}

function onlineSafeUsers() {
  const ids = new Set(Array.from(onlineUsers.values()).map(item => item.userId));
  return Array.from(ids).map(getUser).filter(Boolean).map(publicUser);
}

function emitToUser(userId, event, payload) {
  for (const [socketId, info] of onlineUsers) {
    if (info.userId === userId) io.to(socketId).emit(event, payload);
  }
}

function roomMessages(roomId) {
  return db.messages.filter(message => message.roomId === roomId).slice(-120);
}

function extractMentions(text) {
  const names = Array.from(String(text || '').matchAll(/@([a-z0-9_.-]{2,32})/gi)).map(match => match[1].toLowerCase());
  return db.users.filter(user => names.includes(user.username.toLowerCase())).map(user => user.id);
}

function roomMembers(roomId) {
  return Array.from(onlineUsers.values())
    .filter(info => info.roomId === roomId)
    .map(info => getUser(info.userId))
    .filter(Boolean)
    .map(publicUser);
}

function kickUser(userId, reason) {
  emitToUser(userId, 'force_logout', { reason });
}

app.post('/api/auth/register', async (req, res) => {
  const username = cleanName(req.body.username);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || password.length < 6) return res.status(400).json({ error: 'Fill in all fields' });
  if (emailTaken(email)) return res.status(400).json({ error: 'Email already exists' });
  if (db.bannedEmails.includes(email)) return res.status(403).json({ error: 'This email is banned' });
  const user = {
    id: uuid(),
    username,
    email,
    avatar: username[0].toUpperCase(),
    passwordHash: await bcrypt.hash(password, 10),
    theme: 'midnight',
    accent: '#5865f2',
    status: 'Online',
    bio: '',
    picture: '',
    banner: '',
    createdAt: Date.now(),
  };
  db.users.push(user);
  saveSoon();
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.find(item => item.email === email);
  if (!user || !await bcrypt.compare(password, user.passwordHash || '')) return res.status(401).json({ error: 'Invalid login' });
  if (db.bannedEmails.includes(email)) return res.status(403).json({ error: 'This account is banned' });
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/anonymous', (req, res) => {
  const username = cleanName(req.body.username);
  const user = {
    id: 'anon_' + uuid(),
    username,
    email: null,
    avatar: username[0].toUpperCase(),
    anon: true,
    theme: 'midnight',
    accent: '#5865f2',
    status: 'Online',
    bio: '',
    picture: '',
    banner: '',
    createdAt: Date.now(),
  };
  db.users.push(user);
  saveSoon();
  res.json({ token: sign(user), user: safeUser(user) });
});

app.post('/api/auth/google', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = cleanName(req.body.name || email);
  const googleId = String(req.body.googleId || uuid());
  if (!email) return res.status(400).json({ error: 'Invalid Google login' });
  if (db.bannedEmails.includes(email)) return res.status(403).json({ error: 'This account is banned' });
  let user = db.users.find(item => item.email === email);
  if (!user) {
    user = {
      id: 'google_' + googleId,
      username,
      email,
      avatar: username[0].toUpperCase(),
      picture: req.body.picture || '',
      theme: 'midnight',
      accent: '#5865f2',
      status: 'Online',
      bio: '',
      banner: '',
      createdAt: Date.now(),
    };
    db.users.push(user);
    saveSoon();
  }
  res.json({ token: sign(user), user: safeUser(user) });
});

app.get('/api/bootstrap', requireUser, (req, res) => {
  res.json({
    user: safeUser(req.user),
    rooms: visibleRooms(req.user),
    friends: friendList(req.user.id),
    requests: friendRequests(req.user.id),
    dmThreads: dmList(req.user.id),
    onlineUsers: onlineSafeUsers(),
  });
});

app.get('/api/rooms', requireUser, (req, res) => res.json(visibleRooms(req.user)));

function visibleRooms(user) {
  return db.rooms
    .filter(room => !room.private || room.ownerId === user.id || room.members?.includes(user.id))
    .map(room => ({
      ...room,
      memberCount: roomMembers(room.id).length,
      messageCount: db.messages.filter(message => message.roomId === room.id).length,
    }));
}

app.post('/api/rooms', requireUser, (req, res) => {
  const name = cleanName(req.body.name, 'room').toLowerCase().replace(/\s+/g, '-');
  const room = {
    id: uuid().slice(0, 8),
    name,
    private: !!req.body.private,
    ownerId: req.user.id,
    members: [req.user.id],
    topic: String(req.body.topic || '').slice(0, 100),
    createdAt: Date.now(),
  };
  db.rooms.push(room);
  saveSoon();
  io.emit('rooms_updated');
  res.json(room);
});

app.post('/api/rooms/join', requireUser, (req, res) => {
  const room = db.rooms.find(item => item.id === req.body.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.members = Array.from(new Set([...(room.members || []), req.user.id]));
  saveSoon();
  res.json(room);
});

app.post('/api/invites/create', requireUser, (req, res) => {
  const room = db.rooms.find(item => item.id === req.body.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.private && room.ownerId !== req.user.id && !isMod(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const invite = {
    code: uuid().slice(0, 8).toUpperCase(),
    roomId: room.id,
    createdBy: req.user.id,
    uses: 0,
    maxUses: Number(req.body.maxUses || 0),
    expiresAt: req.body.expiresAt || null,
    createdAt: Date.now(),
  };
  db.invites.push(invite);
  saveSoon();
  res.json(invite);
});

app.post('/api/invites/join', requireUser, (req, res) => {
  const invite = db.invites.find(item => item.code === String(req.body.code || '').toUpperCase());
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.expiresAt && Number(invite.expiresAt) < Date.now()) return res.status(410).json({ error: 'Invite expired' });
  if (invite.maxUses && invite.uses >= invite.maxUses) return res.status(410).json({ error: 'Invite used up' });
  const room = db.rooms.find(item => item.id === invite.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  room.members = Array.from(new Set([...(room.members || []), req.user.id]));
  invite.uses += 1;
  saveSoon();
  res.json(room);
});

app.post('/api/user/profile', requireUser, (req, res) => {
  req.user.username = cleanName(req.body.username || req.user.username);
  req.user.avatar = req.user.username[0].toUpperCase();
  req.user.bio = String(req.body.bio || '').slice(0, 160);
  req.user.status = String(req.body.status || 'Online').slice(0, 60);
  req.user.theme = String(req.body.theme || req.user.theme || 'midnight').slice(0, 24);
  req.user.accent = /^#[0-9a-f]{6}$/i.test(req.body.accent || '') ? req.body.accent : (req.user.accent || '#5865f2');
  req.user.banner = String(req.body.banner || '').slice(0, 180);
  saveSoon();
  res.json({ success: true, user: safeUser(req.user) });
});

app.post('/api/user/profile-picture', requireUser, (req, res) => {
  try {
    req.user.picture = cleanImage(req.body.picture);
    saveSoon();
    res.json({ success: true, user: safeUser(req.user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users/search', requireUser, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  res.json(db.users
    .filter(user => user.id !== req.user.id && user.username.toLowerCase().includes(q))
    .slice(0, 20)
    .map(publicUser));
});

app.get('/api/friends', requireUser, (req, res) => {
  res.json({ friends: friendList(req.user.id), requests: friendRequests(req.user.id) });
});

app.post('/api/friends/request', requireUser, (req, res) => {
  const to = getUser(req.body.userId);
  if (!to || to.id === req.user.id) return res.status(404).json({ error: 'User not found' });
  if (areFriends(req.user.id, to.id)) return res.status(400).json({ error: 'Already friends' });
  const existing = db.friendRequests.find(item => item.from === req.user.id && item.to === to.id && item.status === 'pending');
  if (existing) return res.json(existing);
  const request = { id: uuid(), from: req.user.id, to: to.id, status: 'pending', createdAt: Date.now() };
  db.friendRequests.push(request);
  saveSoon();
  emitToUser(to.id, 'friend_request', { request, from: publicUser(req.user) });
  res.json(request);
});

app.post('/api/friends/respond', requireUser, (req, res) => {
  const request = db.friendRequests.find(item => item.id === req.body.requestId && item.to === req.user.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = req.body.accept ? 'accepted' : 'rejected';
  if (req.body.accept && !areFriends(request.from, request.to)) {
    db.friends.push({ key: friendKey(request.from, request.to), users: [request.from, request.to], createdAt: Date.now() });
  }
  saveSoon();
  res.json({ friends: friendList(req.user.id), requests: friendRequests(req.user.id) });
});

function friendList(userId) {
  return db.friends
    .filter(friend => friend.users.includes(userId))
    .map(friend => getUser(friend.users.find(id => id !== userId)))
    .filter(Boolean)
    .map(publicUser);
}

function friendRequests(userId) {
  return db.friendRequests
    .filter(request => request.to === userId && request.status === 'pending')
    .map(request => ({ ...request, fromUser: publicUser(getUser(request.from)) }));
}

app.get('/api/dm', requireUser, (req, res) => res.json(dmList(req.user.id)));

app.post('/api/dm/start', requireUser, (req, res) => {
  const other = getUser(req.body.userId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  let thread = db.dmThreads.find(item => item.members.includes(req.user.id) && item.members.includes(other.id));
  if (!thread) {
    thread = { id: uuid().slice(0, 10), members: [req.user.id, other.id], messages: [], createdAt: Date.now() };
    db.dmThreads.push(thread);
    saveSoon();
  }
  res.json(dmView(thread, req.user.id));
});

function dmList(userId) {
  return db.dmThreads.filter(thread => thread.members.includes(userId)).map(thread => dmView(thread, userId));
}

function dmView(thread, userId) {
  return {
    id: thread.id,
    members: thread.members.map(getUser).filter(Boolean).map(publicUser),
    other: publicUser(getUser(thread.members.find(id => id !== userId)) || getUser(userId)),
    lastMessage: thread.messages.at(-1) || null,
  };
}

app.post('/api/admin/unlock-pin', requireUser, (req, res) => {
  if (!ADMIN_PIN_HASH) return res.status(503).json({ error: 'Admin PIN is not configured in Railway' });
  const now = Date.now();
  const attempt = failedPins.get(req.user.id) || { count: 0, until: 0 };
  if (attempt.until > now) return res.status(429).json({ error: 'Too many wrong attempts. Wait 10 minutes.' });
  if (!verifyAdminPin(req.body.pin)) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.count = 0;
      attempt.until = now + 10 * 60 * 1000;
    }
    failedPins.set(req.user.id, attempt);
    return res.status(403).json({ error: 'Wrong PIN' });
  }
  failedPins.delete(req.user.id);
  adminSessions.add(req.user.id);
  logAdmin(req.user, 'admin_unlock', req.user.id);
  res.json({ success: true, token: sign(req.user, true), user: safeUser(req.user) });
});

app.get('/api/admin/stats', requireMod, (req, res) => {
  res.json({
    users: db.users.length,
    online: onlineUsers.size,
    rooms: db.rooms.length,
    messages: db.messages.length,
    dmThreads: db.dmThreads.length,
    games: db.games.length,
    muted: Object.values(db.muted).filter(until => until > Date.now()).length,
    bans: db.bannedEmails.length,
    mods: db.moderators.length,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.users.map(safeUser)));
app.get('/api/admin/rooms', requireAdmin, (req, res) => res.json(db.rooms.map(room => ({
  ...room,
  messageCount: db.messages.filter(message => message.roomId === room.id).length,
  memberCount: roomMembers(room.id).length,
}))));
app.get('/api/admin/logs', requireAdmin, (req, res) => res.json(db.auditLogs.slice(0, 200)));

app.post('/api/admin/mute', requireMod, (req, res) => {
  const until = Date.now() + Number(req.body.minutes || 10) * 60 * 1000;
  db.muted[req.body.userId] = until;
  logAdmin(req.user, 'mute', req.body.userId, `${req.body.minutes || 10} minutes`);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/unmute', requireMod, (req, res) => {
  delete db.muted[req.body.userId];
  logAdmin(req.user, 'unmute', req.body.userId);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/kick', requireMod, (req, res) => {
  kickUser(req.body.userId, req.body.reason || 'You were kicked');
  logAdmin(req.user, 'kick', req.body.userId, req.body.reason || '');
  res.json({ success: true });
});
app.post('/api/admin/ban', requireMod, (req, res) => {
  const user = getUser(req.body.userId);
  if (user?.email && !db.bannedEmails.includes(user.email)) db.bannedEmails.push(user.email);
  kickUser(req.body.userId, req.body.reason || 'You were banned');
  logAdmin(req.user, 'ban', req.body.userId, req.body.reason || '');
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/unban', requireMod, (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  db.bannedEmails = db.bannedEmails.filter(item => item !== email);
  logAdmin(req.user, 'unban', email);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/add-mod', requireAdmin, (req, res) => {
  if (!db.moderators.includes(req.body.userId)) db.moderators.push(req.body.userId);
  logAdmin(req.user, 'add_mod', req.body.userId);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/remove-mod', requireAdmin, (req, res) => {
  db.moderators = db.moderators.filter(id => id !== req.body.userId);
  logAdmin(req.user, 'remove_mod', req.body.userId);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/clear-room', requireMod, (req, res) => {
  db.messages = db.messages.filter(message => message.roomId !== req.body.roomId);
  io.to(req.body.roomId).emit('room_cleared');
  logAdmin(req.user, 'clear_room', req.body.roomId);
  saveSoon();
  res.json({ success: true });
});
app.post('/api/admin/delete-room', requireAdmin, (req, res) => {
  if (req.body.roomId === 'general') return res.status(403).json({ error: 'Cannot delete General' });
  db.rooms = db.rooms.filter(room => room.id !== req.body.roomId);
  db.messages = db.messages.filter(message => message.roomId !== req.body.roomId);
  logAdmin(req.user, 'delete_room', req.body.roomId);
  saveSoon();
  io.emit('rooms_updated');
  res.json({ success: true });
});

io.use((socket, next) => {
  const decoded = verify(socket.handshake.auth.token);
  const user = decoded ? getUser(decoded.id) : null;
  if (!user) return next(new Error('Unauthorized'));
  if (decoded.admin) adminSessions.add(user.id);
  socket.userFull = user;
  socket.user = safeUser(user);
  next();
});

io.on('connection', socket => {
  const user = socket.userFull;
  onlineUsers.set(socket.id, { userId: user.id, roomId: null, dmId: null });
  io.emit('presence', onlineSafeUsers());
  io.emit('online_count', onlineUsers.size);

  socket.on('join_room', roomId => {
    const room = db.rooms.find(item => item.id === roomId);
    if (!room) return socket.emit('error_msg', 'Room not found');
    if (room.private && room.ownerId !== user.id && !room.members?.includes(user.id) && !isMod(user)) return socket.emit('error_msg', 'Private room');
    const info = onlineUsers.get(socket.id);
    if (info?.roomId) socket.leave(info.roomId);
    socket.join(room.id);
    info.roomId = room.id;
    socket.emit('room_history', roomMessages(room.id));
    io.to(room.id).emit('room_members', roomMembers(room.id));
  });

  socket.on('send_message', data => {
    const room = db.rooms.find(item => item.id === data.roomId);
    const content = String(data.content || '').trim().slice(0, 1000);
    if (!room || (!content && !data.attachment)) return;
    const mutedUntil = db.muted[user.id] || 0;
    if (mutedUntil > Date.now()) return socket.emit('error_msg', `Muted for ${Math.ceil((mutedUntil - Date.now()) / 1000)}s`);
    const cooldownUntil = swearCooldowns.get(user.id) || 0;
    if (!isMod(user) && cooldownUntil > Date.now()) return socket.emit('error_msg', `Language cooldown: wait ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s`);
    if (!isMod(user) && containsBlockedWord(content)) {
      swearCooldowns.set(user.id, Date.now() + 60 * 1000);
      return socket.emit('error_msg', 'Message blocked. 60 second language cooldown started.');
    }
    let attachment = null;
    try { attachment = cleanAttachment(data.attachment); } catch (err) { return socket.emit('error_msg', err.message); }
    const mentions = extractMentions(content);
    const message = {
      id: uuid(),
      roomId: room.id,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      picture: user.picture || '',
      role: roleOf(user),
      content,
      attachment,
      reactions: {},
      mentions,
      timestamp: Date.now(),
    };
    db.messages.push(message);
    db.messages = db.messages.slice(-5000);
    saveSoon();
    io.to(room.id).emit('new_message', message);
    mentions.forEach(id => emitToUser(id, 'notify', { type: 'mention', roomId: room.id, from: user.username, content }));
  });

  socket.on('react_message', data => {
    const message = db.messages.find(item => item.id === data.messageId);
    if (!message) return;
    const emoji = String(data.emoji || '').slice(0, 8);
    if (!emoji) return;
    message.reactions[emoji] = message.reactions[emoji] || [];
    if (message.reactions[emoji].includes(user.id)) {
      message.reactions[emoji] = message.reactions[emoji].filter(id => id !== user.id);
    } else {
      message.reactions[emoji].push(user.id);
    }
    saveSoon();
    io.to(message.roomId).emit('message_reactions', { messageId: message.id, reactions: message.reactions });
  });

  socket.on('delete_message', data => {
    const message = db.messages.find(item => item.id === data.messageId);
    if (!message || (!isMod(user) && message.userId !== user.id)) return;
    db.messages = db.messages.filter(item => item.id !== message.id);
    saveSoon();
    io.to(message.roomId).emit('message_deleted', { messageId: message.id });
  });

  socket.on('join_dm', dmId => {
    const thread = db.dmThreads.find(item => item.id === dmId && item.members.includes(user.id));
    if (!thread) return socket.emit('error_msg', 'DM not found');
    socket.join('dm_' + dmId);
    onlineUsers.get(socket.id).dmId = dmId;
    socket.emit('dm_history', { dmId, messages: thread.messages.slice(-120) });
  });

  socket.on('send_dm', data => {
    const thread = db.dmThreads.find(item => item.id === data.dmId && item.members.includes(user.id));
    const content = String(data.content || '').trim().slice(0, 1000);
    if (!thread || !content) return;
    const message = { id: uuid(), dmId: thread.id, userId: user.id, username: user.username, picture: user.picture || '', content, timestamp: Date.now() };
    thread.messages.push(message);
    thread.messages = thread.messages.slice(-500);
    saveSoon();
    io.to('dm_' + thread.id).emit('new_dm', message);
    thread.members.filter(id => id !== user.id).forEach(id => emitToUser(id, 'notify', { type: 'dm', dmId: thread.id, from: user.username, content }));
  });

  socket.on('typing', data => socket.to(data.roomId).emit('user_typing', { username: user.username, typing: !!data.typing }));

  socket.on('call_join', data => {
    const callId = String(data.callId || 'general-voice');
    if (!callRooms.has(callId)) callRooms.set(callId, new Set());
    const peers = Array.from(callRooms.get(callId)).map(peerId => {
      const peerUser = getUser(onlineUsers.get(peerId)?.userId);
      return { peerId, username: peerUser?.username || 'User', avatar: peerUser?.avatar || '?', picture: peerUser?.picture || '' };
    });
    callRooms.get(callId).add(socket.id);
    socket.join('call_' + callId);
    socket.to('call_' + callId).emit('call_peer_joined', { peerId: socket.id, username: user.username, avatar: user.avatar, picture: user.picture || '' });
    socket.emit('call_existing_peers', { peers, callId });
  });
  socket.on('call_offer', data => io.to(data.to).emit('call_offer', { from: socket.id, offer: data.offer, username: user.username, avatar: user.avatar, picture: user.picture || '' }));
  socket.on('call_answer', data => io.to(data.to).emit('call_answer', { from: socket.id, answer: data.answer }));
  socket.on('call_ice', data => io.to(data.to).emit('call_ice', { from: socket.id, candidate: data.candidate }));
  socket.on('call_leave', data => leaveCall(socket, data.callId));

  socket.on('game_create', data => {
    const game = createGame(data.type, user);
    db.games.push(game);
    db.games = db.games.slice(-100);
    saveSoon();
    socket.join('game_' + game.id);
    socket.emit('game_created', game);
  });
  socket.on('game_join', data => {
    const game = db.games.find(item => item.id === String(data.gameId || '').toUpperCase());
    if (!game) return socket.emit('game_error', 'Game not found');
    if (!game.players.some(player => player.id === user.id) && game.players.length < 2) game.players.push({ id: user.id, username: user.username });
    if (game.players.length >= 2) game.status = 'playing';
    socket.join('game_' + game.id);
    saveSoon();
    io.to('game_' + game.id).emit('game_updated', game);
  });
  socket.on('game_move', data => {
    const game = db.games.find(item => item.id === data.gameId);
    if (!game) return;
    const error = applyMove(game, data.move, user.id);
    if (error) return socket.emit('game_error', error);
    saveSoon();
    io.to('game_' + game.id).emit('game_updated', game);
  });

  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    if (info?.roomId) io.to(info.roomId).emit('room_members', roomMembers(info.roomId).filter(member => member.id !== user.id));
    callRooms.forEach((_, callId) => leaveCall(socket, callId));
    onlineUsers.delete(socket.id);
    io.emit('presence', onlineSafeUsers());
    io.emit('online_count', onlineUsers.size);
  });
});

function leaveCall(socket, callId) {
  const set = callRooms.get(callId);
  if (!set) return;
  set.delete(socket.id);
  socket.leave('call_' + callId);
  socket.to('call_' + callId).emit('call_peer_left', { peerId: socket.id });
  if (!set.size) callRooms.delete(callId);
}

function createGame(type, user) {
  const id = uuid().slice(0, 6).toUpperCase();
  const base = { id, type, players: [{ id: user.id, username: user.username }], status: 'waiting', turn: 0, winner: null, createdAt: Date.now() };
  if (type === 'connect4') return { ...base, board: Array(42).fill(null) };
  if (type === 'rps') return { ...base, choices: {} };
  if (type === 'memory') return { ...base, board: [...Array(8).keys(), ...Array(8).keys()].sort(() => Math.random() - 0.5), flipped: [], matched: [], scores: [0, 0] };
  if (type === 'trivia') return { ...base, question: triviaQuestion(), answers: {}, scores: [0, 0] };
  if (type === 'checkers') return { ...base, board: makeCheckers() };
  return { ...base, type: 'tictactoe', board: Array(9).fill(null) };
}

function applyMove(game, move, userId) {
  const player = game.players.findIndex(item => item.id === userId);
  if (player < 0) return 'Not a player';
  if (game.status !== 'playing') return 'Waiting for players';
  if (game.type !== 'rps' && game.type !== 'trivia' && game.turn % 2 !== player) return 'Not your turn';
  if (game.type === 'connect4') return moveConnect4(game, move, player);
  if (game.type === 'rps') return moveRps(game, move, userId);
  if (game.type === 'memory') return moveMemory(game, move, player);
  if (game.type === 'trivia') return moveTrivia(game, move, player, userId);
  if (game.type === 'checkers') return moveCheckers(game, move, player);
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
  if (col < 0 || col > 6) return 'Bad column';
  let row = -1;
  for (let r = 5; r >= 0; r--) if (game.board[r * 7 + col] === null) { row = r; break; }
  if (row < 0) return 'Column full';
  game.board[row * 7 + col] = player;
  game.turn += 1;
  if (winC4(game.board, row, col, player)) { game.winner = player; game.status = 'ended'; }
  else if (game.turn >= 42) { game.winner = 'draw'; game.status = 'ended'; }
  return null;
}

function moveRps(game, move, userId) {
  const choice = String(move.choice || '');
  if (!['rock', 'paper', 'scissors'].includes(choice)) return 'Bad choice';
  game.choices[userId] = choice;
  if (Object.keys(game.choices).length === 2) {
    const a = game.choices[game.players[0].id];
    const b = game.choices[game.players[1].id];
    game.winner = a === b ? 'draw' : ((a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper')) ? 0 : 1;
    game.status = 'ended';
  }
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
    setTimeout(() => { game.flipped = []; io.to('game_' + game.id).emit('game_updated', game); saveSoon(); }, 800);
  }
  return null;
}

function moveTrivia(game, move, player, userId) {
  const answer = Number(move.answer);
  if (game.answers[userId] !== undefined) return 'Already answered';
  game.answers[userId] = answer;
  if (answer === game.question.correct) game.scores[player] += 1;
  if (Object.keys(game.answers).length === game.players.length) {
    game.round = (game.round || 0) + 1;
    if (game.round >= 5) {
      game.status = 'ended';
      game.winner = game.scores[0] === game.scores[1] ? 'draw' : game.scores[0] > game.scores[1] ? 0 : 1;
    } else {
      game.answers = {};
      game.question = triviaQuestion();
    }
  }
  return null;
}

function moveCheckers(game, move, player) {
  const from = Number(move.from);
  const to = Number(move.to);
  if (from < 0 || from > 63 || to < 0 || to > 63) return 'Bad move';
  const piece = game.board[from];
  if (piece !== player) return 'Not your piece';
  if (game.board[to] !== null) return 'Taken';
  const diff = to - from;
  const allowed = player === 0 ? [7, 9] : [-7, -9];
  const jump = player === 0 ? [14, 18] : [-14, -18];
  if (allowed.includes(diff)) {
    game.board[to] = piece;
    game.board[from] = null;
  } else if (jump.includes(diff)) {
    const mid = from + diff / 2;
    if (game.board[mid] === null || game.board[mid] === player) return 'No capture';
    game.board[to] = piece;
    game.board[from] = null;
    game.board[mid] = null;
  } else return 'Bad move';
  game.turn += 1;
  const enemyLeft = game.board.some(value => value !== null && value !== player);
  if (!enemyLeft) { game.winner = player; game.status = 'ended'; }
  return null;
}

function triviaQuestion() {
  const questions = [
    { text: 'Which planet is called the Red Planet?', options: ['Mars', 'Venus', 'Jupiter', 'Saturn'], correct: 0 },
    { text: 'What does CPU stand for?', options: ['Central Processing Unit', 'Core Power Utility', 'Computer Personal Unit', 'Control Program Unit'], correct: 0 },
    { text: 'How many squares are on a chess board?', options: ['32', '48', '64', '81'], correct: 2 },
    { text: 'Which language runs in the browser?', options: ['JavaScript', 'SQL', 'Cobalt', 'Bash'], correct: 0 },
    { text: 'What color do you get from red + blue?', options: ['Green', 'Purple', 'Orange', 'Yellow'], correct: 1 },
  ];
  return questions[Math.floor(Math.random() * questions.length)];
}

function makeCheckers() {
  const board = Array(64).fill(null);
  for (let i = 0; i < 24; i++) {
    const row = Math.floor(i / 8), col = i % 8;
    if ((row + col) % 2 === 1) board[i] = 0;
  }
  for (let i = 40; i < 64; i++) {
    const row = Math.floor(i / 8), col = i % 8;
    if ((row + col) % 2 === 1) board[i] = 1;
  }
  return board;
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

server.listen(process.env.PORT || 3000, () => console.log('Nexus Mega running'));
