/**
 * Locate the running DSH installation and the two built Host modules this
 * bundle tunes. Discovery is read-only; a wrong guess returns `undefined` and
 * the caller logs a diagnostic instead of editing an unrelated file.
 *
 * @module dsh-weaknet/targets
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const GATEWAY_PACKAGE = '@deepseek-ai/dsh-api-gateway'
const WEBSERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'

function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** True when `directory` is the root of the `@deepseek-ai/dsh` CLI package. */
export function isDshRoot(directory) {
  return readManifest(directory)?.name === DSH_PACKAGE
}

function walkToDshRoot(start) {
  let directory = start
  for (;;) {
    if (isDshRoot(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Find the DSH installation root.
 *
 * Order: explicit `DSH_WEAKNET_DSH_ROOT`, the launched CLI entry, then the
 * conventional global npm layout next to the running Node executable.
 */
export function findDshRoot(options = {}) {
  const argv1 = options.argv1 ?? process.argv[1]
  const env = options.env ?? process.env
  const candidates = []

  if (typeof env.DSH_WEAKNET_DSH_ROOT === 'string' && env.DSH_WEAKNET_DSH_ROOT !== '') {
    candidates.push(env.DSH_WEAKNET_DSH_ROOT)
  }
  if (typeof argv1 === 'string' && argv1 !== '') {
    const entry = realpathOrUndefined(argv1)
    if (entry !== undefined) candidates.push(dirname(entry))
  }
  const execDirectory = dirname(process.execPath)
  candidates.push(resolve(execDirectory, '..', 'lib', 'node_modules', ...DSH_PACKAGE.split('/')))
  candidates.push(resolve(execDirectory, '..', 'node_modules', ...DSH_PACKAGE.split('/')))

  for (const candidate of candidates) {
    const start = resolve(candidate)
    if (!existsSync(start)) continue
    const root = walkToDshRoot(start)
    if (root !== undefined) return root
  }
  return undefined
}

function resolvePackageDirectory(requireFromDsh, dshRoot, specifier) {
  try {
    return dirname(requireFromDsh.resolve(`${specifier}/package.json`))
  } catch {
    /* fall through to the package's own node_modules layout */
  }
  const direct = join(dshRoot, 'node_modules', ...specifier.split('/'))
  if (existsSync(join(direct, 'package.json'))) return direct
  return undefined
}

/**
 * Resolve the files this bundle patches.
 * @param env - environment used for root discovery.
 * @returns `{ dshRoot, gatewayPath, webserverPath }`, each optional.
 */
export function resolveTargets(env = process.env) {
  const dshRoot = findDshRoot({ env })
  if (dshRoot === undefined) {
    return { dshRoot: undefined, gatewayPath: undefined, webserverPath: undefined }
  }
  const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
  const gatewayDirectory = resolvePackageDirectory(requireFromDsh, dshRoot, GATEWAY_PACKAGE)
  const webserverDirectory = resolvePackageDirectory(requireFromDsh, dshRoot, WEBSERVER_PACKAGE)
  return {
    dshRoot,
    gatewayPath: gatewayDirectory === undefined ? undefined : join(gatewayDirectory, 'lib', 'index.js'),
    webserverPath: webserverDirectory === undefined ? undefined : join(webserverDirectory, 'lib', 'index.js'),
  }
}
