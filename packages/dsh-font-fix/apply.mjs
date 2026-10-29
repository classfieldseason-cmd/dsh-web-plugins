#!/usr/bin/env node
/**
 * Manual, idempotent entry point: `node apply.mjs`.
 *
 * The installed bundle already runs this at every Harness boot; the CLI exists
 * for verifying the patches or re-applying them after an upgrade without
 * restarting the process. It reads the same installation the running Node
 * executable resolves, or `DSH_FONT_FIX_DSH_ROOT` when set.
 */

import { applyFontFix } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

const targets = resolveTargets(process.env)
if (targets.dshRoot === undefined) {
  console.error('dsh-font-fix: could not locate the dsh installation; set DSH_FONT_FIX_DSH_ROOT')
  process.exitCode = 1
} else {
  const results = applyFontFix(targets)
  for (const row of results) {
    const suffix = row.reason === undefined ? '' : ` (${row.reason})`
    console.log(`${row.status.padEnd(7)} ${row.patch} -> ${row.target}${suffix}`)
    for (const warning of row.warnings ?? []) console.log(`        warning: ${warning}`)
  }
  if (results.some((row) => row.status === 'error')) process.exitCode = 1
}
