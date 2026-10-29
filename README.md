# DSH Web 插件集

三个针对 **DeepSeek Harness (DSH) Web 界面** 的插件：修字体、扛弱网、降资源占用。每个插件都是标准的 `dsh.bundle`，通过 npm 安装，随 DSH 的插件系统启停，不修改 DSH 源码。

| npm 包 | 解决什么问题 | 一句话效果 |
| --- | --- | --- |
| [`dsh-font-fix`](packages/dsh-font-fix) | antialiased 让 PingFang SC 笔画变细、品牌字体 Montserrat 混入界面 | 统一系统字体栈，14px/22px，关闭 antialiased，移除 Montserrat |
| [`dsh-weaknet`](packages/dsh-weaknet) | 高延迟/丢包下握手超时、心跳误杀连接、数据不压缩 | 握手 15s→60s，心跳 2s→15s，WebSocket 帧压缩，HTTP Brotli，连接复用 30s |
| [`dsh-web-perf`](packages/dsh-web-perf) | 首屏要拉 9 MB+ 客户端模块，静态资源没有缓存策略 | 哈希资源一年不可变缓存，3.4 MB 内联插图外置按需加载 |

## 环境要求

- 已安装并运行 `dsh`，且使用 **web** profile（`dsh web`）。
- 能执行 `dsh plugin` 命令（或使用 Web 界面的插件管理器）。

## 安装

```bash
dsh plugin --profile web add dsh-font-fix
dsh plugin --profile web add dsh-weaknet
dsh plugin --profile web add dsh-web-perf
```

安装后在 DSH Web 里**刷新一次页面**。插件管理器（`插件 → 已安装插件`）会显示中文标题与说明，可随时开关。

也可以从源码安装：

```bash
git clone https://github.com/classfieldseason-cmd/dsh-web-plugins.git
dsh plugin --profile web add ./dsh-web-plugins/packages/dsh-font-fix
```

## 各插件说明

### dsh-font-fix

把 UI 字体统一为：

```text
-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif
```

并设置 `font-size:14px`、`line-height:22px`、`text-rendering:auto`、
`-webkit-font-smoothing:auto`，去掉 `antialiased` 造成的细笔画；同时把
`--dsw-font-family` 与 `--dsw-font-family-brand` 指向该字体栈，不再加载
Montserrat。

三组补丁各自带幂等标记，分别落在：

- `dsh-client-ui-theme/lib/client.js` 的 `:root` 变量（`dsh-font-theme-patch`）
- `dsh-web-frontend/dist/assets/index-*.css`（`dsh-font-css-patch`，按通配符匹配 hash）
- `dsh-web-frontend/dist/index.html` 的 `<head>` 内联样式（`dsh-font-html-patch`，含 `input/textarea/select/button`）

刷新即生效。

### dsh-weaknet

默认 Gateway 每 2 秒 ping 一次、连续 2 次没 pong 就断开，也就是约 6 秒的容忍度——高延迟链路一次 RTT 抖动就会掉线。这个插件：

- 客户端握手超时 **15s → 60s**（慢握手警告 3s → 20s），退避 800ms ×1.7、上限 15s；
- Gateway 心跳 **2s → 15s**（容忍约 45s），并开启 WebSocket `permessage-deflate`
  （1 KiB 阈值、zlib level 3）；
- WebServer 改为 **Brotli 优先于 gzip**，HTTP keep-alive 空闲 **5s → 30s**。

握手/重连参数通过 index 注入即时生效（刷新页面即可）；心跳、WebSocket 压缩、Brotli 和 keep-alive 是模块加载期读取的，**需要下次 `dsh web` 启动**才装载。升级 DSH 后可先运行：

```bash
node ~/.dsh/profiles/web/node_modules/dsh-weaknet/apply.mjs
```

再启动，一次重启即可。

### dsh-web-perf

- 新增 `/assets` 前缀路由，为 Vite 生成的内容哈希文件返回
  `cache-control: public, max-age=31536000, immutable`，并补齐
  `webp/png/jpeg/gif/woff2/woff/ttf/otf/ico` 的 MIME。此前静态资源没有缓存头，
  每次打开页面都会重新校验/下载入口与 vendor 包。
- 把客户端包里内联的 base64 图片抽取到
  `dist/assets/dsh-perf/<sha256>.<ext>`，并把引用改为相对 URL。实测：

  | 客户端包 | 修改前 | 修改后 |
  | --- | ---: | ---: |
  | `dsh-client-ui-settings-account` | 3 415 941 B | 209 245 B |
  | `dsh-client-ui-plugin-manager` | 626 456 B | 218 984 B |
  | `dsh-client-ui-chat` | 592 012 B | 565 389 B |

这些图片只在打开设置/引导页时加载，之后命中不可变缓存。路由与改写都在插件激活后即时生效，刷新页面即可；浏览器实测刷新后入口 JS/CSS 的 `transferSize` 为 0。

## 重要说明

这些插件通过**幂等文件补丁**改进已安装的 DSH Web 构建：补丁带独立标记、写前语法校验、临时文件原子替换，失败只记日志不会拖垮 DSH。因此：

- `dsh` 升级会替换构建文件、丢掉标记，下次启动（或手动 `apply.mjs`）自动重打；
- 停用/卸载插件只停止后续重打，**不会回滚**已经写入的补丁；要恢复原版，重装 `dsh` 即可；
- 补丁锚点随 DSH 版本变化时会报告 warning 并跳过该项，不影响其余功能。

## 仓库结构

```text
packages/
  dsh-font-fix/    字体修复（Host bundle）
  dsh-weaknet/     弱网优化（Host bundle + 构建补丁）
  dsh-web-perf/    性能优化（Host bundle + /assets 路由 + 图片外置）
```

每个包都是独立的 npm 包，均自带 README、MIT LICENSE、`cordis.patch.yml`、
`locale/{en,zh}.json` 与图标。

## 开发与测试

无需构建步骤，包内是可直接加载的 ESM：

```bash
npm test            # 依次运行三个包的补丁/路由/接线测试
npm run publish:all # 发布三个包到 npm（需要 npm 登录）
```

测试全部在工作区临时目录里跑合成样本，不会读写真实安装文件。

## 许可

MIT
