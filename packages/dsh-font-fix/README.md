# DSH Web Font Fix

[![npm](https://img.shields.io/npm/v/dsh-font-fix.svg)](https://www.npmjs.com/package/dsh-font-fix)

> 中文摘要：恢复系统字体栈、移除 Montserrat、关闭 antialiased 平滑，解决 PingFang SC 笔画变细。安装：`dsh plugin --profile web add dsh-font-fix`。

A persistent DSH bundle that repairs the Harness Web UI's typography. Every
Harness boot re-applies three idempotent patches to the installed build, so a
`dsh` upgrade (which replaces those built files) heals on the next start.

## What it changes

| Patch | Target | Effect |
| --- | --- | --- |
| `dsh-font-theme-patch` | `@deepseek-ai/dsh-client-ui-theme/lib/client.js` | Sets the system font stack as `--dsh-font-family-text-default`, and redefines `--dsw-font-family` / `--dsw-font-family-brand` from it (Montserrat removed); sets 14px/22px, `text-rendering:auto`, `-webkit-font-smoothing:auto`. |
| `dsh-font-css-patch` | `<frontend>/dist/assets/index-*.css` | Removes the antialiased/grayscale smoothing, drops the Montserrat `@font-face` blocks, refreshes the `--dsw-font-family` fallback, and appends the 14px/22px + smoothing rules for `html`, `body`, `input`, `textarea`, `select`, `button`. |
| `dsh-font-html-patch` | `<frontend>/dist/index.html` | Adds a `<style>` at the end of `<head>` (after the linked CSS) that defines the font variables and first-paint metrics, including `input`/`textarea`/`select`/`button`. |

Font stack:

```text
-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif
```

The brand stack is consumed by the first-run/onboarding headings in
`@deepseek-ai/dsh-client-ui-settings-account`; overriding
`--dsw-font-family-brand` moves those headings to the same system stack. The
`@font-face` removal then drops the Montserrat files from the stylesheet.

## Idempotency

Each group writes its own marker (`dsh-font-theme-patch`, `dsh-font-css-patch`,
`dsh-font-html-patch`). A target that already contains its marker is skipped, so
repeated boots and manual runs are no-ops. Because the markers live in the built
files themselves, an upgrade that replaces those files drops the marker and the
next boot re-applies the patch.

## Installation

```sh
dsh plugin --profile web add dsh-font-fix
```

or install the directory through Plugin Manager. The Host plugin applies the
patches as soon as its row activates; refresh the page once.

## Manual run and verification

```sh
node apply.mjs
```

The script resolves the same installation the running Node executable uses.
Set `DSH_FONT_FIX_DSH_ROOT=/path/to/node_modules/@deepseek-ai/dsh` when the
installation lives somewhere unusual. It exits non-zero if a patch fails.

## Notes

- The stylesheet and `index.html` patches are read per request, so a hard page
  refresh shows them immediately.
- `client-modules` snapshots client bundles when its service is built. When a
  boot actually rewrites the theme client, the plugin asks the registry to
  re-read that bundle (`rebuilt()`), so one page reload picks up the new
  revision — no second restart.
- `node apply.mjs` patches files only. If you use the CLI instead of the
  installed bundle, restart `dsh web` afterwards so the theme client is read
  again; the CSS and `index.html` layers still apply on refresh.
- `index-*.css` is matched through the stylesheet link in `index.html`, falling
  back to a wildcard scan of `dist/assets`, so a changed content hash needs no
  code change.
- The patches live in the installed build, not in a profile layer: a `dsh`
  upgrade replaces them, and the next boot (or a manual `node apply.mjs`)
  re-applies them. Disabling or removing the bundle stops future re-application
  but does not revert files already patched; reinstall `dsh` to get the stock
  build back (deleting the markers alone does not undo the edits).
