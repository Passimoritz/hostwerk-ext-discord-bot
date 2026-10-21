![Discord control](banner.svg)

# Discord control

Your own Discord bot for Hostwerk: /status, /players, /start, /stop and /restart right from your Discord server. You decide who may control services through Discord roles or your team – stop and restart are confirmed with a button.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

## What it does

- Slash commands /status, /players, /start, /stop and /restart (German: /spieler, /neustart)
- Rights through Discord roles or linked team members
- Stop and restart only after a confirm button
- Optional: player join/leave messages in a channel and a live bot status
- Talks to Discord directly (Gateway + REST) – no extra library, your token stays encrypted on this PC

## Set up the bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and click **New Application**. The name is what people see in Discord, for example “Hostwerk”.
2. Under **Bot** click **Reset Token** and copy the token. No privileged intents are needed (the bot only uses `GUILDS`).
3. In Hostwerk open **Discord control**, paste the token and save. Hostwerk stores it encrypted and connects.
4. Click **Invite to a Discord server** and pick your server. The invite asks for *View channels*, *Send messages* and *Embed links* plus the slash commands – nothing else.
5. Choose the roles that may start, stop and restart. Done – type `/status` in Discord.

## Commands

| Command (English · German Discord) | Who | What |
|---|---|---|
| `/status` | everyone (or the read roles) | which shared services run, players per Minecraft server |
| `/players` · `/spieler` | everyone (or the read roles) | who is online on each running Minecraft server |
| `/start <service>` · `/start <dienst>` | control roles, server admins, linked team members | starts it (asks first if you switch that on) |
| `/stop <service>` | same | asks with a button, then stops |
| `/restart <service>` · `/neustart <dienst>` | same | asks with a button, then restarts |

The service field suggests only services the person may control. Answers are only visible to the person who asked,
in the language of their Discord. Every action lands in the log on the page and in Hostwerk's activity log (*via Discord*).

## Rights

- **Discord roles** – chosen on the page (the bot reads the roles of your server). Server admins may always, unless you switch that off.
- **Team & roles** – link a Discord user to a team member: they may control exactly the services that member may start and stop in Hostwerk.
- **Shared services** – all, or only chosen ones. Services that are not shared do not exist for Discord – not even for admins.
- **Only your server** – optionally the bot answers on one Discord server only.
- Stop and restart always need a confirm button; the button works only for the person who asked, once, for two minutes, and the rights are checked again when it is pressed.

## Works well with

- **Discord status** – the bot shows the same text that Discord status puts in your profile.
- **Player ticker** – who joins or leaves your Minecraft servers can also be posted into a Discord channel (bundled every few seconds).
- **Team & roles** – rights per member, see above.

## Why no Discord library

The bot speaks the documented Discord Gateway (WebSocket, API v10) and REST API itself, with Node's built-in `WebSocket`
and `fetch` (falling back to the `ws` package Hostwerk ships). The few packets it needs – HELLO, IDENTIFY/RESUME,
heartbeat, DISPATCH, PRESENCE – fit into one small file; discord.js would add about 40 packages and a cache layer the bot
does not use. Reconnects, resuming, zombie connections and rate limits are handled and tested with imitated Discord events.

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`<Hostwerk>/data/discord-bot/` – settings (bot token encrypted with Hostwerk's key) and the last 200 actions. Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
