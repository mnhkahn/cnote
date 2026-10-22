# CNote

基于 Rust、GPUI 和系统 WebKit 的 macOS 笔记应用，复刻 [cyeam.com/note](https://www.cyeam.com/note) 的核心功能，兼容同一 OneDrive `Notes/` 目录中的 HTML 笔记。应用图标和 Bootstrap Icons 直接复用 `cyeam_web` 的资源。

## 使用与构建

需要 macOS 14+、Xcode Command Line Tools、Rust 1.96+。支持 Apple Silicon 和 Intel。

```sh
cargo run --locked
sh scripts/package.sh debug       # dist/CNote.app
sh scripts/package.sh release    # 优化后的应用包
open dist/CNote.app
```

- 原生 GPUI 窗口、虚拟化笔记列表、跟随系统的深浅色主题、侧边栏折叠和专注模式。
- 左下角工具切换：`⌘1` 笔记、`⌘2` 文本处理（JSONPack）、`⌘3` Diff、`⌘4` CSV。三个工具均为本地实现，在同一个内嵌编辑区域内切换；不嵌套在线页面、不下载运行时代码。Cocoa 原生事件监视器在 WKWebView / Ace 获得焦点时也处理快捷键，菜单“视图”保留对应入口。
- 富文本：粗体、斜体、下划线、删除线、代码、三级标题、有序/无序列表、缩进、撤销/重做、清除格式。
- Markdown 快捷输入：行首 `#`、`##`、`###`、`-`、`*`、`1.`、`>`、`[]`、`[ ]` 后按空格。
- 待办勾选会序列化到 HTML；表格支持插入和右键增删行列；支持粘贴图片、链接与富文本。
- 本机自动保存、OneDrive 自动同步、手动保存、刷新、删除确认、HTML 导出和系统打印。
- `⌘S` 保存、`⌘N` 新建、`⌘\` 折叠侧边栏、`⌘Q` 退出。Windows/Linux 尚未适配。

点击“登录 OneDrive”，在系统浏览器输入应用显示的 Microsoft 设备码。沿用 `cyeam-cli` 的 Microsoft 应用 ID、个人账号和权限范围。登录凭据仅存储于 macOS Keychain（服务 `com.cyeam.cnote`），不进入 SQLite、网页或日志。该账号必须拥有 OneDrive；实际登录、同步和跨设备冲突需要用个人 Microsoft 账号验证。

离线也能新建和编辑。SQLite 数据库默认位于 `~/Library/Application Support/com.cyeam.CNote/notes.db`（以 `directories` 返回的实际路径为准）；可通过 `CNOTE_DATA_DIR=/absolute/path` 隔离测试数据。退出登录后原账号的笔记仍在本机保留，重新登录该账号后显示，不会交给另一个账号同步。离线新建的未归属笔记会归入下次登录的账号。

## 性能与数据保护

原生外壳和虚拟化列表使用 `gpui-pre` / `gpui-pre-platform`，编辑区域使用与 herdr-gpui 相同的 `lb-wry` 系统 WebView，不打包 Chromium、Node 或 Electron。富文本编辑需要浏览器的排版与输入法能力，因而编辑区不是 GPUI 原生文本控件。所有 HTML、JS、CSS、字体均内嵌，无 CDN 或网页服务启动依赖。原生图标字体包含 GPUI macOS 加载器所需的 `m` 度量字符；重新生成字体子集后可运行 `python3 scripts/prepare-icon-font.py` 补齐（仅该维护脚本需要 fonttools，正常构建不需要）。

输入先更新内存中的编辑视图，普通切换、新建和格式操作不等待磁盘或 OneDrive。每篇笔记独立排队保存：停顿 200 ms 后保存，持续输入时最多约每秒提交一次快照；大段保存数据的 JSON 解析和 SQLite 写入均在后台线程执行，静置约两秒后同步云端。保存确认只回传小型消息，不重建整份笔记列表。

已打开的笔记保留编辑视图及布局，切换时不重新序列化/净化整篇 HTML，也不强制同步读取滚动布局；字数统计延后计算。干净的非活动视图按 LRU 保留最多 8 篇、约 16 MiB HTML 文本；未落盘或写入失败的草稿不会被淘汰，失败约三秒后自动重试。界面用递增的导航序号拒绝迟到的加载结果；尚未形成快照的输入也会阻止远端内容直接覆盖。

只有退出、账号切换、确认删除及冲突覆盖这类操作会等待相关草稿落盘，正常切换不等待。退出会检查所有笔记的待保存内容，包含当前未打开的笔记；任一写入失败都取消退出并保留内存草稿。SQLite 仍使用 WAL + `synchronous=FULL`，不以降低持久性换取交互速度。异常退出仍可能丢失尚未提交成功的输入；单篇笔记最大 20 MB、单张粘贴图片最大 8 MB。

`npm test` 包含 1,500 段长文的缓存切换基准，分别记录同步处理耗时和到下一个 `requestAnimationFrame` 的耗时；后者是进入下一帧回调的代理指标，并非操作系统实际显示像素的时间。它不包含首次打开、云端下载，也未与 Apple 备忘录做同机直接比较。

上传和删除都携带 ETag 条件，不直接覆盖其他设备修改；下载前后核对 ETag，防止内容与版本标识错配。上传完成只确认当时的修订，不会误清除更新的本地修改。大幅替换/删除需显式确认。冲突可选择保留本地或云端，取消后可先导出 HTML；云端笔记已删除但本机仍有草稿时保留草稿并暂停同步。

首次新建上传使用 `标题--8位唯一ID.html`，保证网络响应丢失后的重试不会重复创建或覆盖同名文件；列表会隐藏这一后缀。现有网页创建的 `.html` 文件可以直接打开和继续编辑。网页完整 HTML 会净化为正文，脚本、事件处理器、内嵌页面等不执行；远程 HTTPS 图片会正常请求其来源站点。

## 使用统计

正式版复用 `cyeam-cli` 的 PostHog 项目，后台直接向 `https://us.i.posthog.com/batch/` 上报。所有事件均带 `app=cnote`、`platform=macos`、`app_version`、`os` 和 `architecture`；仪表盘按 `app=cnote` 筛选即可与 CLI 分开。活跃用户按匿名安装 ID 统计，不等同于 Microsoft 账号数。

随机安装 ID 存在应用数据目录下的 `analytics-id`，使用 `cnote:` 前缀，与 CLI 的安装 ID 独立。不上报笔记标题、正文、笔记 ID、账号、令牌或原始错误信息，不启用网页自动采集或会话回放；PostHog 接收请求时仍能看到来源 IP。

事件包括 `app_started`、`note_created`、`note_deleted`、`login_completed`、`session_restored`、`logout_completed` 和 `sync_completed`。云端事件带操作类别、结果（成功/失败/冲突/未登录）及请求耗时；查询同步成功率需过滤 `operation` 和 `outcome`，不能把所有事件都当作成功。耗时不包含云端任务排队时间。输入和本地自动保存不逐次上报。

独立线程每五秒或累计 32 条发送，内存队列最多 128 条；队列满或网络失败时丢弃，不重试、不占用笔记同步线程。退出后最多等待统计 300 ms，短时会话、断网或异常退出可能漏报。

设置 `CNOTE_NO_ANALYTICS=1` 或 `DO_NOT_TRACK=1` 可关闭；`CI=true`、自动化测试和原生 smoke test 也关闭。Debug 构建默认关闭，可通过 `CNOTE_ANALYTICS_DEBUG=1 cargo run --locked` 启用；Release 构建默认开启。关闭时不初始化统计客户端或读写安装 ID。项目采集 Token 可内嵌，个人查询 API Key 不放入客户端。

## 本地工具

- 文本：本地 Ace 代码编辑器，支持多光标 / Option 列选择、撤销重做、JSON / XML / SQL 格式化、JSON 压缩、去空行、合并换行、排序去重、正则按行过滤、字面字符删除、分隔符提取列和字符换行。JSON 格式化保留大整数原始字面值。
- Diff：双侧编辑、实时行差异、两侧排序 / 去重 / 格式化、复制新增或删除内容，结果分页显示，不创建海量 DOM。
- 表格：导入 CSV / TSV、JSON、JSONL、Markdown、HTML、SQL INSERT、Excel；编辑单元格和表头、增删行列、数值排序、筛选保留、去重、转置、计数统计、撤销重做；导出 CSV、JSON、JSONL、Markdown、HTML、SQL、Excel，通过原生保存对话框选择文件。打印 / PDF 使用 macOS 打印窗口。

工具界面、代码编辑器、算法和依赖全部随应用打包，运行时无需 CDN 或网站。格式化、正则、Diff 和表格转换在按需启动的 Web Worker 中计算；过时的任务会取消，超时保留原始输入。笔记的编辑树在切换工具时保留。工具数据不发送给 OneDrive 或统计服务。

工具草稿单独保存在 `notes.db` 的 `settings.tool_state` 中，后台异步保存；退出、注销和更新安装均等待工具草稿与笔记落盘，保存失败保留内存草稿并暂停退出。工具数据与 Microsoft 账号无关，切换账号不会同步或清除它。

表格单元格按文本保存，以保留前导零和大整数；JSON 导出使用字符串值，数值排序和统计按需解析。Excel 导入第一张工作表，不执行公式或宏；不保留工作簿样式。单文件及工具草稿合计上限 20 MB，表格上限 20 万行、2048 列、200 万单元格；界面每次显示最多 100 行 × 24 列，可翻页；打印 / PDF 上限 5000 行。筛选会保留匹配行，可撤销。工具版不包含网站的云端 AI / 图片识别服务。

正常 Rust / GitHub Actions 打包直接使用已提交的离线资源，不依赖 `cyeam_web`。修改 `tools/core.cjs` 或依赖后运行 `npm ci && npm run build:tools` 更新 bundle；`npm run check:tools` 校验资源与源代码一致。更换 Ace 原始资源时可显式设置 `CNOTE_ACE_SOURCE=/path/to/ace` 再生成。

## GitHub Actions 与自动更新

- `ci.yml`：普通分支 push / PR 只做检查和构建，提供可下载的开发应用 ZIP，不创建 Release，也不更新自动升级源。检查格式、Clippy、Rust 测试、原生升级保护、打包元数据和 Chromium/WebKit 编辑器测试。
- `release.yml`：只有推送稳定版本标签（如 `v0.1.0`，也支持 `V0.1.0` / `0.1.0`）才发布，没有手动发布入口。编译前先检查签名密钥和版本号，再分别构建 Apple Silicon / Intel 应用；两者成功后创建 GitHub Release 并上传 ZIP、SHA-256、架构对应的签名 appcast。
- Sparkle 2.10.0 按 SHA-256 固定下载；更新包和 appcast 都签名并在解压前验证。每小时自动检查，可在侧栏手动检查；安装/重启等待编辑缓冲落盘。自动更新仅在打包后的 `.app` 中启用。

CNote 使用独立的 Ed25519 密钥：公钥位于 `assets/update-public-key.txt`；私钥保存在本机 Keychain 的 Sparkle 账号 `com.cyeam.cnote` 和仓库 Actions secret `SPARKLE_PRIVATE_KEY` 中。首次配置新仓库或恢复 secret 时，运行下面的脚本；脚本先核对公钥，再将原有私钥传给 GitHub，中间文件位于私有临时目录，退出时删除：

```sh
# 需要 gh 已登录且有仓库 secret 写入权限；只需执行一次
bash scripts/configure-signing.sh
```

私钥与公钥必须保持配对并跨版本保留。默认更新源是 `mnhkahn/cnote`；构建其他仓库时设置 `CNOTE_UPDATE_REPOSITORY=owner/repo`。首个带更新组件的版本需手动安装，此后跟踪 GitHub 最新正式 Release。发布包目前使用本地 ad-hoc 签名；如需通过 Gatekeeper 无提示分发，需自行配置 Apple Developer ID 签名与公证。

打包时版本号统一取自 tag：Actions 使用触发发布的 tag；本地省略版本时使用当前提交可达的最高稳定版本 tag。没有 tag 时须显式指定，例如 `sh scripts/package.sh debug v0.0.2`。安装包、Sparkle 比较版本、统计和请求 User-Agent 均使用此版本，不再将 Cargo 的 crate 版本当作应用打包版本。CI 会完整拉取 tag。可设置 `CNOTE_BUNDLE_PATH=dist/preview/CNote.app` 将包生成到另一个目录。

早期本机开发包曾误标为 0.1.0，而线上发布从 0.0.x 开始；Sparkle 会按正常版本顺序阻止安装这些较低版本。使用修正版本号的本地构建替换一次后，后续 0.0.x 的递增更新即可正常检查和安装。

## 验证

编辑器测试保留缓存切换处理 p95 < 16ms 的要求；下一帧测试交错测量空闲帧，以实测空闲帧 p95 的两倍（最低 35ms）为上限，记录两组延迟，避免把共享 CI runner 的整体调度延迟算作编辑器回退。

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
sh scripts/test-updater.sh
sh scripts/test-shortcuts.sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm ci
npm run check:tools
npx playwright install chromium webkit
npm test
cargo build --locked
python3 scripts/smoke-test.py   # 真实 GPUI + WKWebView + SQLite，独立临时数据
```

编辑器测试不连接 Microsoft、不访问真实笔记，验证内容净化、无需等待保存的切换、后台失败重试、所有草稿的退出保护、复选框、表格操作、登录窗口、新建和长文档交互性能。Rust 测试校验内嵌字体的度量字符和原生界面图标轮廓；原生 smoke test 还会实际验证 GPUI 字体选择未回退、图标字形可解析。原生升级测试复用并适配 alloy 的隔离测试；它不加载 Sparkle、不进行更新联网。完整 GPUI/WebKit smoke test 在本机运行，向 Cocoa 队列投递真实 ⌘1–⌘4 事件，在 WKWebView 中运行本地工具并检查草稿持久化；若 CI runner 支持 WindowServer/Metal，可设置仓库变量 `CNOTE_NATIVE_UI_TESTS=true` 启用。
