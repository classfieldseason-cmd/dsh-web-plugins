/**
 * Host half of the DSH weak-network bundle.
 *
 * Two independent layers:
 * 1. A page-level `__DSH_CONNECTION_RECOVERY__` override injected after the
 *    connection plugin's own row, so a slow handshake gets 60 s instead of 15 s
 *    and reconnect backoff starts gently. This applies on the next page load.
 * 2. Idempotent build patches for the Gateway heartbeat / WebSocket
 *    `permessage-deflate` and WebServer Brotli negotiation. These are read at
 *    module import time, so they take effect after the next Harness start.
 *
 * @module dsh-weaknet
 */

import { applyWeakNetPatches, RECOVERY } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-weaknet'

/** Format one patch report row. */
function describe(row) {
  const details = row.details === undefined ? '' : ` ${JSON.stringify(row.details)}`
  const warnings = row.warnings === undefined || row.warnings.length === 0 ? '' : ` warnings=${JSON.stringify(row.warnings)}`
  return `${row.status} ${row.patch} -> ${row.target}${row.reason === undefined ? '' : ` (${row.reason})`}${details}${warnings}`
}

/**
 * Apply the weak-network layers once the plugin is activated.
 * @param ctx - Cordis context used for logging and the optional web server.
 */
export function apply(ctx) {
  const logger = ctx.logger('dsh-weaknet')

  // Layer 1: override the recovery global on every index response. The
  // connection plugin pushed its row earlier, and rows render in registration
  // order, so this later `<script>` wins before the client boot reads it.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: RECOVERY })
      })
    })
    logger.info(`dsh-weaknet: recovery override armed ${JSON.stringify(RECOVERY)} (applies on page reload)`)
  } catch (error) {
    logger.warn(`dsh-weaknet: could not arm the recovery override: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Layer 2: build patches for the transport modules.
  let targets
  try {
    targets = resolveTargets(process.env)
  } catch (error) {
    logger.warn(`dsh-weaknet: could not resolve patch targets: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (targets.dshRoot === undefined) {
    logger.warn('dsh-weaknet: could not locate the dsh installation; set DSH_WEAKNET_DSH_ROOT to its package directory')
    return
  }

  let results
  try {
    results = applyWeakNetPatches(targets)
  } catch (error) {
    logger.warn(`dsh-weaknet: transport patches failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const row of results) {
    if (row.status === 'error') logger.warn(describe(row))
    else logger.info(describe(row))
  }
  const patched = results.filter((row) => row.status === 'patched').length
  if (patched > 0) {
    logger.info('dsh-weaknet: transport patches were written just now; restart dsh web once to activate them')
  } else {
    logger.info(`dsh-weaknet: installation ${targets.dshRoot}; transport patches already current`)
  }
}
