/**
 * Host half of the DSH Web font fix.
 *
 * On every Harness boot it re-applies the three idempotent file patches to the
 * installed Web build, so a `dsh` upgrade (which replaces those built files)
 * heals on the next start instead of silently reverting. A failure is logged
 * and never takes the Harness down.
 *
 * @module dsh-font-fix
 */

import { applyFontFix, MARKERS } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-font-fix'

/** Summarize one report row for the log. */
function describe(row) {
  const details = row.details === undefined ? '' : ` ${JSON.stringify(row.details)}`
  const warnings = row.warnings === undefined || row.warnings.length === 0 ? '' : ` warnings=${JSON.stringify(row.warnings)}`
  return `${row.status} ${row.patch} -> ${row.target}${row.reason === undefined ? '' : ` (${row.reason})`}${details}${warnings}`
}

/**
 * Ask the Client module registry to re-read the patched theme bundle.
 *
 * `client-modules` snapshots every client artifact when the service is built,
 * so on a boot where the theme file was just rewritten the in-memory bundle is
 * still the pre-patch generation. `rebuilt()` is the registry's own publication
 * hook for exactly this case; a composition without the service (headless/TUI)
 * simply never runs the callback.
 *
 * @param ctx - Cordis context used to wait for the optional service.
 * @param logger - logger for the refresh result.
 */
function refreshThemeClientModule(ctx, logger) {
  try {
    ctx.inject(['clientModules'], (clientCtx) => {
      const registry = clientCtx.clientModules
      if (typeof registry?.rebuilt !== 'function') return
      try {
        const revision = registry.rebuilt('@deepseek-ai/dsh-client-ui-theme')
        logger.info(`dsh-font-fix: client module revision refreshed (${String(revision)})`)
      } catch (error) {
        logger.warn(`dsh-font-fix: could not refresh the client module revision: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    logger.warn(`dsh-font-fix: could not subscribe to clientModules: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Apply the font patches once the plugin is activated.
 * @param ctx - Cordis context used for logging.
 */
export function apply(ctx) {
  const logger = ctx.logger('dsh-font-fix')
  let targets
  try {
    targets = resolveTargets(process.env)
  } catch (error) {
    logger.warn(`could not resolve patch targets: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (targets.dshRoot === undefined) {
    logger.warn('could not locate the dsh installation; set DSH_FONT_FIX_DSH_ROOT to its package directory')
    return
  }

  let results
  try {
    results = applyFontFix(targets)
  } catch (error) {
    logger.warn(`font patches failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const row of results) {
    if (row.status === 'error') logger.warn(describe(row))
    else logger.info(describe(row))
  }
  if (results.some((row) => row.patch === MARKERS.theme && row.status === 'patched')) {
    refreshThemeClientModule(ctx, logger)
  }
  const patched = results.filter((row) => row.status === 'patched').length
  logger.info(`dsh-font-fix: installation ${targets.dshRoot}; ${patched} patch(es) applied, ${results.length - patched} already current or unavailable`)
}
