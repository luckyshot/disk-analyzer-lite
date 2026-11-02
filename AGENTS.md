# AGENTS.md

Guidance for AI coding agents working on Disk Analyzer Lite.

## Project

A Tauri 2 desktop app (macOS and Linux): a Rust backend in `src/` and a framework-free HTML/CSS/JS frontend in `ui/`, served as-is (no bundler, no npm dependencies). See README.md → "How it works" for the architecture.

## Commands

```bash
cargo test                                   # Rust unit tests (scanner, fsops)
npm test                                     # UI logic tests (node:test, no install needed)
cargo fmt && cargo clippy --all-targets -- -D warnings
cargo run -- <folder>                        # run the app in development
cargo tauri build --bundles app              # build the macOS .app (needs tauri-cli)
```

All of these must pass before you consider a change done; CI runs them on macOS and Ubuntu.

## Conventions

- Keep pure logic out of the DOM: tree and layout helpers go in `ui/treemap.js` with tests in `tests/ui/`. `ui/app.js` is for rendering and events.
- Scanner logic goes in `src/scanner.rs`, filesystem side effects in `src/fsops.rs`, and Tauri command wrappers in `src/main.rs`. New logic gets unit tests next to it.
- The JSON sent to the UI uses short keys (`n`, `s`, `f`, `c`, `g`) to stay small. Update both sides and the tests if you change it.
- `scanner::ext_of` and `extOf` in `treemap.js` must keep identical rules.
- No background polling or timers: the app must be idle when the user isn't interacting with it.
- Anything destructive goes through the Trash, never permanent deletion, and stays behind `fsops::check_trashable`.
- Keep the dependency footprint small. Don't add a JS framework or bundler.
- Everything must work on macOS and Linux. Use `#[cfg(target_os = ...)]` for platform code, `IS_MAC` in the UI for platform wording, and don't rely on fonts or tools that minimal Linux installs lack (emoji fonts, GNOME-only helpers).
- macOS bundle settings live in `tauri.conf.json`, `Info.plist` (merged into the app) and `Entitlements.plist`.
- Match the existing style: `max_width = 120` for Rust, and compact JS with 2-space indentation.
