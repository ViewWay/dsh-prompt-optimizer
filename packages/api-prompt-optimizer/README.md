# @yimiliya/dsh-api-prompt-optimizer

Typert remote controller for the [dsh-prompt-optimizer](https://github.com/ViewWay/dsh-prompt-optimizer) plugin family: the API layer that lets the dsh web client call the prompt-optimizer host service through the harness API gateway.

> **Users should not install this package directly** — install the bundle instead:
> `dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle`
> See the [project README](https://github.com/ViewWay/dsh-prompt-optimizer#readme) for full documentation (English / 简体中文).

## What it provides

- The `promptOptimizer` remote method table (`listPrompts`, `optimize`, `recommendRoles`, library and verify endpoints) shared by host and client
- Generated Typert descriptors under `src/generated/` (`./typert` for the host, `./remote` for the client) that keep request/response shapes in lockstep across the gateway
- Shared result types re-exported from `@yimiliya/dsh-prompt-optimizer/types`

## Exports

| Entry | Purpose |
| --- | --- |
| `.` | Remote controller |
| `./typert` | Host-side Typert descriptors |
| `./remote` | Client-side typed remote client |
| `./types` | Shared request/response types |

## Development

```sh
pnpm install
pnpm run check   # at the repo root: lint + typecheck + build + test
```

`src/generated/` is generated output — do not hand-edit (excluded from lint). Tests live in `packages/api-prompt-optimizer/tests/` and run in the `node` vitest project.

## Compatibility

Baseline `@deepseek-ai/dsh-*` `0.2.1-rc.3`, `@deepseek-ai/cordis` `4.0.5`, `zod` pinned at `4.4.3`. See [docs/compatibility.md](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/docs/compatibility.md).

## License

[Apache-2.0](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/LICENSE)
