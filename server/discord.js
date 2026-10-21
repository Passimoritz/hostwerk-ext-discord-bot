'use strict';
/*
 * Discord without a library: the Gateway (WebSocket, JSON, API v10) delivers events such as slash commands, REST (fetch)
 * answers them. Both get their transport injected (WebSocket class, fetch, timers) – the tests drive them with fakes and
 * never talk to Discord.
 *
 * Why no discord.js: it pulls in ~40 packages and a voice/cache layer this bot never needs. The handful of packets used
 * here (HELLO, IDENTIFY/RESUME, heartbeat, DISPATCH, PRESENCE) are stable since API v6 and documented.
 */
const { EventEmitter } = require('events');

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE: 3, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
// After these close codes reconnecting makes no sense – the user has to change something first
const FATAL = {
  4004: 'The bot token is wrong – copy it again from the Discord developer portal.',
  4010: 'Discord rejected the connection (invalid shard).',
  4011: 'The bot is in too many servers for one connection.',
  4012: 'Discord rejected the API version.',
  4013: 'Discord rejected the requested events.',
  4014: 'Discord rejected the requested events.',
};
// Close codes after which the old session cannot be resumed
const NEW_SESSION = new Set([4007, 4009]);
const INTENTS = 1; // GUILDS: servers with their roles and channels – slash commands arrive without further intents
const VERSION = '1.0.0';

/** Bot id from the token: the first part is the bot's user id in Base64 (for a bot that is also the application id). */
function appIdFromToken(token) {
  const first = String(token || '').split('.')[0];
  try { const id = Buffer.from(first, 'base64').toString('utf8'); return /^\d{15,22}$/.test(id) ? id : null; } catch { return null; }
}

/** Plausible bot token? (three parts separated by dots, the first one a Base64 id) */
const looksLikeToken = (t) => /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(String(t || '').trim()) && !!appIdFromToken(t);

class Gateway extends EventEmitter {
  /**
   * opts: { token, WebSocket (class with addEventListener/send/close), url, timers: { setTimeout, clearTimeout,
   *         setInterval, clearInterval }, random, properties }
   */
  constructor(opts) {
    super();
    this.token = opts.token;
    this.WS = opts.WebSocket;
    this.url = opts.url || GATEWAY;
    this.tm = opts.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.random = opts.random || Math.random;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.state = 'idle'; // idle · connecting · ready · waiting (reconnect pending) · failed · stopped
    this.error = null;
    this.user = null;
    this.appId = null;
    this.acked = true;
    this.beatTimer = null;
    this.firstBeat = null;
    this.retryTimer = null;
    this.attempts = 0;
    this.presenceData = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this.error = null; this.open(this.url); }

  open(url) {
    this.state = 'connecting';
    let ws;
    try { ws = new this.WS(url); } catch (e) { this.error = e.message; this.later(); return; }
    this.ws = ws;
    ws.addEventListener('message', (e) => this.onRaw(ws, e.data));
    ws.addEventListener('close', (e) => this.onClose(ws, e.code, e.reason));
    ws.addEventListener('error', (e) => { if (ws === this.ws) this.error = (e && e.message) || 'Connection error'; }); // "close" follows
  }

  onRaw(ws, data) {
    if (ws !== this.ws) return;
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    this.onPacket(msg);
  }

  onPacket({ op, d, s, t }) {
    if (s !== null && s !== undefined) this.seq = s;
    if (op === OP.HELLO) {
      this.beat(d && d.heartbeat_interval ? d.heartbeat_interval : 41250);
      if (this.sessionId) this.send(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.seq });
      else this.send(OP.IDENTIFY, { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'hostwerk', device: 'hostwerk' }, ...(this.presenceData ? { presence: this.presenceData } : {}) });
    } else if (op === OP.HEARTBEAT) {
      this.sendBeat();
    } else if (op === OP.HEARTBEAT_ACK) {
      this.acked = true;
    } else if (op === OP.RECONNECT) {
      this.reconnect();
    } else if (op === OP.INVALID_SESSION) {
      if (!d) { this.sessionId = null; this.seq = null; }
      this.reconnect(1000 + Math.floor(this.random() * 4000)); // Discord asks for 1–5 s
    } else if (op === OP.DISPATCH) {
      if (t === 'READY') {
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url ? `${d.resume_gateway_url}/?v=10&encoding=json` : null;
        this.user = d.user || null;
        this.appId = (d.application && d.application.id) || (d.user && d.user.id) || null;
        this.ready();
      } else if (t === 'RESUMED') this.ready();
      this.emit('dispatch', t, d);
    }
  }

  ready() { this.state = 'ready'; this.error = null; this.attempts = 0; this.emit('ready'); }

  beat(interval) {
    this.stopBeat();
    this.acked = true;
    const tick = () => {
      // No answer to the last heartbeat → the connection is dead ("zombie"), start a new one
      if (!this.acked) { this.reconnect(); return; }
      this.acked = false;
      this.sendBeat();
    };
    // The first heartbeat after interval × jitter, as Discord asks
    this.firstBeat = this.tm.setTimeout(() => { tick(); this.beatTimer = this.tm.setInterval(tick, interval); }, Math.floor(interval * this.random()));
  }

  stopBeat() {
    if (this.firstBeat) this.tm.clearTimeout(this.firstBeat);
    if (this.beatTimer) this.tm.clearInterval(this.beatTimer);
    this.firstBeat = null; this.beatTimer = null;
  }

  sendBeat() { this.send(OP.HEARTBEAT, this.seq); }

  send(op, d) {
    const ws = this.ws;
    if (!ws || (ws.readyState !== undefined && ws.readyState !== 1)) return false;
    ws.send(JSON.stringify({ op, d }));
    return true;
  }

  /** Bot status ("Watching …"). Remembered and sent again after every reconnect. */
  presence(activities, status = 'online') {
    this.presenceData = { since: null, activities: activities || [], status, afk: false };
    if (this.state === 'ready') this.send(OP.PRESENCE, this.presenceData);
  }

  /** Close the current connection (keeping the session) and open a new one – resumed when possible. */
  reconnect(delay) {
    const ws = this.ws;
    this.ws = null;
    this.stopBeat();
    if (ws) { try { ws.close(4000, 'reconnect'); } catch { /* already closed */ } }
    this.later(delay);
  }

  onClose(ws, code) {
    if (ws !== this.ws) return; // an old connection we already replaced
    this.ws = null;
    this.stopBeat();
    if (this.stopped) { this.state = 'stopped'; return; }
    if (FATAL[code]) {
      this.state = 'failed';
      this.error = FATAL[code];
      this.sessionId = null;
      this.emit('fatal', code, this.error);
      return;
    }
    if (NEW_SESSION.has(code)) { this.sessionId = null; this.seq = null; }
    this.later();
  }

  /** Try again later: 1 s, 2 s, 4 s … at most one minute (plus a little chance so many bots do not all return at once). */
  later(delay) {
    if (this.stopped) return;
    this.state = 'waiting';
    if (this.retryTimer) this.tm.clearTimeout(this.retryTimer);
    const ms = delay !== undefined ? delay : Math.min(60000, 1000 * 2 ** this.attempts) + Math.floor(this.random() * 500);
    this.attempts++;
    this.retryTimer = this.tm.setTimeout(() => { this.retryTimer = null; this.open(this.sessionId && this.resumeUrl ? this.resumeUrl : this.url); }, ms);
  }

  stop() {
    this.stopped = true;
    this.stopBeat();
    if (this.retryTimer) this.tm.clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.sessionId = null;
    this.state = 'stopped';
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* already closed */ } }
  }
}

class Rest {
  /** opts: { token, fetch, api, sleep } */
  constructor(opts) {
    this.token = opts.token;
    this.fetch = opts.fetch || globalThis.fetch;
    this.api = opts.api || API;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async req(method, path, body, { auth = true, retry = 2 } = {}) {
    const headers = { 'User-Agent': `DiscordBot (https://github.com/Passimoritz/hostwerk-ext-discord-bot, ${VERSION})` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bot ${this.token}`;
    const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(15000);
    const r = await this.fetch(this.api + path, init);
    // Rate limit: wait as long as Discord says (at most 10 s) and try once more
    if (r.status === 429 && retry > 0) {
      let j = {};
      try { j = await r.json(); } catch { /* no body */ }
      await this.sleep(Math.min(10, Number(j.retry_after) || 1) * 1000);
      return this.req(method, path, body, { auth, retry: retry - 1 });
    }
    if (r.status === 204) return null;
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error((j && j.message) || `Discord answered ${r.status}`), { status: r.status, code: j && j.code });
    return j;
  }

  /** Overwrite all slash commands at once (global, or only for one server – then they appear at once). */
  commands(appId, guildId, list) {
    return this.req('PUT', guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`, list);
  }

  /** First answer to an interaction (must come within 3 s). */
  reply(interaction, type, data) {
    return this.req('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, data === undefined ? { type } : { type, data }, { auth: false });
  }

  /** Change the first answer later (valid for 15 minutes). */
  edit(appId, token, data) { return this.req('PATCH', `/webhooks/${appId}/${token}/messages/@original`, data, { auth: false }); }

  send(channelId, data) { return this.req('POST', `/channels/${channelId}/messages`, data); }
}

module.exports = { Gateway, Rest, OP, FATAL, INTENTS, API, GATEWAY, appIdFromToken, looksLikeToken };
