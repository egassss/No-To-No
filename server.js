// Bharat Pulse - Backend Server
// Run with: node server.js
// Accessible from any device on the same WiFi at http://<your-PC-LAN-IP>:3000

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// ---------- DB SETUP ----------
const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({ users: [], posts: [], comments: [], conversations: [], messages: [], notifications: [] }).write();

// ---------- APP SETUP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 180, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// ---------- FILE UPLOAD (images + video) ----------
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) return cb(new Error('Only image or video files are allowed'));
    cb(null, true);
  }
});

// ---------- HELPERS ----------
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

function publicUser(u) {
  if (!u) return null;
  const { password, failedAttempts, lockUntil, blockedUsers, bookmarks, muted, ...rest } = u;
  return { ...rest, followerCount: (u.followers || []).length, followingCount: (u.following || []).length };
}

function sanitizeText(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen || 1000);
}

function extractHashtags(text) {
  const matches = text.match(/#[a-zA-Z0-9_]+/g) || [];
  return [...new Set(matches.map(h => h.slice(1).toLowerCase()))];
}

function extractMentions(text) {
  const matches = text.match(/@[a-zA-Z0-9_.]+/g) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

function pushNotification({ toUserId, type, fromUserId, postId, text }) {
  if (toUserId === fromUserId) return;
  const note = { id: uuidv4(), userId: toUserId, type, fromUserId, postId: postId || null, text: text || '', read: false, createdAt: Date.now() };
  db.get('notifications').push(note).write();
  const fromUser = db.get('users').find({ id: fromUserId }).value();
  io.to('user_' + toUserId).emit('newNotification', { ...note, fromUser: fromUser ? { displayName: fromUser.displayName, avatar: fromUser.avatar } : null });
}

function isBlockedEitherWay(userA, userB) {
  const a = db.get('users').find({ id: userA }).value();
  const b = db.get('users').find({ id: userB }).value();
  if (!a || !b) return false;
  return (a.blockedUsers || []).includes(userB) || (b.blockedUsers || []).includes(userA);
}

function decoratePost(post) {
  const user = db.get('users').find({ id: post.userId }).value();
  return {
    ...post,
    author: user ? { id: user.id, displayName: user.displayName, avatar: user.avatar, online: user.online } : { displayName: 'Deleted User', avatar: null, online: false }
  };
}

function cleanupExpired() {
  const now = Date.now();
  const all = db.get('posts').value();
  const alive = all.filter(p => now - p.createdAt < p.expireHours * 3600000);
  if (alive.length !== all.length) db.set('posts', alive).write();
}

// ---------- AUTH ROUTES ----------
app.post('/api/signup', authLimiter, async (req, res) => {
  const username = sanitizeText(req.body.username, 30).toLowerCase().replace(/[^a-z0-9_.]/g, '');
  const password = req.body.password || '';
  const displayName = sanitizeText(req.body.displayName, 40) || username;

  if (!username || username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters (letters, numbers, _ or .)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.get('users').find({ username }).value();
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    displayName,
    password: hashed,
    avatar: null,
    bio: '',
    createdAt: Date.now(),
    failedAttempts: 0,
    lockUntil: 0,
    blockedUsers: [],
    followers: [],
    following: [],
    bookmarks: [],
    muted: [],
    online: false,
    lastSeen: Date.now(),
    settings: { ghostMode: false, blurLocation: false, radiusKm: 25, mapStyle: 'dark', unit: 'km', notifications: true, accentColor: '#00e6a8', theme: 'dark', pixelMode: false }
  };
  db.get('users').push(user).write();

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const username = sanitizeText(req.body.username, 30).toLowerCase();
  const password = req.body.password || '';
  const userRef = db.get('users').find({ username });
  const user = userRef.value();
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  if (user.lockUntil && user.lockUntil > Date.now()) {
    const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    const attempts = (user.failedAttempts || 0) + 1;
    const patch = { failedAttempts: attempts };
    if (attempts >= MAX_FAILED_ATTEMPTS) { patch.lockUntil = Date.now() + LOCK_DURATION_MS; patch.failedAttempts = 0; }
    userRef.assign(patch).write();
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  userRef.assign({ failedAttempts: 0, lockUntil: 0 }).write();
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.get('users').find({ id: req.userId }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

app.put('/api/me', auth, (req, res) => {
  const { displayName, bio, settings } = req.body;
  const userRef = db.get('users').find({ id: req.userId });
  if (displayName !== undefined) userRef.assign({ displayName: sanitizeText(displayName, 40) }).write();
  if (bio !== undefined) userRef.assign({ bio: sanitizeText(bio, 150) }).write();
  if (settings !== undefined) {
    const current = userRef.value().settings || {};
    userRef.assign({ settings: { ...current, ...settings } }).write();
  }
  res.json(publicUser(userRef.value()));
});

app.post('/api/me/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid image uploaded' });
  const url = '/uploads/' + req.file.filename;
  db.get('users').find({ id: req.userId }).assign({ avatar: url }).write();
  res.json({ avatar: url });
});

app.get('/api/me/export', auth, (req, res) => {
  const user = publicUser(db.get('users').find({ id: req.userId }).value());
  const myPosts = db.get('posts').value().filter(p => p.userId === req.userId);
  const myComments = db.get('comments').value().filter(c => c.userId === req.userId);
  res.json({ user, posts: myPosts, comments: myComments, exportedAt: Date.now() });
});

app.delete('/api/me', auth, (req, res) => {
  db.get('posts').remove({ userId: req.userId }).write();
  db.get('comments').remove({ userId: req.userId }).write();
  db.get('conversations').remove(c => c.participants.includes(req.userId)).write();
  db.get('messages').remove(m => m.senderId === req.userId).write();
  db.get('notifications').remove(n => n.userId === req.userId || n.fromUserId === req.userId).write();
  db.get('users').remove({ id: req.userId }).write();
  res.json({ success: true });
});

// ---------- USER SEARCH / BLOCK / MUTE / FOLLOW ----------
app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const me = db.get('users').find({ id: req.userId }).value();
  const results = db.get('users').value()
    .filter(u => u.id !== req.userId)
    .filter(u => u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .filter(u => !(me.blockedUsers || []).includes(u.id) && !((u.blockedUsers || []).includes(req.userId)))
    .slice(0, 10)
    .map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar }));
  res.json(results);
});

app.get('/api/users/by-username/:username', auth, (req, res) => {
  const user = db.get('users').find({ username: req.params.username.toLowerCase() }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, displayName: user.displayName, username: user.username, avatar: user.avatar });
});

app.post('/api/users/:id/block', auth, (req, res) => {
  const userRef = db.get('users').find({ id: req.userId });
  const current = userRef.value().blockedUsers || [];
  const target = req.params.id;
  const updated = current.includes(target) ? current.filter(id => id !== target) : [...current, target];
  userRef.assign({ blockedUsers: updated }).write();
  res.json({ blocked: updated.includes(target) });
});

app.post('/api/users/:id/mute', auth, (req, res) => {
  const ref = db.get('users').find({ id: req.userId });
  const current = ref.value().muted || [];
  const target = req.params.id;
  const updated = current.includes(target) ? current.filter(id => id !== target) : [...current, target];
  ref.assign({ muted: updated }).write();
  res.json({ muted: updated.includes(target) });
});

app.post('/api/users/:id/follow', auth, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
  const meRef = db.get('users').find({ id: req.userId });
  const targetRef = db.get('users').find({ id: targetId });
  if (!targetRef.value()) return res.status(404).json({ error: 'User not found' });

  const myFollowing = meRef.value().following || [];
  const alreadyFollowing = myFollowing.includes(targetId);
  meRef.assign({ following: alreadyFollowing ? myFollowing.filter(id => id !== targetId) : [...myFollowing, targetId] }).write();

  const theirFollowers = targetRef.value().followers || [];
  const newFollowers = alreadyFollowing ? theirFollowers.filter(id => id !== req.userId) : [...theirFollowers, req.userId];
  targetRef.assign({ followers: newFollowers }).write();

  if (!alreadyFollowing) pushNotification({ toUserId: targetId, type: 'follow', fromUserId: req.userId, text: 'started following you' });
  res.json({ following: !alreadyFollowing, followerCount: newFollowers.length });
});

app.get('/api/users/:id/profile', auth, (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const posts = db.get('posts').value()
    .filter(p => p.userId === user.id && !p.hidden && Date.now() - p.createdAt < p.expireHours * 3600000)
    .sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt))
    .map(decoratePost);
  res.json({
    id: user.id, displayName: user.displayName, username: user.username, avatar: user.avatar, bio: user.bio,
    online: user.online, lastSeen: user.lastSeen,
    followerCount: (user.followers || []).length,
    followingCount: (user.following || []).length,
    isFollowing: (user.followers || []).includes(req.userId),
    isMe: user.id === req.userId,
    posts
  });
});

// ---------- POST ROUTES ----------
app.get('/api/posts', auth, (req, res) => {
  cleanupExpired();
  const me = db.get('users').find({ id: req.userId }).value();
  const blocked = me ? (me.blockedUsers || []) : [];
  const posts = db.get('posts').value()
    .filter(p => !p.hidden)
    .filter(p => p.isFlare || !blocked.includes(p.userId))
    .filter(p => !(me && (me.muted || []).includes(p.userId)))
    .filter(p => {
      const author = db.get('users').find({ id: p.userId }).value();
      return !(author && (author.blockedUsers || []).includes(req.userId));
    })
    .map(decoratePost)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({ ...p, bookmarked: (me && (me.bookmarks || []).includes(p.id)) || false }));
  res.json(posts);
});

app.post('/api/posts', auth, upload.single('media'), (req, res) => {
  const text = sanitizeText(req.body.text, 500);
  const { lat, lng, category, expireHours, isFlare, tags } = req.body;
  if (!text) return res.status(400).json({ error: 'Post text is required' });
  if (lat === undefined || lng === undefined || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
    return res.status(400).json({ error: 'Valid location is required' });
  }

  let parsedTags = [];
  try { parsedTags = JSON.parse(tags || '[]'); } catch (e) { parsedTags = []; }
  parsedTags = Array.isArray(parsedTags) ? parsedTags.map(t => sanitizeText(String(t), 24).toLowerCase()).filter(Boolean).slice(0, 8) : [];

  const isVideo = req.file && req.file.mimetype.startsWith('video/');

  const post = {
    id: uuidv4(),
    userId: req.userId,
    text,
    image: req.file && !isVideo ? '/uploads/' + req.file.filename : null,
    video: req.file && isVideo ? '/uploads/' + req.file.filename : null,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    category: sanitizeText(category, 20) || 'General',
    tags: parsedTags,
    hashtags: extractHashtags(text),
    isFlare: isFlare === 'true' || isFlare === true,
    upvotes: [],
    loves: [],
    reports: [],
    views: 0,
    pinned: false,
    hidden: false,
    createdAt: Date.now(),
    expireHours: Math.min(parseFloat(expireHours) || 24, 168)
  };
  db.get('posts').push(post).write();

  const decorated = decoratePost(post);
  io.emit('newPost', decorated);

  extractMentions(text).forEach(username => {
    const mentioned = db.get('users').find({ username }).value();
    if (mentioned) pushNotification({ toUserId: mentioned.id, type: 'mention', fromUserId: req.userId, postId: post.id, text: 'mentioned you in a post' });
  });

  res.json(decorated);
});

app.put('/api/posts/:id', auth, (req, res) => {
  const postRef = db.get('posts').find({ id: req.params.id });
  const post = postRef.value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Not your post' });
  if (Date.now() - post.createdAt > 5 * 60000) return res.status(400).json({ error: 'Edit window (5 min) has expired' });
  const text = sanitizeText(req.body.text, 500);
  if (!text) return res.status(400).json({ error: 'Post text is required' });
  const hashtags = extractHashtags(text);
  postRef.assign({ text, hashtags }).write();
  io.emit('editPost', { postId: req.params.id, text, hashtags });
  res.json({ success: true });
});

app.post('/api/posts/:id/upvote', auth, (req, res) => {
  const postRef = db.get('posts').find({ id: req.params.id });
  const post = postRef.value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const upvotes = post.upvotes || [];
  const already = upvotes.includes(req.userId);
  const updated = already ? upvotes.filter(id => id !== req.userId) : [...upvotes, req.userId];
  postRef.assign({ upvotes: updated }).write();
  io.emit('upvoteUpdate', { postId: req.params.id, upvotes: updated });
  if (!already) pushNotification({ toUserId: post.userId, type: 'upvote', fromUserId: req.userId, postId: post.id, text: 'upvoted your post' });
  res.json({ upvotes: updated });
});

app.post('/api/posts/:id/love', auth, (req, res) => {
  const postRef = db.get('posts').find({ id: req.params.id });
  const post = postRef.value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const loves = post.loves || [];
  const already = loves.includes(req.userId);
  const updated = already ? loves.filter(id => id !== req.userId) : [...loves, req.userId];
  postRef.assign({ loves: updated }).write();
  io.emit('loveUpdate', { postId: req.params.id, loves: updated });
  res.json({ loves: updated });
});

app.post('/api/posts/:id/view', auth, (req, res) => {
  const postRef = db.get('posts').find({ id: req.params.id });
  const post = postRef.value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  postRef.assign({ views: (post.views || 0) + 1 }).write();
  res.json({ views: (post.views || 0) + 1 });
});

app.post('/api/posts/:id/pin', auth, (req, res) => {
  const post = db.get('posts').find({ id: req.params.id }).value();
  if (!post || post.userId !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  const newPinned = !post.pinned;
  db.get('posts').value().filter(p => p.userId === req.userId).forEach(p => {
    db.get('posts').find({ id: p.id }).assign({ pinned: p.id === post.id ? newPinned : false }).write();
  });
  res.json({ pinned: newPinned });
});

app.post('/api/posts/:id/report', auth, (req, res) => {
  const postRef = db.get('posts').find({ id: req.params.id });
  const post = postRef.value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const reports = post.reports || [];
  if (!reports.includes(req.userId)) reports.push(req.userId);
  const hidden = reports.length >= 3;
  postRef.assign({ reports, hidden }).write();
  if (hidden) io.emit('deletePost', { postId: req.params.id });
  res.json({ reported: true, hidden });
});

app.post('/api/posts/:id/bookmark', auth, (req, res) => {
  const userRef = db.get('users').find({ id: req.userId });
  const current = userRef.value().bookmarks || [];
  const postId = req.params.id;
  const updated = current.includes(postId) ? current.filter(id => id !== postId) : [...current, postId];
  userRef.assign({ bookmarks: updated }).write();
  res.json({ bookmarked: updated.includes(postId) });
});

app.get('/api/bookmarks', auth, (req, res) => {
  const me = db.get('users').find({ id: req.userId }).value();
  const ids = me ? (me.bookmarks || []) : [];
  const posts = db.get('posts').value().filter(p => ids.includes(p.id) && !p.hidden).map(decoratePost);
  res.json(posts);
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const post = db.get('posts').find({ id: req.params.id }).value();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.userId !== req.userId) return res.status(403).json({ error: 'Not your post' });
  db.get('posts').remove({ id: req.params.id }).write();
  db.get('comments').remove({ postId: req.params.id }).write();
  io.emit('deletePost', { postId: req.params.id });
  res.json({ success: true });
});

// ---------- TAGS / HASHTAGS / SEARCH (worldwide) ----------
app.get('/api/tags/suggest', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const posts = db.get('posts').value().filter(p => !p.hidden);
  const counts = {};
  posts.forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  let list = Object.keys(counts).map(t => ({ tag: t, count: counts[t] }));
  if (q) list = list.filter(item => item.tag.includes(q));
  list.sort((a, b) => b.count - a.count);
  res.json(list.slice(0, 10));
});

app.get('/api/hashtags/suggest', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const posts = db.get('posts').value().filter(p => !p.hidden);
  const counts = {};
  posts.forEach(p => (p.hashtags || []).forEach(h => { counts[h] = (counts[h] || 0) + 1; }));
  let list = Object.keys(counts).map(h => ({ hashtag: h, count: counts[h] }));
  if (q) list = list.filter(item => item.hashtag.includes(q));
  list.sort((a, b) => b.count - a.count);
  res.json(list.slice(0, 10));
});

app.get('/api/search', auth, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ posts: [], tags: [], hashtags: [], locations: [] });

  const posts = db.get('posts').value()
    .filter(p => !p.hidden)
    .filter(p => p.text.toLowerCase().includes(q) || (p.tags || []).some(t => t.includes(q)) || (p.hashtags || []).some(h => h.includes(q)))
    .slice(0, 8)
    .map(decoratePost);

  const tagCounts = {}, hashCounts = {};
  db.get('posts').value().filter(p => !p.hidden).forEach(p => {
    (p.tags || []).forEach(t => { if (t.includes(q)) tagCounts[t] = (tagCounts[t] || 0) + 1; });
    (p.hashtags || []).forEach(h => { if (h.includes(q)) hashCounts[h] = (hashCounts[h] || 0) + 1; });
  });
  const tags = Object.keys(tagCounts).map(t => ({ tag: t, count: tagCounts[t] })).sort((a, b) => b.count - a.count).slice(0, 5);
  const hashtags = Object.keys(hashCounts).map(h => ({ hashtag: h, count: hashCounts[h] })).sort((a, b) => b.count - a.count).slice(0, 5);

  let locations = [];
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(req.query.q)}`, {
      headers: { 'User-Agent': 'BharatPulse-Demo/1.0' }
    });
    if (geoRes.ok) {
      const geoData = await geoRes.json();
      locations = geoData.map(g => ({ name: g.display_name, lat: parseFloat(g.lat), lng: parseFloat(g.lon) }));
    }
  } catch (e) { /* geocoding is best-effort */ }

  res.json({ posts, tags, hashtags, locations });
});

// ---------- COMMENTS (with likes + nested replies) ----------
app.get('/api/posts/:id/comments', auth, (req, res) => {
  const comments = db.get('comments').filter({ postId: req.params.id }).value()
    .map(c => {
      const user = db.get('users').find({ id: c.userId }).value();
      return { ...c, author: user ? { displayName: user.displayName, avatar: user.avatar } : { displayName: 'Deleted User' } };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json(comments);
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const text = sanitizeText(req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Comment text required' });
  const comment = { id: uuidv4(), postId: req.params.id, userId: req.userId, text, parentId: req.body.parentId || null, likes: [], createdAt: Date.now() };
  db.get('comments').push(comment).write();
  const user = db.get('users').find({ id: req.userId }).value();
  const decorated = { ...comment, author: { displayName: user.displayName, avatar: user.avatar } };
  io.to('post_' + req.params.id).emit('newComment', decorated);

  const post = db.get('posts').find({ id: req.params.id }).value();
  if (post) pushNotification({ toUserId: post.userId, type: 'comment', fromUserId: req.userId, postId: post.id, text: 'commented on your post' });

  res.json(decorated);
});

app.post('/api/comments/:id/like', auth, (req, res) => {
  const ref = db.get('comments').find({ id: req.params.id });
  const c = ref.value();
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  const likes = c.likes || [];
  const already = likes.includes(req.userId);
  const updated = already ? likes.filter(id => id !== req.userId) : [...likes, req.userId];
  ref.assign({ likes: updated }).write();
  io.to('post_' + c.postId).emit('commentLikeUpdate', { commentId: req.params.id, likes: updated });
  res.json({ likes: updated });
});

// ---------- CHAT: CONVERSATIONS & MESSAGES ----------
app.get('/api/conversations', auth, (req, res) => {
  const all = db.get('conversations').value().filter(c => c.participants.includes(req.userId));
  const result = all.map(c => {
    const otherId = c.participants.find(id => id !== req.userId);
    const otherUser = db.get('users').find({ id: otherId }).value();
    const msgs = db.get('messages').filter({ conversationId: c.id }).value().sort((a, b) => a.createdAt - b.createdAt);
    const lastMessage = msgs[msgs.length - 1] || null;
    const unreadCount = msgs.filter(m => m.senderId !== req.userId && !(m.readBy || []).includes(req.userId)).length;
    return {
      id: c.id,
      otherUser: otherUser ? { id: otherUser.id, displayName: otherUser.displayName, avatar: otherUser.avatar, online: otherUser.online } : { displayName: 'Deleted User' },
      lastMessage,
      unreadCount
    };
  }).sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : 0) - (a.lastMessage ? a.lastMessage.createdAt : 0));
  res.json(result);
});

app.post('/api/conversations', auth, (req, res) => {
  const otherUserId = req.body.otherUserId;
  if (!otherUserId || otherUserId === req.userId) return res.status(400).json({ error: 'Invalid user' });
  if (isBlockedEitherWay(req.userId, otherUserId)) return res.status(403).json({ error: 'Cannot message this user' });

  let convo = db.get('conversations').value().find(c => c.participants.includes(req.userId) && c.participants.includes(otherUserId));
  if (!convo) {
    convo = { id: uuidv4(), participants: [req.userId, otherUserId], createdAt: Date.now() };
    db.get('conversations').push(convo).write();
  }
  res.json(convo);
});

app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const convo = db.get('conversations').find({ id: req.params.id }).value();
  if (!convo || !convo.participants.includes(req.userId)) return res.status(403).json({ error: 'Not your conversation' });

  const msgs = db.get('messages').filter({ conversationId: req.params.id }).value().sort((a, b) => a.createdAt - b.createdAt);
  msgs.forEach(m => {
    if (m.senderId !== req.userId && !(m.readBy || []).includes(req.userId)) {
      db.get('messages').find({ id: m.id }).assign({ readBy: [...(m.readBy || []), req.userId] }).write();
    }
  });
  res.json(msgs);
});

app.post('/api/conversations/:id/messages', auth, (req, res) => {
  const text = sanitizeText(req.body.text, 1000);
  if (!text) return res.status(400).json({ error: 'Message text required' });

  const convo = db.get('conversations').find({ id: req.params.id }).value();
  if (!convo || !convo.participants.includes(req.userId)) return res.status(403).json({ error: 'Not your conversation' });

  const otherId = convo.participants.find(id => id !== req.userId);
  if (isBlockedEitherWay(req.userId, otherId)) return res.status(403).json({ error: 'Cannot message this user' });

  const message = { id: uuidv4(), conversationId: req.params.id, senderId: req.userId, text, createdAt: Date.now(), readBy: [req.userId] };
  db.get('messages').push(message).write();

  io.to('user_' + otherId).emit('newMessage', message);
  io.to('user_' + req.userId).emit('newMessage', message);
  res.json(message);
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const m = db.get('messages').find({ id: req.params.id }).value();
  if (!m || m.senderId !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  db.get('messages').remove({ id: req.params.id }).write();
  const convo = db.get('conversations').find({ id: m.conversationId }).value();
  if (convo) convo.participants.forEach(uid => io.to('user_' + uid).emit('deleteMessage', { id: m.id, conversationId: m.conversationId }));
  res.json({ success: true });
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, (req, res) => {
  const notes = db.get('notifications').filter({ userId: req.userId }).value()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(n => {
      const fromUser = db.get('users').find({ id: n.fromUserId }).value();
      return { ...n, fromUser: fromUser ? { id: fromUser.id, displayName: fromUser.displayName, avatar: fromUser.avatar } : null };
    });
  res.json(notes);
});

app.post('/api/notifications/read', auth, (req, res) => {
  const notes = db.get('notifications').filter({ userId: req.userId, read: false }).value();
  notes.forEach(n => db.get('notifications').find({ id: n.id }).assign({ read: true }).write());
  res.json({ success: true });
});

// ---------- SOCKET.IO ----------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch (e) {
    next(new Error('Invalid session'));
  }
});

let onlineCount = 0;

io.on('connection', (socket) => {
  socket.join('user_' + socket.userId);
  socket.on('joinPost', (postId) => socket.join('post_' + postId));
  socket.on('leavePost', (postId) => socket.leave('post_' + postId));
  socket.on('typing', ({ conversationId, otherUserId }) => {
    io.to('user_' + otherUserId).emit('typing', { conversationId, from: socket.userId });
  });

  db.get('users').find({ id: socket.userId }).assign({ online: true, lastSeen: Date.now() }).write();
  io.emit('presenceUpdate', { userId: socket.userId, online: true });
  onlineCount++; io.emit('onlineCount', onlineCount);

  socket.on('disconnect', () => {
    db.get('users').find({ id: socket.userId }).assign({ online: false, lastSeen: Date.now() }).write();
    io.emit('presenceUpdate', { userId: socket.userId, online: false });
    onlineCount--; io.emit('onlineCount', onlineCount);
  });
});

setInterval(cleanupExpired, 5 * 60 * 1000);

// ---------- START ----------
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) lanIPs.push(net.address);
    }
  }
  console.log('\n=== Bharat Pulse server running ===');
  console.log(`Local:   http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`Network: http://${ip}:${PORT}  <-- open this on your phone (same WiFi)`));
  console.log('====================================\n');
});
