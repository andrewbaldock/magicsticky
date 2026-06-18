# Go-live runbook — magicsticky.andrewbaldock.com

Authored by CW for Claude-in-Chrome to execute the DNS step, and for Andrew/CC to drive the cutover.
DNS host = **A Small Orange (ASO)** → **cPanel → Zone Editor**. Zone = `andrewbaldock.com`.

---

## ⛔ GATE 0 — confirm the CNAME target BEFORE touching DNS

The CNAME points `magicsticky` → the Fly app's hostname. **You cannot add the record correctly until
that hostname is known and confirmed.** `fly.toml` declares `app = "magicsticky"`, but Fly only grants
that exact name if it was free at `fly launch` — otherwise it suffixes (e.g. `magicsticky-1234`).

**Do this first (CC / Andrew, in a terminal with Fly auth):**
```
fly apps list            # confirm the app exists and its exact name
fly status -a <name>     # confirm it's deployed/reachable
```
The CNAME **target is `<that-exact-name>.fly.dev.`** — write it down. If `fly launch` hasn't run yet,
STOP: there is nothing to point at. DNS is step 2, not step 1.

> Do NOT assume `magicsticky.fly.dev`. Verify it.

---

## STEP 1 — add the CNAME in ASO cPanel Zone Editor (Claude-in-Chrome executes)

Pre-flight: you should already be logged into the ASO cPanel for `andrewbaldock.com`.

1. In cPanel, find the **Domains** section → click **Zone Editor**.
2. On the `andrewbaldock.com` row, click **Manage** (opens that zone's records).
3. **Safety check — do not overwrite anything.** In the record filter/search, type `magicsticky`.
   - If a `magicsticky` record ALREADY exists → **STOP and report it.** Do not edit/delete it.
   - If nothing matches → continue. (Expected: it's free.)
4. Click **+ Add Record** (or **Add Record**, then choose type **CNAME** — some cPanel themes have a
   dedicated **Add CNAME Record** button; either is fine).
5. Fill it in EXACTLY:
   - **Name:** `magicsticky`  → cPanel should expand it to `magicsticky.andrewbaldock.com.`
     (If the field shows the full name after you tab out, confirm it reads `magicsticky.andrewbaldock.com.`
     and NOT `magicsticky.andrewbaldock.com.andrewbaldock.com.` — if it double-appended, just enter
     `magicsticky` without the domain.)
   - **TTL:** `300`
   - **Type:** `CNAME`
   - **Record / CNAME / Target:** `<exact-fly-name>.fly.dev.` (trailing dot is good practice)
6. Click **Save Record** / **Add Record**.
7. Confirm the new row appears: `magicsticky.andrewbaldock.com.  300  CNAME  <fly-name>.fly.dev.`

### 🚩 CRITICAL GUARDRAIL — keep it DNS-only, never proxied
This record must point **straight at Fly**. A long-lived MCP SSE session dies behind an edge proxy —
that's the whole reason we're not routing through Cloudflare/Vercel.
- Plain cPanel Zone Editor records are authoritative DNS with **no proxy toggle** — so in Zone Editor
  there's nothing to disable; just don't go looking for one.
- BUT ASO sometimes exposes a **cPanel "Cloudflare" plugin** (the apex's `www` is Cloudflare-proxied,
  so a Cloudflare integration may be present). **Do NOT open that plugin and enable the orange-cloud /
  proxy for `magicsticky`.** Leave it grey/DNS-only. If you see any "proxy / accelerate / CDN" toggle
  associated with this record, leave it OFF and flag it.

---

## STEP 2 — Fly TLS cert (CC / Andrew, terminal)

```
fly certs add magicsticky.andrewbaldock.com -a <name>
```
Fly may print an **`_acme-challenge.magicsticky` CNAME** to add for DNS-01 validation. If it does,
**repeat STEP 1** for that record too (Name: `_acme-challenge.magicsticky`, Type CNAME, Target = the
`...flydns.net.` value Fly prints, TTL 300, DNS-only). Then:
```
fly certs show magicsticky.andrewbaldock.com -a <name>   # wait for "Issued"
```

---

## STEP 3 — verify before go-live
```
dig +short magicsticky.andrewbaldock.com           # → <fly-name>.fly.dev. (then Fly IPs)
curl -sI https://magicsticky.andrewbaldock.com/     # → 200/redirect from Fly, valid TLS
```

---

## STEP 4 — cutover sequence (order matters — CW review of CC's plan)

CC's proposed order is right; two sequencing clarifications I want pinned down:

1. `fly launch` / deploy the app (gets the real `.fly.dev` name → feeds GATE 0).
2. Add CNAME (STEP 1) → `fly certs add` (+ `_acme-challenge` if asked) → verify dig + cert Issued.
3. **Google OAuth origins BEFORE any sign-in.** Andrew adds `https://magicsticky.andrewbaldock.com`
   to the OAuth client's **Authorized JavaScript origins** (GIS 400s without it). This must be live
   *before* even Andrew's own first sign-in, not at the very end.
4. **Account-creating sign-in, then migrate — in that order.** `scripts/migrate-store.ts` takes
   `--user <userId>` and `create()`s stickies for that user; it does **not** create the account. So:
   Andrew signs in once (this creates his account + seeds sticky-1), grab his `userId` from the
   account table, THEN run migrate **exactly once** with **PROD `MAGICSTICKY_KEYS` + `MAGICSTICKY_DB`**:
   ```
   MAGICSTICKY_KEYS=<prod> MAGICSTICKY_DB=<prod.db> bun run scripts/migrate-store.ts --user <id> [--shared <slug>]
   ```
   Caveats (from the 5b review): it's **not idempotent** (re-run = duplicate stickies), it **appends on
   top of** the seeded sticky-1, and a flattened blob >10k **throws mid-loop** (no per-sticky catch) →
   partial import. So: run it once, verify the count it prints, and if it half-fails do NOT blind-rerun.
   Consider a `--dry-run`/per-sticky try-catch before cutover if Andrew's store is non-trivial.
5. THEN open to the public.

> "Migrate BEFORE first public sign-in" is correct, but note it must come AFTER Andrew's *own*
> account-creating sign-in (step 4 above). The `--user` has to exist first.

---

## Quick reference for Claude-in-Chrome (the only DNS action it owns)
- Add ONE record in ASO cPanel → Zone Editor → andrewbaldock.com → Manage:
  `magicsticky` · CNAME · `<exact-fly-name>.fly.dev.` · TTL 300 · **DNS-only, never proxied**.
- Possibly a second later: `_acme-challenge.magicsticky` CNAME → `<...flydns.net.>` if Fly asks.
- Stop conditions: a pre-existing `magicsticky` record; any double-appended domain in the Name; any
  proxy/orange-cloud toggle (leave OFF and report). Don't run `fly` commands — those are CC/Andrew.
