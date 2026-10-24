# dsh-prompt-optimizer

[![CI](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml)

A standalone, independently distributed plugin family for the DeepSeek Harness that turns a rough idea draft into a polished, agent-ready prompt through iterative **rewrite → self-review → fix** rounds.

[English](README.md) | [简体中文](README_zh.md)

## Features

- One-click **Optimize** button on the input box plus domain recommendation chips; multi-round optimization with retry and per-round diff preview
- **Role library** (`<slug>.md` files): a 164-role catalog ships inside the package and is used whenever `rolesDir` is unset; list roles on demand, recommend by draft, re-run with an explicit role; set a default role in the settings page
- **Skill awareness** (`skillAware`): when a draft matches an installed skill, its name and description are folded into the meta-prompt so the output references those skills — guarded by exact-name constraints against hallucination
- **Output language follows the agent UI language**: a Chinese interface yields Chinese prompts, English yields English, while code identifiers, paths and commands stay verbatim
- Inline **Optimize** entry on queued (unsent) conversation items
- **Acceptance criteria**: mechanical criteria ship with an executable check-command template

## Repository layout

| Package | npm | Purpose |
| --- | --- | --- |
| `packages/prompt-optimizer` | [@yimiliya/dsh-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-prompt-optimizer) | Host service: optimization rounds, role library, skill hints, model routing |
| `packages/api-prompt-optimizer` | [@yimiliya/dsh-api-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-api-prompt-optimizer) | Remote controller and Typert descriptors (host/client shared method table) |
| `packages/client-ui-prompt-optimizer` | [@yimiliya/dsh-client-ui-prompt-optimizer](https://www.npmjs.com/package/@yimiliya/dsh-client-ui-prompt-optimizer) | Browser UI: trigger button, preview panel, queue entries, settings page |
| `packages/bundle` | [@yimiliya/dsh-prompt-optimizer-bundle](https://www.npmjs.com/package/@yimiliya/dsh-prompt-optimizer-bundle) | Profile bundle (`cordis.patch.yml`) that installs all three plugins in one shot |

Each package carries its own README, which npm renders on the package page; this document is the family-level view. `tools/tsdown.client.ts` is the standalone client build preset: it emits browser closure artifacts against the harness `window.__ModuleLoader__.load({id, factory})` contract, with CSS Modules compiled by lightningcss into self-contained injected styles.

## Installation (users)

Once published to npm, on any profile that has dsh installed:

```sh
dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle
```

The bundle stacks `prompt-optimizer`, `api-prompt-optimizer` and `ui-prompt-optimizer` into that profile's `dsh.profile.bundles`. You can also install it from the web client's plugin marketplace.

Before any release exists, install from tarballs. A raw local path or git spec does **not** work: the bundle's `workspace:*` dependencies resolve only inside this repository's pnpm workspace, while `dsh plugin add` installs inside the profile's own root. Packing rewrites those ranges to real versions (`pnpm -r pack`), and the tarball's dependencies then resolve from the registry — so this path needs the other three packages published first:

```sh
pnpm -r pack        # writes *.tgz next to each package.json
dsh plugin --profile web add packages/bundle/yimiliya-dsh-prompt-optimizer-bundle-<version>.tgz
```

### Configuration (optional — `plugins > config > prompt-optimizer` in cordis.yml)

| Field | Default | Description |
| --- | --- | --- |
| `verifyTimeoutMs` | see source | Timeout for acceptance-check commands |
| `domainPriors` | `true` | Inject priors based on the draft's technical domain |
| `provider` / `model` | unset | Explicit model routing for optimization; the two must appear together |
| `rolesDir` | bundled catalog | Role definition directory override (`<slug>.md`); the shipped role library is used when unset and stays read-only for role evolution |
| `defaultRole` | unset | Default role slug when none is specified; also settable in the settings page |
| `skillAware` | `true` | Fold matched installed skills into the meta-prompt |

## Privacy

Optimization runs are recorded in the session's own event log; treat drafts accordingly:

- Every optimization round appends a `plugin:prompt-optimizer/llm-request` record containing the full draft text and the auxiliary system prompt.
- Every check run appends a `plugin:prompt-optimizer/verify` record containing the executed command and its (redacted) output.
- "Improve this role" rewrites the role definition file `<slug>.md` under the configured `rolesDir` on disk; the previous version is kept alongside it as `<slug>.md.bak`. The bundled default catalog is read-only: configure `rolesDir` to enable role evolution.

If you paste secrets into a draft, expect them to appear in the session log.

## Development

```sh
pnpm install
pnpm run check      # lint + typecheck + build + test (the same gate CI runs)
pnpm run typecheck  # TypeScript only
pnpm run lint       # oxlint
pnpm run test       # vitest (node + client projects)
pnpm run build      # tsdown, dependency order
```

- **node project** (host + api tests) runs out of the box.
- **client project** (jsdom browser tests) resolves the `@deepseek-ai/*` modules through a deepseek-harness checkout: the published dsh client packages are browser closure artifacts that only load inside the real web client, so tests follow the harness `tsconfig.base.json` paths map into its source tree — the same way these suites run natively inside the harness repo. It defaults to the sibling checkout `../deepseek-harness-latest`, or point at it explicitly:

  ```sh
  DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run test
  ```

  The harness checkout must have had `pnpm install` run inside it (its sources resolve their own dependencies from its tree). The test config also pins react / react-dom / use-sync-external-store to a single copy to avoid cross-copy hook errors.

Agents and contributors should read [AGENTS.md](AGENTS.md) for repo conventions.

## Compatibility

The supported baseline is `@deepseek-ai/dsh-*` `0.2.1-rc.3`; earlier versions are unverified. Details — including the queue-entry slot requirement and the pinned peer dependencies — live in [docs/compatibility.md](docs/compatibility.md), which is the single source of truth.

## Releasing (maintainers)

Keep the four packages on one version. Tag a release (`git tag vX.Y.Z && git push origin vX.Y.Z`) and GitHub Actions builds, checks and publishes all four packages to npm in dependency order (host → api → client → bundle). See `.github/workflows/release.yml`.

## License

[Apache-2.0](LICENSE)
