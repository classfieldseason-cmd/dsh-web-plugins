/**
 * Workspace test for the font patches.
 *
 * Builds synthetic copies shaped like the real built artifacts, applies the
 * three patch groups, and asserts both the patched content and idempotency. It
 * never reads or writes the DSH installation, so it runs against any checkout.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyFontFix, FONT_STACK, MARKERS } from '../lib/patches.js'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, '.work')

const OLD_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif'

const THEME_SOURCE = `window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-theme",
  factory: (require) => {
    var base_css_default = ":root{--dsh-font-family-text-default:${OLD_STACK.replaceAll('"', '\\"')};--dsw-font-family:var(--dsh-font-family-text-default);--dsw-font-family-brand:\\"Montserrat\\", var(--dsh-font-family-text-default);--dsw-radius-panel:28px}body{--dsw-font-family:var(--dsh-font-family-text,var(--dsh-font-family-text-default)), var(--dsh-font-family-text-default)}";
    return { apply() {} };
  },
});
`

const CSS_SOURCE = `@font-face{font-family:Montserrat;font-style:normal;font-weight:400;font-display:swap;src:url(./fonts/montserrat-regular-AAAA.woff2) format("woff2")}@font-face{font-family:Montserrat;font-style:normal;font-weight:300;font-display:swap;src:url(./fonts/montserrat-light-BBBB.woff2) format("woff2")}body{font-family:var( --dsw-font-family, ${OLD_STACK} );-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color:#000}button,input,select,textarea{font-family:inherit}
`

const HTML_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" crossorigin href="./assets/index-AAAA.css">
  </head>
  <body><div id="root"></div></body>
</html>
`

function buildTargets(root) {
  const themeDir = join(root, 'theme')
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  mkdirSync(join(themeDir, 'lib'), { recursive: true })
  writeFileSync(join(themeDir, 'lib', 'client.js'), THEME_SOURCE)
  writeFileSync(join(dist, 'assets', 'index-AAAA.css'), CSS_SOURCE)
  writeFileSync(join(dist, 'index.html'), HTML_SOURCE)
  return {
    themeClientPath: join(themeDir, 'lib', 'client.js'),
    frontendDistDir: dist,
    indexHtmlPath: join(dist, 'index.html'),
    cssPath: join(dist, 'assets', 'index-AAAA.css'),
  }
}

function read(path) {
  return readFileSync(path, 'utf8')
}

const roots = join(work, 'roots')
rmSync(work, { recursive: true, force: true })
const targets = buildTargets(join(roots, 'main'))

const first = applyFontFix(targets, { stack: FONT_STACK })
assert.deepEqual(
  first.map((row) => [row.patch, row.status]),
  [
    [MARKERS.theme, 'patched'],
    [MARKERS.css, 'patched'],
    [MARKERS.html, 'patched'],
  ],
)

const client = read(targets.themeClientPath)
assert.equal((client.match(/dsh-font-theme-patch/g) ?? []).length, 1)
assert.ok(client.includes(FONT_STACK.replaceAll('"', '\\"')), 'stack is present in the JS literal')
assert.ok(/--dsw-font-family-brand:var\(--dsh-font-family-text-default\)/.test(client))
assert.ok(!client.includes('Montserrat'), 'Montserrat removed from the theme client')
assert.ok(!client.includes('Hiragino Sans GB'), 'old default stack replaced')
assert.ok(client.includes('-webkit-font-smoothing:auto'))
assert.ok(client.includes('font-size:14px;line-height:22px'))
new Function(client) // still parses as a classic script

const css = read(targets.cssPath)
assert.equal((css.match(/dsh-font-css-patch/g) ?? []).length, 1)
assert.ok(!css.includes('-webkit-font-smoothing:antialiased'))
assert.ok(!css.includes('-moz-osx-font-smoothing:grayscale'))
assert.ok(css.includes('-webkit-font-smoothing:auto'))
assert.ok(!css.includes('Montserrat'))
assert.ok(!css.includes('@font-face'))
assert.ok(css.includes(`var(--dsw-font-family, ${FONT_STACK})`))
assert.ok(css.includes('input,textarea,select,button{font-family:inherit;'))
assert.ok(css.trimEnd().endsWith(`/* ${MARKERS.css} */`))

const html = read(targets.indexHtmlPath)
assert.equal((html.match(/dsh-font-html-patch/g) ?? []).length, 1)
assert.ok(html.includes('<style data-dsh-font-patch>'))
assert.ok(html.indexOf('data-dsh-font-patch') < html.indexOf('</head>'))
assert.ok(html.includes(`html,body{font-family:var(--dsw-font-family, ${FONT_STACK});`))
assert.ok(html.includes('input,textarea,select,button{font-family:inherit;'))
// The inline style must follow the linked stylesheet so it wins the first paint.
assert.ok(html.indexOf('data-dsh-font-patch') > html.indexOf('index-AAAA.css'))

// Idempotency: a second run changes nothing and preserves mtimes.
const paths = [targets.themeClientPath, targets.cssPath, targets.indexHtmlPath]
const before = paths.map((path) => statSync(path).mtimeMs)
const second = applyFontFix(targets, { stack: FONT_STACK })
assert.deepEqual(
  second.map((row) => row.status),
  ['skipped', 'skipped', 'skipped'],
)
assert.deepEqual(paths.map((path) => statSync(path).mtimeMs), before, 'skipped patches must not rewrite files')

// Simulated upgrade: the built files are replaced and the markers disappear.
const upgraded = buildTargets(join(roots, 'upgraded'))
const third = applyFontFix(upgraded, { stack: FONT_STACK })
assert.deepEqual(
  third.map((row) => row.status),
  ['patched', 'patched', 'patched'],
)
assert.ok(read(upgraded.themeClientPath).includes(MARKERS.theme))
assert.ok(read(upgraded.cssPath).includes(MARKERS.css))
assert.ok(read(upgraded.indexHtmlPath).includes(MARKERS.html))

// A changed content hash is still matched through the wildcard scan even when
// the stylesheet link cannot be parsed.
const wildcardRoot = join(roots, 'wildcard')
mkdirSync(join(wildcardRoot, 'dist', 'assets'), { recursive: true })
writeFileSync(join(wildcardRoot, 'dist', 'index.html'), '<html><head></head><body></body></html>')
writeFileSync(join(wildcardRoot, 'dist', 'assets', 'index-0123ABCD.css'), CSS_SOURCE)
const wildcard = applyFontFix(
  {
    themeClientPath: upgraded.themeClientPath,
    frontendDistDir: join(wildcardRoot, 'dist'),
    indexHtmlPath: join(wildcardRoot, 'dist', 'index.html'),
  },
  { stack: FONT_STACK },
)
assert.equal(wildcard.find((row) => row.patch === MARKERS.css)?.status, 'patched')

// Plugin wiring: a freshly patched theme client asks clientModules for a new
// revision, while an already-patched tree stays silent.
const { apply: pluginApply } = await import('../index.js')
const fakeRoot = join(roots, 'fake-dsh')
const fakeTheme = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme')
const fakeFrontend = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
mkdirSync(join(fakeTheme, 'lib'), { recursive: true })
mkdirSync(join(fakeFrontend, 'dist', 'assets'), { recursive: true })
writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
writeFileSync(
  join(fakeTheme, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-theme', exports: { './package.json': './package.json' } }),
)
writeFileSync(
  join(fakeFrontend, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', exports: { './package.json': './package.json' } }),
)
writeFileSync(join(fakeTheme, 'lib', 'client.js'), THEME_SOURCE)
writeFileSync(join(fakeFrontend, 'dist', 'assets', 'index-AAAA.css'), CSS_SOURCE)
writeFileSync(join(fakeFrontend, 'dist', 'index.html'), HTML_SOURCE)

const logs = []
const rebuilt = []
const stubContext = () => ({
  logger: () => ({
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  }),
  inject: (_deps, callback) =>
    callback({
      clientModules: {
        rebuilt: (id) => {
          rebuilt.push(id)
          return 'test-rev'
        },
      },
    }),
})

const previousRoot = process.env.DSH_FONT_FIX_DSH_ROOT
process.env.DSH_FONT_FIX_DSH_ROOT = fakeRoot
try {
  pluginApply(stubContext())
  assert.deepEqual(rebuilt, ['@deepseek-ai/dsh-client-ui-theme'])
  assert.ok(logs.some((line) => line.startsWith('info dsh-font-fix: client module revision refreshed')))
  assert.ok(!logs.some((line) => line.startsWith('warn')), 'a healthy patch run must not warn')

  rebuilt.length = 0
  logs.length = 0
  pluginApply(stubContext())
  assert.deepEqual(rebuilt, [], 'skipped patches must not refresh the registry')
} finally {
  if (previousRoot === undefined) delete process.env.DSH_FONT_FIX_DSH_ROOT
  else process.env.DSH_FONT_FIX_DSH_ROOT = previousRoot
}

console.log('dsh-font-fix: all patch tests passed')
console.log(`work directory: ${resolve(work)}`)
