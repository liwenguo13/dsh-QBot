/**
 * QBot autonomous trading console.
 *
 * Loaded as a plain public script by the QBot web app. It renders either a
 * compact floating monitor or a full-screen operations console, and talks to
 * the local QBot host server on 127.0.0.1:8790. It never sees model or
 * exchange credentials.
 */
(() => {
  // Served by the QBot host itself (desktop plugin or engine), so page and API share an origin.
  const ORIGIN = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8790'
  const STATUS_URL = `${ORIGIN}/qbot/status`
  const CONTROL_URL = `${ORIGIN}/qbot/control`
  const REFRESH_MS = 10000
  const CONSOLE_KEY = 'qbot-console-mode'
  const COLLAPSED_KEY = 'qbot-panel-collapsed'

  let currentData = null

  const style = document.createElement('style')
  style.textContent = `
    #qbot-console-backdrop{position:fixed;inset:0;z-index:2147482998;background:rgba(2,6,5,.92);display:none}
    #qbot-console-backdrop.qp-show{display:block}
    #qbot-panel{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:430px;max-width:calc(100vw - 28px);max-height:calc(100vh - 28px);overflow:auto;background:#070c0a;color:#d9fff5;border:1px solid #1d5c4b;border-radius:2px;box-shadow:5px 5px 0 #020403;font:12px/1.55 "IBM Plex Mono",Consolas,"Microsoft YaHei",monospace}
    #qbot-panel.qbot-collapsed{width:auto;max-height:none}
    #qbot-panel.qbot-collapsed .qp-body{display:none}
    #qbot-panel.qbot-console{left:14px;top:14px;right:14px;bottom:14px;width:auto;max-width:none;max-height:none}
    #qbot-panel *{box-sizing:border-box}
    #qbot-panel .qp-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#0e1a16;border-bottom:1px solid #1d5c4b}
    #qbot-panel .qp-title{font-weight:700;color:#33ffcc;letter-spacing:.5px}
    #qbot-panel .qp-buttons{display:flex;gap:5px;flex-wrap:wrap}
    #qbot-panel button{background:#0a1210;border:1px solid #1d5c4b;color:#a8d8c9;padding:2px 8px;cursor:pointer;font:inherit;border-radius:2px}
    #qbot-panel button:hover{border-color:#33ffcc;color:#d9fff5}
    #qbot-panel .qp-danger{border-color:#7a2b33;color:#ffb3bb}
    #qbot-panel .qp-primary{border-color:#33ffcc;color:#33ffcc}
    #qbot-panel .qp-body{padding:10px}
    #qbot-panel.qbot-console .qp-body{max-width:1500px;margin:0 auto}
    #qbot-panel .qp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(max-width:900px){#qbot-panel .qp-grid{grid-template-columns:1fr}}
    #qbot-panel .qp-card{border:1px solid #12382e;background:#08110e;padding:9px}
    #qbot-panel .qp-card h3{margin:0 0 7px;font-size:12px;color:#33ffcc;font-weight:700;letter-spacing:.4px}
    #qbot-panel .qp-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px dashed rgba(29,92,75,.35)}
    #qbot-panel .qp-row:last-child{border-bottom:none}
    #qbot-panel .qp-muted{color:#7eab9d}
    #qbot-panel .qp-green{color:#77ff66}.qp-red{color:#ff4455}.qp-amber{color:#ffcc33}.qp-cyan{color:#33ffcc}
    #qbot-panel table{width:100%;border-collapse:collapse;margin:3px 0}
    #qbot-panel th,#qbot-panel td{text-align:left;padding:3px 4px;border-bottom:1px solid #12382e;font-weight:400;white-space:nowrap}
    #qbot-panel th{color:#7eab9d}
    #qbot-panel .qp-offline{color:#ffcc33;padding:3px 0}
    #qbot-panel .qp-decision{color:#d9fff5;border-left:2px solid #33ffcc;padding-left:7px;margin:5px 0;white-space:pre-wrap}
    #qbot-panel .qp-history-item{border-top:1px dashed #1d5c4b;padding:5px 0}
    #qbot-panel .qp-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px}
    #qbot-panel .qp-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
    #qbot-panel .qp-chip{border:1px solid #1d5c4b;padding:1px 6px;color:#a8d8c9}
  `
  document.head.appendChild(style)

  const backdrop = document.createElement('div')
  backdrop.id = 'qbot-console-backdrop'
  document.body?.appendChild(backdrop)

  const root = document.createElement('div')
  root.id = 'qbot-panel'
  if (localStorage.getItem(COLLAPSED_KEY) === '1') root.classList.add('qbot-collapsed')
  if (localStorage.getItem(CONSOLE_KEY) === '1') {
    root.classList.add('qbot-console')
    backdrop.classList.add('qp-show')
  }
  root.innerHTML = `
    <div class="qp-head">
      <span class="qp-title">■ QBot 自动交易控制台</span>
      <div class="qp-buttons">
        <button class="qp-primary qp-run" type="button">立即执行</button>
        <button class="qp-pause" type="button">暂停</button>
        <button class="qp-console-toggle" type="button">控制台</button>
        <button class="qp-collapse-toggle" type="button">收起</button>
      </div>
    </div>
    <div class="qp-body"><div class="qp-muted">正在连接 QBot host…</div></div>
  `
  const mount = () => document.body.appendChild(root)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
  const num = (value, digits = 2) => {
    const n = Number(value)
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '--'
  }
  const pnlClass = (value) => Number(value) > 0 ? 'qp-green' : Number(value) < 0 ? 'qp-red' : ''
  const zhSide = (side) => side === 'long' ? '多' : side === 'short' ? '空' : String(side ?? '--')
  const zhRegime = (regime) => ({ trend_up: '上涨趋势', trend_down: '下跌趋势', range: '区间震荡', chaotic: '混沌高波动' }[regime] ?? regime ?? '--')
  const shortTime = (value) => String(value ?? '').replace('T', ' ').slice(0, 16)

  function accountCard(data) {
    const account = data.account ?? {}
    const dayPnl = Number(account.dayPnl ?? 0)
    return `<div class="qp-card"><h3>账户</h3>
      <div class="qp-kv">
        <span class="qp-muted">权益</span><span>${num(account.equity, 2)}</span>
        <span class="qp-muted">今日盈亏</span><span class="${pnlClass(dayPnl)}">${num(dayPnl, 2)}</span>
        <span class="qp-muted">可用</span><span>${num(account.free, 2)}</span>
        <span class="qp-muted">已实现</span><span>${num(account.realizedPnl, 2)}</span>
        <span class="qp-muted">手续费</span><span>${num(account.totalFees, 2)}</span>
        <span class="qp-muted">模式</span><span class="qp-cyan">${esc(String(data.mode ?? '--').toUpperCase())}</span>
      </div>
    </div>`
  }

  function autopilotCard(data) {
    const a = data.autopilot ?? {}
    const status = a.enabled === false ? '已暂停' : a.running ? '运行中' : '待命'
    return `<div class="qp-card"><h3>AI 自动交易</h3>
      <div class="qp-kv">
        <span class="qp-muted">状态</span><span class="${a.lastError ? 'qp-red' : 'qp-green'}">${esc(status)} · 第 ${a.cycle ?? 0} 轮</span>
        <span class="qp-muted">下次唤醒</span><span>${shortTime(a.nextRunAt) || '--'}</span>
        <span class="qp-muted">上次完成</span><span>${shortTime(a.lastRunAt) || '--'}</span>
        <span class="qp-muted">当前任务</span><span>${a.running ? '模型决策中…' : '按节奏自动运行'}</span>
      </div>
      ${a.lastError ? `<div class="qp-offline">最近错误：${esc(a.lastError)}</div>` : ''}
      <div class="qp-chips">
        <span class="qp-chip">完全自动</span><span class="qp-chip">C++ 风控</span><span class="qp-chip">journal 记录</span><span class="qp-chip">${a.enabled === false ? '已暂停' : '自动循环中'}</span>
      </div>
    </div>`
  }

  function committeeCard(data) {
    const stats = data.autopilot?.modelStats ?? {}
    const rows = Object.entries(stats)
    return `<div class="qp-card"><h3>模型委员会评分</h3>
      ${rows.length ? `<table><thead><tr><th>模型</th><th>投票</th><th>命中</th><th>准确率</th><th>最近</th></tr></thead><tbody>
        ${rows.map(([model, item]) => {
          const votes = Number(item.votes ?? 0)
          const correct = Number(item.correct ?? 0)
          const accuracy = votes > 0 ? (correct / votes * 100).toFixed(1) + '%' : '--'
          return `<tr><td>${esc(model)}</td><td>${votes}</td><td>${correct}</td><td class="${Number(correct) * 2 >= votes ? 'qp-green' : 'qp-amber'}">${accuracy}</td><td>${esc(shortTime(item.lastAt))}</td></tr>`
        }).join('')}
      </tbody></table>` : '<div class="qp-muted">等待模型投票样本…</div>'}
      <div class="qp-muted" style="margin-top:4px">准确率是方向命中率，不是收益保证；样本少时仅作参考。</div>
    </div>`
  }

  function dreamCard(data) {
    const a = data.autopilot ?? {}
    const controller = a.dreamController ?? {}
    const last = a.dreamLastResult ?? {}
    const current = last.current ?? {}
    const best = last.best ?? {}
    const history = Array.isArray(a.dreamHistory) ? a.dreamHistory.slice(-4).reverse() : []
    return `<div class="qp-card"><h3>Dream-RSI 控制器进化</h3>
      <div class="qp-kv">
        <span class="qp-muted">当前控制器</span><span class="qp-cyan">${esc(controller.name ?? '--')} v${controller.version ?? '--'}</span>
        <span class="qp-muted">分支策略</span><span>${esc(controller.branchStrategy ?? 'aggregate')} ${controller.code ? '· 代码策略' : ''}</span>
        <span class="qp-muted">回放节点</span><span>${a.dreamNodeCount ?? 0}</span>
        <span class="qp-muted">回放分数</span><span>${num(a.dreamScore, 4)}</span>
        <span class="qp-muted">最近改进</span><span class="${last.improved ? 'qp-green' : 'qp-muted'}">${last.improved ? '已提升' : '保持当前'}</span>
        <span class="qp-muted">Dream 运行</span><span>${a.dreamRunning ? '回放中…' : shortTime(a.dreamLastRunAt) || '--'}</span>
      </div>
      ${a.dreamLastError ? `<div class="qp-offline">${esc(a.dreamLastError)}</div>` : ''}
      <div class="qp-muted" style="margin-top:5px">置信 ${num(controller.minConfidence, 2)} ｜ 风险x${num(controller.riskScale, 2)} ｜ 动作 ${controller.maxActions ?? '--'} ｜ 热度 ${num(controller.heatCapPct, 1)}% ｜ 相关 ${num(controller.correlationLimit, 2)}</div>
      ${current.score != null ? `<div class="qp-muted" style="margin-top:5px">当前 replay：收益 ${num(current.totalReturnPct, 3)}% ｜ 回撤 ${num(current.maxDrawdownPct, 3)}% ｜ 交易 ${current.trades ?? 0} ｜ 模型调用 ${current.modelCalls ?? 0} ｜ 手续费 ${num(current.fees, 4)} ｜ 资金费 ${num(current.fundingPnl, 4)}</div>` : ''}
      ${best.score != null ? `<div class="qp-muted">最佳 replay：收益 ${num(best.totalReturnPct, 3)}% ｜ 回撤 ${num(best.maxDrawdownPct, 3)}% ｜ 分数 ${num(best.score, 4)}</div>` : ''}
      ${history.length ? `<div class="qp-muted" style="margin-top:5px">${history.map((item) => `${esc(shortTime(item.at))} 第${item.cycle}轮 ${num(item.currentScore, 4)} → ${num(item.bestScore, 4)} ${item.improved ? '升级' : '保留'}`).join('<br>')}</div>` : '<div class="qp-muted" style="margin-top:5px">每 N 轮在真实历史上离线回放控制器。</div>'}
    </div>`
  }


  function portfolioCard(data) {
    const p = data.autopilot?.lastPortfolio
    if (!p) return `<div class="qp-card"><h3>组合风险</h3><div class="qp-muted">等待第一轮自动循环…</div></div>`
    const corr = Object.entries(p.correlations ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
    return `<div class="qp-card"><h3>组合风险</h3>
      <div class="qp-kv">
        <span class="qp-muted">组合热度</span><span class="${Number(p.heatPct) >= Number(p.maxHeatPct) * 0.8 ? 'qp-amber' : 'qp-green'}">${num(p.heatPct, 2)}% / ${num(p.maxHeatPct, 2)}%</span>
        <span class="qp-muted">总敞口</span><span>${num(p.grossNotional, 2)} (${num(p.grossPct, 2)}%)</span>
        <span class="qp-muted">止损风险额</span><span>${num(p.heatUsdt, 2)}</span>
      </div>
      ${corr.length ? `<div class="qp-muted" style="margin-top:5px">相关性：${corr.map(([pair, value]) => `${esc(pair)} ${num(value, 2)}`).join(' ｜ ')}</div>` : ''}
    </div>`
  }

  function reviewCard(data) {
    const reviews = Array.isArray(data.autopilot?.reviews) ? data.autopilot.reviews : []
    const latest = reviews.slice(-1)[0]
    return `<div class="qp-card"><h3>自动复盘</h3>
      ${latest ? `<div class="qp-muted">${esc(shortTime(latest.at))} · 第 ${latest.cycle ?? '--'} 轮</div>
        <div class="qp-decision">${esc(latest.insights || '')}</div>
        <div class="qp-muted">建议：${esc(latest.suggested || '')}</div>` : '<div class="qp-muted">每 N 轮自动复盘；暂无记录。</div>'}
    </div>`
  }

  function decisionCard(data) {
    const a = data.autopilot ?? {}
    const d = a.lastDecision ?? {}
    const actions = Array.isArray(d.actions) ? d.actions : []
    return `<div class="qp-card"><h3>最新 AI 决策</h3>
      ${d.summary ? `<div class="qp-row"><span class="qp-muted">状态</span><span class="qp-cyan">${esc(zhRegime(d.regime))}</span></div>
      <div class="qp-decision">${esc(d.summary)}</div>` : '<div class="qp-muted">暂无决策</div>'}
      ${actions.length ? `<table><thead><tr><th>动作</th><th>币种</th><th>方向</th><th>理由</th></tr></thead><tbody>
        ${actions.map((x) => `<tr><td>${esc(x.action ?? x.type ?? 'hold')}</td><td>${esc(x.symbol ?? '--')}</td><td>${esc(zhSide(x.side))}</td><td>${esc(String(x.reason ?? '').slice(0, 80))}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${Array.isArray(d._committee?.members) && d._committee.members.length ? `<div class="qp-muted" style="margin-top:5px">模型投票：${d._committee.members.map((m) => `${esc(m.model)} ${m.ok ? '✓' : '✗'} ${esc(zhRegime(m.regime))} ${num(m.confidence, 2)}`).join(' ｜ ')}</div>` : ''}
    </div>`
  }

  function positionsCard(data) {
    const positions = Array.isArray(data.positions) ? data.positions : []
    return `<div class="qp-card"><h3>当前持仓 (${positions.length})</h3>
      ${positions.length ? `<table><thead><tr><th>币种</th><th>方向</th><th>数量</th><th>入场</th><th>标记</th><th>杠杆</th><th>浮盈</th></tr></thead><tbody>
        ${positions.map((p) => `<tr><td>${esc(p.symbol)}</td><td>${esc(zhSide(p.side))}</td><td>${num(p.size, 6)}</td><td>${num(p.entry, 2)}</td><td>${num(p.mark, 2)}</td><td>${num(p.leverage, 1)}</td><td class="${pnlClass(p.unrealizedPnl)}">${num(p.unrealizedPnl, 2)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="qp-muted">暂无持仓</div>'}
    </div>`
  }

  function fillsCard(data) {
    const fills = Array.isArray(data.recentFills) ? data.recentFills : []
    return `<div class="qp-card"><h3>最近成交</h3>
      ${fills.length ? `<table><thead><tr><th>时间</th><th>币种</th><th>方向</th><th>数量</th><th>价格</th><th>盈亏</th></tr></thead><tbody>
        ${fills.map((f) => `<tr><td>${esc(shortTime(f.at))}</td><td>${esc(f.symbol)}</td><td>${esc(zhSide(f.side))}</td><td>${num(f.qty, 6)}</td><td>${num(f.price, 2)}</td><td class="${pnlClass(f.realizedPnl)}">${num(f.realizedPnl, 2)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="qp-muted">暂无成交</div>'}
    </div>`
  }

  function marketCard(data) {
    const m = data.market ?? {}
    return `<div class="qp-card"><h3>市场状态 · ${esc(m.symbol ?? '--')}</h3>
      ${m.error ? `<div class="qp-offline">行情不可用：${esc(m.error)}</div>` : `<div class="qp-kv">
        <span class="qp-muted">最新价</span><span>${num(m.last, 2)}</span>
        <span class="qp-muted">状态</span><span class="qp-cyan">${esc(zhRegime(m.regime))} / ${esc(m.volatility ?? '--')}</span>
        <span class="qp-muted">RSI</span><span>${num(m.rsi, 2)}</span>
        <span class="qp-muted">ATR%</span><span>${num(m.atrPercent, 3)}</span>
      </div>`}
    </div>`
  }

  function historyCard(data) {
    const history = Array.isArray(data.autopilot?.decisionHistory) ? data.autopilot.decisionHistory : []
    const recent = history.slice(-6).reverse()
    return `<div class="qp-card"><h3>决策时间线</h3>
      ${recent.length ? recent.map((item) => `<div class="qp-history-item">
        <div class="qp-muted">${esc(shortTime(item.at))} · 第 ${item.cycle ?? '--'} 轮 · ${esc(zhRegime(item.regime))} · ${esc(item.confidence != null ? `置信 ${num(item.confidence, 2)}` : '')}</div>
        <div>${esc(item.summary || item.noTradeReason || '')}</div>
        ${Array.isArray(item.committee?.members) ? `<div class="qp-muted">${item.committee.members.map((m) => `${esc(m.model)}:${esc(zhRegime(m.regime))}`).join(' ｜ ')}</div>` : ''}
      </div>`).join('') : '<div class="qp-muted">暂无历史</div>'}
    </div>`
  }

  function equityChart(history) {
    const points = (Array.isArray(history) ? history : []).slice(-80).map((item) => Number(item.equity)).filter((value) => Number.isFinite(value))
    if (points.length < 2) return '<div class="qp-muted">权益数据积累中…</div>'
    const min = Math.min(...points)
    const max = Math.max(...points)
    const range = max - min || 1
    const width = 360
    const height = 72
    const pad = 5
    const coords = points.map((value, index) => {
      const x = pad + (width - 2 * pad) * index / (points.length - 1)
      const y = height - pad - (height - 2 * pad) * (value - min) / range
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const rising = points[points.length - 1] >= points[0]
    const color = rising ? '#77ff66' : '#ff4455'
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:72px;background:#07100d;border:1px solid #12382e">
      <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="qp-row"><span class="qp-muted">区间</span><span>${num(min, 2)} ~ ${num(max, 2)}</span></div>`
  }

  function equityCard(data) {
    return `<div class="qp-card"><h3>权益曲线</h3>${equityChart(data.autopilot?.equityHistory)}</div>`
  }

  function render(data) {
    const body = root.querySelector('.qp-body')
    body.innerHTML = `
      <div class="qp-grid">
        ${accountCard(data)}
        ${autopilotCard(data)}
        ${equityCard(data)}
        ${decisionCard(data)}
        ${committeeCard(data)}
        ${positionsCard(data)}
        ${fillsCard(data)}
        ${marketCard(data)}
        ${portfolioCard(data)}
        ${dreamCard(data)}
      </div>
      <div style="margin-top:10px">${historyCard(data)}</div>
      <div style="margin-top:10px">${reviewCard(data)}</div>
      <div class="qp-row" style="margin-top:8px"><span class="qp-muted">数据更新</span><span>${esc(shortTime(data.generatedAt))}</span></div>
    `
    const pauseButton = root.querySelector('.qp-pause')
    pauseButton.textContent = data.autopilot?.enabled === false ? '恢复' : '暂停'
    pauseButton.classList.toggle('qp-primary', data.autopilot?.enabled === false)
  }

  async function refresh() {
    try {
      const response = await fetch(STATUS_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      currentData = await response.json()
      render(currentData)
    } catch (error) {
      root.querySelector('.qp-body').innerHTML = `<div class="qp-offline">QBot host 未连接：${esc(error.message)}</div>`
    }
  }

  async function control(action, extra = {}) {
    try {
      const response = await fetch(CONTROL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const payload = await response.json()
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      await refresh()
    } catch (error) {
      root.querySelector('.qp-body').insertAdjacentHTML('afterbegin', `<div class="qp-offline">控制失败：${esc(error.message)}</div>`)
    }
  }

  root.querySelector('.qp-run').addEventListener('click', () => control('run_once'))
  root.querySelector('.qp-pause').addEventListener('click', () => {
    const enabled = currentData?.autopilot?.enabled !== false
    control(enabled ? 'pause' : 'resume')
  })
  root.querySelector('.qp-console-toggle').addEventListener('click', () => {
    root.classList.toggle('qbot-console')
    const consoleMode = root.classList.contains('qbot-console')
    backdrop.classList.toggle('qp-show', consoleMode)
    localStorage.setItem(CONSOLE_KEY, consoleMode ? '1' : '0')
    root.querySelector('.qp-console-toggle').textContent = consoleMode ? '浮窗' : '控制台'
  })
  root.querySelector('.qp-collapse-toggle').addEventListener('click', () => {
    root.classList.toggle('qbot-collapsed')
    localStorage.setItem(COLLAPSED_KEY, root.classList.contains('qbot-collapsed') ? '1' : '0')
    root.querySelector('.qp-collapse-toggle').textContent = root.classList.contains('qbot-collapsed') ? '展开' : '收起'
  })

  // Restore button labels after mount.
  root.querySelector('.qp-console-toggle').textContent = root.classList.contains('qbot-console') ? '浮窗' : '控制台'
  root.querySelector('.qp-collapse-toggle').textContent = root.classList.contains('qbot-collapsed') ? '展开' : '收起'

  refresh()
  setInterval(refresh, REFRESH_MS)
})()
