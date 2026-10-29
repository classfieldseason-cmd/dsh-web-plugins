/**
 * Workspace test for the Web performance bundle.
 *
 * Exercises image extraction, idempotency, the immutable `/assets` route and
 * the plugin wiring against a fake installation.
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAssetHandler } from '../lib/asset-route.js'
import { applyPerfPatches, extractClientImages, MARKER } from '../lib/patches.js'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, '.work')

const WEBP_B64 = Buffer.from('fake-webp-bytes').toString('base64')
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64')
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')

const CLIENT_SOURCE = `window.__ModuleLoader__.load({
  id: "@fake/client",
  factory: () => {
    var a = "data:image/webp;base64,${WEBP_B64}";
    var b = "data:image/png;base64,${PNG_B64}";
    var c = "url(data:image/svg+xml;base64,${SVG_B64})";
    return { a, b, c };
  },
});
`

const AVIF_SOURCE = `window.__ModuleLoader__.load({
  id: "@fake/avif",
  factory: () => ({ img: "data:image/avif;base64,AAAA" }),
});
`

function read(path) {
  return readFileSync(path, 'utf8')
}

function request(port, path, method = 'GET', headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

rmSync(work, { recursive: true, force: true })

// Pure extraction.
const assetsDir = join(work, 'dist', 'assets')
const extracted = extractClientImages(CLIENT_SOURCE, { assetsDir })
assert.equal(extracted.status, 'patched')
assert.equal(extracted.files.length, 3)
assert.ok(extracted.content.startsWith(`/* ${MARKER} */`))
assert.equal((extracted.content.match(/data:image/g) ?? []).length, 0)
assert.equal((extracted.content.match(/\.\/assets\/dsh-perf\//g) ?? []).length, 3)
assert.ok(extracted.savedChars > 0)
new Function(extracted.content)
assert.equal(extractClientImages(extracted.content, { assetsDir }).status, 'skipped')

const unsupported = extractClientImages(AVIF_SOURCE, { assetsDir })
assert.equal(unsupported.status, 'patched')
assert.deepEqual(unsupported.unsupported, ['avif'])
assert.ok(unsupported.content.includes('data:image/avif;base64,AAAA'))

// Disk pass + idempotency.
const fakePkg = join(work, 'pkg', 'lib')
mkdirSync(fakePkg, { recursive: true })
writeFileSync(join(fakePkg, 'client.js'), CLIENT_SOURCE)
const targets = {
  frontendDistDir: join(work, 'dist'),
  clientPackages: [{ id: 'dsh-client-fake', directory: join(work, 'pkg') }],
}
const first = applyPerfPatches(targets)
assert.equal(first.patched.length, 1)
assert.equal(first.patched[0].images, 3)
for (const file of extracted.files) {
  const bytes = readFileSync(file.path)
  assert.ok(bytes.length > 0, `extracted file exists: ${file.path}`)
}
const before = statSync(join(fakePkg, 'client.js')).mtimeMs
const second = applyPerfPatches(targets)
assert.equal(second.patched.length, 0)
assert.equal(statSync(join(fakePkg, 'client.js')).mtimeMs, before)

// Immutable asset route.
const dist = join(work, 'dist')
mkdirSync(join(dist, 'assets', 'dsh-perf'), { recursive: true })
writeFileSync(join(dist, 'assets', 'index-AAAA.css'), 'body{color:#000}')
writeFileSync(join(dist, 'assets', 'dsh-perf', 'image.webp'), 'webp-bytes')
writeFileSync(join(work, 'secret.txt'), 'secret')
const handler = createAssetHandler({ distDir: dist })
const server = createServer((req, res) => {
  handler(req, res).catch((error) => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
try {
  const css = await request(port, '/assets/index-AAAA.css')
  assert.equal(css.status, 200)
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(css.body.toString(), 'body{color:#000}')

  const image = await request(port, '/assets/dsh-perf/image.webp')
  assert.equal(image.status, 200)
  assert.equal(image.headers['content-type'], 'image/webp')

  const missing = await request(port, '/assets/nope.css')
  assert.equal(missing.status, 404)

  const head = await request(port, '/assets/index-AAAA.css', 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(Buffer.byteLength('body{color:#000}')))
  assert.equal(head.body.length, 0)

  const traversal = await request(port, '/assets/%2e%2e/secret.txt')
  assert.ok(traversal.status === 403 || traversal.status === 404, `traversal blocked, got ${traversal.status}`)

  const method = await request(port, '/assets/index-AAAA.css', 'POST')
  assert.equal(method.status, 405)
} finally {
  await new Promise((done) => server.close(done))
}

// Plugin wiring against a fake installation.
const fakeRoot = join(work, 'fake-dsh')
const frontendDir = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
const clientDir = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-fake')
mkdirSync(join(frontendDir, 'dist', 'assets'), { recursive: true })
mkdirSync(join(clientDir, 'lib'), { recursive: true })
writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
writeFileSync(
  join(frontendDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', exports: { './package.json': './package.json' } }),
)
writeFileSync(join(frontendDir, 'dist', 'index.html'), '<html><head></head><body></body></html>')
writeFileSync(join(clientDir, 'package.json'), JSON.stringify({ name: 'dsh-client-fake' }))
writeFileSync(join(clientDir, 'lib', 'client.js'), CLIENT_SOURCE)

const { apply: pluginApply } = await import('../index.js')
const logs = []
const registered = []
const rebuilt = []
const stubContext = () => ({
  logger: () => ({
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  }),
  inject: (deps, callback) => {
    if (deps.includes('webServer')) {
      callback({
        effect: (fn) => fn(),
        webServer: {
          register: (route) => {
            registered.push(route)
            return () => {}
          },
        },
      })
    }
    if (deps.includes('clientModules')) {
      callback({
        clientModules: {
          rebuilt: (id) => {
            rebuilt.push(id)
            return 'rev'
          },
        },
      })
    }
  },
})

const previousRoot = process.env.DSH_WEB_PERF_DSH_ROOT
process.env.DSH_WEB_PERF_DSH_ROOT = fakeRoot
try {
  pluginApply(stubContext())
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/assets')
  assert.deepEqual(rebuilt, ['dsh-client-fake'])
  assert.ok(read(join(clientDir, 'lib', 'client.js')).startsWith(`/* ${MARKER} */`))
  assert.ok(!logs.some((line) => line.startsWith('warn')), 'a healthy run must not warn')

  registered.length = 0
  rebuilt.length = 0
  logs.length = 0
  pluginApply(stubContext())
  assert.equal(registered.length, 1, 'the route registers on every activation')
  assert.deepEqual(rebuilt, [], 'skipped modules need no registry refresh')
} finally {
  if (previousRoot === undefined) delete process.env.DSH_WEB_PERF_DSH_ROOT
  else process.env.DSH_WEB_PERF_DSH_ROOT = previousRoot
}

console.log('dsh-web-perf: all patch tests passed')
console.log(`work directory: ${resolve(work)}`)
