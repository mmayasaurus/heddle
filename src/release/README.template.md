# Heddle

Heddle is a cross-provider orchestration layer for subscription coding CLIs. It routes bounded work
to configured provider CLIs and keeps execution policy explicit. It is a command-line tool for
coordinating work, not a hosted service.

## Install

```sh
git clone … && npm ci && npm run build
node dist/cli.js doctor
```

## Providers

See [the provider matrix](docs/PROVIDER-MATRIX.md) for supported providers and their setup.

## Documentation

- [Specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Orchestration](docs/ORCHESTRATION.md)
- [Provider matrix](docs/PROVIDER-MATRIX.md)

## Provenance

This snapshot was generated from the heddle source repository by `heddle release --standalone`; the
dashboard is a separate product and is not included. Version {{version}}; source commit {{sourceCommit}}.
