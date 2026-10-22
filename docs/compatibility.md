# Compatibility

This file is the single source of truth for supported harness baselines and pinned dependencies. Update it whenever a baseline changes; the READMEs only summarize.

## Supported baselines

| Dependency | Baseline | Notes |
| --- | --- | --- |
| `@deepseek-ai/dsh-*` | `0.2.1-rc.2` | npm `next` tag; earlier versions are unverified |
| `@deepseek-ai/cordis` | `4.0.5` | peer + dev dependency in host and client packages |
| `zod` | `4.4.3` | pinned — required by lib/types interop, do not upgrade |

## Harness feature requirements

- The inline **queue entry** depends on the harness plugin slot `conversation.input.dock.queue.item`, which shipped after `0.2.1-rc.2`. On older hosts that entry skips itself automatically (one `warn` in the log); the input-box button, preview panel and settings page are unaffected. After the host is upgraded, the queue entry appears without reinstalling the plugin.

## Client tests

The client (jsdom) test project resolves `@deepseek-ai/*` modules through a deepseek-harness checkout's `tsconfig.base.json` paths map (default sibling `../deepseek-harness-latest`, or `DSH_HARNESS_ROOT`). CI clones the harness at tag `dsh-v0.2.1-rc.2`, installs its dependencies, and runs the suite against it. When bumping the baseline tag, update:

1. the peer/dev dependency versions in `packages/*/package.json`,
2. the clone tag in `.github/workflows/ci.yml` and `.github/workflows/release.yml`,
3. this file.
