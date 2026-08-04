# gtasks-mcp — poznámky pro Claude

Fork MCP serveru pro Google Tasks. Ondřejův primární task manager (task list „Úkoly",
ID `MTM3NzY2NDEwOTk2NTY3NzMxODk6MDow`). Běží lokálně pod Claude Desktopem na Windows.

## Kde je server nakonfigurovaný (tohle jsem minule dlouho hledal)

Server **není** v `.claude.json`, ani v `.claude/settings.json`, ani přes `claude mcp add`
(`claude mcp list` nic nevrací). Je nadefinovaný v **Claude Desktop configu**:

```
C:\Users\ondra\AppData\Roaming\Claude\claude_desktop_config.json
```

```json
"mcpServers": {
  "gtasks": { "command": "bun", "args": ["run", "C:\\Users\\ondra\\repos\\gtasks-mcp\\src\\index.ts"] }
}
```

Spouští se tedy přímo z `src/index.ts` přes `bun run` (žádný build krok — `dist/` se nepoužívá).

### Logy serveru

```
C:\Users\ondra\AppData\Roaming\Claude\logs\mcp-server-gtasks.log
```

Tady je vidět JSON-RPC komunikace i chyby startu. Soubor bývá velký (stovky KB) — čti `tail`,
ne celý. Klíčové řádky: `Server started and connected successfully`, `Message from client/server`,
`Request timed out`.

## Chyba „Could not attach to MCP server gtasks" — co to znamená

V logu to vypadá takhle:

```
Server started and connected successfully
→ initialize (id:0)              klient pošle handshake
... 60 s ticho ...
← McpError -32001: Request timed out
```

Server naběhne, ale na úvodní `initialize` handshake **neodpoví do 60 s** → Claude to vzdá →
popup. Je to **cold-start race**, ne trvalá chyba (jiné dny server funguje normálně). Spouští se
to ráno při startu appky, kdy je disk studený (antivirus skenuje `node_modules`, bun se zahřívá).

## Co a proč jsem upravil (řešení timeoutu)

Hlavní žrout startu byl `import { google } from "googleapis"` — načítá **celé** Google API
(stovky API), což na studeném disku mohlo přesáhnout 60s limit. Změny:

- **`googleapis` → `@googleapis/tasks`** (úzký balík, jen Tasks API). V `index.ts` i `Tasks.ts`.
  - Klient se staví přes `createTasks({ version: "v1", auth })` místo globálního `google.options({ auth })`.
  - Modulová proměnná `let tasks: tasks_v1.Tasks` se přiřadí v `loadCredentialsAndRunServer()`
    ještě před `server.connect()`, takže je vždy ready, než doběhne první request.
- **`@google-cloud/local-auth`** se načítá **dynamicky** (`await import(...)`) až uvnitř
  `authenticateAndSaveCredentials()` — ten běží jen při ručním `bun run src/index.ts auth`,
  ne při normálním startu serveru.

Výsledek: `initialize` handshake za ~2 s místo potenciálních >60 s.

> Pozn.: grep na „googleapis" pořád najde shody v `src/` — to je jen substring importu
> `@googleapis/tasks`, ne stará závislost. Ta je z `package.json` odebraná.

## Server-side filtrování v `list` toolu

`list` posílá filtry přímo na Google Tasks API — netahej všechno a nefiltruj v klientovi
(Ondřej má 150+ tasků). Parametry (vše RFC 3339, `YYYY-MM-DD` i plné ISO 8601):
`dueMin`/`dueMax`, `completedMin`/`completedMax`, `updatedMin`, `showCompleted`/`showHidden`/
`showDeleted`, `taskListId` (jen jeden list), `excludeTaskListId` (vynech list, např. PPG).
V jednom volání se filtry **ANDují** → „due tento týden OR completed tento týden" jsou dvě
volání sloučená podle ID. Každý list se stránkuje do konce (`nextPageToken`). Výstup má na
řádku `List:` název listu (dřív se ztrácel při slévání). Implementace: `_list` v `Tasks.ts`,
schema v `index.ts`. Hranice normalizuje `toRFC3339` (na rozdíl od `normalizeDueDate`
zachová čas, ne jen datum).

## Jak otestovat změny

`bun run src/index.ts` mluví MCP protokolem po stdio. Rychlý smoke test (spawn + initialize +
tools/call) — pošli `initialize`, pak `notifications/initialized`, pak `tools/call list-tasklists`
a čekej odpověď. Když `list-tasklists` vrátí task listy, funguje auth i wiring. (Skript jsem
minule psal ad hoc do `/tmp` a po sobě mazal.)

Build (jen sanity check, runtime ho nepoužívá): `bun build ./src/index.ts --outdir ./dist --target bun`.

## Auth flow

- Credentials: `.gtasks-server-credentials.json` (OAuth tokeny, gitignored). Refresh tokeny se
  ukládají automaticky přes `auth.on("tokens", ...)`.
- OAuth klíče: `gcp-oauth.keys.json`.
- Re-auth při expiraci: `bun run src/index.ts auth` (otevře browser flow, uloží credentials).

## Po úpravě kódu

Změny se projeví až po restartu serveru: Claude Desktop → Settings → Connectors → gtasks
vypnout/zapnout, nebo restart appky. Pracovní strom commituje Ondřej sám po kontrole.
