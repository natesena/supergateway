# Fixing the stateless streamableHttp child-process leak (#108) — methodology log

A record of **every approach tried**, working and not, so the next attempt starts from
knowledge instead of zero. Context: `supercorp-ai/supergateway` 3.4.3, used to expose
`@modelcontextprotocol/server-filesystem` over streamable-http for the Kismet Obsidian
vaults (`company-obsidian-mcp`, `obsidian-mcp` on a UGREEN NAS), fronted by `mcp-front`
(OAuth proxy) and consumed by the **claude.ai MCP connector**.

## The bug (confirmed)

Upstream issue **#108**: in stateless `stdio→streamableHttp`, each `POST /mcp` spawns a
child; it is never reaped because:

- `transport.onclose` never fires for an open SSE response (`handleRequest` never resolves), and
- `child.kill()` only signals the `/bin/sh -c` wrapper, orphaning the real `node` server to PID 1.

On the NAS this accumulated **4,903 + 1,197 orphaned children (~41 GiB)**, exhausting 62 GiB
RAM + 37 GiB swap and taking every NAS app offline. Multiple identical upstream prod reports
(maxx3250 has the exact `obsidian-mcp` setup: 1,880 leaked children / 9.4 GiB).

## Containment (works — this is the current production state)

- **`docker restart`** of the two MCP containers reclaimed ~49 GiB immediately.
- **`mem_limit: 2g` + `memswap_limit: 2g`** applied live (`docker update`) AND persisted in both
  compose files. A future leak now OOM-kills only the container, never the host. **This is the
  decisive safety net** and is why the leak is no longer an emergency.
- Both containers run the **known-good** image (`:known-good-20260628`, also saved as a
  `docker save` tarball) — instant rollback target.

## Fix attempts

### 1. Reap-on-close: `detached:true` + process-group SIGTERM on `res.on('close')` ❌ REGRESSES

The upstream PR approach (#124/#137/#148): spawn detached so the sh wrapper + node form a
process group, and kill the whole group when the HTTP response closes (`res.on('close')` fires
even for SSE, unlike `transport.onclose`).

- **Offline (direct curl / direct MCP SDK client): worked**, no leak.
- **Prod (claude.ai → mcp-front): REGRESSED.** Gateway logs showed
  `Initialize response received → Cleaning up child (res close) → Child exited SIGTERM`, i.e. the
  child is killed **mid-handshake**; mcp-front's `POST` returns 400 → claude.ai shows `503`.
- **Root cause:** claude.ai's stateless flow is a multi-step handshake on one child; reaping on
  res-close kills it before the real request completes. The upstream PRs work because their
  clients (lightpanda, firecrawl, gsc) do single-step `tools/list`, not claude.ai's pattern.
- **Verdict:** the leak (child persisting) and a working session are _entangled_ for this client.
  Reap-on-close is a **dead end** for claude.ai. Proven by A/B rollback + gateway logs.

### 2. Stateful + `--sessionTimeout` ❌ REJECTED before building

- `--stateful --sessionTimeout` _does_ reap idle children (verified locally: 12 held → 0 after
  timeout). But:
  - **#141**: stateful _also_ orphans on close; only `sessionTimeout` reaps, and with a long
    timeout it still leaks to OOM. Needs a _short_ timeout.
  - **#123 / #126**: stateful has its own open bugs (wrong status for unknown session,
    session-conflict SIGTERMs the child).
  - **mcp-front strips `Mcp-Session-Id`** on SSE responses (`internal/server/streamable_proxy.go`
    copies back only `Content-Type`/`Cache-Control`/`Connection`), so stateful session reuse
    breaks through mcp-front. Would need a paired mcp-front patch.
- **Verdict:** too many moving parts + a cross-component dependency. Rejected.

### 3. External reaper sidecar (kill orphaned children periodically) ❌ BLOCKED

EvanSchalton's community workaround (a `docker:cli` sidecar that reaps children older than N).

- **Blocked by:** `docker exec` is **broken on the NAS** (`OCI runtime exec failed: fork/exec
/proc/self/exe: no such file or directory`, a runc issue) — the sidecar relies on it.
- **Also:** the `PPID==1` orphan signal **does not hold in-container** — children stay parented
  to supergateway (PID 1 in the container), so age/connection heuristics are needed instead, which
  risk killing in-use children. Tracked separately.

### 4. Single-shared-child multiplexer 🟡 ARCHITECTURALLY RIGHT, fails claude.ai interop

Replace per-request spawn with **one persistent child**; multiplex all HTTP requests onto it by
remapping each caller's JSON-RPC id to a unique internal id and routing replies back. No
per-request spawn → nothing to leak; no per-request kill → nothing to kill mid-handshake.
(Branch `fix/stateless-child-process-leak`; this is the current code in
`src/gateways/stdioToStatelessStreamableHttp.ts`.)

- **Offline: solid.** Functional (init / listTools=14 / callTool), **8 concurrent SDK clients
  OK**, **zero leak** (one child steady across 25+ calls).
- **Sub-bug found + fixed:** answering the child's startup `roots/list` with `{roots: []}` made
  mcp-server-filesystem _discard_ its argv `/vault` dir (`No valid root directories provided by
client`). Fix = **don't answer `roots/list`** (let it time out → server uses argv, matching the
  original).
- **Still fails prod:** through mcp-front/claude.ai the `POST` returns **400** consistently (two
  calls 5 min apart; plus `notifications/cancelled` = claude.ai timing out). The remaining
  incompatibility is in claude.ai's exact streamable-http handshake and **could not be reproduced
  offline** (see harness notes). Suspected: intercepting `initialize` via `transport.send`
  conflicts with the SDK `StreamableHTTPServerTransport`'s own initialize state machine — untested.
- **Verdict:** best approach; needs a faithful claude.ai-behavior harness to finish.

## Reproduction / harness attempts (the real blocker)

- **Local supergateway + `curl`** (held-open POST): does **not** reproduce — bare curl closes too
  cleanly to trigger the leak/regression; mcp-front holds connections differently.
- **Direct MCP SDK client** (`@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`, pinned to
  supergateway's bundled `1.18.2`): **works against everything** (original, reap-on-close fork,
  multiplexer). Good for functional + leak + concurrency testing, but **does not reproduce the
  mcp-front/claude.ai failure** — so it's not a regression gate.
- **mcp-front offline harness** (built the Go binary; `config.streamable-test.json` style config,
  `bearer` auth, pointed at a local fork supergateway): runs, but the SDK client **chokes on the
  `GET /sse` 503** (supergateway 405s GET; mcp-front returns 503) with a Zod error — _claude.ai
  tolerates this, the SDK client does not_. So the harness still isn't faithful to claude.ai.
- **GAP:** there is no offline client that behaves like the **claude.ai MCP connector** (its
  `GET /sse` stream + retry/cancel logic + exact POST sequence). Building one is the prerequisite
  for finishing the multiplexer without slow, half-blind prod cycles.

## Diagnostic techniques that worked

- **Prod A/B rollback testing**: deploy fork → call the real `mcp__claude_ai_Kismet_Obsidian` tool
  → roll back to `:known-good` → call again → compare. This is what _proved_ each regression
  (reap-on-close and multiplexer both pass direct tests but fail the real tool).
- **Layered log capture**: `mcp-front` logs (POST/GET status) + the supergateway container's own
  logs (`Cleaning up child`, `Shared child initialized`, `No valid root directories`,
  `notifications/cancelled`) pinpointed each mechanism.
- **Upstream issue/PR mining**: #108 (the leak), #141 (stateful also leaks), #124/#137/#148 (the
  reap PRs and why they're insufficient/regress), #123/#126 (stateful bugs), #98 (claude connector
  auth issues). Confirmed our diagnosis matches multiple production reports.

## Where to resume

1. **Build a faithful claude.ai-behavior harness** — a client (or a captured request trace replayed
   via raw HTTP) that opens the `GET /sse` stream, tolerates its 503, and issues claude.ai's exact
   POST sequence, run through a local mcp-front. Without this, every iteration is a slow prod cycle.
2. With that gate, finish the **multiplexer**: most likely fix is to stop intercepting `initialize`
   with a raw `transport.send` and instead let the SDK `Server`/transport handle the protocol
   (register request handlers), so claude.ai's handshake isn't short-circuited.
3. Fallback if multiplexer interop proves intractable: a **host-side reaper** (not `docker exec` —
   that's broken) keyed on a real idle/connection signal, paired with the existing `mem_limit`.

Status as of this writing: both containers on **known-good + `mem_limit`** (MCP working, leak
contained). The leak is a capped annoyance, not an outage risk.
