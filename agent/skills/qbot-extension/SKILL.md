---
name: qbot-extension
description: Use DSH dynamic Cordis capabilities to build task plugins for QBot on the spot, and persist working plugins into the QBot agent bundle.
whenToUse: When current tools cannot solve a task, when a new market/data/analysis/execution/notification capability is needed, or when the user asks QBot to extend itself.
---

# QBot Self-Extension

QBot runs on the DSH base, which already mounts `@deepseek-ai/dsh-tool-cordis`. Build tools for yourself with the dynamic Cordis tools instead of repeatedly stitching one-off scripts together with bash.

## Dynamic tools

- `cordis_inspect_process` / `cordis_inspect_fibers` / `cordis_inspect_services`: start by understanding the current process.
- `cordis_define`: define a temporary plugin; the argument is plugin module source or configuration. It lives only in the current process and disappears on restart.
- `cordis_run`: mount and run a temporary plugin.
- `cordis_stop` / `cordis_undefine`: stop or unregister a temporary plugin.
- The browser control panel `ui-cordis` shows these temporary plugins.

Micro-tasks default to temporary plugins; never let a temporary plugin carry money-safety responsibility.

## Persistent plugins

When a capability must survive restarts:

1. Write a small, focused `.mjs` plugin under `qbot-dsh/agent/plugins/`, exporting `name`, `inject` and `apply(ctx, config)`.
2. Prefer reusing existing capabilities under `qbot-dsh/agent/lib/`; do not copy large blocks of logic.
3. When model-facing tools are needed, use `defineTool` from `@deepseek-ai/dsh-tools`; the available dependencies are already linked under `agent/node_modules/@deepseek-ai/`.
4. Append the plugin row to `home/profiles/qbot/cordis.patch.yml` (hot reload, effective immediately) or `agent/cordis.patch.yml` (carried permanently with the bundle, effective after restart).
5. Put plugin parameters in `Config`; dangerous operations must require an explicit `confirmation`.
6. Verify on a small scale first, then write to the journal explaining the motivation, interface and risks.

## Safety baseline

- Never write API keys, private keys or seed phrases into plugin source or logs.
- New plugins default to read-only/paper; anything that places real orders must inherit the desk's risk rails and confirmation gates.
- Do not bypass `qbot-desk` leverage, notional, daily-loss or kill-switch limits.
- If a dynamic plugin errors, `cordis_stop` it first; do not let a failing plugin keep running.
- For large changes, explain the plan to the user and get confirmation first.