let socket, currentUser, currentRoom, currentCallId, localStream, screenStream, currentGame, chessSelected;
let micOn = true, camOn = false, screenOn = false;
const peers = {};
const peerNames = {};
const badWords = ['fuck','shit','bitch','cunt','dick','pussy','bastard','cock','whore','slut'];
let cooldownUntil = 0;
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' },
];

const $ = id => document.getElementById(id);
const token = () => localStorage.getItem('nexus_token');

async function post(path, body, authed = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (authed) headers.Authorization = 'Bearer ' + token();
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

function showAuthError(text) {
  $('auth-error').textContent = text;
  $('auth-error').classList.remove('hidden');
  setTimeout(() => $('auth-error').classList.add('hidden'), 3500);
}

function html(text) {
  return String(text).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
}

document.querySelectorAll('.auth-tab').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    $('tab-' + button.dataset.tab).classList.add('active');
  });
});

$('btn-login').onclick = async () => {
  const res = await post('/api/auth/login', { email: $('login-email').value, password: $('login-password').value });
  if (res.error) return showAuthError(res.error);
  login(res.token, res.user);
};

$('btn-register').onclick = async () => {
  const res = await post('/api/auth/register', { username: $('reg-username').value, email: $('reg-email').value, password: $('reg-password').value });
  if (res.error) return showAuthError(res.error);
  login(res.token, res.user);
};

$('btn-anon-toggle').onclick = () => $('anon-form').classList.toggle('hidden');
$('btn-anon').onclick = async () => {
  const res = await post('/api/auth/anonymous', { username: $('anon-name').value });
  if (res.error) return showAuthError(res.error);
  login(res.token, res.user);
};

window.handleGoogleSignIn = async response => {
  try {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    const res = await post('/api/auth/google', { googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture });
    if (res.error) return showAuthError(res.error);
    login(res.token, res.user);
  } catch {
    showAuthError('Google sign-in failed');
  }
};

$('btn-google').onclick = () => {
  if (window.google?.accounts?.id) window.google.accounts.id.prompt();
  else showAuthError('Google is still loading. Try again in a second.');
};

function login(newToken, user) {
  localStorage.setItem('nexus_token', newToken);
  localStorage.setItem('nexus_user', JSON.stringify(user));
  currentUser = user;
  startApp();
}

function updateUser(user) {
  currentUser = user;
  localStorage.setItem('nexus_user', JSON.stringify(user));
}

window.addEventListener('load', () => {
  const savedToken = token();
  const savedUser = localStorage.getItem('nexus_user');
  if (savedToken && savedUser) {
    currentUser = JSON.parse(savedUser);
    startApp();
  }
});

function startApp() {
  $('auth-screen').classList.remove('active');
  $('app-screen').classList.add('active');
  $('sidebar-name').textContent = currentUser.username;
  $('sidebar-avatar').textContent = currentUser.avatar || currentUser.username[0].toUpperCase();
  if (currentUser.picture) {
    $('sidebar-avatar').style.backgroundImage = `url(${currentUser.picture})`;
    $('sidebar-avatar').textContent = '';
  }
  socket = io({ auth: { token: token() }, transports: ['polling', 'websocket'] });
  setupSocket();
  loadRooms();
}

$('btn-logout').onclick = () => {
  localStorage.clear();
  location.reload();
};

$('nav-chat').onclick = () => showView('chat');
$('nav-games').onclick = () => showView('games');
$('btn-mobile-menu').onclick = () => document.querySelector('.sidebar').classList.toggle('open');

function showView(name) {
  document.querySelectorAll('.main-view').forEach(view => view.classList.remove('active'));
  $(name + '-view').classList.add('active');
  $('nav-chat').classList.toggle('active', name === 'chat');
  $('nav-games').classList.toggle('active', name === 'games');
}

async function loadRooms() {
  const rooms = await fetch('/api/rooms').then(res => res.json());
  const list = $('room-list');
  list.innerHTML = '';
  rooms.forEach(room => addRoomButton(room));
  if (!currentRoom) joinRoom('general', 'General Chat');
}

function addRoomButton(room) {
  const button = document.createElement('button');
  button.className = 'room-btn';
  button.dataset.id = room.id;
  button.innerHTML = `<span>#</span><span>${html(room.name)}</span><small>${room.private ? 'private' : ''}</small>`;
  button.onclick = () => joinRoom(room.id, room.name);
  $('room-list').appendChild(button);
}

function joinRoom(roomId, name) {
  currentRoom = roomId;
  document.querySelectorAll('.room-btn').forEach(button => button.classList.toggle('active', button.dataset.id === roomId));
  $('current-room-name').textContent = name || roomId;
  $('message-input').disabled = false;
  $('btn-send').disabled = false;
  $('message-input').placeholder = 'Message #' + (name || roomId);
  $('messages-area').innerHTML = '';
  socket.emit('join_room', roomId);
  showView('chat');
  document.querySelector('.sidebar').classList.remove('open');
}

$('btn-new-room').onclick = () => $('room-modal').classList.remove('hidden');
$('btn-room-cancel').onclick = () => $('room-modal').classList.add('hidden');
$('btn-room-create').onclick = () => {
  socket.emit('create_room', { name: $('room-name').value, private: $('room-private').checked });
  $('room-name').value = '';
  $('room-private').checked = false;
  $('room-modal').classList.add('hidden');
};

$('btn-admin-open').onclick = () => $('admin-modal').classList.remove('hidden');
$('btn-admin-cancel').onclick = () => $('admin-modal').classList.add('hidden');
$('btn-admin-unlock').onclick = async () => {
  const res = await post('/api/admin/unlock-pin', { pin: $('admin-pin').value }, true);
  if (res.error) {
    $('admin-error').textContent = res.error;
    $('admin-error').classList.remove('hidden');
    return;
  }
  updateUser(res.user);
  $('admin-modal').classList.add('hidden');
  window.open('/admin.html', '_blank');
};

function setupSocket() {
  socket.on('online_count', count => $('online-count').textContent = count);
  socket.on('room_history', messages => {
    $('messages-area').innerHTML = '';
    messages.forEach(renderMessage);
    scrollMessages();
  });
  socket.on('new_message', message => { renderMessage(message); scrollMessages(); });
  socket.on('message_deleted', data => document.getElementById('msg-' + data.messageId)?.remove());
  socket.on('room_cleared', () => $('messages-area').innerHTML = '');
  socket.on('room_members', members => {
    $('room-member-count').textContent = members.length + ' members';
    renderMembers(members);
  });
  socket.on('rooms_updated', loadRooms);
  socket.on('room_created', room => {
    loadRooms();
    joinRoom(room.id, room.name);
    if (room.private) alert('Private room created. Room ID: ' + room.id);
  });
  socket.on('room_deleted', () => { currentRoom = null; loadRooms(); });
  socket.on('user_typing', data => showTyping(data.typing ? `${data.username} is typing...` : ''));
  socket.on('error_msg', showTyping);
  socket.on('force_logout', data => { alert(data.reason); localStorage.clear(); location.reload(); });

  socket.on('call_existing_peers', data => data.peers.forEach(peerId => callPeer(peerId)));
  socket.on('call_peer_joined', data => peerNames[data.peerId] = data.username);
  socket.on('call_offer', async data => { peerNames[data.from] = data.username; await answerOffer(data.from, data.offer); });
  socket.on('call_answer', async data => peers[data.from]?.setRemoteDescription(new RTCSessionDescription(data.answer)));
  socket.on('call_ice', async data => { try { await peers[data.from]?.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} });
  socket.on('call_peer_left', data => removePeer(data.peerId));

  socket.on('game_created', data => renderGame(data.game));
  socket.on('game_updated', renderGame);
  socket.on('game_error', message => alert(message));
}

function renderMessage(message) {
  const wrap = document.createElement('div');
  wrap.className = 'message';
  wrap.id = 'msg-' + message.id;
  const canDelete = currentUser.role === 'admin' || currentUser.role === 'moderator';
  const badge = message.role === 'admin' ? '<span class="badge">ADMIN</span>' : message.role === 'moderator' ? '<span class="badge">MOD</span>' : '';
  wrap.innerHTML = `
    <div class="msg-avatar">${html(message.avatar || message.username[0])}</div>
    <div>
      <div><span class="msg-name">${html(message.username)}</span>${badge}<span class="msg-time">${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="msg-text">${html(message.content)}</div>
    </div>
    ${canDelete ? '<button class="delete-msg">Delete</button>' : ''}
  `;
  const deleteButton = wrap.querySelector('.delete-msg');
  if (deleteButton) deleteButton.onclick = () => socket.emit('mod_delete_message', { roomId: message.roomId, messageId: message.id });
  $('messages-area').appendChild(wrap);
}

function renderMembers(members) {
  $('members-list').innerHTML = members.map(member => `
    <div class="member">
      <div class="avatar">${html(member.avatar || member.username[0])}</div>
      <span>${html(member.username)} ${member.role === 'admin' ? '(admin)' : member.role === 'moderator' ? '(mod)' : ''}</span>
    </div>
  `).join('');
}

function scrollMessages() {
  $('messages-area').scrollTop = $('messages-area').scrollHeight;
}

function showTyping(text) {
  $('typing-indicator').textContent = text;
  $('typing-indicator').classList.toggle('hidden', !text);
}

$('message-form').onsubmit = event => {
  event.preventDefault();
  sendMessage();
};

$('message-input').oninput = () => {
  if (!currentRoom) return;
  socket.emit('typing', { roomId: currentRoom, typing: true });
  clearTimeout(window.typingTimer);
  window.typingTimer = setTimeout(() => socket.emit('typing', { roomId: currentRoom, typing: false }), 1200);
};

function sendMessage() {
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !currentRoom) return;
  if (!['admin','moderator'].includes(currentUser.role)) {
    if (Date.now() < cooldownUntil) {
      showTyping('Cooldown: ' + Math.ceil((cooldownUntil - Date.now()) / 1000) + ' seconds left');
      return;
    }
    if (badWords.some(word => new RegExp('\\b' + word + '\\b', 'i').test(content))) {
      cooldownUntil = Date.now() + 60000;
      input.value = '';
      showTyping('Do not swear. You have a 1 minute cooldown.');
      return;
    }
  }
  socket.emit('send_message', { roomId: currentRoom, content });
  input.value = '';
  socket.emit('typing', { roomId: currentRoom, typing: false });
}

$('btn-join-call').onclick = () => currentCallId ? leaveCall() : joinCall('general');
$('btn-leave-call').onclick = leaveCall;

async function joinCall(callId) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    alert('Allow microphone access first.');
    return;
  }
  currentCallId = callId;
  $('call-area').classList.remove('hidden');
  $('current-call-id').textContent = callId;
  $('local-label').textContent = currentUser.username + ' (you)';
  $('local-video').srcObject = localStream;
  $('btn-join-call').textContent = 'Leave General Call';
  $('btn-join-call').classList.add('leave');
  socket.emit('call_join', { callId });
}

function leaveCall() {
  socket.emit('call_leave', { callId: currentCallId });
  Object.keys(peers).forEach(removePeer);
  localStream?.getTracks().forEach(track => track.stop());
  screenStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  screenStream = null;
  currentCallId = null;
  $('call-area').classList.add('hidden');
  $('btn-join-call').textContent = 'Join General Call';
  $('btn-join-call').classList.remove('leave');
  document.querySelectorAll('.remote-tile').forEach(tile => tile.remove());
}

function makePeer(peerId) {
  if (peers[peerId]) peers[peerId].close();
  const pc = new RTCPeerConnection({ iceServers });
  peers[peerId] = pc;
  localStream?.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = event => event.candidate && socket.emit('call_ice', { to: peerId, candidate: event.candidate });
  pc.ontrack = event => addRemoteVideo(peerId, event.streams[0] || new MediaStream([event.track]));
  return pc;
}

async function callPeer(peerId) {
  const pc = makePeer(peerId);
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit('call_offer', { to: peerId, offer: pc.localDescription });
}

async function answerOffer(peerId, offer) {
  const pc = makePeer(peerId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  await pc.setLocalDescription(await pc.createAnswer());
  socket.emit('call_answer', { to: peerId, answer: pc.localDescription });
}

function addRemoteVideo(peerId, stream) {
  let tile = $('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile remote-tile';
    tile.id = 'tile-' + peerId;
    tile.innerHTML = '<video autoplay playsinline></video><span></span>';
    $('video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('span').textContent = peerNames[peerId] || 'User';
}

function removePeer(peerId) {
  peers[peerId]?.close();
  delete peers[peerId];
  $('tile-' + peerId)?.remove();
}

$('btn-toggle-mic').onclick = () => {
  micOn = !micOn;
  localStream?.getAudioTracks().forEach(track => track.enabled = micOn);
  $('btn-toggle-mic').textContent = micOn ? 'Mic' : 'Muted';
};

$('btn-toggle-cam').onclick = async () => {
  if (!localStream) return;
  camOn = !camOn;
  if (camOn) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    localStream.addTrack(track);
    Object.values(peers).forEach(pc => pc.addTrack(track, localStream));
  } else {
    localStream.getVideoTracks().forEach(track => { track.stop(); localStream.removeTrack(track); });
  }
};

$('btn-share-screen').onclick = async () => {
  if (!currentCallId) return alert('Join a call first.');
  if (screenOn) {
    screenStream?.getTracks().forEach(track => track.stop());
    screenOn = false;
    $('local-video').srcObject = localStream;
    return;
  }
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  screenOn = true;
  const screenTrack = screenStream.getVideoTracks()[0];
  Object.values(peers).forEach(pc => {
    const sender = pc.getSenders().find(item => item.track?.kind === 'video');
    if (sender) sender.replaceTrack(screenTrack);
    else pc.addTrack(screenTrack, screenStream);
  });
  $('local-video').srcObject = screenStream;
  screenTrack.onended = () => { screenOn = false; $('local-video').srcObject = localStream; };
};

$('btn-copy-call-id').onclick = () => navigator.clipboard.writeText(currentCallId || 'general');

document.querySelectorAll('.game-create').forEach(button => button.onclick = () => socket.emit('game_create', { type: button.dataset.type }));
$('btn-join-game').onclick = () => socket.emit('game_join', { gameId: $('join-game-id').value.trim().toUpperCase() });

function renderGame(game) {
  currentGame = game;
  showView('games');
  $('games-lobby').classList.add('hidden');
  $('game-area').classList.remove('hidden');
  const myIndex = game.players.findIndex(player => player.id === currentUser.id);
  const status = game.status === 'waiting' ? `Waiting for player. ID: ${game.id}` :
    game.status === 'ended' ? (game.winner === 'draw' ? 'Draw' : `${game.players[game.winner]?.username || 'Player'} won`) :
    (game.turn % 2 === myIndex ? 'Your turn' : `${game.players[game.turn % 2]?.username || 'Player'} turn`);
  const board = game.type === 'connect4' ? renderConnect4(game, myIndex) : game.type === 'chess' ? renderChess(game, myIndex) : renderTicTacToe(game, myIndex);
  $('game-area').innerHTML = `
    <button class="ghost-btn" onclick="backToGames()">Back to games</button>
    <h2>${game.type} - ${game.id}</h2>
    <p>${status}</p>
    ${board}
    ${game.status === 'ended' ? `<button class="primary-btn" onclick="socket.emit('game_rematch',{gameId:'${game.id}'})">Rematch</button>` : ''}
  `;
  if (game.type === 'chess') bindChess(game, myIndex);
}

window.backToGames = () => {
  $('games-lobby').classList.remove('hidden');
  $('game-area').classList.add('hidden');
  chessSelected = null;
};

function renderTicTacToe(game, myIndex) {
  const marks = ['X','O'];
  const can = game.status === 'playing' && game.turn % 2 === myIndex;
  return `<div class="ttt-board">${game.board.map((cell, index) =>
    `<button class="ttt-cell" ${can && cell === null ? `onclick="socket.emit('game_move',{gameId:'${game.id}',move:{index:${index}}})"` : ''}>${cell === null ? '' : marks[cell]}</button>`
  ).join('')}</div>`;
}

function renderConnect4(game, myIndex) {
  const can = game.status === 'playing' && game.turn % 2 === myIndex;
  const buttons = Array.from({ length: 7 }, (_, col) => `<button ${can ? `onclick="socket.emit('game_move',{gameId:'${game.id}',move:{col:${col}}})"` : 'disabled'}>v</button>`).join('');
  const cells = game.board.map(cell => `<div class="c4-cell ${cell === null ? '' : 'p' + cell}"></div>`).join('');
  return `<div class="c4-wrap"><div class="c4-buttons">${buttons}</div><div class="c4-board">${cells}</div></div>`;
}

function renderChess(game) {
  const pieces = { wK:'K',wQ:'Q',wR:'R',wB:'B',wN:'N',wP:'P',bK:'k',bQ:'q',bR:'r',bB:'b',bN:'n',bP:'p' };
  return `<div id="chess-board" class="chess-board">${game.board.map((piece, index) => {
    const r = Math.floor(index / 8), c = index % 8;
    return `<button data-index="${index}" class="chess-sq ${(r + c) % 2 ? 'dark' : 'light'} ${chessSelected === index ? 'selected' : ''}">${pieces[piece] || ''}</button>`;
  }).join('')}</div>`;
}

function bindChess(game, myIndex) {
  $('chess-board').onclick = event => {
    const square = event.target.closest('.chess-sq');
    if (!square || game.status !== 'playing' || game.turn % 2 !== myIndex) return;
    const index = Number(square.dataset.index);
    if (chessSelected === null) {
      chessSelected = index;
      renderGame(game);
    } else {
      socket.emit('game_move', { gameId: game.id, move: { from: chessSelected, to: index } });
      chessSelected = null;
    }
  };
}
