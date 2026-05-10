let socket = null, currentUser = null, currentRoom = null;
let currentCallId = null, localStream = null, screenStream = null;
let peerConnections = {}, peerUsernames = {};
let micEnabled = true, camEnabled = false, screenSharing = false;
let currentGame = null, chessSelected = null;
const typingTimers = {};
const SWEAR_WORDS = ['fuck','shit','bitch','cunt','dick','pussy','bastard','cock','whore','slut'];
let swearCooldownUntil = 0;

const ICE = [
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'],username:'openrelayproject',credential:'openrelayproject'}
];

async function apiCall(path, body) {
  const r = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
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
  const res = await apiCall('/api/auth/login', {email, password});
  if (res.error) return showError(res.error);
  login(res.token, res.user);
});

document.getElementById('btn-register').addEventListener('click', async () => {
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !email || !password) return showError('Fill in all fields');
  if (password.length < 6) return showError('Password must be at least 6 characters');
  const res = await apiCall('/api/auth/register', {username, email, password});
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
  const res = await apiCall('/api/auth/anonymous', {username});
  if (res.error) return showError(res.error);
  login(res.token, res.user);
});

window.handleGoogleSignIn = async (response) => {
  try {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    const res = await apiCall('/api/auth/google', {googleId:payload.sub,email:payload.email,name:payload.name,picture:payload.picture});
    if (res.error) return showError(res.error);
    login(res.token, res.user);
  } catch(e) { showError('Google sign-in failed'); }
};

document.getElementById('btn-google').addEventListener('click', () => {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.prompt();
  } else {
    showError('Google Sign-In not configured. Add your Client ID to index.html');
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
  } else {
    av.textContent = (currentUser.avatar || currentUser.username[0]).toUpperCase();
  }
  socket = io({auth:{token:token}, transports:['polling','websocket']});
  setupSocket();
  loadRooms();
}

window.addEventListener('load', () => {
  const token = localStorage.getItem('nexus_token');
  const user = localStorage.getItem('nexus_user');
  if (token && user) {
    try { currentUser = JSON.parse(user); startApp(); }
    catch(e) { localStorage.removeItem('nexus_token'); localStorage.removeItem('nexus_user'); }
  }
});

// Server nav buttons
document.getElementById('srv-chat').addEventListener('click', () => {
  document.getElementById('srv-chat').classList.add('active');
  document.getElementById('srv-games').classList.remove('active');
  showView('chat');
});
document.getElementById('srv-games').addEventListener('click', () => {
  document.getElementById('srv-games').classList.add('active');
  document.getElementById('srv-chat').classList.remove('active');
  showView('games');
});

function showView(name) {
  document.querySelectorAll('.dc-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

async function loadRooms() {
  const rooms = await fetch('/api/rooms').then(r => r.json());
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(room => {
    const el = document.createElement('div');
    el.className = 'dc-channel-item';
    el.dataset.id = room.id;
    el.innerHTML = '<span class="dc-ch-hash">#</span><span>' + room.name + '</span>';
    el.addEventListener('click', () => joinRoom(room.id, room.name));
    list.appendChild(el);
  });
  // Auto-join general
  joinRoom('general', 'general');
}

function joinRoom(roomId, name) {
  currentRoom = roomId;
  document.querySelectorAll('.dc-channel-item').forEach(r => r.classList.toggle('active', r.dataset.id === roomId));
  document.getElementById('current-room-name').textContent = name;
  document.getElementById('message-input').disabled = false;
  document.getElementById('message-input').placeholder = 'Message #' + name;
  document.getElementById('btn-send').disabled = false;
  document.getElementById('messages-area').innerHTML = '';
  socket.emit('join_room', roomId);
  showView('chat');
  document.getElementById('srv-chat').classList.add('active');
  document.getElementById('srv-games').classList.remove('active');
}

function setupSocket() {
  socket.on('connect', () => console.log('Connected!'));
  socket.on('connect_error', err => console.log('Error:', err.message));
  socket.on('online_count', n => {
    document.getElementById('online-count').textContent = n;
    const el2 = document.getElementById('online-count-2');
    if (el2) el2.textContent = n;
  });
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
  socket.on('user_joined', data => appendSystemMsg(data.username + ' joined'));
  socket.on('user_left', data => appendSystemMsg(data.username + ' left'));
  socket.on('room_members', members => {
    document.getElementById('room-member-count').textContent = members.length + ' members';
    renderMembers(members);
  });
  socket.on('user_typing', data => {
    const el = document.getElementById('typing-indicator');
    if (data.typing) { el.textContent = data.username + ' is typing…'; el.style.display = 'block'; el.style.color = ''; }
    else { el.style.display = 'none'; }
  });
  socket.on('message_deleted', data => { const el = document.getElementById('msg-' + data.messageId); if (el) el.remove(); });
  socket.on('room_cleared', () => { document.getElementById('messages-area').innerHTML = ''; });
  socket.on('error_msg', msg => { showTypingMsg(msg, '#f23f43'); });
  socket.on('force_logout', data => { alert(data.reason); localStorage.clear(); location.reload(); });
  socket.on('call_existing_peers', data => { data.peers.forEach(peerId => initiateCallToPeer(peerId)); });
  socket.on('call_peer_joined', data => { peerUsernames[data.peerId] = data.username; });
  socket.on('call_offer', async data => { peerUsernames[data.from] = data.username; await handleOffer(data.from, data.offer); });
  socket.on('call_answer', async data => { await handleAnswer(data.from, data.answer); });
  socket.on('call_ice', async data => { await handleIce(data.from, data.candidate); });
  socket.on('call_peer_left', data => { removePeer(data.peerId); });
  socket.on('game_created', data => renderGame(data.game));
  socket.on('game_updated', game => renderGame(game));
  socket.on('game_error', err => alert('Game: ' + err));
}

function renderMembers(members) {
  const list = document.getElementById('members-list');
  if (!list) return;
  list.innerHTML = '';
  members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'dc-member-item';
    const av = m.picture ? 'background-image:url(' + m.picture + ');background-size:cover;' : '';
    div.innerHTML = '<div class="dc-member-avatar" style="' + av + '">' + (m.picture ? '' : (m.avatar || m.username[0]).toUpperCase()) + '</div><span class="dc-member-name ' + (m.role || '') + '">' + escHtml(m.username) + (m.role === 'admin' ? ' 👑' : m.role === 'moderator' ? ' 🛡' : '') + '</span>';
    list.appendChild(div);
  });
}

function appendMessage(msg) {
  const area = document.getElementById('messages-area');
  const welcome = area.querySelector('.dc-welcome');
  if (welcome) welcome.remove();
  const isMe = msg.userId === currentUser.id;
  const div = document.createElement('div');
  div.className = 'dc-msg';
  div.id = 'msg-' + msg.id;
  const badge = msg.role === 'admin' ? '<span class="msg-badge admin">ADMIN</span>' : msg.role === 'moderator' ? '<span class="msg-badge mod">MOD</span>' : '';
  div.innerHTML = '<div class="dc-msg-avatar">' + (msg.avatar || msg.username[0]).toUpperCase() + '</div><div class="dc-msg-body"><div class="dc-msg-meta"><span class="dc-msg-name' + (isMe ? ' is-me' : '') + '">' + escHtml(msg.username) + '</span>' + badge + '<span class="dc-msg-time">' + formatTime(msg.timestamp) + '</span></div><div class="dc-msg-text">' + escHtml(msg.content) + '</div></div>';
  area.appendChild(div);
}

function appendSystemMsg(text) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('div');
  div.className = 'dc-msg-divider'; div.textContent = text;
  area.appendChild(div); area.scrollTop = area.scrollHeight;
}

function showTypingMsg(msg, color) {
  const el = document.getElementById('typing-indicator');
  el.style.display = 'block';
  el.style.color = color || '';
  el.textContent = msg;
  if (color) setTimeout(() => { el.style.display = 'none'; el.style.color = ''; }, 4000);
}

document.getElementById('message-input').addEventListener('input', () => {
  if (!currentRoom) return;
  socket.emit('typing', {roomId:currentRoom,typing:true});
  clearTimeout(typingTimers[currentRoom]);
  typingTimers[currentRoom] = setTimeout(() => socket.emit('typing', {roomId:currentRoom,typing:false}), 1500);
});

document.getElementById('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('btn-send').addEventListener('click', sendMsg);

function containsSwear(text) {
  return SWEAR_WORDS.some(w => new RegExp('\\b' + w + '\\b', 'i').test(text));
}

function sendMsg() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentRoom) return;

  // Secret admin command - check exact match silently
  if (content === 'Hombatomba12@') {
    input.value = '';
    window.open('/admin.html', '_blank');
    return;
  }

  // Swear cooldown
  if (currentUser.role !== 'admin' && currentUser.role !== 'moderator') {
    const now = Date.now();
    if (now < swearCooldownUntil) {
      const secs = Math.ceil((swearCooldownUntil - now) / 1000);
      startCooldownDisplay(secs);
      input.value = '';
      return;
    }
    if (containsSwear(content)) {
      swearCooldownUntil = Date.now() + 60000;
      startCooldownDisplay(60);
      input.value = '';
      return;
    }
  }

  socket.emit('send_message', {roomId:currentRoom, content:content});
  input.value = '';
  socket.emit('typing', {roomId:currentRoom,typing:false});
}

let cooldownInterval = null;
function startCooldownDisplay(secs) {
  clearInterval(cooldownInterval);
  showTypingMsg('You used a swear word. Cooldown: ' + secs + 's', '#f23f43');
  cooldownInterval = setInterval(() => {
    const remaining = Math.ceil((swearCooldownUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(cooldownInterval);
      document.getElementById('typing-indicator').style.display = 'none';
    } else {
      showTypingMsg('Cooldown: ' + remaining + ' seconds remaining', '#f23f43');
    }
  }, 1000);
}

/* ── VOICE CALL ── */
document.getElementById('btn-join-vc').addEventListener('click', () => {
  if (currentCallId) {
    leaveCall();
  } else {
    startOrJoinCall(null);
  }
});

async function startOrJoinCall(callId) {
  if (currentCallId) return;
  try { localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:false}); }
  catch(e) { alert('Could not access microphone. Please allow microphone access.'); return; }
  currentCallId = callId || Math.random().toString(36).slice(2,8).toUpperCase();
  document.getElementById('current-call-id').textContent = currentCallId;
  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('local-label').textContent = currentUser.username + ' (You)';
  document.getElementById('call-area').style.display = 'flex';
  document.getElementById('btn-join-vc').textContent = 'Leave';
  document.getElementById('btn-join-vc').classList.add('leave');
  socket.emit('call_join', {callId:currentCallId});
}

function leaveCall() {
  if (!currentCallId) return;
  socket.emit('call_leave', {callId:currentCallId});
  Object.keys(peerConnections).forEach(removePeer);
  peerConnections = {}; peerUsernames = {};
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  document.getElementById('local-video').srcObject = null;
  document.getElementById('call-area').style.display = 'none';
  document.getElementById('video-grid').querySelectorAll('.remote-tile').forEach(t => t.remove());
  document.getElementById('btn-join-vc').textContent = 'Join';
  document.getElementById('btn-join-vc').classList.remove('leave');
  document.getElementById('btn-share-screen').classList.remove('screensharing');
  screenSharing = false;
  currentCallId = null;
}

document.getElementById('btn-leave-call').addEventListener('click', leaveCall);

document.getElementById('btn-copy-call-id').addEventListener('click', () => {
  navigator.clipboard.writeText(currentCallId);
  document.getElementById('btn-copy-call-id').textContent = 'Copied!';
  setTimeout(() => document.getElementById('btn-copy-call-id').textContent = 'Copy ID', 2000);
});

document.getElementById('btn-toggle-mic').addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('btn-toggle-mic');
  btn.textContent = micEnabled ? '🎤' : '🔇';
  btn.classList.toggle('muted', !micEnabled);
  btn.classList.toggle('active', micEnabled);
});

document.getElementById('btn-toggle-cam').addEventListener('click', async () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  if (camEnabled) {
    try {
      const vs = await navigator.mediaDevices.getUserMedia({video:true});
      vs.getVideoTracks().forEach(t => {
        localStream.addTrack(t);
        Object.values(peerConnections).forEach(pc => pc.addTrack(t, localStream));
      });
    } catch(e) { camEnabled = false; return; }
  } else {
    localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
  }
  document.getElementById('btn-toggle-cam').classList.toggle('active', camEnabled);
});

document.getElementById('btn-share-screen').addEventListener('click', async () => {
  if (!currentCallId) { alert('Join a call first!'); return; }
  if (screenSharing) {
    // Stop screen share
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    screenSharing = false;
    document.getElementById('btn-share-screen').classList.remove('screensharing');
    // Remove screen track from peers and restore
    Object.values(peerConnections).forEach(pc => {
      pc.getSenders().forEach(sender => {
        if (sender.track && sender.track.kind === 'video') pc.removeTrack(sender);
      });
    });
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
    screenSharing = true;
    document.getElementById('btn-share-screen').classList.add('screensharing');
    const screenTrack = screenStream.getVideoTracks()[0];
    // Replace video track in all peer connections
    Object.values(peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) { sender.replaceTrack(screenTrack); }
      else { pc.addTrack(screenTrack, screenStream); }
    });
    // Show locally
    document.getElementById('local-video').srcObject = screenStream;
    screenTrack.onended = () => {
      screenSharing = false;
      document.getElementById('btn-share-screen').classList.remove('screensharing');
      document.getElementById('local-video').srcObject = localStream;
      if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    };
  } catch(e) { console.log('Screen share cancelled or failed'); }
});

function createPC(peerId) {
  if (peerConnections[peerId]) { peerConnections[peerId].close(); delete peerConnections[peerId]; }
  const pc = new RTCPeerConnection({iceServers:ICE});
  peerConnections[peerId] = pc;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('call_ice', {to:peerId,candidate:e.candidate}); };
  pc.ontrack = e => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    addRemoteVideo(peerId, stream, peerUsernames[peerId] || 'User');
  };
  return pc;
}

async function initiateCallToPeer(peerId) {
  const pc = createPC(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call_offer', {to:peerId, offer:pc.localDescription});
}

async function handleOffer(from, offer) {
  const pc = createPC(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call_answer', {to:from, answer:pc.localDescription});
}

async function handleAnswer(from, answer) {
  const pc = peerConnections[from];
  if (pc && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleIce(from, candidate) {
  const pc = peerConnections[from];
  if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {} }
}

function addRemoteVideo(peerId, stream, username) {
  let tile = document.getElementById('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'dc-vtile remote-tile'; tile.id = 'tile-' + peerId;
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    const label = document.createElement('div');
    label.className = 'dc-vlabel'; label.textContent = username;
    tile.appendChild(video); tile.appendChild(label);
    document.getElementById('video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.dc-vlabel').textContent = username;
}

function removePeer(peerId) {
  if (peerConnections[peerId]) { peerConnections[peerId].close(); delete peerConnections[peerId]; }
  delete peerUsernames[peerId];
  const t = document.getElementById('tile-' + peerId);
  if (t) t.remove();
}

/* ── GAMES ── */
document.querySelectorAll('.game-create-btn').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('game_create', {type:btn.dataset.type}));
});
document.getElementById('btn-join-game').addEventListener('click', () => {
  const id = document.getElementById('join-game-id').value.trim().toUpperCase();
  if (id) socket.emit('game_join', {gameId:id});
});

function renderGame(game) {
  currentGame = game;
  document.getElementById('games-lobby').style.display = 'none';
  showView('games');
  document.getElementById('srv-games').classList.add('active');
  document.getElementById('srv-chat').classList.remove('active');
  const area = document.getElementById('game-area');
  area.style.display = 'flex';
  const myIdx = game.players.findIndex(p => p.id === currentUser.id);
  const isMyTurn = game.status === 'playing' && game.turn % 2 === myIdx;
  let status = '';
  if (game.status === 'waiting') status = 'Waiting for opponent — Game ID: <strong>' + game.id + '</strong>';
  else if (game.status === 'ended') status = game.winner === 'draw' ? 'Draw!' : '<strong>' + (game.players[game.winner] ? game.players[game.winner].username : '?') + '</strong> wins!';
  else status = isMyTurn ? 'Your turn' : ((game.players[game.turn%2] ? game.players[game.turn%2].username : '') + "'s turn");
  const players = game.players.map(p => p.username).join(' vs ');
  let board = '';
  if (game.type === 'tictactoe') board = renderTTT(game, myIdx);
  else if (game.type === 'connect4') board = renderC4(game, myIdx);
  else if (game.type === 'chess') board = renderChess(game, myIdx);
  const rematch = game.status === 'ended' ? '<div style="text-align:center;margin-top:1rem"><button onclick="socket.emit(\'game_rematch\',{gameId:\'' + game.id + '\'})" class="btn-primary" style="width:auto;padding:10px 24px">Rematch</button></div>' : '';
  area.innerHTML = '<div class="game-header"><h3>' + (game.type==='chess'?'♟ Chess':game.type==='tictactoe'?'Tic-Tac-Toe':'Connect Four') + '</h3><span class="game-id-badge">ID: ' + game.id + '</span><button onclick="leaveGame()" class="btn-ghost sm">← Back</button></div><div class="game-status">' + status + '</div><div style="text-align:center;color:var(--text2);font-size:13px;margin-bottom:1rem">' + players + '</div>' + board + rematch;
  if (game.type === 'chess') attachChessListeners(game, myIdx);
}

function leaveGame() {
  document.getElementById('games-lobby').style.display = 'block';
  document.getElementById('game-area').style.display = 'none';
  currentGame = null; chessSelected = null;
}

function renderTTT(game, myIdx) {
  const S = ['X','O'], isMyTurn = game.status==='playing' && game.turn%2===myIdx;
  let h = '<div class="ttt-board">';
  for (let i=0;i<9;i++) {
    const v = game.board[i], c = v===null&&isMyTurn;
    h += '<div class="ttt-cell' + (v!==null?' taken p'+v:'') + '"' + (c?' onclick="socket.emit(\'game_move\',{gameId:\''+game.id+'\',move:{index:'+i+'}})"':'') + '>' + (v!==null?S[v]:'') + '</div>';
  }
  return h + '</div>';
}

function renderC4(game, myIdx) {
  const COLS=7,ROWS=6,isMyTurn=game.status==='playing'&&game.turn%2===myIdx;
  let h = '<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="display:grid;grid-template-columns:repeat(7,48px);gap:5px">';
  for (let c=0;c<COLS;c++) h += '<button class="c4-col-btn"' + (isMyTurn?' onclick="socket.emit(\'game_move\',{gameId:\''+game.id+'\',move:{col:'+c+'}})"':' disabled') + '>▼</button>';
  h += '</div><div class="c4-board">';
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) { const v=game.board[r*COLS+c]; h += '<div class="c4-cell' + (v!==null?' p'+v:'') + '"></div>'; }
  return h + '</div></div>';
}

function renderChess(game, myIdx) {
  const U={wK:'♔',wQ:'♕',wR:'♖',wB:'♗',wN:'♘',wP:'♙',bK:'♚',bQ:'♛',bR:'♜',bB:'♝',bN:'♞',bP:'♟'};
  let h = '<div class="chess-board" id="chess-board">';
  for (let i=0;i<64;i++) {
    const r=Math.floor(i/8),c=i%8,light=(r+c)%2===0,p=game.board[i],sel=chessSelected===i?' selected':'';
    h += '<div class="chess-sq '+(light?'light':'dark')+sel+'" data-idx="'+i+'">'+(p?U[p]||'':'')+'</div>';
  }
  return h + '</div>';
}

function attachChessListeners(game, myIdx) {
  const board = document.getElementById('chess-board');
  if (!board) return;
  board.addEventListener('click', e => {
    const sq = e.target.closest('.chess-sq'); if (!sq) return;
    const idx = parseInt(sq.dataset.idx);
    if (game.status!=='playing'||game.turn%2!==myIdx) return;
    if (chessSelected===null) {
      const p=game.board[idx],mc=myIdx===0?'w':'b';
      if (p&&p[0]===mc){chessSelected=idx;renderGame(game);}
    } else {
      if (idx!==chessSelected) socket.emit('game_move',{gameId:game.id,move:{from:chessSelected,to:idx}});
      chessSelected=null;
    }
  });
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
