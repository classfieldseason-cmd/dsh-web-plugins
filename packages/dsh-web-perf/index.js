/**
 * Host half of the DSH Web performance bundle.
 *
 * Two layers, both effective on a page reload:
 * 1. A `/assets` prefix route serves the build's content-hashed files with a
 *    one-year immutable cache policy and a complete MIME table (the shipped
 *    fallback sends no cache policy and no image/font types).
 * 2. Embedded base64 artwork is extracted out of the client bundles into that
 *    same hashed tree, shrinking the boot payload (settings-account is ~3.4 MB
 *    of JavaScript for ~2.4 MB of inline WebP artwork) and deferring the
 *    image decode until the screen that uses it is opened.
 *
 * @module dsh-web-perf
 */

import { createAssetHandler } from './lib/asset-route.js'
import { applyPerfPatches } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-web-perf'

const kilobyte = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`

/**
 * Apply the performance layers once the plugin is activated.
 * @param ctx - Cordis context used for logging, the web server and the client graph.
 */
export function apply(ctx) {
  const logger = ctx.logger('dsh-web-perf')
  let targets
  try {
    targets = resolveTargets(process.env)
  } catch (error) {
    logger.warn(`dsh-web-perf: could not resolve targets: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (targets.dshRoot === undefined) {
    logger.warn('dsh-web-perf: could not locate the dsh installation; set DSH_WEB_PERF_DSH_ROOT to its package directory')
    return
  }

  // Layer 1: immutable caching for the hashed asset tree. Registering a new
  // prefix route is live immediately; no plugin reload or restart is needed.
  if (targets.frontendDistDir !== undefined) {
    ctx.inject(['webServer'], (webCtx) => {
      const handler = createAssetHandler({ distDir: targets.frontendDistDir })
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: '/assets', handler }),
        'dsh-web-perf: immutable asset route',
      )
      logger.info('dsh-web-perf: /assets is served with a one-year immutable cache policy')
    })
  } else {
    logger.warn('dsh-web-perf: frontend dist not resolved; the immutable asset route is skipped')
  }

  // Layer 2: pull inline artwork out of the built client bundles.
  let report
  try {
    report = applyPerfPatches(targets)
  } catch (error) {
    logger.warn(`dsh-web-perf: image extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const row of report.patched) {
    const warnings = row.unsupported.length === 0 ? '' : ` (left inline: ${row.unsupported.join(', ')})`
    logger.info(
      `dsh-web-perf: ${row.id}: ${row.images} image(s) extracted, ${kilobyte(row.originalBytes)} -> ${kilobyte(row.patchedBytes)}${warnings}`,
    )
  }
  for (const row of report.errors) {
    logger.warn(`dsh-web-perf: ${row.id}: ${row.status}${row.reason === undefined ? '' : ` (${row.reason})`}`)
  }
  logger.info(`dsh-web-perf: scanned ${report.scanned} client bundle(s); ${report.patched.length} optimized, ${report.errors.length} failed`)

  // Publish the rewritten bundles to the live module graph so one page reload
  // fetches the small generation instead of the cached pre-patch bytes.
  if (report.patched.length > 0) {
    try {
      ctx.inject(['clientModules'], (clientCtx) => {
        for (const row of report.patched) {
          try {
            const revision = clientCtx.clientModules.rebuilt(row.id)
            logger.info(`dsh-web-perf: ${row.id} revision refreshed (${String(revision)})`)
          } catch (error) {
            logger.warn(`dsh-web-perf: could not refresh ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })
    } catch (error) {
      logger.warn(`dsh-web-perf: could not subscribe to clientModules: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
