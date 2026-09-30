# 在 DeepSeek Harness 桌面版安装 QBot 插件

把 `qbot-dsh/agent`（包名 `@qbot/dsh-agent`）作为正式 DSH profile bundle 装进**桌面版
DeepSeek Harness** 的 desktop profile，让桌面 DSH 获得 QBot 的交易身份、工具、技能和交易面板。
桌面版与 WSL 里那套独立 QBot 引擎互不影响：本流程只写 `%USERPROFILE%\.dsh`（profile + 技能），
不改桌面 DSH 安装目录，也不碰 `qbot-dsh/home`。

## 这个插件带来什么

- **QBot 身份**：bundle 覆盖全局 `system-prompt` 层，并注册一个 Windows 桌面专用的
  **QBot agent preset**（id `qbot`）。新建会话时选 QBot preset 即可获得完整人设。
- **交易工具**：`qbot-core`（共享行情/交易台/paper 状态/面板）、`qbot-autopilot`（自主循环）、
  `qbot-market`、`qbot-news`、`qbot-risk`、`qbot-execution`、`qbot-web`、`qbot-cpp`；
  以及 DSH 动态 Cordis 工具集（`cordis_define` / `cordis_run` 等）。
- **交易面板**：`qbot-core` 在 `127.0.0.1:8791/qbot/status` 暴露只读 JSON。
  Windows 桌面默认 **8791**；WSL 的 QBot 引擎占用 8790，两者不冲突。
  可用环境变量 `QBOT_PANEL_PORT` 覆盖端口（改完重启 app）。
- **技能**：`agent\skills\*`（`qbot-trading`、`qbot-extension`）播种到
  `%USERPROFILE%\.dsh\skills\`；DSH 的 `skill-filesystem` 默认扫描该目录。
- 默认关闭 `qbot-tools`、`qbot-python-dashboard`（它们面向 WSL 里的旧 Python QBot），
  需要时在 `agent\cordis.patch.yml` 里把 `disabled` 改成 `false`。

## 前置条件

- 桌面版 DeepSeek Harness 已安装，默认路径 `D:\klein\code_agent\dsh`。
- 桌面 DSH 的 home 是 `C:\Users\<你>\.dsh`，desktop profile 是
  `C:\Users\<你>\.dsh\profiles\desktop`。
- 不需要联网：`file:` 安装只用本地 pnpm store，脚本会加 `--offline`，一旦需要访问 registry 会直接报错。

## 安装方式 A：脚本（推荐）

```powershell
cd D:\klein\code_agent\qbot-dsh

# 1) 先看计划：打印要执行的 pnpm 命令和要写的每个文件，不写盘
.\scripts\install-dsh-plugin.ps1 -DryRun

# 2) 真正安装（app 正在运行也可以，装完重启即可）
.\scripts\install-dsh-plugin.ps1
```

脚本做的事与桌面版插件管理器一致：

1. 用 app 自带的 node + pnpm，在 profile 目录里执行
   `pnpm add "file:D:\klein\code_agent\qbot-dsh\agent" --offline`；
2. 把 `@qbot/dsh-agent` 追加到 profile `package.json` 的 `dsh.profile.bundles`（去重、保持顺序）；
3. 把 `agent\skills\*` 复制到 `%USERPROFILE%\.dsh\skills\`（已存在的技能先备份再覆盖）。

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-InstallDir` | `D:\klein\code_agent\dsh` | 桌面版安装目录（用它的 node/pnpm） |
| `-ProfileDir` | `%USERPROFILE%\.dsh\profiles\desktop` | 要安装到的 profile |
| `-PluginDir` | `<repo>\agent` | bundle 源目录 |
| `-SkillsDir` | `%USERPROFILE%\.dsh\skills` | 技能播种目录（DSH_HOME 非默认时手动指定） |
| `-DryRun` | 关 | 只打印计划，不写任何文件 |
| `-SkipSkills` | 关 | 不播种技能 |
| `-Force` | 关 | 即使快照一致也强制刷新 pnpm 安装 |

安全机制：

- profile 里存在 `lock` 文件时直接拒绝（app 正在改 profile，等它操作完再跑）；
- 写入前把 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`
  备份到 `<profile>\backups\<时间戳>\`，失败自动恢复并保留备份目录；
- 幂等：已安装且源码快照一致时直接跳过，不重复写。

> 源码快照说明：pnpm 对 `file:` 依赖可能用硬链接（同卷）或拷贝（跨卷，桌面 profile 在 C:、
> 源码在 D: 时就是拷贝）。**就地编辑**源码文件同卷时会自动同步；**新增或替换**文件不会自动
> 同步，而且只跑 `pnpm add` 会报 "Already up to date" 却不刷新。脚本会比较源目录与已安装快照
> 的指纹，发现不一致就 `pnpm remove` + `pnpm add` 重建，所以改完 `agent\` 后重跑一次安装脚本即可。

## 安装方式 B：应用内安装

1. 打开 DeepSeek Harness → **Settings（设置）→ Plugins（插件）**；
2. 选择安装本地插件，路径填绝对路径：`D:\klein\code_agent\qbot-dsh\agent`；
3. 应用会自己执行等价的 pnpm 安装，并在包声明了 `dsh.bundle.patch` 时把
   `@qbot/dsh-agent` 追加进 `dsh.profile.bundles`；
4. 重启 app。

应用内安装**不会**播种技能。装完后可以补跑一次脚本（它会发现依赖和 bundle 都已就位，只补技能）：

```powershell
.\scripts\install-dsh-plugin.ps1
```

## 重启与选择 QBot agent preset

- **必须重启 DeepSeek Harness**：bundle 只在 app 启动时组合进 profile。
- 重启后**新建会话**，在 agent preset 选择器里选择 **QBot**（id `qbot`，插件在 Windows 桌面注册）。
- 不要用默认的 `standard` preset：每个 shipped preset 都会挂载自己的 scoped
  `@deepseek-ai/dsh-persona` 前缀，会盖掉 QBot 的全局人设；QBot preset 才是给交易场景的。
- 交易面板：浏览器打开 `http://127.0.0.1:8791/qbot/status`。端口被占用时
  （EADDRINUSE）用 `QBOT_PANEL_PORT=8792` 覆盖后重启 app。

## 安装后自检

```powershell
.\scripts\status-dsh-plugin.ps1
```

会打印：app 是否在运行、`lock` 是否存在、profile 的 dependencies / bundles、已安装包版本与
指向（硬链接源或拷贝快照）、快照是否 STALE、已播种技能。退出码 0 = 已安装并注册，1 = 未安装。

也可以直接看 manifest：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw
```

应能看到 `"@qbot/dsh-agent": "file:D:/klein/code_agent/qbot-dsh/agent"`，以及
`dsh.profile.bundles` 末尾的 `"@qbot/dsh-agent"`。

## 卸载

```powershell
.\scripts\uninstall-dsh-plugin.ps1 -DryRun      # 先看计划
.\scripts\uninstall-dsh-plugin.ps1              # 执行
.\scripts\uninstall-dsh-plugin.ps1 -KeepSkills  # 保留技能（技能是你可编辑的数据）
```

卸载会：备份 → `pnpm remove @qbot/dsh-agent` → 从 `dsh.profile.bundles` 移除条目 →
删除脚本播种的技能（先备份）→ 报告残留。之后重启 app。

残留是正常的 pnpm 元数据：`node_modules\.pnpm`、`node_modules\.modules.yaml`、
`node_modules\.pnpm-workspace-state-v1.json`、`pnpm-lock.yaml`；脚本会逐项列出，不会乱删。

## 恢复 / 兜底

- **app 自带恢复**：Settings → Plugins → Disable all plugins（`disableAllPlugins` 会把
  `dsh.profile.bundles` 重置为出厂 web 模板）。bundle 导致 app 起不来时用这个。
- **脚本备份恢复**：备份在 `<profile>\backups\<时间戳>\`，手动把
  `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.patch.yml`
  复制回 profile 即可；技能备份在 `<时间戳>-uninstall\skills\`。
- 想彻底清干净：先卸载，再手动删 `node_modules\.pnpm` 等元数据目录（可选）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 安装后没生效 | 确认 manifest 里有依赖和 `dsh.profile.bundles` 条目，然后**重启 app**；`status` 显示 `Snapshot: STALE` 时重跑安装脚本 |
| 改了 `agent\` 但桌面端没变 | 重跑 `install-dsh-plugin.ps1`（脚本检测指纹差异后 remove + add 重建快照）；只跑 `pnpm add` 不会刷新 |
| 启动时 stderr 出现 skipped bundle | `dsh: skipping profile bundle "@qbot/dsh-agent": ... cannot resolve ...` 表示 node_modules 里没有安装包；app 仍能启动（其他层继续组合），跑安装脚本补装即可 |
| pnpm 报错 | 看 `<profile>\backups\<时间戳>\pnpm-add.log`（卸载是 `pnpm-remove.log`）；脚本失败会打印日志并自动回滚 |
| 包没注册进 bundles | 只有声明了 `dsh.bundle.patch` 的包才会进 `bundles`；检查 `agent\package.json`，脚本对缺声明的包直接拒绝 |
| EADDRINUSE / 面板打不开 | 8790 被 WSL QBot 占用，Windows 桌面用 8791；`QBOT_PANEL_PORT=8792` 覆盖后重启；用 `netstat -ano` 配合 `findstr :8791` 查占用 |
| profile 被锁 | `lock` 文件存在说明 app 正在改 profile，等操作结束再跑脚本 |
| 技能没出现 | 确认 `%USERPROFILE%\.dsh\skills\<名字>\SKILL.md` 存在，重启 app；DSH 默认扫描 `~/.dsh/skills` |
| 想装到别的 DSH_HOME | `-SkillsDir` 指向对应的 skills 目录；profile 用 `-ProfileDir` |

## 相关文件

- `scripts\install-dsh-plugin.ps1` — 安装/刷新（备份 + 回滚 + `-DryRun`）
- `scripts\uninstall-dsh-plugin.ps1` — 卸载（`-KeepSkills` + 备份 + 回滚 + `-DryRun`）
- `scripts\status-dsh-plugin.ps1` — 只读状态报告
- `agent\` — bundle 本体（`package.json` 的 `dsh.bundle.patch`、`cordis.patch.yml`、`plugins\`、`skills\`）

## 自动交易循环（autopilot）说明

- 默认开启，paper 模式，每 60 分钟一轮；每轮会对 `autopilotModels` 里列出的每个模型各调用一次（默认 4 个委员会角色），会产生 API 费用。不需要就把它关掉：在 profile 用户补丁层（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）里覆盖 `qbot-core` 的 `autopilotEnabled: false`，或把 `autopilotModels` 换成你想用的模型。
- 模型路由自动适配：桌面版的模型挂在应用自带的 `opencode-go-live` 路由上（pi-ai 目录里没有 `deepseek-v4.1-flash`），插件会在调用前用 `llm.listModels` 找到真正带这个模型的路由，所以 Linux 引擎的 `opencode-go:...` 配置在桌面版也能直接跑；也可以用 `QBOT_AUTOPILOT_MODELS` 环境变量覆盖。
- 失败会明确报错：LLM 调用失败（模型不存在、鉴权失败、超时等）会带 `provider:model` 和原因写进 journal 与面板，不再伪装成「模型没返回 JSON」。
- 连续 3 轮失败、回撤超 10%、当日亏损超上限都会自动暂停开新仓；live 模式默认禁止自动运行。

## 控制台（监控 + 模式切换 + 启停）

浏览器打开 **http://127.0.0.1:8791/**（win32 默认 8791；`QBOT_PANEL_PORT` 可覆盖）。

- 顶部：模拟盘 / 测试网 / 实盘 三个模式按钮（实盘会二次确认，且需要配置 `allowLive: true`，否则会被交易台拒绝）；
  启动 / 停止自动循环、立即跑一轮、紧急平仓（reduce-only）、循环间隔（分钟）。
- 收益区：权益、今日盈亏、已实现、手续费、峰值权益、回撤、权益曲线、持仓（含未实现盈亏与止损/止盈）、最近成交。
- 多专家讨论区：每一轮委员会的每个专家（trend / reversal / news / risk …）的判断、置信度、发言、动作；
  以及历史轮次和专家战绩（投票数 / 命中 / 准确率）。
- 右下角浮动面板（可折叠 / 全屏）同步显示账户、持仓、成交与市场状态。
- 控制台调用的接口：`GET /qbot/status`、`POST /qbot/control`
  （`set_mode` / `pause` / `resume` / `run_once` / `close_all` / `set_interval` / `dream_now`）。
- 说明：控制台是插件自带的独立页面（DSH 桌面应用的界面插件是按应用挂载、不随会话 preset 切换），
  所以它不在应用窗口内，而是一个本机页面；打开后可固定在浏览器或做成桌面快捷方式。

### 应用内按钮（推荐用法）

装好插件并重启 DeepSeek Harness 后，会话输入框那一行会多出一个 **QBot 控制台** 按钮：

- **只有会话 preset 是「QBot Trading Agent」（id `qbot`）时才出现**；极简模式、创造模式等其它 preset 下按钮不渲染；切走时自动收起面板；
- 按钮边框绿色 = 本机 QBot host 有响应（鼠标悬停显示模式与权益）；红色 = host 未连接；
- 判据来自会话的 `agentPreset` 投影值（与会话头部那个 preset 标签同源）；应急强制显示：控制台执行 `localStorage.setItem("qbot-console-always","1")` 后刷新页面。
- 点一下在窗口右上浮出完整面板（模式切换 / 启动停止 / 立即跑一轮 / 紧急平仓 / 间隔 / 收益 / 多专家讨论），再点收起；
- 面板端口可配置：客户端会依次探测 8791 / 8790 / 8792 / 8793，用第一个响应的那个；
- 安全：面板只监听 127.0.0.1；`/qbot/control` 会校验来源，只接受本机来源（无 Origin 或 `http://127.0.0.1:*` / `http://localhost:*`），其他站点发起的请求返回 403，避免网页偷偷暂停循环或平仓。

## 独立引擎模式已移除

如需重建已删除的 `dsh-base` 引擎副本（仅供历史参考）：

```bash
git clone https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git dsh-base/source
cd dsh-base/source && git checkout 0b3d39d2   # 删除时的 HEAD
```

（备份目录 `_qbot-cleanup-20260930` 已按用户要求删除，其中包含旧 `~/.qbot-dsh` 的 tar 包。）

2026-09-30：`dsh-base/`（引擎源码副本）、`home`、`run-qbot.sh`、`launcher/` 与旧引擎脚本已删除，
WSL 侧的 `~/.qbot-dsh`、`~/.qbot-engine` 也已清理（备份：`D:\klein\code_agent\_qbot-cleanup-20260930\`）。
现在只有插件模式：桌面版 profile 安装 `@qbot/dsh-agent`，C++ 内核仍走 `cpp/qbot_cpp`（Windows 经 WSL 调用）。

## 状态与日志落在哪

- desk 状态：`<DSH_HOME>/desk/state.json`（桌面版 `%USERPROFILE%\.dsh\desk\state.json`；`QBOT_STATE_DIR` 可覆盖）
- autopilot journal 与 Dream-RSI 数据：`<DSH_HOME>/workspace/{journal,dream}`（桌面版 `%USERPROFILE%\.dsh\workspace`；`QBOT_WORKSPACE` 可覆盖）
- 技能：安装脚本播种到 `%USERPROFILE%\.dsh\skills\`，autopilot 的复盘也写回同一份
- 桌面 Host 不设置 `DSH_HOME` 环境变量（home 以启动参数传入），所以插件统一回落到 `~/.dsh`：**不会再写 `~/.qbot-dsh`**
