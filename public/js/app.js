/* Luckyroom Telegram UI — full client wired to real backend */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = ['#e17076', '#faa357', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];
const AV = [['#ff845e', '#d45246'], ['#ffa127', '#e46e18'], ['#b580f2', '#7b61ff'], ['#5fc9f3', '#3390ec'], ['#5dd978', '#3aa655'], ['#6ad7fd', '#2a9ad8'], ['#f27fa5', '#d44d7d']];
const hash = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0);
const NC = s => NAMES[hash(s) % NAMES.length];
const G = s => AV[hash(s) % AV.length];
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}
function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}
const nowISO = () => new Date().toISOString();
const toast = msg => {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
};
function avatarHTML(url, name, cls = '') {
  if (url) return `<div class="avatar ${cls}"><img src="${esc(url)}" alt=""></div>`;
  const [g1, g2] = G(name);
  return `<div class="avatar ${cls}" style="--g1:${g1};--g2:${g2}">${esc(initials(name))}</div>`;
}

const S = {
  chats: [], active: null, msgs: [], reads: {}, members: [],
  stickers: [], folder: 'all', replyTo: null, editMsg: null,
  linkCache: {}, typingUsers: {}, lastTypingSent: 0, myPerms: [],
  mutedIds: new Set(), notifTimer: null,
};
const targetOf = c => ({ type: c.kind === 'dm' ? 'dm' : 'group', id: c.id });
const msgPath = t => t.type === 'dm' ? `/conversations/${t.id}` : `/groups/${t.id}`;

/* ================= BOOT / AUTH ================= */
async function boot() {
  try {
    S.authCfg = await Api.get('/auth/config');
  } catch { S.authCfg = {}; }
  applyAuthCfg();
  if (Api.token && Api.user) { showApp(); }
  else { showAuth(); }
}
// Show/hide login methods based on server config: Google button first
// (needs GOOGLE_CLIENT_ID), phone-only tab (needs ALLOW_PHONE_ONLY_LOGIN).
function applyAuthCfg() {
  const cfg = S.authCfg || {};
  if (cfg.phoneOnlyLogin) {
    $('#phoneTab').classList.remove('hidden');
    document.querySelectorAll('.atab').forEach(x => x.classList.remove('active'));
    $('#phoneTab').classList.add('active');
    ['phoneForm', 'loginForm', 'regForm', 'forgotForm'].forEach(id => $('#' + id).classList.toggle('hidden', id !== 'phoneForm'));
  }
  if (cfg.googleClientId) {
    $('#googleWrap').classList.remove('hidden');
    initGoogle(cfg.googleClientId);
  }
}
function initGoogle(clientId) {
  if (!window.google?.accounts?.id) {
    // GIS script not loaded yet (slow net) — retry shortly.
    setTimeout(() => initGoogle(clientId), 1500);
    return;
  }
  try {
    google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCred });
    google.accounts.id.renderButton($('#gBtn'), { theme: 'filled_blue', size: 'large', width: 300, text: 'continue_with' });
  } catch { }
}
async function onGoogleCred(resp) {
  try {
    const r = await Api.post('/auth/google', { idToken: resp.credential });
    Api.save(r.token, r.user);
    await showApp();
  } catch (e) { toast(e.message); }
}
async function doPhoneLogin(phone, name) {
  const r = await Api.post('/auth/phone-login', { phone, name: name || undefined });
  Api.save(r.token, r.user);
  await showApp();
}
function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
async function showApp() {
  $('#authView').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#meName').textContent = Api.user.name;
  $('#mePhone').textContent = Api.user.email || Api.user.phone || '';
  $('#meAvatar').outerHTML = avatarHTML(Api.user.avatarUrl || null, Api.user.name, 'sm').replace('class="avatar sm"', 'id="meAvatar" class="avatar sm"');
  try {
    await Api.connectSocket();
    wireSocket();
    const roles = await Api.get('/roles/me').catch(() => ({ permissions: [] }));
    S.myPerms = roles.permissions || [];
    if (S.myPerms.length) $('#adminBtn').classList.remove('hidden');
    await reloadLists();
    startNotifPoll();
    if (innerWidth > 925 && S.chats[0]) openChat(S.chats[0]);
    else renderAll();
  } catch (e) { logout(true); }
}
function logout(silent) {
  Api.clear();
  clearInterval(S.notifTimer);
  showAuth();
  if (!silent) toast('Logged out');
}
async function doLogin(phone, password) {
  const r = await Api.post('/auth/login', { phone, password });
  Api.save(r.token, r.user);
  await showApp();
  if (!r.user.phoneVerified) toast('Tip: verify your phone in Profile');
}
async function doRegister(name, phone, password) {
  const r = await Api.post('/auth/register', { name, phone, password });
  Api.save(r.token, r.user);
  await showApp();
  setupSecQ(true);
}

/* ================= CHAT LIST ================= */
async function reloadLists() {
  const [groups, convs] = await Promise.all([
    Api.get('/groups').catch(() => []),
    Api.get('/conversations').catch(() => []),
  ]);
  try { S.mutedIds = new Set((await Api.get('/users/me/mutes')).map(u => u.id)); } catch { S.mutedIds = new Set(); }
  const items = [];
  groups.forEach(g => items.push({
    kind: 'group', id: g.id, name: g.name, avatarUrl: g.avatarUrl || null,
    sub: g.memberCount + ' members', unread: g.unread || 0,
    time: g.lastMessage?.createdAt || g.createdAt,
    preview: g.lastMessage ? `${g.lastMessage.senderId === Api.user.id ? 'You: ' : g.lastMessage.senderName.split(' ')[0] + ': '}${g.lastMessage.preview}` : (g.bio || 'No messages yet'),
    pin: false, myRole: g.myRole, type: g.type,
  }));
  convs.forEach(c => items.push({
    kind: 'dm', id: c.id, otherId: c.other.id, name: c.other.name, avatarUrl: c.other.avatarUrl || null,
    online: c.other.online, lastSeen: c.other.lastSeenAt, username: c.other.username,
    sub: '', unread: c.unread || 0,
    time: c.lastMessage?.createdAt || c.created_at,
    preview: c.lastMessage ? `${c.lastMessage.senderId === Api.user.id ? 'You: ' : ''}${c.lastMessage.preview}` : 'No messages yet',
    mute: S.mutedIds.has(c.other.id),
  }));
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  S.chats = items;
  renderAll();
}
function statusText(c) {
  if (c.kind === 'dm') {
    if (S.typingUsers['dm:' + c.id]) return 'typing...';
    if (c.online) return 'online';
    return c.lastSeen ? 'last seen ' + fmtTime(c.lastSeen) : '';
  }
  if (S.typingUsers['group:' + c.id]) return S.typingUsers['group:' + c.id] + ' typing...';
  return c.sub || '';
}
function renderAll() { renderFolders(); renderList(); renderStories(); }
function renderStories() {
  const others = S.chats.filter(c => c.kind === 'dm').slice(0, 6);
  $('#stories').innerHTML = `<div class="story"><div class="ring mine"><span>${esc(initials(Api.user.name))}</span><span class="plus">+</span></div>My Story</div>` +
    others.map(c => `<div class="story"><div class="ring"><span>${c.avatarUrl ? `<img src="${esc(c.avatarUrl)}">` : esc(initials(c.name))}</span></div>${esc(c.name.split(' ')[0])}</div>`).join('');
}
function renderFolders() {
  const n = k => S.chats.filter(c => k === 'all' || (k === 'personal' ? c.kind === 'dm' : c.kind === 'group')).length;
  $('#folders').innerHTML = [['all', 'All Chats'], ['personal', 'Personal'], ['groups', 'Groups']]
    .map(([k, l]) => `<button class="folder${S.folder === k ? ' active' : ''}" data-f="${k}">${l}<span class="cnt">${n(k)}</span></button>`).join('');
  document.querySelectorAll('.folder').forEach(f => f.onclick = () => { S.folder = f.dataset.f; renderFolders(); renderList(); });
}
function renderList() {
  const q = ($('#search').value || '').toLowerCase();
  const list = $('#chatList'); list.innerHTML = '';
  S.chats.filter(c => (S.folder === 'all' || (S.folder === 'personal' ? c.kind === 'dm' : c.kind === 'group')) && (c.name.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)))
    .forEach(c => {
      const b = document.createElement('button');
      b.className = 'chat' + (S.active && S.active.kind === c.kind && S.active.id === c.id ? ' active' : '');
      b.innerHTML = `${avatarHTML(c.avatarUrl, c.name)}
        <div class="c-main">
          <div class="c-top"><span class="c-name">${c.kind === 'group' ? '👥 ' : ''}${esc(c.name)}${c.mute ? ' <span class="mute">🔇</span>' : ''}</span><span class="c-time">${fmtTime(c.time)}</span></div>
          <div class="c-bot"><span class="c-sub">${esc(c.preview)}</span>
          <span class="c-right">${c.unread ? `<span class="badge"> ${c.unread}</span>` : ''}</span></div>
        </div>`;
      b.onclick = () => openChat(c);
      b.oncontextmenu = e => {
        e.preventDefault();
        const items = [[c.mute ? 'Unmute' : '🔇 Mute', () => toggleMute(c)], ['✓ Mark as read', () => markRead(c)]];
        if (c.kind === 'group') items.push(['🚪 Leave group', () => leaveGroup(c)]);
        showCtx(e.clientX, e.clientY, items);
      };
      list.appendChild(b);
    });
}

/* ================= OPEN CHAT / MESSAGES ================= */
async function openChat(c) {
  S.active = { kind: c.kind, id: c.id, ref: c };
  S.replyTo = null; S.editMsg = null; hideReplyBar();
  $('#emptyState').classList.add('hidden');
  $('#chatView').classList.remove('hidden');
  $('#peerAvatar').outerHTML = avatarHTML(c.avatarUrl, c.name, 'sm').replace('class="avatar sm"', 'id="peerAvatar" class="avatar sm"');
  $('#peerName').textContent = c.name;
  $('#peerStatus').textContent = statusText(c);
  const t = targetOf(c);
  Api.send('join', t).catch(() => {});
  if (c.kind === 'group') {
    try { S.members = await Api.get(`/groups/${c.id}/members`); } catch { S.members = []; }
  } else S.members = [];
  await loadMsgs();
  try {
    const pinned = await Api.get(msgPath(t) + '/messages/pinned');
    if (pinned.length) { $('#pinnedBar').classList.remove('hidden'); $('#pinnedText').textContent = pinned[0].content || pinned[0].message_type; }
    else $('#pinnedBar').classList.add('hidden');
  } catch { $('#pinnedBar').classList.add('hidden'); }
  try { S.reads = Object.fromEntries((await Api.get(msgPath(t) + '/reads')).map(r => [r.userId, r.lastReadMessageId])); }
  catch { S.reads = {}; }
  drawMsgs();
  markRead(c);
  if (innerWidth <= 925) { $('#sidebar').classList.add('hide'); $('#main').classList.remove('hide'); }
  renderList();
}
async function loadMsgs() {
  const t = targetOf(S.active);
  S.msgs = await Api.get(msgPath(t) + '/messages?limit=50').catch(() => []);
}
function isRead(m) {
  const others = Object.entries(S.reads).filter(([uid]) => +uid !== Api.user.id).map(([, v]) => v);
  if (!others.length) return false;
  return Math.max(...others) >= m.id;
}
function attURL(m) { return S.linkCache[m.attachment.id]; }
async function ensureLinks() {
  const need = S.msgs.filter(m => m.attachment && !S.linkCache[m.attachment.id]);
  await Promise.all(need.map(async m => {
    try { S.linkCache[m.attachment.id] = await Api.uploadLink(m.attachment.id, true); } catch { }
  }));
}
function msgHTML(m, prev) {
  if (m.deleted_at) return `<div class="row ${m.sender_id === Api.user.id ? 'out' : 'in'}"><div class="bub deleted"><i>Message deleted</i><span class="meta">${fmtTime(m.created_at)}</span></div></div>`;
  const me = m.sender_id === Api.user.id;
  const grp = prev && prev.sender_id === m.sender_id && !prev.deleted_at ? '' : 'grp';
  const isGroup = S.active.kind === 'group';
  let inner = '';
  if (isGroup && !me && grp) inner += `<div class="from" style="color:${NC(m.sender_name)}">${esc(m.sender_name)}</div>`;
  if (m.forwarded_from_name) inner += `<div class="fwd">Forwarded from ${esc(m.forwarded_from_name)}</div>`;
  if (m.replyTo) inner += `<div class="quote"><b>${esc(m.replyTo.sender_name)}</b><br>${esc(m.replyTo.deleted_at ? 'Message deleted' : (m.replyTo.content || m.replyTo.message_type))}</div>`;
  if (m.message_type === 'image' && m.attachment) inner += `<div class="photo"><img loading="lazy" src="${esc(attURL(m) || '')}" data-full="${m.attachment.id}"><small>${esc(fmtTime(m.created_at))} ${me ? (isRead(m) ? '✓✓' : '✓') : ''}</small></div>`;
  if (m.message_type === 'video' && m.attachment) inner += `<video controls preload="metadata" src="${esc(attURL(m) || '')}"></video>`;
  if (m.message_type === 'voice' && m.attachment) inner += `<div class="voice"><audio controls preload="none" src="${esc(attURL(m) || '')}"></audio></div>`;
  if ((m.message_type === 'file') && m.attachment) inner += `<div class="file" data-dl="${m.attachment.id}"><span>📄</span><div><b>${esc(m.attachment.original_name)}</b><small>${(m.attachment.size / 1024).toFixed(0)} KB · tap to download</small></div></div>`;
  if (m.message_type === 'sticker' && m.sticker) inner += `<img class="sticker" loading="lazy" src="/api/stickers/file/${m.sticker.id}" alt="${esc(m.sticker.emoji || '')}">`;
  if (m.content) inner += `<span>${esc(m.content)}</span>`;
  if (m.message_type !== 'image') inner += `<span class="meta">${m.edited_at ? 'edited ' : ''}${fmtTime(m.created_at)} ${me ? (isRead(m) ? '<span class="read">✓✓</span>' : '<span>✓</span>') : ''}${m.pinned_at ? ' 📌' : ''}</span>`;
  if (m.reactions?.length) inner += `<div class="reacts">${m.reactions.map(r => `<button class="react${r.userIds.includes(Api.user.id) ? ' mine' : ''}" data-mid="${m.id}" data-e="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`).join('')}</div>`;
  return `<div class="row ${me ? 'out' : 'in'} ${grp}"><div class="bub" data-mid="${m.id}">${inner}</div>
    <div class="msg-actions"><span data-act="react">👍</span><span data-act="reply">↩️</span></div></div>`;
}
async function drawMsgs() {
  await ensureLinks();
  const box = $('#msgs');
  let html = '', lastDay = '';
  S.msgs.forEach((m, i) => {
    const d = fmtDay(m.created_at);
    if (d !== lastDay) { html += `<div class="day">${d}</div>`; lastDay = d; }
    html += msgHTML(m, S.msgs[i - 1]);
  });
  box.innerHTML = html || '<div class="day">No messages yet</div>';
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll('.bub').forEach(el => {
    const mid = +el.dataset.mid;
    el.ondblclick = () => startReply(mid);
    el.oncontextmenu = e => { e.preventDefault(); msgMenu(e.clientX, e.clientY, mid); };
  });
  box.querySelectorAll('[data-act]').forEach(a => a.onclick = e => {
    e.stopPropagation();
    const mid = +a.closest('.row').querySelector('.bub').dataset.mid;
    if (a.dataset.act === 'react') react(mid, '👍');
    else startReply(mid);
  });
  box.querySelectorAll('.react').forEach(b => b.onclick = () => react(+b.dataset.mid, b.dataset.e));
  box.querySelectorAll('.photo img').forEach(im => im.onclick = () => openLightbox(im.dataset.full));
  box.querySelectorAll('.file').forEach(f => f.onclick = async () => {
    try {
      const r = await Api.get('/uploads/' + f.dataset.dl + '/link');
      const a = document.createElement('a'); a.href = r.url; a.download = ''; a.click();
    } catch (e) { toast(e.message); }
  });
  updateBottom();
}
function findMsg(mid) { return S.msgs.find(m => m.id === mid); }
function msgMenu(x, y, mid) {
  const m = findMsg(mid); if (!m) return;
  const me = m.sender_id === Api.user.id;
  const items = [
    ['↩️ Reply', () => startReply(mid)],
    ['➡️ Forward', () => openForward(mid)],
    ['📋 Copy text', () => { if (m.content) navigator.clipboard?.writeText(m.content); }],
    ['👍 React', () => react(mid, '👍')],
  ];
  if (me && m.message_type === 'text') items.push(['✏️ Edit', () => startEdit(mid)]);
  if (me) items.push(['🗑 Delete', () => delMsg(mid), 1]);
  items.push([m.pinned_at ? 'Unpin' : '📌 Pin', () => pinMsg(mid, !m.pinned_at)]);
  showCtx(x, y, items);
}
function startReply(mid) {
  const m = findMsg(mid); if (!m) return;
  S.replyTo = mid; S.editMsg = null;
  $('#replyName').textContent = 'Reply to ' + m.sender_name;
  $('#replyText').textContent = m.content || m.message_type;
  $('#replyBar').classList.remove('hidden');
  $('#msgInput').focus();
}
function startEdit(mid) {
  const m = findMsg(mid); if (!m) return;
  S.editMsg = mid; S.replyTo = null;
  $('#replyName').textContent = 'Edit message';
  $('#replyText').textContent = m.content;
  $('#replyBar').classList.remove('hidden');
  $('#msgInput').value = m.content; $('#msgInput').focus();
}
function hideReplyBar() { $('#replyBar').classList.add('hidden'); $('#msgInput').value = ''; }
async function react(mid, emoji) {
  try { await Api.send('message:react', { target: targetOf(S.active), messageId: mid, emoji }); }
  catch (e) { toast(e.message || 'React failed'); }
}
async function delMsg(mid) {
  try { await Api.send('message:delete', { target: targetOf(S.active), messageId: mid }); }
  catch (e) { toast(e.message); }
}
async function pinMsg(mid, pin) {
  try { await Api.send(pin ? 'message:pin' : 'message:unpin', { target: targetOf(S.active), messageId: mid }); }
  catch (e) { toast(e.message); }
}
async function markRead(c) {
  c = c || S.active?.ref; if (!c) return;
  const t = c.kind === 'dm' ? { type: 'dm', id: c.id } : { type: 'group', id: c.id };
  try { await Api.post((t.type === 'dm' ? `/conversations/${t.id}` : `/groups/${t.id}`) + '/read'); } catch { }
  c.unread = 0; renderList();
}

/* ================= SEND ================= */
async function send() {
  const inp = $('#msgInput'), t = inp.value.trim();
  if (!S.active) return;
  const target = targetOf(S.active);
  try {
    if (S.editMsg) {
      await Api.send('message:edit', { target, messageId: S.editMsg, content: t });
      S.editMsg = null; hideReplyBar(); return;
    }
    if (!t) return;
    await Api.send('message:send', { target, content: t, replyToId: S.replyTo || undefined });
    S.replyTo = null; hideReplyBar();
  } catch (e) { toast(e.message || 'Send failed'); }
}
async function sendUpload(file, category) {
  if (!S.active) return toast('Open a chat first');
  const fd = new FormData(); fd.append(category, file);
  const upId = crypto.randomUUID?.() || String(Date.now());
  toast('Uploading…');
  try {
    const up = await Api.req('POST', `/uploads/${category}`, fd, { headers: { 'X-Upload-Id': upId } });
    await Api.send('message:send', { target: targetOf(S.active), content: '', attachment: { uploadId: up.id, category }, replyToId: S.replyTo || undefined });
    S.replyTo = null; hideReplyBar();
  } catch (e) { toast(e.message); }
}
let recorder = null, recChunks = [];
async function toggleVoice() {
  if (recorder) {
    recorder.stop(); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined });
    recorder.ondataavailable = e => recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null; $('#micBtn').classList.remove('rec');
      sendUpload(new File([blob,], 'voice.webm', { type: blob.type }), 'voice');
    };
    recorder.start();
    $('#micBtn').classList.add('rec');
    toast('Recording… tap mic to stop');
  } catch { toast('Mic unavailable'); }
}

/* ================= SOCKET IN ================= */
function chatKey(t) { return t.type + ':' + t.id; }
function wireSocket() {
  const R = Api.on.bind(Api);
  R('message:new', async ({ target, message }) => {
    const k = chatKey(target), a = S.active && chatKey(targetOf(S.active)) === k;
    if (a) { S.msgs.push(message); await drawMsgs(); markRead(); }
    else {
      const c = S.chats.find(x => (x.kind === 'dm' ? 'dm' : 'group') === target.type && x.id === target.id);
      if (c) { c.unread++; c.preview = (message.sender_id === Api.user.id ? 'You: ' : message.sender_name.split(' ')[0] + ': ') + (message.content || message.message_type); c.time = message.created_at; renderList(); }
      else reloadLists();
    }
  });
  const patch = (mid, fn) => {
    const m = findMsg(mid);
    if (m) { fn(m); drawMsgs(); }
  };
  R('message:edited', ({ message }) => patch(message.id, m => Object.assign(m, message)));
  R('message:deleted', ({ messageId }) => patch(messageId, m => { m.deleted_at = nowISO(); m.content = ''; }));
  R('message:reaction', ({ messageId, reactions }) => patch(messageId, m => m.reactions = reactions));
  R('message:pinned', ({ message }) => patch(message.messageId || message.id, m => m.pinned_at = nowISO()));
  R('message:unpinned', ({ messageId }) => patch(messageId, m => m.pinned_at = null));
  R('typing', ({ target, user }) => {
    if (user.id === Api.user.id) return;
    S.typingUsers[chatKey(target)] = user.name;
    renderList();
    if (S.active && chatKey(targetOf(S.active)) === chatKey(target)) $('#peerStatus').textContent = user.name + ' typing...';
    clearTimeout(S.typingUsers['_t' + user.id]);
    S.typingUsers['_t' + user.id] = setTimeout(() => {
      delete S.typingUsers[chatKey(target)]; renderList();
      if (S.active && chatKey(targetOf(S.active)) === chatKey(target)) $('#peerStatus').textContent = statusText(S.active.ref);
    }, 2500);
  });
  R('presence:update', ({ userId, online, lastSeenAt }) => {
    const c = S.chats.find(x => x.kind === 'dm' && x.otherId === userId);
    if (c) { c.online = online; c.lastSeen = lastSeenAt || c.lastSeen; renderList(); if (S.active?.ref === c) $('#peerStatus').textContent = statusText(c); }
  });
  R('chat:read', ({ target, userId, lastReadMessageId }) => {
    if (S.active && chatKey(targetOf(S.active)) === chatKey(target)) {
      S.reads[userId] = lastReadMessageId; drawMsgs();
    }
  });
  R('conversation:new', () => reloadLists());
  R('room:invite', ({ invite }) => { toast('Group invite: ' + (invite.groupName || 'new')); });
  R('room:updated', () => reloadLists());
  R('room:deleted', ({ groupId }) => {
    if (S.active?.kind === 'group' && S.active.id === groupId) closeChat();
    reloadLists(); toast('Group deleted');
  });
  R('room:removed', ({ groupId }) => {
    if (S.active?.kind === 'group' && S.active.id === groupId) closeChat();
    reloadLists(); toast('Removed from group');
  });
  R('room:member_removed', () => { if (S.active?.kind === 'group') openChat(S.active.ref); });
  R('room:member_role_changed', () => reloadLists());
  R('profile:updated', p => {
    if (p.id === Api.user.id) { Api.user = { ...Api.user, ...p }; localStorage.setItem('chat_user', JSON.stringify(Api.user)); }
    reloadLists();
  });
  R('notification:broadcast', n => toast('📢 ' + n.title + (n.body ? ': ' + n.body : '')));
  R('upload:progress', ({ percent, done }) => {
    $('#upProg').textContent = done ? '' : `Uploading ${percent || 0}%`;
  });
  const dead = r => { toast(r?.reason || 'Session ended'); logout(true); };
  R('session:revoked', dead);
  R('force:disconnect', dead);
  R('error:message', ({ error }) => toast(error || 'Error'));
  R('unauthorized', () => logout(true));
}
function closeChat() {
  S.active = null; S.msgs = [];
  $('#chatView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  $('#sidebar').classList.remove('hide'); $('#main').classList.add('hide');
}

/* ================= MODALS / MENUS ================= */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
function showCtx(x, y, items) {
  const ctx = $('#ctx');
  ctx.innerHTML = items.map((it, i) => `<button data-i="${i}" class="${it[2] ? 'danger' : ''}">${it[0]}</button>`).join('');
  ctx.classList.remove('hidden');
  ctx.style.left = Math.min(x, innerWidth - 230) + 'px';
  ctx.style.top = Math.min(y, innerHeight - items.length * 44 - 16) + 'px';
  ctx.querySelectorAll('button').forEach(b => b.onclick = () => { ctx.classList.add('hidden'); items[+b.dataset.i][1](); });
}
function openLightbox(attId) {
  Api.uploadLink(attId, true).then(url => {
    $('#lightImg').src = url; openModal('#lightbox');
  }).catch(e => toast(e.message));
}
function openForward(mid) {
  const box = $('#fwdList');
  box.innerHTML = S.chats.map((c, i) => `<button data-i="${i}">${avatarHTML(c.avatarUrl, c.name)}<span>${esc(c.name)}</span></button>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = async () => {
    const c = S.chats[+b.dataset.i];
    try {
      await Api.send('message:forward', { sourceTarget: targetOf(S.active), destTarget: targetOf(c), messageId: mid });
      closeModals(); toast('Forwarded to ' + c.name);
    } catch (e) { toast(e.message); }
  });
  openModal('#fwdModal');
}

/* ================= STICKERS ================= */
async function loadStickers() {
  S.stickers = await Api.get('/packs').catch(() => []);
  const box = $('#stickGrid');
  if (!S.stickers.length) { box.innerHTML = '<p class="hint">No packs yet — import one from Telegram 👇</p>'; return; }
  box.innerHTML = S.stickers.map(p => `<div class="spack"><b>${esc(p.title || 'Pack')}</b><div class="srow">` +
    (p.items || []).slice(0, 24).map(it => `<img loading="lazy" src="/api/stickers/file/${it.id}" data-sid="${it.id}" title="${esc(it.emoji || '')}">`).join('') + '</div></div>').join('');
  box.querySelectorAll('img').forEach(im => im.onclick = () => sendSticker(+im.dataset.sid));
}
async function sendSticker(itemId) {
  try { await Api.send('message:send', { target: targetOf(S.active), sticker: { itemId } }); $('#stickPop').classList.add('hidden'); }
  catch (e) { toast(e.message); }
}

/* ================= GROUPS / CONTACTS ================= */
async function toggleMute(c) {
  try {
    if (c.kind !== 'dm') return;
    if (c.mute) { await Api.del(`/users/${c.otherId}/mute`); c.mute = false; }
    else { await Api.post(`/users/${c.otherId}/mute`); c.mute = true; }
    renderList();
  } catch (e) { toast(e.message); }
}
async function leaveGroup(c) {
  try { await Api.del(`/groups/${c.id}/members/${Api.user.id}`); closeChat(); reloadLists(); }
  catch (e) { toast(e.message); }
}
async function openPeerInfo() {
  const c = S.active?.ref; if (!c) return;
  const box = $('#peerBody');
  if (c.kind === 'dm') {
    const p = await Api.get(`/users/${c.otherId}`).catch(() => null);
    if (!p) return toast('No info');
    box.innerHTML = `${avatarHTML(p.avatarUrl, p.name, 'xl')}
      <h2>${esc(p.name)}</h2><p class="gray">${esc(p.username || p.email || (String(p.phone || '').startsWith('google:') ? 'Google user' : p.phone))} · ${p.online ? 'online' : 'last seen ' + fmtTime(p.lastSeenAt)}</p>
      ${esc(p.bio || '')}
      <div class="btn-row">
        <button id="piBlock">${p.blockedByMe ? 'Unblock' : 'Block'}</button>
        <button id="piMute">${p.mutedByMe ? 'Unmute' : 'Mute'}</button>
      </div>`;
    $('#piBlock').onclick = async () => {
      try { p.blockedByMe ? await Api.del(`/users/${c.otherId}/block`) : await Api.post(`/users/${c.otherId}/block`); openPeerInfo(); }
      catch (e) { toast(e.message); }
    };
    $('#piMute').onclick = () => toggleMute(c).then(openPeerInfo);
  } else {
    const g = await Api.get(`/groups/${c.id}/invite-link`).catch(() => null);
    const members = S.members;
    const isMgr = ['owner', 'admin'].includes(c.myRole) || S.myPerms.includes('groups.manage');
    box.innerHTML = `${avatarHTML(c.avatarUrl, c.name, 'xl')}
      <h2>${esc(c.name)}</h2><p class="gray">${c.type} group · ${members.length} members</p>
      <h4>Members</h4><div class="mlist">${members.map(m => `<div class="mrow">${avatarHTML(null, m.name)}<span>${esc(m.name)}<small>${m.role}</small></span>${isMgr && m.id !== Api.user.id ? `<button data-prom="${m.id}" data-role="${m.role}">${m.role === 'admin' ? 'Demote' : 'Make admin'}</button><button data-kick="${m.id}" class="danger">Remove</button>` : ''}</div>`).join('')}</div>
      ${isMgr ? `<h4>Invite link</h4><p class="gray">${g?.code ? location.origin + g.path : 'none'} <button id="mkLink">New link</button></p>
      <h4>Add member</h4><div class="btn-row"><input id="invInput" placeholder="phone or @username"><button id="invBtn">Invite</button></div>` : ''}`;
    box.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
      try { await Api.del(`/groups/${c.id}/members/${b.dataset.kick}`); openChat(c); openPeerInfo(); } catch (e) { toast(e.message); }
    });
    box.querySelectorAll('[data-prom]').forEach(b => b.onclick = async () => {
      try { await Api.patch(`/groups/${c.id}/members/${b.dataset.prom}`, { role: b.dataset.role === 'admin' ? 'member' : 'admin' }); openChat(c); openPeerInfo(); } catch (e) { toast(e.message); }
    });
    const mk = $('#mkLink');
    if (mk) mk.onclick = async () => { try { await Api.post(`/groups/${c.id}/invite-link`); openPeerInfo(); } catch (e) { toast(e.message); } };
    const ib = $('#invBtn');
    if (ib) ib.onclick = async () => {
      const v = $('#invInput').value.trim(); if (!v) return;
      const body = v.startsWith('@') ? { username: v } : { phone: v };
      try { await Api.post(`/groups/${c.id}/invites`, body); toast('Invited'); } catch (e) { toast(e.message); }
    };
  }
  openModal('#peerModal');
}

/* ================= PROFILE / SESSIONS / NOTIFS ================= */
async function openProfile() {
  const me = await Api.get('/users/me');
  $('#pfName').value = me.name || '';
  $('#pfBio').value = me.bio || '';
  $('#pfUser').value = me.username || '';
  $('#pfAva').outerHTML = avatarHTML(me.avatarUrl, me.name, 'xl').replace('class="avatar xl"', 'id="pfAva" class="avatar xl"');
  $('#verifyRow').classList.toggle('hidden', !!me.phoneVerified);
  const sess = await Api.get('/auth/sessions').catch(() => ({ sessions: [] }));
  $('#sessList').innerHTML = (sess.sessions || []).map(s => `<div class="mrow"><span>${esc(s.deviceName || 'Device')}<small>${esc(s.ipAddress || '')} · ${fmtTime(s.lastUsedAt)}</small></span>${s.current ? '<small>this device</small>' : `<button data-sess="${s.id}">Revoke</button>`}</div>`).join('');
  $('#sessList').querySelectorAll('[data-sess]').forEach(b => b.onclick = async () => {
    await Api.del('/auth/sessions/' + b.dataset.sess).catch(e => toast(e.message)); openProfile();
  });
  openModal('#profileModal');
}
async function startNotifPoll() {
  clearInterval(S.notifTimer);
  const tick = async () => {
    try {
      const { count } = await Api.get('/notifications/unread-count');
      $('#bellBadge').textContent = count || '';
      $('#bellBadge').classList.toggle('hidden', !count);
    } catch { }
  };
  tick(); S.notifTimer = setInterval(tick, 30000);
}
async function openNotifs() {
  const list = await Api.get('/notifications?limit=20').catch(() => []);
  $('#notifList').innerHTML = list.length ? list.map(n => `<div class="mrow"><span>${esc(n.title || '')}<small>${esc(n.body || '')} · ${fmtTime(n.createdAt || n.created_at)}</small></span></div>`).join('') : '<p class="hint">No notifications</p>';
  openModal('#notifModal');
  Api.post('/notifications/read-all').catch(() => {});
}

/* ================= ADMIN ================= */
async function loadInvites() {
  try {
    const inv = await Api.get('/groups/invites');
    $('#invList').innerHTML = inv.length ? inv.map(i => `<div class="mrow"><span>${esc(i.group_name || 'Group')}<small>by ${esc(i.invited_by_name || '')}</small></span><span><button data-acc="${i.id}">Accept</button> <button data-rej="${i.id}">Reject</button></span></div>`).join('') : '<p class="hint">No pending invites</p>';
    $('#invList').querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { try { await Api.post(`/groups/invites/${b.dataset.acc}/accept`); closeModals(); reloadLists(); } catch (e) { toast(e.message); } });
    $('#invList').querySelectorAll('[data-rej]').forEach(b => b.onclick = async () => { try { await Api.post(`/groups/invites/${b.dataset.rej}/reject`); loadInvites(); } catch (e) { toast(e.message); } });
  } catch { $('#invList').innerHTML = ''; }
}
async function openAdmin() {
  openModal('#adminModal');
}
async function adminLookup() {
  const phone = $('#admPhone').value.trim(); if (!phone) return;
  try {
    const u = await Api.get('/admin/users/lookup?phone=' + encodeURIComponent(phone));
    $('#admResult').innerHTML = `<div class="mrow"><span>${esc(u.name)}<small>${esc(u.phone)} · banned:${!!u.banned} muted:${!!u.muted}</small></span></div>
      <div class="btn-row"><button id="admBan">${u.banned ? 'Unban' : 'Ban'}</button><button id="admMute">${u.muted ? 'Unmute' : 'Mute 60m'}</button></div>`;
    $('#admBan').onclick = async () => { try { u.banned ? await Api.post(`/admin/users/${u.id}/unban`) : await Api.post(`/admin/users/${u.id}/ban`, { reason: 'moderation' }); adminLookup(); } catch (e) { toast(e.message); } };
    $('#admMute').onclick = async () => { try { u.muted ? await Api.post(`/admin/users/${u.id}/unmute`) : await Api.post(`/admin/users/${u.id}/mute`, { durationMinutes: 60 }); adminLookup(); } catch (e) { toast(e.message); } };
  } catch (e) { toast(e.message); }
}

/* ================= SECQ / VERIFY / RESET ================= */
async function setupSecQ(auto) {
  try {
    const { questions } = await Api.get('/auth/security-questions/catalog');
    $('#secQList').innerHTML = [0, 1, 2].map(i => `<select data-q="${i}">${questions.map(q => `<option value="${q.id}">${esc(q.text)}</option>`).join('')}</select><input data-a="${i}" placeholder="Answer ${i + 1}">`).join('');
    $('#secQSkip').classList.toggle('hidden', !auto);
    openModal('#secQModal');
  } catch { }
}

/* ================= WIRING ================= */
function updateBottom() {
  const box = $('#msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  $('#toBottom').classList.toggle('hidden', near);
}
document.addEventListener('DOMContentLoaded', () => {
  // auth tabs
  document.querySelectorAll('.atab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.atab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const forms = { phone: 'phoneForm', login: 'loginForm', register: 'regForm', forgot: 'forgotForm' };
    Object.entries(forms).forEach(([k, id]) => $('#' + id).classList.toggle('hidden', k !== t.dataset.t));
  });
  $('#phoneBtn').onclick = () => doPhoneLogin($('#plPhone').value.trim(), $('#plName').value.trim()).catch(e => toast(e.message));
  $('#loginBtn').onclick = () => doLogin($('#liPhone').value.trim(), $('#liPass').value).catch(e => toast(e.message));
  $('#regBtn').onclick = () => {
    if ($('#rgPass').value.length < 6) return toast('Password must be 6+ chars');
    doRegister($('#rgName').value.trim(), $('#rgPhone').value.trim(), $('#rgPass').value).catch(e => toast(e.message));
  };
  $('#fgBtn').onclick = async () => {
    try { const r = await Api.post('/auth/password/forgot', { phone: $('#fgPhone').value.trim() }); toast(r.message || 'Code sent if number exists'); }
    catch (e) { toast(e.message); }
  };
  $('#fgResetBtn').onclick = async () => {
    try { await Api.post('/auth/password/reset', { phone: $('#fgPhone').value.trim(), code: $('#fgCode').value.trim(), newPassword: $('#fgNew').value }); toast('Password changed — log in'); }
    catch (e) { toast(e.message); }
  };
  $('#secQSave').onclick = async () => {
    const qs = [0, 1, 2].map(i => ({ questionId: +document.querySelector(`[data-q="${i}"]`).value, answer: document.querySelector(`[data-a="${i}"]`).value }));
    try { await Api.post('/auth/security-questions/setup', { securityQuestions: qs }); closeModals(); toast('Security questions saved'); }
    catch (e) { toast(e.message); }
  };
  $('#secQSkip').onclick = closeModals;

  // composer
  $('#sendBtn').onclick = send;
  $('#msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#msgInput').addEventListener('input', () => {
    if (!S.active || !Api.socket) return;
    const t = Date.now();
    if (t - S.lastTypingSent > 2000) { S.lastTypingSent = t; Api.send('typing', targetOf(S.active)).catch(() => {}); }
  });
  $('#msgs').addEventListener('scroll', updateBottom);
  $('#toBottom').onclick = () => { const b = $('#msgs'); b.scrollTop = b.scrollHeight; };
  $('#replyClose').onclick = () => { S.replyTo = null; S.editMsg = null; hideReplyBar(); };
  $('#pinnedClose').onclick = () => $('#pinnedBar').classList.add('hidden');
  $('#backBtn').onclick = closeChat;
  $('#search').addEventListener('input', renderList);
  $('#searchMsgBtn').onclick = async () => {
    const q = prompt('Search in this chat:'); if (!q || !S.active) return;
    try {
      const r = await Api.get(msgPath(targetOf(S.active)) + '/messages/search?q=' + encodeURIComponent(q) + '&limit=20');
      S.msgs = r; drawMsgs(); toast(r.length + ' found');
    } catch (e) { toast(e.message); }
  };

  // attach / emoji / stickers / mic
  $('#attachBtn').onclick = e => { e.stopPropagation(); $('#attachPop').classList.toggle('hidden'); };
  document.addEventListener('click', e => { if (!e.target.closest('#attachPop,#attachBtn')) $('#attachPop').classList.add('hidden'); });
  $('#pickPhoto').onclick = () => $('#filePhoto').click();
  $('#pickFile').onclick = () => $('#fileDoc').click();
  $('#pickVideo').onclick = () => $('#fileVideo').click();
  $('#filePhoto').onchange = e => e.target.files[0] && sendUpload(e.target.files[0], 'image');
  $('#fileDoc').onchange = e => e.target.files[0] && sendUpload(e.target.files[0], 'file');
  $('#fileVideo').onchange = e => e.target.files[0] && sendUpload(e.target.files[0], 'video');
  $('#micBtn').onclick = toggleVoice;
  const em = ['😀', '😂', '😍', '👍', '🙏', '🎉', '❤️', '🔥', '👀', '🚀', '😢', '😮', '👏', '💪', '🎨', '📌', '🍲', '🌅', '🤖', '✅', '💯', '🙌', '⭐', '👋'];
  $('#emojiPop').innerHTML = em.map(x => `<span>${x}</span>`).join('');
  $('#emojiPop').querySelectorAll('span').forEach(s => s.onclick = () => { $('#msgInput').value += s.textContent; $('#msgInput').focus(); });
  $('#emojiBtn').onclick = e => { e.stopPropagation(); $('#emojiPop').classList.toggle('hidden'); };
  document.addEventListener('click', e => { if (!e.target.closest('#emojiPop,#emojiBtn')) $('#emojiPop').classList.add('hidden'); });
  $('#stickBtn').onclick = e => { e.stopPropagation(); loadStickers(); $('#stickPop').classList.toggle('hidden'); };
  document.addEventListener('click', e => { if (!e.target.closest('#stickPop,#stickBtn')) $('#stickPop').classList.add('hidden'); });
  $('#stickImport').onclick = async () => {
    const url = $('#stickUrl').value.trim(); if (!url) return;
    try { await Api.post('/packs/import', { url }); $('#stickUrl').value = ''; loadStickers(); toast('Pack imported'); }
    catch (e) { toast(e.message); }
  };

  // drawer / modals
  $('#burger').onclick = () => { $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); };
  $('#fab').onclick = () => { $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); };
  $('#scrim').onclick = () => { $('#drawer').classList.remove('open'); $('#scrim').classList.add('hidden'); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModals);
  document.addEventListener('click', e => { if (!e.target.closest('#ctx')) $('#ctx').classList.add('hidden'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('#ctx').classList.add('hidden'); closeModals(); }
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#search').focus(); }
  });
  $('#themeBtn').onclick = () => {
    const h = document.documentElement;
    h.dataset.theme = h.dataset.theme === 'dark' ? 'light' : 'dark';
    $('#scrim').click();
  };
  $('#logoutBtn').onclick = async () => { try { await Api.post('/auth/logout'); } catch { } logout(); };
  $('#peerBtn').onclick = openPeerInfo;
  $('#infoBtn').onclick = openPeerInfo;
  $('#bellBtn').onclick = openNotifs;
  $('#profileBtn').onclick = () => { $('#scrim').click(); openProfile(); };
  $('#adminBtn').onclick = () => { $('#scrim').click(); openAdmin(); };
  $('#newChatBtn').onclick = () => { $('#scrim').click(); openModal('#newModal'); loadInvites(); };
  $('#startDmBtn').onclick = async () => {
    const v = $('#dmInput').value.trim(); if (!v) return;
    const body = v.startsWith('@') ? { username: v } : (/^\d+$/.test(v) ? { phone: v } : { username: v });
    try { closeModals(); await reloadLists(); const r = await Api.post('/conversations', body); await reloadLists(); const c = S.chats.find(x => x.kind === 'dm' && x.id === r.id); if (c) openChat(c); }
    catch (e) { toast(e.message); }
  };
  $('#createGrpBtn').onclick = async () => {
    const name = $('#grpName').value.trim(); if (!name) return;
    const phones = $('#grpMembers').value.split(',').map(s => s.trim()).filter(Boolean);
    try { const g = await Api.post('/groups', { name, type: $('#grpType').value, memberPhones: phones }); closeModals(); await reloadLists(); const c = S.chats.find(x => x.kind === 'group' && x.id === g.id); if (c) openChat(c); }
    catch (e) { toast(e.message); }
  };
  $('#pubSearchBtn').onclick = async () => {
    try {
      const list = await Api.get('/groups/public?q=' + encodeURIComponent($('#pubQ').value.trim()));
      $('#pubList').innerHTML = list.map((g, i) => `<div class="mrow"><span>${esc(g.name)}<small>${g.memberCount} members</small></span><button data-j="${i}">Join</button></div>`).join('') || '<p class="hint">Nothing found</p>';
      $('#pubList').querySelectorAll('[data-j]').forEach(b => b.onclick = async () => {
        try { await Api.post(`/groups/${list[+b.dataset.j].id}/join`); closeModals(); reloadLists(); toast('Joined'); } catch (e) { toast(e.message); }
      });
    } catch (e) { toast(e.message); }
  };
  $('#pfSave').onclick = async () => {
    try {
      await Api.patch('/users/me', { name: $('#pfName').value.trim(), bio: $('#pfBio').value.trim() });
      if ($('#pfUser').value.trim()) await Api.put('/users/me/username', { username: $('#pfUser').value.trim().replace(/^@/, '') }).catch(e => toast(e.message));
      toast('Saved'); openProfile();
    } catch (e) { toast(e.message); }
  };
  $('#pfAvaBtn').onclick = () => $('#pfAvaFile').click();
  $('#pfAvaFile').onchange = async e => {
    if (!e.target.files[0]) return;
    const fd = new FormData(); fd.append('avatar', e.target.files[0]);
    try { await Api.req('POST', '/users/me/avatar', fd); toast('Avatar updated'); openProfile(); reloadLists(); }
    catch (err) { toast(err.message); }
  };
  $('#verifyBtn').onclick = async () => {
    try { await Api.post('/auth/phone/verify/request'); toast('Code sent'); const code = prompt('Enter SMS code:'); if (code) { await Api.post('/auth/phone/verify/confirm', { code }); toast('Verified'); openProfile(); } }
    catch (e) { toast(e.message); }
  };
  $('#sessOthers').onclick = async () => { try { await Api.del('/auth/sessions/others'); toast('Other sessions revoked'); openProfile(); } catch (e) { toast(e.message); } };
  $('#admGo').onclick = adminLookup;
  $('#admBc').onclick = async () => {
    try { const r = await Api.post('/superadmin/broadcast', { title: $('#admTitle').value, body: $('#admBody').value }); toast('Sent to ' + r.recipients); }
    catch (e) { toast(e.message); }
  };

  boot();
});
