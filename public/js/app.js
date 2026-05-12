const $ = id => document.getElementById(id);

const state = {
  token: localStorage.getItem('nexus_token') || '',
  user: readJson(localStorage.getItem('nexus_user')),
  rooms: [],
  friends: [],
  requests: [],
  dms: [],
  presence: [],
  currentRoom: 'general',
  currentDm: '',
  currentGame: null,
  socket: null,
  attachment: null,
  localStream: null,
  screenStream: null,
  cameraStream: null,
  callId: '',
  peers: {},
  micOn: true,
  camOn: false,
  deafened: false,
  pushToTalk: false,
};

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

let googleInitialized = false;

function readJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safePic(value) {
  const pic = String(value || '');
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(pic)) return pic;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(pic)) return pic;
  return '';
}

function avatar(user, cls = 'avatar') {
  const pic = safePic(user?.picture);
  const letter = esc(user?.avatar || (user?.username || '?')[0].toUpperCase());
  return `<span class="${cls}">${pic ? `<img src="${esc(pic)}" alt="">` : letter}</span>`;
}

function showError(message) {
  const el = $('auth-error');
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function toast(message) {
  if (message) alert(message);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function saveSession(data) {
  if (data.token) state.token = data.token;
  if (data.user) state.user = data.user;
  localStorage.setItem('nexus_token', state.token);
  localStorage.setItem('nexus_user', JSON.stringify(state.user));
}

function logout() {
  if (state.socket) state.socket.disconnect();
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
  state.token = '';
  state.user = null;
  $('app-screen').classList.remove('active');
  $('auth-screen').classList.add('active');
}

async function auth(path, body) {
  showError('');
  try {
    const data = await request(path, { method: 'POST', body: JSON.stringify(body) });
    saveSession(data);
    await startApp();
  } catch (err) {
    showError(err.message);
  }
}

function decodeGoogleCredential(credential) {
  let encoded = String(credential || '').split('.')[1] || '';
  encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  encoded += '='.repeat((4 - encoded.length % 4) % 4);
  return JSON.parse(atob(encoded));
}

window.handleGoogleSignIn = async response => {
  try {
    if (!response?.credential) throw new Error('Missing credential');
    const payload = decodeGoogleCredential(response.credential);
    await auth('/api/auth/google', { email: payload.email, name: payload.name, picture: payload.picture, googleId: payload.sub });
  } catch {
    showError('Google login failed');
  }
};

function initGoogleSignIn() {
  if (googleInitialized) return true;
  if (!window.google?.accounts?.id) return false;
  const holder = $('g_id_onload');
  const clientId = holder?.dataset?.client_id;
  if (!clientId) {
    showError('Google Client ID is missing');
    return false;
  }
  google.accounts.id.initialize({
    client_id: clientId,
    callback: window.handleGoogleSignIn,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: 'popup',
  });
  const button = $('google-button');
  if (button) {
    button.innerHTML = '';
    google.accounts.id.renderButton(button, {
      theme: 'outline',
      size: 'large',
      shape: 'rectangular',
      text: 'continue_with',
      width: 330,
    });
  }
  googleInitialized = true;
  return true;
}

function waitForGoogleSignIn() {
  if (initGoogleSignIn()) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (initGoogleSignIn() || tries > 40) clearInterval(timer);
  }, 250);
}

function bindAuth() {
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  }));
  $('btn-login').addEventListener('click', () => auth('/api/auth/login', { email: $('login-email').value, password: $('login-password').value }));
  $('btn-register').addEventListener('click', () => auth('/api/auth/register', { username: $('reg-username').value, email: $('reg-email').value, password: $('reg-password').value }));
  $('btn-anon-toggle').addEventListener('click', () => $('anon-form').classList.toggle('hidden'));
  $('btn-anon').addEventListener('click', () => auth('/api/auth/anonymous', { username: $('anon-name').value }));
}

async function startApp() {
  $('auth-screen').classList.remove('active');
  $('app-screen').classList.add('active');
  connectSocket();
  await bootstrap();
}

async function bootstrap() {
  const data = await request('/api/bootstrap');
  state.user = data.user;
  state.rooms = data.rooms;
  state.friends = data.friends;
  state.requests = data.requests || [];
  state.dms = data.dmThreads;
  state.presence = data.onlineUsers;
  localStorage.setItem('nexus_user', JSON.stringify(state.user));
  applyProfileUi();
  renderRooms();
  renderDms();
  renderFriends();
  joinRoom(state.currentRoom || 'general');
}

function applyProfileUi() {
  document.body.dataset.theme = state.user?.theme || 'midnight';
  document.documentElement.style.setProperty('--accent', state.user?.accent || '#5865f2');
  $('me-name').textContent = state.user?.username || 'User';
  $('me-status').textContent = state.user?.status || 'Online';
  $('btn-profile-picture').innerHTML = safePic(state.user?.picture) ? `<img src="${esc(state.user.picture)}" alt="">` : esc(state.user?.avatar || '?');
  $('local-call-name').textContent = state.user?.username || 'You';
  $('local-call-picture').src = safePic(state.user?.picture);
  $('profile-name').value = state.user?.username || '';
  $('profile-status').value = state.user?.status || '';
  $('profile-bio').value = state.user?.bio || '';
  $('profile-banner-input').value = state.user?.banner || '';
  $('profile-accent').value = state.user?.accent || '#5865f2';
  $('profile-theme').value = state.user?.theme || 'midnight';
  renderProfilePreview();
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token }, transports: ['polling'], upgrade: false, reconnection: true });
  const s = state.socket;
  s.on('connect_error', err => {
    if (/unauthorized/i.test(err.message || '')) logout();
    else toast(err.message);
  });
  s.on('rooms_updated', async () => {
    state.rooms = await request('/api/rooms');
    renderRooms();
  });
  s.on('online_count', count => $('room-subtitle').textContent = `${count} online`);
  s.on('presence', users => {
    state.presence = users;
    renderFriends();
  });
  s.on('room_history', renderMessages);
  s.on('new_message', msg => appendMessage(msg));
  s.on('message_deleted', data => document.querySelector(`[data-message-id="${data.messageId}"]`)?.remove());
  s.on('message_reactions', data => updateReactions(data.messageId, data.reactions));
  s.on('room_cleared', () => $('messages').innerHTML = empty('Room cleared'));
  s.on('room_members', members => $('room-subtitle').textContent = `${members.length} in room`);
  s.on('user_typing', data => {
    $('typing').textContent = data.typing ? `${data.username} is typing...` : '';
    $('typing').classList.toggle('hidden', !data.typing);
  });
  s.on('error_msg', toast);
  s.on('force_logout', data => {
    toast(data.reason || 'Logged out');
    logout();
  });
  s.on('notify', data => notify(data));
  s.on('friend_request', async () => {
    const next = await request('/api/friends');
    state.friends = next.friends;
    state.requests = next.requests;
    renderFriends();
    notify({ type: 'friend', from: 'Nexus', content: 'New friend request' });
  });
  s.on('dm_history', data => renderDmMessages(data.messages));
  s.on('new_dm', msg => appendDmMessage(msg));
  s.on('call_existing_peers', async data => {
    state.callId = data.callId;
    for (const peer of data.peers || []) await createPeer(peer.peerId, peer, true);
    updateCallStatus();
  });
  s.on('call_peer_joined', data => createPeer(data.peerId, data, false));
  s.on('call_offer', async data => {
    const pc = await createPeer(data.from, data, false);
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    s.emit('call_answer', { to: data.from, answer });
  });
  s.on('call_answer', async data => {
    const pc = state.peers[data.from]?.pc;
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  });
  s.on('call_ice', async data => {
    const pc = state.peers[data.from]?.pc;
    if (pc && data.candidate) try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  });
  s.on('call_peer_left', data => removePeer(data.peerId));
  s.on('game_created', game => renderGame(game));
  s.on('game_updated', game => renderGame(game));
  s.on('game_error', toast);
}

function empty(text) {
  return `<div class="empty"><h2>${esc(text)}</h2><p>Nexus is ready.</p></div>`;
}

function renderRooms() {
  $('room-list').innerHTML = state.rooms.map(room => `<button class="${room.id === state.currentRoom ? 'active' : ''}" data-room="${room.id}"># ${esc(room.name)}${room.private ? ' 🔒' : ''}</button>`).join('');
  document.querySelectorAll('[data-room]').forEach(btn => btn.addEventListener('click', () => joinRoom(btn.dataset.room)));
}

function joinRoom(id) {
  const room = state.rooms.find(item => item.id === id) || { id, name: id };
  state.currentRoom = id;
  $('room-title').textContent = `# ${room.name}`;
  $('message-input').placeholder = `Message #${room.name}`;
  state.socket.emit('join_room', id);
  renderRooms();
  showView('chat');
}

function renderMessages(messages) {
  $('messages').innerHTML = messages.length ? '' : empty('No messages yet');
  messages.forEach(appendMessage);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function appendMessage(msg) {
  const wrap = $('messages');
  const row = document.createElement('article');
  row.className = `message ${msg.mentions?.includes(state.user.id) ? 'mention' : ''}`;
  row.dataset.messageId = msg.id;
  row.innerHTML = `
    ${avatar(msg, 'msg-avatar')}
    <div>
      <div><span class="msg-name">${esc(msg.username)}</span><span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div>${linkMentions(esc(msg.content || ''))}</div>
      ${attachmentHtml(msg.attachment)}
      <div class="reactions" data-reactions></div>
      <div class="reactions">
        ${['💜','😂','🔥','👍','💀'].map(e => `<button class="react-btn" data-react="${e}">${e}</button>`).join('')}
      </div>
    </div>
    <button class="delete-msg">Delete</button>
  `;
  row.querySelectorAll('[data-react]').forEach(btn => btn.addEventListener('click', () => state.socket.emit('react_message', { messageId: msg.id, emoji: btn.dataset.react })));
  row.querySelector('.delete-msg').addEventListener('click', () => state.socket.emit('delete_message', { messageId: msg.id }));
  wrap.appendChild(row);
  updateReactions(msg.id, msg.reactions || {});
  wrap.scrollTop = wrap.scrollHeight;
}

function linkMentions(text) {
  return text.replace(/@([a-z0-9_.-]{2,32})/gi, '<b>@$1</b>');
}

function attachmentHtml(file) {
  if (!file) return '';
  if (file.type?.startsWith('image/')) return `<div class="attachment"><img src="${esc(file.data)}" alt="${esc(file.name)}"></div>`;
  if (file.type?.startsWith('video/')) return `<div class="attachment"><video src="${esc(file.data)}" controls></video></div>`;
  return `<div class="attachment"><a href="${esc(file.data)}" download="${esc(file.name)}">${esc(file.name)}</a></div>`;
}

function updateReactions(messageId, reactions) {
  const box = document.querySelector(`[data-message-id="${messageId}"] [data-reactions]`);
  if (!box) return;
  box.innerHTML = Object.entries(reactions || {}).filter(([, ids]) => ids.length).map(([emoji, ids]) => `<span class="reaction">${emoji} ${ids.length}</span>`).join('');
}

function renderDms() {
  $('dm-list').innerHTML = state.dms.map(dm => `<button data-dm="${dm.id}">${avatar(dm.other)} ${esc(dm.other?.username || 'DM')}</button>`).join('');
  document.querySelectorAll('[data-dm]').forEach(btn => btn.addEventListener('click', () => openDm(btn.dataset.dm)));
}

function openDm(id) {
  state.currentDm = id;
  const dm = state.dms.find(item => item.id === id);
  $('dm-title').textContent = dm?.other?.username || 'Direct Message';
  state.socket.emit('join_dm', id);
  showView('dm');
}

function renderDmMessages(messages) {
  $('dm-messages').innerHTML = messages.length ? '' : empty('No DMs yet');
  messages.forEach(appendDmMessage);
}

function appendDmMessage(msg) {
  const row = document.createElement('article');
  row.className = 'message';
  row.innerHTML = `${avatar(msg, 'msg-avatar')}<div><b>${esc(msg.username)}</b><span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div>${esc(msg.content)}</div></div>`;
  $('dm-messages').appendChild(row);
  $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
}

function renderFriends() {
  $('friends-list').innerHTML = state.friends.map(friend => `<div class="item-row">${avatar(friend)}<div><b>${esc(friend.username)}</b><small>${esc(friend.status || 'Online')}</small></div><button class="mini" data-start-dm="${friend.id}">DM</button></div>`).join('') || '<p>No friends yet.</p>';
  $('friend-requests').innerHTML = (state.requests || []).map(req => `<div class="item-row">${avatar(req.fromUser)}<b>${esc(req.fromUser.username)}</b><button class="mini good" data-accept="${req.id}">Accept</button><button class="mini" data-reject="${req.id}">Reject</button></div>`).join('') || '<p>No requests.</p>';
  $('presence-list').innerHTML = (state.presence || []).map(user => `<div class="item-row">${avatar(user)}<div><b>${esc(user.username)}</b><small>${esc(user.status || 'Online')}</small></div></div>`).join('');
  document.querySelectorAll('[data-start-dm]').forEach(btn => btn.addEventListener('click', () => startDm(btn.dataset.startDm)));
  document.querySelectorAll('[data-accept]').forEach(btn => btn.addEventListener('click', () => respondFriend(btn.dataset.accept, true)));
  document.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', () => respondFriend(btn.dataset.reject, false)));
}

async function startDm(userId) {
  const dm = await request('/api/dm/start', { method: 'POST', body: JSON.stringify({ userId }) });
  if (!state.dms.some(item => item.id === dm.id)) state.dms.push(dm);
  renderDms();
  openDm(dm.id);
}

async function respondFriend(requestId, accept) {
  const data = await request('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId, accept }) });
  state.friends = data.friends;
  state.requests = data.requests;
  renderFriends();
}

function showView(view) {
  document.querySelectorAll('.view').forEach(item => item.classList.remove('active'));
  $(`view-${view}`).classList.add('active');
  document.querySelectorAll('.nav').forEach(item => item.classList.toggle('active', item.dataset.view === view));
}

function bindUi() {
  document.querySelectorAll('.nav[data-view]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  $('btn-logout').addEventListener('click', logout);
  $('message-form').addEventListener('submit', e => {
    e.preventDefault();
    const content = $('message-input').value.trim();
    state.socket.emit('send_message', { roomId: state.currentRoom, content, attachment: state.attachment });
    $('message-input').value = '';
    state.attachment = null;
  });
  $('dm-form').addEventListener('submit', e => {
    e.preventDefault();
    const content = $('dm-input').value.trim();
    if (!content || !state.currentDm) return;
    state.socket.emit('send_dm', { dmId: state.currentDm, content });
    $('dm-input').value = '';
  });
  let typingTimer = null;
  $('message-input').addEventListener('input', () => {
    state.socket.emit('typing', { roomId: state.currentRoom, typing: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => state.socket.emit('typing', { roomId: state.currentRoom, typing: false }), 900);
  });
  $('btn-attach').addEventListener('click', () => $('attachment-input').click());
  $('attachment-input').addEventListener('change', async () => {
    const file = $('attachment-input').files[0];
    $('attachment-input').value = '';
    if (!file) return;
    if (file.size > 700000) return toast('File too large. Keep it under about 700 KB.');
    state.attachment = { name: file.name, type: file.type, size: file.size, data: await fileToDataUrl(file) };
    toast(`Attached ${file.name}`);
  });
  $('btn-new-room').addEventListener('click', () => $('room-modal').classList.remove('hidden'));
  $('btn-room-cancel').addEventListener('click', () => $('room-modal').classList.add('hidden'));
  $('btn-room-create').addEventListener('click', createRoom);
  $('btn-room-invite').addEventListener('click', () => $('invite-modal').classList.remove('hidden'));
  $('btn-invite-close').addEventListener('click', () => $('invite-modal').classList.add('hidden'));
  $('btn-create-invite').addEventListener('click', createInvite);
  $('btn-join-invite').addEventListener('click', joinInvite);
  $('btn-notifications').addEventListener('click', () => Notification?.requestPermission?.());
  $('btn-theme').addEventListener('click', () => $('theme-modal').classList.remove('hidden'));
  $('btn-theme-close').addEventListener('click', () => $('theme-modal').classList.add('hidden'));
  document.querySelectorAll('.theme-grid button[data-theme]').forEach(btn => btn.addEventListener('click', () => saveProfile({ theme: btn.dataset.theme }, true)));
  $('btn-admin').addEventListener('click', () => $('admin-modal').classList.remove('hidden'));
  $('btn-admin-cancel').addEventListener('click', () => $('admin-modal').classList.add('hidden'));
  $('btn-admin-unlock').addEventListener('click', unlockAdmin);
  $('btn-admin-refresh').addEventListener('click', loadAdmin);
  $('btn-search-user').addEventListener('click', searchUsers);
  $('profile-form').addEventListener('submit', e => {
    e.preventDefault();
    saveProfile({
      username: $('profile-name').value,
      status: $('profile-status').value,
      bio: $('profile-bio').value,
      banner: $('profile-banner-input').value,
      accent: $('profile-accent').value,
      theme: $('profile-theme').value,
    });
  });
  $('btn-profile-picture').addEventListener('click', () => $('profile-picture-input').click());
  $('profile-picture-input').addEventListener('change', updateProfilePicture);
  document.querySelectorAll('[data-game]').forEach(btn => btn.addEventListener('click', () => state.socket.emit('game_create', { type: btn.dataset.game })));
  $('btn-join-game').addEventListener('click', () => state.socket.emit('game_join', { gameId: $('join-game-id').value.trim().toUpperCase() }));
}

async function createRoom() {
  const room = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('room-name').value, topic: $('room-topic').value, private: $('room-private').checked }) });
  state.rooms.push(room);
  $('room-modal').classList.add('hidden');
  renderRooms();
  joinRoom(room.id);
}

async function createInvite() {
  const invite = await request('/api/invites/create', { method: 'POST', body: JSON.stringify({ roomId: state.currentRoom }) });
  $('invite-code').value = invite.code;
  navigator.clipboard?.writeText(invite.code);
}

async function joinInvite() {
  const room = await request('/api/invites/join', { method: 'POST', body: JSON.stringify({ code: $('invite-code').value }) });
  if (!state.rooms.some(item => item.id === room.id)) state.rooms.push(room);
  renderRooms();
  joinRoom(room.id);
  $('invite-modal').classList.add('hidden');
}

async function searchUsers() {
  const q = $('friend-search').value.trim();
  const users = await request(`/api/users/search?q=${encodeURIComponent(q)}`);
  $('search-results').innerHTML = users.map(user => `<div class="item-row">${avatar(user)}<b>${esc(user.username)}</b><button class="mini good" data-add-friend="${user.id}">Add</button><button class="mini" data-start-dm="${user.id}">DM</button></div>`).join('') || '<p>No users found.</p>';
  document.querySelectorAll('[data-add-friend]').forEach(btn => btn.addEventListener('click', async () => {
    await request('/api/friends/request', { method: 'POST', body: JSON.stringify({ userId: btn.dataset.addFriend }) });
    toast('Friend request sent');
  }));
  document.querySelectorAll('[data-start-dm]').forEach(btn => btn.addEventListener('click', () => startDm(btn.dataset.startDm)));
}

async function saveProfile(changes, silent = false) {
  const body = {
    username: state.user.username,
    status: state.user.status,
    bio: state.user.bio,
    banner: state.user.banner,
    accent: state.user.accent,
    theme: state.user.theme,
    ...changes,
  };
  const data = await request('/api/user/profile', { method: 'POST', body: JSON.stringify(body) });
  state.user = data.user;
  localStorage.setItem('nexus_user', JSON.stringify(state.user));
  applyProfileUi();
  if (!silent) toast('Saved');
}

async function updateProfilePicture() {
  const file = $('profile-picture-input').files[0];
  $('profile-picture-input').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Choose an image');
  const picture = await imageToSquareData(file);
  const data = await request('/api/user/profile-picture', { method: 'POST', body: JSON.stringify({ picture }) });
  state.user = data.user;
  localStorage.setItem('nexus_user', JSON.stringify(state.user));
  applyProfileUi();
}

function renderProfilePreview() {
  $('profile-preview-name').textContent = state.user?.username || 'User';
  $('profile-preview-status').textContent = state.user?.status || 'Online';
  $('profile-preview-bio').textContent = state.user?.bio || 'No bio yet.';
  $('profile-banner').style.background = state.user?.banner || `linear-gradient(135deg, ${state.user?.accent || '#5865f2'}, #eb459e)`;
  $('profile-avatar').innerHTML = safePic(state.user?.picture) ? `<img src="${esc(state.user.picture)}" alt="">` : esc(state.user?.avatar || '?');
}

async function unlockAdmin() {
  try {
    const data = await request('/api/admin/unlock-pin', { method: 'POST', body: JSON.stringify({ pin: $('admin-pin').value }) });
    saveSession(data);
    $('admin-modal').classList.add('hidden');
    showView('admin');
    await loadAdmin();
  } catch (err) {
    $('admin-error').textContent = err.message;
    $('admin-error').classList.remove('hidden');
  }
}

async function loadAdmin() {
  try {
    const [stats, users, rooms, logs] = await Promise.all([request('/api/admin/stats'), request('/api/admin/users'), request('/api/admin/rooms'), request('/api/admin/logs')]);
    $('admin-lock').classList.add('hidden');
    $('admin-content').classList.remove('hidden');
    $('admin-stats').innerHTML = Object.entries(stats).map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`).join('');
    $('admin-users').innerHTML = `<table><tr><th>User</th><th>Email</th><th>Role</th><th>Actions</th></tr>${users.map(user => `<tr><td>${avatar(user)} ${esc(user.username)}</td><td>${esc(user.email || 'anon')}</td><td>${esc(user.role)}</td><td><button class="mini" data-admin="mute" data-user="${user.id}">Mute</button><button class="mini" data-admin="unmute" data-user="${user.id}">Unmute</button><button class="mini danger" data-admin="kick" data-user="${user.id}">Kick</button><button class="mini danger" data-admin="ban" data-user="${user.id}">Ban</button><button class="mini good" data-admin="add-mod" data-user="${user.id}">Mod</button><button class="mini" data-admin="remove-mod" data-user="${user.id}">Unmod</button></td></tr>`).join('')}</table>`;
    $('admin-rooms').innerHTML = `<table><tr><th>Room</th><th>Private</th><th>Messages</th><th>Actions</th></tr>${rooms.map(room => `<tr><td># ${esc(room.name)}</td><td>${room.private ? 'yes' : 'no'}</td><td>${room.messageCount}</td><td><button class="mini danger" data-room-action="clear-room" data-room="${room.id}">Clear</button><button class="mini danger" data-room-action="delete-room" data-room="${room.id}">Delete</button></td></tr>`).join('')}</table>`;
    $('admin-logs').innerHTML = logs.map(log => `<div class="item-row"><b>${esc(log.action)}</b><span>${esc(log.actor)} → ${esc(log.target)}</span><small>${new Date(log.timestamp).toLocaleString()}</small></div>`).join('');
    document.querySelectorAll('[data-admin]').forEach(btn => btn.addEventListener('click', () => adminAction(btn.dataset.admin, { userId: btn.dataset.user })));
    document.querySelectorAll('[data-room-action]').forEach(btn => btn.addEventListener('click', () => adminAction(btn.dataset.roomAction, { roomId: btn.dataset.room })));
  } catch {
    $('admin-lock').classList.remove('hidden');
    $('admin-content').classList.add('hidden');
  }
}

async function adminAction(action, body) {
  if (action === 'delete-room' && !confirm('Delete room?')) return;
  if (action === 'clear-room' && !confirm('Clear room messages?')) return;
  await request(`/api/admin/${action}`, { method: 'POST', body: JSON.stringify(body) });
  await loadAdmin();
}

function notify(data) {
  if (document.hidden && window.Notification?.permission === 'granted') {
    new Notification(`${data.from}`, { body: data.content || data.type });
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function imageToSquareData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Bad image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  $('mic-select').innerHTML = devices.filter(d => d.kind === 'audioinput').map(d => `<option value="${d.deviceId}">${esc(d.label || 'Microphone')}</option>`).join('');
  $('cam-select').innerHTML = devices.filter(d => d.kind === 'videoinput').map(d => `<option value="${d.deviceId}">${esc(d.label || 'Camera')}</option>`).join('');
}

async function startCall(callId = 'general-voice') {
  if (state.callId) return leaveCall();
  state.callId = callId;
  $('call-overlay').classList.remove('hidden');
  $('btn-join-call').innerHTML = '<span></span> Leave General Voice';
  await refreshDevices();
  try {
    const audio = $('mic-select').value ? { deviceId: { exact: $('mic-select').value } } : true;
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    state.localStream = new MediaStream();
    toast('Microphone blocked, joined listen-only.');
  }
  $('local-video').srcObject = state.localStream;
  state.socket.emit('call_join', { callId });
  updateCallStatus();
}

function leaveCall() {
  Object.values(state.peers).forEach(peer => peer.pc.close());
  state.peers = {};
  document.querySelectorAll('.call-tile.remote').forEach(tile => tile.remove());
  state.localStream?.getTracks().forEach(track => track.stop());
  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.screenStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.cameraStream = null;
  state.screenStream = null;
  state.socket.emit('call_leave', { callId: state.callId });
  state.callId = '';
  $('call-overlay').classList.add('hidden');
  $('call-stage').classList.remove('video-mode', 'screen-mode');
  $('local-call-tile').classList.remove('has-video', 'screen-share');
  $('btn-join-call').innerHTML = '<span></span> Join General Voice';
}

async function createPeer(peerId, info, initiator) {
  if (state.peers[peerId]) return state.peers[peerId].pc;
  addCallTile(peerId, info);
  const pc = new RTCPeerConnection({ iceServers });
  state.peers[peerId] = { pc, stream: new MediaStream(), info };
  state.localStream?.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  state.screenStream?.getTracks().forEach(track => pc.addTrack(track, state.screenStream));
  pc.ontrack = event => {
    const peer = state.peers[peerId];
    if (!peer) return;
    event.streams[0].getTracks().forEach(track => peer.stream.addTrack(track));
    if (event.track.kind === 'video') {
      $(`call-tile-${peerId}`)?.classList.add('has-video');
      updateCallLayout();
    }
    const video = $(`call-video-${peerId}`);
    if (video) {
      video.srcObject = peer.stream;
      video.muted = state.deafened;
    }
  };
  pc.onicecandidate = event => event.candidate && state.socket.emit('call_ice', { to: peerId, candidate: event.candidate });
  if (initiator) await sendOffer(peerId);
  updateCallStatus();
  return pc;
}

async function sendOffer(peerId) {
  const pc = state.peers[peerId]?.pc;
  if (!pc) return;
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  state.socket.emit('call_offer', { to: peerId, offer });
}

function addCallTile(peerId, info) {
  if ($(`call-tile-${peerId}`)) return;
  const tile = document.createElement('div');
  tile.id = `call-tile-${peerId}`;
  tile.className = 'call-tile remote';
  tile.innerHTML = `<img src="${esc(safePic(info.picture))}" alt=""><video id="call-video-${peerId}" autoplay playsinline></video><span>${esc(info.username || 'User')}</span>`;
  $('call-stage').appendChild(tile);
  updateCallLayout();
}

function removePeer(peerId) {
  state.peers[peerId]?.pc.close();
  delete state.peers[peerId];
  $(`call-tile-${peerId}`)?.remove();
  updateCallStatus();
  updateCallLayout();
}

function updateCallStatus() {
  $('call-status').textContent = `${Object.keys(state.peers).length + 1} connected`;
}

function updateCallLayout() {
  const stage = $('call-stage');
  const hasVideo = !!stage.querySelector('.call-tile.has-video');
  const hasScreen = !!stage.querySelector('.call-tile.screen-share');
  stage.classList.toggle('video-mode', hasVideo);
  stage.classList.toggle('screen-mode', hasScreen);
}

async function toggleCamera() {
  if (!state.callId) return;
  const existing = state.localStream?.getVideoTracks()[0];
  if (existing) {
    existing.enabled = !existing.enabled;
    state.camOn = existing.enabled;
  } else {
    const video = $('cam-select').value ? { deviceId: { exact: $('cam-select').value } } : true;
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    const track = state.cameraStream.getVideoTracks()[0];
    state.localStream.addTrack(track);
    $('local-video').srcObject = state.localStream;
    state.camOn = true;
    for (const peerId of Object.keys(state.peers)) {
      state.peers[peerId].pc.addTrack(track, state.localStream);
      await sendOffer(peerId);
    }
  }
  $('local-call-tile').classList.toggle('has-video', state.camOn || !!state.screenStream);
  $('btn-call-camera').classList.toggle('off', !state.camOn);
  updateCallLayout();
}

function toggleMic() {
  state.micOn = !state.micOn;
  state.localStream?.getAudioTracks().forEach(track => { track.enabled = state.micOn && !state.pushToTalk; });
  $('btn-call-mic').classList.toggle('off', !state.micOn);
}

function toggleDeafen() {
  state.deafened = !state.deafened;
  document.querySelectorAll('.call-tile.remote video').forEach(video => { video.muted = state.deafened; });
  $('btn-call-deafen').classList.toggle('off', state.deafened);
}

async function shareScreen() {
  if (!state.callId) return;
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(track => track.stop());
    state.screenStream = null;
    $('btn-call-screen').classList.remove('active');
    $('local-call-tile').classList.remove('screen-share');
    $('local-video').srcObject = state.localStream;
    $('local-call-tile').classList.toggle('has-video', state.camOn);
    updateCallLayout();
    return;
  }
  state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  $('local-video').srcObject = state.screenStream;
  $('local-call-tile').classList.add('has-video', 'screen-share');
  $('btn-call-screen').classList.add('active');
  updateCallLayout();
  const track = state.screenStream.getVideoTracks()[0];
  track.onended = () => {
    state.screenStream = null;
    $('local-video').srcObject = state.localStream;
    $('local-call-tile').classList.remove('screen-share');
    $('local-call-tile').classList.toggle('has-video', state.camOn);
    $('btn-call-screen').classList.remove('active');
    updateCallLayout();
  };
  for (const peerId of Object.keys(state.peers)) {
    state.peers[peerId].pc.addTrack(track, state.screenStream);
    await sendOffer(peerId);
  }
}

function togglePushToTalk() {
  state.pushToTalk = !state.pushToTalk;
  $('btn-call-ptt').classList.toggle('active', state.pushToTalk);
  state.localStream?.getAudioTracks().forEach(track => { track.enabled = state.pushToTalk ? false : state.micOn; });
}

function bindCall() {
  $('btn-join-call').addEventListener('click', () => startCall());
  $('btn-call-leave').addEventListener('click', leaveCall);
  $('btn-call-camera').addEventListener('click', () => toggleCamera().catch(() => toast('Camera blocked')));
  $('btn-call-mic').addEventListener('click', toggleMic);
  $('btn-call-deafen').addEventListener('click', toggleDeafen);
  $('btn-call-screen').addEventListener('click', () => shareScreen().catch(() => {}));
  $('btn-call-invite').addEventListener('click', () => navigator.clipboard?.writeText(location.href));
  $('btn-call-ptt').addEventListener('click', togglePushToTalk);
  document.addEventListener('keydown', e => {
    if (state.pushToTalk && e.code === 'Space') state.localStream?.getAudioTracks().forEach(track => { track.enabled = true; });
  });
  document.addEventListener('keyup', e => {
    if (state.pushToTalk && e.code === 'Space') state.localStream?.getAudioTracks().forEach(track => { track.enabled = false; });
  });
}

function renderGame(game) {
  state.currentGame = game;
  $('game-area').classList.remove('hidden');
  const status = game.status === 'ended' ? winnerText(game) : game.status === 'waiting' ? 'Waiting for player' : `Turn: ${game.players[game.turn % 2]?.username || 'Player'}`;
  $('game-area').innerHTML = `<div class="row"><h3>${esc(game.type)} - ${esc(game.id)}</h3><button class="btn ghost" id="copy-game">Copy ID</button><span>${esc(status)}</span></div><div id="game-board"></div>`;
  $('copy-game').addEventListener('click', () => navigator.clipboard?.writeText(game.id));
  if (game.type === 'connect4') renderConnect4(game);
  else if (game.type === 'rps') renderRps(game);
  else if (game.type === 'memory') renderMemory(game);
  else if (game.type === 'trivia') renderTrivia(game);
  else if (game.type === 'checkers') renderCheckers(game);
  else renderTtt(game);
}

function winnerText(game) {
  return game.winner === 'draw' ? 'Draw' : `Winner: ${game.players[game.winner]?.username || 'Player'}`;
}

function move(move) {
  state.socket.emit('game_move', { gameId: state.currentGame.id, move });
}

function renderTtt(game) {
  $('game-board').className = 'board-ttt';
  $('game-board').innerHTML = game.board.map((v, i) => `<button data-i="${i}">${v === 0 ? 'X' : v === 1 ? 'O' : ''}</button>`).join('');
  document.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => move({ index: Number(btn.dataset.i) })));
}

function renderConnect4(game) {
  $('game-board').className = 'board-c4';
  $('game-board').innerHTML = game.board.map((v, i) => `<button class="${v === 0 ? 'p0' : v === 1 ? 'p1' : ''}" data-c="${i % 7}"></button>`).join('');
  document.querySelectorAll('[data-c]').forEach(btn => btn.addEventListener('click', () => move({ col: Number(btn.dataset.c) })));
}

function renderRps() {
  $('game-board').className = 'board-rps';
  $('game-board').innerHTML = ['rock','paper','scissors'].map(choice => `<button data-rps="${choice}">${choice}</button>`).join('');
  document.querySelectorAll('[data-rps]').forEach(btn => btn.addEventListener('click', () => move({ choice: btn.dataset.rps })));
}

function renderMemory(game) {
  $('game-board').className = 'board-memory';
  $('game-board').innerHTML = game.board.map((v, i) => `<button data-mem="${i}">${game.flipped.includes(i) || game.matched.includes(i) ? v + 1 : '?'}</button>`).join('');
  document.querySelectorAll('[data-mem]').forEach(btn => btn.addEventListener('click', () => move({ index: Number(btn.dataset.mem) })));
}

function renderTrivia(game) {
  $('game-board').className = 'board-trivia';
  $('game-board').innerHTML = `<h3>${esc(game.question.text)}</h3>${game.question.options.map((option, i) => `<button data-answer="${i}">${esc(option)}</button>`).join('')}`;
  document.querySelectorAll('[data-answer]').forEach(btn => btn.addEventListener('click', () => move({ answer: Number(btn.dataset.answer) })));
}

function renderCheckers(game) {
  $('game-board').className = 'board-checkers';
  $('game-board').innerHTML = game.board.map((v, i) => `<button class="${(Math.floor(i / 8) + i % 8) % 2 ? 'dark-cell' : ''} ${v === 0 ? 'p0' : v === 1 ? 'p1' : ''}" data-cell="${i}">${v === null ? '' : '●'}</button>`).join('');
  let selected = null;
  document.querySelectorAll('[data-cell]').forEach(btn => btn.addEventListener('click', () => {
    const cell = Number(btn.dataset.cell);
    if (selected === null) selected = cell;
    else { move({ from: selected, to: cell }); selected = null; }
  }));
}

bindAuth();
bindUi();
bindCall();
waitForGoogleSignIn();
if (state.user && state.token) startApp();
