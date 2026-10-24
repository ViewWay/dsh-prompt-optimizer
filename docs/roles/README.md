# 内置示例角色库

本目录是 prompt-optimizer 的内置示例角色库：20 个开箱即用的角色定义文件，供 `rolesDir` 直接指向使用，也可复制到任意目录后按需增删定制。

## 角色文件契约

- 文件名必须是 `<slug>.md`，slug 仅由小写字母、数字与连字符组成（如 `code-reviewer.md`）。大写开头的文件（如本 `README.md`）不匹配角色文件模式，不会被读取为角色，可安全存放说明文档。
- 文件首行必须是 `#` 一级标题，即角色的显示名（如 `# 代码评审官`）；标题末尾带括号的英文后缀会被剥去，只留中文名。
- 标题之后的正文是角色定义全文：职责、视角、审查重点（或工作方法）、输出要求。定义会被原文拼入优化元提示词，作为该角色的唯一依据，因此须自包含、不引用外部文件。
- 单个角色文件不超过 8000 字符；单个目录最多 500 个文件。
- 角色清单按需读取全部定义文件，不发起任何模型调用。

## 配置 rolesDir 指向本目录

在部署配置文件 `cordis.yml` 的 `plugins > config > prompt-optimizer` 中设置 `rolesDir` 为本目录的绝对路径（macOS 示例）：

```yaml
plugins:
  config:
    prompt-optimizer:
      rolesDir: /Users/your-name/Projects/dsh-prompt-optimizer/docs/roles
```

通用写法（任意系统，替换为实际检出路径）：

```yaml
plugins:
  config:
    prompt-optimizer:
      rolesDir: /absolute/path/to/dsh-prompt-optimizer/docs/roles
```

也可以把本目录复制到任意位置（例如 `~/.dsh/roles/`）再指向复制后的目录，避免示例升级与你的定制互相覆盖。

## 手测步骤

1. 按上文在 `cordis.yml` 中把 `rolesDir` 指向本目录（或你的复制目录）。
2. 重启 dsh（或重新加载插件），使配置生效。
3. 打开插件的设置页：默认角色下拉应列出本目录的角色（如「代码评审官」「测试设计师」），选择一个并保存。
4. 在对话输入框对一段草稿发起优化：优化面板的角色选择器应可选同一批角色，或直接使用推荐角色完成一次成稿。

若设置页出现「未配置角色目录」占位与引导提示，说明 `rolesDir` 未配置或指向的目录没有可用的角色文件，按上文核对路径与文件名后重试。
