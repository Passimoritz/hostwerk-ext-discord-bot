'use strict';
/*
 * Bridge to Hostwerk: which services exist, starting/stopping them, Team members and the status text.
 * Service ids are the same as in the Team extension (web:<id>, dbs:<id>, mc:<id>, apps:<id>, game:<id>) – so the
 * rights a member has there apply to the bot without further setup.
 */

/** Player lists of all Minecraft servers → join/leave events compared with the last snapshot. Pure, tested. */
function playerDiff(before, after) {
  const out = [];
  for (const [id, now] of after) {
    const old = before.get(id) || { players: [] };
    for (const p of now.players) if (!old.players.includes(p)) out.push({ type: 'join', player: p, server: now.name, id });
    for (const p of old.players) if (!now.players.includes(p)) out.push({ type: 'leave', player: p, server: now.name, id });
  }
  for (const [id, old] of before) if (!after.has(id)) for (const p of old.players) out.push({ type: 'leave', player: p, server: old.name, id });
  return out;
}

function hostwerkAdapter(host, t) {
  const { ctx } = host;
  const procOf = (mgr, id) => { try { return mgr.proc(id).info(); } catch { return { state: 'stopped', extra: {} }; } };
  const name = (x) => x.name || x.id;
  const managers = () => ({ web: ctx.web, dbs: ctx.dbm, mc: ctx.minecraft, apps: ctx.apps });

  function services() {
    const out = [];
    const m = managers();
    for (const [kind, mgr] of Object.entries(m)) {
      if (!mgr || typeof mgr.list !== 'function') continue;
      for (const x of mgr.list() || []) {
        const p = procOf(mgr, x.id);
        out.push({ id: `${kind}:${x.id}`, kind, name: name(x), state: p.state || 'stopped', players: kind === 'mc' ? ((p.extra && p.extra.players) || []) : undefined });
      }
    }
    // Game servers (extension "Game servers"): last known state, no expensive query
    if (ctx.games && typeof ctx.games.summary === 'function') {
      for (const g of ctx.games.summary()) out.push({ id: `game:${g.id}`, kind: 'game', name: g.name || g.id, state: g.running ? 'running' : 'stopped' });
    }
    return out;
  }

  async function control(serviceId, action) {
    const [kind, ...rest] = String(serviceId).split(':');
    const id = rest.join(':');
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action');
    if (kind === 'game') {
      if (!ctx.games) throw new Error('The game server extension is not installed.');
      return ctx.games.run(id, action); // runs as a Hostwerk job
    }
    const mgr = managers()[kind];
    if (!mgr) throw new Error('Unknown service');
    if (typeof mgr.get === 'function') mgr.get(id); // throws for unknown ids
    return mgr[action](id);
  }

  /** Team member by id (Team extension, settings.users) – null without the extension. */
  function team(memberId) {
    if (!ctx.users) return null;
    const list = (ctx.settings.get().users || []);
    const u = list.find((x) => x.id === memberId);
    return u ? { id: u.id, name: u.name, role: u.role, enabled: u.enabled, services: u.services || [], areas: u.areas || [] } : null;
  }
  const teamMembers = () => (ctx.users ? (ctx.settings.get().users || []).map((u) => ({ id: u.id, name: u.name, role: u.role === 'admin' ? 'admin' : 'member', enabled: u.enabled !== false, discordId: u.discordId || null })) : null);
  /** Team 1.2: member with this Discord ID (set in Team) – null without it. */
  const memberOf = (discordUserId) => { try { const u = ctx.users && typeof ctx.users.byDiscord === 'function' ? ctx.users.byDiscord(discordUserId) : null; return u ? u.id : null; } catch { return null; } };
  /** Team 1.2: its own check "may this member do that?" – null = older Team, then the bot's rule applies. */
  const can = ctx.users && typeof ctx.users.can === 'function' ? (memberId, serviceId, area) => !!ctx.users.can(memberId, serviceId, area) : null;

  /** Status text of the bot: the same one Discord status shows in your profile, else our own short summary. */
  function presenceText() {
    const ds = ctx.discord;
    if (ds && typeof ds.activity === 'function') {
      try { const a = ds.activity(); if (a && a.details) return a.state ? `${a.details} · ${a.state}` : a.details; } catch { /* own text */ }
    }
    const list = services();
    const running = list.filter((s) => s.state === 'running').length;
    const players = list.reduce((n, s) => n + (s.state === 'running' && s.players ? s.players.length : 0), 0);
    if (!running) return t('All services stopped');
    return t(running === 1 ? '{n} service running' : '{n} services running', { n: running }) + (players ? ` · ${t(players === 1 ? '{n} player online' : '{n} players online', { n: players })}` : '');
  }

  /** Minecraft servers with their players right now (for the player messages). */
  function playerSnapshot() {
    const map = new Map();
    for (const s of services()) if (s.kind === 'mc' && s.state === 'running') map.set(s.id, { name: s.name, players: [...(s.players || [])] });
    return map;
  }

  return { services, control, team, teamMembers, memberOf, can, presenceText, playerSnapshot };
}

module.exports = { hostwerkAdapter, playerDiff };
