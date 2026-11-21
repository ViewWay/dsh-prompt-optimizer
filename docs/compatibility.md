# Compatibility

This file is the single source of truth for supported harness baselines and pinned dependencies. Update it whenever a baseline changes; the READMEs only summarize.

## Supported baselines

| Dependency | Baseline | Notes |
| --- | --- | --- |
| `@deepseek-ai/dsh-*` | `0.2.1-rc.5` | npm `latest`/`next` tag; earlier versions are unverified |
| `@deepseek-ai/cordis` | `4.0.5` | peer + dev dependency in host and client packages |
| `zod` | `4.6.7` | pinned; 4.6.x verified against the full gate (lib/types interop holds; `>=4.6.6` fixes GHSA-mrhx-c7xc-m3w5) |

## Runtime compatibility range

Every publishable package declares `engines.dsh` — currently `>=0.2.1-rc.5 <0.3.0`. The harness plugin gate evaluates an `engines.dsh` range on its own and then ignores the exact `@deepseek-ai/dsh-*` peer pins, so one release installs and activates across the entire 0.2.x line (prereleases included) without a plugin release per rc. The peer pins stay exact on purpose: they record the version each release is built and typechecked against; pnpm may still print peer warnings on newer runtimes, which are cosmetic. The `<0.3.0` ceiling is deliberate — 0.x minor bumps may break APIs. `.github/workflows/canary.yml` runs the full gate against the newest published harness weekly and opens an issue on failure; that issue is the signal to cut an adapted release.

## Harness feature requirements

- The inline **queue entry** depends on the harness plugin slot `conversation.input.dock.queue.item`, which no published harness release declares up to `0.2.1-rc.5`. Hosts without the slot skip the entry automatically (one `warn` in the log); the input-box button, preview panel and settings page are unaffected. Once a harness release ships the slot, the queue entry appears without reinstalling the plugin.
- **Session record writes resolve through the host's own copy.** The installed app runtime bundles `@deepseek-ai/dsh-session` inside its app archive, and a profile whose dependency tree pulls any `@deepseek-ai/*` package (directly or through third-party plugins) carries a second, locally resolved copy. Appending a plugin record calls a `#`-private method whose V8 brand check rejects a session created by the other copy ("Receiver must be an instance of class Session"), so the host service resolves `appendPluginRecord` from the runtime bundle first and falls back to the peer import only where one shared copy exists (source checkouts, dev harness runs).

## Client tests

The client (jsdom) test project resolves `@deepseek-ai/*` modules through a deepseek-harness checkout's `tsconfig.base.json` paths map (default sibling `../deepseek-harness-latest`, or `DSH_HARNESS_ROOT`). CI clones the harness at tag `dsh-v0.2.1-rc.5`, installs its dependencies, and runs the suite against it. When bumping the baseline tag, update:

1. the peer/dev dependency versions in `packages/*/package.json`,
2. the clone tag in `.github/workflows/ci.yml` and `.github/workflows/release.yml`,
3. this file.
