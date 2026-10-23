# @yimiliya/dsh-prompt-optimizer-bundle

One-command install of the [dsh-prompt-optimizer](https://github.com/ViewWay/dsh-prompt-optimizer) plugin family for the DeepSeek Harness: turn a rough idea draft into a polished, agent-ready prompt through iterative **rewrite → self-review → fix** rounds.

## Install

On any profile that has dsh installed:

```sh
dsh plugin --profile web add @yimiliya/dsh-prompt-optimizer-bundle
```

Updates:

```sh
dsh plugin --profile web update @yimiliya/dsh-prompt-optimizer-bundle@latest
```

The bundle stacks three plugins into the profile's `dsh.profile.bundles`:

| Plugin | Purpose |
| --- | --- |
| [`@yimiliya/dsh-prompt-optimizer`](https://www.npmjs.com/package/@yimiliya/dsh-prompt-optimizer) | Host service: optimization rounds, role library, skill hints, model routing |
| [`@yimiliya/dsh-api-prompt-optimizer`](https://www.npmjs.com/package/@yimiliya/dsh-api-prompt-optimizer) | Typert remote controller (host/client shared method table) |
| [`@yimiliya/dsh-client-ui-prompt-optimizer`](https://www.npmjs.com/package/@yimiliya/dsh-client-ui-prompt-optimizer) | Browser UI: optimize button, preview panel, queue entries, settings |

You can also install it from the web client's plugin marketplace.

## What you get

- One-click **Optimize** on the input box plus domain recommendation chips; multi-round optimization with retry and per-round diff preview
- **Role library** and per-draft role recommendation; default role configurable
- **Skill awareness**: matched installed skills are referenced by exact name in the optimized prompt
- **Output language** follows the agent UI language; code identifiers, paths and commands stay verbatim
- Inline **Optimize** on queued (unsent) conversation items
- **Acceptance criteria** with executable check-command templates

## Configuration (optional — `plugins > config > prompt-optimizer` in cordis.yml)

| Field | Default | Description |
| --- | --- | --- |
| `verifyTimeoutMs` | see source | Timeout for acceptance-check commands |
| `domainPriors` | `true` | Inject priors based on the draft's technical domain |
| `provider` / `model` | unset | Explicit model routing; the two must appear together |
| `rolesDir` | unset | Role definition directory (`<slug>.md`); enables role selection and recommendation |
| `defaultRole` | unset | Role used when none is specified |
| `skillAware` | `true` | Fold matched installed skills into the meta-prompt |

## Compatibility

Baseline `@deepseek-ai/dsh-*` `0.2.1-rc.2`; earlier versions are unverified. See [docs/compatibility.md](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/docs/compatibility.md).

## License

[Apache-2.0](https://github.com/ViewWay/dsh-prompt-optimizer/blob/main/LICENSE)
