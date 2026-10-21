'use strict';
/*
 * Slash commands, rights and message texts – pure functions without Hostwerk or Discord, tested directly.
 *
 * Command names are English (/status, /players, /start, /stop, /restart); German Discord clients see the German names
 * (/spieler, /neustart) and the option "dienst" through Discord's name_localizations.
 */

// Interaction types and answer types of the Discord API
const IT = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4 };
const RT = { MESSAGE: 4, DEFERRED: 5, UPDATE: 7, CHOICES: 8 };
const EPHEMERAL = 64;
const ADMINISTRATOR = 0x8n;

const CONTROL = new Set(['start', 'stop', 'restart']);
const KIND_LABEL = { web: 'Web server', dbs: 'Database', mc: 'Minecraft', apps: 'App', game: 'Game server' };

const serviceOption = {
  type: 3, name: 'service', name_localizations: { de: 'dienst' },
  description: 'Which service', description_localizations: { de: 'Welcher Dienst' },
  required: true, autocomplete: true,
};

/** The command list as Discord expects it (bulk overwrite). Only usable on servers (contexts: guild). */
function definitions() {
  const base = { type: 1, contexts: [0], integration_types: [0] };
  return [
    { ...base, name: 'status', description: 'Which Hostwerk services are running', description_localizations: { de: 'Welche Hostwerk-Dienste laufen' } },
    { ...base, name: 'players', name_localizations: { de: 'spieler' }, description: 'Who is online on the Minecraft servers', description_localizations: { de: 'Wer ist auf den Minecraft-Servern online' } },
    { ...base, name: 'start', description: 'Start a service', description_localizations: { de: 'Einen Dienst starten' }, options: [serviceOption] },
    { ...base, name: 'stop', description: 'Stop a service (asks first)', description_localizations: { de: 'Einen Dienst stoppen (mit Rückfrage)' }, options: [serviceOption] },
    { ...base, name: 'restart', name_localizations: { de: 'neustart' }, description: 'Restart a service (asks first)', description_localizations: { de: 'Einen Dienst neu starten (mit Rückfrage)' }, options: [serviceOption] },
  ];
}

/** Fingerprint of the command list – registered again only when it changes. */
const definitionsKey = () => JSON.stringify(definitions());

/** Language of the person who asked: German Discord → German, everything else English. */
const langOf = (interaction) => (/^de/i.test((interaction && interaction.locale) || '') ? 'de' : 'en');

/** Discord user behind an interaction (in a server under member.user, in direct messages under user). */
const userOf = (i) => (i && ((i.member && i.member.user) || i.user)) || {};
const nameOf = (u) => u.global_name || u.username || u.id || '?';

function isServerAdmin(member) {
  if (!member || member.permissions === undefined) return false;
  try { return (BigInt(member.permissions) & ADMINISTRATOR) === ADMINISTRATOR; } catch { return false; }
}

/** Is this service shared with Discord at all? ("all" or a list of service ids) */
const exposed = (cfg, serviceId) => cfg.services === 'all' || (Array.isArray(cfg.services) && cfg.services.includes(serviceId));

/**
 * May this person do this? → { ok, via: 'everyone'|'admin'|'role'|'team', why }
 *   read (status, players): everyone – unless read roles are set
 *   control (start, stop, restart): service shared AND (server admin if allowed · one of the control roles ·
 *   team member who may start/stop exactly this service)
 * Team member: linked here (cfg.links) or – Team 1.2 – the member with this Discord ID (memberOf).
 * team(memberId) → Team member ({ role, enabled, services, areas }) or null (Team extension missing)
 * can(memberId, serviceId, area) → Team's own check (users.can, Team 1.2) – else the rule here with the same meaning
 */
function decide(cfg, { action, serviceId, member, userId, team, memberOf, can }) {
  const roles = new Set((member && member.roles) || []);
  const hasRole = (list) => Array.isArray(list) && list.some((r) => roles.has(r));
  const admin = cfg.adminsAlways !== false && isServerAdmin(member);
  const memberId = (cfg.links && userId ? cfg.links[userId] : null) || (userId && typeof memberOf === 'function' ? memberOf(userId) : null);
  const tm = memberId && typeof team === 'function' ? team(memberId) : null;
  const teamOk = !!(tm && tm.enabled !== false);
  if (!CONTROL.has(action)) {
    if (!Array.isArray(cfg.readRoles) || !cfg.readRoles.length) return { ok: true, via: 'everyone' };
    if (admin) return { ok: true, via: 'admin' };
    if (hasRole(cfg.readRoles) || hasRole(cfg.controlRoles)) return { ok: true, via: 'role' };
    if (teamOk) return { ok: true, via: 'team' };
    return { ok: false, why: 'no-read' };
  }
  if (!serviceId || !exposed(cfg, serviceId)) return { ok: false, why: 'not-shared' };
  if (admin) return { ok: true, via: 'admin' };
  if (hasRole(cfg.controlRoles)) return { ok: true, via: 'role' };
  const teamAllows = typeof can === 'function' ? () => can(memberId, serviceId, 'start-stop') : () => tm.role === 'admin' || ((tm.services || []).includes(serviceId) && (tm.areas || []).includes('start-stop'));
  if (teamOk && teamAllows()) return { ok: true, via: 'team' };
  return { ok: false, why: 'no-right' };
}

/** Stop and restart always ask; start only when switched on. */
const needsConfirm = (cfg, action) => action === 'stop' || action === 'restart' || (action === 'start' && !!cfg.confirmStart);

/** Discord markdown in player and service names harmless (Steve_42 stays Steve_42, no italics). */
const md = (s) => String(s == null ? '' : s).replace(/([\\*_~`|>#[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');

const DOT = { running: '🟢', starting: '🟡', stopping: '🟡', error: '🔴', crashed: '🔴' };
const isRunning = (s) => s.state === 'running';

/** Value of the autocomplete: name, kind and state – filtered by what was typed, at most 25 (Discord limit). */
function choices(services, typed, tr) {
  const q = String(typed || '').trim().toLowerCase();
  return services
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .slice(0, 25)
    .map((s) => ({ name: `${s.name} · ${tr(KIND_LABEL[s.kind] || s.kind)} · ${tr(isRunning(s) ? 'running' : 'stopped')}`.slice(0, 100), value: s.id }));
}

/** /status as one embed: one line per service, running ones first. */
function statusEmbed(services, tr) {
  const running = services.filter(isRunning).length;
  const sorted = [...services].sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || a.name.localeCompare(b.name));
  const lines = sorted.slice(0, 30).map((s) => {
    const players = s.kind === 'mc' && isRunning(s) && s.players ? ` · ${tr(s.players.length === 1 ? '{n} player' : '{n} players', { n: s.players.length })}` : '';
    return `${DOT[s.state] || '⚪'} **${md(s.name)}** · ${tr(KIND_LABEL[s.kind] || s.kind)}${players}`;
  });
  if (sorted.length > 30) lines.push(tr('… and {n} more', { n: sorted.length - 30 }));
  return {
    title: tr('Hostwerk status'),
    description: services.length ? lines.join('\n') : tr('No services are shared with Discord.'),
    color: running ? 0x22c55e : 0x6b7280,
    footer: { text: tr(running === 1 ? '{n} of {total} service running' : '{n} of {total} services running', { n: running, total: services.length }) },
  };
}

/** /players: who is online, per running Minecraft server. */
function playersEmbed(services, tr) {
  const mc = services.filter((s) => s.kind === 'mc' && isRunning(s));
  const total = mc.reduce((n, s) => n + (s.players || []).length, 0);
  const fields = mc.slice(0, 25).map((s) => ({ name: md(s.name), value: (s.players || []).length ? s.players.map(md).join(', ').slice(0, 1024) : tr('Nobody online'), inline: false }));
  return {
    title: tr(total === 1 ? '{n} player online' : '{n} players online', { n: total }),
    description: mc.length ? undefined : tr('No Minecraft server is running.'),
    fields: fields.length ? fields : undefined,
    color: total ? 0x22c55e : 0x6b7280,
  };
}

/** Buttons under the question „Really stop …?“ – custom_id carries the one-time key. */
function confirmButtons(key, action, tr) {
  const label = { start: 'Yes, start', stop: 'Yes, stop', restart: 'Yes, restart' }[action];
  return [{ type: 1, components: [
    { type: 2, style: action === 'start' ? 1 : 4, label: tr(label), custom_id: `hwb:ok:${key}` },
    { type: 2, style: 2, label: tr('Cancel'), custom_id: `hwb:no:${key}` },
  ] }];
}

/** Player messages for a channel: joins and leaves of several seconds in one message. */
const FEED = { join: '{player} joined {server}', leave: '{player} left {server}' };
function feedText(events, tr) {
  return events.slice(0, 20).map((e) => tr(FEED[e.type] || FEED.join, { player: `**${md(e.player)}**`, server: md(e.server) })).join('\n')
    + (events.length > 20 ? `\n${tr('… and {n} more', { n: events.length - 20 })}` : '');
}

module.exports = { IT, RT, EPHEMERAL, CONTROL, KIND_LABEL, definitions, definitionsKey, langOf, userOf, nameOf, isServerAdmin, exposed, decide, needsConfirm, md, choices, statusEmbed, playersEmbed, confirmButtons, feedText };
