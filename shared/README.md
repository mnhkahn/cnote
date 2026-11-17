# CNote 通用核心与页面

本仓库只维护可复用的 Rust 业务核心和页面，不包含 JNI、Kotlin、Android Gradle、NDK 或 AAR 打包实现。Android 专属代码统一放在 `cnote-android`。

`shared/core` 是独立 Rust 库，复用 `src/` 中的笔记引擎、SQLite、OneDrive、Trello、作业批改及链接标题模块。`cnote_shared_core` 仅由该库的 build.rs 设置，用于无桌面 UI 的宿主模式；Mac 入口不启用它。通用宿主接口包括 JSON 命令/事件、安全凭据 Vault、下载目录和 HTTP 客户端工厂，没有 Android API 依赖。

`shared/pages` 是移动布局与通用 `cnoteHost.postMessage` 消息桥。`scripts/build-shared-pages.cjs` 从现有编辑器、Trello 和 OneDrive 源码生成 `index.html`、仅包含功能页的 `features.html`、页面摘要和许可证。具体宿主提供消息桥；Android 的笔记界面仍由安卓仓库维护。

## 构建

只需 Rust 1.96+、Node 22+，不需要 JDK、Android SDK 或 NDK。

```sh
cargo test --manifest-path shared/core/Cargo.toml --locked
npm ci
npx playwright install chromium webkit
npm run test:shared-pages
python3 scripts/build-shared-source.py --version development
```

输出 `dist/shared/cnote-shared.tar.gz`、`shared.json` 和 SHA-256 文件。压缩包包含通用核心所需源码、资源和已生成页面。元信息记录协议、版本、源提交、未提交状态、源码摘要和包摘要；构建期间源码变化会拒绝产出。

`.github/workflows/shared.yml` 测试核心和页面并上传通用包。推送 CNote 原有版本标签（如 `v0.3.0`）时，`release.yml` 调用该工作流构建共享包，与 Mac 和 Web 产物一起上传到同一个 CNote Release；没有独立共享标签或独立 Release。普通分支和手动运行只生成 artifact，不发布。本仓库不再生成 SO 或 AAR：这些都由平台项目根据自己的目标架构构建。

## Android 消费

`cnote-android/shared-sdk.json` 只配置仓库和兼容要求，不固定版本。安卓每次构建解析本仓库的最新正式 Release，并固定本次解析到的 tag 下载源码与页面，校验后使用 NDK 编译 SO、JNI，生成 AAR 和 APK。发布新的 CNote 版本后，安卓下次构建会自动使用新的共享业务与页面。

本地联调在 `cnote-android` 执行：

```sh
python3 scripts/prepare-sdk.py --local ../cnote
./gradlew testDebugUnitTest lintDebug assembleDebug
```

JNI、Keystore、旧安卓数据库迁移、Android TLS、WebView、后台任务、系统分享和 AAR 构建的说明见安卓仓库 README。已有旧版本（如 `v0.3.0`）需要补上传共享包；采用统一发布流程后的版本会自动包含共享包。安卓只使用最新正式 Release，记录实际版本与提交，不会混用多个版本的文件。本地联调可以直接使用当前工作区。

共享数据库由 Rust SQLite 独占，宿主通过命令/事件读写，不用其他 SQLite 实现同时打开同一数据库。Mac 的 GPUI、AppKit、钥匙串、Finder、主题和全部工具继续保留；现有 Web/WASM 构建也保持独立。
