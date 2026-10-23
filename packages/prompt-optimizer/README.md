# @yimiliya/dsh-prompt-optimizer

Host service of the [dsh-prompt-optimizer](https://github.com/ViewWay/dsh-prompt-optimizer) plugin family: a DeepSeek Harness (dsh) cordis plugin that turns a rough idea draft into a polished, agent-ready prompt through iterative **rewrite → self-review → fix** rounds.

> **Users should not install this package directly** — install the bundle instead:
> `dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle`
> See the [project README](https://github.com/ViewWay/dsh-prompt-optimizer#readme) for full documentation (English / 简体中文).

## What it does

- Runs multi-round optimization with retry and self-review, exposing the result to the browser client through the Typert remote controller
- **Role library**: lists `<slug>.md` roles from the configured `rolesDir`, recommends roles for a draft, and re-runs with an explicit or default role
- **Skill awareness**: folds matched installed skills (name + description) into the meta-prompt, with exact-name constraints against hallucination
- **Output language** follows the agent UI language; code identifiers, paths and commands stay verbatim
- **Acceptance criteria**: mechanical criteria ship with an executable check-command template, verified under `verifyTimeoutMs`
- **Model routing**: uses the session model by default, or an explicit `provider`/`model` pair

## Configuration

Set under `plugins > config > prompt-optimizer` in `cordis.yml`:

| Field | Default | Description |
| --- | --- | --- |
| `verifyTimeoutMs` | see source | Timeout for acceptance-check commands |
| `domainPriors` | `true` | Inject priors based on the draft's technical domain |
| `provider` / `model` | unset | Explicit model routing; the two must appear together |
| `rolesDir` | unset | Role definition directory (`<slug>.md`); enables role selection and recommendation |
| `defaultRole` | unset | Role used when none is specified |
| `skillAware` | `true` | Fold matched installed skills into the meta-prompt |

## Development

```sh
pnpm install
pnpm run check   # at the repo root: lint + typecheck + build + test
```

Host tests live in `packages/prompt-optimizer/tests/` and run in the `node` vitest project out of the box.

## Compatibility

Baseline `@deepseek-ai/dsh-*` `0.2.1-rc.2`, `@deepseek-ai/cordis` `4.0.5`, `zod` pinned at `4.4.3`. See [docs/compatibility.md](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/docs/compatibility.md).

## License

[Apache-2.0](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/LICENSE)
