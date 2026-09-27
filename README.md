# 图片隐写 · 压缩包伪装

把一个 ZIP 压缩包拼在一张图片的字节后面，产出的文件仍然能被当成图片打开，改扩展名为 `.zip` 后又能当压缩包解开；反向面板则算出压缩包在文件里的精确字节偏移，把文件切回两半。全部计算发生在浏览器里，**没有上传、没有服务端、运行期不发出任何网络请求**。界面语言为中文。

## 原理

产出文件就是两段字节的简单拼接，没有加密、没有改写头部：

```
偏移 0                    25 662                    26 039
   ┌──────────────────────────┬─────────────────────────┐
   │  封面图片的原始字节        │  ZIP 压缩包的原始字节    │
   │  25 662 B                │  377 B                  │
   └──────────────────────────┴─────────────────────────┘
   [0, 25 662)  ← 图片          [25 662, 26 039) ← 追加段
                ↑ 图片结束标记在这里
```

两件事让这个布局成立：

- **看图工具为什么只看到图片。** 解码器在读到图片自身的结束标记后就停止解析，后面的字节既不属于图像数据流，也不在它需要维护的任何长度字段里，因此被忽略。浏览器实测：把 26 039 字节的合并文件交给 `createImageBitmap`，Promise 以 96×96 兑现，页面自己的预览 `<img>` 也报 `naturalWidth = 96`。
- **为什么改扩展名就能解开。** ZIP 规范里中央目录的偏移量是相对于**压缩包自身起点**的，不是相对于文件起点。所以只要读取器是从文件末尾向前扫描 EOCD（End Of Central Directory）记录，它算出来的偏移自然就落在追加段上，前缀被透明跳过。这正是自解压（SFX）压缩包的构造方式，带前缀的 ZIP 本身是合法且广泛使用的格式。

反向操作是同一件事的逆运算。检测器从 EOF 向前找到 EOCD 记录，然后：

```
start = eocdPos - cdSize - cdOffset
```

在本项目的实测样本里，上式给出的 `start` 是 **25 662**，正好等于封面图片的长度，文件在这个位置切开就得到原图和那个 377 字节的压缩包。

### 检测算法为什么不是朴素的字节搜索

直接对 `PK\x03\x04`（`50 4B 03 04`）做 `indexOf` 会在图片像素数据上误报，回归测试把这个行为钉住了：一张**真实可解码**的 JPEG，其 `COM` 段里塞了一个格式完好的本地文件头，指向文件名 `"decoy.txt"`。在这个文件上，朴素搜索给出一个正偏移，真实检测器正确地报告"未找到"。

`src/lib/zip.ts` 的检测按以下顺序走：

1. **信任门。** 从 EOF 向前扫描 EOCD 签名，并要求"记录本体 + 声明的注释长度"正好吃到文件末尾，才认这个记录。压缩包注释里植入的诱饵 `PK\x05\x06` 因此被跳过。
2. **推导起点。** 用 `eocdPos - cdSize - cdOffset` 算出候选偏移，再用该位置上的本地文件头（LFH）做校验。
3. **ZIP64。** 32 位字段饱和为 `0xFFFFFFFF` 时，走 locator 加 ZIP64 EOCD 记录。
4. **兜底扫描。** 前三步都不成立时，扫描所有 `PK\x03\x04` 候选，逐个用解析出的本地文件头校验，取最早的一个合法偏移。

## 使用

### 伪装（拼接）

1. 选择封面图片。
2. 选择一个 `.zip` 压缩包。
3. 点击生成，下载结果。下载文件名沿用**封面图片自己的扩展名**（例如 `photo.png`），不会被改成 `.zip`；需要解开时由你自己改扩展名。

### 还原（拆分）

1. 选择合并后的文件。
2. 面板给出压缩包起始偏移、条目数与校验结论。
3. 拆分下载，得到前半段的图片和后半段的压缩包。

## 兼容性

同样是那个改名后的 `.zip`，不同读取器的结论不一样。下表只写实际测过的结果：

| 读取器 | 在改名后的 `.zip` 上的结果 | 验证方式 |
|---|---|---|
| Info-ZIP `unzip` | **能读。** 提示 `N extra bytes at beginning or within zipfile (attempting to process anyway)` 并且**退出码 1**，但随后每个条目都测成 `OK`，并打印 `No errors detected in compressed data` | `unzip -t`，自动化 |
| libarchive（`bsdtar`，Windows `tar`） | **干净读取**，3/3 条目列出，SHA256 一致 | `tar`，自动化 |
| **.NET `System.IO.Compression.ZipFile` / `Expand-Archive`** | **读不了：静默报告 0 个条目，且不抛异常** | 自动化，断言为已知的实现差异 |
| 本项目自己的读取器（`src/lib/zip.ts`） | 能读，并能推导出精确偏移 | 单元规格 16 个 |

Windows 资源管理器、WinRAR、7-Zip **未测试**（构建机器上没有安装 7-Zip）。这三者的行为本 README 不作任何声称。

### .NET 为什么失败

带前缀的压缩包是合法格式，ZIP 规范中中央目录的偏移是相对压缩包起点而言。从末尾向前定位 EOCD 的读取器（Info-ZIP、libarchive，以及本项目自己的检测器）因此能透明处理前缀。.NET 的 `ZipArchive` 从位置 0 解析偏移，不做这个修正。

危险的地方在于它**静默失败**：不抛异常，只给出一个空列表。没有报错信息告诉使用者"这个文件里其实有东西"，所以在 .NET 上打开结果时，看到空列表不代表文件是空的。

## 开发

### 前置条件

需要 **Node 22.12+ 或 20.19+**（本机实测环境是 **Node 25.9.0**）和 **pnpm 11**（实测 11.18.0）。

包管理器是 **pnpm**，`package.json` 里有 `"packageManager": "pnpm@11.18.0"`，锁文件是 `pnpm-lock.yaml`（**需要提交**）。`.gitignore` 里忽略的是 `package-lock.json` / `yarn.lock` / `bun.lockb`，这样一次误跑的 `npm install` 不会悄悄变成事实来源。

```bash
pnpm install     # 不要用 npm install
```

技术栈（`.npmrc` 里 `save-exact=true`，全部精确锁定）：

| 包 | 版本 |
|---|---|
| vue | 3.5.43 |
| vite | 8.3.1 |
| @vitejs/plugin-vue | 6.0.9 |
| vitest | 4.1.11 |
| @vue/test-utils | 2.5.1 |
| vue-tsc | 3.3.11 |
| typescript | 6.0.3 |
| jsdom | 29.1.1 |
| @types/node | 25.9.8 |
| playwright | 1.63.0 |

除 `vue` 外**零运行时依赖**：没有 UI 框架，没有 Tailwind，没有图标库，样式是手写 scoped CSS，压在自定义属性 token 层 `src/styles/tokens.css` 上。

#### 为什么不是每个包的 `latest`

`latest` 里有两个版本在 Node 25 上**装不上**，因为 Node 25 是奇数（非 LTS）发布，而很多包的 `engines.node` 只写了 `^22.12.0 || ^24.0.0 || >=26.0.0`——正好跳过 25：

- `vitest@5.x` → 用 **`vitest@4.1.11`**（`^20.0.0 || ^22.0.0 || >=24.0.0`）
- `jsdom@30.x` → 用 **`jsdom@29.1.1`**（`^20.19.0 || ^22.13.0 || >=24.0.0`）

`typescript` 也停在 **6.0.3** 而不是 7.0.2：TS 7 是原生（Go）重写版，`package.json` 的 `exports` 换成了全新 API，**不再导出 `lib/tsc`**；而 `vue-tsc` 正是靠 `require.resolve('typescript/lib/tsc')` 定位编译器的，会直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。6.0.3 是目前能与 `vue-tsc` 配合的最新 TypeScript。等 `vue-tsc` 支持 TS 7 后再升。

`@types/node` 用 **25.9.8** 而不是 registry 的 26.x：类型包要跟运行时大版本对齐。

### 工具链升级带来的三处代码改动

1. **`vitest.config.ts`：`environmentMatchGlobs` 已被 vitest 4 删除。** 改用 `projects`，四个具名 project（`unit` / `evidence` / `composable` / `component`）各自 `extends: true` 继承插件、`@` 别名与公共选项，只覆盖 `include` 与 `environment`。这也让 `pnpm test:unit` 等脚本能用 `--project <name>` 精确选择。
2. **`tsconfig.json`：删掉 `baseUrl`。** TS 6 起它被标记弃用（TS 7 将停止支持），报 `TS5101`。TS 5 起 `paths` 在没有 `baseUrl` 时本就相对 tsconfig 解析，所以直接删掉、保留 `paths` 即可，而不是加 `ignoreDeprecations` 把警告压掉。
3. **`test/component/primitives.spec.ts`：断言对象 URL 的契约而非某个实现。** vitest 4 的 jsdom 环境下全局 `URL` 是 Node 自带的实现（jsdom 29 本身依然不提供 `createObjectURL`），而 `test/setup/jsdom.ts` 里的探针**本来就会拒绝覆盖一个可用的实现**，所以 `blob:mock/N` 那个 mock 根本不会安装。断言改为验证面板真正依赖的东西：API 存在、每个 blob 拿到各自的 URL、URL 可以被 revoke——两种实现下都成立。

### pnpm 的依赖构建脚本策略

pnpm ≥ 10 默认**拦截所有依赖的安装脚本**并在有未处理项时以非零码退出。本项目在 `pnpm-workspace.yaml` 里用 `allowBuilds` 显式表态（注意：pnpm ≥ 10 **不读** `.npmrc` 里的这些键，只读 `pnpm-workspace.yaml`）：

| 包 | 决定 | 原因 |
|---|---|---|
| `playwright` | `false` | 它的 postinstall 会下载约 150 MB 浏览器二进制，而本项目**从不使用**——浏览器 QA 走 `channel: 'msedge'` 驱动系统已装的 Edge |

（这份清单以前还有 `esbuild: true`。Vite 8 改用 Rolldown，原生二进制通过平台 optional dependency 直接到位、不再需要安装脚本，esbuild 已完全不在依赖树里，故移除。）

### 脚本

全部脚本与包管理器无关（直接调 `vitest` / `vue-tsc` / `node`），`npm run` 也能跑，但约定用 `pnpm`：

| 命令 | 实际做的事 |
|---|---|
| `pnpm dev` | 启动 Vite 开发服务器 |
| `pnpm build` | `vue-tsc --noEmit` 类型检查后执行 `vite build`，产出 `dist/`（约 18 kB CSS，gzip 后约 4 kB；约 90 kB JS，gzip 后约 35 kB）。退出码 0 |
| `pnpm preview` | 以 4173 端口、`--strictPort` 预览构建产物 |
| `pnpm typecheck` | 仅类型检查（`vue-tsc --noEmit`）。退出码 0 |
| `pnpm test` | `vitest run`，跑全部 4 个 project / 14 个测试文件。**110 个用例通过** |
| `pnpm test:unit` | `--project unit --project evidence`（6 个文件） |
| `pnpm test:component` | `--project component --project composable`（6 个文件） |
| `pnpm test:watch` | Vitest 监听模式 |
| `pnpm fixtures` | 只跑 evidence project，把字节级 fixture 与真实磁盘证据写进 `.tmp/`（仓库内不落文件） |
| `pnpm qa:evidence` | 真实文件系统证据。造一张封面图和一个真压缩包，拼起来，交给 `unzip`、`tar` 和 .NET 三方读取，核对字节数与 SHA256。退出码 0 |
| `pnpm qa:browser` | Playwright 驱动**系统已安装的 Edge**（`channel: 'msedge'`），通过 `vite preview` 在 127.0.0.1:4173 上访问**构建产物**。不使用 Playwright 自带浏览器，不需要下载浏览器二进制，也不访问外部网络；页面触发的下载落在本地临时目录。退出码 0 |
| `pnpm qa:shot` | 只截取"有判定结果"状态的两张图（390 与 1440），用来把 `StatusPill` 的换行效果**拍成证据**，而不只是量出来 |
| `pnpm qa:preview` | 预览功能专证：真浏览器里选中封面图 / 压缩包 / 纯图片 / 伪装文件，断言缩略图**真的解码成功**（`naturalWidth`/`complete`），压缩包拿到的是卡片而不是坏掉的 `<img>`，并截图。23 项 |
| `pnpm qa:cjk` | 中文排版与挤压专证：逐字测量每行的字数分布，断言没有"最后一行只剩一个字"的孤字；并用一个 60 字超长文件名压在 72px 缩略图旁边，验证不溢出 |
| `pnpm qa:teardown` | 清理 QA 产物，并断言没有残留的服务进程或被占用的端口 |

六个 QA 脚本：`scripts/real-surface-check.ps1`（`qa:evidence`）、`scripts/browser-qa.mjs`（`qa:browser`）、`scripts/shot-verdict.mjs`（`qa:shot`）、`scripts/preview-proof.mjs`（`qa:preview`）、`scripts/cjk-squeeze-check.mjs`（`qa:cjk`）、`scripts/teardown.ps1`（`qa:teardown`）。四个 PowerShell / Node 脚本自己管理 `vite preview` 的生命周期，退出时杀掉子进程并复查端口。

> **门禁顺序有讲究：`qa:teardown` 会删掉 `.tmp/qa`，那正是截图和浏览器证据的存放处。** 它作为清理门禁这样设计是对的，但意味着**跑全量门禁时把 `qa:teardown` 放最后**，它会连同前面 `qa:browser` / `qa:shot` / `qa:preview` / `qa:cjk` 刚生成的 PNG 一起清掉。想在清理之后仍然查看截图，重跑对应的证据脚本即可（它们是幂等的，只写 `.tmp/qa`）。这个坑真实存在过：本文档的截图曾被自己最后跑的那道清理门禁删掉，是一次逐项审计才发现的。

它们内部**不依赖任何包管理器**：`qa:evidence` 用当前 node 直接跑 `node_modules/vitest/vitest.mjs`，两个 Node 脚本用 `process.execPath` 跑 `node_modules/vite/bin/vite.js`。换包管理器不会改坏这几个脚本，也不会误用到全局装的另一个版本。

## Docker 部署

镜像是多阶段构建，最终产物是 nginx 直接提供的静态文件：**容器里没有 Node 运行时，也没有 `node_modules` 和源码**。构建阶段照旧跑 `vue-tsc --noEmit`，类型检查这道门禁没有因为进了容器被去掉。

```bash
docker compose build     # 构建镜像
docker compose up -d     # 后台启动，宿主端口默认 8080
docker compose ps        # 看健康状态
docker compose down      # 停止并删除容器
```

改端口、换子路径走 `.env`（先 `cp .env.example .env`），或临时用环境变量：

```bash
HOST_PORT=9000 docker compose up -d
```

服务是**明文 HTTP**，TLS 请在前置反向代理上终止，不要把证书和私钥打进镜像层。

`docker-compose.yml` 与 `docker/` 里值得知道的两处加固：

- **`read_only: true` 加 `tmpfs`。** 容器根文件系统不可写，只给 nginx 的三个写路径（`/var/cache/nginx`、`/run` 的 PID 文件、`/tmp`）挂了内存盘。nginx 的访问日志与错误日志在官方镜像里是指向 `/dev/stdout` 和 `/dev/stderr` 的软链，所以不需要额外的可写路径。这一条成立的前提是 `Dockerfile` 里把 `ENTRYPOINT` 清空了：官方镜像的 entrypoint 会在 exec 之前 `sed` 改写 `/etc/nginx/nginx.conf`，只读根上会直接失败。
- **CSP 头。** `docker/security-headers.conf` 里 `default-src 'none'` 配 `connect-src 'none'`，把"运行期不发出任何网络请求"从一句说明变成浏览器强制的约束；`style-src` 的 `'unsafe-inline'` 是唯一让步，给的是 `index.html` 里那段消白屏的内联 `<style>`。

构建默认走仓库 `.npmrc` 里的 npmmirror；墙外构建设 `NPM_REGISTRY`；子路径部署用 `VITE_BASE_PATH`，两者都见 `.env.example`。

> 容器启动即退时，先去掉 `read_only` 再跑一次。这份配置在编写它的机器上无法验证（那台机器没有安装 Docker），tmpfs 列表来自 nginx 文档而不是实测启动结果。

## 项目结构

```
src/
  lib/            zip.ts 是检测核心，另有 stego.ts（拼接）、imageProbe.ts（图片探测）、
                  download.ts（下载）
  components/     两个面板与基础组件，scoped CSS
  composables/    面板状态逻辑
  styles/         tokens.css 是自定义属性 token 层，base.css 是全局基础样式
scripts/          四个 QA 脚本（见上表）
test/
  unit/           zip、stego、imageProbe、download、smoke
  component/      App、两个面板、基础组件
  composable/     两个 composable
  fixtures/       bytes.ts，字节级 fixture 构造器（LFH、EOCD、诱饵 EOCD、ZIP64 哨兵等）
  evidence/       真实磁盘证据
  setup/          jsdom 环境补丁
```

- `src/lib/zip.ts`：检测核心。EOCD 信任门、ZIP64、LFH 校验、入口名解码、区域边界检查都在这里。
- `test/fixtures/bytes.ts`：在字节层面手工构造各种畸形与对抗样本的 fixture 构造器，诱饵 JPEG 回归用例依赖它。

## 测试与验证

单元与组件测试：**14 个文件，110 个用例全部通过**。

真实文件系统证据（`pnpm qa:evidence`，退出码 0）：

- 封面图 25 662 字节，压缩包由 `[System.IO.Compression.ZipFile]::CreateFromDirectory` 写出，377 字节。
- 磁盘上的合并文件 25 662 + 377 = **26 039 字节**。
- 改名后的副本能列出 `a.txt`、`c.bin`、`nested/b.txt`，每个条目测成 `OK`，并打印 `No errors detected in compressed data`。
- 解压出的文件 SHA256 与原始文件一致。

真实浏览器证据（`pnpm qa:browser`，退出码 0，`checks: 41 ; passed: 41 ; failed: 0`，针对**构建产物**）：

- `download.suggestedFilename()` 返回 `"photo.png"`：输出沿用封面图的扩展名，没有被改成 `.zip`。
- 下载文件字节精确：25 662 + 377 = 26 039。
- `createImageBitmap` 在 26 039 字节的合并文件上兑现 96×96，尾部压缩包没有破坏图片解码；页面预览 `<img>` 独立报出 `naturalWidth = 96`。
- 回环：把合并文件重新喂进还原面板，报告偏移 **25662**，等于封面图长度；两半都通过校验，取回的压缩包 377 字节，`unzip -t` 退出码 0。
- 响应式：390×844 与 1440×900 两个宽度下、两个页签、空状态与有判定结果两种情形，都满足 `scrollWidth <= clientWidth`，且**没有任何元素越过 `clientWidth`**。
- 中文排版是量出来的，不是看出来的：`尚未选择` 占位符在两个宽度下都恰好 1 行；还原面板标题无孤字，1440 下为 2 行 `[25,25]`，390 下为 3 行 `[17,16,17]`。

预览功能专证（`pnpm qa:preview`，退出码 0，`checks: 23 ; passed: 23 ; failed: 0`）：

- 选中封面图后**立即**出现缩略图，无需先点合成：`<img>` 的 `naturalWidth x naturalHeight = 96 x 96` 且 `complete = true`（桌面与 390 两个宽度都验证）。
- 压缩包拿到的是**卡片**而不是被塞进 `<img>`：卡片里有图形标记，`<img>` 不存在，不会出现坏图图标。
- 名称与体积并排显示，例如 `photo.png` / `25.1 KB`、`payload.zip` / `377 B`。
- **一张没有附带压缩包的普通图片现在能被看见。** 这是此前的一个真实缺陷：检测不到压缩包时代码会撤销预览，选一张普通图片进去界面完全空白。现在整份文件会被探测一次，能解码就显示，图片与"这不是伪装文件"的结论同时呈现。
- 伪装文件（图片后接压缩包）仍然只有一张卡片、且图片照常解码 —— 不会因为新增的整文件探测而重复渲染。
- 名称元素的首个子节点仍是文本节点，`qa:browser` 的逐字普查依赖这一点。

中文排版与挤压专证（`pnpm qa:cjk`，退出码 0）：逐字测量行内字数分布。过程中查出并修掉两个真实缺陷：

1. **拖放区提示重复。** `DropZone` 原本无条件渲染一句通用提示，面板又传了一个 `hint`，于是每个拖放区都印两行近乎相同的说明（390px 下是 4 行）。现在 `hint` 会**取代**通用提示，只在没有 `hint` 时才回落到通用文案。
2. **拖放区提示的孤字。** 修掉重复后仍测得每行字数为 `[22, 1]` / `[25, 1]` —— 最后一个字独占一行（"…空格选" + "择"）。原因是文案比容器宽出一个字。加 `text-wrap: balance` 后变成 `[9, 14]` / `[12, 14]`；`base.css` 的标题本来就在用同一属性。
   另外用 60 字超长文件名压在 72px 缩略图旁做了挤压验证：6 行、无孤字、`scrollWidth = 390`、越界元素 0 个。

判定状态截图（`pnpm qa:shot`，退出码 0，`checks: 11 ; passed: 11 ; failed: 0`）：空状态下 `StatusPill` 根本不渲染（`tone === 'idle'` 被 `v-if` 排除），所以换行效果只能靠**加载了真实判定结果**再拍。390 下那条 49 字的中文错误提示换行为 2 行 `[26,23]`、宽 316 px（修复前是 599.6 px，在 390 px 视口里把整页撑出横向滚动）；1440 下同一句话单行放下。

清理（`pnpm qa:teardown`，退出码 0，`checks: 6 ; passed: 6 ; failed: 0`）：删除 `.tmp/qa`，断言没有残留的 `vite preview` 进程、4173 端口没有 `Listen` 套接字，并断言 `.tmp/evidence` 与 `.tmp/fixtures` 未被这次清理动过。

## 已知限制

以下是 v1 的已知边界，逐条列出。

- **整体读入内存。** 超过 256 MB 会给出警告。没有流式处理，也不会只读文件尾部的 EOCD。
- **只接受一张图片加一个压缩包。** 第二个压缩包会被拒绝，并给出说明。这是刻意的：两个压缩包拼在一起会留下两个 EOCD 记录，从末尾向前扫描只会找到最后那个，先出现的那个将无法访问，属于静默数据丢失。
- **ZIP64 分支只由合成 fixture 覆盖。** 那是一个带 `0xFFFFFFFF` 哨兵的人造样本，在这里构造一个真实的 4 GB 以上压缩包不现实。检测逻辑本身不受影响，但这条声明的范围仅限被测过的部分。
- **条目名编码是 UTF-8 对 latin1 的启发式判断。** GBK / Shift-JIS 文件名可能显示为乱码，检测本身不受影响。
- **不支持 AES / ZipCrypto，不支持跨盘（spanned）与多卷归档。**
- **检测到的偏移之前的字节不做任何解释。** 一个同时还是别的合法格式的文件不在本工具的范围内。
- **图片结束标记之后的尾随字节会被主流解码器忽略**，严格的校验器可能给出警告。Info-ZIP 就是这个行为。
- **.NET 读取器打不开结果**，见上面的兼容性矩阵。这是最容易让用户意外的一条。
- **一个已知的 Playwright 1.49.1 + Edge 产物问题**：页面发生下载时会多出一个未处理的 `TargetClosedError`。QA 脚本把它标为 `[note]`，它不是产品判定结论；任何**其他**未处理的 rejection 仍然会让检查失败。记在这里是为了让后来的维护者不要去追它。

## 仓库根目录的两个历史文件

早于本项目存在于该目录中的 `v_config.ts` 与 `v_workspace.ts` 是 **vitest 自己的内部源码**——前者是它的配置类型定义，后者是 workspace 引擎。它们的相对导入（`../node/reporters`、`./config`、`../integrations/browser/server`）只在 vitest 源码树内部才成立，落到本目录后既无法解析也不参与任何编译：不在 `tsconfig.json` 的 `include` 里，不匹配 `vitest.config.ts` 的四个 `include` glob，`node_modules` 里装的是完整的 vitest，从不需要根目录下这两份拷贝。

两个文件与本工具无关，**已删除**，`tsconfig.json` 的 `exclude`、`.gitignore` 与 `.dockerignore` 里对应的三处条目随之移除。记在这里是为了让后来的维护者看到同名文件时不要重新提交：它们不是本项目的文件，也不参与构建。
