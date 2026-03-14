# Repo Layout Draft

## Top level

- `package.json` — scripts and dependencies
- `tsconfig.json` — TypeScript build config
- `.env.example` — runtime config template
- `src/` — implementation
- `docs/` — architecture and design notes

## `src/`

- `config/` — env parsing and app config
- `types/` — shared domain types
- `core/` — routing, session policy, application flow
- `adapters/feishu/` — Feishu transport adapter
- `adapters/codex/` — Codex runtime adapter
- `store/` — minimal binding store

## Design intent

The repo layout should keep transport, runtime, and state concerns clearly separated. The bridge should stay thin and avoid accumulating a second assistant platform inside `core/`.
