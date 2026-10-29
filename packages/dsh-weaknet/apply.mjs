#!/usr/bin/env node
/**
 * Manual entry point: apply the transport patches before starting `dsh web`.
 *
 * The installed bundle already runs this at every boot, but the WebServer and
 * Gateway read their modules at import time, so a patch written by a plugin
 * that loads after them only takes effect on the following start. Running this
 * script first (or after a `dsh` upgrade) makes one restart enough.
 */

import { applyWeakNetPatches } from './lib/patches.js'
import { resolveTargets } from './lib/targets.js'

const targets = resolveTargets(process.env)
if (targets.dshRoot === undefined) {
  console.error('dsh-weaknet: could not locate the dsh installation; set DSH_WEAKNET_DSH_ROOT')
  process.exitCode = 1
} else {
  const results = applyWeakNetPatches(targets)
  for (const row of results) {
    const suffix = row.reason === undefined ? '' : ` (${row.reason})`
    console.log(`${row.status.padEnd(7)} ${row.patch} -> ${row.target}${suffix}`)
    for (const warning of row.warnings ?? []) console.log(`        warning: ${warning}`)
  }
  if (results.some((row) => row.status === 'error')) process.exitCode = 1
}
