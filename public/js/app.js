// ===================== STATE =====================
let token = localStorage.getItem('bp_token') || null;
let currentUser = null;
let map = null, tileLayer = null, accuracyCircle = null, myMarker = null;
let userLocation = null;
let bestAccuracySoFar = Infinity;
let posts = [];
let mapMarkers = {};
let selectedTags = [];
let selectedImageFile = null;
let socket = null;
let activeCommentsPostId = null;
let replyTargetId = null;
let activeFilter = null;
let searchDebounce = null, tagDebounce = null, chatUserDebounce = null, typingTimeout = null;
let conversations = [];
let activeConversationId = null, activeConversationOtherUser = null;
let currentProfileId = null;
let settings = { ghostMode:false, blurLocation:false, radiusKm:25, mapStyle:'dark', unit:'km', notifications:true, accentColor:'#00e6a8', theme:'dark', pixelMode:false };

// ===================== AUTH =====================
function showForm(which){
  document.getElementById('login-form').classList.toggle('hidden', which!=='login');
  document.getElementById('signup-form').classList.toggle('hidden', which!=='signup');
}

async function handleSignup(){
  const displayName = document.getElementById('signup-displayname').value.trim();
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  try{
    const res = await fetch('/api/signup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username, password, displayName}) });
    const data = await res.json();
    if(!res.ok) return errEl.textContent = data.error;
    completeLogin(data);
  }catch(e){ errEl.textContent = 'Could not reach server.'; }
}

async function handleLogin(){
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try{
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username, password}) });
    const data = await res.json();
    if(!res.ok) return errEl.textContent = data.error;
    completeLogin(data);
  }catch(e){ errEl.textContent = 'Could not reach server.'; }
}

function completeLogin(data){
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('bp_token', token);
  settings = { ...settings, ...(currentUser.settings || {}) };
  boot();
}

function logout(){
  localStorage.removeItem('bp_token');
  location.reload();
}

async function tryAutoLogin(){
  if(!token) return false;
  try{
    const res = await fetch('/api/me', { headers: authHeaders() });
    if(!res.ok) return false;
    currentUser = await res.json();
    settings = { ...settings, ...(currentUser.settings || {}) };
    return true;
  }catch(e){ return false; }
}

function authHeaders(extra){
  return { 'Authorization': 'Bearer ' + token, ...(extra||{}) };
}

// ===================== BOOT =====================
async function boot(){
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('my-name').textContent = currentUser.displayName;
  if(currentUser.avatar){
    document.getElementById('my-avatar').src = currentUser.avatar;
    document.getElementById('profile-avatar-preview').src = currentUser.avatar;
  }
  loadSettingsUI();
  initSocket();
  initMap();
  startLocationTracking();
  await loadPosts();
  await loadConversations();
  await loadNotifications();
  await loadTrending();
  checkSharedPostLink();

  const draft = localStorage.getItem('bp_draft');
  if(draft){ document.getElementById('post-text').value = draft; onPostTextInput(); }
}

document.addEventListener('keydown', e => {
  if(e.key === '/' && !['TEXTAREA','INPUT'].includes(document.activeElement.tagName)){
    e.preventDefault();
    document.getElementById('search-input')?.focus();
  }
});

(async function init(){
  const ok = await tryAutoLogin();
  if(ok) boot();
})();

// ===================== SOCKET =====================
function initSocket(){
  socket = io({ auth: { token } });

  socket.on('newPost', (post) => { posts.unshift(post); renderAll(); });
  socket.on('deletePost', ({postId}) => { posts = posts.filter(p => p.id !== postId); renderAll(); });
  socket.on('upvoteUpdate', ({postId, upvotes}) => { const p = posts.find(p => p.id === postId); if(p){ p.upvotes = upvotes; renderAll(); } });
  socket.on('loveUpdate', ({postId, loves}) => { const p = posts.find(p => p.id === postId); if(p){ p.loves = loves; renderAll(); } });
  socket.on('editPost', ({postId, text, hashtags}) => { const p = posts.find(p => p.id === postId); if(p){ p.text = text; p.hashtags = hashtags; renderAll(); } });
  socket.on('newComment', (comment) => { if(activeCommentsPostId === comment.postId) appendCommentToDrawer(comment); });
  socket.on('commentLikeUpdate', () => { if(activeCommentsPostId) openComments(activeCommentsPostId); });
  socket.on('newMessage', (msg) => { if(activeConversationId === msg.conversationId) appendMessageBubble(msg); loadConversations(); });
  socket.on('deleteMessage', ({id}) => document.getElementById('msg-'+id)?.remove());
  socket.on('typing', ({conversationId}) => {
    if(activeConversationId === conversationId){
      const el = document.getElementById('typing-indicator');
      el.classList.remove('hidden');
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => el.classList.add('hidden'), 2500);
    }
  });
  socket.on('newNotification', () => { document.getElementById('notif-badge').classList.remove('hidden'); loadNotifications(); });
  socket.on('presenceUpdate', ({userId, online}) => {
    document.querySelectorAll(`.presence-${userId}`).forEach(el => el.classList.toggle('online', online));
  });
  socket.on('onlineCount', c => { const el = document.getElementById('online-count'); if(el) el.textContent = `🟢 ${c} online`; });
}

// ===================== MAP =====================
function initMap(){
  map = L.map('map', { zoomControl: true }).setView([22.5, 79.5], 5);
  updateMapTheme();
  fetch('https://raw.githubusercontent.com/datameet/maps/master/Country/india-land-simplified.geojson')
    .then(r => r.json())
    .then(geo => { L.geoJSON(geo, { style: { color:'#00e6a8', weight:1, fillColor:'#00e6a8', fillOpacity:0.04 } }).addTo(map); })
    .catch(()=>{});
}

function updateMapTheme(){
  if(!map) return;
  if(tileLayer) map.removeLayer(tileLayer);
  let url = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  if(settings.mapStyle === 'street') url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  if(settings.mapStyle === 'satellite') url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  tileLayer = L.tileLayer(url, { maxZoom: 19 }).addTo(map);
}

// ===================== GEOLOCATION =====================
function startLocationTracking(){
  if(!navigator.geolocation){ updateLocUI(false, 'Geolocation not supported'); return; }
  navigator.geolocation.watchPosition(onLocationUpdate, () => updateLocUI(false, 'Location access denied'), {
    enableHighAccuracy: true, maximumAge: 0, timeout: 15000
  });
}

function onLocationUpdate(pos){
  const { latitude, longitude, accuracy } = pos.coords;
  if(accuracy <= bestAccuracySoFar || !userLocation){
    bestAccuracySoFar = accuracy;
    userLocation = { lat: latitude, lng: longitude, accuracy };
    placeMyMarker();
    updateLocUI(true, `±${Math.round(accuracy)}m accuracy`);
    if(accuracy > 15) showAccuracyBanner(`GPS is ±${Math.round(accuracy)}m off. Drag the pin to your exact spot for best precision.`);
    document.getElementById('publish-btn').disabled = false;
    renderAll();
  }
}

function updateLocUI(ok, msg){
  document.getElementById('loc-text').textContent = msg;
  const badge = document.getElementById('loc-badge');
  badge.textContent = ok ? 'GPS' : 'OFF';
  badge.className = 'badge' + (ok ? '' : ' bad');
}
function showAccuracyBanner(msg){ document.getElementById('accuracy-text').textContent = msg; document.getElementById('accuracy-banner').classList.remove('hidden'); }
function dismissAccuracyBanner(){ document.getElementById('accuracy-banner').classList.add('hidden'); }

function placeMyMarker(){
  if(!userLocation || !map) return;
  map.setView([userLocation.lat, userLocation.lng], 15);
  if(accuracyCircle) map.removeLayer(accuracyCircle);
  accuracyCircle = L.circle([userLocation.lat, userLocation.lng], { radius: userLocation.accuracy, color:'#00e6a8', fillColor:'#00e6a8', fillOpacity:0.08, weight:1 }).addTo(map);
  if(myMarker) map.removeLayer(myMarker);
  if(settings.ghostMode) return;
  const icon = L.divIcon({ className:'', html:`<div style="width:16px;height:16px;background:#00e6a8;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px #00e6a8;"></div>`, iconSize:[16,16] });
  myMarker = L.marker([userLocation.lat, userLocation.lng], { icon, draggable:true }).addTo(map).bindPopup('Your location — drag to correct if off');
  myMarker.on('dragend', (e) => {
    const p = e.target.getLatLng();
    userLocation.lat = p.lat; userLocation.lng = p.lng; userLocation.accuracy = 1;
    updateLocUI(true, 'Manually corrected'); dismissAccuracyBanner();
  });
}

// ===================== SEARCH BAR =====================
function onSearchInput(){
  const q = document.getElementById('search-input').value.trim();
  document.getElementById('search-clear').classList.toggle('hidden', !q);
  clearTimeout(searchDebounce);
  if(!q){ document.getElementById('search-results').classList.add('hidden'); return; }
  searchDebounce = setTimeout(() => runSearch(q), 350);
}

async function runSearch(q){
  const res = await fetch('/api/search?q=' + encodeURIComponent(q), { headers: authHeaders() });
  const data = await res.json();
  const box = document.getElementById('search-results');
  box.innerHTML = '';
  let any = false;

  if(data.locations && data.locations.length){
    any = true;
    box.innerHTML += `<div class="search-group"><div class="search-group-title">📍 Locations</div>${
      data.locations.map(l => `<div class="search-item" onclick='flyToLocation(${l.lat},${l.lng})'>${escapeHtml(l.name)}</div>`).join('')
    }</div>`;
  }
  if(data.posts && data.posts.length){
    any = true;
    box.innerHTML += `<div class="search-group"><div class="search-group-title">📝 Posts</div>${
      data.posts.map(p => `<div class="search-item" onclick="focusPostFromSearch('${p.id}')"><span>${escapeHtml(p.text.slice(0,60))}</span></div>`).join('')
    }</div>`;
  }
  if(data.tags && data.tags.length){
    any = true;
    box.innerHTML += `<div class="search-group"><div class="search-group-title">🏷️ Labels</div>${
      data.tags.map(t => `<div class="search-item" onclick="filterByTag('${t.tag}')"><span class="tag-pill">${escapeHtml(t.tag)}</span><span style="margin-left:6px;color:var(--text-dim);">${t.count} post(s)</span></div>`).join('')
    }</div>`;
  }
  if(data.hashtags && data.hashtags.length){
    any = true;
    box.innerHTML += `<div class="search-group"><div class="search-group-title"># Hashtags</div>${
      data.hashtags.map(h => `<div class="search-item" onclick="filterByHashtag('${h.hashtag}')"><span class="tag-pill">#${escapeHtml(h.hashtag)}</span><span style="margin-left:6px;color:var(--text-dim);">${h.count} post(s)</span></div>`).join('')
    }</div>`;
  }
  if(!any) box.innerHTML = `<div class="search-empty">No matches for "${escapeHtml(q)}"</div>`;
  box.classList.remove('hidden');
}

function clearSearch(){
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.add('hidden');
  document.getElementById('search-results').classList.add('hidden');
  activeFilter = null;
  renderAll();
}

function flyToLocation(lat, lng){ map.setView([lat, lng], 14); document.getElementById('search-results').classList.add('hidden'); }
function focusPostFromSearch(postId){
  const p = posts.find(p => p.id === postId);
  document.getElementById('search-results').classList.add('hidden');
  if(p){ map.setView([p.lat, p.lng], 16); const m = mapMarkers[p.id]; if(m) m.openPopup(); }
}
function filterByTag(tag){ activeFilter = { type:'tag', value: tag }; document.getElementById('search-results').classList.add('hidden'); document.getElementById('search-input').value = ''; renderAll(); }
function filterByHashtag(tag){ activeFilter = { type:'hashtag', value: tag }; document.getElementById('search-results').classList.add('hidden'); document.getElementById('search-input').value = ''; renderAll(); }

async function loadTrending(){
  const res = await fetch('/api/hashtags/suggest', { headers: authHeaders() });
  const list = await res.json();
  const el = document.getElementById('trending-strip');
  if(!el) return;
  el.innerHTML = list.length ? ('🔥 ' + list.slice(0,5).map(h => `<span class="post-label-pill" onclick="filterByHashtag('${h.hashtag}')">#${escapeHtml(h.hashtag)}</span>`).join(' ')) : '';
}

document.addEventListener('click', (e) => {
  if(!e.target.closest('.search-wrap')) document.getElementById('search-results')?.classList.add('hidden');
  if(!e.target.closest('.tag-attach-wrap')) document.getElementById('tag-suggestions')?.classList.add('hidden');
  if(!e.target.closest('.chat-search-wrap')) document.getElementById('chat-user-results')?.classList.add('hidden');
});

// ===================== LABEL/TAG ATTACH =====================
function onTagSearchInput(){
  const q = document.getElementById('tag-search-input').value.trim();
  clearTimeout(tagDebounce);
  if(!q){ document.getElementById('tag-suggestions').classList.add('hidden'); return; }
  tagDebounce = setTimeout(async () => {
    const res = await fetch('/api/tags/suggest?q=' + encodeURIComponent(q), { headers: authHeaders() });
    const list = await res.json();
    const box = document.getElementById('tag-suggestions');
    box.innerHTML = list.map(item => `<div class="tag-suggestion-item" onclick="addTag('${item.tag}')"><span>${escapeHtml(item.tag)}</span><span class="tag-suggestion-count">${item.count}</span></div>`).join('');
    const cleanNewTag = q.toLowerCase().replace(/[^a-z0-9_ -]/gi, '');
    box.innerHTML += `<div class="tag-suggestion-item" style="color:var(--accent);" onclick="addTag('${cleanNewTag}')">+ Create "${escapeHtml(q)}"</div>`;
    box.classList.remove('hidden');
  }, 250);
}
function onTagSearchKeydown(e){
  if(e.key === 'Enter'){
    e.preventDefault();
    const q = document.getElementById('tag-search-input').value.trim();
    if(q) addTag(q.toLowerCase());
  }
}
function addTag(tag){
  tag = tag.trim().slice(0, 24);
  if(!tag || selectedTags.includes(tag) || selectedTags.length >= 8) return;
  selectedTags.push(tag);
  document.getElementById('tag-search-input').value = '';
  document.getElementById('tag-suggestions').classList.add('hidden');
  renderTagChips();
}
function removeTag(tag){ selectedTags = selectedTags.filter(t => t !== tag); renderTagChips(); }
function renderTagChips(){
  document.getElementById('tag-chips').innerHTML = selectedTags.map(t =>
    `<span class="tag-chip">${escapeHtml(t)}<button onclick="removeTag('${t}')">✕</button></span>`
  ).join('');
}

// ===================== PROFILE (self) =====================
function openProfileModal(){
  document.getElementById('profile-displayname').value = currentUser.displayName || '';
  document.getElementById('profile-bio').value = currentUser.bio || '';
  toggleProfile(true);
}
function toggleProfile(show){ document.getElementById('profile-modal').classList.toggle('active', show); }

async function uploadAvatar(){
  const file = document.getElementById('avatar-input').files[0];
  if(!file) return;
  const fd = new FormData(); fd.append('avatar', file);
  const res = await fetch('/api/me/avatar', { method:'POST', headers: authHeaders(), body: fd });
  const data = await res.json();
  if(res.ok){
    currentUser.avatar = data.avatar;
    document.getElementById('my-avatar').src = data.avatar;
    document.getElementById('profile-avatar-preview').src = data.avatar;
  }
}

async function saveProfile(){
  const displayName = document.getElementById('profile-displayname').value.trim();
  const bio = document.getElementById('profile-bio').value.trim();
  const res = await fetch('/api/me', { method:'PUT', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({displayName, bio}) });
  if(res.ok){
    currentUser.displayName = displayName; currentUser.bio = bio;
    document.getElementById('my-name').textContent = displayName;
    toggleProfile(false);
  }
}

async function exportMyData(){
  const res = await fetch('/api/me/export', { headers: authHeaders() });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'my-bharatpulse-data.json'; a.click();
  URL.revokeObjectURL(url);
}
async function deleteAccount(){
  if(!confirm('This permanently deletes your account and all posts. Continue?')) return;
  if(!confirm('Really sure? This cannot be undone.')) return;
  await fetch('/api/me', { method:'DELETE', headers: authHeaders() });
  logout();
}

// ===================== PUBLIC PROFILE (others) =====================
async function openPublicProfile(userId){
  const res = await fetch(`/api/users/${userId}/profile`, { headers: authHeaders() });
  if(!res.ok) return;
  const p = await res.json();
  currentProfileId = p.id;
  document.getElementById('pp-avatar').src = p.avatar || 'img/default-avatar.svg';
  document.getElementById('pp-name').textContent = p.displayName;
  document.getElementById('pp-bio').textContent = p.bio || '';
  document.getElementById('pp-followers').textContent = p.followerCount;
  document.getElementById('pp-following').textContent = p.followingCount;
  document.getElementById('pp-postcount').textContent = p.posts.length;
  const followBtn = document.getElementById('pp-follow-btn');
  followBtn.textContent = p.isFollowing ? 'Following ✓' : 'Follow';
  followBtn.style.background = p.isFollowing ? '#1d222a' : 'var(--accent)';
  followBtn.style.color = p.isFollowing ? 'var(--text)' : '#00251c';
  document.getElementById('pp-follow-btn').classList.toggle('hidden', p.isMe);
  document.getElementById('pp-message-btn').classList.toggle('hidden', p.isMe);
  document.getElementById('pp-mute-btn').classList.toggle('hidden', p.isMe);
  document.getElementById('pp-block-btn').classList.toggle('hidden', p.isMe);
  document.getElementById('public-profile-modal').classList.add('active');
}
function togglePublicProfile(show){ document.getElementById('public-profile-modal').classList.toggle('active', show); }

async function toggleFollow(){
  const res = await fetch(`/api/users/${currentProfileId}/follow`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  const followBtn = document.getElementById('pp-follow-btn');
  followBtn.textContent = data.following ? 'Following ✓' : 'Follow';
  document.getElementById('pp-followers').textContent = data.followerCount;
}

async function muteFromProfile(){
  await fetch(`/api/users/${currentProfileId}/mute`, { method:'POST', headers: authHeaders() });
  togglePublicProfile(false);
  loadPosts();
}

async function blockFromProfile(){
  if(!confirm('Block this user? You will no longer see each others posts or messages.')) return;
  await fetch(`/api/users/${currentProfileId}/block`, { method:'POST', headers: authHeaders() });
  togglePublicProfile(false);
  loadPosts();
}

async function messageFromProfile(){
  const res = await fetch('/api/conversations', { method:'POST', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({otherUserId: currentProfileId}) });
  const convo = await res.json();
  const profRes = await fetch(`/api/users/${currentProfileId}/profile`, { headers: authHeaders() });
  const p = await profRes.json();
  togglePublicProfile(false);
  toggleChat(true);
  openConversation(convo.id, { id: p.id, displayName: p.displayName, avatar: p.avatar });
}

async function openProfileByUsername(username){
  const res = await fetch('/api/users/by-username/' + encodeURIComponent(username), { headers: authHeaders() });
  if(res.ok){ const u = await res.json(); openPublicProfile(u.id); }
}

// ===================== SETTINGS =====================
function toggleSettings(show){ document.getElementById('settings-modal').classList.toggle('active', show); }
function loadSettingsUI(){
  document.getElementById('s-ghost').checked = settings.ghostMode;
  document.getElementById('s-blur').checked = settings.blurLocation;
  document.getElementById('s-radius').value = settings.radiusKm;
  document.getElementById('s-map-style').value = settings.mapStyle;
  document.getElementById('s-unit').value = settings.unit;
  document.getElementById('s-notif').checked = settings.notifications;
  document.getElementById('s-accent-color').value = settings.accentColor || '#00e6a8';
  document.getElementById('s-theme').value = settings.theme || 'dark';
  document.getElementById('s-pixel').checked = !!settings.pixelMode;
  applyAccentColor(settings.accentColor || '#00e6a8');
  applyThemeMode();
  applyPixelMode();
}
async function saveSettings(){
  settings.ghostMode = document.getElementById('s-ghost').checked;
  settings.blurLocation = document.getElementById('s-blur').checked;
  settings.radiusKm = parseInt(document.getElementById('s-radius').value);
  settings.mapStyle = document.getElementById('s-map-style').value;
  settings.unit = document.getElementById('s-unit').value;
  settings.notifications = document.getElementById('s-notif').checked;
  settings.accentColor = document.getElementById('s-accent-color').value;
  settings.theme = document.getElementById('s-theme').value;
  settings.pixelMode = document.getElementById('s-pixel').checked;
  await fetch('/api/me', { method:'PUT', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({settings}) });
  placeMyMarker(); renderAll();
}
function applyAccentColor(hex){ document.documentElement.style.setProperty('--accent', hex); settings.accentColor = hex; }
function applyThemeMode(){ const mode = document.getElementById('s-theme').value; document.documentElement.setAttribute('data-theme', mode); settings.theme = mode; }
function applyPixelMode(){ document.body.classList.toggle('pixel-theme', document.getElementById('s-pixel').checked); settings.pixelMode = document.getElementById('s-pixel').checked; }

// ===================== POSTS =====================
function handleImagePreview(){
  const file = document.getElementById('post-media').files[0];
  selectedImageFile = file || null;
  document.getElementById('img-name').textContent = file ? file.name : '';
}

async function loadPosts(){
  const res = await fetch('/api/posts', { headers: authHeaders() });
  posts = await res.json();
  renderAll();
}

function insertEmoji(e){ const ta=document.getElementById('post-text'); ta.value += e; ta.focus(); onPostTextInput(); }
function onPostTextInput(){
  const ta = document.getElementById('post-text');
  document.getElementById('char-count').textContent = `${ta.value.length}/500`;
  localStorage.setItem('bp_draft', ta.value);
}

async function createPost(){
  const text = document.getElementById('post-text').value.trim();
  if(!text || !userLocation) return;

  let lat = userLocation.lat, lng = userLocation.lng;
  if(settings.blurLocation){ lat += (Math.random()-0.5)*0.008; lng += (Math.random()-0.5)*0.008; }

  const fd = new FormData();
  fd.append('text', text);
  fd.append('lat', lat);
  fd.append('lng', lng);
  fd.append('category', 'General');
  fd.append('tags', JSON.stringify(selectedTags));
  fd.append('expireHours', document.getElementById('expire-select').value);
  if(selectedImageFile) fd.append('media', selectedImageFile);

  const res = await fetch('/api/posts', { method:'POST', headers: authHeaders(), body: fd });
  if(res.ok){
    document.getElementById('post-text').value = '';
    document.getElementById('post-media').value = '';
    document.getElementById('img-name').textContent = '';
    document.getElementById('char-count').textContent = '';
    selectedImageFile = null;
    selectedTags = [];
    renderTagChips();
    localStorage.removeItem('bp_draft');
  }
}

async function upvote(postId){
  const res = await fetch(`/api/posts/${postId}/upvote`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  const p = posts.find(p => p.id === postId);
  if(p){ p.upvotes = data.upvotes; renderAll(); }
}

async function love(postId, ev){
  if(ev) ev.stopPropagation();
  const res = await fetch(`/api/posts/${postId}/love`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  const p = posts.find(p => p.id === postId);
  if(p){ p.loves = data.loves; renderAll(); }
}

async function pinPost(postId, ev){
  if(ev) ev.stopPropagation();
  await fetch(`/api/posts/${postId}/pin`, { method:'POST', headers: authHeaders() });
  loadPosts();
}

async function editPost(postId, ev){
  if(ev) ev.stopPropagation();
  const p = posts.find(p => p.id === postId);
  const t = prompt('Edit your post:', p ? p.text : '');
  if(!t || !t.trim()) return;
  const res = await fetch(`/api/posts/${postId}`, { method:'PUT', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({text: t.trim()}) });
  if(!res.ok){ const d = await res.json(); alert(d.error); }
}

function copyCoords(lat, lng, ev){
  if(ev) ev.stopPropagation();
  navigator.clipboard.writeText(`${lat},${lng}`).then(() => alert('Coordinates copied!'));
}

async function toggleBookmark(postId){
  const res = await fetch(`/api/posts/${postId}/bookmark`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  const p = posts.find(p => p.id === postId);
  if(p){ p.bookmarked = data.bookmarked; renderAll(); }
}

async function reportPost(postId, ev){
  if(ev) ev.stopPropagation();
  if(!confirm('Report this post to moderators?')) return;
  const res = await fetch(`/api/posts/${postId}/report`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  alert(data.hidden ? 'Post reported and removed from view.' : 'Thanks, this post has been reported.');
}

async function muteUser(id, ev){
  if(ev) ev.stopPropagation();
  await fetch(`/api/users/${id}/mute`, { method:'POST', headers: authHeaders() });
  loadPosts();
}

function sharePost(postId, ev){
  if(ev) ev.stopPropagation();
  const url = `${location.origin}${location.pathname}?post=${postId}`;
  navigator.clipboard.writeText(url).then(() => alert('Link copied! Share it with anyone.'));
}

function checkSharedPostLink(){
  const params = new URLSearchParams(location.search);
  const postId = params.get('post');
  if(postId){
    setTimeout(() => { const p = posts.find(p => p.id === postId); if(p){ map.setView([p.lat,p.lng],16); mapMarkers[p.id]?.openPopup(); } }, 800);
  }
}

async function deletePost(postId, ev){
  if(ev) ev.stopPropagation();
  if(!confirm('Delete this post?')) return;
  await fetch(`/api/posts/${postId}`, { method:'DELETE', headers: authHeaders() });
}

// ===================== SAFETY FLARE =====================
function openFlareModal(){ toggleFlare(true); }
function toggleFlare(show){ document.getElementById('flare-modal').classList.toggle('active', show); }
async function sendFlare(){
  const text = document.getElementById('flare-text').value.trim();
  if(!text || !userLocation) return;
  const fd = new FormData();
  fd.append('text', '🚨 ' + text);
  fd.append('lat', userLocation.lat);
  fd.append('lng', userLocation.lng);
  fd.append('category', 'Alert');
  fd.append('tags', '[]');
  fd.append('expireHours', '1');
  fd.append('isFlare', 'true');
  await fetch('/api/posts', { method:'POST', headers: authHeaders(), body: fd });
  document.getElementById('flare-text').value = '';
  toggleFlare(false);
}

// ===================== NOTIFICATIONS =====================
async function loadNotifications(){
  const res = await fetch('/api/notifications', { headers: authHeaders() });
  const notes = await res.json();
  const hasUnread = notes.some(n => !n.read);
  document.getElementById('notif-badge').classList.toggle('hidden', !hasUnread);
  const list = document.getElementById('notifications-list');
  if(notes.length === 0){ list.innerHTML = '<div class="empty-state">No notifications yet.</div>'; return; }
  const icons = { follow:'👤', upvote:'👍', comment:'💬', mention:'📣' };
  list.innerHTML = notes.map(n => `
    <div class="toggle-row" style="align-items:flex-start;">
      <img src="${n.fromUser?.avatar || 'img/default-avatar.svg'}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">
      <span style="flex:1;margin-left:10px;">${icons[n.type]||'🔔'} <b>${escapeHtml(n.fromUser?.displayName||'Someone')}</b> ${escapeHtml(n.text)}${!n.read ? ' <span style="color:var(--accent);">●</span>' : ''}</span>
    </div>
  `).join('');
}
function toggleNotifications(show){
  document.getElementById('notifications-modal').classList.toggle('active', show);
  if(show) loadNotifications();
}
async function markAllRead(){
  await fetch('/api/notifications/read', { method:'POST', headers: authHeaders() });
  document.getElementById('notif-badge').classList.add('hidden');
  loadNotifications();
}

// ===================== BOOKMARKS =====================
async function toggleBookmarks(show){
  document.getElementById('bookmarks-modal').classList.toggle('active', show);
  if(!show) return;
  const res = await fetch('/api/bookmarks', { headers: authHeaders() });
  const saved = await res.json();
  const list = document.getElementById('bookmarks-list');
  if(saved.length === 0){ list.innerHTML = '<div class="empty-state">Nothing saved yet. Tap the 🔖 icon on any post.</div>'; return; }
  list.innerHTML = saved.map(p => `
    <div class="post-card" onclick="toggleBookmarks(false); setTimeout(()=>{map.setView([${p.lat},${p.lng}],16); mapMarkers['${p.id}']?.openPopup();},300)">
      <div class="post-card-top"><img src="${p.author.avatar||'img/default-avatar.svg'}"><span class="post-author">${escapeHtml(p.author.displayName)}</span></div>
      <div class="post-text">${escapeHtml(p.text.slice(0,120))}</div>
    </div>
  `).join('');
}

// ===================== CHAT =====================
function toggleChat(show){
  document.getElementById('chat-drawer').classList.toggle('open', show);
  if(show) showChatList();
}
function showChatList(){
  document.getElementById('chat-list-view').classList.remove('hidden');
  document.getElementById('chat-thread-view').classList.add('hidden');
  document.getElementById('chat-back-btn').classList.add('hidden');
  document.getElementById('chat-drawer-title').textContent = 'Messages';
  activeConversationId = null;
  loadConversations();
}
async function loadConversations(){
  const res = await fetch('/api/conversations', { headers: authHeaders() });
  conversations = await res.json();
  const totalUnread = conversations.reduce((s,c) => s + c.unreadCount, 0);
  document.getElementById('chat-badge').classList.toggle('hidden', totalUnread === 0);
  const list = document.getElementById('conversations-list');
  if(conversations.length === 0){ list.innerHTML = '<div class="empty-state">No conversations yet. Search someone above to start chatting.</div>'; return; }
  list.innerHTML = conversations.map(c => `
    <div class="convo-item" onclick='openConversation("${c.id}", ${JSON.stringify(c.otherUser)})'>
      <img src="${c.otherUser.avatar || 'img/default-avatar.svg'}">
      <div class="convo-info">
        <div class="convo-name"><span class="presence-dot ${c.otherUser.online?'online':''} presence-${c.otherUser.id}"></span>${escapeHtml(c.otherUser.displayName)}</div>
        <div class="convo-last">${c.lastMessage ? escapeHtml(c.lastMessage.text) : 'Say hi 👋'}</div>
      </div>
      ${c.unreadCount > 0 ? `<span class="convo-unread">${c.unreadCount}</span>` : ''}
    </div>
  `).join('');
}
function onChatUserSearch(){
  const q = document.getElementById('chat-user-search').value.trim();
  clearTimeout(chatUserDebounce);
  const box = document.getElementById('chat-user-results');
  if(!q){ box.classList.add('hidden'); return; }
  chatUserDebounce = setTimeout(async () => {
    const res = await fetch('/api/users/search?q=' + encodeURIComponent(q), { headers: authHeaders() });
    const users = await res.json();
    box.innerHTML = users.map(u => `<div class="tag-suggestion-item" onclick='startConversationWith(${JSON.stringify(u)})'><span>${escapeHtml(u.displayName)} <span style="color:var(--text-dim);">@${escapeHtml(u.username)}</span></span></div>`).join('') || '<div class="tag-suggestion-item">No users found</div>';
    box.classList.remove('hidden');
  }, 300);
}
async function startConversationWith(user){
  const res = await fetch('/api/conversations', { method:'POST', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({otherUserId: user.id}) });
  const convo = await res.json();
  document.getElementById('chat-user-search').value = '';
  document.getElementById('chat-user-results').classList.add('hidden');
  openConversation(convo.id, user);
}
async function openConversation(id, otherUser){
  activeConversationId = id;
  activeConversationOtherUser = otherUser;
  document.getElementById('chat-list-view').classList.add('hidden');
  document.getElementById('chat-thread-view').classList.remove('hidden');
  document.getElementById('chat-back-btn').classList.remove('hidden');
  document.getElementById('chat-drawer-title').textContent = otherUser.displayName;
  document.getElementById('thread-avatar').src = otherUser.avatar || 'img/default-avatar.svg';
  document.getElementById('thread-name').textContent = otherUser.displayName;
  const res = await fetch(`/api/conversations/${id}/messages`, { headers: authHeaders() });
  const msgs = await res.json();
  const list = document.getElementById('messages-list');
  list.innerHTML = '';
  msgs.forEach(appendMessageBubble);
  loadConversations();
}
function appendMessageBubble(msg){
  if(msg.conversationId !== activeConversationId) return;
  const list = document.getElementById('messages-list');
  const mine = msg.senderId === currentUser.id;
  const div = document.createElement('div');
  div.id = 'msg-' + msg.id;
  div.className = 'msg-bubble ' + (mine ? 'msg-mine' : 'msg-theirs');
  div.innerHTML = `${escapeHtml(msg.text)}<span class="msg-time">${new Date(msg.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}${mine ? ` · <a onclick="unsendMessage('${msg.id}')" style="cursor:pointer;text-decoration:underline;">unsend</a>` : ''}</span>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}
async function unsendMessage(id){
  await fetch('/api/messages/' + id, { method:'DELETE', headers: authHeaders() });
}
async function sendMessage(){
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if(!text || !activeConversationId) return;
  input.value = '';
  await fetch(`/api/conversations/${activeConversationId}/messages`, { method:'POST', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({text}) });
}
function onTyping(){
  if(!activeConversationId || !activeConversationOtherUser) return;
  socket.emit('typing', { conversationId: activeConversationId, otherUserId: activeConversationOtherUser.id });
}

// ===================== DISTANCE / RENDER =====================
function distanceKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180, dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function renderPostText(text){
  let html = escapeHtml(text);
  html = html.replace(/#([a-zA-Z0-9_]+)/g, `<span class="hashtag" onclick="filterByHashtag('$1')">#$1</span>`);
  html = html.replace(/@([a-zA-Z0-9_.]+)/g, `<span class="hashtag" onclick="openProfileByUsername('$1')">@$1</span>`);
  return html;
}

function renderAll(){
  const now = Date.now();
  let visible = posts.filter(p => now - p.createdAt < p.expireHours * 3600000);

  if(userLocation && settings.radiusKm > 0){
    visible = visible.filter(p => distanceKm(userLocation.lat, userLocation.lng, p.lat, p.lng) <= settings.radiusKm);
  }
  if(activeFilter){
    if(activeFilter.type === 'tag') visible = visible.filter(p => (p.tags||[]).includes(activeFilter.value));
    if(activeFilter.type === 'hashtag') visible = visible.filter(p => (p.hashtags||[]).includes(activeFilter.value));
  }

  document.getElementById('pulse-count').textContent = visible.length;

  Object.values(mapMarkers).forEach(m => map.removeLayer(m));
  mapMarkers = {};

  const feedList = document.getElementById('feed-list');
  feedList.innerHTML = '';

  if(activeFilter){
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.style.marginBottom = '10px';
    chip.innerHTML = `Filtering: ${activeFilter.type==='hashtag'?'#':''}${escapeHtml(activeFilter.value)} <button onclick="activeFilter=null; renderAll();">✕</button>`;
    feedList.appendChild(chip);
  }

  if(visible.length === 0){
    feedList.innerHTML += `<div class="empty-state">No posts match right now. Try widening your radius or clearing filters.</div>`;
    return;
  }

  const sortMode = document.getElementById('feed-sort') ? document.getElementById('feed-sort').value : 'new';
  visible.sort((a,b) => sortMode === 'top' ? (b.upvotes||[]).length - (a.upvotes||[]).length : b.createdAt - a.createdAt);

  visible.forEach(post => {
    const lifetimeMs = post.expireHours * 3600000;
    const elapsed = now - post.createdAt;
    const remainingRatio = Math.max(0, 1 - elapsed / lifetimeMs);
    const opacity = 0.35 + 0.65 * remainingRatio;
    const remainingHours = Math.max(0, Math.ceil((lifetimeMs - elapsed) / 3600000));

    const iconHtml = post.isFlare
      ? `<div style="width:20px;height:20px;background:#ff4d5e;border-radius:50%;border:3px solid #fff;box-shadow:0 0 14px #ff4d5e;opacity:${opacity}"></div>`
      : `<div style="width:14px;height:14px;background:#00e6a8;border-radius:50%;border:2px solid #fff;opacity:${opacity}"></div>`;
    const icon = L.divIcon({ className:'', html: iconHtml, iconSize:[20,20] });

    let popupHtml = `<b>${escapeHtml(post.author.displayName)}</b><br>${renderPostText(post.text)}`;
    if(post.video) popupHtml += `<br><video src="${post.video}" class="popup-img" controls></video>`;
    else if(post.image) popupHtml += `<br><img src="${post.image}" class="popup-img">`;
    const marker = L.marker([post.lat, post.lng], { icon }).addTo(map).bindPopup(popupHtml);
    mapMarkers[post.id] = marker;

    const card = document.createElement('div');
    card.className = 'post-card' + (post.isFlare ? ' flare-card' : '');
    card.style.opacity = opacity;
    card.onclick = () => { map.setView([post.lat, post.lng], 16); marker.openPopup(); fetch(`/api/posts/${post.id}/view`, {method:'POST', headers:authHeaders()}); };

    const voted = (post.upvotes || []).includes(currentUser.id);
    const loved = (post.loves || []).includes(currentUser.id);
    const dist = userLocation ? distanceKm(userLocation.lat, userLocation.lng, post.lat, post.lng) : null;
    const distStr = dist === null ? '' : (settings.unit === 'mi' ? `${(dist*0.621371).toFixed(1)} mi` : `${dist.toFixed(1)} km`);
    const isMine = currentUser && post.userId === currentUser.id;
    const editable = isMine && (now - post.createdAt < 5*60000);
    const labelsHtml = (post.tags||[]).map(t => `<span class="post-label-pill" onclick="event.stopPropagation(); filterByTag('${t}')">${escapeHtml(t)}</span>`).join('');
    const mediaHtml = post.video ? `<video src="${post.video}" class="post-img" controls playsinline></video>` : (post.image ? `<img src="${post.image}" class="post-img">` : '');

    card.innerHTML = `
      <div class="post-card-top">
        ${post.pinned ? `<span class="pin-badge">📌</span>` : ''}
        <span class="presence-dot ${post.author.online?'online':''} presence-${post.userId}"></span>
        <img src="${post.isFlare ? 'img/default-avatar.svg' : (post.author.avatar || 'img/default-avatar.svg')}" ${!post.isFlare ? `onclick="event.stopPropagation(); openPublicProfile('${post.userId}')" style="cursor:pointer;"` : ''}>
        <span class="post-author" ${!post.isFlare ? `onclick="event.stopPropagation(); openPublicProfile('${post.userId}')" style="cursor:pointer;"` : ''}>${post.isFlare ? 'Anonymous Flare' : escapeHtml(post.author.displayName)}</span>
      </div>
      <div class="post-text">${renderPostText(post.text)}</div>
      ${labelsHtml ? `<div class="post-labels">${labelsHtml}</div>` : ''}
      ${mediaHtml}
      <div class="post-meta-row">
        <div class="post-actions">
          <button class="upvote-btn ${voted?'voted':''}" onclick="event.stopPropagation(); upvote('${post.id}')">👍 ${(post.upvotes||[]).length}</button>
          <button class="upvote-btn ${loved?'voted':''}" onclick="love('${post.id}', event)">❤️ ${(post.loves||[]).length}</button>
          <button class="comment-btn" onclick="event.stopPropagation(); openComments('${post.id}')">💬</button>
          <button class="comment-btn" onclick="event.stopPropagation(); toggleBookmark('${post.id}')">${post.bookmarked ? '🔖' : '🏷️'}</button>
          <button class="comment-btn" onclick="sharePost('${post.id}', event)">🔗</button>
          <button class="comment-btn" onclick="copyCoords(${post.lat},${post.lng},event)">📋</button>
          ${isMine ? `<button class="comment-btn" onclick="pinPost('${post.id}', event)">${post.pinned?'📌':'📍'}</button>` : ''}
          ${editable ? `<button class="comment-btn" onclick="editPost('${post.id}', event)">✏️</button>` : ''}
          ${!isMine ? `<button class="report-btn" onclick="reportPost('${post.id}', event)">🚩</button>` : ''}
          ${!isMine ? `<button class="report-btn" onclick="muteUser('${post.userId}', event)">🔇</button>` : ''}
        </div>
        <span>${distStr} · 👁️ ${post.views||0} · ~${remainingHours}h ${isMine ? `<button class="del-btn" onclick="deletePost('${post.id}', event)">🗑️</button>` : ''}</span>
      </div>
    `;
    feedList.appendChild(card);
  });
}

// ===================== COMMENTS (with likes + nested replies) =====================
async function openComments(postId){
  activeCommentsPostId = postId;
  replyTargetId = null;
  if(socket) socket.emit('joinPost', postId);
  document.getElementById('comments-drawer').classList.add('open');
  document.getElementById('comment-input').placeholder = 'Reply to this post…';
  const list = document.getElementById('comments-list');
  list.innerHTML = 'Loading…';
  const res = await fetch(`/api/posts/${postId}/comments`, { headers: authHeaders() });
  const comments = await res.json();
  list.innerHTML = '';
  comments.forEach(appendCommentToDrawer);
  if(comments.length === 0) list.innerHTML = '<div class="empty-state">No comments yet. Start the conversation.</div>';
}
function closeComments(){
  if(socket && activeCommentsPostId) socket.emit('leavePost', activeCommentsPostId);
  activeCommentsPostId = null;
  document.getElementById('comments-drawer').classList.remove('open');
}
function appendCommentToDrawer(c){
  const list = document.getElementById('comments-list');
  const empty = list.querySelector('.empty-state');
  if(empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'comment-item' + (c.parentId ? ' comment-reply' : '');
  const liked = (c.likes||[]).includes(currentUser.id);
  div.innerHTML = `<span class="comment-author">${escapeHtml(c.author.displayName)}</span>${renderPostText(c.text)}
    <div style="margin-top:4px;">
      <button class="comment-btn" onclick="likeComment('${c.id}')">${liked?'❤️':'🤍'} ${(c.likes||[]).length}</button>
      <button class="comment-btn" onclick="replyToComment('${c.id}')">Reply</button>
    </div>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}
function replyToComment(id){
  replyTargetId = id;
  document.getElementById('comment-input').placeholder = 'Replying to comment…';
  document.getElementById('comment-input').focus();
}
async function likeComment(id){
  await fetch(`/api/comments/${id}/like`, { method:'POST', headers: authHeaders() });
}
async function submitComment(){
  const input = document.getElementById('comment-input');
  const text = input.value.trim();
  if(!text || !activeCommentsPostId) return;
  input.value = '';
  await fetch(`/api/posts/${activeCommentsPostId}/comments`, { method:'POST', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify({text, parentId: replyTargetId}) });
  replyTargetId = null;
  document.getElementById('comment-input').placeholder = 'Reply to this post…';
}

// ===================== UTIL =====================
function escapeHtml(str){
  return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
