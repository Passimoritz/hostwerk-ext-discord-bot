'use strict';
/*
 * Native part of "Discord control" (SDK 2.7):
 *   GET    /api/discord-bot            → state, settings (never the token), services, team members, recent users, log
 *   PUT    /api/discord-bot/settings   → roles, shared services, team links, player messages, bot status …
 *   PUT    /api/discord-bot/token      → { token } ('' removes it) – stored encrypted, the bot reconnects
 *   POST   /api/discord-bot/commands   → register the slash commands again
 *   DELETE /api/discord-bot/log        → clear the action log
 * Outgoing connections only (Discord Gateway + REST) – no port is opened, nothing in Hostwerk becomes public.
 */
const path = require('path');
const { DiscordBot } = require('./bot');
const { Store } = require('./store');
const { hostwerkAdapter, playerDiff } = require('./hostwerk');
const { translator } = require('./i18n');
const { looksLikeToken } = require('./discord');

let bot = null;
let unhook = null;

function activate(host) {
  const { ctx } = host;
  const { bus } = host.core('events');
  const store = new Store(path.join(ctx.paths.data, 'discord-bot'), host.core('secrets'));
  const hw = hostwerkAdapter(host, host.t);
  const tr = translator(path.join(host.dir, 'locales', 'de.json'));
  // Node 22+ (and Electron) bring a WebSocket client; otherwise the "ws" package Hostwerk ships anyway
  const WebSocketImpl = globalThis.WebSocket || host.lib('ws');
  bot = new DiscordBot({
    store, hw, tr,
    WebSocket: WebSocketImpl,
    fetch: globalThis.fetch,
    lang: host.lang,
    log: (...a) => host.log(...a),
    audit: ctx.audit && typeof ctx.audit.record === 'function' ? (e) => ctx.audit.record(e) : null,
  });

  // Player messages and bot status follow Hostwerk's live events
  let players = hw.playerSnapshot();
  const onBus = (m) => {
    if (!m || (m.type !== 'status' && m.type !== 'mc-player-join')) return;
    bot.schedulePresence();
    if (m.type === 'status' && !String(m.svc || '').startsWith('mc:')) return;
    const now = hw.playerSnapshot();
    for (const e of playerDiff(players, now)) bot.playerEvent(e);
    players = now;
  };
  bus.on('broadcast', onBus);
  unhook = () => bus.removeListener('broadcast', onBus);

  const state = () => {
    let ticker = false;
    try { ticker = !!(ctx.extMarket && ctx.extMarket.get('player-ticker')); } catch { /* not installed */ }
    return {
      ...bot.status(),
      cfg: store.pub(),
      services: hw.services().map(({ id, kind, name, state: s }) => ({ id, kind, name, state: s })),
      team: hw.teamMembers(),
      users: store.recent(),
      log: store.log().slice(0, 60),
      synergies: { discordStatus: !!ctx.discord, playerTicker: ticker, team: !!ctx.users },
    };
  };

  host.router.get('/discord-bot', (req, res) => res.json(state()));
  host.router.put('/discord-bot/settings', async (req, res) => {
    const before = store.cfg();
    const wasActive = before.active !== false;
    store.save(req.body || {});
    const cfg = store.cfg();
    if ((cfg.active !== false) !== wasActive) { if (cfg.active === false) bot.stop(); else bot.start(); }
    else if (bot.gw && bot.gw.state === 'ready') {
      bot.lastPresence = '';
      bot.updatePresence();
      await bot.registerCommands().catch((e) => { bot.lastError = e.message; });
    }
    res.json(state());
  });
  host.router.put('/discord-bot/token', (req, res) => {
    const token = String((req.body || {}).token || '').trim().replace(/^Bot\s+/i, '');
    if (token && !looksLikeToken(token)) throw host.error(400, 'That does not look like a bot token. Copy it under Bot → Reset Token in the Discord developer portal.');
    store.setToken(token);
    if (token) bot.start(); else bot.stop();
    res.json(state());
  });
  host.router.post('/discord-bot/commands', async (req, res) => {
    if (!bot.gw || bot.gw.state !== 'ready') throw host.error(409, 'The bot is not connected.');
    await bot.registerCommands(true);
    res.json(state());
  });
  host.router.delete('/discord-bot/log', (req, res) => { store.clearLog(); res.json(state()); });

  host.on('shutdown', () => deactivate());
  // Never connect to the real Discord in Hostwerk's own tests
  if (!process.env.HW_TEST || process.env.HW_TEST_DISCORD_BOT) bot.start();
}

function deactivate() {
  if (unhook) unhook();
  unhook = null;
  if (bot) bot.stop();
  bot = null;
}

module.exports = { activate, deactivate };
