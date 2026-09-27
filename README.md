# QBot — 独立的 DSH 交易 agent

QBot 是一个**完全独立的 agent**，不是 `deepseek-harness-dsh` 的一个插件：

- **自己的引擎**：`qbot-dsh/dsh-base/source`（DSH 完整副本，独立安装依赖、独立构建、独立升级）
- **自己的 agent**：`qbot-dsh/agent`（正式 DSH profile bundle：身份人设 + QBot 工具 + dashboard 生命周期）
- **自己的 home**：`qbot-dsh/home`（会话、settings、凭据、profile 全在这里，与 `~/.dsh` 隔离）
- **自己的入口**：`run-qbot.sh` + 桌面快捷方式（端口 3090，默认模型 `opencode-go/deepseek-v4.1-flash`）

它继承 DSH 的全部能力（Web 客户端、会话、subagent、计划、bash、文件、网页、后台作业、定时任务），并且被明确赋予**自我扩展**能力：遇到当前工具解决不了的问题时，可以自己写插件。

## 目录

```text
qbot-dsh/
  agent/                         # @qbot/dsh-agent：QBot 的 agent bundle
    cordis.patch.yml             #   profile 补丁层：人设、工具、dashboard、动态插件
    settings.template.yaml       #   首次安装写入 home/settings.yaml 的模板
    plugins/qbot-tools.mjs       #   QBot 模型工具（8 个）
    plugins/qbot-dashboard.mjs   #   Python dashboard 常驻管理
  dsh-base/source/               # QBot 自有 DSH 引擎（完整副本，含 .git，分支 qbot-local）
  home -> ~/.qbot-dsh            # DSH_HOME：profiles/qbot、settings.yaml、.credentials.yaml
  scripts/
    install-qbot-agent.sh        # 初始化 profile + 安装 agent bundle
    build-engine.sh              # pnpm install + pnpm run build
    update-engine.sh             # 升级到官方最新 dsh-v* 并重建
    install-dsh-plugin.ps1       # 装进 Windows 桌面版 DeepSeek Harness（可选）
    uninstall-dsh-plugin.ps1     # 卸载
    status-dsh-plugin.ps1        # 安装状态
  docs/
    dsh-plugin.md                # 桌面插件安装 / 排错说明
  launcher/                      # Windows 快捷方式入口（VBS + cmd + create-shortcut.ps1）
  run-qbot.sh                    # 启动 / 停止 QBot
  logs/                          # 运行日志
```

> `home` 是指向 `~/.qbot-dsh` 的软链接：drvfs 不保存 Unix 权限，凭据文件放在 D: 会被 DSH
> 以 world-readable 拒绝；会话库放 ext4 也更快。设置 `QBOT_DSH_HOME` 可完全覆盖该位置。

## 快速开始

```bash
cd /mnt/d/klein/code_agent/qbot-dsh

# 1) 构建 QBot 自有引擎（首次约 10-20 分钟；依赖已在本机 store 时会很快）
./scripts/build-engine.sh

# 2) 初始化 QBot home、qbot profile，并安装 agent bundle
./scripts/install-qbot-agent.sh

# 3) 启动（自动打开 Edge 应用窗口）
./run-qbot.sh

# 停止
./run-qbot.sh --stop
```

常用参数：

```bash
./run-qbot.sh --no-open    # 只启动服务，不开窗口
./run-qbot.sh --build      # 先构建再启动
QBOT_DSH_PORT=3091 ./run-qbot.sh
```

## 桌面入口

桌面只保留一个图标：

```text
C:\Users\33407\Desktop\QBot Terminal.lnk
```

链路：

```text
QBot Terminal.lnk
  -> wscript.exe
  -> qbot-dsh\launcher\QBot Terminal.vbs
  -> launcher\qbot-server.cmd
  -> wsl.exe -d Ubuntu-26.04 -- ./run-qbot.sh
  -> qbot 自有引擎 + qbot profile + qbot home
  -> Edge 应用窗口 http://127.0.0.1:3090
```

## QBot 工具

| 工具 | 说明 |
|---|---|
| `qbot_status` | 运行时控制与状态 JSON（mode、trading_enabled、last cycle） |
| `qbot_state` | SQLite 持久状态：最新权益、最近订单、风控事件、新闻 |
| `qbot_doctor` | 只读体检：配置、行情连通性、风控上限（可选 `--check-llm`） |
| `qbot_control` | 请求切换 paper/testnet/live、暂停/恢复交易（live 需 `confirmation="LIVE"`） |
| `qbot_news` | 拉取新闻源快照（JSON，可 `force` 忽略缓存） |
| `qbot_backtest` | 回测（mock/binance/file，可 `walk_forward`） |
| `qbot_run_once` | 只跑一轮交易循环（paper/testnet 需 `RUN`，live 需 `RUN_LIVE`） |
| `qbot_log_tail` | 读日志尾部（qbot / dsh / launcher / dashboard） |

QBot 还带 DSH 的动态 Cordis 插件工具（`cordis_inspect_*`、`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine`）与浏览器控制面板，用于现场扩展能力。

## 自我扩展

- **临时能力**：直接对 QBot 说清需求，它会用动态 Cordis 插件现场定义并运行（只存在于当前进程，重启失效）。
- **持久能力**：让它在 `agent/plugins/` 写新插件，然后二选一挂载——加到 `home/profiles/qbot/cordis.patch.yml`（热重载，立即生效）或加到 `agent/cordis.patch.yml`（随安装永久携带，重启生效）。
- 安装脚本会给 `agent/node_modules/@deepseek-ai/` 建两个指向 QBot 自有引擎的软链（`dsh-tools`、`schemastery`），新插件可直接 import 这些包。

## 与 deepseek-harness-dsh 的分离保证

- 引擎、DSH_HOME、profile、会话、settings、凭据全部在 `qbot-dsh` 内，互不影响。
- 运行 QBot 不读取、不修改 `~/.dsh` 与 `deepseek-harness-dsh/source`（仅 `install-qbot-agent.sh` 首次从 `~/.dsh` 复制一份凭据）。
- 升级 QBot 引擎用 `scripts/update-engine.sh`，与主 DSH 的升级互不干扰。

## 装进 DeepSeek Harness 桌面版（Windows，可选）

同一个 `agent/` bundle 也可以作为**正式 DSH bundle** 装进已安装的 DeepSeek Harness 桌面应用
（`D:\klein\code_agent\dsh`），与上面的独立引擎方式互不影响，两种方式可以同时存在。

```powershell
cd D:\klein\code_agent\qbot-dsh
.\scripts\install-dsh-plugin.ps1 -DryRun   # 只打印将要执行的命令与写入的文件
.\scripts\install-dsh-plugin.ps1           # 安装：pnpm file: 快照 + 注册 bundle + 播种技能
.\scripts\status-dsh-plugin.ps1            # 查看安装状态
.\scripts\uninstall-dsh-plugin.ps1         # 卸载（默认连技能一起移除，-KeepSkills 保留）
```

也可以在应用内走 Settings → Plugins → 安装绝对路径 `D:\klein\code_agent\qbot-dsh\agent`。
安装后**重启 DeepSeek Harness**（bundle 在启动时组合），然后在新会话的 preset 选择器里选
**QBot 交易智能体**（id `qbot`，win32 启用）。

- **能力**：market_data / market_indicators / market_regime / market_news / desk_* / position_size /
  cpp_* / web_search / autopilot_status / journal_append，以及 `cordis_*` 动态插件工具。
  host 行对任何会话可见；QBot 身份与技能只在选中该 preset 的会话里生效。
- **技能**：`agent/skills/*` 播种到 `%USERPROFILE%\.dsh\skills\`，选中 QBot preset 后按需加载 `qbot-trading`。
- **控制台**：重启应用后，会话输入框会出现 **QBot 控制台** 按钮，点开即浮出面板（模式切换 / 启停 / 收益 / 多专家讨论）；
  也可以直接开页面 http://127.0.0.1:8791/（win32 默认 8791，避开 WSL 引擎的 8790；
  `QBOT_PANEL_PORT` 可覆盖；端口被占用只告警，不退出）。
- **C++ 内核**：Windows 无本地工具链时自动经 WSL 调用 `cpp/qbot_cpp`（发行版自动探测，可用
  `QBOT_CPP_WSL_DISTRO` / `QBOT_CPP_WSL_BIN` 或补丁里的 `cppWslDistro` / `cppWslBinPath` 覆盖）；
  缺内核时只有相关工具调用报错，插件照常加载。
- **状态目录**：桌面插件默认写 `%USERPROFILE%\.dsh\desk`（`QBOT_STATE_DIR` 可覆盖），与 WSL 引擎的
  `~/.qbot-dsh` 相互独立。
- **回滚**：安装前自动备份 profile 文件（`<profile>\backups\<时间戳>`）；应用自带的「禁用所有插件」
  恢复流程会把 bundle 列表还原为随发行版交付的集合。完整说明与排错见 `docs/dsh-plugin.md`。

## 模型配置说明

`agent/settings.template.yaml` 里手工声明了 `opencode-go` 路由与 `deepseek-v4.1-flash`：

- 已安装的 pi-ai 目录（0.85.1）还没有这个模型，目录里只有 `deepseek-v4-flash`，所以不能用 `modelOverrides`，必须用 `models` 列表整条声明（`api`、`baseURL`、`compat` 与同族模型一致）。
- Console Go 要求 `x-opencode-session` 请求头，pi-ai 0.85.1 不会自动发送，所以在路由 `headers` 里静态配置了一个会话标识。
- 升级引擎后如果新 pi-ai 已收录该模型，这段配置仍然有效（`models` 条目会与目录条目按字段合并）。

## 迁移说明

旧版本把 QBot 作为 `--patch plugin/cordis.yml` 插件挂在 `deepseek-harness-dsh` 的 web profile 上。现已删除：

- `plugin/`、`install-qbot-profile.sh`、`build-dsh.sh`、`run-dsh-web.sh`（被 `agent/` 与 `scripts/` 取代）
- 旧的 `qbot-dsh/node_modules` 解析 shim（现在由 `agent/node_modules` + 安装脚本负责）
- 桌面快捷方式路径不变（`launcher\QBot Terminal.vbs`）；如需重建，运行 `launcher\create-shortcut.ps1`


## QBot 首页交易面板

- Host 插件 `qbot-core` 在 `127.0.0.1:8790/qbot/status` 暴露只读 JSON。
- Web 公共资产 `apps/web/public/qbot-panel.js` 在右下角渲染：
  - 权益、今日盈亏、可用/已实现
  - 持仓与浮盈
  - 最近成交
  - 市场状态（趋势/区间/混沌、RSI、ATR%）
- 10 秒刷新，断线显示 host 未连接。

## 任务插件拆分

- `qbot-core`：共享 market / desk / paper / panel / C++ 配置
- `qbot-market`：market_data / market_indicators / market_regime
- `qbot-news`：market_news
- `qbot-risk`：desk_risk / position_size
- `qbot-execution`：desk_order / close / cancel / status / history / mode / leverage / protect / journal_append
- `qbot-cpp`：cpp_engine_status / cpp_risk_size
- `qbot-web`：联网搜索
- `@deepseek-ai/dsh-tool-cordis`：动态 Cordis 插件

## C++ 执行内核

- `qbot-dsh/cpp/qbot_cpp --risk-check`
- 编译：`cd qbot-dsh/cpp && make`
- QBot 所有**风险增加型** `desk_order` 现在先经过 C++ 内核：
  - 必须有 `stop_loss`
  - 按权益风险预算计算 qty/notional
  - 超过 cap 自动缩仓
- `cpp_engine_status` / `cpp_risk_size` 也可由模型直接调用交叉验证。

## 自我扩展 skill

- `agent/skills/qbot-extension/SKILL.md` 会播种到 QBot workspace。
- 临时能力用 `cordis_define` / `cordis_run`；持久能力写入 `agent/plugins/` 并挂到 profile 补丁。


## 无人指挥的自动交易模式

- `qbot-autopilot` 默认启用，在 paper 模式下每 60 分钟自动运行一遍。
- 每个周期：账户/持仓 → 行情/指标/资金费率 → 新闻/恐慌贪婪 → 加载 `qbot-trading` skill → 模型决策 → C++ 风险内核截断 → desk 执行 → journal → 面板状态。
- 支持委员会：`autopilotModels` 配置成多个 `provider:model`，按置信度加权投票；方向分歧超过阈值自动 hold。
- 风控自动暂停：
  - 回撤超过 `autopilotMaxDrawdownPct`（默认 10%）自动暂停开新仓
  - 当日亏损达到 `maxDailyLoss` 自动暂停开新仓
  - 连续错误达到 `autopilotMaxConsecutiveErrors`（默认 3）自动暂停
- Live 默认禁止自动运行；必须同时设置 `allowLive: true` 与 `autopilotAllowLive: true`。
- 人工只在紧急时用控制台：暂停 / 恢复 / 立即执行一轮 / 紧急平仓；正常运行时不需要指挥。

## 自动交易控制台

- 右下角浮动面板，可切全屏控制台。
- 展示：权益、今日盈亏、自动循环状态、下次唤醒、最新决策、持仓、成交、市场状态、决策时间线。
- Host 本地接口：
  - `GET /qbot/status`
  - `POST /qbot/control`：`pause` / `resume` / `run_once` / `close_all` / `set_interval`


## Dream-RSI 回放与控制器进化

- `agent/lib/dream.mjs` 把每个 cycle 记录为 grounded discovery-tree 节点：
  - 真实价格、资金费率、模型分支、执行 actions、权益、组合热度
  - `branches.aggregate` + `branches.members`：同一节点保留多个模型分支
- controller 选择分支策略：
  - `aggregate`：用委员会聚合决策
  - `primary`：用第一个成功模型的分支
  - `best_confidence`：用置信度最高的模型分支
- replay 调用 C++ `--paper-sim` 做 paper ledger：
  - 手续费、滑点、资金费、持仓盈亏、权益曲线
- replay 成本：
  - 模型调用次数 × modelCallCost
  - 交易次数 × tradeCost
  - C++ 手续费、资金费已经计入权益曲线
- controller 进化：
  - 参数邻居：置信度、风险倍数、动作数、热度、相关性、委员会阈值
  - 分支策略、沙箱代码候选
  - 模型生成的候选也进入同一个 replay 评估
  - 当前 controller 始终在候选集合中，只升不降
- controller 持久化：
  - `~/.qbot-dsh/workspace/dream/controller.json`
  - 重启后自动恢复
- `POST /qbot/control {"action":"dream_now"}`：立即在真实历史上跑一次 dreaming

### 首次进化观测

为观测曾临时把 `dreamIntervalCycles` 调为 3，并让两个委员模型各投票一次：

```text
进化前：default-v1 aggregate，score -0.18
进化后：default-v1-branch-primary v2，score -0.15
improved: true
```

原因：双模型节点里 `primary` 分支只调用一个模型，replay 成本更低。
观测完成后已恢复：

```yaml
autopilotModels: 'opencode-go:deepseek-v4.1-flash'
dreamIntervalCycles: 20
```

控制器 v2 已持久化，重启后自动恢复。


## 只使用 OpenCode Go 的多 Agent

QBot 现在只需要一个 API key：

```text
OPENCODE_GO_API_KEY
```

默认四委员全部使用同一个模型 `deepseek-v4.1-flash`，通过角色提示词制造多样性：

```yaml
autopilotModels: 'opencode-go:deepseek-v4.1-flash@trend,opencode-go:deepseek-v4.1-flash@reversal,opencode-go:deepseek-v4.1-flash@news,opencode-go:deepseek-v4.1-flash@risk'
autopilotReasoningEffort: max
autopilotMaxTokens: 16000
autopilotCommitteeMinAgreement: 0.55
```

- trend：趋势延续 / 回调企稳
- reversal：区间边缘 / 假突破 / 均值回归
- news：新闻 / ETF / 资金费率 / 拥挤度
- risk：资本保全 / 低回撤 / 拒绝不确定交易

四个模型并行投票，按置信度加权；`reasoning_effort=max`，思考预算提升到 16000 tokens。
