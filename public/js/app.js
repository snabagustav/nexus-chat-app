const $ = id => document.getElementById(id);

const els = {
  authScreen: $('auth-screen'),
  appScreen: $('app-screen'),
  authError: $('auth-error'),
  sidebarName: $('sidebar-name'),
  sidebarAvatar: $('sidebar-avatar'),
  roomList: $('room-list'),
  currentRoomTitle: $('current-room-title'),
  roomMemberCount: $('room-member-count'),
  messagesArea: $('messages-area'),
  membersList: $('members-list'),
  messageForm: $('message-form'),
  messageInput: $('message-input'),
  btnSend: $('btn-send'),
  typing: $('typing-indicator'),
  callArea: $('call-area'),
  videoGrid: $('video-grid'),
  localVideo: $('local-video'),
  btnJoinCall: $('btn-join-call'),
  gamesView: $('games-view'),
  chatView: $('chat-view'),
  gameArea: $('game-area'),
  gamesLobby: $('games-lobby'),
  callStatus: $('call-status'),
};

let token = localStorage.getItem('nexus_token') || '';
let currentUser = readJson(localStorage.getItem('nexus_user'));
let socket = null;
let rooms = [];
let currentRoomId = '';
let currentMessages = [];
let currentGame = null;
let typingTimer = null;

let localStream = null;
let screenStream = null;
let currentCallId = '';
let peers = {};
let micEnabled = true;
let camEnabled = false;
let deafened = false;

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

function readJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function setAuthError(message) {
  els.authError.textContent = message || '';
  els.authError.classList.toggle('hidden', !message);
}

function toast(message) {
  if (message) alert(message);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function saveSession(data) {
  token = data.token || token;
  currentUser = data.user || currentUser;
  localStorage.setItem('nexus_token', token);
  localStorage.setItem('nexus_user', JSON.stringify(currentUser));
}

function logout() {
  if (socket) socket.disconnect();
  token = '';
  currentUser = null;
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
  currentRoomId = '';
  showScreen(false);
}

function showScreen(loggedIn) {
  els.authScreen.classList.toggle('active', !loggedIn);
  els.appScreen.classList.toggle('active', loggedIn);
}

function applyTheme(theme) {
  const nextTheme = theme || localStorage.getItem('nexus_theme') || currentUser?.theme || 'midnight';
  document.body.dataset.theme = nextTheme;
  localStorage.setItem('nexus_theme', nextTheme);
  if (currentUser) {
    currentUser.theme = nextTheme;
    localStorage.setItem('nexus_user', JSON.stringify(currentUser));
    request('/api/user/theme', {
      method: 'POST',
      body: JSON.stringify({ theme: nextTheme }),
    }).catch(() => {});
  }
}

function updateUserUi() {
  if (!currentUser) return;
  els.sidebarName.textContent = currentUser.username || 'User';
  els.sidebarAvatar.textContent = currentUser.avatar || (currentUser.username || 'U')[0].toUpperCase();
  $('local-label').textContent = currentUser.username || 'You';
  applyTheme(currentUser.theme);
}

async function handleAuth(path, body) {
  setAuthError('');
  try {
    const data = await request(path, { method: 'POST', body: JSON.stringify(body) });
    saveSession(data);
    await startApp();
  } catch (err) {
    setAuthError(err.message);
  }
}

window.handleGoogleSignIn = async response => {
  try {
    let encoded = response.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    encoded += '='.repeat((4 - encoded.length % 4) % 4);
    const payload = JSON.parse(atob(encoded));
    await handleAuth('/api/auth/google', {
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
      googleId: payload.sub,
    });
  } catch {
    setAuthError('Google login failed');
  }
};

function bindAuth() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(item => item.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  $('btn-login').addEventListener('click', () => handleAuth('/api/auth/login', {
    email: $('login-email').value,
    password: $('login-password').value,
  }));

  $('btn-register').addEventListener('click', () => handleAuth('/api/auth/register', {
    username: $('reg-username').value,
    email: $('reg-email').value,
    password: $('reg-password').value,
  }));

  $('btn-anon-toggle').addEventListener('click', () => $('anon-form').classList.toggle('hidden'));
  $('btn-anon').addEventListener('click', () => handleAuth('/api/auth/anonymous', {
    username: $('anon-name').value,
  }));

  $('btn-google').addEventListener('click', () => {
    if (window.google?.accounts?.id) {
      google.accounts.id.prompt();
    } else {
      setAuthError('Google is still loading. Try again in a second.');
    }
  });
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({
    auth: { token },
    transports: ['polling'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: 20,
    timeout: 20000,
  });

  socket.on('connect_error', err => {
    if (/unauthorized/i.test(err.message || '')) {
      logout();
      setAuthError('Session expired after deploy. Log in again.');
      return;
    }
    toast(err.message || 'Connection failed');
  });
  socket.on('online_count', count => {
    if (!currentRoomId) els.roomMemberCount.textContent = `${count} online`;
  });
  socket.on('rooms_updated', loadRooms);
  socket.on('room_created', room => {
    loadRooms().then(() => joinRoom(room.id, room.name));
    if (room.private) copyText(room.id, `Private room ID: ${room.id}`);
  });
  socket.on('room_history', messages => {
    currentMessages = messages || [];
    renderMessages();
  });
  socket.on('new_message', message => {
    currentMessages.push(message);
    renderMessage(message);
    els.messagesArea.scrollTop = els.messagesArea.scrollHeight;
  });
  socket.on('message_deleted', data => {
    currentMessages = currentMessages.filter(message => message.id !== data.messageId);
    const node = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (node) node.remove();
  });
  socket.on('room_cleared', () => {
    currentMessages = [];
    renderMessages();
  });
  socket.on('room_members', renderMembers);
  socket.on('user_typing', data => {
    els.typing.textContent = data.typing ? `${data.username} is typing...` : '';
    els.typing.classList.toggle('hidden', !data.typing);
  });
  socket.on('error_msg', toast);
  socket.on('force_logout', data => {
    toast(data.reason || 'Logged out');
    logout();
  });

  socket.on('call_existing_peers', async data => {
    currentCallId = data.callId || currentCallId;
    for (const peer of data.peers || []) {
      const info = normalizePeer(peer);
      await createPeer(info.peerId, info, true);
    }
  });
  socket.on('call_peer_joined', data => {
    const info = normalizePeer(data);
    addRemoteTile(info.peerId, info);
    createPeer(info.peerId, info, false).catch(console.error);
  });
  socket.on('call_offer', async data => {
    const info = normalizePeer({ peerId: data.from, username: data.username, avatar: data.avatar });
    const pc = await createPeer(data.from, info, false);
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call_answer', { to: data.from, answer });
  });
  socket.on('call_answer', async data => {
    const pc = peers[data.from]?.pc;
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  });
  socket.on('call_ice', async data => {
    const pc = peers[data.from]?.pc;
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  });
  socket.on('call_peer_left', data => removePeer(data.peerId));

  socket.on('game_created', data => renderGame(data.game));
  socket.on('game_updated', renderGame);
  socket.on('game_error', toast);
}

function normalizePeer(peer) {
  if (typeof peer === 'string') return { peerId: peer, username: 'User', avatar: '?' };
  return {
    peerId: peer.peerId || peer.id,
    username: peer.username || 'User',
    avatar: peer.avatar || '?',
  };
}

async function loadRooms() {
  try {
    rooms = await request('/api/rooms');
    renderRooms();
  } catch (err) {
    toast(err.message);
  }
}

function renderRooms() {
  els.roomList.innerHTML = '';
  rooms.forEach(room => {
    const button = document.createElement('button');
    button.className = `room-btn ${room.id === currentRoomId ? 'active' : ''}`;
    button.textContent = `# ${room.name}`;
    button.addEventListener('click', () => joinRoom(room.id, room.name));
    els.roomList.appendChild(button);
  });
}

function joinRoom(roomId, roomName) {
  if (!socket || !roomId) return;
  currentRoomId = roomId;
  const room = rooms.find(item => item.id === roomId);
  els.currentRoomTitle.textContent = roomName || room?.name || roomId;
  els.roomMemberCount.textContent = 'Loading room...';
  els.messageInput.disabled = false;
  els.btnSend.disabled = false;
  els.messageInput.placeholder = `Message #${els.currentRoomTitle.textContent}`;
  socket.emit('join_room', roomId);
  renderRooms();
}

function renderMembers(members) {
  els.roomMemberCount.textContent = `${members.length} online in room`;
  els.membersList.innerHTML = '';
  members.forEach(member => {
    const row = document.createElement('div');
    row.className = 'member';
    row.innerHTML = `<div class="avatar">${escapeText(member.avatar || '?')}</div><div><b>${escapeText(member.username)}</b><br><small>${escapeText(member.role || 'user')}</small></div>`;
    els.membersList.appendChild(row);
  });
}

function renderMessages() {
  els.messagesArea.innerHTML = '';
  if (!currentMessages.length) {
    els.messagesArea.innerHTML = '<div class="empty-state"><div class="empty-icon">#</div><h2>No messages yet</h2><p>Start the room.</p></div>';
    return;
  }
  currentMessages.forEach(renderMessage);
  els.messagesArea.scrollTop = els.messagesArea.scrollHeight;
}

function renderMessage(message) {
  const empty = els.messagesArea.querySelector('.empty-state');
  if (empty) empty.remove();
  const row = document.createElement('article');
  row.className = 'message';
  row.dataset.messageId = message.id;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = message.avatar || '?';

  const body = document.createElement('div');
  const top = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = message.username || 'User';
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const content = document.createElement('div');
  content.textContent = message.content || '';
  top.append(name, time);
  body.append(top, content);

  row.append(avatar, body);
  if (currentUser && ['admin', 'moderator'].includes(currentUser.role)) {
    const del = document.createElement('button');
    del.className = 'delete-msg';
    del.textContent = 'Delete';
    del.addEventListener('click', () => socket.emit('mod_delete_message', {
      roomId: currentRoomId,
      messageId: message.id,
    }));
    row.appendChild(del);
  }
  els.messagesArea.appendChild(row);
}

function bindChat() {
  els.messageForm.addEventListener('submit', event => {
    event.preventDefault();
    const content = els.messageInput.value.trim();
    if (!content || !currentRoomId) return;
    socket.emit('send_message', { roomId: currentRoomId, content });
    els.messageInput.value = '';
    socket.emit('typing', { roomId: currentRoomId, typing: false });
  });

  els.messageInput.addEventListener('input', () => {
    if (!currentRoomId || !socket) return;
    socket.emit('typing', { roomId: currentRoomId, typing: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { roomId: currentRoomId, typing: false }), 900);
  });

  $('btn-new-room').addEventListener('click', () => $('room-modal').classList.remove('hidden'));
  $('btn-room-cancel').addEventListener('click', () => $('room-modal').classList.add('hidden'));
  $('btn-room-create').addEventListener('click', () => {
    const name = $('room-name').value.trim();
    if (!name) return;
    socket.emit('create_room', { name, private: $('room-private').checked });
    $('room-name').value = '';
    $('room-private').checked = false;
    $('room-modal').classList.add('hidden');
  });
  $('btn-join-private').addEventListener('click', () => {
    const id = $('private-room-id').value.trim();
    if (id) joinRoom(id, `Private ${id}`);
  });
}

async function startCall(callId = 'general') {
  if (currentCallId) return leaveCall();
  currentCallId = callId;
  els.callArea.classList.remove('hidden');
  document.body.classList.add('in-call');
  els.callStatus.textContent = 'Connecting...';
  els.btnJoinCall.innerHTML = '<span></span>Leave General Call';
  $('btn-toggle-cam').classList.add('off');
  $('btn-toggle-mic').classList.remove('off');
  $('btn-deafen').classList.remove('off');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    localStream = new MediaStream();
    toast('Microphone was blocked, but you can still join and listen.');
  }
  els.localVideo.srcObject = localStream;
  micEnabled = true;
  socket.emit('call_join', { callId });
  updateCallStatus();
}

function leaveCall() {
  Object.values(peers).forEach(peer => peer.pc.close());
  peers = {};
  document.querySelectorAll('.call-avatar-tile.remote').forEach(tile => tile.remove());
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  if (screenStream) screenStream.getTracks().forEach(track => track.stop());
  localStream = null;
  screenStream = null;
  socket.emit('call_leave', { callId: currentCallId });
  currentCallId = '';
  els.callArea.classList.add('hidden');
  document.body.classList.remove('in-call');
  els.btnJoinCall.innerHTML = '<span></span>Join General Call';
  $('btn-toggle-cam').classList.remove('active', 'off');
  $('btn-share-screen').classList.remove('active');
  $('btn-toggle-mic').classList.remove('off');
  $('btn-deafen').classList.remove('off');
}

async function createPeer(peerId, info, initiator) {
  if (peers[peerId]) return peers[peerId].pc;
  addRemoteTile(peerId, info);
  const pc = new RTCPeerConnection({ iceServers });
  peers[peerId] = { pc, stream: new MediaStream(), info };

  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  if (screenStream) screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

  pc.ontrack = event => {
    const remote = peers[peerId];
    if (!remote) return;
    event.streams[0].getTracks().forEach(track => remote.stream.addTrack(track));
    const video = $(`remote-video-${peerId}`);
    if (video) {
      video.srcObject = remote.stream;
      video.muted = deafened;
    }
  };
  pc.onicecandidate = event => {
    if (event.candidate) socket.emit('call_ice', { to: peerId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    const tile = $(`remote-tile-${peerId}`);
    if (tile) tile.classList.toggle('local', pc.connectionState === 'connected');
  };

  if (initiator) await sendOffer(peerId);
  return pc;
}

async function sendOffer(peerId) {
  const pc = peers[peerId]?.pc;
  if (!pc) return;
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  socket.emit('call_offer', { to: peerId, offer });
}

function addRemoteTile(peerId, info) {
  if ($(`remote-tile-${peerId}`)) return;
  const tile = document.createElement('div');
  tile.id = `remote-tile-${peerId}`;
  tile.className = 'call-avatar-tile remote';
  const video = document.createElement('video');
  video.id = `remote-video-${peerId}`;
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement('span');
  label.textContent = info.username || 'User';
  tile.title = info.username || 'User';
  tile.append(video, label);
  els.videoGrid.appendChild(tile);
  updateCallStatus();
}

function removePeer(peerId) {
  if (peers[peerId]) {
    peers[peerId].pc.close();
    delete peers[peerId];
  }
  const tile = $(`remote-tile-${peerId}`);
  if (tile) tile.remove();
  updateCallStatus();
}

function updateCallStatus() {
  if (!els.callStatus || !currentCallId) return;
  const count = Object.keys(peers).length + 1;
  els.callStatus.textContent = `${count} connected - voice channel`;
}

async function toggleCamera() {
  if (!currentCallId) return;
  const existing = localStream?.getVideoTracks()[0];
  if (existing) {
    existing.enabled = !existing.enabled;
    camEnabled = existing.enabled;
  } else {
    const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = cam.getVideoTracks()[0];
    localStream.addTrack(track);
    els.localVideo.srcObject = localStream;
    camEnabled = true;
    for (const peerId of Object.keys(peers)) {
      peers[peerId].pc.addTrack(track, localStream);
      await sendOffer(peerId);
    }
  }
  $('btn-toggle-cam').classList.toggle('active', camEnabled);
  $('btn-toggle-cam').classList.toggle('off', !camEnabled);
}

function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(track => { track.enabled = micEnabled; });
  $('btn-toggle-mic').classList.toggle('off', !micEnabled);
  $('btn-toggle-mic').title = micEnabled ? 'Mute' : 'Unmute';
}

function toggleDeafen() {
  deafened = !deafened;
  document.querySelectorAll('.call-avatar-tile.remote video').forEach(video => { video.muted = deafened; });
  $('btn-deafen').classList.toggle('off', deafened);
  $('btn-deafen').title = deafened ? 'Undeafen' : 'Deafen';
}

async function shareScreen() {
  if (!currentCallId) return;
  try {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
      $('btn-share-screen').classList.remove('active');
      return;
    }
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = screenStream.getVideoTracks()[0];
    els.localVideo.srcObject = screenStream;
    $('btn-share-screen').classList.add('active');
    track.onended = () => {
      screenStream = null;
      els.localVideo.srcObject = localStream;
      $('btn-share-screen').classList.remove('active');
    };
    for (const peerId of Object.keys(peers)) {
      peers[peerId].pc.addTrack(track, screenStream);
      await sendOffer(peerId);
    }
  } catch {}
}

function bindCall() {
  els.btnJoinCall.addEventListener('click', () => startCall('general'));
  $('btn-leave-call').addEventListener('click', leaveCall);
  $('btn-toggle-mic').addEventListener('click', toggleMic);
  $('btn-toggle-cam').addEventListener('click', () => toggleCamera().catch(() => toast('Camera blocked')));
  $('btn-deafen').addEventListener('click', toggleDeafen);
  $('btn-share-screen').addEventListener('click', shareScreen);
  $('btn-copy-call-id').addEventListener('click', () => copyText(location.href, 'Invite link copied'));
}

function renderGame(game) {
  currentGame = game;
  els.gameArea.classList.remove('hidden');
  els.gameArea.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'active-card';
  const status = game.status === 'waiting' ? 'Waiting for another player' : game.status === 'ended' ? winnerText(game) : `Turn: ${game.players[game.turn % 2]?.username || 'Player'}`;
  header.innerHTML = `<b>${escapeText(game.type.toUpperCase())}</b><p>ID: ${escapeText(game.id)} - ${escapeText(status)}</p>`;
  const copy = document.createElement('button');
  copy.className = 'btn primary';
  copy.textContent = 'Copy ID';
  copy.addEventListener('click', () => copyText(game.id, `Game ID copied: ${game.id}`));
  header.appendChild(copy);
  els.gameArea.appendChild(header);

  if (game.type === 'connect4') renderConnect4(game);
  else if (game.type === 'rps') renderRps(game);
  else if (game.type === 'memory') renderMemory(game);
  else renderTtt(game);
}

function winnerText(game) {
  if (game.winner === 'draw') return 'Draw';
  return `Winner: ${game.players[game.winner]?.username || 'Player'}`;
}

function renderTtt(game) {
  const board = document.createElement('div');
  board.className = 'ttt';
  game.board.forEach((value, index) => {
    const cell = document.createElement('button');
    cell.textContent = value === 0 ? 'X' : value === 1 ? 'O' : '';
    cell.addEventListener('click', () => socket.emit('game_move', { gameId: game.id, move: { index } }));
    board.appendChild(cell);
  });
  els.gameArea.appendChild(board);
}

function renderConnect4(game) {
  const board = document.createElement('div');
  board.className = 'c4';
  game.board.forEach((value, index) => {
    const cell = document.createElement('div');
    cell.className = value === 0 ? 'p0' : value === 1 ? 'p1' : '';
    cell.addEventListener('click', () => socket.emit('game_move', { gameId: game.id, move: { col: index % 7 } }));
    board.appendChild(cell);
  });
  els.gameArea.appendChild(board);
}

function renderRps(game) {
  const wrap = document.createElement('div');
  wrap.className = 'rps';
  ['rock', 'paper', 'scissors'].forEach(choice => {
    const button = document.createElement('button');
    button.textContent = choice;
    button.addEventListener('click', () => socket.emit('game_move', { gameId: game.id, move: { choice } }));
    wrap.appendChild(button);
  });
  els.gameArea.appendChild(wrap);
}

function renderMemory(game) {
  const wrap = document.createElement('div');
  wrap.className = 'memory';
  game.board.forEach((value, index) => {
    const button = document.createElement('button');
    const visible = game.flipped.includes(index) || game.matched.includes(index);
    button.textContent = visible ? String(value + 1) : '?';
    button.addEventListener('click', () => socket.emit('game_move', { gameId: game.id, move: { index } }));
    wrap.appendChild(button);
  });
  els.gameArea.appendChild(wrap);
}

function bindGames() {
  document.querySelectorAll('.game-create').forEach(button => {
    button.addEventListener('click', () => socket.emit('game_create', { type: button.dataset.type }));
  });
  $('btn-join-game').addEventListener('click', () => {
    const gameId = $('join-game-id').value.trim().toUpperCase();
    if (gameId) socket.emit('game_join', { gameId });
  });
}

function bindNavigation() {
  $('nav-chat').addEventListener('click', () => showMain('chat'));
  $('chat-home').addEventListener('click', () => showMain('chat'));
  $('nav-games').addEventListener('click', () => showMain('games'));
  $('btn-open-sidebar').addEventListener('click', () => document.querySelector('.sidebar').classList.add('open'));
  $('btn-mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.remove('open'));
  $('btn-logout').addEventListener('click', logout);
}

function showMain(view) {
  els.chatView.classList.toggle('active', view === 'chat');
  els.gamesView.classList.toggle('active', view === 'games');
  $('nav-chat').classList.toggle('active', view === 'chat');
  $('nav-games').classList.toggle('active', view === 'games');
}

function bindThemeAndAdmin() {
  $('btn-theme-open').addEventListener('click', () => $('theme-modal').classList.remove('hidden'));
  $('btn-theme-close').addEventListener('click', () => $('theme-modal').classList.add('hidden'));
  document.querySelectorAll('[data-theme]').forEach(button => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.theme);
      $('theme-modal').classList.add('hidden');
    });
  });

  $('btn-admin-open').addEventListener('click', () => {
    $('admin-pin').value = '';
    $('admin-error').classList.add('hidden');
    $('admin-modal').classList.remove('hidden');
  });
  $('btn-admin-cancel').addEventListener('click', () => $('admin-modal').classList.add('hidden'));
  $('btn-admin-unlock').addEventListener('click', unlockAdmin);
  $('admin-pin').addEventListener('keydown', event => {
    if (event.key === 'Enter') unlockAdmin();
  });
}

async function unlockAdmin() {
  const pin = $('admin-pin').value.trim();
  const error = $('admin-error');
  error.classList.add('hidden');
  try {
    const data = await request('/api/admin/unlock-pin', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    currentUser = data.user;
    localStorage.setItem('nexus_user', JSON.stringify(currentUser));
    $('admin-modal').classList.add('hidden');
    location.href = '/admin.html';
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

function copyText(text, message) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(message));
  } else {
    prompt(message, text);
  }
}

async function startApp() {
  showScreen(true);
  updateUserUi();
  connectSocket();
  await loadRooms();
  if (!currentRoomId) joinRoom('general', 'General');
}

bindAuth();
bindChat();
bindCall();
bindGames();
bindNavigation();
bindThemeAndAdmin();
applyTheme(localStorage.getItem('nexus_theme') || 'midnight');

if (currentUser && token) startApp();
else showScreen(false);
