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

- 原生 GPUI 窗口、虚拟化笔记列表、支持顶栏“⋯”或“视图 → 主题”选择 20 种配色（浅色、深色、暖纸、樱花、薄荷、薰衣草、沙丘、冰川、日光、象牙、晴空、极夜、森林、德古拉、莫诺凯、午夜、深海、复古、暮光、石墨）或跟随系统；鼠标悬停主题名称即时预览，点击后记住偏好，移出主题列表或取消菜单恢复原主题，窗口与编辑器同步切换、侧边栏折叠和专注模式。列表名称使用正文第一个非空标题，保存或下载内容后更新；没有正文标题时使用原笔记名称。
- 顶栏固定工作区 Tab：`⌘1` 笔记、`⌘2` 文本处理（JSONPack）、`⌘3` Diff、`⌘4` CSV、`⌘5` Trello 日历。工具页完全隐藏左侧栏，使用全部内容宽度；可点击顶栏 Tab、通过快捷键或“视图”菜单切换工作区，切回笔记时恢复原侧栏状态。三个工具均为本地实现，在同一个内嵌编辑区域内切换；不嵌套在线页面、不下载运行时代码。Cocoa 原生事件监视器在 WKWebView / Ace 获得焦点时也处理快捷键，菜单“视图”保留对应入口。
- 富文本：粗体、斜体、下划线、删除线、代码、三级标题、有序/无序列表、缩进、撤销/重做、清除格式。笔记正文支持 `⌘B` 加粗、`⌘I` 斜体、`⌘U` 下划线，再按一次取消；没有选中文字时切换后续输入的格式。格式快捷键仅作用于当前获得焦点的笔记正文，不修改弹窗或其他工具页。
- Markdown 快捷输入：行首 `#`、`##`、`###`、`-`、`*`、`1.`、`>`、`[]`、`[ ]` 后按空格。
- 笔记工具栏的“？”和 `⌘/` 打开完整快捷键说明；悬停按钮也能看到对应按键。`⌘1–⌘5` 保留工作区切换，标题使用 `⌘⌥1–⌘⌥3`。

| 操作 | 快捷键 |
| --- | --- |
| 加粗 / 斜体 / 下划线 / 删除线 | `⌘B` / `⌘I` / `⌘U` / `⌘⇧X` |
| 行内代码 / 代码块 / 引用 | `⌘E` / `⌘⇧C` / `⌘⇧B` |
| 插入或编辑链接 / 移除链接 | `⌘K` / `⌘⇧K` |
| 正文 / 一级、二级、三级标题 | `⌘⌥0` / `⌘⌥1`、`⌘⌥2`、`⌘⌥3` |
| 有序列表 / 无序列表 / 待办事项 | `⌘⇧7` / `⌘⇧8` / `⌘⇧9` |
| 减少 / 增加缩进 | `⌘[` / `⌘]`；列表内也可用 `⇧Tab` / `Tab` |
| 左对齐 / 居中 / 右对齐 / 两端对齐 | `⌘⇧L` / `⌘⇧E` / `⌘⇧R` / `⌘⇧J` |
| 清除字符格式 | `⌘⇧\` |
| 插入表格 / 表格内前后移动 | `⌘⌥T` / `⇧Tab`、`Tab`；末格按 Tab 新增一行，可撤销 |
| 纯文本粘贴 | `⌘⇧V`，不保留富文本、不自动转换表格 |
| 当前笔记内查找 / 下一个 / 上一个 | `⌘F` / `⌘G` 或 Enter / `⌘⇧G` 或 ⇧Enter；Esc 关闭 |
| 打印 / 快捷键说明 | `⌘P` / `⌘/` |

- 待办勾选会序列化到 HTML；表格支持插入和右键增删行列；支持粘贴图片、链接与富文本。
- 粘贴单个 HTTP(S) 链接时先插入可点击的网址，再在后台获取网页标题并替换链接文字，保留原链接地址，支持撤销。直接请求目标网站，不经过第三方代理、不携带 OneDrive 或 Trello 凭据；最多跟随 5 次重定向，超时 8 秒，读取前 1 MB HTML，标题最多 300 字。无标题、请求失败、非 HTML、非 UTF-8 或需要 JavaScript 渲染的标题保留网址；手动修改或删除链接后，迟到的结果不会覆盖修改。切换笔记后结果等待原笔记重新获得编辑焦点；`⌘⇧V` 纯文本粘贴不获取标题。
- 本机自动保存、OneDrive 自动同步、手动保存、刷新、删除确认、HTML 导出和系统打印。
- `⌘A` 全选、`⌘C` 复制、`⌘V` 粘贴、`⌘X` 剪切、`⌘Z` 撤销、`⇧⌘Z` 重做，作用于当前输入框或编辑器。
- `⌘S` 保存、`⌘N` 新建、`⌘\` 折叠侧边栏、`⌘Q` 退出。Windows/Linux 尚未适配。

点击“登录 OneDrive”，在系统浏览器输入应用显示的 Microsoft 设备码。沿用 `cyeam-cli` 的 Microsoft 应用 ID、个人账号和权限范围。OneDrive 和 Trello 凭据统一存储于 macOS Keychain（服务 `com.cyeam.cnote`、条目 `credentials-v1`），不进入 SQLite、网页或日志。该账号必须拥有 OneDrive；实际登录、同步和跨设备冲突需要用个人 Microsoft 账号验证。

离线也能新建和编辑。SQLite 数据库默认位于 `~/Library/Application Support/com.cyeam.CNote/notes.db`（以 `directories` 返回的实际路径为准）；可通过 `CNOTE_DATA_DIR=/absolute/path` 隔离测试数据。退出登录后原账号的笔记仍在本机保留，重新登录该账号后显示，不会交给另一个账号同步。离线新建的未归属笔记会归入下次登录的账号。

## 性能与数据保护

原生外壳和虚拟化列表使用 `gpui-pre` / `gpui-pre-platform`，编辑区域使用与 herdr-gpui 相同的 `lb-wry` 系统 WebView，不打包 Chromium、Node 或 Electron。富文本编辑需要浏览器的排版与输入法能力，因而编辑区不是 GPUI 原生文本控件。所有 HTML、JS、CSS、字体均内嵌，无 CDN 或网页服务启动依赖。原生图标字体包含 GPUI macOS 加载器所需的 `m` 度量字符；重新生成字体子集后可运行 `python3 scripts/prepare-icon-font.py` 补齐（仅该维护脚本需要 fonttools，正常构建不需要）。

输入先更新内存中的编辑视图，普通切换、新建和格式操作不等待磁盘或 OneDrive。每篇笔记独立排队保存：停顿 200 ms 后保存，持续输入时最多约每秒提交一次快照；大段保存数据的 JSON 解析和 SQLite 写入均在后台线程执行，静置约两秒后同步云端。保存确认只回传小型消息，不重建整份笔记列表。

已打开的笔记保留编辑视图及布局，切换时不重新序列化/净化整篇 HTML，也不强制同步读取滚动布局；字数统计延后计算。干净的非活动视图按 LRU 保留最多 8 篇、约 16 MiB HTML 文本；未落盘或写入失败的草稿不会被淘汰，失败约三秒后自动重试。界面用递增的导航序号拒绝迟到的加载结果；尚未形成快照的输入也会阻止远端内容直接覆盖。

只有退出、账号切换、确认删除及冲突覆盖这类操作会等待相关草稿落盘，正常切换不等待。退出会检查所有笔记的待保存内容，包含当前未打开的笔记；任一写入失败都取消退出并保留内存草稿。SQLite 仍使用 WAL + `synchronous=FULL`，不以降低持久性换取交互速度。异常退出仍可能丢失尚未提交成功的输入；单篇笔记最大 20 MB、单张粘贴图片最大 8 MB。

`npm test` 包含 1,500 段长文的缓存切换基准，分别记录同步处理耗时和到下一个 `requestAnimationFrame` 的耗时；后者是进入下一帧回调的代理指标，并非操作系统实际显示像素的时间。它不包含首次打开、云端下载，也未与 Apple 备忘录做同机直接比较。

上传和删除都携带 ETag 条件，不直接覆盖其他设备修改；下载前后核对 ETag，防止内容与版本标识错配。上传完成只确认当时的修订，不会误清除更新的本地修改。本地编辑不按改动幅度拦截同步；云端版本变化时保留本地草稿，通过差异对比由用户选择处理。冲突可选择保留本地或云端，取消后可先导出 HTML；云端笔记已删除但本机仍有草稿时保留草稿并暂停同步。

首次新建上传使用 `标题--8位唯一ID.html`，保证网络响应丢失后的重试不会重复创建或覆盖同名文件；列表会隐藏这一后缀。现有网页创建的 `.html` 文件可以直接打开和继续编辑。网页完整 HTML 会净化为正文，脚本、事件处理器、内嵌页面等不执行；远程 HTTPS 图片会正常请求其来源站点。

## 使用统计

正式版复用 `cyeam-cli` 的 PostHog 项目，通过官方 `posthog-rs` SDK 上报。所有事件均带 `app=cnote`、`platform=macos`、`app_version`、`os` 和 `architecture`；仪表盘按 `app=cnote` 筛选即可与 CLI 分开。活跃用户按匿名安装 ID 统计，不等同于 Microsoft 账号数。

使用 SDK 的同步接口，`capture` 只入队，实际网络发送由 SDK 后台线程完成。批量发送、请求超时、失败重试和退出排空采用 SDK 默认策略；应用不再实现 HTTP 上报、退避或网络超时。SDK 队列最多保留 128 条事件，退出时显式调用 `shutdown()` 排空；最终上报失败只输出不含身份和令牌的通用提示。

随机安装 ID 存在应用数据目录下的 `analytics-id`，使用 `cnote:` 前缀，与 CLI 的安装 ID 独立。不上报笔记标题、正文、笔记 ID、账号、令牌或原始错误信息，不启用网页自动采集或会话回放；PostHog 接收请求时仍能看到来源 IP。

事件包括 `app_started`、`note_created`、`note_deleted`、`login_completed`、`session_restored`、`logout_completed` 和 `sync_completed`。云端事件带操作类别、结果（成功/失败/冲突/未登录）及请求耗时；查询同步成功率需过滤 `operation` 和 `outcome`，不能把所有事件都当作成功。耗时不包含云端任务排队时间。输入和本地自动保存不逐次上报。

统计仍属尽力上报，失败事件不落盘补传；队列满、长时间断网或异常退出可能漏报。SDK 会附带自身版本和系统信息，便于区分客户端实现。

设置 `CNOTE_NO_ANALYTICS=1` 或 `DO_NOT_TRACK=1` 可关闭；`CI=true`、自动化测试和原生 smoke test 也关闭。Debug 构建默认关闭，可通过 `CNOTE_ANALYTICS_DEBUG=1 cargo run --locked` 启用；Release 构建默认开启。关闭时不初始化统计客户端或读写安装 ID。项目采集 Token 可内嵌，个人查询 API Key 不放入客户端。

真实上报检查：`cargo test --locked analytics::tests::live_sdk_capture -- --ignored --exact --nocapture`。该检查默认跳过，手动运行时仅发送带 `integration_test=true` 的诊断事件，不计入正式日报；输出诊断安装 ID，便于在 PostHog 确认入库。

## 本地工具

- 文本：本地 Ace 代码编辑器，支持多光标 / Option 列选择、撤销重做、JSON / XML / SQL / AI 文本格式化、智能解码、去空行、合并换行、排序去重、正则按行过滤、字面字符删除、分隔符提取列和字符换行。JSON 格式化保留大整数原始字面值，并将字符串中的 Unicode 转义显示为实际字符（如 `\u0026` 显示为 `&`）；普通文本中的 URL 编码和 Unicode 转义也可直接点“格式化”还原。AI 文本自动识别固定缩进、清理行首空白、合并断行文字和 URL，保留表格记录与空行分段。工具栏参照 jsonpack：单编辑区直接处理，参数输入后按回车或离开输入框执行，⌘Z 可撤销。
- 智能解码位于文本工具栏，复用 cyeam_web 的 `/tool/smartdecode`：自动识别 URL、Unicode 转义、HTML 实体、Base64（含 URL-safe）、Base32 和 Hex，最多还原 20 层，展示每层结果；直接应用到编辑区，支持撤销。全部在本机运行。
- Diff：双侧编辑、实时行差异、两侧排序 / 去重 / 格式化、复制新增或删除内容，结果分页显示，不创建海量 DOM。
- 表格：导入 CSV / TSV、JSON、JSONL、Markdown、HTML、SQL INSERT、Excel；编辑单元格和表头、增删行列、数值排序、筛选保留、去重、转置、计数统计、撤销重做；导出 CSV、JSON、JSONL、Markdown、HTML、SQL、Excel，通过原生保存对话框选择文件。打印 / PDF 使用 macOS 打印窗口。

工具界面、代码编辑器、算法和依赖全部随应用打包，运行时无需 CDN 或网站。格式化、正则、Diff 和表格转换在按需启动的 Web Worker 中计算；过时的任务会取消，超时保留原始输入。笔记的编辑树在切换工具时保留。工具数据不发送给 OneDrive 或统计服务。

笔记支持把 CSV、TSV 纯文本直接粘贴为表格；已有 HTML 表格保留富文本格式。在笔记表格内粘贴表格时，从当前单元格开始填入并按需扩展行列，不创建嵌套表格，整次粘贴可撤销；目标表格包含合并单元格时改为在当前单元格插入文本，以保留原有合并布局。CSV 页的“自动”导入支持 CSV、TSV，也可从当前单元格粘贴多行多列，自动扩展并支持撤销。不解析靠空格和横线对齐的终端文本表格；笔记中作为普通文本粘贴，CSV 页自动导入遇到无法识别的文本时提示错误并保留当前表格。普通段落仍作为文字粘贴。

工具草稿单独保存在 `notes.db` 的 `settings.tool_state` 中，后台异步保存；退出、注销和更新安装均等待工具草稿与笔记落盘，保存失败保留内存草稿并暂停退出。工具数据与 Microsoft 账号无关，切换账号不会同步或清除它。

表格单元格按文本保存，以保留前导零和大整数；JSON 导出使用字符串值，数值排序和统计按需解析。Excel 导入第一张工作表，不执行公式或宏；不保留工作簿样式。单文件及工具草稿合计上限 20 MB，表格上限 20 万行、2048 列、200 万单元格；界面每次显示最多 100 行 × 24 列，可翻页；打印 / PDF 上限 5000 行。筛选会保留匹配行，可撤销。工具版不包含网站的云端 AI / 图片识别服务。

正常 Rust / GitHub Actions 打包直接使用已提交的离线资源，不依赖 `cyeam_web`。修改 `tools/core.cjs` 或依赖后运行 `npm ci && npm run build:tools` 更新 bundle；`npm run check:tools` 校验资源与源代码一致。更换 Ace 原始资源时可显式设置 `CNOTE_ACE_SOURCE=/path/to/ace` 再生成。

## GitHub Actions 与自动更新

- `ci.yml`：普通分支 push / PR 只做检查和构建，提供可下载的开发应用 ZIP，不创建 Release，也不更新自动升级源。检查格式、Clippy、Rust 测试、原生升级保护、打包元数据和 Chromium/WebKit 编辑器测试。
- `release.yml`：只有推送稳定版本标签（如 `v0.1.0`，也支持 `V0.1.0` / `0.1.0`）才发布，没有手动发布入口。编译前先检查签名密钥和版本号，再分别构建 Apple Silicon / Intel 应用；两者成功后创建 GitHub Release 并上传 ZIP、SHA-256、架构对应的签名 appcast。
- 默认分支 push（或在默认分支手动运行 CI）还会为两种架构运行 Rust 测试和 Release 构建，预热发布所需的依赖缓存；发布任务使用相同的 shared key，只恢复缓存，避免保存下个标签无法复用的缓存。首次启用时需先等默认分支预热完成，再推送版本标签。此优化增加默认分支的构建用量，不改变 Release 优化参数；应用自身仍会重新编译，依赖或 Rust 工具链变化时也可能需要重新构建依赖。
- `notify.yml`：CI / 发布流程失败或超时后，通过飞书发送原构建日志链接；发布成功发送版本下载链接。两种结果共用仓库 Secret `FEISHU_WEBHOOK_URL`，填入现有飞书群机器人的同一个 Webhook。通知流程独立于构建，按整次运行汇总，矩阵构建只通知一次；主动取消不通知。该工作流进入默认分支后生效，只执行默认分支的通知脚本。
- Sparkle 2.10.0 按 SHA-256 固定下载；更新包和 appcast 都签名并在解压前验证。每小时自动检查，可在侧栏手动检查；安装/重启等待编辑缓冲落盘。自动更新仅在打包后的 `.app` 中启用。

CNote 使用独立的 Ed25519 密钥：公钥位于 `assets/update-public-key.txt`；私钥保存在本机 Keychain 的 Sparkle 账号 `com.cyeam.cnote` 和仓库 Actions secret `SPARKLE_PRIVATE_KEY` 中。首次配置新仓库或恢复 secret 时，运行下面的脚本；脚本先核对公钥，再将原有私钥传给 GitHub，中间文件位于私有临时目录，退出时删除：

```sh
# 需要 gh 已登录且有仓库 secret 写入权限；只需执行一次
bash scripts/configure-signing.sh
```

私钥与公钥必须保持配对并跨版本保留。默认更新源是 `mnhkahn/cnote`；构建其他仓库时设置 `CNOTE_UPDATE_REPOSITORY=owner/repo`。首个带更新组件的版本需手动安装，此后跟踪 GitHub 最新正式 Release。发布包和本机打包使用同一份固定自签名证书，公钥位于 `assets/code-signing-cert.pem`，私钥不入库。固定证书使代码的 designated requirement 保持一致，但不保证登录钥匙串跨版本免授权。当前自签名包没有 TeamIdentifier，实际登录钥匙串记录的 ACL partition list 使用 `cdhash:`，程序重新编译后指纹会变化，仍可能再次要求密码；“始终允许”和统一条目也不能解决后续版本指纹变化。正式解决需要稳定的 Apple Developer ID / Team ID 签名身份及凭据授权迁移；当前构建尚未接入。这不是 Touch ID 支持，也不代替 Apple Developer ID 签名或公证。

签名私钥、加密 PKCS#12 备份、随机密码和独立钥匙串保存在本机 `~/Library/Application Support/CNote/code-signing/`（目录 700、私密文件 600）。构建时只为此证书添加代码签名信任，不添加 TLS 信任；临时加入钥匙串搜索列表后会恢复并锁定。不要删除或重建这份身份；换机器时需安全备份并恢复整个目录。首次配置 / 重传 GitHub Secrets：

```sh
# 新建证书需要 OpenSSL 3；已固定公钥时绝不自动生成替代证书。
python3 scripts/code-signing.py configure --upload
python3 scripts/test-code-signing.py
```

`configure --upload` 把加密身份和随机密码分别写入仓库 Secrets `CNOTE_SIGNING_P12` / `CNOTE_SIGNING_PASSWORD`。发布工作流导入后先对照公钥证书，再验证两个不同版本在独立测试钥匙串中的访问与签名一致性（不覆盖真实登录钥匙串的 partition ACL，不能据此保证升级免弹窗）；构建结束删除临时钥匙串和构建机信任。缺失或不匹配时中止发布，不能退回 ad-hoc 签名。Sparkle 原有更新签名密钥保持独立。

普通 PR/分支 CI 不接触私钥，通过 `CNOTE_ALLOW_ADHOC=1 sh scripts/package.sh debug` 显式生成临时签名开发包；开发包不保证跨版本保留钥匙串授权，不能作为正式升级包，release 打包禁止这个选项。

打包时版本号统一取自 tag：Actions 使用触发发布的 tag；本地省略版本时使用当前提交可达的最高稳定版本 tag。没有 tag 时须显式指定，例如 `sh scripts/package.sh debug v0.0.2`。安装包、Sparkle 比较版本、统计和请求 User-Agent 均使用此版本，不再将 Cargo 的 crate 版本当作应用打包版本。CI 会完整拉取 tag。可设置 `CNOTE_BUNDLE_PATH=dist/preview/CNote.app` 将包生成到另一个目录。

早期本机开发包曾误标为 0.1.0，而线上发布从 0.0.x 开始；Sparkle 会按正常版本顺序阻止安装这些较低版本。使用修正版本号的本地构建替换一次后，后续 0.0.x 的递增更新即可正常检查和安装。

## 从网页打开

安装应用后，网页可用以下链接启动 CNote，或激活已运行的窗口并切换工作区：

| 入口 | URL | 快捷键 |
| --- | --- | --- |
| 笔记 | `cnote://open` | ⌘1 |
| 文本处理 | `cnote://tool/text` | ⌘2 |
| 文本对比 | `cnote://tool/diff` | ⌘3 |
| CSV 表格 | `cnote://tool/csv` | ⌘4 |
| Trello 日历 | `cnote://tool/trello` | ⌘5 |

```html
<a href="cnote://open">打开笔记</a>
<a href="cnote://tool/text">打开文本处理</a>
<a href="cnote://tool/diff">打开文本对比</a>
<a href="cnote://tool/csv">打开 CSV 表格</a>
```

浏览器可能会询问是否打开 CNote。链接只切换工作区，不接受内容、笔记操作或其他参数。需要重新打包并安装包含 URL Scheme 注册信息的 `.app`；直接运行 `cargo run` 不会向系统注册链接。安装后可用 `open 'cnote://tool/text'` 验证。

## 验证

编辑器测试保留缓存切换处理 p95 < 16ms 的要求；下一帧测试交错测量空闲帧，以实测空闲帧 p95 的两倍（最低 35ms）为上限，记录两组延迟，避免把共享 CI runner 的整体调度延迟算作编辑器回退。

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
sh scripts/test-updater.sh
sh scripts/test-shortcuts.sh
CNOTE_NATIVE_UI_TESTS=1 sh scripts/test-shortcuts.sh # 真实菜单悬停预览、WKWebView 编辑快捷键、方向键和 Shift 选择（需要图形会话）
python3 -m unittest discover -s tests -p 'test_*.py'
npm ci
npm run check:tools
npx playwright install chromium webkit
npm test
cargo build --locked
python3 scripts/smoke-test.py   # 真实 GPUI + WKWebView + SQLite，独立临时数据
```

`workspace-native-tests` 的 UI 等待会记录步骤名、条件、调用行号和窗口焦点状态。超时、检查失败、JavaScript 错误和 Objective-C 异常均输出错误并正常退出 1，不使用断言触发 SIGABRT；失焦立即报错，不自动反复激活窗口。`scripts/test-shortcuts.sh` 编译后会自动验证无界面失败出口；单独验证可运行 `python3 scripts/test-native-failures.py target/workspace-native-tests`。测试程序的 `--no-ui` 参数会覆盖环境中的 UI 开关，不创建测试窗口。

编辑器测试不连接 Microsoft、不访问真实笔记，验证内容净化、无需等待保存的切换、后台失败重试、所有草稿的退出保护、复选框、表格操作、登录窗口、新建和长文档交互性能。Rust 测试校验内嵌字体的度量字符和原生界面图标轮廓；原生 smoke test 还会实际验证 GPUI 字体选择未回退、图标字形可解析。原生升级测试复用并适配 alloy 的隔离测试；它不加载 Sparkle、不进行更新联网。完整 GPUI/WebKit smoke test 在本机运行，向 Cocoa 队列投递真实 ⌘1–⌘4 事件，在 WKWebView 中运行本地工具并检查草稿持久化；若 CI runner 支持 WindowServer/Metal，可设置仓库变量 `CNOTE_NATIVE_UI_TESTS=true` 启用。

### Trello 日历

`⌘5` 打开 Trello 周历，默认显示本周（周一开始）并选中今天。选择日期后按本机时区的卡片 `due` 过滤，以表格展示标题、进度、描述中的“打分结果”、实际完成时间和预计完成时间，待完成、待改错排在已完成、已改错之前；同一进度内先按 Trello 的 `dateCompleted` 实际完成时间升序，再按 `due` 预计完成时间升序排列，无实际完成时间的放在该进度最后并按预计完成时间排序，缺失时间显示“—”，时间按本机时区展示；未评分显示“—”；双击“进度”或“打分结果”单元格（也可聚焦后按 Enter / F2）会立即展开下拉菜单，点击选项后保存到 Trello，并显示正在保存、已保存或保存失败；Esc、点击外部或失焦取消未提交的选择；进度使用当前看板列表，评分支持未评分、100、优、良、中、差，保留其他描述内容。旧的只读 Token 需要在关联设置重新授权读写权限。没有截止日期和已归档卡片不显示。可切换周、回到今天、刷新及切换看板；Trello 工作区按 `⌘R` 刷新当前看板，其他工作区保留原刷新行为。Trello 页面可见时每 60 秒自动刷新当前看板，切换工作区或页面隐藏后暂停；返回时若已超过 60 秒会补刷新。查看卡片详情、放大图片或关联设置时暂缓自动刷新，自动刷新保留原表格直至请求完成，失败保留已有数据并等待下次重试，选择的看板保存在本机。点击卡片查看完整描述、截止时间、完成标记、按上传时间倒序排列的附件内容（图片默认紧凑平铺，仅展示缩略图、名称和上传时间，按上传时间倒序排列，点击图片在 CNote 内加载原图，支持缩放、拖动和双向旋转；图片查看器使用图标工具栏，`+` / `-` 缩放，`0` 适应窗口，`1` 原始大小，`R` 顺时针 / `Shift+R` 逆时针旋转，方向键平移（Shift 加速），`Esc` 关闭图片；音频、视频、PDF 和文本预览）、默认折叠的评论与活动（展开后每条一行，最多最近 1000 条）、成员和清单，并可打开 Trello 原卡片。

图片放大查看器的工具栏提供「识别图片文字」图标，使用与 cyeam-cli 相同的 macOS Apple Vision 桥接识别原图中的中英文，结果显示在图片右侧，可选中复制，失败可重试；Trello 详情缩略图不提供识别按钮。识别在本机进行，无需配置密钥；单张图片上限 20 MB，超时 30 秒，不使用口算验算或篆书识别，不把结果写回 Trello。

音频附件的下载按钮前提供「ASR」转文本按钮，点击后将原始音频发送到 cyeam 语音识别服务，结果显示在播放器下方，可选中复制；转写中防止重复点击，失败后可重试。单个音频上限 15 MB，需要联网，转写文本仅在当前详情中展示。

CNote 内置 Trello REST API 客户端，无需安装其他程序。未关联时，在页面输入 API Key，点击打开 Trello 读写授权页面，再把浏览器显示的 Token 粘贴回 CNote；验证成功后与 OneDrive 共用 CNote 的 `credentials-v1` 系统钥匙串条目，读取后在进程内共享缓存。授权使用 `expiration=never`，重启时自动恢复，一次进程内复用凭据。临时断网、限流或服务错误只提示重试，保留关联；只有明确的 401 授权失效才自动展示重新授权表单。关联设置默认显示连接状态，不要求重复输入 Token。可通过“关联设置”重新关联或移除本机凭据；移除本机凭据不撤销 Trello 端 Token，可在 Trello 账号设置中撤销。Token 不存入笔记数据库、工具草稿或日志，网络错误不回传请求地址或响应正文。Trello 页面需要网络。

发布时可通过 `CNOTE_TRELLO_API_KEY` 构建环境变量预置 CNote 的公开应用 API Key，用户只需打开授权并粘贴 Token；未配置时页面提供 API Key 输入与获取入口。不内置用户 Token。

### 统一钥匙串凭据迁移

旧版分别使用 `onedrive-oauth` 和 `trello-auth` 条目，分别读取会触发两项独立的 macOS 访问授权。新版将两项凭据按服务分别保存到同一个 `credentials-v1` 条目，启动读取后供两个功能共用；进入 Trello 不再为已迁移的账号额外读取旧条目。钥匙串版本和访问失败不会静默覆盖原记录，进程间文件锁只保存锁状态，不保存任何凭据。同一次运行中，刷新 OneDrive 令牌和进入 Trello 共用已读取的凭据缓存；保存令牌直接更新条目，不再先读取旧密码。锁文件中的随机代号用于让其他新版 CNote 进程更新缓存，不包含凭据。旧条目首次迁移仍可能分别要求授权；此优化不保证自签名应用升级后完全免弹窗。

首次迁移仍可能需要授权读取旧条目，macOS 的访问控制无法由应用绕过。迁移成功后保留旧记录以便恢复；单独退出 OneDrive 或断开 Trello 时删除该服务的旧记录并持久化退出标记，不影响另一服务，也不会再次从旧条目恢复已退出的账号。统一条目只减少分别访问多个条目的授权，不消除自签名应用的 `cdhash` 版本变化；即使固定自签名证书相同，升级后仍可能要求密码。

文本文件可通过 Finder 的“打开方式 → CNote”或命令行 `cnote 文件路径` 打开，包括 Markdown、TXT、JSON 和代码等文本内容。打开后自动进入“文本”页，支持 UTF-8 和带 BOM 的 UTF-16，单文件上限 8 MB。编辑结果保存为本机工具草稿，不会自动写回原文件；打开前的文本可用撤销恢复。文件关联在重新打包安装后生效。

包含文本文件打开功能的版本首次启动时，会询问是否将 CNote 设为常见文本格式的默认打开程序。只有选择“设为默认”才会向 macOS 发起设置请求；选择“暂不设置”后不再自动提示，后续升级也不会重复询问。网页文件的默认程序不变。

## 笔记页 Web / WASM 导出

独立构建和 GitHub Actions 导出说明见 [web/README.md](web/README.md)。只包含笔记工作区，不改变桌面应用和其他工具页。
