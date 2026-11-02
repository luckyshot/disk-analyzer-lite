# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-02

### Added
- Parallel disk scanner that measures real on-disk usage, counts hardlinks once, never follows symlinks and stays on one filesystem.
- Interactive squarified treemap with shaded tiles and depth-shaded folder borders.
- Folder tree and per-file-type list, synced with the map. Clicking a file type highlights its files.
- Multi-selection (⌘/Ctrl-click, Shift-click ranges in the tree).
- Right-click menu: copy absolute path(s), reveal in Finder / file manager, move to Trash.
- Safe move to Trash with confirmation and guards against trashing `/` or the home folder.
- Disk usage gauge with space freed since the scan and space still in the Trash.
- Toggleable side panels, light and dark themes.
- App menu with an About panel crediting the author.
- Linux: Reveal selects the item in the file manager (FileManager1 D-Bus, falling back to `xdg-open`), a workaround for blank windows on NVIDIA/Wayland, and a folder icon that doesn't need an emoji font.
- macOS: explains why the app asks to control Finder (Trash with Put Back), and an entitlements file ready for notarized builds.
- Installers for macOS (universal) and Linux (x86_64 and arm64, AppImage and .deb), with SHA-256 checksums.
