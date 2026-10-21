# Third-party notices

- Application icon: `assets/note.png`, copied from `mnhkahn/cyeam_web/static/assets/note.png`.
- Bootstrap Icons v1.13.1: Copyright 2019–2024 The Bootstrap Authors, MIT. The subset stylesheet and WOFF2 are copied from cyeam_web; `assets/bootstrap-icons.ttf` is the same subset converted from WOFF for GPUI, with an additional `m` metrics glyph required by the macOS loader. Original icon outlines and codepoints are unchanged. `scripts/prepare-icon-font.py` reproduces the addition after regenerating the subset. The MIT license is reproduced in `assets/Bootstrap-Icons-LICENSE.txt`.
- GPUI: Zed Industries, Apache-2.0. Distributed through the pinned `gpui-pre` and `gpui-pre-platform` crates.
- Wry (`lb-wry`): Tauri Programme within The Commons Conservancy, Apache-2.0 OR MIT.
- Sparkle 2.10.0: Sparkle Project, BSD-style license; `scripts/prepare-sparkle.sh` downloads the pinned SDK. Its LICENSE is copied into every application bundle.
- Sparkle main-thread adapter, packaging helpers, release workflow and updater tests adapted from the user's `mnhkahn/alloy` project. CNote uses its own bundle identity and Ed25519 signing key.
- OneDrive account registration, folder conventions and editor behaviors reference `mnhkahn/cyeam_web` and `mnhkahn/cyeam-cli`.

- Offline code editors reuse Ace 1.32.6 from cyeam_web (BSD-3-Clause). Local background processing bundles jsdiff, fflate, fast-xml-parser, sql-formatter and xml-formatter; exact versions are locked in package-lock.json. Complete bundled notices are in `tools/vendor/LICENSES.txt`, copied into every application bundle.

Other Rust dependency licenses are recorded in each package's Cargo metadata.
