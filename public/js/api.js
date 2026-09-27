/* Luckyroom API + Socket client */
'use strict';
const Api = {
  token: localStorage.getItem('chat_token') || null,
  user: JSON.parse(localStorage.getItem('chat_user') || 'null'),
  socket: null,
  handlers: {},
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
  emit(ev, d) { (this.handlers[ev] || []).forEach(f => { try { f(d); } catch (e) { console.error(e); } }); },

  save(token, user) {
    this.token = token; this.user = user;
    localStorage.setItem('chat_token', token);
    localStorage.setItem('chat_user', JSON.stringify(user));
  },
  clear() {
    this.token = null; this.user = null;
    localStorage.removeItem('chat_token'); localStorage.removeItem('chat_user');
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
  },

  async req(method, path, body, opts = {}) {
    const headers = {};
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    let fetchBody;
    if (body instanceof FormData) { fetchBody = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
    Object.assign(headers, opts.headers || {});
    const res = await fetch('/api' + path, { method, headers, body: fetchBody });
    if (res.status === 401) { this.emit('unauthorized'); throw new Error('Unauthorized'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  },
  get(p) { return this.req('GET', p); },
  post(p, b, o) { return this.req('POST', p, b, o); },
  patch(p, b) { return this.req('PATCH', p, b); },
  put(p, b) { return this.req('PUT', p, b); },
  del(p) { return this.req('DELETE', p); },

  connectSocket() {
    if (this.socket) this.socket.disconnect();
    return new Promise((resolve, reject) => {
      const s = io({ auth: { token: this.token } });
      this.socket = s;
      const evs = ['message:new', 'message:edited', 'message:deleted', 'message:pinned',
        'message:unpinned', 'message:reaction', 'message:forwarded', 'typing',
        'presence:update', 'chat:read', 'conversation:new', 'room:invite', 'room:updated',
        'room:deleted', 'room:removed', 'room:member_removed', 'room:member_role_changed',
        'profile:updated', 'notification:broadcast', 'upload:progress',
        'session:revoked', 'force:disconnect', 'error:message'];
      evs.forEach(e => s.on(e, d => this.emit(e, d)));
      s.on('connect', () => resolve(s));
      s.on('connect_error', err => { this.emit('unauthorized', err); reject(err); });
    });
  },
  send(ev, data) { return new Promise(res => this.socket.emit(ev, data, res)); },

  async uploadLink(attId, inline) {
    const r = await this.get('/uploads/' + attId + '/link' + (inline ? '?inline=1' : ''));
    return r.url;
  }
};
