# dsh-prompt-optimizer

[![CI](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/ViewWay/dsh-prompt-optimizer/actions/workflows/ci.yml)

A standalone, independently distributed plugin family for the DeepSeek Harness that turns a rough idea draft into a polished, agent-ready prompt through iterative **rewrite → self-review → fix** rounds.

[English](README.md) | [简体中文](README_zh.md)

## Features

- One-click **Optimize** button on the input box plus domain recommendation chips; multi-round optimization with retry and per-round diff preview
- **Role library** (`<slug>.md` files under `rolesDir`): list roles on demand, recommend by draft, re-run with an explicit role; set a default role in the settings page
- **Skill awareness** (`skillAware`): when a draft matches an installed skill, its name and description are folded into the meta-prompt so the output references those skills — guarded by exact-name constraints against hallucination
- **Output language follows the agent UI language**: a Chinese interface yields Chinese prompts, English yields English, while code identifiers, paths and commands stay verbatim
- Inline **Optimize** entry on queued (unsent) conversation items
- **Acceptance criteria**: mechanical criteria ship with an executable check-command template

## Repository layout

| Package | Purpose |
| --- | --- |
| `packages/prompt-optimizer` | Host service: optimization rounds, role library, skill hints, model routing |
| `packages/api-prompt-optimizer` | Remote controller and Typert descriptors (host/client shared method table) |
| `packages/client-ui-prompt-optimizer` | Browser UI: trigger button, preview panel, queue entries, settings page |
| `packages/bundle` | Profile bundle (`cordis.patch.yml`) that installs all three plugins in one shot |

`tools/tsdown.client.ts` is the standalone client build preset: it emits browser closure artifacts against the harness `window.__ModuleLoader__.load({id, factory})` contract, with CSS Modules compiled by lightningcss into self-contained injected styles.

## Installation (users)

Once published to npm, on any profile that has dsh installed:

```sh
dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle
```

The bundle stacks `prompt-optimizer`, `api-prompt-optimizer` and `ui-prompt-optimizer` into that profile's `dsh.profile.bundles`. You can also install it from the web client's plugin marketplace.

Before publishing, install from a local path or git (pnpm resolves `workspace:*` to the matching versions):

```sh
dsh plugin --profile web add /path/to/dsh-prompt-optimizer/packages/bundle
```

### Configuration (optional — `plugins > config > prompt-optimizer` in cordis.yml)

| Field | Default | Description |
| --- | --- | --- |
| `verifyTimeoutMs` | see source | Timeout for acceptance-check commands |
| `domainPriors` | `true` | Inject priors based on the draft's technical domain |
| `provider` / `model` | unset | Explicit model routing for optimization; the two must appear together |
| `rolesDir` | unset | Role definition directory (`<slug>.md`); enables role selection and recommendation |
| `defaultRole` | unset | Default role slug when none is specified; also settable in the settings page |
| `skillAware` | `true` | Fold matched installed skills into the meta-prompt |

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

The supported baseline is `@deepseek-ai/dsh-*` `0.2.1-rc.2`; earlier versions are unverified. Details — including the queue-entry slot requirement and the pinned peer dependencies — live in [docs/compatibility.md](docs/compatibility.md), which is the single source of truth.

## Releasing (maintainers)

Keep the four packages on one version. Tag a release (`git tag v0.1.0 && git push --tags`) and GitHub Actions builds, checks and publishes all four packages to npm in dependency order (host → api → client → bundle). See `.github/workflows/release.yml`.

## License

[Apache-2.0](LICENSE)
