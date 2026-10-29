# DSH Web Performance

> 中文摘要：哈希资源一年不可变缓存；客户端包内 3.4 MB 内联插图外置、按需加载。安装：`dsh plugin --profile web add dsh-web-perf`。

Reduces the boot payload and makes repeat loads cheap.

## What it changes

### 1. Immutable `/assets` cache

The shipped fallback static server sends no `cache-control` (and no MIME entry
for images or fonts), so every page load revalidates or re-downloads the entry
and vendor bundles, the CSS and the per-language chunks. This bundle registers
a `/assets` prefix route ahead of the fallback:

- `cache-control: public, max-age=31536000, immutable` for every file under
  `dist/assets` (Vite hashes those names, so a new build changes the URL);
- a complete MIME table including `webp`, `png`, `jpeg`, `gif`, `woff2`, `woff`,
  `ttf`, `otf`, `ico`;
- `GET`/`HEAD` only, traversal rejected, missing files 404.

The route is live as soon as the plugin activates — no restart, no page rebuild.

### 2. Inline artwork extraction

Several shipped client bundles inline artwork as base64 `data:` URLs. The
largest, `@deepseek-ai/dsh-client-ui-settings-account`, is **3.4 MB of
JavaScript for ~2.4 MB of onboarding WebP artwork**; the plugin manager carries
another ~0.3 MB of preview SVGs. The boot graph parses and retains all of it on
every page load even though the artwork only renders inside a settings or
onboarding screen.

The bundle writes each image once into `dist/assets/dsh-perf/<sha256>.<ext>`,
replaces the data URL with `./assets/dsh-perf/...` (resolved against the page
base), and prepends its marker to the rewritten bundle. The image is fetched
only when the screen that uses it opens, and is then cached immutably by the
route above.

Measured on the installed build:

| Bundle | Before | After |
| --- | --- | --- |
| `dsh-client-ui-settings-account` | 3 415 941 B | ~60 KB |
| `dsh-client-ui-plugin-manager` | 626 456 B | ~310 KB |
| `dsh-client-ui-chat` | 592 012 B | ~563 KB |

After rewriting a bundle the plugin asks `clientModules.rebuilt(id)` for a new
revision, so one page reload fetches the small generation instead of the cached
pre-patch bytes.

## Idempotency

Each rewritten client bundle starts with `/* dsh-web-perf-assets-patch */` and is
skipped on later boots. A `dsh` upgrade replaces the bundle and its dist, drops
the marker, and the next boot re-extracts. Extracted files are content-hashed,
so re-extraction is deterministic.

## Installation

```sh
dsh plugin --profile web add dsh-web-perf
```

or install the directory through Plugin Manager. The route and extraction are
live on activation; refresh the page once.

## Manual run

```sh
node apply.mjs
```

Extracts artwork without starting the Harness (the `/assets` route only exists
while the plugin is mounted). Useful before a restart after a `dsh` upgrade.

## Notes

- Extracted images are ordinary frontend assets; deleting `dist/assets/dsh-perf`
  or reinstalling `dsh` restores the original inline behavior on the next boot.
- Relative URLs resolve against the document base, the same base the shipped
  `index.html` uses for its own `./assets/...` links.
- The plugin does not alter JavaScript logic, React components, or the theme.
