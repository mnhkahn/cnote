# CNote 笔记 Web / WASM

只导出笔记工作区，不包含文本工具、Diff 工具页、CSV、Trello、Ace、桌面更新器或 macOS 凭据。
富文本编辑器、样式、配色、表格粘贴和标题提取复用仓库源码；浏览器笔记状态、修订确认和冲突校验由 `web/core` 编译为真正的 WASM，浏览器存储/登录/网络由 JS 适配。
这不是把 GPUI 应用整体编译到浏览器，也尚未将桌面 `engine.rs` 改造成两端共用的同步引擎。桌面实现不变。

## 构建

在仓库根目录运行（Rust 1.96+，Node 22+）：

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm ci
npm run build:web
npm run test:web
```

输出 `dist/cnote-web/`，包含 `index.html`、编辑器资源、适配脚本、`pkg/*.wasm`、Microsoft 登录回调页、配置、版本与校验文件。GitHub Actions 的 **Export notes WebAssembly** 工作流自动构建和测试并上传压缩包；支持分支、PR、tag 与手动触发，不部署网站、不修改其他仓库，不需要发布/部署密钥。

## 托管与登录

把输出目录原样放到 HTTP(S) 静态目录，例如 `/note/`；只允许 HTTPS 或 localhost，不支持双击 `file://`。`.wasm` 应使用 `application/wasm` MIME。可本地运行 `python3 -m http.server 8080 --directory dist/cnote-web`。
相对路径允许部署到任意子目录，页面入口需以 `/` 结尾或显式使用 `index.html`。

配置 `config.json` 的公开 `clientId`（可用构建变量 `CNOTE_WEB_CLIENT_ID` 覆盖）；在该 Microsoft 应用注册中添加实际 `https://域名/目录/auth.html` 为 **SPA redirect URI**，权限为个人账号 `Files.ReadWrite`、`User.Read`。客户端不需要也不接受 client secret。默认公开 client ID 沿用已有网页，但新回调地址需要在 Microsoft 应用中登记，不能仅靠构建完成登录配置。
MSAL v5 使用独立回调桥接页，参考 https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge 。不要把笔记主页面代码放入回调页。

登录凭据由 MSAL 放入 sessionStorage，与 IndexedDB 的笔记正文分开。退出登录保留原账号的本地笔记；离线创建且未归属的笔记在下一次登录时归入该账号。每个浏览器 origin 使用一个 IndexedDB 数据库；Web Locks 限制同一 origin 同时只能有一个可编辑标签页，防止全量快照相互覆盖。浏览器隐私模式、存储配额和清理网站数据均会影响本地持久性，请使用 HTML 导出保留副本。

## 浏览器适配边界

- 编辑中的笔记先写 IndexedDB，事务成功后才确认保存；失败保留编辑器草稿并重试。关闭页面时若尚未确认保存会触发浏览器提示，但浏览器强制退出仍可能丢失尚未持久化的输入。
- OneDrive 保留 `Notes/*.html` 格式；分页读取、条件上传/删除、修订确认、冲突保留与合并。新建使用唯一文件名；云端删除后本地草稿保留。实际 Microsoft 登录与跨设备同步需要使用真实账号验证，自动化测试只使用模拟 Graph 响应。
- 粘贴链接标题：浏览器受目标网站 CORS 限制。允许 CORS 的网页可直接获取；失败保留网址。可选 `metadataEndpoint` 只接受同源 URL，服务契约为 `GET ?url=...` 返回 `{"title":"..."}`；宿主后端需自行实现有限时、限大小和目标地址校验的取标题服务。本产物没有第三方代理，也不包含该后端。
- 图片复制受 Clipboard API、用户授权和图片 CORS 限制，失败保留原图。打印与 HTML 下载使用浏览器功能。
- 不含 Service Worker；已打开的页面可以离线编辑，离线冷启动缓存不是本次范围。导出产物不会自动更新现有 `cyeam_web`，接入与部署应另行完成。
