# @yimiliya/dsh-client-ui-prompt-optimizer

Browser UI of the [dsh-prompt-optimizer](https://github.com/ViewWay/dsh-prompt-optimizer) plugin family for the DeepSeek Harness web client: every surface you touch when optimizing a prompt.

> **Users should not install this package directly** — install the bundle instead:
> `dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle`
> See the [project README](https://github.com/ViewWay/dsh-prompt-optimizer#readme) for full documentation (English / 简体中文).

## Surfaces

- **Optimize button** on the conversation input box, with domain recommendation chips
- **Preview panel** with per-round diff preview, retry, and editable acceptance criteria
- **Queue entries**: an inline Optimize action on queued (unsent) conversation items
- **Settings page**: default role, `rolesDir`-independent defaults, and skill-awareness toggle

All user-visible strings live in `src/client/locales.ts` — `zh` is the key source and `en` is type-checked against it, so UI changes must update both dictionaries. `locale/en.json` and `locale/zh.json` carry only the plugin-marketplace metadata (`meta.title` / `meta.description`).

## Build model

The published npm artifact is a browser closure bundle built by `tools/tsdown.client.ts` against the harness `window.__ModuleLoader__.load({id, factory})` contract, with CSS Modules compiled by lightningcss into self-contained injected styles. Harness modules are injected (`dsh.client.inject`) and resolved as externals at load time.

## Development

```sh
pnpm install
pnpm run check   # at the repo root: lint + typecheck + build + test
DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run test   # client (jsdom) tests
```

Client tests resolve `@deepseek-ai/*` modules through a deepseek-harness checkout's paths map; see the [project README](https://github.com/ViewWay/dsh-prompt-optimizer#development) for setup details.

## Compatibility

Baseline `@deepseek-ai/dsh-*` `0.2.1-rc.3`; the queue-entry surface needs the `conversation.input.dock.queue.item` slot. See [docs/compatibility.md](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/docs/compatibility.md).

## License

[Apache-2.0](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/LICENSE)
