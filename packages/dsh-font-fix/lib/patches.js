/**
 * Idempotent font patches for the built DSH Web frontend.
 *
 * Three independent patch groups, each carrying its own marker:
 * - dsh-font-theme-patch: `@deepseek-ai/dsh-client-ui-theme/lib/client.js`
 * - dsh-font-css-patch:   `<frontend>/dist/assets/index-*.css`
 * - dsh-font-html-patch:  `<frontend>/dist/index.html`
 *
 * Every transform is a pure function over file text, so a release upgrade that
 * replaces a built file simply drops its marker and the next run re-applies the
 * patch. Nothing is written unless the whole transform validates.
 *
 * @module dsh-font-fix/patches
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** UI font stack owned by this fix. */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'

/** Marker for each patch group; a file containing its marker is already patched. */
export const MARKERS = Object.freeze({
  theme: 'dsh-font-theme-patch',
  css: 'dsh-font-css-patch',
  html: 'dsh-font-html-patch',
})

/** Font metrics/smoothing that must accompany the stack. */
const METRICS =
  'font-size:14px;line-height:22px;text-rendering:auto;-webkit-font-smoothing:auto;-moz-osx-font-smoothing:auto'

/** Escape a plain CSS value for insertion into a JS double-quoted string literal. */
function escapeDoubleQuoted(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** Find the closing quote of a JS double-quoted string starting at `from`. */
function findLiteralEnd(text, from) {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"') return index
    if (character === '\n') return -1
  }
  return -1
}

/**
 * Patch the theme client's embedded base stylesheet.
 *
 * The generated bundle keeps `base.css` in one `base_css_default` string
 * literal. The default text stack and brand stack are replaced in place, and a
 * final `:root` rule (followed by the marker) repeats the variables plus the
 * requested metrics. The final rule wins the cascade inside that stylesheet,
 * so a changed literal layout only degrades the in-place edits, not the fix.
 *
 * @param source - current `client.js` text.
 * @param stack - font stack to install.
 * @returns transform result; `content` is set only for a patchable file.
 */
export function patchThemeClientSource(source, stack = FONT_STACK) {
  if (source.includes(MARKERS.theme)) {
    return { status: 'skipped', reason: `marker ${MARKERS.theme} already present` }
  }
  const anchor = 'var base_css_default = "'
  const anchorIndex = source.indexOf(anchor)
  if (anchorIndex < 0) {
    return { status: 'error', reason: 'base_css_default declaration not found' }
  }
  const literalStart = anchorIndex + anchor.length
  const literalEnd = findLiteralEnd(source, literalStart)
  if (literalEnd < 0) {
    return { status: 'error', reason: 'base_css_default string literal is unterminated' }
  }

  const warnings = []
  let literal = source.slice(literalStart, literalEnd)
  let replacedDefaultStack = false

  if (/--dsh-font-family-text-default:[^;]*;/.test(literal)) {
    literal = literal.replace(
      /--dsh-font-family-text-default:[^;]*;/,
      `--dsh-font-family-text-default:${escapeDoubleQuoted(stack)};`,
    )
    replacedDefaultStack = true
  } else {
    warnings.push('--dsh-font-family-text-default declaration not found; the appended rule still defines it')
  }

  if (/--dsw-font-family-brand:[^;]*;/.test(literal)) {
    literal = literal.replace(
      /--dsw-font-family-brand:[^;]*;/,
      '--dsw-font-family-brand:var(--dsh-font-family-text-default);',
    )
  } else {
    warnings.push('--dsw-font-family-brand declaration not found; the appended rule still overrides it')
  }

  const override =
    `:root{--dsh-font-family-text-default:${escapeDoubleQuoted(stack)};` +
    '--dsw-font-family:var(--dsh-font-family-text-default);' +
    '--dsw-font-family-brand:var(--dsh-font-family-text-default);' +
    `${METRICS}}/* ${MARKERS.theme} */`
  literal += override

  const content = source.slice(0, literalStart) + literal + source.slice(literalEnd)
  if (!content.includes(MARKERS.theme)) {
    return { status: 'error', reason: 'marker missing after transform' }
  }
  try {
    // Compiling the bundle catches a broken string splice before it reaches disk.
    // The function body is never executed.
    // eslint-disable-next-line no-new-func
    new Function(content)
  } catch (error) {
    return { status: 'error', reason: `patched client.js does not parse: ${error.message}` }
  }
  if (content.includes('Montserrat')) {
    warnings.push('Montserrat still appears in the theme client')
  }
  return {
    status: 'patched',
    content,
    warnings,
    details: { replacedDefaultStack },
  }
}

/**
 * Patch the built frontend stylesheet.
 *
 * Removes the antialiased smoothing that thins PingFang SC strokes, drops the
 * Montserrat `@font-face` blocks, refreshes the `--dsw-font-family` fallback,
 * and appends the stack/metrics plus the form-control rules.
 *
 * @param source - current `index-*.css` text.
 * @param stack - font stack to install.
 * @returns transform result; `content` is set only for a patchable file.
 */
export function patchFrontendCssSource(source, stack = FONT_STACK) {
  if (source.includes(MARKERS.css)) {
    return { status: 'skipped', reason: `marker ${MARKERS.css} already present` }
  }

  let next = source
  const antialiased = (next.match(/-webkit-font-smoothing:antialiased/g) ?? []).length
  next = next.replaceAll('-webkit-font-smoothing:antialiased', '-webkit-font-smoothing:auto')
  const grayscale = (next.match(/-moz-osx-font-smoothing:grayscale/g) ?? []).length
  next = next.replaceAll('-moz-osx-font-smoothing:grayscale', '-moz-osx-font-smoothing:auto')

  const fallbackPattern = /var\(\s*--dsw-font-family\s*,[^)]*\)/g
  const fallbacks = (next.match(fallbackPattern) ?? []).length
  next = next.replace(fallbackPattern, `var(--dsw-font-family, ${stack})`)

  const montserratPattern = /@font-face\{[^}]*Montserrat[^}]*\}/g
  const montserrat = (next.match(montserratPattern) ?? []).length
  next = next.replace(montserratPattern, '')

  const warnings = []
  if (next.includes('Montserrat')) {
    warnings.push('Montserrat still appears outside removable @font-face blocks')
  }
  if (next.includes('-webkit-font-smoothing:antialiased')) {
    warnings.push('antialiased smoothing remains after transform')
  }

  next +=
    `\nhtml,body{${METRICS}}\n` +
    `input,textarea,select,button{font-family:inherit;${METRICS}}\n` +
    `/* ${MARKERS.css} */\n`

  return {
    status: 'patched',
    content: next,
    warnings,
    details: { antialiased, grayscale, fallbacks, montserrat },
  }
}

/**
 * Patch the frontend `index.html` template.
 *
 * The style sits at the end of `<head>`, after the linked stylesheets, so it
 * governs the first paint (and form controls, which do not inherit the UA font
 * size) before any client plugin module has run. The runtime theme stylesheet
 * is appended later and still wins, which keeps the user's font preference.
 *
 * @param source - current `index.html` text.
 * @param stack - font stack to install.
 * @returns transform result; `content` is set only for a patchable file.
 */
export function patchIndexHtmlSource(source, stack = FONT_STACK) {
  if (source.includes(MARKERS.html)) {
    return { status: 'skipped', reason: `marker ${MARKERS.html} already present` }
  }
  const close = /<\/head\s*>/i.exec(source)
  if (close === null) {
    return { status: 'error', reason: '</head> not found' }
  }

  const style =
    '<style data-dsh-font-patch>' +
    `:root{--dsh-font-family-text-default:${stack};` +
    '--dsw-font-family:var(--dsh-font-family-text-default);' +
    '--dsw-font-family-brand:var(--dsh-font-family-text-default);' +
    `${METRICS}}` +
    `html,body{font-family:var(--dsw-font-family, ${stack});${METRICS}}` +
    `input,textarea,select,button{font-family:inherit;${METRICS}}` +
    '</style>' +
    `<!-- ${MARKERS.html} -->`
  const content = `${source.slice(0, close.index)}${style}${source.slice(close.index)}`
  if ((content.match(new RegExp(MARKERS.html, 'g')) ?? []).length !== 1) {
    return { status: 'error', reason: 'marker count is not exactly one after transform' }
  }
  return { status: 'patched', content, warnings: [] }
}

/** Write `content` over `filePath` through a sibling temp file, preserving its mode. */
function writeAtomically(filePath, content) {
  const mode = statSync(filePath).mode & 0o777
  const temporary = `${filePath}.dsh-font-fix-${process.pid}.tmp`
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
 * Apply one pure transform to one file.
 * @returns a report row with `patch`, `target`, `status` and an optional `reason`.
 */
export function patchFile(filePath, patchName, transform) {
  if (filePath === undefined || !existsSync(filePath)) {
    return { patch: patchName, target: filePath ?? '(unresolved)', status: 'error', reason: 'file not found' }
  }
  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { patch: patchName, target: filePath, status: 'error', reason: `read failed: ${error.message}` }
  }
  const result = transform(source)
  if (result.status !== 'patched') {
    return {
      patch: patchName,
      target: filePath,
      status: result.status,
      reason: result.reason,
      warnings: result.warnings,
    }
  }
  try {
    writeAtomically(filePath, result.content)
  } catch (error) {
    return { patch: patchName, target: filePath, status: 'error', reason: `write failed: ${error.message}` }
  }
  return {
    patch: patchName,
    target: filePath,
    status: 'patched',
    details: result.details,
    warnings: result.warnings,
  }
}

/**
 * Locate the stylesheet the current `index.html` links, falling back to every
 * `index-*.css` in `dist/assets` so a changed content hash needs no code change.
 *
 * @param distDir - frontend `dist` directory.
 * @param indexHtmlPath - the frontend `index.html` path.
 * @returns absolute CSS paths, referenced file first.
 */
export function resolveIndexCssFiles(distDir, indexHtmlPath) {
  const referenced = []
  try {
    const html = readFileSync(indexHtmlPath, 'utf8')
    for (const match of html.matchAll(/href="([^"]*index-[^"]+\.css)"/g)) {
      const file = join(distDir, match[1].replace(/^\.?\//, ''))
      if (existsSync(file)) referenced.push(file)
    }
  } catch {
    /* fall through to the wildcard scan */
  }
  if (referenced.length > 0) return [...new Set(referenced)]

  const assets = join(distDir, 'assets')
  if (!existsSync(assets)) return []
  return readdirSync(assets)
    .filter((name) => /^index-.*\.css$/.test(name))
    .map((name) => join(assets, name))
}

/**
 * Apply all three patch groups to resolved targets.
 *
 * @param targets - `{ themeClientPath, frontendDistDir, indexHtmlPath }`, each optional.
 * @param options - `{ stack }` override; defaults to {@link FONT_STACK}.
 * @returns one report row per target; never throws on a single patch failure.
 */
export function applyFontFix(targets, options = {}) {
  const stack = options.stack ?? FONT_STACK
  const results = []

  results.push(
    patchFile(targets.themeClientPath, MARKERS.theme, (source) => patchThemeClientSource(source, stack)),
  )

  const cssFiles = targets.frontendDistDir
    ? resolveIndexCssFiles(targets.frontendDistDir, targets.indexHtmlPath)
    : []
  if (cssFiles.length === 0) {
    results.push({
      patch: MARKERS.css,
      target: targets.frontendDistDir ?? '(unresolved)',
      status: 'error',
      reason: 'no index-*.css found',
    })
  } else {
    for (const file of cssFiles) {
      results.push(patchFile(file, MARKERS.css, (source) => patchFrontendCssSource(source, stack)))
    }
  }

  results.push(
    patchFile(targets.indexHtmlPath, MARKERS.html, (source) => patchIndexHtmlSource(source, stack)),
  )
  return results
}
