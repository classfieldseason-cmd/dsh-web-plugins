/**
 * Extract embedded base64 images from built client modules.
 *
 * Several shipped client bundles inline onboarding artwork and preview images
 * as `data:` URLs — the largest one adds ~3.4 MB of JavaScript to the boot
 * graph, parsed and retained on every page load even though the artwork only
 * renders inside a settings/onboarding screen. This transform writes each
 * image once into the frontend's hashed asset tree, replaces the URL with a
 * relative one (resolved against the page base), and prepends a marker to the
 * bundle. The images then load on demand and are cached immutably.
 *
 * @module dsh-web-perf/patches
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Marker prepended to every rewritten client module. */
export const MARKER = 'dsh-web-perf-assets-patch'

/** Base64 image mime types this transform understands. */
const EXTENSIONS = {
  webp: 'webp',
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  'svg+xml': 'svg',
}

const IMAGE_PATTERN = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)/g

/**
 * Rewrite one client module, returning the content and the files to write.
 *
 * @param source - current client bundle text.
 * @param assetsDir - frontend `dist/assets` directory.
 * @returns `{ status, content, files, savedChars, unsupported }`.
 */
export function extractClientImages(source, { assetsDir }) {
  if (source.includes(MARKER)) {
    return { status: 'skipped', reason: `marker ${MARKER} already present`, files: [] }
  }
  if (!IMAGE_PATTERN.test(source)) {
    IMAGE_PATTERN.lastIndex = 0
    return { status: 'skipped', reason: 'no embedded base64 images', files: [] }
  }
  IMAGE_PATTERN.lastIndex = 0

  const files = new Map()
  const unsupported = new Set()
  let savedChars = 0

  let content = source.replace(IMAGE_PATTERN, (full, mime, payload) => {
    const extension = EXTENSIONS[mime.toLowerCase()]
    if (extension === undefined) {
      unsupported.add(mime.toLowerCase())
      return full
    }
    const bytes = Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const name = `${digest}.${extension}`
    const url = `./assets/dsh-perf/${name}`
    files.set(name, bytes)
    savedChars += full.length - url.length
    return url
  })
  content = `/* ${MARKER} */\n${content}`

  const unsupportedList = [...unsupported].sort()

  try {
    // Client modules are classic scripts (`window.__ModuleLoader__.load(...)`);
    // compiling catches a broken splice before any file is replaced.
    // eslint-disable-next-line no-new-func
    new Function(content)
  } catch (error) {
    return { status: 'error', reason: `patched client module does not parse: ${error.message}`, files: [] }
  }

  return {
    status: 'patched',
    content,
    files: [...files.entries()].map(([name, bytes]) => ({ path: join(assetsDir, 'dsh-perf', name), bytes })),
    savedChars,
    unsupported: unsupportedList,
  }
}

/** Write through a sibling temp file, preserving the original mode. */
function writeAtomically(filePath, content) {
  const mode = statSync(filePath).mode & 0o777
  const temporary = `${filePath}.dsh-web-perf-${process.pid}.tmp`
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

/**
 * Rewrite the embedded images of one client bundle.
 * @returns a report row (`patched`, `skipped`, or `error`).
 */
export function patchClientModule(directory, id, { assetsDir }) {
  const filePath = join(directory, 'lib', 'client.js')
  if (!existsSync(filePath)) {
    return { id, target: filePath, status: 'skipped', reason: 'client bundle not found' }
  }
  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { id, target: filePath, status: 'error', reason: `read failed: ${error.message}` }
  }

  const result = extractClientImages(source, { assetsDir })
  if (result.status !== 'patched') {
    return { id, target: filePath, status: result.status, reason: result.reason, bytes: source.length }
  }

  try {
    for (const file of result.files) {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.bytes)
    }
    writeAtomically(filePath, result.content)
  } catch (error) {
    return { id, target: filePath, status: 'error', reason: `write failed: ${error.message}` }
  }

  return {
    id,
    target: filePath,
    status: 'patched',
    images: result.files.length,
    savedBytes: result.savedChars,
    originalBytes: source.length,
    patchedBytes: result.content.length,
    unsupported: result.unsupported,
  }
}

/**
 * Scan every shipped client bundle and extract embedded images.
 *
 * @param targets - `{ frontendDistDir, clientPackages }`.
 * @returns `{ patched, errors, scanned }`; `patched` carries the module ids
 * that the client-module registry must re-read.
 */
export function applyPerfPatches(targets) {
  const patched = []
  const errors = []
  if (targets.frontendDistDir === undefined) {
    errors.push({ id: '(frontend)', status: 'error', reason: 'frontend dist not resolved' })
    return { patched, errors, scanned: 0 }
  }
  const assetsDir = join(targets.frontendDistDir, 'assets')
  const packages = targets.clientPackages ?? []
  for (const entry of packages) {
    const row = patchClientModule(entry.directory, entry.id, { assetsDir })
    if (row.status === 'patched') patched.push(row)
    else if (row.status === 'error') errors.push(row)
  }
  return { patched, errors, scanned: packages.length }
}
