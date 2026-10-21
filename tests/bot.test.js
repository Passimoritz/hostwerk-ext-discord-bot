'use strict';
/*
 * Discord control: Gateway protocol, REST, rights, slash commands, confirm buttons, player messages and bot status –
 * all with imitated Discord events (fake WebSocket, fake fetch, fake timers). Never connects to Discord.
 *   node --test tests/*.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Gateway, Rest, OP, appIdFromToken, looksLikeToken } = require('../server/discord');
const C = require('../server/commands');
const { DiscordBot } = require('../server/bot');
const { Store, clean } = require('../server/store');
const { playerDiff, hostwerkAdapter } = require('../server/hostwerk');
const { translator } = require('../server/i18n');
const de = require('../locales/de.json');

const APP = '123456789012345678';
const TOKEN = `${Buffer.from(APP).toString('base64').replace(/=+$/, '')}.GhIjKl.abcdefghijklmnopqrstuvwxyz0123`;
const GUILD = '222222222222222222';
const ROLE_MOD = '333333333333333333';
const USER = '444444444444444444';
const OTHER = '555555555555555555';

/* ---------- Fakes ---------- */

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.l = {}; this.closed = null; FakeWS.all.push(this); }
  addEventListener(n, f) { (this.l[n] = this.l[n] || []).push(f); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.readyState = 3; }
  fire(n, e) { for (const f of this.l[n] || []) f(e); }
  msg(o) { this.fire('message', { data: JSON.stringify(o) }); }
  ops(op) { return this.sent.filter((p) => p.op === op); }
}
FakeWS.all = [];
const lastWS = () => FakeWS.all[FakeWS.all.length - 1];

function fakeTimers() {
  let n = 0;
  const q = new Map();
  const add = (fn, ms, repeat) => { const id = ++n; q.set(id, { fn, ms, repeat }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: (id) => q.delete(id),
    clearInterval: (id) => q.delete(id),
    pending: () => [...q.values()],
    /** Fire every waiting one-shot timer once (intervals with `intervals: true`). */
    run({ intervals = false } = {}) {
      for (const [id, x] of [...q]) {
        if (x.repeat && !intervals) continue;
        if (!x.repeat) q.delete(id);
        x.fn();
      }
    },
  };
}

function fakeFetch(answer = () => ({ status: 200, body: {} })) {
  const calls = [];
  const f = async (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
    calls.push(call);
    const a = answer(call) || { status: 200, body: {} };
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status });
  };
  f.calls = calls;
  return f;
}

const secrets = { seal: (s) => `enc:${Buffer.from(s).toString('base64')}`, open: (s) => Buffer.from(String(s).slice(4), 'base64').toString() };
const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hw-discord-bot-')), secrets);
const flush = () => new Promise((r) => setImmediate(r));

/* ---------- Gateway ---------- */

test('token helpers', () => {
  assert.strictEqual(appIdFromToken(TOKEN), APP);
  assert.ok(looksLikeToken(TOKEN));
  assert.ok(!looksLikeToken('hello'));
  assert.ok(!looksLikeToken(''));
});

test('gateway: identify, heartbeat, zombie connection, resume, fatal close', () => {
  FakeWS.all = [];
  const tm = fakeTimers();
  const gw = new Gateway({ token: TOKEN, WebSocket: FakeWS, timers: tm, random: () => 0.5 });
  const events = [];
  gw.on('dispatch', (t) => events.push(t));
  gw.start();
  const ws = lastWS();
  assert.match(ws.url, /gateway\.discord\.gg\/\?v=10&encoding=json/);
  ws.msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  const id = ws.ops(OP.IDENTIFY)[0];
  assert.strictEqual(id.d.token, TOKEN);
  assert.strictEqual(id.d.intents, 1);
  ws.msg({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example', user: { id: APP, username: 'HostwerkBot' }, application: { id: APP } } });
  assert.strictEqual(gw.state, 'ready');
  assert.strictEqual(gw.appId, APP);
  assert.deepStrictEqual(events, ['READY']);

  // first heartbeat after interval × jitter, carrying the last sequence number
  tm.run();
  assert.deepStrictEqual(ws.ops(OP.HEARTBEAT).map((p) => p.d), [1]);
  ws.msg({ op: OP.HEARTBEAT_ACK });
  tm.run({ intervals: true });
  assert.strictEqual(ws.ops(OP.HEARTBEAT).length, 2);
  // no ACK → zombie → close with 4000 (session kept) and resume on the resume address
  tm.run({ intervals: true });
  assert.strictEqual(ws.closed, 4000);
  tm.run();
  const ws2 = lastWS();
  assert.notStrictEqual(ws2, ws);
  assert.match(ws2.url, /^wss:\/\/resume\.example/);
  ws2.msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  const resume = ws2.ops(OP.RESUME)[0];
  assert.deepStrictEqual(resume.d, { token: TOKEN, session_id: 'sess', seq: 1 });
  ws2.msg({ op: OP.DISPATCH, t: 'RESUMED', s: 2, d: {} });
  assert.strictEqual(gw.state, 'ready');

  // Discord asks for a new connection (op 7) → resume again
  ws2.msg({ op: OP.RECONNECT, d: null });
  tm.run();
  lastWS().msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  assert.strictEqual(lastWS().ops(OP.RESUME).length, 1);

  // invalid session that cannot be resumed → identify from scratch
  lastWS().msg({ op: OP.INVALID_SESSION, d: false });
  tm.run();
  lastWS().msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  assert.strictEqual(lastWS().ops(OP.IDENTIFY).length, 1);

  // wrong token: close code 4004 → no reconnect, readable error
  const before = FakeWS.all.length;
  lastWS().fire('close', { code: 4004 });
  tm.run();
  assert.strictEqual(FakeWS.all.length, before);
  assert.strictEqual(gw.state, 'failed');
  assert.match(gw.error, /token/);
});

test('gateway: dropped connection → reconnect with growing pause, stop() ends it', () => {
  FakeWS.all = [];
  const tm = fakeTimers();
  const gw = new Gateway({ token: TOKEN, WebSocket: FakeWS, timers: tm, random: () => 0 });
  gw.start();
  lastWS().fire('close', { code: 1006 });
  assert.strictEqual(gw.state, 'waiting');
  assert.strictEqual(tm.pending()[0].ms, 1000);
  tm.run();
  lastWS().fire('close', { code: 1006 });
  assert.strictEqual(tm.pending()[0].ms, 2000);
  gw.stop();
  assert.strictEqual(tm.pending().length, 0);
  assert.strictEqual(gw.state, 'stopped');
});

test('gateway: bot status is sent when ready and again in IDENTIFY after a new session', () => {
  FakeWS.all = [];
  const tm = fakeTimers();
  const gw = new Gateway({ token: TOKEN, WebSocket: FakeWS, timers: tm, random: () => 0 });
  gw.presence([{ type: 4, name: 'Custom Status', state: 'x' }]);
  gw.start();
  lastWS().msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  assert.strictEqual(lastWS().ops(OP.IDENTIFY)[0].d.presence.activities[0].state, 'x');
  lastWS().msg({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's', user: { id: APP }, application: { id: APP } } });
  gw.presence([{ type: 4, name: 'Custom Status', state: 'y' }]);
  assert.strictEqual(lastWS().ops(OP.PRESENCE)[0].d.activities[0].state, 'y');
  gw.stop();
});

/* ---------- REST ---------- */

test('rest: rate limit is waited out, errors carry Discord\'s message', async () => {
  let n = 0;
  const waited = [];
  const fetch = fakeFetch(() => (++n === 1 ? { status: 429, body: { retry_after: 0.25 } } : n === 2 ? { status: 200, body: { ok: 1 } } : { status: 403, body: { message: 'Missing Access', code: 50001 } }));
  const rest = new Rest({ token: TOKEN, fetch, sleep: async (ms) => { waited.push(ms); } });
  assert.deepStrictEqual(await rest.send('1', { content: 'hi' }), { ok: 1 });
  assert.deepStrictEqual(waited, [250]);
  assert.strictEqual(fetch.calls[0].headers.Authorization, `Bot ${TOKEN}`);
  await assert.rejects(rest.send('1', {}), (e) => e.message === 'Missing Access' && e.status === 403);
  // interaction answers need no token
  await rest.reply({ id: '9', token: 'tok' }, 4, { content: 'x' }).catch(() => {});
  const last = fetch.calls[fetch.calls.length - 1];
  assert.match(last.url, /\/interactions\/9\/tok\/callback$/);
  assert.strictEqual(last.headers.Authorization, undefined);
});

/* ---------- Rights ---------- */

test('rights: roles, server admins, team links, shared services', () => {
  const cfg = { services: ['mc:survival', 'web:apache'], controlRoles: [ROLE_MOD], readRoles: [], adminsAlways: true, links: { [USER]: 'm1' } };
  const team = (id) => (id === 'm1' ? { role: 'mitglied', enabled: true, services: ['mc:survival'], areas: ['start-stop'] } : null);
  const plain = { roles: [], permissions: '0' };
  assert.deepStrictEqual(C.decide(cfg, { action: 'status', member: plain, userId: OTHER }), { ok: true, via: 'everyone' });
  assert.strictEqual(C.decide(cfg, { action: 'stop', serviceId: 'mc:survival', member: plain, userId: OTHER }).why, 'no-right');
  assert.strictEqual(C.decide(cfg, { action: 'stop', serviceId: 'mc:survival', member: { roles: [ROLE_MOD] }, userId: OTHER }).via, 'role');
  assert.strictEqual(C.decide(cfg, { action: 'stop', serviceId: 'mc:survival', member: { roles: [], permissions: String(0x8) }, userId: OTHER }).via, 'admin');
  assert.strictEqual(C.decide({ ...cfg, adminsAlways: false }, { action: 'stop', serviceId: 'mc:survival', member: { roles: [], permissions: '8' }, userId: OTHER }).ok, false);
  // linked team member: only the services shared with them in the Team extension
  assert.strictEqual(C.decide(cfg, { action: 'restart', serviceId: 'mc:survival', member: plain, userId: USER, team }).via, 'team');
  assert.strictEqual(C.decide(cfg, { action: 'restart', serviceId: 'web:apache', member: plain, userId: USER, team }).ok, false);
  assert.strictEqual(C.decide(cfg, { action: 'restart', serviceId: 'mc:survival', member: plain, userId: USER, team: () => ({ role: 'mitglied', enabled: false, services: ['mc:survival'], areas: ['start-stop'] }) }).ok, false);
  // not shared with Discord → nobody, not even admins
  assert.strictEqual(C.decide(cfg, { action: 'start', serviceId: 'dbs:mariadb', member: { roles: [ROLE_MOD], permissions: '8' }, userId: OTHER }).why, 'not-shared');
  // read roles set → only those (and control roles, admins, team)
  const r = { ...cfg, readRoles: ['666666666666666666'] };
  assert.strictEqual(C.decide(r, { action: 'players', member: plain, userId: OTHER }).why, 'no-read');
  assert.ok(C.decide(r, { action: 'players', member: { roles: [ROLE_MOD] }, userId: OTHER }).ok);
  assert.ok(C.decide(r, { action: 'players', member: plain, userId: USER, team }).ok);
  assert.ok(C.needsConfirm({}, 'stop') && C.needsConfirm({}, 'restart') && !C.needsConfirm({}, 'start') && C.needsConfirm({ confirmStart: true }, 'start'));
});

test('rights with Team 1.2: member found by the Discord ID set in Team, the check of Team decides; links still win', () => {
  const cfg = { services: 'all', controlRoles: [], readRoles: [ROLE_MOD], adminsAlways: true, links: {} };
  const plain = { roles: [], permissions: '0' };
  const team = (id) => ({ m1: { role: 'mitglied', enabled: true, services: [], areas: [] }, m2: { role: 'mitglied', enabled: true } })[id] || null;
  const memberOf = (uid) => (uid === OTHER ? 'm1' : null);
  const asked = [];
  const can = (mid, sid, area) => { asked.push([mid, sid, area]); return mid === 'm1' && sid === 'game:valheim'; };
  assert.strictEqual(C.decide(cfg, { action: 'start', serviceId: 'game:valheim', member: plain, userId: OTHER, team, memberOf, can }).via, 'team');
  assert.deepStrictEqual(asked, [['m1', 'game:valheim', 'start-stop']]);
  assert.strictEqual(C.decide(cfg, { action: 'start', serviceId: 'mc:survival', member: plain, userId: OTHER, team, memberOf, can }).why, 'no-right');
  assert.ok(C.decide(cfg, { action: 'players', member: plain, userId: OTHER, team, memberOf, can }).ok, 'read: known team member');
  assert.strictEqual(C.decide(cfg, { action: 'players', member: plain, userId: USER, team, memberOf, can }).why, 'no-read', 'unknown Discord user');
  // Verknüpfung auf der Bot-Seite geht vor der Discord-ID in Team
  asked.length = 0;
  C.decide({ ...cfg, links: { [OTHER]: 'm2' } }, { action: 'start', serviceId: 'game:valheim', member: plain, userId: OTHER, team, memberOf, can });
  assert.strictEqual(asked[0][0], 'm2');
});

test('Hostwerk adapter: Team 1.2 gives memberOf and can, older Team gives neither', () => {
  const S = { users: [{ id: 'm1', name: 'Lena', role: 'mitglied', discordId: '123456789012345678' }] };
  const users = { byDiscord: (d) => (d === '123456789012345678' ? { id: 'm1' } : null), can: (m, s, a) => m === 'm1' && s === 'mc:x' && a === 'start-stop' };
  const hw = hostwerkAdapter({ ctx: { settings: { get: () => S }, users } }, (s) => s);
  assert.strictEqual(hw.memberOf('123456789012345678'), 'm1'); assert.strictEqual(hw.memberOf('1'), null);
  assert.strictEqual(hw.can('m1', 'mc:x', 'start-stop'), true); assert.strictEqual(hw.can('m1', 'mc:y', 'start-stop'), false);
  assert.strictEqual(hw.teamMembers()[0].discordId, '123456789012345678');
  const old = hostwerkAdapter({ ctx: { settings: { get: () => S }, users: {} } }, (s) => s);
  assert.strictEqual(old.can, null); assert.strictEqual(old.memberOf('123456789012345678'), null);
});

test('command definitions: English names with German localisations, guild only, autocomplete', () => {
  const defs = C.definitions();
  assert.deepStrictEqual(defs.map((d) => d.name), ['status', 'players', 'start', 'stop', 'restart']);
  assert.strictEqual(defs.find((d) => d.name === 'players').name_localizations.de, 'spieler');
  assert.strictEqual(defs.find((d) => d.name === 'restart').name_localizations.de, 'neustart');
  for (const d of defs) {
    assert.match(d.name, /^[-_a-z0-9]{1,32}$/);
    assert.ok(d.description.length <= 100 && d.description_localizations.de.length <= 100);
    assert.deepStrictEqual(d.contexts, [0]);
  }
  const opt = defs.find((d) => d.name === 'stop').options[0];
  assert.ok(opt.autocomplete && opt.required && opt.name_localizations.de === 'dienst');
});

test('texts: markdown in names is neutralised, embeds stay inside Discord limits', () => {
  const tr = translator();
  const t = (s, v) => tr('de', s, v);
  assert.strictEqual(C.md('Steve_42 *x* @everyone'), 'Steve\\_42 \\*x\\* @​everyone');
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `web:w${i}`, kind: 'web', name: `W${i}`, state: i % 2 ? 'running' : 'stopped' }));
  const e = C.statusEmbed(many, t);
  assert.ok(e.description.length <= 4096);
  assert.match(e.description, /… und 10 weitere/);
  assert.match(e.footer.text, /20 von 40 Diensten laufen/);
  const p = C.playersEmbed([{ id: 'mc:a', kind: 'mc', name: 'Survival', state: 'running', players: ['Alex', 'Steve'] }], t);
  assert.strictEqual(p.title, '2 Spieler online');
  assert.strictEqual(p.fields[0].value, 'Alex, Steve');
  assert.match(C.feedText([{ type: 'join', player: 'Alex', server: 'Survival' }, { type: 'leave', player: 'Steve', server: 'Survival' }], t), /\*\*Alex\*\* ist Survival beigetreten\n\*\*Steve\*\* hat Survival verlassen/);
});

/* ---------- Store ---------- */

test('store: only known settings, token encrypted on disk', () => {
  const s = tmpStore();
  s.save({ controlRoles: [ROLE_MOD, 'evil', ROLE_MOD], services: ['mc:survival', '../x'], links: { [USER]: 'm1', bad: 'm2' }, feed: { on: true, channelId: 'x' }, bogus: 1 });
  assert.deepStrictEqual(s.cfg().controlRoles, [ROLE_MOD]);
  assert.deepStrictEqual(s.cfg().services, ['mc:survival']);
  assert.deepStrictEqual(s.cfg().links, { [USER]: 'm1' });
  assert.strictEqual(s.cfg().feed.on, true);
  assert.strictEqual(s.cfg().feed.channelId, '');
  assert.strictEqual(s.cfg().bogus, undefined);
  s.setToken(TOKEN);
  assert.strictEqual(s.token(), TOKEN);
  const raw = fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8');
  assert.ok(!raw.includes(TOKEN), 'token never in clear text');
  assert.strictEqual(s.pub().token, undefined);
  assert.deepStrictEqual(clean({ services: 'all' }, {}).services, 'all');
});

test('player list changes → join and leave events', () => {
  const a = new Map([['mc:s', { name: 'Survival', players: ['Alex'] }]]);
  const b = new Map([['mc:s', { name: 'Survival', players: ['Steve'] }]]);
  assert.deepStrictEqual(playerDiff(a, b).map((e) => `${e.type}:${e.player}`), ['join:Steve', 'leave:Alex']);
  assert.deepStrictEqual(playerDiff(a, new Map()).map((e) => `${e.type}:${e.player}`), ['leave:Alex']);
});

/* ---------- Bot end to end ---------- */

function setup({ cfg = {}, control } = {}) {
  FakeWS.all = [];
  const tm = fakeTimers();
  const services = [
    { id: 'mc:survival', kind: 'mc', name: 'Survival', state: 'running', players: ['Alex'] },
    { id: 'web:apache', kind: 'web', name: 'Apache', state: 'stopped' },
    { id: 'dbs:mariadb', kind: 'dbs', name: 'MariaDB', state: 'running' },
  ];
  const controlled = [];
  const store = tmpStore();
  store.setToken(TOKEN);
  store.save({ controlRoles: [ROLE_MOD], ...cfg });
  const audits = [];
  const fetch = fakeFetch(() => ({ status: 200, body: {} }));
  const bot = new DiscordBot({
    store, tr: translator(), WebSocket: FakeWS, fetch, timers: tm, random: () => 0, sleep: async () => {},
    lang: () => 'de', log: () => {}, audit: (e) => audits.push(e),
    hw: {
      services: () => services,
      control: control || (async (id, action) => { controlled.push(`${action}:${id}`); }),
      team: (id) => (id === 'm1' ? { role: 'mitglied', enabled: true, services: ['web:apache'], areas: ['start-stop'] } : null),
      presenceText: () => '2 Dienste laufen · 1 Spieler online',
    },
  });
  bot.start();
  const ws = lastWS();
  ws.msg({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  ws.msg({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's', user: { id: APP, username: 'HostwerkBot' }, application: { id: APP } } });
  ws.msg({ op: OP.DISPATCH, t: 'GUILD_CREATE', s: 2, d: { id: GUILD, name: 'Mein Server', roles: [{ id: GUILD, name: '@everyone', position: 0 }, { id: ROLE_MOD, name: 'Mods', position: 2, color: 5 }, { id: '777777777777777777', name: 'Bot', managed: true, position: 1 }], channels: [{ id: '888888888888888888', name: 'allgemein', type: 0, position: 1 }, { id: '999999999999999999', name: 'Sprache', type: 2 }] } });
  let n = 0;
  const interact = async (d) => {
    const i = { id: String(++n), token: `tok${n}`, guild_id: GUILD, locale: 'de', ...d };
    ws.msg({ op: OP.DISPATCH, t: 'INTERACTION_CREATE', s: 10 + n, d: i });
    await flush(); await flush(); await flush();
    return fetch.calls.filter((c) => c.url.includes(`/tok${n}/`) || c.url.includes(`/tok${n}`));
  };
  const member = (roles = [], id = OTHER) => ({ roles, permissions: '0', user: { id, username: id === USER ? 'pascal' : 'gast' } });
  return { bot, ws, tm, fetch, store, controlled, audits, interact, member, services };
}

test('bot: registers commands once, knows roles and channels, sets its status', async () => {
  const { bot, ws, tm, fetch } = setup();
  await flush();
  const put = fetch.calls.filter((c) => c.method === 'PUT');
  assert.strictEqual(put.length, 1);
  assert.match(put[0].url, new RegExp(`/applications/${APP}/commands$`));
  assert.strictEqual(put[0].body.length, 5);
  // a second READY (new session) does not register again
  ws.msg({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's2', user: { id: APP }, application: { id: APP } } });
  await flush();
  assert.strictEqual(fetch.calls.filter((c) => c.method === 'PUT').length, 1);
  const st = bot.status();
  assert.strictEqual(st.state, 'ready');
  assert.match(st.invite, new RegExp(`client_id=${APP}&scope=bot\\+applications\\.commands`));
  assert.deepStrictEqual(st.guilds[0].roles.map((r) => r.name), ['Mods'], '@everyone and bot roles are not offered');
  assert.deepStrictEqual(st.guilds[0].channels.map((c) => c.name), ['allgemein']);
  tm.run();
  assert.strictEqual(ws.ops(OP.PRESENCE).at(-1).d.activities[0].state, '2 Dienste laufen · 1 Spieler online');
  bot.stop();
});

test('bot: /status and /spieler answer for everyone, in the language of the asker', async () => {
  const { bot, interact, member } = setup();
  let [r] = await interact({ type: 2, data: { name: 'status' }, member: member() });
  assert.strictEqual(r.body.type, 4);
  assert.strictEqual(r.body.data.embeds[0].title, 'Hostwerk-Status');
  assert.match(r.body.data.embeds[0].description, /🟢 \*\*Survival\*\* · Minecraft · 1 Spieler/);
  [r] = await interact({ type: 2, data: { name: 'players' }, member: member(), locale: 'en-US' });
  assert.strictEqual(r.body.data.embeds[0].title, '1 player online');
  bot.stop();
});

test('bot: /stop without the right role is refused and logged', async () => {
  const { bot, interact, member, controlled, store } = setup();
  const [r] = await interact({ type: 2, data: { name: 'stop', options: [{ name: 'service', value: 'mc:survival' }] }, member: member() });
  assert.strictEqual(r.body.data.flags, 64, 'only the asker sees it');
  assert.match(r.body.data.content, /darfst du nicht/);
  assert.deepStrictEqual(controlled, []);
  assert.strictEqual(store.log()[0].result, 'denied');
  bot.stop();
});

test('bot: /stop with role asks with buttons; only the asker can confirm; then it runs', async () => {
  const { bot, interact, member, controlled, audits, fetch, store } = setup();
  const [ask] = await interact({ type: 2, data: { name: 'stop', options: [{ name: 'service', value: 'mc:survival' }] }, member: member([ROLE_MOD]) });
  assert.match(ask.body.data.content, /Survival.*wirklich stoppen/);
  const buttons = ask.body.data.components[0].components;
  assert.strictEqual(buttons[0].style, 4);
  assert.strictEqual(buttons[0].label, 'Ja, stoppen');
  const ok = buttons[0].custom_id;
  // someone else presses the button
  const [foreign] = await interact({ type: 3, data: { custom_id: ok }, member: member([ROLE_MOD], USER) });
  assert.match(foreign.body.data.content, /Nur wer gefragt hat/);
  assert.deepStrictEqual(controlled, []);
  // the asker confirms
  const calls = await interact({ type: 3, data: { custom_id: ok }, member: member([ROLE_MOD]) });
  assert.strictEqual(calls[0].body.type, 7);
  assert.match(calls[0].body.data.content, /wird gestoppt/);
  assert.deepStrictEqual(controlled, ['stop:mc:survival']);
  const edit = fetch.calls.find((c) => c.method === 'PATCH');
  assert.match(edit.url, new RegExp(`/webhooks/${APP}/tok\\d+/messages/@original$`));
  assert.match(edit.body.content, /Survival.*gestoppt/);
  assert.deepStrictEqual(audits[0], { kind: 'Discord', target: 'Survival', action: 'gestoppt', via: 'discord', user: 'gast' });
  assert.strictEqual(store.log()[0].result, 'ok');
  // the same button cannot be used twice
  const [again] = await interact({ type: 3, data: { custom_id: ok }, member: member([ROLE_MOD]) });
  assert.match(again.body.data.content, /abgelaufen/);
  assert.strictEqual(controlled.length, 1);
  bot.stop();
});

test('bot: cancel button, expired question and rights checked again on confirm', async () => {
  const { bot, interact, member, controlled, store } = setup();
  const ask = async () => (await interact({ type: 2, data: { name: 'restart', options: [{ name: 'service', value: 'mc:survival' }] }, member: member([ROLE_MOD]) }))[0].body.data.components[0].components;
  let b = await ask();
  const [no] = await interact({ type: 3, data: { custom_id: b[1].custom_id }, member: member([ROLE_MOD]) });
  assert.match(no.body.data.content, /Abgebrochen/);
  b = await ask();
  for (const q of bot.pending.values()) q.expires = Date.now() - 1;
  const [old] = await interact({ type: 3, data: { custom_id: b[0].custom_id }, member: member([ROLE_MOD]) });
  assert.match(old.body.data.content, /abgelaufen/);
  b = await ask();
  store.save({ controlRoles: [] }); // role taken away while the question was open
  const [denied] = await interact({ type: 3, data: { custom_id: b[0].custom_id }, member: member([ROLE_MOD]) });
  assert.match(denied.body.data.content, /darfst du nicht/);
  assert.deepStrictEqual(controlled, []);
  bot.stop();
});

test('bot: /start runs directly (deferred answer), team link gives rights for its services only', async () => {
  const { bot, interact, member, controlled, store } = setup();
  store.save({ links: { [USER]: 'm1' } });
  const calls = await interact({ type: 2, data: { name: 'start', options: [{ name: 'service', value: 'web:apache' }] }, member: member([], USER) });
  assert.strictEqual(calls[0].body.type, 5);
  assert.strictEqual(calls[0].body.data.flags, 64);
  assert.deepStrictEqual(controlled, ['start:web:apache']);
  assert.match(calls[1].body.content, /Apache.*gestartet/);
  assert.strictEqual(store.log()[0].detail, 'team');
  // already running → no action
  const [r] = await interact({ type: 2, data: { name: 'start', options: [{ name: 'service', value: 'mc:survival' }] }, member: member([ROLE_MOD]) });
  assert.match(r.body.data.content, /läuft schon/);
  assert.deepStrictEqual(controlled, ['start:web:apache']);
  bot.stop();
});

test('bot: errors of the action are shown, slow actions continue in the background', async () => {
  const { bot, interact, member } = setup({ control: async () => { throw new Error('Port 80 belegt'); } });
  const calls = await interact({ type: 2, data: { name: 'start', options: [{ name: 'service', value: 'web:apache' }] }, member: member([ROLE_MOD]) });
  assert.match(calls[1].body.content, /Das hat nicht geklappt: Port 80 belegt/);
  bot.stop();
  const s = setup({ control: () => new Promise(() => {}) });
  const p = s.interact({ type: 2, data: { name: 'start', options: [{ name: 'service', value: 'web:apache' }] }, member: s.member([ROLE_MOD]) });
  await flush(); await flush();
  s.tm.run(); // the 45 s are over
  const calls2 = await p; await flush(); await flush();
  const edit = s.fetch.calls.find((c) => c.method === 'PATCH');
  assert.ok(calls2.length >= 1);
  assert.match(edit.body.content, /im Hintergrund/);
  s.bot.stop();
});

test('bot: autocomplete offers only services the person may control', async () => {
  const { bot, interact, member, store } = setup();
  store.save({ links: { [USER]: 'm1' } });
  const [r] = await interact({ type: 4, data: { name: 'stop', options: [{ name: 'service', value: '', focused: true }] }, member: member([], USER) });
  assert.strictEqual(r.body.type, 8);
  assert.deepStrictEqual(r.body.data.choices.map((c) => c.value), ['web:apache']);
  const [all] = await interact({ type: 4, data: { name: 'stop', options: [{ name: 'service', value: 'surv', focused: true }] }, member: member([ROLE_MOD]) });
  assert.deepStrictEqual(all.body.data.choices, [{ name: 'Survival · Minecraft · läuft', value: 'mc:survival' }]);
  bot.stop();
});

test('bot: only shared services and only on its own Discord server', async () => {
  const { bot, interact, member, store } = setup();
  store.save({ services: ['web:apache'] });
  let [r] = await interact({ type: 2, data: { name: 'stop', options: [{ name: 'service', value: 'mc:survival' }] }, member: member([ROLE_MOD]) });
  assert.match(r.body.data.content, /gibt es nicht/);
  [r] = await interact({ type: 2, data: { name: 'status' }, member: member() });
  assert.ok(!r.body.data.embeds[0].description.includes('Survival'));
  store.save({ guildId: '101010101010101010' });
  [r] = await interact({ type: 2, data: { name: 'status' }, member: member() });
  assert.match(r.body.data.content, /nur auf seinem eigenen Discord-Server/);
  bot.stop();
});

test('bot: player messages are bundled into one channel message', async () => {
  const { bot, tm, fetch, store } = setup();
  store.save({ feed: { on: true, channelId: '888888888888888888', lang: 'de' } });
  bot.playerEvent({ type: 'join', player: 'Steve', server: 'Survival' });
  bot.playerEvent({ type: 'leave', player: 'Alex', server: 'Survival' });
  tm.run();
  await flush(); await flush();
  const sent = fetch.calls.filter((c) => c.url.endsWith('/channels/888888888888888888/messages'));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body.content, /\*\*Steve\*\* ist Survival beigetreten\n\*\*Alex\*\* hat Survival verlassen/);
  assert.deepStrictEqual(sent[0].body.allowed_mentions, { parse: [] });
  bot.stop();
});

test('bot: without token or switched off it does not connect', () => {
  FakeWS.all = [];
  const store = tmpStore();
  const bot = new DiscordBot({ store, tr: translator(), WebSocket: FakeWS, fetch: fakeFetch(), hw: {}, lang: () => 'de', log: () => {} });
  assert.strictEqual(bot.start(), false);
  assert.strictEqual(bot.status().state, 'no-token');
  store.setToken(TOKEN);
  store.save({ active: false });
  assert.strictEqual(bot.start(), false);
  assert.strictEqual(bot.status().state, 'off');
  assert.strictEqual(FakeWS.all.length, 0);
});

test('every text the bot sends has a German translation', () => {
  const src = ['bot.js', 'commands.js', 'hostwerk.js', 'discord.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8')).join('\n');
  const texts = new Set();
  for (const m of src.matchAll(/\b(?:tr|t)\(\s*(?:[^'()]*\?\s*)?'([^']+)'(?:\s*:\s*'([^']+)')?/g)) { texts.add(m[1]); if (m[2]) texts.add(m[2]); }
  for (const block of src.matchAll(/const (?:DONE|BUSY|ASK|DENIED|KIND_LABEL|FATAL|FEED) = \{([\s\S]*?)\};/g)) for (const m of block[1].matchAll(/:\s*'([^']+)'/g)) texts.add(m[1]);
  for (const m of src.matchAll(/label = \{([^}]*)\}/g)) for (const x of m[1].matchAll(/'([^']+)'/g)) if (/^Yes/.test(x[1])) texts.add(x[1]);
  const missing = [...texts].filter((s) => /[a-z]/.test(s) && !de[s] && !['Custom Status'].includes(s));
  assert.deepStrictEqual(missing, []);
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});
