/**
 * Locate the running DSH installation and the built Web artifacts this bundle
 * patches. Discovery is deliberately read-only and tolerant: a wrong guess
 * returns `undefined` so the caller reports a diagnostic instead of writing to
 * an unrelated file.
 *
 * @module dsh-font-fix/targets
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const FRONTEND_PACKAGE = '@deepseek-ai/dsh-web-frontend'
const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'

/** Read a package manifest, returning `undefined` for a missing/broken file. */
function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolve a path through a fallible filesystem call. */
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

/**
 * Walk up from a starting path until the DSH CLI package root is found.
 * @param start - file or directory inside the installation.
 * @returns the package root, or `undefined`.
 */
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
 * Order: explicit `DSH_FONT_FIX_DSH_ROOT`, the launched CLI entry, then the
 * conventional global npm layout next to the running Node executable.
 *
 * @param options - `{ argv1, env }` injection points for tests.
 * @returns absolute DSH package root, or `undefined`.
 */
export function findDshRoot(options = {}) {
  const argv1 = options.argv1 ?? process.argv[1]
  const env = options.env ?? process.env
  const candidates = []

  if (typeof env.DSH_FONT_FIX_DSH_ROOT === 'string' && env.DSH_FONT_FIX_DSH_ROOT !== '') {
    candidates.push(env.DSH_FONT_FIX_DSH_ROOT)
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

/**
 * Resolve one dependency's package directory from the DSH installation.
 * @param requireFromDsh - `createRequire` anchored on the DSH manifest.
 * @param dshRoot - DSH package root, used for the direct-layout fallback.
 * @param specifier - package name.
 * @returns absolute package directory, or `undefined`.
 */
function resolvePackageDirectory(requireFromDsh, dshRoot, specifier) {
  try {
    return dirname(requireFromDsh.resolve(`${specifier}/package.json`))
  } catch {
    /* fall back to the package's own node_modules layout */
  }
  const direct = join(dshRoot, 'node_modules', ...specifier.split('/'))
  if (existsSync(join(direct, 'package.json'))) return direct
  return undefined
}

/**
 * Resolve the three patch targets for an installation.
 *
 * @param env - environment used for root discovery.
 * @returns `{ dshRoot, themeClientPath, frontendDistDir, indexHtmlPath }`; each
 * target is `undefined` when its package cannot be located.
 */
export function resolveTargets(env = process.env) {
  const dshRoot = findDshRoot({ env })
  if (dshRoot === undefined) {
    return { dshRoot: undefined, themeClientPath: undefined, frontendDistDir: undefined, indexHtmlPath: undefined }
  }
  const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
  const themeDirectory = resolvePackageDirectory(requireFromDsh, dshRoot, THEME_PACKAGE)
  const frontendDirectory = resolvePackageDirectory(requireFromDsh, dshRoot, FRONTEND_PACKAGE)
  return {
    dshRoot,
    themeClientPath: themeDirectory === undefined ? undefined : join(themeDirectory, 'lib', 'client.js'),
    frontendDistDir: frontendDirectory === undefined ? undefined : join(frontendDirectory, 'dist'),
    indexHtmlPath: frontendDirectory === undefined ? undefined : join(frontendDirectory, 'dist', 'index.html'),
  }
}
