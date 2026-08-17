# Heddle Dashboard Repo Skill Pack

Instructions for working inside the `heddle-dashboard` repository (`/Users/mayatobi/Developer/heddle-dashboard`).

## Exact Gate Invocations
- **Web Build**: `pnpm build` (`tsc && vite build`) (`package.json`, `.github/workflows/gate.yml`)
- **Web Test**: `pnpm test` (`vitest run`) (`package.json`, `.github/workflows/gate.yml`)
- **Web Dependency Install**: `pnpm install --frozen-lockfile` (`.github/workflows/gate.yml`)
- **Rust Check (Default/GUI)**: `cargo check --manifest-path src-tauri/Cargo.toml --locked` (`.github/workflows/gate.yml`)
- **Rust Check (Minimal Server)**: `cargo check --manifest-path src-tauri/Cargo.toml --locked --no-default-features` (`.github/workflows/gate.yml`)
- **Rust Test**: `cargo test --manifest-path src-tauri/Cargo.toml --locked` (`.github/workflows/gate.yml`)

## Linting & Quality Expectations
- **ESLint Status**: `pnpm lint` (`eslint .`) is non-required in CI gate aggregation and red until HED-14 due to inherited errors in `src/remote/ConnectionBanner.tsx`. Report lint failures; do NOT chase or attempt to fix them unless assigned. (`package.json`, `.github/workflows/gate.yml`, `docs/CI.md`, `docs/REVIEW-SWEEP.md`)

## Test & Behavioral Conventions
- **Behavioral Testing Bar**: Assert observable effects (state, persisted result, downstream behavior), never toggle switches alone. (`.github/workflows/gate.yml`, `docs/CI.md`, `docs/REVIEW-SWEEP.md`, `README.md`)
- **Ignored Rust Tests**: 8 Rust tests are ignored by design in CI because they require real `~/.claude` or SSH state. (`.github/workflows/gate.yml`)
- **i18n Requirement**: All user-facing strings are English and must go through `src/i18n/`. Missing keys fail typecheck. All code comments must be in English. (`README.md`)
- **Async IPC Rules**: Any command touching network or filesystem in Tauri backend/frontend MUST be asynchronous; synchronous commands freeze the main UI loop. (`README.md`)
