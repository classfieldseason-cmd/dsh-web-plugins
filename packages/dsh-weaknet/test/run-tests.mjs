/**
 * Workspace test for the weak-network transport patches.
 *
 * Applies the transforms to synthetic modules, checks idempotency, and drives
 * the plugin entry point against a fake installation so the recovery override
 * and file patches are exercised without touching the real build.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyWeakNetPatches,
  HEARTBEAT_INTERVAL_MS,
  MARKERS,
  patchGatewaySource,
  patchWebserverSource,
  RECOVERY,
} from '../lib/patches.js'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, '.work')

const GATEWAY_SOURCE = `import WebSocket, { WebSocketServer } from "ws";
const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2e3;
const DEFAULT_STREAM_INBOX_BYTES = 262144;
var RemoteStreamMuxServer = class {
	server = new WebSocketServer({ noServer: true });
};
export { RemoteStreamMuxServer };
`

const WEBSERVER_SOURCE = `import compressionMiddleware from "compression";
import Negotiator from "negotiator";
function createGzipMiddleware(config) {
	return (req, res, next) => {
		const encoding = new Negotiator(req).encoding(["gzip", "identity"]);
		const gzipRequest = Object.create(req);
		Object.defineProperty(gzipRequest, "headers", { value: {
			...req.headers,
			"accept-encoding": encoding === "gzip" ? "gzip" : "identity"
		} });
		compressionMiddleware(config)(gzipRequest, res, next);
	};
}
const serverOwner = {
	server: { on() {} },
	listen() {
		this.server.on("upgrade", (req, socket, head) => {});
	},
};
export { createGzipMiddleware, serverOwner };
`

function read(path) {
  return readFileSync(path, 'utf8')
}

rmSync(work, { recursive: true, force: true })

// Pure transforms.
const gateway = patchGatewaySource(GATEWAY_SOURCE)
assert.equal(gateway.status, 'patched')
assert.ok(gateway.content.startsWith(`/* ${MARKERS.gateway} */`))
assert.ok(gateway.content.includes(`const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS};`))
assert.ok(gateway.content.includes('perMessageDeflate: { threshold: 1024'))
assert.equal(patchGatewaySource(gateway.content).status, 'skipped')

const webserver = patchWebserverSource(WEBSERVER_SOURCE)
assert.equal(webserver.status, 'patched')
assert.ok(webserver.content.startsWith(`/* ${MARKERS.brotli} */`))
assert.ok(webserver.content.includes('.encoding(["br", "gzip", "identity"])'))
assert.ok(webserver.content.includes('"accept-encoding": encoding === "gzip" || encoding === "br" ? encoding : "identity"'))
assert.ok(webserver.content.includes('this.server.keepAliveTimeout = 30000;'))
assert.ok(webserver.content.includes('this.server.headersTimeout = 35000;'))
assert.equal(patchWebserverSource(webserver.content).status, 'skipped')

// Real files: first pass patches, second pass leaves everything alone.
const targets = join(work, 'targets')
mkdirSync(join(targets, 'gateway', 'lib'), { recursive: true })
mkdirSync(join(targets, 'webserver', 'lib'), { recursive: true })
writeFileSync(join(targets, 'gateway', 'lib', 'index.js'), GATEWAY_SOURCE)
writeFileSync(join(targets, 'webserver', 'lib', 'index.js'), WEBSERVER_SOURCE)
const paths = {
  gatewayPath: join(targets, 'gateway', 'lib', 'index.js'),
  webserverPath: join(targets, 'webserver', 'lib', 'index.js'),
}

const first = applyWeakNetPatches(paths)
assert.deepEqual(first.map((row) => row.status), ['patched', 'patched'])
assert.ok(read(paths.gatewayPath).includes(MARKERS.gateway))
assert.ok(read(paths.webserverPath).includes(MARKERS.brotli))
// The syntax check must have accepted the rewritten ESM.
const before = [paths.gatewayPath, paths.webserverPath].map((path) => statSync(path).mtimeMs)
const second = applyWeakNetPatches(paths)
assert.deepEqual(second.map((row) => row.status), ['skipped', 'skipped'])
assert.deepEqual(
  [paths.gatewayPath, paths.webserverPath].map((path) => statSync(path).mtimeMs),
  before,
  'skipped patches must not rewrite files',
)

// Plugin wiring: fake installation + stub context.
const fakeRoot = join(work, 'fake-dsh')
const gatewayDir = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-api-gateway')
const webserverDir = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-webserver')
mkdirSync(join(gatewayDir, 'lib'), { recursive: true })
mkdirSync(join(webserverDir, 'lib'), { recursive: true })
writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
writeFileSync(join(gatewayDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-api-gateway', exports: { './package.json': './package.json' } }))
writeFileSync(join(webserverDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host-webserver', exports: { './package.json': './package.json' } }))
writeFileSync(join(gatewayDir, 'lib', 'index.js'), GATEWAY_SOURCE)
writeFileSync(join(webserverDir, 'lib', 'index.js'), WEBSERVER_SOURCE)

const { apply: pluginApply } = await import('../index.js')
const logs = []
const injectedRows = []
const listeners = []
const stubContext = () => ({
  logger: () => ({
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  }),
  inject: (deps, callback) => {
    if (deps.includes('webServer')) {
      callback({
        on: (event, listener) => {
          assert.equal(event, 'webserver/index-inject')
          listeners.push(listener)
        },
      })
    }
  },
})

const previousRoot = process.env.DSH_WEAKNET_DSH_ROOT
process.env.DSH_WEAKNET_DSH_ROOT = fakeRoot
try {
  pluginApply(stubContext())
  assert.equal(listeners.length, 1, 'one index-inject subscription')
  listeners[0](injectedRows)
  assert.deepEqual(injectedRows, [{ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: RECOVERY }])
  assert.ok(read(join(gatewayDir, 'lib', 'index.js')).includes(MARKERS.gateway))
  assert.ok(read(join(webserverDir, 'lib', 'index.js')).includes(MARKERS.brotli))
  assert.ok(logs.some((line) => line.includes('restart dsh web once to activate')))
  assert.ok(!logs.some((line) => line.startsWith('warn')), 'a healthy run must not warn')

  logs.length = 0
  pluginApply(stubContext())
  assert.ok(!logs.some((line) => line.includes('restart dsh web once')), 'already-current patches need no restart notice')
} finally {
  if (previousRoot === undefined) delete process.env.DSH_WEAKNET_DSH_ROOT
  else process.env.DSH_WEAKNET_DSH_ROOT = previousRoot
}

console.log('dsh-weaknet: all patch tests passed')
console.log(`work directory: ${resolve(work)}`)
