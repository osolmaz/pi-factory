# AGENTS.md

These instructions apply to this repository.

## Quality Gates

- Run `npm run check` before finishing changes.
- Mutation tests are optional and stay out of the default gate and CI. Run `npm run mutate` when
  mutation coverage is relevant; the weekly `mutation` workflow runs them as well.
- Keep `slophammer.yml` and `.github/workflows/ci.yml` aligned with Slophammer's TypeScript standards.
- If applying or updating Slophammer standards, start with `/home/bob/repos/slophammer/docs/AGENT_ENTRYPOINT.md`.

## TypeScript

- Keep `strict: true` and the existing strict compiler options enabled.
- Do not use explicit `any`.
- Validate unknown external input at the boundary before converting it to typed data.
- Keep filesystem, process, network, and child-process code at the outer edges of the implementation.

## Architecture

- pi-factory owns app bundle parsing, validation, config generation, app install/link state, and native Pi launch preparation.
- Pi owns the runtime, TUI, sessions, model selector, command system, and extension SDK.
- App-specific projects own their prompts, extensions, providers, model discovery, and local model server lifecycle.
- Keep shared domain types in `src/types.ts`; avoid importing CLI modules from library modules.

## Testing

- Add or update nearby Vitest tests for behavior changes.
- Tests must use fake Pi commands and temporary directories.
- Do not start real model servers or load models while testing this repository.
