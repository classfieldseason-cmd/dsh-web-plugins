/**
 * Locate the running DSH installation, its built frontend and every shipped
 * client module that may embed base64 images.
 *
 * @module dsh-web-perf/targets
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const FRONTEND_PACKAGE = '@deepseek-ai/dsh-web-frontend'
const CLIENT_PREFIX = 'dsh-client-'

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
 * @param options - `{ argv1, env }` injection points for tests.
 * @returns absolute DSH package root, or `undefined`.
 */
export function findDshRoot(options = {}) {
  const argv1 = options.argv1 ?? process.argv[1]
  const env = options.env ?? process.env
  const candidates = []

  if (typeof env.DSH_WEB_PERF_DSH_ROOT === 'string' && env.DSH_WEB_PERF_DSH_ROOT !== '') {
    candidates.push(env.DSH_WEB_PERF_DSH_ROOT)
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

/** The `@deepseek-ai` directory holding the installation's packages. */
function scopeDirectory(dshRoot) {
  const nested = join(dshRoot, 'node_modules', '@deepseek-ai')
  if (existsSync(nested)) return nested
  const sibling = dirname(dshRoot)
  if (basename(sibling) === '@deepseek-ai') return sibling
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
 * Available shipped client bundles: `{ id, directory }` for every
 * `dsh-client-<name>/lib/client.js`.
 */
export function listClientPackages(dshRoot) {
  const scope = scopeDirectory(dshRoot)
  if (scope === undefined) return []
  const packages = []
  let names
  try {
    names = readdirSync(scope)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name.startsWith(CLIENT_PREFIX)) continue
    const directory = join(scope, name)
    if (!existsSync(join(directory, 'lib', 'client.js'))) continue
    packages.push({ id: name, directory })
  }
  return packages
}

/**
 * Resolve the files this bundle optimizes.
 * @param env - environment used for root discovery.
 * @returns `{ dshRoot, frontendDistDir, clientPackages }`.
 */
export function resolveTargets(env = process.env) {
  const dshRoot = findDshRoot({ env })
  if (dshRoot === undefined) {
    return { dshRoot: undefined, frontendDistDir: undefined, clientPackages: [] }
  }
  const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
  const frontendDirectory = resolvePackageDirectory(requireFromDsh, dshRoot, FRONTEND_PACKAGE)
  return {
    dshRoot,
    frontendDistDir: frontendDirectory === undefined ? undefined : join(frontendDirectory, 'dist'),
    clientPackages: listClientPackages(dshRoot),
  }
}
