# QBot — DeepSeek Harness trading plugin

QBot as an installable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin bundle:
one profile patch layer plus host plugins. It turns a DSH profile into an autonomous crypto trading agent
with hard risk rails, while leaving the host application untouched.

## What the plugin adds

- **Trading desk** — paper by default; testnet/live behind explicit gates (`allowLive`, `confirmation="LIVE"`).
- **Risk rails** — leverage / per-order notional / gross notional / daily-loss caps, kill switch, mandatory stop-loss.
- **C++ execution kernel** — position sizing and an extra entry gate (`cpp/`), used natively on Linux or through
  WSL on Windows when no local toolchain exists.
- **Market tools** — ticker / candles / depth / funding / contract, multi-timeframe indicators, regime classification,
  RSS news + Fear & Greed, keyless web search.
- **Autopilot** — a host-level loop that wakes on an interval, builds market context, asks a committee of N models
  (roles: trend / reversal / news / risk / macro), aggregates weighted votes, passes actions through the C++ kernel
  and the desk, then journals the cycle. Auto-pauses on drawdown, daily loss or repeated errors.
- **Committee visibility** — every cycle records each expert's regime, confidence, summary and actions.
- **Console** — a standalone monitoring page (equity, PnL, positions, fills, equity curve, committee table,
  expert scoreboard) with mode switching and start/stop/run-once/emergency-flat controls.
- **Skills** — `qbot-trading` (market states, setups, sizing, review) and `qbot-extension` (self-extension workflow).

## Layout

```
agent/                     the DSH bundle (@qbot/dsh-agent)
  package.json             declares dsh.bundle.patch
  cordis.patch.yml         the profile layer: rows, config, QBot agent preset
  plugins/                 qbot-core, qbot-autopilot, qbot-market, qbot-news,
                           qbot-risk, qbot-execution, qbot-web, qbot-cpp,
                           qbot-tools, qbot-dashboard
  lib/                     desk, market, dream (replay), tool groups, cpp bridge
  assets/                  console page + floating monitor
  skills/                  qbot-trading, qbot-extension
scripts/                   Windows install / uninstall / status (PowerShell)
docs/dsh-plugin.md         install, usage, troubleshooting (Chinese)
cpp/                       C++ risk kernel source + Makefile
```

## Install

**DeepSeek Harness desktop app (Windows)** — either in-app (*Settings → Plugins → install the absolute path to
`agent/`*) or with the script:

```powershell
.\scripts\install-dsh-plugin.ps1 -DryRun   # print the plan, write nothing
.\scripts\install-dsh-plugin.ps1           # pnpm file: install + register the bundle + seed skills
.\scripts\status-dsh-plugin.ps1
.\scripts\uninstall-dsh-plugin.ps1
```

Restart the app afterwards: bundles are composed at startup. Then pick the **QBot Trading Agent** preset in a session.

**Any DSH profile, via the CLI:**

```bash
dsh plugin --profile <name> add /absolute/path/to/agent
```

## Console

```
http://127.0.0.1:8791/        # win32 default (8790 on Linux); QBOT_PANEL_PORT overrides
```

The page polls `GET /qbot/status` and drives `POST /qbot/control`
(`set_mode`, `pause`, `resume`, `run_once`, `close_all`, `set_interval`, `dream_now`).

## Safety model

- Paper mode by default; switching to live needs `allowLive: true` in configuration **and** an explicit
  `confirmation="LIVE"` (the console asks for confirmation, the desk enforces the gate).
- Every risk-increasing entry must carry a stop-loss and is validated by the C++ kernel first.
- Daily-loss, drawdown and consecutive-error circuit breakers pause new entries; autopilot is disabled in live
  unless `autopilotAllowLive` is set deliberately.
- Nothing in this plugin holds exchange credentials: the desk uses the host's configured providers.

## License

No license file yet — add one before publishing.