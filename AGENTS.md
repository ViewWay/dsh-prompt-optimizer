# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this repository is

`dsh-prompt-optimizer` is a standalone distribution of the DeepSeek Harness (dsh) "prompt optimizer" plugin family, packaged as four publishable npm packages in a pnpm workspace:

1. `packages/prompt-optimizer` — host service
2. `packages/api-prompt-optimizer` — remote controller + Typert descriptors
3. `packages/client-ui-prompt-optimizer` — browser UI (React)
4. `packages/bundle` — profile bundle stacking the three above

## Environment setup

- Node 24, pnpm (pinned by the root `packageManager` field).
- Run `pnpm install` once at the root.
- The **client** test project resolves the dsh harness sources through a deepseek-harness checkout. By default it uses the sibling directory `../deepseek-harness-latest`; override with `DSH_HARNESS_ROOT=/path/to/deepseek-harness`. That checkout must have had `pnpm install` run inside it. Before doing any work touching harness integration, read the relevant harness sources — do not guess the plugin APIs.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run check` | lint + typecheck + build + test — the full local gate, same as CI |
| `pnpm run lint` | oxlint over the repository |
| `pnpm run typecheck` | `tsc -b` over the three buildable packages |
| `pnpm run build` | tsdown builds all packages in dependency order |
| `pnpm run test` | vitest once at the root (node + client projects) |

Run tests scoped while iterating: `pnpm exec vitest run --project node` or `--project client`.

## Conventions

- **Minimal diffs.** Change only what the task requires; do not reformat or restructure unrelated code.
- **Comments are the exception.** Write one only for a constraint the code cannot express; never narrate what the next line does.
- Keep single files under 1000 lines; split when they grow past that.
- **i18n.** User-visible UI strings live in `packages/client-ui-prompt-optimizer/locale/{en,zh}.json`. Any UI change updates both locales in the same change; do not hardcode strings in components.
- **Compatibility is contractual.** `docs/compatibility.md` is the single source of truth for supported harness baselines and pinned peer dependencies. Bump a baseline only together with that file.
- **Pinned dependencies.** `zod` stays at `4.4.3` (required by lib/types interop — do not upgrade); harness peer dependencies stay at the documented baseline.
- Generated code lives under `packages/api-prompt-optimizer/src/generated/` — do not hand-edit; it is also excluded from lint.

## Before you finish

1. Re-read your diff; remove temporary files and stray experiments (`.tmp/` is gitignored scratch space).
2. Run `pnpm run check` and make it pass.
3. Prefer one commit per task with a concise subject; do not mix unrelated changes.

## Release

Keep all four packages on one version. Publish by tagging `vX.Y.Z`; `.github/workflows/release.yml` builds, checks, verifies the tag matches every package version, and publishes all packages to npm in dependency order (host → api → client → bundle).
