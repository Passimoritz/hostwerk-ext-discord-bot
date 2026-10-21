![Discord-Steuerung](banner.svg)

# Discord-Steuerung

Dein eigener Discord-Bot für Hostwerk: /status, /spieler, /start, /stop und /neustart direkt aus deinem Discord-Server. Wer Dienste steuern darf, legst du über Discord-Rollen oder dein Team fest – Stoppen und Neustarten bestätigt man per Knopf.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

## Was sie kann

- **Wo:** Livebetrieb → Betrieb → Discord (ein Reiter zusammen mit „Discord-Status“) und Übersichtskachel – seit 1.2.0 ohne eigenen Seitenleisten-Eintrag; die ganze Seite bleibt unter Erweiterungen → Öffnen
- Slash-Befehle /status, /spieler, /start, /stop und /neustart (englisch: /players, /restart)
- Rechte über Discord-Rollen oder verknüpfte Team-Mitglieder
- Stoppen und Neustarten erst nach Bestätigung per Knopf
- Auf Wunsch: Spieler-Meldungen in einem Kanal und ein Live-Status des Bots
- Spricht direkt mit Discord (Gateway + REST) – ohne Zusatz-Bibliothek, dein Token bleibt verschlüsselt auf diesem PC

## Bot einrichten

1. Das [Discord Developer Portal](https://discord.com/developers/applications) öffnen und **New Application** anklicken. Den Namen sehen später alle in Discord, zum Beispiel „Hostwerk“.
2. Unter **Bot** auf **Reset Token** klicken und den Token kopieren. Besondere (privilegierte) Intents braucht es nicht – der Bot nutzt nur `GUILDS`.
3. In Hostwerk **Discord-Steuerung** öffnen, den Token einfügen und speichern. Hostwerk legt ihn verschlüsselt ab und verbindet sich.
4. **Auf einen Discord-Server einladen** anklicken und deinen Server wählen. Die Einladung fragt nur nach *Kanäle ansehen*, *Nachrichten senden* und *Links einbetten* plus den Slash-Befehlen.
5. Die Rollen wählen, die starten, stoppen und neu starten dürfen. Fertig – in Discord `/status` eingeben.

## Befehle

| Befehl (englisch · deutsches Discord) | Wer | Was |
|---|---|---|
| `/status` | alle (oder die Lese-Rollen) | welche freigegebenen Dienste laufen, Spieler je Minecraft-Server |
| `/players` · `/spieler` | alle (oder die Lese-Rollen) | wer auf jedem laufenden Minecraft-Server online ist |
| `/start <service>` · `/start <dienst>` | Steuer-Rollen, Server-Admins, verknüpfte Team-Mitglieder | startet ihn (fragt vorher, wenn du das einschaltest) |
| `/stop <dienst>` | ebenso | fragt per Knopf nach, dann stoppt er |
| `/restart <service>` · `/neustart <dienst>` | ebenso | fragt per Knopf nach, dann startet er neu |

Das Dienst-Feld schlägt nur Dienste vor, die die Person steuern darf. Antworten sieht nur, wer gefragt hat – in der
Sprache seines Discords. Jede Aktion steht im Protokoll auf der Seite und in Hostwerks Aktivitätsprotokoll (*über Discord*).

## Rechte

- **Discord-Rollen** – auf der Seite auswählen (der Bot liest die Rollen deines Servers). Server-Admins dürfen immer, außer du schaltest das ab.
- **Team & Rollen** – beim Mitglied in Team die Discord-ID eintragen (Team 1.2) oder hier einen Discord-Nutzer mit einem Team-Mitglied verknüpfen: Er darf genau die Dienste steuern, die dieses Mitglied in Hostwerk starten und stoppen darf – Team prüft das mit denselben Regeln wie beim Fernzugriff.
- **Freigegebene Dienste** – alle oder nur ausgewählte. Nicht freigegebene gibt es für Discord nicht – auch nicht für Admins.
- **Nur dein Server** – auf Wunsch antwortet der Bot nur auf einem Discord-Server.
- Stoppen und Neustarten brauchen immer einen Bestätigungsknopf; der Knopf gilt nur für die fragende Person, nur einmal und zwei Minuten lang, und beim Drücken werden die Rechte noch einmal geprüft.

## Passt gut zu

- **Discord-Status** – der Bot zeigt denselben Text, den der Discord-Status in dein Profil schreibt.
- **Spieler-Ticker** – wer auf deine Minecraft-Server kommt oder geht, kann auch in einem Discord-Kanal erscheinen (alle paar Sekunden gebündelt).
- **Team & Rollen** – Rechte je Mitglied, siehe oben.

## Warum keine Discord-Bibliothek

Der Bot spricht das dokumentierte Discord-Gateway (WebSocket, API v10) und die REST-API selbst – mit Nodes eingebautem
`WebSocket` und `fetch` (zur Not mit dem `ws`-Paket, das Hostwerk ohnehin mitbringt). Die wenigen nötigen Pakete – HELLO,
IDENTIFY/RESUME, Heartbeat, DISPATCH, PRESENCE – passen in eine kleine Datei; discord.js brächte rund 40 Pakete und eine
Zwischenspeicher-Schicht mit, die der Bot nicht braucht. Neu verbinden, Fortsetzen, tote Verbindungen und Ratenlimits sind
eingebaut und mit nachgebildeten Discord-Ereignissen getestet.

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`<Hostwerk>/data/discord-bot/` – Einstellungen (Bot-Token mit Hostwerks Schlüssel verschlüsselt) und die letzten 200 Aktionen. Entfernen der Erweiterung löscht nichts.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
