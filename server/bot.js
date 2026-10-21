'use strict';
/*
 * The Discord bot itself: keeps the Gateway connection, registers the slash commands, answers them, asks before stop and
 * restart (buttons), posts player messages into a channel and shows a live status. Free of Hostwerk internals – index.js
 * hands in the adapter "hw" (services, control, team, presence text) and the store; the tests use plain objects.
 */
const crypto = require('crypto');
const { Gateway, Rest, appIdFromToken } = require('./discord');
const C = require('./commands');

const CONFIRM_TTL = 2 * 60 * 1000;
const ACTION_WAIT = 45 * 1000; // longer starts continue in the background, the answer says so
const FEED_DELAY = 5000;
const PRESENCE_DELAY = 20000; // Discord allows only a few status changes per minute
const LOG_MAX = 200;

const DONE = { start: '{name} started.', stop: '{name} stopped.', restart: '{name} restarted.' };
const BUSY = { start: 'Starting {name} …', stop: 'Stopping {name} …', restart: 'Restarting {name} …' };
const ASK = { start: 'Really start {name}?', stop: 'Really stop {name}?', restart: 'Really restart {name}?' };
const DENIED = {
  'no-right': 'You may not do that. Ask the owner of this Hostwerk for a role or a team link.',
  'no-read': 'You may not see this. Ask the owner of this Hostwerk for a role.',
  'not-shared': 'This service is not shared with Discord.',
};
const AUDIT = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' };

class DiscordBot {
  /**
   * deps: { store, hw, tr(lang, text, vars), WebSocket, fetch, timers, audit(entry), log(...), lang() }
   *   store: { cfg(), save(patch), token(), addLog(e), log(), seen(user) }
   *   hw: { services(), control(id, action), team(memberId), presenceText(lang) }
   */
  constructor(deps) {
    this.d = deps;
    this.gw = null;
    this.rest = null;
    this.guilds = new Map(); // id → { id, name, roles, channels }
    this.pending = new Map(); // one-time key → question waiting for a button
    this.feed = [];
    this.feedTimer = null;
    this.presenceTimer = null;
    this.lastPresence = '';
    this.lastError = null;
    this.tm = deps.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  }

  get cfg() { return this.d.store.cfg(); }
  t(lang, text, vars) { return this.d.tr(lang, text, vars); }

  /** Connect when a token is stored and the bot is switched on. Safe to call again (reconnects with the new token). */
  start() {
    this.stop();
    const token = this.d.store.token();
    if (!token || this.cfg.active === false) return false;
    this.rest = new Rest({ token, fetch: this.d.fetch, sleep: this.d.sleep });
    this.gw = new Gateway({ token, WebSocket: this.d.WebSocket, timers: this.d.timers, random: this.d.random });
    this.gw.on('ready', () => this.onReady());
    this.gw.on('dispatch', (t, d) => this.onDispatch(t, d));
    this.gw.on('fatal', (code, text) => { this.lastError = text; this.d.log('gateway closed', code); });
    this.lastError = null;
    this.gw.start();
    return true;
  }

  stop() {
    if (this.gw) { this.gw.removeAllListeners(); this.gw.stop(); }
    this.gw = null;
    this.guilds.clear();
    this.pending.clear();
    this.tm.clearTimeout(this.feedTimer); this.feedTimer = null; this.feed = [];
    this.tm.clearTimeout(this.presenceTimer); this.presenceTimer = null; this.lastPresence = '';
  }

  status() {
    const gw = this.gw;
    const token = this.d.store.token();
    const appId = (gw && gw.appId) || appIdFromToken(token);
    return {
      hasToken: !!token,
      active: this.cfg.active !== false,
      state: !token ? 'no-token' : this.cfg.active === false ? 'off' : gw ? gw.state : 'off',
      error: (gw && gw.error) || this.lastError,
      bot: gw && gw.user ? { id: gw.user.id, name: gw.user.global_name || gw.user.username } : null,
      appId,
      invite: appId ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=19456` : null,
      guilds: [...this.guilds.values()].map((g) => ({ id: g.id, name: g.name, roles: g.roles, channels: g.channels })),
    };
  }

  /* ---------- Gateway events ---------- */

  async onReady() {
    this.lastPresence = '';
    this.schedulePresence(0);
    await this.registerCommands().catch((e) => { this.lastError = e.message; this.d.log('commands', e.message); });
  }

  /** Register the slash commands – only when they changed or the bot/server is a different one. */
  async registerCommands(force = false) {
    if (!this.rest || !this.gw || !this.gw.appId) return false;
    const cfg = this.cfg;
    const key = `${this.gw.appId}|${cfg.guildId || ''}|${C.definitionsKey()}`;
    if (!force && cfg.commandsKey === key) return false;
    await this.rest.commands(this.gw.appId, cfg.guildId || null, C.definitions());
    this.d.store.save({ commandsKey: key });
    return true;
  }

  onDispatch(t, d) {
    if (!d) return;
    if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') {
      const old = this.guilds.get(d.id) || { roles: [], channels: [] };
      this.guilds.set(d.id, {
        id: d.id, name: d.name || old.name,
        // @everyone (same id as the server) and roles of bots (managed) cannot be handed out – not offered
        roles: d.roles ? d.roles.filter((r) => r.id !== d.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.color || 0 })) : old.roles,
        channels: d.channels ? d.channels.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position || 0) - (b.position || 0)).map((c) => ({ id: c.id, name: c.name })) : old.channels,
      });
    } else if (t === 'GUILD_DELETE') this.guilds.delete(d.id);
    else if (/^GUILD_ROLE_(CREATE|UPDATE|DELETE)$/.test(t)) {
      const g = this.guilds.get(d.guild_id);
      if (!g) return;
      const id = d.role ? d.role.id : d.role_id;
      g.roles = g.roles.filter((r) => r.id !== id);
      if (t !== 'GUILD_ROLE_DELETE' && d.role && !d.role.managed) g.roles.push({ id: d.role.id, name: d.role.name, color: d.role.color || 0 });
    } else if (/^CHANNEL_(CREATE|UPDATE|DELETE)$/.test(t) && d.guild_id) {
      const g = this.guilds.get(d.guild_id);
      if (!g) return;
      g.channels = g.channels.filter((c) => c.id !== d.id);
      if (t !== 'CHANNEL_DELETE' && (d.type === 0 || d.type === 5)) g.channels.push({ id: d.id, name: d.name });
    } else if (t === 'INTERACTION_CREATE') {
      this.onInteraction(d).catch((e) => this.d.log('interaction', e.message));
    }
  }

  /* ---------- Interactions ---------- */

  async onInteraction(i) {
    const lang = C.langOf(i);
    const tr = (s, v) => this.t(lang, s, v);
    const u = C.userOf(i);
    if (u.id) this.d.store.seen({ id: u.id, name: C.nameOf(u), t: Date.now() });
    const cfg = this.cfg;
    if (cfg.guildId && i.guild_id !== cfg.guildId) {
      if (i.type === C.IT.AUTOCOMPLETE) return this.rest.reply(i, C.RT.CHOICES, { choices: [] });
      return this.say(i, tr('This bot only answers on its own Discord server.'));
    }
    if (i.type === C.IT.AUTOCOMPLETE) return this.autocomplete(i, tr);
    if (i.type === C.IT.COMPONENT) return this.onButton(i, tr, lang);
    if (i.type !== C.IT.COMMAND || !i.data) return null;
    const name = i.data.name;
    if (name === 'status' || name === 'players') {
      const r = this.allowed(i, name, null);
      if (!r.ok) return this.deny(i, tr, name, null, r.why);
      const list = this.visible();
      const embed = name === 'status' ? C.statusEmbed(list, tr) : C.playersEmbed(list, tr);
      return this.rest.reply(i, C.RT.MESSAGE, { embeds: [embed], allowed_mentions: { parse: [] } });
    }
    if (!C.CONTROL.has(name)) return this.say(i, tr('Unknown command.'));
    const opt = (i.data.options || []).find((o) => o.name === 'service');
    const svc = this.find(opt && opt.value);
    if (!svc) return this.say(i, tr('There is no such service – pick one from the list.'));
    const r = this.allowed(i, name, svc.id);
    if (!r.ok) return this.deny(i, tr, name, svc, r.why);
    if (name === 'start' && svc.state === 'running') return this.say(i, tr('{name} is already running.', { name: C.md(svc.name) }));
    if (name === 'stop' && svc.state === 'stopped') return this.say(i, tr('{name} is already stopped.', { name: C.md(svc.name) }));
    if (C.needsConfirm(cfg, name)) {
      const key = crypto.randomBytes(9).toString('base64url');
      this.prune();
      this.pending.set(key, { userId: u.id, action: name, serviceId: svc.id, expires: Date.now() + CONFIRM_TTL });
      return this.rest.reply(i, C.RT.MESSAGE, { content: tr(ASK[name], { name: `**${C.md(svc.name)}**` }), components: C.confirmButtons(key, name, tr), flags: C.EPHEMERAL, allowed_mentions: { parse: [] } });
    }
    await this.rest.reply(i, C.RT.DEFERRED, { flags: C.EPHEMERAL });
    const text = await this.run(i, name, svc, tr, r.via);
    return this.rest.edit(this.gw.appId, i.token, { content: text, allowed_mentions: { parse: [] } });
  }

  async onButton(i, tr) {
    const m = /^hwb:(ok|no):([\w-]+)$/.exec((i.data && i.data.custom_id) || '');
    if (!m) return null;
    this.prune();
    const q = this.pending.get(m[2]);
    const u = C.userOf(i);
    if (!q) return this.rest.reply(i, C.RT.UPDATE, { content: tr('This question has expired – run the command again.'), components: [] });
    if (q.userId !== u.id) return this.say(i, tr('Only the person who asked can answer.'));
    this.pending.delete(m[2]);
    if (m[1] === 'no') return this.rest.reply(i, C.RT.UPDATE, { content: tr('Cancelled.'), components: [] });
    const svc = this.find(q.serviceId);
    if (!svc) return this.rest.reply(i, C.RT.UPDATE, { content: tr('There is no such service – pick one from the list.'), components: [] });
    // Rights again: roles or links may have changed while the question was open
    const r = this.allowed(i, q.action, svc.id);
    if (!r.ok) { this.addLog(i, q.action, svc, 'denied', r.why); return this.rest.reply(i, C.RT.UPDATE, { content: tr(DENIED[r.why]), components: [] }); }
    await this.rest.reply(i, C.RT.UPDATE, { content: tr(BUSY[q.action], { name: `**${C.md(svc.name)}**` }), components: [], allowed_mentions: { parse: [] } });
    const text = await this.run(i, q.action, svc, tr, r.via);
    return this.rest.edit(this.gw.appId, i.token, { content: text, components: [], allowed_mentions: { parse: [] } });
  }

  async autocomplete(i, tr) {
    const focused = (i.data.options || []).find((o) => o.focused);
    // Only services this person may control are offered (others would only get a "no" afterwards)
    const list = this.visible().filter((s) => this.allowed(i, i.data.name, s.id).ok);
    return this.rest.reply(i, C.RT.CHOICES, { choices: C.choices(list, focused && focused.value, tr) });
  }

  /** Start/stop/restart – waits at most 45 s, longer ones continue in the background. */
  async run(i, action, svc, tr, via) {
    let timer;
    try {
      const done = this.d.hw.control(svc.id, action).then(() => 'done');
      const wait = new Promise((r) => { timer = this.tm.setTimeout(() => r('later'), ACTION_WAIT); });
      const how = await Promise.race([done, wait]);
      done.catch(() => {}); // a later error lands in Hostwerk's own log
      this.addLog(i, action, svc, 'ok', via);
      this.audit(i, action, svc);
      return how === 'later' ? tr('{name} is still busy – Hostwerk carries on in the background.', { name: `**${C.md(svc.name)}**` }) : tr(DONE[action], { name: `**${C.md(svc.name)}**` });
    } catch (e) {
      this.addLog(i, action, svc, 'error', e.message);
      return tr('That did not work: {error}', { error: tr(String(e.message || e)).slice(0, 300) });
    } finally { this.tm.clearTimeout(timer); }
  }

  allowed(i, action, serviceId) {
    const hw = this.d.hw;
    return C.decide(this.cfg, { action, serviceId, member: i.member, userId: C.userOf(i).id, team: (id) => hw.team(id),
      memberOf: typeof hw.memberOf === 'function' ? (uid) => hw.memberOf(uid) : null, can: typeof hw.can === 'function' ? (mid, sid, area) => hw.can(mid, sid, area) : null });
  }

  deny(i, tr, action, svc, why) {
    this.addLog(i, action, svc, 'denied', why);
    return this.say(i, tr(DENIED[why] || DENIED['no-right']));
  }

  say(i, content) { return this.rest.reply(i, C.RT.MESSAGE, { content, flags: C.EPHEMERAL, allowed_mentions: { parse: [] } }); }

  /** Services shared with Discord (all, or the chosen ones). */
  visible() { const cfg = this.cfg; return this.d.hw.services().filter((s) => C.exposed(cfg, s.id)); }
  find(id) { return id ? this.visible().find((s) => s.id === id) || null : null; }

  prune() { const now = Date.now(); for (const [k, q] of this.pending) if (q.expires < now) this.pending.delete(k); }

  addLog(i, action, svc, result, detail) {
    const u = C.userOf(i);
    this.d.store.addLog({ t: Date.now(), user: C.nameOf(u), userId: u.id || null, action, service: svc ? svc.name : null, serviceId: svc ? svc.id : null, result, detail: detail || null }, LOG_MAX);
  }

  audit(i, action, svc) {
    if (!this.d.audit) return;
    try { this.d.audit({ kind: 'Discord', target: svc.name, action: AUDIT[action], via: 'discord', user: C.nameOf(C.userOf(i)) }); } catch { /* no audit log in this Hostwerk */ }
  }

  /* ---------- Player messages and bot status (synergies with Player ticker and Discord status) ---------- */

  /** A player came or went – collected for a few seconds, then one message into the chosen channel. */
  playerEvent(e) {
    const f = this.cfg.feed || {};
    if (!f.on || !f.channelId || !this.gw || this.gw.state !== 'ready') return;
    this.feed.push(e);
    if (this.feedTimer) return;
    this.feedTimer = this.tm.setTimeout(() => this.flushFeed(), FEED_DELAY);
  }

  async flushFeed() {
    this.feedTimer = null;
    const events = this.feed.splice(0);
    const f = this.cfg.feed || {};
    if (!events.length || !this.rest || !f.channelId) return;
    const lang = f.lang === 'en' || f.lang === 'de' ? f.lang : this.d.lang();
    try { await this.rest.send(f.channelId, { content: C.feedText(events, (s, v) => this.t(lang, s, v)), allowed_mentions: { parse: [] } }); } catch (e) { this.lastError = e.message; }
  }

  /** Something changed in Hostwerk → update the bot status soon (bundled). */
  schedulePresence(ms = PRESENCE_DELAY) {
    if (this.presenceTimer) return;
    this.presenceTimer = this.tm.setTimeout(() => { this.presenceTimer = null; this.updatePresence(); }, ms);
  }

  updatePresence() {
    if (!this.gw || this.gw.state !== 'ready') return;
    const on = this.cfg.presence !== false;
    const text = on ? String(this.d.hw.presenceText(this.d.lang()) || '').slice(0, 128) : '';
    if (text === this.lastPresence) return;
    this.lastPresence = text;
    // Custom status (type 4): just the text, without "Playing"
    this.gw.presence(text ? [{ type: 4, name: 'Custom Status', state: text }] : []);
  }
}

module.exports = { DiscordBot, CONFIRM_TTL, ACTION_WAIT };
