import { useEffect, useState } from 'react';
import { Bot, ExternalLink, KeyRound, ShieldCheck, Server, Radio, Trash2, RefreshCw, Users, ListChecks, Activity, UserPlus } from 'lucide-react';
import { put, post, del, useApi, openExternal } from '@hostwerk/api';
import { Btn, SettingRow, Switch, Callout, InfoTip, Field, Empty, Loading, TileEmpty, Seg, toast, confirmDialog } from '@hostwerk/ui';
import './style.css';

/*
 * Discord control: set up the bot (token + invite), decide who may do what (Discord roles, team links, shared services),
 * player messages and bot status, and the log of everything done through Discord.
 * Texts are English; German comes from locales/de.json (translated automatically, also inside JSX).
 */
const PORTAL = 'https://discord.com/developers/applications';
const STATE = {
  ready: ['Connected', 'ok'], connecting: ['Connecting …', 'warn'], waiting: ['Reconnecting …', 'warn'],
  failed: ['Connection failed', 'err'], off: ['Off', ''], 'no-token': ['Not set up', ''], idle: ['Off', ''], stopped: ['Off', ''],
};
const KIND = { web: 'Web server', dbs: 'Database', mc: 'Minecraft', apps: 'App', game: 'Game server' };
const ACTION = { status: '/status', players: '/players', start: '/start', stop: '/stop', restart: '/restart' };
const RESULT = { ok: ['Done', 'ok'], denied: ['Refused', 'warn'], error: ['Failed', 'err'] };
const WHY = { 'no-right': 'no right', 'no-read': 'no right', 'not-shared': 'not shared', role: 'via role', admin: 'server admin', team: 'team member', everyone: '' };

function StateBadge({ s }) {
  const [label, kind] = STATE[s.state] || STATE.off;
  return <span className={`badge ${kind}`}>{label}</span>;
}

/** Bot token: entered once, stored encrypted, never shown again. */
function TokenForm({ onSaved, onCancel }) {
  const [token, setToken] = useState('');
  const save = async () => { try { onSaved(await put('/discord-bot/token', { token })); toast.success('Saved – the bot connects'); } catch (e) { toast.error(e); } };
  return (
    <div className="row-tight dbot-token">
      <input className="input mono grow" type="password" autoComplete="off" spellCheck="false" aria-label="Bot token" placeholder="Paste the bot token" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) save(); }} />
      <Btn className="primary" icon={KeyRound} disabled={!token.trim()} onClick={save}>Save token</Btn>
      {onCancel && <Btn className="ghost" onClick={onCancel}>Cancel</Btn>}
    </div>
  );
}

function Setup({ onSaved }) {
  return (
    <div className="card mb">
      <div className="card-head"><Bot size={16} /><h3>Set up your bot</h3>
        <InfoTip title="Your own bot">The bot belongs to you: Hostwerk logs in with your token, the token stays encrypted on this PC and only goes to Discord.</InfoTip>
      </div>
      <div className="card-body stack">
        <ol className="dbot-steps">
          <li><span>Open the Discord developer portal and create a “New Application” – its name is what people see in Discord, for example “Hostwerk”.</span><Btn className="sm" icon={ExternalLink} onClick={() => openExternal(PORTAL)}>Open the developer portal</Btn></li>
          <li><span>Under “Bot” click “Reset Token” and copy the token. No special intents are needed.</span></li>
          <li><span>Paste the token here:</span></li>
        </ol>
        <TokenForm onSaved={onSaved} />
      </div>
    </div>
  );
}

/** Check boxes for Discord roles (all servers of the bot, or the chosen one). */
function RolePicker({ guilds, value, onChange, label }) {
  const roles = guilds.flatMap((g) => g.roles.map((r) => ({ ...r, guild: g.name })));
  if (!roles.length) return <span className="small muted">Invite the bot to your server first – then its roles appear here.</span>;
  const set = new Set(value || []);
  const toggle = (id) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); onChange([...n]); };
  return (
    <div className="dbot-chips" role="group" aria-label={label}>
      {roles.map((r) => (
        <label key={r.id} className={`dbot-chip ${set.has(r.id) ? 'active' : ''}`} title={guilds.length > 1 ? r.guild : undefined}>
          <input type="checkbox" checked={set.has(r.id)} onChange={() => toggle(r.id)} />
          <span className="dbot-dot" aria-hidden="true" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'var(--muted)' }} />
          <span>{r.name}</span>
        </label>
      ))}
    </div>
  );
}

function Rights({ s, save }) {
  const c = s.cfg;
  const guilds = c.guildId ? s.guilds.filter((g) => g.id === c.guildId) : s.guilds;
  return (
    <div className="card">
      <div className="card-head"><ShieldCheck size={16} /><h3>Who may do what</h3>
        <InfoTip title="Rights">Everyone on your Discord server may use /status and /players. Starting, stopping and restarting is only for the roles chosen here, server admins (if allowed) and linked team members – for exactly the services shared with them in the Team extension.</InfoTip>
      </div>
      <div className="card-body">
        {s.guilds.length > 0 && (
          <SettingRow title="Discord server" text="The bot answers only there.">
            <select className="select sm" aria-label="Discord server" value={c.guildId} onChange={(e) => save({ guildId: e.target.value })}>
              <option value="">Every server of the bot</option>
              {s.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </SettingRow>
        )}
        <Field label="May start, stop and restart"><RolePicker guilds={guilds} value={c.controlRoles} label="May start, stop and restart" onChange={(v) => save({ controlRoles: v })} /></Field>
        <Field label="May see status and players" hint="None chosen = everyone on the server."><RolePicker guilds={guilds} value={c.readRoles} label="May see status and players" onChange={(v) => save({ readRoles: v })} /></Field>
        <SettingRow title="Server admins may always" text="People with the Administrator right on your Discord server."><Switch checked={c.adminsAlways !== false} onChange={(v) => save({ adminsAlways: v })} /></SettingRow>
        <SettingRow title="Ask before starting too" text="Stop and restart always ask with a button."><Switch checked={!!c.confirmStart} onChange={(v) => save({ confirmStart: v })} /></SettingRow>
      </div>
    </div>
  );
}

function Services({ s, save }) {
  const c = s.cfg;
  const all = c.services === 'all';
  const chosen = new Set(all ? s.services.map((x) => x.id) : c.services);
  const toggle = (id) => { const n = new Set(chosen); if (n.has(id)) n.delete(id); else n.add(id); save({ services: [...n] }); };
  return (
    <div className="card">
      <div className="card-head"><Server size={16} /><h3>Services in Discord</h3>
        <InfoTip title="Shared services">Only these appear in /status and can be started or stopped from Discord. Others stay invisible there – even for admins.</InfoTip>
      </div>
      <div className="card-body stack">
        <Seg options={[{ id: 'all', label: 'All services' }, { id: 'some', label: 'Only chosen ones' }]} value={all ? 'all' : 'some'} onChange={(v) => save({ services: v === 'all' ? 'all' : s.services.map((x) => x.id) })} />
        {!s.services.length ? <span className="small muted">No services yet.</span> : (
          <div className="dbot-services">
            {s.services.map((x) => (
              <label key={x.id} className="dbot-service">
                <input type="checkbox" checked={chosen.has(x.id)} disabled={all} onChange={() => toggle(x.id)} />
                <span className={`dbot-state ${x.state === 'running' ? 'on' : ''}`} aria-hidden="true" />
                <span className="grow ellipsis">{x.name}</span>
                <span className="tiny muted">{KIND[x.kind] || x.kind}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TeamLinks({ s, save }) {
  const c = s.cfg;
  if (!s.synergies.team) {
    return (
      <div className="card">
        <div className="card-head"><Users size={16} /><h3>Team members</h3></div>
        <TileEmpty icon={Users} text="With the Team extension you can link Discord users to team members – they then get exactly their rights." href="#/ext" action="Extensions" />
      </div>
    );
  }
  const linked = Object.keys(c.links || {});
  const users = [...s.users];
  for (const id of linked) if (!users.some((u) => u.id === id)) users.push({ id, name: id });
  const link = (uid, mid) => { const n = { ...(c.links || {}) }; if (mid) n[uid] = mid; else delete n[uid]; save({ links: n }); };
  return (
    <div className="card">
      <div className="card-head"><Users size={16} /><h3>Team members</h3>
        <InfoTip title="Link Discord users">Everyone who used the bot shows up here. Link them to a team member – the bot then allows exactly what this member may do in Hostwerk (services and “start, stop, restart”).</InfoTip>
      </div>
      {!users.length ? <TileEmpty icon={UserPlus} text="Nobody has used the bot yet. Type /status in Discord – then you show up here." /> : (
        <table className="table">
          <thead><tr><th>Discord user</th><th>Team member</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b><div className="tiny muted mono">{u.id}</div></td>
                <td>
                  <select className="select sm" aria-label={`Team member for ${u.name}`} value={(c.links || {})[u.id] || ''} onChange={(e) => link(u.id, e.target.value)}>
                    <option value="">Not linked</option>
                    {(s.team || []).map((m) => <option key={m.id} value={m.id} disabled={!m.enabled}>{m.name}{m.role === 'admin' ? ' (admin)' : ''}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Extras({ s, save }) {
  const c = s.cfg;
  const f = c.feed || {};
  const guilds = c.guildId ? s.guilds.filter((g) => g.id === c.guildId) : s.guilds;
  const channels = guilds.flatMap((g) => g.channels.map((ch) => ({ ...ch, guild: g.name })));
  return (
    <div className="card">
      <div className="card-head"><Radio size={16} /><h3>Messages and status</h3></div>
      <div className="card-body">
        <SettingRow title="Player messages in a channel" text={s.synergies.playerTicker ? 'Like the player ticker – who joins and leaves your Minecraft servers.' : 'Who joins and leaves your Minecraft servers.'}>
          <Switch checked={!!f.on} onChange={(v) => save({ feed: { on: v } })} />
        </SettingRow>
        {f.on && (
          <div className="row-tight dbot-feed">
            <select className="select sm grow" aria-label="Channel" value={f.channelId} onChange={(e) => save({ feed: { channelId: e.target.value } })}>
              <option value="">Choose a channel …</option>
              {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}{guilds.length > 1 ? ` · ${ch.guild}` : ''}</option>)}
            </select>
            <Seg options={[{ id: '', label: 'Like Hostwerk' }, { id: 'de', label: 'German' }, { id: 'en', label: 'English' }]} value={f.lang || ''} onChange={(v) => save({ feed: { lang: v } })} />
          </div>
        )}
        <SettingRow title="Show status at the bot" text={s.synergies.discordStatus ? 'Same text as Discord status in your profile.' : 'For example “2 services running · 3 players online”.'}>
          <Switch checked={c.presence !== false} onChange={(v) => save({ presence: v })} />
        </SettingRow>
      </div>
    </div>
  );
}

function Log({ s, onClear }) {
  return (
    <div className="card">
      <div className="card-head"><ListChecks size={16} /><h3>Recent actions</h3>
        {s.log.length > 0 && <div className="right"><Btn className="xs ghost" icon={Trash2} onClick={onClear}>Clear</Btn></div>}
      </div>
      {!s.log.length ? <TileEmpty icon={Activity} text="Nothing yet – everything done through Discord shows up here." /> : (
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Command</th><th>Result</th></tr></thead>
          <tbody>
            {s.log.map((e, n) => {
              const [label, kind] = RESULT[e.result] || RESULT.error;
              return (
                <tr key={`${e.t}-${n}`}>
                  <td className="small muted">{new Date(e.t).toLocaleString()}</td>
                  <td>{e.user}</td>
                  <td><code>{ACTION[e.action] || e.action}</code>{e.service ? <span className="small"> {e.service}</span> : null}</td>
                  <td><span className={`badge ${kind}`} title={e.result === 'error' ? e.detail : undefined}>{label}</span>{e.detail && WHY[e.detail] ? <span className="tiny muted"> {WHY[e.detail]}</span> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DiscordBotPage() {
  const st = useApi('/discord-bot', []);
  const s = st.data;
  const [token, setToken] = useState(false);
  useEffect(() => { const t = setInterval(() => st.reload({ silent: true }), 5000); return () => clearInterval(t); }, [st.reload]);
  if (!s) return st.error ? <Empty icon={Bot} title="Could not load" text={String(st.error.message || st.error)} /> : <Loading />;
  const save = async (patch) => { try { st.setData(await put('/discord-bot/settings', patch)); } catch (e) { toast.error(e); } };
  const removeToken = async () => {
    if (!(await confirmDialog({ title: 'Remove the bot token?', text: 'The bot goes offline. Settings and rights stay.', confirm: 'Remove', danger: true }))) return;
    try { st.setData(await put('/discord-bot/token', { token: '' })); } catch (e) { toast.error(e); }
  };
  const register = async () => { try { st.setData(await post('/discord-bot/commands')); toast.success('Commands registered'); } catch (e) { toast.error(e); } };
  const clearLog = async () => { if (await confirmDialog({ title: 'Clear the action log?', confirm: 'Clear', danger: true })) st.setData(await del('/discord-bot/log')); };
  return (
    <div className="page fade-in dbot">
      <div className="page-head">
        <div>
          <h1><Bot /> Discord control</h1>
          <p>Your own Discord bot: /status, /players, /start, /stop and /restart from your Discord server.</p>
        </div>
        <div className="actions">
          <StateBadge s={s} />
          <InfoTip title="Commands">/status – which services run · /players – who is online · /start, /stop, /restart &lt;service&gt; – with a confirm button for stop and restart. German Discord shows /spieler and /neustart.</InfoTip>
        </div>
      </div>
      {!s.hasToken ? <Setup onSaved={st.setData} /> : (
        <div className="card mb">
          <div className="card-head"><Bot size={16} /><h3>{s.bot ? s.bot.name : 'Your bot'}</h3><StateBadge s={s} />
            <div className="right"><Switch label="Bot on" checked={s.active} onChange={(v) => save({ active: v })} /></div>
          </div>
          <div className="card-body stack">
            {s.error && s.state !== 'ready' && <Callout kind="err" dismissible={false}>{s.error}</Callout>}
            {s.state === 'ready' && !s.guilds.length && <Callout kind="warn" dismissible={false}>The bot is not on any Discord server yet – invite it with the button below.</Callout>}
            {token ? <TokenForm onSaved={(d) => { st.setData(d); setToken(false); }} onCancel={() => setToken(false)} /> : (
              <div className="row-tight dbot-actions">
                {s.invite && <Btn className={s.guilds.length ? 'sm' : 'sm primary'} icon={UserPlus} onClick={() => openExternal(s.invite)}>Invite to a Discord server</Btn>}
                <Btn className="sm ghost" icon={RefreshCw} disabled={s.state !== 'ready'} onClick={register}>Register commands again</Btn>
                <Btn className="sm ghost" icon={KeyRound} onClick={() => setToken(true)}>Change token</Btn>
                <Btn className="sm ghost" icon={Trash2} onClick={removeToken}>Remove token</Btn>
                <Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal(PORTAL)}>Developer portal</Btn>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-2 dbot-grid">
        <Rights s={s} save={save} />
        <Services s={s} save={save} />
        <TeamLinks s={s} save={save} />
        <Extras s={s} save={save} />
      </div>
      <Log s={s} onClear={clearLog} />
    </div>
  );
}

/** Tile for the overview: connected? and what happened today. */
function DiscordBotTile() {
  const st = useApi('/discord-bot', []);
  const s = st.data;
  if (!s) return <div className="card-body"><span className="small muted">…</span></div>;
  if (!s.hasToken) return <TileEmpty icon={Bot} text="Discord bot not set up yet." href="#/ext/discord-bot" action="Set up" />;
  const today = new Date().toDateString();
  const n = s.log.filter((e) => new Date(e.t).toDateString() === today && e.action !== 'status' && e.action !== 'players').length;
  return (
    <div className="card-body stack dbot-tile">
      <div className="row-tight"><Bot size={16} /><b className="grow ellipsis">{s.bot ? s.bot.name : 'Discord bot'}</b><StateBadge s={s} /></div>
      <div className="small muted">{n === 1 ? '1 action today' : `${n} actions today`}</div>
    </div>
  );
}

export default {
  pages: { main: DiscordBotPage },
  slots: { 'dashboard.tiles': [{ id: 'state', title: 'Discord control', icon: 'bot', size: 'third', Component: DiscordBotTile }] },
};
