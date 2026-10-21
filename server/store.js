'use strict';
/*
 * Settings, recent Discord users and the action log of the bot – JSON files in its own data folder.
 * The bot token is stored sealed (seal/open from Hostwerk's core "secrets": AES-GCM, key in config/secret.key),
 * so the settings file alone never reveals it.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  active: true,
  guildId: '',
  controlRoles: [],
  readRoles: [],
  adminsAlways: true,
  confirmStart: false,
  services: 'all',
  links: {},
  feed: { on: false, channelId: '', lang: '' },
  presence: true,
};
const SNOWFLAKE = /^\d{15,22}$/;
const SERVICE_ID = /^(web|dbs|mc|apps|game):[\w.-]{1,80}$/;

/** Only known fields with sensible values – everything else is dropped. Pure, tested. */
function clean(patch, prev) {
  const out = { ...prev };
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => SNOWFLAKE.test(x)))].slice(0, 50) : undefined);
  if (typeof patch.active === 'boolean') out.active = patch.active;
  if (typeof patch.guildId === 'string' && (patch.guildId === '' || SNOWFLAKE.test(patch.guildId.trim()))) out.guildId = patch.guildId.trim();
  if (ids(patch.controlRoles)) out.controlRoles = ids(patch.controlRoles);
  if (ids(patch.readRoles)) out.readRoles = ids(patch.readRoles);
  if (typeof patch.adminsAlways === 'boolean') out.adminsAlways = patch.adminsAlways;
  if (typeof patch.confirmStart === 'boolean') out.confirmStart = patch.confirmStart;
  if (patch.services === 'all') out.services = 'all';
  else if (Array.isArray(patch.services)) out.services = [...new Set(patch.services.filter((x) => SERVICE_ID.test(x)))].slice(0, 200);
  if (patch.links && typeof patch.links === 'object' && !Array.isArray(patch.links)) {
    out.links = {};
    for (const [k, v] of Object.entries(patch.links)) if (SNOWFLAKE.test(k) && typeof v === 'string' && /^[\w-]{1,40}$/.test(v)) out.links[k] = v;
  }
  if (patch.feed && typeof patch.feed === 'object') {
    const f = { ...DEFAULTS.feed, ...(prev.feed || {}) };
    if (typeof patch.feed.on === 'boolean') f.on = patch.feed.on;
    if (typeof patch.feed.channelId === 'string' && (patch.feed.channelId === '' || SNOWFLAKE.test(patch.feed.channelId))) f.channelId = patch.feed.channelId;
    if (['', 'de', 'en'].includes(patch.feed.lang)) f.lang = patch.feed.lang;
    out.feed = f;
  }
  if (typeof patch.presence === 'boolean') out.presence = patch.presence;
  if (typeof patch.commandsKey === 'string') out.commandsKey = patch.commandsKey;
  return out;
}

class Store {
  /** dir: data folder · secrets: { seal, open } */
  constructor(dir, secrets) {
    this.dir = dir;
    this.secrets = secrets;
    fs.mkdirSync(dir, { recursive: true });
    this.data = { ...DEFAULTS, ...this.read('config.json', {}) };
    this.logs = this.read('log.json', []);
    this.users = this.read('users.json', []);
  }

  read(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fallback; } }
  write(name, value) {
    const f = path.join(this.dir, name);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value, null, 1));
    fs.renameSync(`${f}.tmp`, f);
  }

  cfg() { return this.data; }
  /** Settings for the page – never the token. */
  pub() { const { token, commandsKey, ...rest } = this.data; return rest; }
  save(patch) { this.data = { ...clean(patch || {}, this.data), token: this.data.token }; this.write('config.json', this.data); return this.pub(); }

  token() { return this.data.token ? this.secrets.open(this.data.token) : ''; }
  setToken(token) {
    this.data.token = token ? this.secrets.seal(token) : '';
    delete this.data.commandsKey; // a different bot needs its commands
    this.write('config.json', this.data);
  }

  log() { return this.logs; }
  addLog(e, max = 200) { this.logs.unshift(e); this.logs.length = Math.min(this.logs.length, max); this.write('log.json', this.logs); }
  clearLog() { this.logs = []; this.write('log.json', this.logs); }

  /** Who used the bot lately – offered on the page to link with a team member. */
  seen(u) {
    const known = this.users.find((x) => x.id === u.id);
    if (known && known.name === u.name && Date.now() - known.t < 60000) return;
    this.users = [u, ...this.users.filter((x) => x.id !== u.id)].slice(0, 30);
    this.write('users.json', this.users);
  }
  recent() { return this.users; }
}

module.exports = { Store, clean, DEFAULTS };
