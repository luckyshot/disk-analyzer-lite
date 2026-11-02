# Contributing to Disk Analyzer Lite

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and requesting features

Open an issue using one of the templates. For bugs, include your OS and version, the app version, and steps to reproduce. A screenshot helps a lot.

## Development setup

1. Install [Rust](https://rustup.rs) (stable) and Node.js 20+ (only used to run the UI tests).
2. On Linux, install the WebKitGTK dev packages listed in the README.
3. Optional, for building installers: `cargo install tauri-cli --version "^2" --locked`.

```bash
cargo run -- ~/Downloads    # start the app, scanning a folder
cargo test                  # Rust tests
npm test                    # UI logic tests
```

The frontend in `ui/` is plain HTML/CSS/JS loaded directly by Tauri, so there's nothing to install or bundle. Rebuild with `cargo run` to see changes.

## Pull requests

- Keep each PR focused on one change, and describe what it does and why.
- Add or update tests for logic changes: Rust tests sit next to the code, UI logic tests are in `tests/ui/`.
- Make sure these pass:
  ```bash
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo test
  npm test
  ```
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- For UI changes, attach a before/after screenshot.

## Design principles

- **Fast and idle.** No background work unless the user asked for it.
- **Safe.** Anything destructive goes to the Trash and asks for confirmation first.
- **Small.** Prefer the platform and the standard library over new dependencies.

## Releasing (maintainers)

1. Update the version in `Cargo.toml` and `tauri.conf.json`, run `cargo check` so `Cargo.lock` picks it up, and move the "Unreleased" notes into a new section in `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow runs the tests and builds a universal macOS `.dmg`, plus Linux `.AppImage` and `.deb` packages for x86_64 and arm64. It attaches them and a `SHA256SUMS.txt` file to a **draft** GitHub release.
4. Review the draft, edit the notes if needed, and publish.

To try the release build without publishing anything, run the Release workflow manually from the Actions tab. The installers are kept as workflow artifacts.

The macOS build is unsigned by default. To sign and notarize it, add the Apple secrets described in `.github/workflows/release.yml`.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
