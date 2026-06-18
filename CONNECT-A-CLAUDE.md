# Connect Magic Sticky to a Claude — setup steps

Magic Sticky is **not a skill** — it's an **MCP connector** (a tool server Claude calls).
You add it once per Claude. **Every** Claude can connect — they all share your one shared sticky.
There are two paths because the clients differ in how they authenticate.

---

## Desktop / phone / Cowork — OAuth (recommended)

The desktop/phone **Add custom connector** dialog only does OAuth (no static-header field), and the
server now speaks it. **No token to copy** — the flow mints one for you.

1. In the Claude app, open **Settings → Connectors → Add custom connector**.
2. **Name:** `Magic Sticky`. **Remote MCP server URL:** `https://magicsticky.andrewbaldock.com/mcp`
3. Leave the **Advanced** OAuth Client ID/Secret **blank** — the server supports Dynamic Client
   Registration, so it self-registers.
4. Click **Connect**. You'll be sent to a Magic Sticky page → **Sign in with Google** (if not
   already) → **Connect** on the consent screen.
5. The connector turns active. Done.

Under the hood: the server is its own OAuth 2.1 Authorization Server. On the first 401 it returns a
`WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`; the client discovers
the endpoints, registers (RFC 7591), runs the authorization-code flow with PKCE (S256), and exchanges
the code for a per-client connector token. Each Claude you connect gets its **own** token, all
resolving to your one account — so they genuinely share the one prompt.

---

## Claude Code (CLI) — static bearer token

Claude Code's `.mcp.json` supports an `Authorization` header, so it uses the simpler static-token
path (no OAuth round-trip needed).

### Generate your token (web app, once)
1. Open **https://magicsticky.andrewbaldock.com** → **Sign in with Google.**
2. Click **Connect a Claude** → **Generate token**.
3. Copy the **`msk_…`** token **immediately** — shown only once (stored only as a sha256 hash). Lost
   it? Just generate a new one.

Keep this token secret. Don't commit it or paste it into chat.

### Add it to Claude Code

Already scaffolded for you at **`~/Code/magicsticky/.mcp.json`** (gitignored).
Just paste your real token in place of the placeholder:

```json
{
  "mcpServers": {
    "magicsticky": {
      "type": "http",
      "url": "https://magicsticky.andrewbaldock.com/mcp",
      "headers": { "Authorization": "Bearer msk_REPLACE_WITH_YOUR_CONNECTOR_TOKEN" }
    }
  }
}
```

- Claude Code **auto-discovers `.mcp.json` in the project root**, so it works in this repo.
- To use it from another project (e.g. `~/Code/orion`), copy this `.mcp.json` into that
  repo root and paste the same token. (`.mcp.json` is gitignored in magicsticky; add it to
  `.gitignore` in any other repo before copying so you don't commit the token.)

---

## Quick check it's working
In a fresh session: ask the Claude to call `whoami`. If it returns your shared sticky's
text, you're connected. If it 401s, the token/header is wrong — regenerate and re-paste.
