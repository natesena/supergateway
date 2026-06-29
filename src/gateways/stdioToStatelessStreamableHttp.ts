import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  JSONRPCMessage,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  protocolVersion: string
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

// Helper function to create initialize request
const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {
      roots: {
        listChanged: true,
      },
      sampling: {},
    },
    clientInfo: {
      name: 'supergateway',
      version: getVersion(),
    },
  },
})

// Helper function to create initialized notification
const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

/**
 * Stateless stdio→StreamableHttp gateway, implemented as a SHARED-CHILD MULTIPLEXER.
 *
 * The upstream implementation spawned one stdio child PER HTTP request. That leaks
 * (supercorp-ai/supergateway#108: transport.onclose never fires for open SSE responses,
 * and child.kill only signals the /bin/sh wrapper), and the obvious "reap on res close"
 * patch breaks streaming clients (e.g. claude.ai via mcp-front) by killing the child
 * mid-handshake.
 *
 * This version runs ONE long-lived child for the whole process. Every HTTP request is
 * multiplexed onto that child by remapping the caller's JSON-RPC id to a globally-unique
 * internal id, then routing the child's response back to the originating HTTP response.
 * Consequences:
 *   - nothing is spawned per request  → nothing to leak
 *   - nothing is killed per request    → nothing to kill mid-handshake
 * Safe because the wrapped server (e.g. mcp-server-filesystem) is stateless per call.
 */
export async function stdioToStatelessStreamableHttp(
  args: StdioToStreamableHttpArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    protocolVersion,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)
  logger.info(`  - protocolVersion: ${protocolVersion}`)
  logger.info(
    `  - mode: shared-child multiplexer (one persistent stdio child; no per-request spawn)`,
  )
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({ res, headers })
      res.send('ok')
    })
  }

  // ── The single shared stdio child ───────────────────────────────────────────
  let child: ChildProcessWithoutNullStreams
  let nextInternalId = 1
  // internalId → deliver the child's reply to the right HTTP request
  const inflight = new Map<number, (msg: JSONRPCMessage) => void>()
  let cachedInitResult: Record<string, unknown> | null = null
  let resolveReady: () => void = () => {}
  let childReady = new Promise<void>((r) => (resolveReady = r))

  const dispatchChildMessage = (msg: any) => {
    // Reply to something we forwarded (a client request, or our own startup initialize).
    if (msg && msg.id != null && inflight.has(msg.id)) {
      const deliver = inflight.get(msg.id)!
      inflight.delete(msg.id)
      deliver(msg)
      return
    }
    // Server→client request (the child asking US something — e.g. roots/list during
    // initialize). We deliberately DO NOT answer it: answering roots/list with an empty
    // list makes mcp-server-filesystem discard its argv directory ("No valid root
    // directories provided by client"). Leaving it unanswered makes the server fall back
    // to its argv directory — exactly what the original gateway did (there this request
    // merely timed out). So drop server→client requests; the child serves from argv.
    if (msg && typeof msg.method === 'string') {
      logger.info(`Ignoring server→client request/notification: ${msg.method}`)
      return
    }
    logger.info(`Unrouted child message: ${JSON.stringify(msg)}`)
  }

  const initChild = () => {
    const initId = nextInternalId++
    inflight.set(initId, (resp: any) => {
      cachedInitResult = (resp && resp.result) || null
      child.stdin.write(JSON.stringify(createInitializedNotification()) + '\n')
      logger.info('Shared child initialized')
      resolveReady()
    })
    child.stdin.write(
      JSON.stringify(createInitializeRequest(initId, protocolVersion)) + '\n',
    )
  }

  const spawnChild = () => {
    child = spawn(stdioCmd, { shell: true })

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          dispatchChildMessage(JSON.parse(line))
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(`Child stderr: ${chunk.toString('utf8')}`)
    })

    child.on('exit', (code, signal) => {
      logger.error(
        `Shared child exited: code=${code}, signal=${signal} — failing inflight and respawning`,
      )
      // Don't hang the in-flight HTTP responses.
      for (const deliver of inflight.values()) {
        try {
          deliver({
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32000, message: 'stdio child exited' },
          } as any)
        } catch {}
      }
      inflight.clear()
      cachedInitResult = null
      childReady = new Promise<void>((r) => (resolveReady = r))
      setTimeout(() => {
        spawnChild()
        initChild()
      }, 250).unref()
    })
  }

  spawnChild()
  initChild()

  app.post(streamableHttpPath, async (req, res) => {
    try {
      await childReady

      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      await server.connect(transport)

      // ids this request put on the shared child, so a disconnect can't deliver to a
      // dead transport (and we never leak map entries).
      const myIds = new Set<number>()
      let closed = false
      const dropMyIds = () => {
        closed = true
        for (const id of myIds) inflight.delete(id)
        myIds.clear()
      }

      transport.onmessage = (msg: JSONRPCMessage) => {
        const anyMsg = msg as any

        // Each client initializes; the shared child is already initialized, so answer
        // from cache (echoing the client's requested protocol version) instead of
        // re-initializing — which would reset the shared child.
        if (isInitializeRequest(msg)) {
          // Negotiate the protocol version EXACTLY like the SDK Server does
          // (server/index.js _oninitialize): honor the client's requested
          // version only if we support it, otherwise fall back to the latest
          // version our bundled SDK knows.
          //
          // Why this matters: blindly echoing the client's requested version
          // breaks newer clients. claude.ai requests a protocol version newer
          // than this SDK supports; per spec the client then sends THAT version
          // in the `Mcp-Protocol-Version` header on every subsequent POST, and
          // the SDK's StreamableHTTPServerTransport.validateProtocolVersion
          // rejects it with HTTP 400 ("Unsupported protocol version"). The
          // original per-request gateway never hit this because it let the SDK
          // Server negotiate (and clamp) the version. The offline SDK test
          // client never hit it either, because it is pinned to this same SDK
          // and so requests a supported version. Clamping here restores parity.
          const requestedVersion = anyMsg.params?.protocolVersion
          const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
            requestedVersion,
          )
            ? requestedVersion
            : ((cachedInitResult as any)?.protocolVersion ??
              LATEST_PROTOCOL_VERSION)
          const result = {
            ...(cachedInitResult || {}),
            protocolVersion: negotiatedVersion,
          }
          try {
            transport.send({ jsonrpc: '2.0', id: anyMsg.id, result } as any)
          } catch (e) {
            logger.error('Failed to answer initialize', e)
          }
          return
        }

        // Notifications (no id), e.g. notifications/initialized — child already
        // initialized; nothing to forward.
        if (anyMsg.id === undefined || anyMsg.id === null) return

        // Request: remap id → forward to shared child → route reply back here.
        const internalId = nextInternalId++
        myIds.add(internalId)
        inflight.set(internalId, (childMsg: any) => {
          myIds.delete(internalId)
          if (closed) return
          try {
            transport.send({ ...childMsg, id: anyMsg.id })
          } catch (e) {
            logger.error('Failed to send to StreamableHttp', e)
          }
        })
        child.stdin.write(JSON.stringify({ ...anyMsg, id: internalId }) + '\n')
      }

      transport.onclose = () => dropMyIds()
      transport.onerror = (err) => {
        logger.error('StreamableHttp error:', err)
        dropMyIds()
      }
      res.on('close', dropMyIds)

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        })
      }
    }
  })

  app.get(streamableHttpPath, async (_req, res) => {
    logger.info('Received GET MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.delete(streamableHttpPath, async (_req, res) => {
    logger.info('Received DELETE MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
