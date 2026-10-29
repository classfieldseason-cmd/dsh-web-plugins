/**
 * Idempotent transport patches for high-latency links.
 *
 * Two built Host modules are tuned in place, each with its own marker:
 * - `dsh-weaknet-gateway-patch`: WebSocket heartbeat 2 s -> 15 s and
 *   `permessage-deflate` on the Gateway mux socket.
 * - `dsh-weaknet-brotli-patch`: negotiate `br` ahead of `gzip` in the
 *   WebServer's compression wrapper.
 *
 * Both modules are ESM: a patch is syntax-checked with `node --check` on a
 * temporary `.mjs` sibling before it replaces the file. A marker means the
 * patch already ran; an upgrade that replaces the build drops the marker and
 * the next boot re-applies it.
 *
 * @module dsh-weaknet/patches
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

/** Markers written into each patched build file. */
export const MARKERS = Object.freeze({
  gateway: 'dsh-weaknet-gateway-patch',
  brotli: 'dsh-weaknet-brotli-patch',
})

/**
 * Connection recovery timings injected into the page as
 * `__DSH_CONNECTION_RECOVERY__` (it overrides the connection plugin's own row).
 *
 * The strict default gives up on a generation handshake after 15 s, which a
 * slow uplink can exceed; 60 s keeps retrying without changing the protocol.
 */
export const RECOVERY = Object.freeze({
  backoffBaseMs: 800,
  backoffFactor: 1.7,
  backoffMaxMs: 15000,
  generationReadyWarnMs: 20000,
  generationReadyTimeoutMs: 60000,
})

/** Ping interval for the Gateway's multiplexed WebSocket. */
export const HEARTBEAT_INTERVAL_MS = 15000

/** Add a leading marker comment without disturbing the trailing source map. */
function prependMarker(source, marker) {
  return `/* ${marker} */\n${source}`
}

/**
 * Patch `dsh-api-gateway/lib/index.js`.
 * @param source - current module text.
 * @returns transform result.
 */
export function patchGatewaySource(source) {
  if (source.includes(MARKERS.gateway)) {
    return { status: 'skipped', reason: `marker ${MARKERS.gateway} already present` }
  }

  let next = source
  const warnings = []

  const heartbeat = /const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = [0-9.e]+;/
  if (heartbeat.test(next)) {
    next = next.replace(
      heartbeat,
      `const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS};`,
    )
  } else {
    // A release that moved the constant keeps the default heartbeat; the
    // compression half below is still worth applying.
    warnings.push('DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS not found; heartbeat left unchanged')
  }

  const server = 'new WebSocketServer({ noServer: true })'
  if (!next.includes(server)) {
    return {
      status: 'error',
      reason: 'WebSocketServer construction not found; cannot enable permessage-deflate',
    }
  }
  next = next.replace(
    server,
    'new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } } })',
  )
  next = prependMarker(next, MARKERS.gateway)

  return {
    status: 'patched',
    content: next,
    warnings,
    details: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, perMessageDeflate: true },
  }
}

/**
 * Patch `dsh-host-webserver/lib/index.js` to negotiate Brotli.
 *
 * Node's `compression` middleware already prefers `br` when the client offers
 * it; the wrapper here rewrites `accept-encoding` to `gzip|identity` first, so
 * Brotli never reaches the middleware. Offering `br` changes only the
 * negotiation order — clients without Brotli still get gzip.
 *
 * @param source - current module text.
 * @returns transform result.
 */
export function patchWebserverSource(source) {
  if (source.includes(MARKERS.brotli)) {
    return { status: 'skipped', reason: `marker ${MARKERS.brotli} already present` }
  }

  const negotiation = 'new Negotiator(req).encoding(["gzip", "identity"])'
  if (!source.includes(negotiation)) {
    return { status: 'error', reason: 'accept-encoding negotiation site not found' }
  }
  const header = '"accept-encoding": encoding === "gzip" ? "gzip" : "identity"'
  if (!source.includes(header)) {
    return { status: 'error', reason: 'accept-encoding rewrite site not found' }
  }

  let next = source.replace(negotiation, 'new Negotiator(req).encoding(["br", "gzip", "identity"])')
  next = next.replace(header, '"accept-encoding": encoding === "gzip" || encoding === "br" ? encoding : "identity"')

  const warnings = []
  const upgrade = 'this.server.on("upgrade", (req, socket, head) => {'
  if (next.includes(upgrade)) {
    next = next.replace(
      upgrade,
      'this.server.keepAliveTimeout = 30000;\n\t\t\tthis.server.headersTimeout = 35000;\n\t\t\t' + upgrade,
    )
  } else {
    warnings.push('server upgrade handler not found; keep-alive timeout left unchanged')
  }
  next = prependMarker(next, MARKERS.brotli)

  return {
    status: 'patched',
    content: next,
    warnings,
    details: { encodings: ['br', 'gzip', 'identity'], keepAliveTimeoutMs: 30000 },
  }
}

/** Validate ESM text with `node --check` on a same-directory `.mjs` sibling. */
function checkEsmSyntax(target, content) {
  const temporary = `${target}.dsh-weaknet-check-${process.pid}.mjs`
  try {
    writeFileSync(temporary, content)
    const result = spawnSync(process.execPath, ['--check', temporary], { encoding: 'utf8' })
    if (result.error !== undefined) return { ok: true, skipped: true }
    if (result.status === 0) return { ok: true }
    return {
      ok: false,
      message: (result.stderr || 'node --check failed').trim().split('\n').slice(0, 3).join(' '),
    }
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* best effort cleanup */
    }
  }
}

/** Write through a sibling temp file, preserving the original mode. */
function writeAtomically(filePath, content) {
  const mode = statSync(filePath).mode & 0o777
  const temporary = `${filePath}.dsh-weaknet-${process.pid}.tmp`
  try {
    writeFileSync(temporary, content, { mode })
    renameSync(temporary, filePath)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* best effort cleanup */
    }
    throw error
  }
}

/** Apply one pure transform to one file. */
export function patchFile(filePath, patchName, transform) {
  if (filePath === undefined || !existsSync(filePath)) {
    return { patch: patchName, target: filePath ?? '(unresolved)', status: 'error', reason: 'file not found' }
  }
  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { patch: patchName, target: filePath, status: 'error', reason: `read failed: ${error.message}` }
  }
  const result = transform(source)
  if (result.status !== 'patched') {
    return {
      patch: patchName,
      target: filePath,
      status: result.status,
      reason: result.reason,
      warnings: result.warnings,
    }
  }
  const syntax = checkEsmSyntax(filePath, result.content)
  if (!syntax.ok) {
    return { patch: patchName, target: filePath, status: 'error', reason: `patched module does not parse: ${syntax.message}` }
  }
  try {
    writeAtomically(filePath, result.content)
  } catch (error) {
    return { patch: patchName, target: filePath, status: 'error', reason: `write failed: ${error.message}` }
  }
  return {
    patch: patchName,
    target: filePath,
    status: 'patched',
    details: result.details,
    warnings: result.warnings,
  }
}

/**
 * Apply both transport patches.
 * @param targets - `{ gatewayPath, webserverPath }`, each optional.
 * @returns one report row per target.
 */
export function applyWeakNetPatches(targets) {
  return [
    patchFile(targets.gatewayPath, MARKERS.gateway, patchGatewaySource),
    patchFile(targets.webserverPath, MARKERS.brotli, patchWebserverSource),
  ]
}
