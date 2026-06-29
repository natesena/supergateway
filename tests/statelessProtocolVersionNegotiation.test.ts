import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'

/**
 * Regression test for the claude.ai / mcp-front "Unsupported protocol version"
 * 400 in the shared-child multiplexer (stateless streamableHttp).
 *
 * The multiplexer used to answer `initialize` by echoing the client's requested
 * protocolVersion verbatim. A client newer than the gateway's bundled SDK (e.g.
 * claude.ai) requests a version the SDK doesn't support; per the MCP spec the
 * client then stamps that version into its `Mcp-Protocol-Version` header on every
 * subsequent POST, and the SDK's StreamableHTTPServerTransport rejects it with
 * HTTP 400. The fix clamps the negotiated version exactly like the SDK Server.
 *
 * This MUST use raw fetch, not the SDK Client: the SDK Client is pinned to the
 * same SDK as the gateway, so it can only ever request a *supported* version —
 * which is precisely why this bug never reproduced through the SDK harness.
 */

const PORT = 11007
const MCP_URL = `http://localhost:${PORT}/mcp`
const ACCEPT = 'application/json, text/event-stream'

let gatewayProc: ChildProcess

test.before(async () => {
  gatewayProc = spawn(
    'npm',
    [
      'run',
      'start',
      '--',
      '--stdio',
      'node tests/helpers/mock-mcp-server.js stdio',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(PORT),
      '--streamableHttpPath',
      '/mcp',
    ],
    { stdio: 'ignore', shell: false },
  )
  gatewayProc.unref()
  // Give the gateway time to boot + initialize its shared child.
  await new Promise((r) => setTimeout(r, 2500))
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((resolve) => gatewayProc.once('exit', resolve))
})

// Pull a single JSON-RPC payload out of an SSE or plain-JSON response body.
function extractRpc(body: string): any {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {
        /* keep scanning */
      }
    }
  }
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

async function post(body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.text() }
}

// Mimic a real client: initialize asking for `requestedVersion`, then send a
// follow-up request stamped with whatever version the server negotiated.
async function initializeThenList(requestedVersion: string) {
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: requestedVersion,
      capabilities: {},
      clientInfo: { name: 'raw-harness', version: '1.0.0' },
    },
  })
  const negotiated = extractRpc(init.body)?.result?.protocolVersion as
    | string
    | undefined

  const list = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { 'Mcp-Protocol-Version': negotiated ?? requestedVersion },
  )
  return { initStatus: init.status, negotiated, listStatus: list.status }
}

test('newer-than-SDK protocol version negotiates down and tools/list still 200s', async () => {
  // A version far in the future — exactly the claude.ai failure mode.
  const r = await initializeThenList('2999-01-01')
  assert.strictEqual(r.initStatus, 200)
  // The server MUST NOT echo the unsupported version back...
  assert.notStrictEqual(
    r.negotiated,
    '2999-01-01',
    'gateway echoed an unsupported protocol version instead of clamping it',
  )
  // ...and the follow-up request stamped with the negotiated version must work.
  assert.strictEqual(
    r.listStatus,
    200,
    `tools/list rejected the negotiated version ${r.negotiated} (regression: claude.ai 400)`,
  )
})

test('a supported protocol version is honored as-is', async () => {
  const r = await initializeThenList('2025-03-26')
  assert.strictEqual(r.initStatus, 200)
  assert.strictEqual(r.negotiated, '2025-03-26')
  assert.strictEqual(r.listStatus, 200)
})
