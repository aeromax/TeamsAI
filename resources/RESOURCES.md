# resources/

This directory holds bundled binaries and assets that are included in the
final app via `electron-builder.yml` `extraResources`.

## Required before packaging

### `BlackHole2ch.pkg`
Download from: https://existential.audio/blackhole/
Place at: `resources/BlackHole2ch.pkg`

### `bin/ollama`
Download the macOS universal binary from: https://ollama.com/download
Place the CLI binary at: `resources/bin/ollama`
Make executable: `chmod +x resources/bin/ollama`

If missing, setup will attempt to download and install the Ollama CLI automatically
to the app `userData/bin/ollama` directory.
Bundling is still recommended for offline/restricted-network installs.

### `bin/setup-audio`
Compile from the Swift source:
```bash
swiftc swift/setup-audio/main.swift -o resources/bin/setup-audio
chmod +x resources/bin/setup-audio
```

### `icon.icns`
App icon in macOS .icns format.
Place at: `resources/icon.icns`

## Development

During `npm run dev`, Electron falls back gracefully if binaries are missing —
the setup wizard will show errors for missing resources rather than crashing.
