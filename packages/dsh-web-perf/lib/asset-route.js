/**
 * Immutable static serving for the frontend's hashed `/assets` tree.
 *
 * The shipped fallback static server sends files without a cache policy, so
 * every page load revalidates or re-downloads the 1.7 MB entry/vendor bundles
 * and the per-language chunks. Vite gives every file in `dist/assets` a
 * content hash, so this prefix route may answer with a one-year immutable
 * policy: a new build changes the URL, which changes the cache key.
 *
 * @module dsh-web-perf/asset-route
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** One-year immutable policy for content-hashed files. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
}

/**
 * Build the `/assets` handler.
 * @param options - `{ distDir }`, the frontend `dist` directory.
 * @returns a Node request handler serving only `<distDir>/assets`.
 */
export function createAssetHandler({ distDir }) {
  const root = resolve(distDir, 'assets')

  return async function handleAsset(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }

      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      let decoded
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (!decoded.startsWith('/assets/')) {
        res.writeHead(404)
        res.end()
        return
      }

      const target = resolve(root, decoded.slice('/assets/'.length))
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        res.writeHead(403)
        res.end()
        return
      }

      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      if (req.method === 'HEAD') {
        try {
          const info = await stat(target)
          res.writeHead(200, { 'content-type': type, 'cache-control': IMMUTABLE, 'content-length': info.size })
        } catch {
          res.writeHead(404)
        }
        res.end()
        return
      }

      let body
      try {
        body = await readFile(target)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') {
          res.writeHead(404)
          res.end()
          return
        }
        throw error
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': IMMUTABLE })
      res.end(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`asset route failure: ${message}`)
    }
  }
}
