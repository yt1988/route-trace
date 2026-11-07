# AGENTS.md

这份说明写给在这个仓库里干活的人和 AI 代理（Claude Code、Codex、Cursor 等都适用）。

## 这是什么

路由追踪（Route Trace），线上地址是 https://trace.1ms.dog，属于 [1ms.dog](https://1ms.dog) 的一组免费网络工具。

- 页面在访客浏览器里调用 [Globalping](https://globalping.io) 跑一次 MTR。
- 去程挑一个和访客网络最像的探针；回程挑目标附近的探针，追回访客的地址。
- 结果逐跳画成时间线和地图：经过哪些网络和线路，在哪里出境，哪一段绕路，哪里真的丢包。

所有请求都从访客浏览器直接发给公共服务，测量不经过自己的服务器。为什么这样做、各个数据来源测过的结论，见 [docs/design.md](docs/design.md)。

1ms.dog 的运营说明在私有仓库 1ms-shell。

## 代码在哪

| 路径 | 内容 |
|---|---|
| `src/page.html` | 页面模板（`data-i`、`{{a:key}}` 由构建填入各语言文字） |
| `src/app.js` | 页面逻辑：检测出口、挑探针、选择器、运行、渲染、分享 |
| `src/lib.mjs` | 纯逻辑：探针匹配和排序、跳点分析（延迟下限、丢包、局域网、地理合理性、跳变解释、线路命名） |
| `src/net.mjs` | 网络请求：Globalping、GeoJS、ipinfo、PeeringDB、RDAP、DoH、STUN、出口检测 |
| `src/map.mjs` | d3 地图：路线动画、探针点、缩放 |
| `src/code.mjs` | 分享链接的编码和解码，回程目标打码 |
| `src/worker.js` | Cloudflare Worker：只处理 `/r/<码>` 的预览标题和描述，其他交给静态资源 |
| `src/i18n/<lang>.mjs` | 10 种语言的文字，`zh-CN` 是基准 |
| `src/cities.mjs` | 城市名的各语言写法 |
| `scripts/build.mjs` | 从 `src/` 生成 `public/`：各语言页面、带哈希的资源、SEO、`_headers` |
| `scripts/assets.mjs` | 用 resvg 生成分享预览图 |
| `test/` | 单元测试（`lib`）和多语言覆盖测试；fixtures 只用文档保留地址 |

## 本地跑起来

```bash
npm ci
npm run build      # 生成 public/
npm run dev        # wrangler dev，打开 http://localhost:8807
```

`public/` 是构建产物，但要提交进仓库：`npm test` 会检查它和 `src/` 是否一致。

## 测试：按改动范围选

| 改了什么 | 跑什么 |
|---|---|
| 任何改动，提交前 | `npm run build` 然后 `npm test`（构建一致性 + 单元测试 + 多语言键和占位符） |
| `src/lib.mjs`（分析、匹配、线路） | `npm test`；必要时在 `test/lib.test.mjs` 补用例 |
| 页面、样式、交互 | 上面这些，再用 `npm run dev` 在浏览器里看桌面和 375px 手机宽度、浅色和深色 |
| 文字 | 改 `zh-CN` 后，其余 9 种语言同一个键都要改，`npm test` 会查 |
| 分享卡片、预览图 | `npm run assets`，再打开一个 `/r/` 链接看 |

## 部署

这是一个带静态资源的 Cloudflare Worker（`wrangler.toml`，Worker 名 `route-trace`）。

- 手动部署：`npm run build`，然后 `npm run deploy`（需要你自己的 Cloudflare 账号）。
- 自动部署：把仓库接到 Cloudflare Workers Builds，构建命令填 `npm ci && npm test`。之后推送 `main` 就会部署。
- 站点地址是构建参数：`SITE_URL=https://<your-domain> npm run build`，用于 canonical、sitemap 和分享链接。

## 约定

- 测量请求从浏览器直接发给公共服务，不要改成经过自己的服务器。
- 仓库里不放真实用户 IP 或密钥。测试数据只用文档保留地址：`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`2001:db8::/32`。
- 分享出去的回程结果默认不带访客的完整地址，要访客自己勾选才显示。
- 提交说明用英文；文档用中文。
