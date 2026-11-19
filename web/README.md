# CNote WASM 核心

这个目录维护浏览器可调用的 Rust 笔记核心。WASM 暴露 `Notebook` 的快照、视图和命令接口，处理笔记状态、修订和冲突。浏览器登录、凭据缓存、IndexedDB、网络以及最终页面构建由 [cyeam_web](https://github.com/mnhkahn/cyeam_web/tree/master/frontend/cnote) 维护。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm run build:web
```

输出 `dist/cnote-web/`，包含 `pkg/` 下的 WASM 与生成绑定、`shared/` 下的可复用编辑器和工具资源，以及版本、许可证和校验文件。该目录是构建输入，可复制到 Web 宿主后组装页面。正式 CNote tag 仍发布同名 `cnote-web.tar.gz` 和校验文件，包的 `version.json` 用 `cnote-wasm-core-v1` 标识新格式。Web 宿主自行构建和部署，不需要为独立的浏览器改动重新发布 Rust 核心。
