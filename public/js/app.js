let socket = null;
let currentUser = null;
let currentRoom = null;
let currentCallId = null;
let localStream = null;
let peerConnections = {};
let peerUsernames = {};
let micEnabled = true;
let camEnabled = false;
let currentGame = null;
let chessSelected = null;
const typingTimers = {};

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' }
];

async function apiCall(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 4000);
}

document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return showError('Fill in all fields');
  const res = await apiCall('/api/auth/login', { email, password });
  if (res.error) return showError(res.error);
  login(res.token, res.user);
});

document.getElementById('btn-register').addEventListener('click', async () => {
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !email || !password) return showError('Fill in all fields');
  if (password.length < 6) return showError('Password must be at least 6 characters');
  const res = await apiCall('/api/auth/register', { username, email, password });
  if (res.error) return showError(res.error);
  login(res.token, res.user);
});

document.getElementById('btn-anon-toggle').addEventListener('click', () => {
  const f = document.getElementById('anon-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('btn-anon').addEventListener('click', async () => {
  const username = document.getElementById('anon-name').value.trim();
  if (!username) return showError('Please enter a display name');
  const res = await apiCall('/api/auth/anonymous', { username });
  if (res.error) return showError(res.error);
  login(res.token, res.user);
});

window.handleGoogleSignIn = async (response) => {
  try {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    const res = await apiCall('/api/auth/google', { googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture });
    if (res.error) return showError(res.error);
    login(res.token, res.user);
  } catch (e) { showError('Google sign-in failed'); }
};

document.getElementById('btn-google').addEventListener('click', () => {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.prompt();
  } else {
    showError('Google Sign-In not loaded. Check your Client ID in index.html');
  }
});

function login(token, user) {
  localStorage.setItem('nexus_token', token);
  localStorage.setItem('nexus_user', JSON.stringify(user));
  currentUser = user;
  startApp();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
  if (socket) socket.disconnect();
  location.reload();
});

function startApp() {
  const token = localStorage.getItem('nexus_token');
  if (!token) return;

  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('sidebar-name').textContent = currentUser.username;

  const av = document.getElementById('sidebar-avatar');
  if (currentUser.picture) {
    av.style.backgroundImage = 'url(' + currentUser.picture + ')';
    av.style.backgroundSize = 'cover';
    av.textContent = '';
  } else {
    av.textContent = currentUser.avatar || currentUser.username[0].toUpperCase();
  }

  // Admin panel via secret command only

  socket = io({
    auth: { token: token },
    transports: ['polling', 'websocket']
  });
  setupSocket();
  loadRooms();
}

window.addEventListener('load', () => {
  const token = localStorage.getItem('nexus_token');
  const user = localStorage.getItem('nexus_user');
  if (token && user) {
    try {
      currentUser = JSON.parse(user);
      startApp();
    } catch(e) {
      localStorage.removeItem('nexus_token');
      localStorage.removeItem('nexus_user');
    }
  }
});

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

async function loadRooms() {
  const rooms = await fetch('/api/rooms').then(r => r.json());
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(function(room) {
    const el = document.createElement('div');
    el.className = 'room-item';
    el.dataset.id = room.id;
    el.innerHTML = '<span class="room-item-icon">' + room.icon + '</span><div class="room-item-info"><div class="room-item-name">' + room.name + '</div><div class="room-item-count">' + room.memberCount + ' online</div></div>';
    el.addEventListener('click', function() { joinRoom(room.id, room.name, room.icon); });
    list.appendChild(el);
  });
}

function joinRoom(roomId, name, icon) {
  currentRoom = roomId;
  document.querySelectorAll('.room-item').forEach(r => r.classList.toggle('active', r.dataset.id === roomId));
  document.getElementById('current-room-name').textContent = name;
  document.getElementById('current-room-icon').textContent = icon;
  document.getElementById('message-input').disabled = false;
  document.getElementById('btn-send').disabled = false;
  document.getElementById('messages-area').innerHTML = '';
  socket.emit('join_room', roomId);
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'chat'));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-chat'));
}

function setupSocket() {
  socket.on('connect', function() { console.log('Socket connected!'); });
  socket.on('connect_error', function(err) { console.log('Socket error:', err.message); });
  socket.on('online_count', function(n) { document.getElementById('online-count').textContent = n; });
  socket.on('room_history', function(msgs) {
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    msgs.forEach(appendMessage);
    area.scrollTop = area.scrollHeight;
  });
  socket.on('new_message', function(msg) {
    appendMessage(msg);
    const area = document.getElementById('messages-area');
    area.scrollTop = area.scrollHeight;
  });
  socket.on('user_joined', function(data) { appendSystemMsg(data.username + ' joined'); });
  socket.on('user_left', function(data) { appendSystemMsg(data.username + ' left'); });
  socket.on('room_members', function(members) {
    document.getElementById('room-member-count').textContent = members.length + ' members';
  });
  socket.on('user_typing', function(data) {
    const el = document.getElementById('typing-indicator');
    if (data.typing) { el.textContent = data.username + ' is typing…'; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  });
  socket.on('message_deleted', function(data) {
    const el = document.getElementById('msg-' + data.messageId);
    if (el) el.remove();
  });
  socket.on('room_cleared', function() { document.getElementById('messages-area').innerHTML = ''; });
  socket.on('error_msg', function(msg) { alert(msg); });
  socket.on('force_logout', function(data) {
    alert(data.reason);
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_user');
    location.reload();
  });
  socket.on('call_existing_peers', function(data) {
    data.peers.forEach(function(peerId) { initiateCallToPeer(peerId); });
  });
  socket.on('call_peer_joined', function(data) { peerUsernames[data.peerId] = data.username; });
  socket.on('call_offer', async function(data) {
    peerUsernames[data.from] = data.username;
    await handleOffer(data.from, data.offer);
  });
  socket.on('call_answer', async function(data) { await handleAnswer(data.from, data.answer); });
  socket.on('call_ice', async function(data) { await handleIce(data.from, data.candidate); });
  socket.on('call_peer_left', function(data) { removePeer(data.peerId); });
  socket.on('game_created', function(data) { renderGame(data.game); });
  socket.on('game_updated', function(game) { renderGame(game); });
  socket.on('game_error', function(err) { alert('Game: ' + err); });
}

function appendMessage(msg) {
  const area = document.getElementById('messages-area');
  const splash = area.querySelector('.welcome-splash');
  if (splash) splash.remove();
  const isMe = msg.userId === currentUser.id;
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = 'msg-' + msg.id;
  const badge = msg.role === 'admin' ? '<span class="msg-badge admin">ADMIN</span>' : msg.role === 'moderator' ? '<span class="msg-badge mod">MOD</span>' : '';
  div.innerHTML = '<div class="msg-avatar">' + (msg.avatar || msg.username[0].toUpperCase()) + '</div><div class="msg-body"><div class="msg-meta"><span class="msg-name' + (isMe ? ' is-me' : '') + '">' + escHtml(msg.username) + '</span>' + badge + '<span class="msg-time">' + formatTime(msg.timestamp) + '</span></div><div class="msg-text">' + escHtml(msg.content) + '</div></div>';
  area.appendChild(div);
}

function appendSystemMsg(text) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('div');
  div.className = 'msg-divider';
  div.textContent = text;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

document.getElementById('message-input').addEventListener('input', function() {
  if (!currentRoom) return;
  socket.emit('typing', { roomId: currentRoom, typing: true });
  clearTimeout(typingTimers[currentRoom]);
  typingTimers[currentRoom] = setTimeout(function() { socket.emit('typing', { roomId: currentRoom, typing: false }); }, 1500);
});

document.getElementById('message-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('btn-send').addEventListener('click', sendMsg);

const SWEAR_WORDS = ['fuck','shit','ass','bitch','cunt','dick','pussy','bastard','damn','hell','cock','whore','slut'];
let swearCooldownUntil = 0;

function containsSwear(text) {
  const lower = text.toLowerCase();
  return SWEAR_WORDS.some(w => {
    const re = new RegExp('\\b' + w + '\\b', 'i');
    return re.test(lower);
  });
}

function sendMsg() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentRoom) return;

  // Secret admin command
  if (content === 'Hombatomba12@') {
    input.value = '';
    window.location.href = '/admin.html';
    return;
  }

  // Swear cooldown check (not for admins/mods)
  if (currentUser.role !== 'admin' && currentUser.role !== 'moderator') {
    const now = Date.now();
    if (now < swearCooldownUntil) {
      const secs = Math.ceil((swearCooldownUntil - now) / 1000);
      showCooldownMsg(secs);
      input.value = '';
      return;
    }
    if (containsSwear(content)) {
      swearCooldownUntil = now + 60000;
      showCooldownMsg(60);
      input.value = '';
      return;
    }
  }

  socket.emit('send_message', { roomId: currentRoom, content: content });
  input.value = '';
  socket.emit('typing', { roomId: currentRoom, typing: false });
}

function showCooldownMsg(secs) {
  const el = document.getElementById('typing-indicator');
  el.style.display = 'block';
  el.style.color = '#ef4444';
  el.textContent = 'You used a swear word. You cannot send messages for ' + secs + ' seconds.';
  const interval = setInterval(function() {
    const remaining = Math.ceil((swearCooldownUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      el.style.display = 'none';
      el.style.color = '';
      clearInterval(interval);
    } else {
      el.textContent = 'Cooldown: ' + remaining + ' seconds remaining.';
    }
  }, 1000);
}

document.getElementById('btn-start-call').addEventListener('click', function() {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'calls'));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-calls'));
});

document.getElementById('btn-join-call').addEventListener('click', function() {
  const id = document.getElementById('call-id-input').value.trim().toUpperCase() || null;
  startOrJoinCall(id);
});

async function startOrJoinCall(callId) {
  if (currentCallId) return;
  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch(e) { alert('Could not access microphone. Please allow microphone access.'); return; }
  currentCallId = callId || Math.random().toString(36).slice(2, 8).toUpperCase();
  document.getElementById('current-call-id').textContent = currentCallId;
  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('local-label').textContent = currentUser.username + ' (You)';
  document.getElementById('call-area').style.display = 'flex';
  document.getElementById('call-area').style.flexDirection = 'column';
  socket.emit('call_join', { callId: currentCallId });
}

function createPeerConnection(peerId) {
  if (peerConnections[peerId]) { peerConnections[peerId].close(); delete peerConnections[peerId]; }
  const pc = new RTCPeerConnection({ iceServers: ICE });
  peerConnections[peerId] = pc;
  if (localStream) localStream.getTracks().forEach(function(t) { pc.addTrack(t, localStream); });
  pc.onicecandidate = function(e) { if (e.candidate) socket.emit('call_ice', { to: peerId, candidate: e.candidate }); };
  pc.ontrack = function(e) {
    const stream = e.streams[0] || new MediaStream([e.track]);
    addRemoteVideo(peerId, stream, peerUsernames[peerId] || 'User');
  };
  return pc;
}

async function initiateCallToPeer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call_offer', { to: peerId, offer: pc.localDescription });
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call_answer', { to: from, answer: pc.localDescription });
}

async function handleAnswer(from, answer) {
  const pc = peerConnections[from];
  if (pc && pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
}

async function handleIce(from, candidate) {
  const pc = peerConnections[from];
  if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {} }
}

function addRemoteVideo(peerId, stream, username) {
  let tile = document.getElementById('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile remote-tile';
    tile.id = 'tile-' + peerId;
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = username;
    tile.appendChild(video); tile.appendChild(label);
    document.getElementById('video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.video-label').textContent = username;
}

function removePeer(peerId) {
  if (peerConnections[peerId]) { peerConnections[peerId].close(); delete peerConnections[peerId]; }
  delete peerUsernames[peerId];
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.remove();
}

document.getElementById('btn-leave-call').addEventListener('click', function() {
  if (!currentCallId) return;
  socket.emit('call_leave', { callId: currentCallId });
  Object.keys(peerConnections).forEach(removePeer);
  peerConnections = {}; peerUsernames = {};
  if (localStream) { localStream.getTracks().forEach(function(t) { t.stop(); }); localStream = null; }
  document.getElementById('local-video').srcObject = null;
  document.getElementById('call-area').style.display = 'none';
  document.getElementById('video-grid').querySelectorAll('.remote-tile').forEach(function(t) { t.remove(); });
  currentCallId = null;
});

document.getElementById('btn-copy-call-id').addEventListener('click', function() {
  navigator.clipboard.writeText(currentCallId);
  document.getElementById('btn-copy-call-id').textContent = 'Copied!';
  setTimeout(function() { document.getElementById('btn-copy-call-id').textContent = 'Copy ID'; }, 2000);
});

document.getElementById('btn-toggle-mic').addEventListener('click', function() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(function(t) { t.enabled = micEnabled; });
  document.getElementById('btn-toggle-mic').textContent = micEnabled ? '🎤' : '🔇';
});

document.getElementById('btn-toggle-cam').addEventListener('click', function() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(function(t) { t.enabled = camEnabled; });
});

document.querySelectorAll('.game-create-btn').forEach(function(btn) {
  btn.addEventListener('click', function() { socket.emit('game_create', { type: btn.dataset.type }); });
});

document.getElementById('btn-join-game').addEventListener('click', function() {
  const id = document.getElementById('join-game-id').value.trim().toUpperCase();
  if (!id) return;
  socket.emit('game_join', { gameId: id });
});

function renderGame(game) {
  currentGame = game;
  document.getElementById('games-lobby').style.display = 'none';
  const area = document.getElementById('game-area');
  area.style.display = 'flex';
  const players = game.players.map(function(p) { return p.username; }).join(' vs ');
  const myIdx = game.players.findIndex(function(p) { return p.id === currentUser.id; });
  const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
  let statusText = '';
  if (game.status === 'waiting') statusText = 'Waiting for opponent — Share game ID: <strong>' + game.id + '</strong>';
  else if (game.status === 'ended') {
    if (game.winner === 'draw') statusText = 'It is a draw!';
    else statusText = '<strong>' + (game.players[game.winner] ? game.players[game.winner].username : '?') + '</strong> wins!';
  } else statusText = isMyTurn ? 'Your turn' : (game.players[game.turn % 2] ? game.players[game.turn % 2].username : '') + "'s turn";

  let boardHtml = '';
  if (game.type === 'tictactoe') boardHtml = renderTTT(game, myIdx);
  if (game.type === 'connect4') boardHtml = renderC4(game, myIdx);
  if (game.type === 'chess') boardHtml = renderChess(game, myIdx);

  const rematch = game.status === 'ended' ? '<div style="text-align:center"><button onclick="socket.emit(\'game_rematch\',{gameId:\'' + game.id + '\'})" class="btn-primary" style="width:auto;padding:10px 24px">Rematch</button></div>' : '';
  const title = game.type === 'chess' ? 'Chess' : game.type === 'tictactoe' ? 'Tic-Tac-Toe' : 'Connect Four';

  area.innerHTML = '<div class="game-header"><h3>' + title + '</h3><span class="game-id-badge">ID: ' + game.id + '</span><button onclick="leaveGame()" class="btn-ghost sm">Back</button></div><div class="game-status">' + statusText + '</div><div style="text-align:center;color:var(--text2);font-size:13px">' + players + '</div>' + boardHtml + rematch;
  if (game.type === 'chess') attachChessListeners(game, myIdx);
}

function leaveGame() {
  document.getElementById('games-lobby').style.display = 'block';
  document.getElementById('game-area').style.display = 'none';
  currentGame = null; chessSelected = null;
}

function renderTTT(game, myIdx) {
  const symbols = ['X', 'O'];
  let html = '<div class="ttt-board">';
  for (let i = 0; i < 9; i++) {
    const val = game.board[i];
    const clickable = val === null && game.status === 'playing' && game.turn % 2 === myIdx;
    const cls = 'ttt-cell' + (val !== null ? ' taken p' + val : '');
    const click = clickable ? 'onclick="socket.emit(\'game_move\',{gameId:\'' + game.id + '\',move:{index:' + i + '}})"' : '';
    html += '<div class="' + cls + '" ' + click + '>' + (val !== null ? symbols[val] : '') + '</div>';
  }
  return html + '</div>';
}

function renderC4(game, myIdx) {
  const COLS = 7, ROWS = 6;
  const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
  let html = '<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="display:grid;grid-template-columns:repeat(7,48px);gap:5px">';
  for (let c = 0; c < COLS; c++) {
    const click = isMyTurn ? 'onclick="socket.emit(\'game_move\',{gameId:\'' + game.id + '\',move:{col:' + c + '}})"' : 'disabled';
    html += '<button class="c4-col-btn" ' + click + '>v</button>';
  }
  html += '</div><div class="c4-board">';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const val = game.board[r * COLS + c];
    html += '<div class="c4-cell' + (val !== null ? ' taken p' + val : '') + '"></div>';
  }
  return html + '</div></div>';
}

function renderChess(game, myIdx) {
  const P = { wK:'K',wQ:'Q',wR:'R',wB:'B',wN:'N',wP:'P', bK:'k',bQ:'q',bR:'r',bB:'b',bN:'n',bP:'p' };
  const U = { wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙', bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟' };
  let html = '<div class="chess-board" id="chess-board">';
  for (let i = 0; i < 64; i++) {
    const r = Math.floor(i/8), c = i % 8;
    const light = (r+c)%2===0;
    const piece = game.board[i];
    const sel = chessSelected === i ? ' selected' : '';
    html += '<div class="chess-sq ' + (light?'light':'dark') + sel + '" data-idx="' + i + '">' + (piece ? (U[piece]||piece) : '') + '</div>';
  }
  return html + '</div>';
}

function attachChessListeners(game, myIdx) {
  const board = document.getElementById('chess-board');
  if (!board) return;
  board.addEventListener('click', function(e) {
    const sq = e.target.closest('.chess-sq');
    if (!sq) return;
    const idx = parseInt(sq.dataset.idx);
    const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
    if (!isMyTurn) return;
    if (chessSelected === null) {
      const piece = game.board[idx];
      const myColor = myIdx === 0 ? 'w' : 'b';
      if (piece && piece[0] === myColor) { chessSelected = idx; renderGame(game); }
    } else {
      if (idx !== chessSelected) socket.emit('game_move', { gameId: game.id, move: { from: chessSelected, to: idx } });
      chessSelected = null;
    }
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
