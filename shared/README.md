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

`.github/workflows/shared.yml` 测试核心和页面并上传通用包。推送 `shared-vX.Y.Z` 标签才创建独立共享 Release，使用 `--latest=false`，不改变桌面应用的最新 Release。本仓库不再生成 SO 或 AAR：这些都由平台项目根据自己的目标架构构建。

## Android 消费

`cnote-android/shared-sdk.lock.json` 固定本仓库的共享 Release。安卓 CI 下载并校验源码与页面，在安卓仓库中使用 NDK 编译 SO、JNI，并生成 AAR 和 APK。更新这个固定版本即可获取新的共享业务与页面。

本地联调在 `cnote-android` 执行：

```sh
python3 scripts/prepare-sdk.py --local ../cnote
./gradlew testDebugUnitTest lintDebug assembleDebug
```

JNI、Keystore、旧安卓数据库迁移、Android TLS、WebView、后台任务、系统分享和 AAR 构建的说明见安卓仓库 README。初始锁定的 `shared-v0.1.0` 尚需实际发布后，远端 CI 才能下载；本地联调可以直接使用当前工作区。

共享数据库由 Rust SQLite 独占，宿主通过命令/事件读写，不用其他 SQLite 实现同时打开同一数据库。Mac 的 GPUI、AppKit、钥匙串、Finder、主题和全部工具继续保留；现有 Web/WASM 构建也保持独立。
