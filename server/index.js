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
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_dev_secret_change_me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'gustavenglund69@gmail.com';

const users = new Map();
const emailIndex = new Map();
const bannedEmails = new Set();
const moderators = new Set();
const mutedUsers = new Set();
const rooms = new Map([
  ['general', { id:'general', name:'General', icon:'💬', desc:'Main hangout', messages:[], members:new Set() }],
  ['gaming',  { id:'gaming',  name:'Gaming',  icon:'🎮', desc:'Game talk',   messages:[], members:new Set() }],
  ['music',   { id:'music',   name:'Music',   icon:'🎵', desc:'Share tunes', messages:[], members:new Set() }],
  ['random',  { id:'random',  name:'Random',  icon:'🎲', desc:'Anything goes',messages:[],members:new Set() }],
]);
const onlineUsers = new Map();
const callRooms = new Map();
const gameRooms = new Map();

function signToken(u) { return jwt.sign({ id:u.id, username:u.username }, JWT_SECRET, { expiresIn:'30d' }); }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function getRole(u) { return u.email===ADMIN_EMAIL?'admin':moderators.has(u.id)?'moderator':'user'; }
function safeUser(u) { return { id:u.id, username:u.username, avatar:u.avatar, anon:!!u.anon, picture:u.picture, email:u.email, role:getRole(u), banned:bannedEmails.has(u.email), muted:mutedUsers.has(u.id) }; }
function isAdmin(u) { return u?.email===ADMIN_EMAIL; }
function isMod(u) { return isAdmin(u)||moderators.has(u?.id); }

app.post('/api/auth/register', async (req,res) => {
  const {username,email,password}=req.body;
  if(!username||!email||!password) return res.status(400).json({error:'All fields required'});
  if(emailIndex.has(email)) return res.status(400).json({error:'Email already registered'});
  if(bannedEmails.has(email)) return res.status(403).json({error:'This account has been banned'});
  const id=uuidv4(), hash=await bcrypt.hash(password,10);
  const user={id,username,email,passwordHash:hash,avatar:username[0].toUpperCase(),createdAt:Date.now()};
  users.set(id,user); emailIndex.set(email,id);
  res.json({token:signToken(user),user:safeUser(user)});
});

app.post('/api/auth/login', async (req,res) => {
  const {email,password}=req.body;
  const id=emailIndex.get(email);
  if(!id) return res.status(401).json({error:'Invalid credentials'});
  if(bannedEmails.has(email)) return res.status(403).json({error:'This account has been banned'});
  const user=users.get(id);
  if(!await bcrypt.compare(password,user.passwordHash)) return res.status(401).json({error:'Invalid credentials'});
  res.json({token:signToken(user),user:safeUser(user)});
});

app.post('/api/auth/anonymous', (req,res) => {
  const {username}=req.body;
  if(!username||username.trim().length<2) return res.status(400).json({error:'Name must be at least 2 characters'});
  const id='anon_'+uuidv4();
  const user={id,username:username.trim(),email:null,passwordHash:null,avatar:username[0].toUpperCase(),anon:true,createdAt:Date.now()};
  users.set(id,user);
  res.json({token:signToken(user),user:safeUser(user)});
});

app.post('/api/auth/google', (req,res) => {
  const {googleId,email,name,picture}=req.body;
  if(!googleId||!email) return res.status(400).json({error:'Invalid Google data'});
  if(bannedEmails.has(email)) return res.status(403).json({error:'This account has been banned'});
  let id=emailIndex.get(email), user;
  if(id){user=users.get(id);}
  else{id='google_'+googleId;user={id,username:name,email,passwordHash:null,avatar:name[0].toUpperCase(),picture,googleId,createdAt:Date.now()};users.set(id,user);emailIndex.set(email,id);}
  res.json({token:signToken(user),user:safeUser(user)});
});

app.get('/api/rooms',(req,res)=>{
  res.json(Array.from(rooms.values()).map(r=>({id:r.id,name:r.name,icon:r.icon,desc:r.desc,memberCount:r.members.size})));
});

function adminAuth(req,res,next){
  const token=req.headers.authorization?.split(' ')[1];
  const decoded=verifyToken(token);
  if(!decoded) return res.status(401).json({error:'Unauthorized'});
  const user=users.get(decoded.id);
  if(!isAdmin(user)) return res.status(403).json({error:'Admin only'});
  req.admin=user; next();
}
function modAuth(req,res,next){
  const token=req.headers.authorization?.split(' ')[1];
  const decoded=verifyToken(token);
  if(!decoded) return res.status(401).json({error:'Unauthorized'});
  const user=users.get(decoded.id);
  if(!isMod(user)) return res.status(403).json({error:'Moderator only'});
  req.mod=user; next();
}

app.get('/api/admin/users', adminAuth, (req,res) => res.json(Array.from(users.values()).map(safeUser)));
app.get('/api/admin/stats', modAuth, (req,res) => res.json({
  totalUsers:users.size, onlineUsers:onlineUsers.size, bannedUsers:bannedEmails.size,
  moderators:moderators.size, totalRooms:rooms.size,
  totalMessages:Array.from(rooms.values()).reduce((a,r)=>a+r.messages.length,0)
}));

app.post('/api/admin/ban', modAuth, (req,res) => {
  const user=users.get(req.body.userId);
  if(!user) return res.status(404).json({error:'User not found'});
  if(isAdmin(user)) return res.status(403).json({error:'Cannot ban admin'});
  if(user.email) bannedEmails.add(user.email);
  for(const [sid,info] of onlineUsers) if(info.userId===req.body.userId) io.to(sid).emit('force_logout',{reason:'You have been banned'});
  res.json({success:true});
});

app.post('/api/admin/unban', modAuth, (req,res) => {
  const user=users.get(req.body.userId);
  if(!user) return res.status(404).json({error:'User not found'});
  if(user.email) bannedEmails.delete(user.email);
  res.json({success:true});
});

app.post('/api/admin/kick', modAuth, (req,res) => {
  for(const [sid,info] of onlineUsers) if(info.userId===req.body.userId) io.to(sid).emit('force_logout',{reason:'You have been kicked by a moderator'});
  res.json({success:true});
});

app.post('/api/admin/mute', modAuth, (req,res) => {
  const user=users.get(req.body.userId);
  if(!user) return res.status(404).json({error:'User not found'});
  if(isAdmin(user)) return res.status(403).json({error:'Cannot mute admin'});
  mutedUsers.add(req.body.userId);
  io.emit('user_muted',{userId:req.body.userId});
  res.json({success:true});
});

app.post('/api/admin/unmute', modAuth, (req,res) => {
  mutedUsers.delete(req.body.userId);
  io.emit('user_unmuted',{userId:req.body.userId});
  res.json({success:true});
});

app.post('/api/admin/add-mod', adminAuth, (req,res) => {
  const user=users.get(req.body.userId);
  if(!user) return res.status(404).json({error:'User not found'});
  moderators.add(req.body.userId);
  io.emit('role_updated',{userId:req.body.userId,role:'moderator'});
  res.json({success:true});
});

app.post('/api/admin/remove-mod', adminAuth, (req,res) => {
  moderators.delete(req.body.userId);
  io.emit('role_updated',{userId:req.body.userId,role:'user'});
  res.json({success:true});
});

app.post('/api/admin/delete-message', modAuth, (req,res) => {
  const room=rooms.get(req.body.roomId);
  if(!room) return res.status(404).json({error:'Room not found'});
  room.messages=room.messages.filter(m=>m.id!==req.body.messageId);
  io.to(req.body.roomId).emit('message_deleted',{messageId:req.body.messageId});
  res.json({success:true});
});

app.post('/api/admin/clear-room', modAuth, (req,res) => {
  const room=rooms.get(req.body.roomId);
  if(!room) return res.status(404).json({error:'Room not found'});
  room.messages=[];
  io.to(req.body.roomId).emit('room_cleared');
  res.json({success:true});
});

io.use((socket,next) => {
  const token=socket.handshake.auth.token;
  const decoded=verifyToken(token);
  if(!decoded) return next(new Error('Unauthorized'));
  const user=users.get(decoded.id);
  if(!user) return next(new Error('User not found'));
  socket.user=safeUser(user); socket.userFull=user; next();
});

io.on('connection',(socket) => {
  const user=socket.user;
  onlineUsers.set(socket.id,{userId:user.id,username:user.username,roomId:null});
  broadcastOnlineCount();

  socket.on('join_room',(roomId) => {
    const room=rooms.get(roomId); if(!room) return;
    const prev=onlineUsers.get(socket.id);
    if(prev?.roomId){socket.leave(prev.roomId);rooms.get(prev.roomId)?.members.delete(socket.id);io.to(prev.roomId).emit('room_members',getRoomMembers(prev.roomId));socket.to(prev.roomId).emit('user_left',{username:user.username});}
    socket.join(roomId); room.members.add(socket.id); onlineUsers.get(socket.id).roomId=roomId;
    socket.emit('room_history',room.messages.slice(-50));
    io.to(roomId).emit('room_members',getRoomMembers(roomId));
    socket.to(roomId).emit('user_joined',{username:user.username});
  });

  socket.on('send_message',({roomId,content}) => {
    if(!content?.trim()||!roomId) return;
    if(mutedUsers.has(user.id)) return socket.emit('error_msg','You are muted and cannot send messages');
    const room=rooms.get(roomId); if(!room) return;
    const msg={id:uuidv4(),userId:user.id,username:user.username,avatar:user.avatar,content:content.trim(),timestamp:Date.now(),roomId,role:user.role};
    room.messages.push(msg); if(room.messages.length>200) room.messages.shift();
    io.to(roomId).emit('new_message',msg);
  });

  socket.on('typing',({roomId,typing}) => socket.to(roomId).emit('user_typing',{username:user.username,typing}));

  socket.on('mod_delete_message',({roomId,messageId}) => {
    if(!isMod(socket.userFull)) return;
    const room=rooms.get(roomId); if(!room) return;
    room.messages=room.messages.filter(m=>m.id!==messageId);
    io.to(roomId).emit('message_deleted',{messageId});
  });

  socket.on('call_join',({callId}) => {
    if(!callRooms.has(callId)) callRooms.set(callId,new Set());
    const peers=Array.from(callRooms.get(callId));
    callRooms.get(callId).add(socket.id); socket.join('call_'+callId);
    peers.forEach(peerId=>io.to(peerId).emit('call_peer_joined',{peerId:socket.id,username:user.username}));
    socket.emit('call_existing_peers',{peers,callId});
  });
  socket.on('call_offer',({to,offer})=>io.to(to).emit('call_offer',{from:socket.id,offer,username:user.username}));
  socket.on('call_answer',({to,answer})=>io.to(to).emit('call_answer',{from:socket.id,answer}));
  socket.on('call_ice',({to,candidate})=>io.to(to).emit('call_ice',{from:socket.id,candidate}));
  socket.on('call_leave',({callId})=>leaveCall(socket,callId));

  socket.on('game_create',({type}) => {
    const gameId=uuidv4().slice(0,6).toUpperCase();
    const game=createGame(type,gameId,user);
    gameRooms.set(gameId,game); socket.join('game_'+gameId);
    socket.emit('game_created',{gameId,game:publicGame(game)});
  });
  socket.on('game_join',({gameId}) => {
    const game=gameRooms.get(gameId);
    if(!game) return socket.emit('game_error','Game not found');
    if(game.players.length>=2) return socket.emit('game_error','Game is full');
    if(game.players.find(p=>p.id===user.id)) return socket.emit('game_error','Already in game');
    game.players.push({id:user.id,username:user.username,avatar:user.avatar}); game.status='playing';
    socket.join('game_'+gameId); io.to('game_'+gameId).emit('game_updated',publicGame(game));
  });
  socket.on('game_move',({gameId,move}) => {
    const game=gameRooms.get(gameId); if(!game) return;
    const result=applyMove(game,move,user.id);
    if(result.error) return socket.emit('game_error',result.error);
    io.to('game_'+gameId).emit('game_updated',publicGame(game));
  });
  socket.on('game_rematch',({gameId}) => {
    const game=gameRooms.get(gameId); if(!game) return;
    resetGame(game); io.to('game_'+gameId).emit('game_updated',publicGame(game));
  });

  socket.on('disconnect',() => {
    const info=onlineUsers.get(socket.id);
    if(info?.roomId){rooms.get(info.roomId)?.members.delete(socket.id);io.to(info.roomId).emit('room_members',getRoomMembers(info.roomId));socket.to(info.roomId).emit('user_left',{username:user.username});}
    callRooms.forEach((set,callId)=>{if(set.has(socket.id))leaveCall(socket,callId);});
    onlineUsers.delete(socket.id); broadcastOnlineCount();
  });
});

function broadcastOnlineCount(){io.emit('online_count',onlineUsers.size);}
function getRoomMembers(roomId){
  const room=rooms.get(roomId); if(!room) return [];
  return Array.from(room.members).map(sid=>{const info=onlineUsers.get(sid);const u=info?users.get(info.userId):null;return u?safeUser(u):null;}).filter(Boolean);
}
function leaveCall(socket,callId){
  const set=callRooms.get(callId); if(!set) return;
  set.delete(socket.id); socket.leave('call_'+callId);
  io.to('call_'+callId).emit('call_peer_left',{peerId:socket.id});
  if(set.size===0)callRooms.delete(callId);
}
function createGame(type,id,user){
  const base={id,type,players:[{id:user.id,username:user.username,avatar:user.avatar}],status:'waiting',winner:null,createdAt:Date.now()};
  if(type==='tictactoe')return{...base,board:Array(9).fill(null),turn:0};
  if(type==='connect4')return{...base,board:Array(42).fill(null),turn:0};
  if(type==='chess')return{...base,...initChess()};
  return base;
}
function publicGame(g){return{...g};}
function resetGame(game){
  game.winner=null;game.status='playing';
  if(game.type==='tictactoe'){game.board=Array(9).fill(null);game.turn=0;}
  if(game.type==='connect4'){game.board=Array(42).fill(null);game.turn=0;}
  if(game.type==='chess'){Object.assign(game,initChess());}
}
function applyMove(game,move,userId){
  if(game.status!=='playing')return{error:'Game not active'};
  const pidx=game.players.findIndex(p=>p.id===userId);
  if(pidx<0)return{error:'Not a player'};
  if(game.type==='tictactoe')return moveTTT(game,move,pidx);
  if(game.type==='connect4')return moveC4(game,move,pidx);
  if(game.type==='chess')return moveChess(game,move,userId);
  return{error:'Unknown game'};
}
function moveTTT(game,{index},pidx){
  if(game.turn%2!==pidx)return{error:'Not your turn'};
  if(game.board[index]!==null)return{error:'Cell taken'};
  game.board[index]=pidx;game.turn++;
  const w=checkTTT(game.board);
  if(w!==null){game.winner=w;game.status='ended';}else if(game.turn===9){game.winner='draw';game.status='ended';}
  return{};
}
function checkTTT(b){const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];for(const[a,c,d]of lines)if(b[a]!==null&&b[a]===b[c]&&b[a]===b[d])return b[a];return null;}
function moveC4(game,{col},pidx){
  if(game.turn%2!==pidx)return{error:'Not your turn'};
  const COLS=7,ROWS=6;let row=-1;
  for(let r=ROWS-1;r>=0;r--){if(game.board[r*COLS+col]===null){row=r;break;}}
  if(row<0)return{error:'Column full'};
  game.board[row*COLS+col]=pidx;game.turn++;
  if(checkC4(game.board,row,col,pidx)){game.winner=pidx;game.status='ended';}else if(game.turn===42){game.winner='draw';game.status='ended';}
  return{};
}
function checkC4(b,r,c,p){const COLS=7,ROWS=6,dirs=[[0,1],[1,0],[1,1],[1,-1]];for(const[dr,dc]of dirs){let cnt=1;for(let d=1;d<4;d++){const nr=r+dr*d,nc=c+dc*d;if(nr<0||nr>=ROWS||nc<0||nc>=COLS||b[nr*COLS+nc]!==p)break;cnt++;}for(let d=1;d<4;d++){const nr=r-dr*d,nc=c-dc*d;if(nr<0||nr>=ROWS||nc<0||nc>=COLS||b[nr*COLS+nc]!==p)break;cnt++;}if(cnt>=4)return true;}return false;}
function initChess(){const board=Array(64).fill(null),back=['R','N','B','Q','K','B','N','R'];for(let i=0;i<8;i++){board[i]=`b${back[i]}`;board[8+i]=`bP`;board[48+i]=`wP`;board[56+i]=`w${back[i]}`;}return{board,turn:0};}
function moveChess(game,{from,to},userId){
  const pidx=game.players.findIndex(p=>p.id===userId);
  const color=pidx===0?'w':'b';
  if((game.turn%2===0&&color!=='w')||(game.turn%2===1&&color!=='b'))return{error:'Not your turn'};
  const piece=game.board[from];
  if(!piece||piece[0]!==color)return{error:'Not your piece'};
  const captured=game.board[to];
  game.board[to]=piece;game.board[from]=null;
  if(piece==='wP'&&Math.floor(to/8)===0)game.board[to]='wQ';
  if(piece==='bP'&&Math.floor(to/8)===7)game.board[to]='bQ';
  game.turn++;
  if(captured==='wK'){game.winner=1;game.status='ended';}
  if(captured==='bK'){game.winner=0;game.status='ended';}
  return{};
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n🚀 Nexus Chat running → http://localhost:${PORT}\n`));
