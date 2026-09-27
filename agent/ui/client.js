/**
 * QBot trading console - browser half of @qbot/dsh-ui-console.
 *
 * Registers a lazy factory whose id equals the package name. React comes from
 * the browser module table. It talks to the local QBot host panel over
 * 127.0.0.1 only (GET /qbot/status, POST /qbot/control) and never sees model or
 * exchange credentials.
 */
window.__ModuleLoader__.load({
  id: '@qbot/dsh-ui-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PORTS = [8791, 8790, 8792, 8793]
    const REFRESH_MS = 5000
    const OPEN_KEY = 'qbot-console-open'

    // The toggle button and the overlay panel are two slot registrations that
    // share this one open flag.
    const listeners = new Set()
    let openState = false
    try { openState = window.localStorage.getItem(OPEN_KEY) === '1' } catch (error) { openState = false }
    function setOpen(value) {
      openState = value
      try { window.localStorage.setItem(OPEN_KEY, value ? '1' : '0') } catch (error) { /* private mode */ }
      listeners.forEach(function (notify) { notify(value) })
    }
    function useOpenState() {
      const [value, setValue] = useState(openState)
      useEffect(function () {
        const notify = function (next) { setValue(next) }
        listeners.add(notify)
        return function () { listeners.delete(notify) }
      }, [])
      return value
    }

    // The panel port is configurable (8791 on win32, 8790 on linux), so probe
    // the usual candidates once and remember the host that answered.
    let originCache = null
    async function discover() {
      if (originCache) return originCache
      for (let index = 0; index < PORTS.length; index += 1) {
        const origin = 'http://127.0.0.1:' + PORTS[index]
        try {
          const response = await fetch(origin + '/qbot/status', { cache: 'no-store' })
          if (response.ok) { await response.json(); originCache = origin; return origin }
        } catch (error) { /* try the next port */ }
      }
      return null
    }
    async function control(origin, payload) {
      const response = await fetch(origin + '/qbot/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(function () { return {} })
      if (response.ok !== true || body.ok !== true) throw new Error(body.error || ('HTTP ' + response.status))
      return body
    }

    const num = function (value, digits) {
      const parsed = Number(value)
      return isFinite(parsed) ? parsed.toFixed(digits === undefined ? 2 : digits) : '-'
    }
    const tone = function (value) {
      const parsed = Number(value)
      if (!isFinite(parsed)) return '#6f9c8c'
      return parsed > 0 ? '#5ffbc4' : (parsed < 0 ? '#ff8f8f' : '#6f9c8c')
    }
    const actionText = function (actions) {
      const list = actions || []
      if (list.length === 0) return '无动作'
      return list.map(function (action) {
        const parts = [action.action || action.type || '?', action.symbol, action.side]
        if (action.notional) parts.push('$' + num(action.notional, 0))
        if (action.leverage) parts.push('x' + action.leverage)
        if (action.stop_loss) parts.push('stop ' + num(action.stop_loss, 0))
        return parts.filter(Boolean).join(' ')
      }).join(' | ')
    }

    const panelStyle = {
      position: 'fixed', right: '16px', top: '56px', width: '460px',
      maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 96px)', overflow: 'auto',
      zIndex: 2147483000, pointerEvents: 'auto', background: '#070c0a', color: '#d9fff5',
      border: '1px solid #1d5c4b', borderRadius: '6px', boxShadow: '0 12px 40px rgba(0,0,0,.65)',
      font: '12px/1.55 Consolas,"Microsoft YaHei",monospace', padding: '10px 12px',
    }
    const buttonStyle = function (extra) {
      return Object.assign({
        background: '#0b1512', color: '#bff7e6', border: '1px solid #1d5c4b',
        borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', font: 'inherit', marginRight: '6px',
      }, extra || {})
    }
    const cellStyle = { borderBottom: '1px solid #143c31', padding: '2px 6px', textAlign: 'left', verticalAlign: 'top' }
    const headStyle = Object.assign({}, cellStyle, { color: '#7fd9bb' })

    function useStatus() {
      const [state, setState] = useState({ origin: null, data: null, error: null })
      useEffect(function () {
        let stopped = false
        const tick = async function () {
          const origin = await discover()
          if (stopped) return
          if (!origin) { setState({ origin: null, data: null, error: 'QBot host 未连接（面板端口无响应）' }); return }
          try {
            const response = await fetch(origin + '/qbot/status', { cache: 'no-store' })
            const data = await response.json()
            if (!stopped) setState({ origin: origin, data: data, error: null })
          } catch (error) {
            if (!stopped) setState({ origin: origin, data: null, error: String(error && error.message || error) })
          }
        }
        tick()
        const timer = setInterval(tick, REFRESH_MS)
        return function () { stopped = true; clearInterval(timer) }
      }, [])
      return state
    }

    function Table(props) {
      const rows = props.rows || []
      if (rows.length === 0) return h('div', { style: { color: '#6f9c8c', margin: '4px 0' } }, props.empty || '无数据')
      return h('table', { style: { borderCollapse: 'collapse', width: '100%', margin: '4px 0 8px' } },
        h('thead', null, h('tr', null, (props.head || []).map(function (title, index) { return h('th', { key: index, style: headStyle }, title) }))),
        h('tbody', null, rows.map(function (cells, rowIndex) {
          return h('tr', { key: rowIndex }, cells.map(function (cell, cellIndex) {
            if (cell && typeof cell === 'object' && cell.node) return h('td', { key: cellIndex, style: cellStyle }, cell.node)
            return h('td', { key: cellIndex, style: cellStyle }, String(cell === undefined || cell === null ? '' : cell))
          }))
        })))
    }

    function Controls(props) {
      const data = props.data || {}
      const autopilot = data.autopilot || {}
      const account = data.account || {}
      const [minutes, setMinutes] = useState('')
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(function () {
        if (autopilot.lastRunAt && autopilot.nextRunAt) {
          const computed = Math.round((new Date(autopilot.nextRunAt) - new Date(autopilot.lastRunAt)) / 60000)
          if (computed > 0) setMinutes(String(computed))
        }
      }, [autopilot.lastRunAt, autopilot.nextRunAt])
      const run = useCallback(function (payload, note) {
        setBusy(true); setMessage(note)
        control(props.origin, payload).then(function () {
          setMessage(note + ' 完成')
          if (props.onChanged) props.onChanged()
        }).catch(function (error) {
          setMessage(note + ' 失败: ' + String(error && error.message || error))
        }).then(function () { setBusy(false) })
      }, [props.origin, props.onChanged])

      const modeButton = function (mode, label, danger) {
        return h('button', {
          type: 'button', disabled: busy,
          style: buttonStyle(Object.assign({ marginRight: '4px' },
            data.mode === mode ? { background: '#0f3a2d', borderColor: '#3ee0a6', color: '#8effd2', fontWeight: 700 } : {},
            danger ? { borderColor: '#7a2b2b', color: '#ffc9c9' } : {})),
          onClick: function () {
            const payload = { action: 'set_mode', mode: mode }
            if (mode === 'live') {
              if (!window.confirm('切到实盘会使用真实资金，且需要配置 allowLive: true。确认切换？')) return
              payload.confirmation = 'LIVE'
            }
            run(payload, '切换到 ' + mode)
          },
        }, label)
      }

      return h('div', null,
        h('div', { style: { margin: '6px 0' } },
          modeButton('paper', '模拟盘', false),
          modeButton('testnet', '测试网', false),
          modeButton('live', '实盘', true),
          h('span', { style: { color: '#6f9c8c' } }, '权益 ' + num(account.equity) + ' · 今日 ' + num(account.dayPnl))),
        h('div', { style: { margin: '6px 0' } },
          h('button', { type: 'button', disabled: busy, style: buttonStyle({ borderColor: autopilot.enabled === false ? '#3ee0a6' : '#7a2b2b' }), onClick: function () { run({ action: autopilot.enabled === false ? 'resume' : 'pause' }, autopilot.enabled === false ? '启动循环' : '停止循环') } }, autopilot.enabled === false ? '启动' : '停止'),
          h('button', { type: 'button', disabled: busy, style: buttonStyle(), onClick: function () { run({ action: 'run_once' }, '立即跑一轮') } }, '立即跑一轮'),
          h('button', { type: 'button', disabled: busy, style: buttonStyle({ borderColor: '#7a2b2b', color: '#ffc9c9' }), onClick: function () { if (window.confirm('平掉当前所有持仓（reduce-only）？')) run({ action: 'close_all' }, '紧急平仓') } }, '紧急平仓')),
        h('div', { style: { margin: '6px 0' } },
          h('span', null, '间隔 '),
          h('input', { type: 'number', min: 1, max: 1440, value: minutes, onChange: function (event) { setMinutes(event.target.value) }, style: { width: '64px', background: '#0b1512', color: '#d9fff5', border: '1px solid #1d5c4b', borderRadius: '4px', padding: '2px 6px', font: 'inherit' } }),
          h('span', null, ' 分钟 '),
          h('button', { type: 'button', disabled: busy, style: buttonStyle(), onClick: function () { run({ action: 'set_interval', minutes: Number(minutes) }, '应用间隔') } }, '应用')),
        message ? h('div', { style: { color: '#ffd479', margin: '4px 0' } }, message) : null)
    }

    function Panel(props) {
      const status = useStatus()
      const data = status.data || {}
      const autopilot = data.autopilot || {}
      const account = data.account || {}
      const history = autopilot.decisionHistory || []
      const latest = history.length > 0 ? history[history.length - 1] : null
      const members = latest && latest.committee && latest.committee.members ? latest.committee.members : []
      const positions = data.positions || []
      const fills = (data.recentFills || []).slice(-6).reverse()
      const stats = autopilot.modelStats || {}

      const memberRows = members.map(function (member) {
        return [member.model, member.ok ? 'ok' : ('失败: ' + String(member.error || '').slice(0, 60)), member.regime || '-', num(member.confidence), member.summary || '', actionText(member.actions)]
      })
      const positionRows = positions.map(function (position) {
        return [position.symbol, position.side, num(position.qty, 6), num(position.entryPrice || position.entry), num(position.markPrice || position.mark), h('span', { style: { color: tone(position.unrealizedPnl !== undefined ? position.unrealizedPnl : position.pnl) } }, num(position.unrealizedPnl !== undefined ? position.unrealizedPnl : position.pnl))]
      })
      const fillRows = fills.map(function (fill) {
        return [String(fill.at || fill.time || '').slice(0, 19).replace('T', ' '), fill.symbol, fill.side, num(fill.qty, 6), num(fill.price), h('span', { style: { color: tone(fill.realizedPnl) } }, num(fill.realizedPnl))]
      })
      const statRows = Object.keys(stats).map(function (key) {
        const row = stats[key] || {}
        const accuracy = row.votes ? (Number(row.correct || 0) / Number(row.votes)) : 0
        return [key, num(row.votes, 0), num(row.correct, 0), row.votes ? (accuracy * 100).toFixed(0) + '%' : '-']
      })
      const older = history.slice(-6, -1).reverse().map(function (entry) {
        return h('div', { key: String(entry.cycle) + String(entry.at), style: { borderTop: '1px solid #143c31', paddingTop: '4px', marginTop: '4px' } },
          h('div', { style: { color: '#9fe8cd' } }, 'cycle ' + entry.cycle + ' · ' + String(entry.at || '').slice(0, 19).replace('T', ' ') + ' · ' + String(entry.regime || '') + ' · conf ' + num(entry.confidence)),
          h('div', { style: { color: '#bff7e6' } }, String(entry.summary || '').slice(0, 400)),
          h('div', { style: { color: '#6f9c8c' } }, actionText(entry.actions)))
      })

      return h('div', { style: panelStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' } },
          h('strong', { style: { color: '#5ffbc4' } }, 'QBot 控制台'),
          h('span', null,
            h('span', { style: { color: '#6f9c8c', marginRight: '8px' } }, data.mode ? ('模式 ' + data.mode) : '未连接'),
            h('button', { type: 'button', style: buttonStyle(), onClick: function () { setOpen(false) } }, '收起'))),
        status.error ? h('div', { style: { color: '#ff8f8f', margin: '4px 0' } }, status.error) : null,
        h('div', { style: { color: '#9fe8cd', margin: '4px 0' } },
          '权益 ' + num(account.equity) + ' · 今日 ' + num(account.dayPnl) + ' · 已实现 ' + num(account.realizedPnl) + ' · 手续费 ' + num(account.totalFees) +
          ' · 持仓 ' + positions.length + ' · 循环 ' + (autopilot.enabled === false ? '已停止' : (autopilot.running ? '运行中' : '待命')) + ' · cycle ' + num(autopilot.cycle, 0) +
          ' · 下次 ' + (autopilot.nextRunAt ? new Date(autopilot.nextRunAt).toLocaleString() : '-')),
        autopilot.pauseReason ? h('div', { style: { color: '#ffd479' } }, '暂停: ' + autopilot.pauseReason) : null,
        autopilot.lastError ? h('div', { style: { color: '#ff8f8f' } }, '最近错误: ' + String(autopilot.lastError).slice(0, 300)) : null,
        status.origin ? h(Controls, { origin: status.origin, data: data }) : null,
        h('div', { style: { color: '#5ffbc4', marginTop: '8px' } }, '多专家讨论（最新一轮）'),
        latest ? h('div', null,
          h('div', { style: { color: '#bff7e6' } }, String(latest.summary || '').slice(0, 600)),
          h('div', { style: { color: '#6f9c8c' } }, '最终动作: ' + actionText(latest.actions)),
          h(Table, { head: ['专家', '状态', '判断', '置信度', '发言', '动作'], rows: memberRows, empty: '本轮无专家返回' })) : h('div', { style: { color: '#6f9c8c' } }, '还没有决策记录'),
        h('div', { style: { color: '#5ffbc4', marginTop: '8px' } }, '持仓'),
        h(Table, { head: ['品种', '方向', '数量', '开仓', '标记', '浮盈'], rows: positionRows, empty: '当前无持仓' }),
        h('div', { style: { color: '#5ffbc4' } }, '最近成交'),
        h(Table, { head: ['时间', '品种', '方向', '数量', '价格', '已实现'], rows: fillRows, empty: '暂无成交' }),
        statRows.length > 0 ? h('div', null, h('div', { style: { color: '#5ffbc4' } }, '专家战绩'), h(Table, { head: ['专家', '投票', '命中', '准确率'], rows: statRows })) : null,
        older.length > 0 ? h('div', null, h('div', { style: { color: '#5ffbc4', marginTop: '8px' } }, '历史轮次'), older) : null)
    }

    // The console is a QBot-mode surface: it renders only in a session composed
    // from the `qbot` agent preset (QBot Trading Agent). Session-scoped slots
    // pass the standard props `sessionId`, `useProjection` and `useSessions` -
    // the same accessors the shipped agent-preset label reads - so the gate needs
    // no host round trip.
    let warnedUnknownPreset = false
    function forcedOn() {
      try { return window.localStorage.getItem('qbot-console-always') === '1' } catch (error) { return false }
    }
    function usePresetGate(props) {
      const hasProjection = props && typeof props.useProjection === "function"
      const hasSessions = props && typeof props.useSessions === "function"
      const sessionId = props ? props.sessionId : undefined
      const fromProjection = hasProjection ? props.useProjection('agentPreset') : undefined
      const fromSessions = hasSessions
        ? props.useSessions(function (state) {
          const row = sessionId && state.byId ? state.byId[sessionId] : undefined
          const value = row && row.projectionValues ? row.projectionValues.agentPreset : undefined
          return typeof value === "string" ? value : undefined
        })
        : undefined
      return typeof fromSessions === "string" ? fromSessions : fromProjection
    }

    function Toggle(props) {
      const isOpen = useOpenState()
      const preset = usePresetGate(props)
      const forced = forcedOn()
      const [summary, setSummary] = useState({ ok: false })
      // Leaving QBot mode closes the panel; an unknown preset hides the button.
      useEffect(function () {
        if (preset !== 'qbot' && !forced) {
          setOpen(false)
          if (preset === undefined && warnedUnknownPreset !== true) {
            warnedUnknownPreset = true
            console.info('[qbot-console] session preset unknown; console hidden. Force with localStorage.setItem("qbot-console-always", "1")')
          }
        }
      }, [preset, forced])
      useEffect(function () {
        let stopped = false
        const tick = async function () {
          const origin = await discover()
          if (stopped) return
          if (!origin) { setSummary({ ok: false }); return }
          try {
            const response = await fetch(origin + '/qbot/status', { cache: 'no-store' })
            const data = await response.json()
            if (!stopped) setSummary({ ok: true, mode: data.mode, equity: (data.account || {}).equity, enabled: (data.autopilot || {}).enabled })
          } catch (error) { if (!stopped) setSummary({ ok: false }) }
        }
        tick()
        const timer = setInterval(tick, 15000)
        return function () { stopped = true; clearInterval(timer) }
      }, [])
      if (preset !== 'qbot' && !forced) return null
      return h('button', {
        type: 'button',
        onClick: function () { setOpen(!isOpen) },
        title: summary.ok ? ('QBot ' + summary.mode + ' · 权益 ' + num(summary.equity) + (summary.enabled === false ? ' · 循环已停止' : '')) : 'QBot host 未连接',
        style: buttonStyle({ borderColor: summary.ok ? '#3ee0a6' : '#7a2b2b', color: summary.ok ? '#8effd2' : '#ffc9c9' }),
      }, 'QBot 控制台' + (summary.ok ? '' : '（未连接）'))
    }

    function Overlay() {
      const isOpen = useOpenState()
      if (!isOpen) return null
      return h(Panel, {})
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register({ name: 'conversation.composer.dock', id: 'qbot-console-toggle', order: 20 }, Toggle)
        })
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'qbot-console-panel', order: 20 }, Overlay)
        })
      },
    }
  },
})