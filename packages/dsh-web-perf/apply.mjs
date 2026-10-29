#!/usr/bin/env node
/**
 * Manual entry point: extract embedded client artwork before starting
 * `dsh web`. The immutable `/assets` route is registered by the running
 * plugin, so this script only rewrites the bundles and their image files.
 */

import { applyPerfPatches } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

const targets = resolveTargets(process.env)
if (targets.dshRoot === undefined) {
  console.error('dsh-web-perf: could not locate the dsh installation; set DSH_WEB_PERF_DSH_ROOT')
  process.exitCode = 1
} else {
  const report = applyPerfPatches(targets)
  for (const row of report.patched) {
    console.log(
      `patched ${row.id}: ${row.images} image(s), ${row.originalBytes} -> ${row.patchedBytes} bytes`,
    )
  }
  for (const row of report.errors) console.log(`error   ${row.id}: ${row.reason ?? row.status}`)
  console.log(`scanned ${report.scanned} client bundle(s)`)
  if (report.errors.length > 0) process.exitCode = 1
}
