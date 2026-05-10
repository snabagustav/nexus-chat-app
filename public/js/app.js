/* ── State ──────────────────────────────────────────────────────────────── */
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

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

/* ── Auth ────────────────────────────────────────────────────────────────── */
async function apiCall(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
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
    const parts = response.credential.split('.');
    const payload = JSON.parse(atob(parts[1]));
    const res = await apiCall('/api/auth/google', {
      googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture
    });
    if (res.error) return showError(res.error);
    login(res.token, res.user);
  } catch (e) { showError('Google sign-in failed'); }
};

document.getElementById('btn-google').addEventListener('click', () => {
  if (window.google?.accounts?.id) {
    google.accounts.id.prompt();
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

/* ── App Start ───────────────────────────────────────────────────────────── */
function startApp() {
  const token = localStorage.getItem('nexus_token');
  if (!token) return;

  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');

  document.getElementById('sidebar-name').textContent = currentUser.username;
  const av = document.getElementById('sidebar-avatar');
  if (currentUser.picture) {
    av.style.backgroundImage = `url(${currentUser.picture})`;
    av.style.backgroundSize = 'cover';
    av.textContent = '';
  } else {
    av.textContent = currentUser.avatar || currentUser.username[0].toUpperCase();
  }

  // Show admin link if admin/mod
  if (currentUser.role === 'admin' || currentUser.role === 'moderator') {
    const adminBtn = document.createElement('a');
    adminBtn.href = '/admin.html';
    adminBtn.style.cssText = 'display:block;padding:8px 10px;color:#7c6af7;font-size:13px;text-decoration:none;border-radius:8px;margin:2px 0;';
    adminBtn.textContent = '⚙️ Admin Panel';
    adminBtn.onmouseover = () => adminBtn.style.background = 'rgba(124,106,247,0.1)';
    adminBtn.onmouseout = () => adminBtn.style.background = 'transparent';
    document.querySelector('.sidebar-nav').appendChild(adminBtn);
  }

  const socketUrl = window.location.origin;
  socket = io(socketUrl, {
    auth: { token },
    transports: ['polling', 'websocket'],
    upgrade: true,
    rememberUpgrade: false,
    path: '/socket.io/',
  });
  setupSocket();
  loadRooms();
}

window.addEventListener('load', () => {
  const token = localStorage.getItem('nexus_token');
  const user = localStorage.getItem('nexus_user');
  if (token && user) {
    currentUser = JSON.parse(user);
    startApp();
  }
});

/* ── Navigation ──────────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

/* ── Rooms ───────────────────────────────────────────────────────────────── */
async function loadRooms() {
  const rooms = await fetch('/api/rooms').then(r => r.json());
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(room => {
    const el = document.createElement('div');
    el.className = 'room-item';
    el.dataset.id = room.id;
    el.innerHTML = `<span class="room-item-icon">${room.icon}</span><div class="room-item-info"><div class="room-item-name">${room.name}</div><div class="room-item-count">${room.memberCount} online</div></div>`;
    el.addEventListener('click', () => joinRoom(room.id, room.name, room.icon));
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

/* ── Socket ──────────────────────────────────────────────────────────────── */
function setupSocket() {
  socket.on('connect', () => console.log('Connected to server'));
  socket.on('online_count', n => document.getElementById('online-count').textContent = n);
  socket.on('room_history', msgs => {
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    msgs.forEach(appendMessage);
    area.scrollTop = area.scrollHeight;
  });
  socket.on('new_message', msg => {
    appendMessage(msg);
    const area = document.getElementById('messages-area');
    area.scrollTop = area.scrollHeight;
  });
  socket.on('user_joined', ({ username }) => appendSystemMsg(`${username} joined`));
  socket.on('user_left',   ({ username }) => appendSystemMsg(`${username} left`));
  socket.on('room_members', members => {
    document.getElementById('room-member-count').textContent = members.length + ' members';
  });
  socket.on('user_typing', ({ username, typing }) => {
    const el = document.getElementById('typing-indicator');
    if (typing) { el.textContent = `${username} is typing…`; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  });
  socket.on('message_deleted', ({ messageId }) => {
    document.getElementById('msg-' + messageId)?.remove();
  });
  socket.on('room_cleared', () => {
    document.getElementById('messages-area').innerHTML = '';
  });
  socket.on('error_msg', msg => alert(msg));
  socket.on('force_logout', ({ reason }) => {
    alert(reason);
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_user');
    location.reload();
  });

  // ── Call events ──────────────────────────────────────────────────────────
  socket.on('call_existing_peers', ({ peers }) => {
    console.log('Existing peers in call:', peers);
    peers.forEach(peerId => {
      console.log('Initiating call to existing peer:', peerId);
      initiateCallToPeer(peerId);
    });
  });

  socket.on('call_peer_joined', ({ peerId, username }) => {
    console.log('New peer joined:', peerId, username);
    peerUsernames[peerId] = username;
    // New peer joined — they will send us an offer, we just wait
  });

  socket.on('call_offer', async ({ from, offer, username }) => {
    console.log('Received offer from:', from, username);
    peerUsernames[from] = username;
    await handleOffer(from, offer);
  });

  socket.on('call_answer', async ({ from, answer }) => {
    console.log('Received answer from:', from);
    await handleAnswer(from, answer);
  });

  socket.on('call_ice', async ({ from, candidate }) => {
    await handleIce(from, candidate);
  });

  socket.on('call_peer_left', ({ peerId }) => {
    console.log('Peer left:', peerId);
    removePeer(peerId);
  });

  // Game events
  socket.on('game_created', ({ gameId, game }) => renderGame(game));
  socket.on('game_updated', game => renderGame(game));
  socket.on('game_error', err => alert('Game: ' + err));
}

/* ── Messages ────────────────────────────────────────────────────────────── */
function appendMessage(msg) {
  const area = document.getElementById('messages-area');
  const splash = area.querySelector('.welcome-splash');
  if (splash) splash.remove();
  const isMe = msg.userId === currentUser.id;
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = 'msg-' + msg.id;
  div.innerHTML = `
    <div class="msg-avatar">${msg.avatar || msg.username[0].toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name${isMe ? ' is-me' : ''}">${escHtml(msg.username)}</span>
        ${msg.role === 'admin' ? '<span class="msg-badge admin">ADMIN</span>' : msg.role === 'moderator' ? '<span class="msg-badge mod">MOD</span>' : ''}
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      </div>
      <div class="msg-text">${escHtml(msg.content)}</div>
    </div>`;
  area.appendChild(div);
}

function appendSystemMsg(text) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('div');
  div.className = 'msg-divider'; div.textContent = text;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

document.getElementById('message-input').addEventListener('input', () => {
  if (!currentRoom) return;
  socket.emit('typing', { roomId: currentRoom, typing: true });
  clearTimeout(typingTimers[currentRoom]);
  typingTimers[currentRoom] = setTimeout(() => socket.emit('typing', { roomId: currentRoom, typing: false }), 1500);
});

document.getElementById('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('btn-send').addEventListener('click', sendMsg);

function sendMsg() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentRoom) return;
  socket.emit('send_message', { roomId: currentRoom, content });
  input.value = '';
  socket.emit('typing', { roomId: currentRoom, typing: false });
}

/* ── WebRTC Calls ────────────────────────────────────────────────────────── */
document.getElementById('btn-start-call').addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'calls'));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-calls'));
});

document.getElementById('btn-join-call').addEventListener('click', () => {
  const id = document.getElementById('call-id-input').value.trim().toUpperCase() || null;
  startOrJoinCall(id);
});

async function getLocalStream() {
  // Try audio + video first, then audio only
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      alert('Could not access microphone. Please allow microphone access and try again.');
      return null;
    }
  }
}

async function startOrJoinCall(callId) {
  if (currentCallId) return;

  localStream = await getLocalStream();
  if (!localStream) return;

  currentCallId = callId || Math.random().toString(36).slice(2, 8).toUpperCase();
  document.getElementById('current-call-id').textContent = currentCallId;
  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('local-label').textContent = currentUser.username + ' (You)';
  document.getElementById('call-area').style.display = 'flex';
  document.getElementById('call-area').style.flexDirection = 'column';

  // Check mic/cam state
  const audioTracks = localStream.getAudioTracks();
  const videoTracks = localStream.getVideoTracks();
  micEnabled = audioTracks.length > 0;
  camEnabled = videoTracks.length > 0;
  document.getElementById('btn-toggle-mic').textContent = micEnabled ? '🎤' : '🔇';
  document.getElementById('btn-toggle-cam').classList.toggle('active', camEnabled);

  socket.emit('call_join', { callId: currentCallId });
}

function createPeerConnection(peerId) {
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
  }

  console.log('Creating peer connection for:', peerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 });
  peerConnections[peerId] = pc;

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      console.log('Adding track:', track.kind);
      pc.addTrack(track, localStream);
    });
  }

  // Send ICE candidates
  pc.onicecandidate = e => {
    if (e.candidate) {
      console.log('Sending ICE candidate to:', peerId);
      socket.emit('call_ice', { to: peerId, candidate: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('ICE state for', peerId, ':', pc.iceConnectionState);
    updatePeerStatus(peerId, pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state for', peerId, ':', pc.connectionState);
  };

  // Receive remote tracks
  pc.ontrack = e => {
    console.log('Received track from:', peerId, e.track.kind);
    const stream = e.streams[0] || new MediaStream([e.track]);
    addRemoteVideo(peerId, stream, peerUsernames[peerId] || 'User');
  };

  return pc;
}

async function initiateCallToPeer(peerId) {
  const pc = createPeerConnection(peerId);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    console.log('Sending offer to:', peerId);
    socket.emit('call_offer', { to: peerId, offer: pc.localDescription });
  } catch (e) {
    console.error('Error creating offer:', e);
  }
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('Sending answer to:', from);
    socket.emit('call_answer', { to: from, answer: pc.localDescription });
  } catch (e) {
    console.error('Error handling offer:', e);
  }
}

async function handleAnswer(from, answer) {
  const pc = peerConnections[from];
  if (!pc) return;
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (e) {
    console.error('Error handling answer:', e);
  }
}

async function handleIce(from, candidate) {
  const pc = peerConnections[from];
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Error adding ICE candidate:', e);
  }
}

function addRemoteVideo(peerId, stream, username) {
  let tile = document.getElementById('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile remote-tile';
    tile.id = 'tile-' + peerId;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'cover';
    const label = document.createElement('div');
    label.className = 'video-label';
    label.id = 'label-' + peerId;
    label.textContent = username || 'User';
    const status = document.createElement('div');
    status.className = 'video-status';
    status.id = 'status-' + peerId;
    status.style.cssText = 'position:absolute;top:6px;right:8px;font-size:11px;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:20px;color:#fcd34d;';
    status.textContent = 'Connecting…';
    tile.appendChild(video);
    tile.appendChild(label);
    tile.appendChild(status);
    document.getElementById('video-grid').appendChild(tile);
    tile.querySelector('video').srcObject = stream;
  } else {
    tile.querySelector('video').srcObject = stream;
    const label = document.getElementById('label-' + peerId);
    if (label) label.textContent = username || 'User';
  }
}

function updatePeerStatus(peerId, state) {
  const status = document.getElementById('status-' + peerId);
  if (!status) return;
  if (state === 'connected') { status.textContent = '🟢 Connected'; status.style.color = '#4ade80'; }
  else if (state === 'connecting' || state === 'checking') { status.textContent = '🟡 Connecting…'; status.style.color = '#fcd34d'; }
  else if (state === 'failed' || state === 'disconnected') { status.textContent = '🔴 Failed'; status.style.color = '#fca5a5'; }
  else if (state === 'closed') { status.textContent = '⚫ Closed'; }
}

function removePeer(peerId) {
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
  }
  delete peerUsernames[peerId];
  document.getElementById('tile-' + peerId)?.remove();
}

document.getElementById('btn-leave-call').addEventListener('click', leaveCall);

function leaveCall() {
  if (!currentCallId) return;
  socket.emit('call_leave', { callId: currentCallId });
  Object.keys(peerConnections).forEach(removePeer);
  peerConnections = {};
  peerUsernames = {};
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  document.getElementById('local-video').srcObject = null;
  document.getElementById('call-area').style.display = 'none';
  document.getElementById('video-grid').querySelectorAll('.remote-tile').forEach(t => t.remove());
  currentCallId = null;
}

document.getElementById('btn-copy-call-id').addEventListener('click', () => {
  navigator.clipboard.writeText(currentCallId);
  document.getElementById('btn-copy-call-id').textContent = 'Copied!';
  setTimeout(() => document.getElementById('btn-copy-call-id').textContent = 'Copy ID', 2000);
});

document.getElementById('btn-toggle-mic').addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  document.getElementById('btn-toggle-mic').textContent = micEnabled ? '🎤' : '🔇';
  document.getElementById('btn-toggle-mic').classList.toggle('muted', !micEnabled);
});

document.getElementById('btn-toggle-cam').addEventListener('click', async () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  document.getElementById('btn-toggle-cam').classList.toggle('active', camEnabled);
  document.getElementById('btn-toggle-cam').textContent = camEnabled ? '📷' : '📷';
});

/* ── Games ───────────────────────────────────────────────────────────────── */
document.querySelectorAll('.game-create-btn').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('game_create', { type: btn.dataset.type }));
});

document.getElementById('btn-join-game').addEventListener('click', () => {
  const id = document.getElementById('join-game-id').value.trim().toUpperCase();
  if (!id) return;
  socket.emit('game_join', { gameId: id });
});

function renderGame(game) {
  currentGame = game;
  document.getElementById('games-lobby').style.display = 'none';
  const area = document.getElementById('game-area');
  area.style.display = 'flex';
  const players = game.players.map(p => p.username).join(' vs ');
  const myIdx = game.players.findIndex(p => p.id === currentUser.id);
  const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
  let statusText = '';
  if (game.status === 'waiting') statusText = `⏳ Waiting for opponent — Share game ID: <strong>${game.id}</strong>`;
  else if (game.status === 'ended') {
    if (game.winner === 'draw') statusText = `🤝 It's a draw!`;
    else statusText = `🏆 <strong>${game.players[game.winner]?.username || '?'}</strong> wins!`;
  } else statusText = isMyTurn ? `Your turn` : `${game.players[game.turn % 2]?.username}'s turn`;

  let boardHtml = '';
  if (game.type === 'tictactoe') boardHtml = renderTTT(game, myIdx);
  if (game.type === 'connect4')  boardHtml = renderC4(game, myIdx);
  if (game.type === 'chess')     boardHtml = renderChess(game, myIdx);

  area.innerHTML = `
    <div class="game-header">
      <h3>${game.type === 'chess' ? '♟ Chess' : game.type === 'tictactoe' ? '⬜ Tic-Tac-Toe' : '🟡 Connect Four'}</h3>
      <span class="game-id-badge">ID: ${game.id}</span>
      <button onclick="leaveGame()" class="btn-ghost sm">← Back</button>
    </div>
    <div class="game-status">${statusText}</div>
    <div style="text-align:center;color:var(--text2);font-size:13px">${players}</div>
    ${boardHtml}
    ${game.status === 'ended' ? `<div style="text-align:center"><button onclick="socket.emit('game_rematch',{gameId:'${game.id}'})" class="btn-primary" style="width:auto;padding:10px 24px">Rematch</button></div>` : ''}
  `;
  if (game.type === 'chess') attachChessListeners(game, myIdx);
}

function leaveGame() {
  document.getElementById('games-lobby').style.display = 'block';
  document.getElementById('game-area').style.display = 'none';
  currentGame = null; chessSelected = null;
}

function renderTTT(game, myIdx) {
  const symbols = ['✕', '○'];
  let html = '<div class="ttt-board">';
  for (let i = 0; i < 9; i++) {
    const val = game.board[i];
    const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
    const clickable = val === null && isMyTurn;
    html += `<div class="ttt-cell${val !== null ? ' taken p' + val : ''}" ${clickable ? `onclick="socket.emit('game_move',{gameId:'${game.id}',move:{index:${i}}})"` : ''}>${val !== null ? symbols[val] : ''}</div>`;
  }
  return html + '</div>';
}

function renderC4(game, myIdx) {
  const COLS = 7, ROWS = 6;
  let html = '<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="display:grid;grid-template-columns:repeat(7,48px);gap:5px">';
  const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
  for (let c = 0; c < COLS; c++) html += `<button class="c4-col-btn" ${isMyTurn ? `onclick="socket.emit('game_move',{gameId:'${game.id}',move:{col:${c}}})"` : 'disabled'}>▼</button>`;
  html += '</div><div class="c4-board">';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const val = game.board[r * COLS + c];
    html += `<div class="c4-cell${val !== null ? ' taken p' + val : ''}"></div>`;
  }
  return html + '</div></div>';
}

function renderChess(game, myIdx) {
  const PIECES = { wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙', bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟' };
  let html = '<div class="chess-board" id="chess-board">';
  for (let i = 0; i < 64; i++) {
    const r = Math.floor(i/8), c = i%8;
    const light = (r+c)%2===0;
    const piece = game.board[i];
    const sel = chessSelected === i ? ' selected' : '';
    html += `<div class="chess-sq ${light?'light':'dark'}${sel}" data-idx="${i}">${piece ? PIECES[piece]||'' : ''}</div>`;
  }
  return html + '</div>';
}

function attachChessListeners(game, myIdx) {
  const board = document.getElementById('chess-board');
  if (!board) return;
  board.addEventListener('click', e => {
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
      if (idx === chessSelected) renderGame(game);
    }
  });
}

/* ── Utils ───────────────────────────────────────────────────────────────── */
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
