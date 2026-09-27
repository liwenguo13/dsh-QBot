/**
 * QBot trading-desk tools: market data, analysis, news, and order execution.
 *
 * These are the model's hands in the market. Everything here is a primitive —
 * the model reads the market, forms a view, sizes a position, and sends an
 * order; the desk enforces the hard risk rails (leverage, notional, daily
 * loss, kill switch) and the live-mode confirmation gate.
 */
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDesk } from '../lib/desk.mjs'
import { createMarket, DEFAULT_NEWS_SOURCES, fearGreed, fetchNews, indicators, normalizeSymbol } from '../lib/market.mjs'

export const name = 'qbot-core'
export const inject = ['tools']

/** Desk, market, and safety configuration resolved from cordis.yml. */
export const Config = z.object({
  /** Where the desk state lives; defaults to `$QBOT_STATE_DIR` or `$DSH_HOME/desk`. */
  stateDir: z.string().default(''),
  /** Public market data source: gateio | binance-spot | binance-testnet. */
  marketProvider: z.string().default('gateio'),
  /** Paper account starting wallet in USDT. */
  paperWallet: z.number().default(10_000),
  /** Taker fee applied to both paper fills, as a fraction. */
  takerFeeRate: z.number().default(0.0005),
  /** Maintenance margin rate used for paper liquidation estimates. */
  maintenanceRate: z.number().default(0.005),
  /** Leverage used when an order names none. */
  defaultLeverage: z.number().default(3),
  maxLeverage: z.number().default(5),
  maxOrderNotional: z.number().default(2_000),
  maxGrossNotional: z.number().default(10_000),
  /** Daily loss (USDT) that stops new entries for the rest of the day. */
  maxDailyLoss: z.number().default(500),
  /** Live trading stays disabled until this is turned on deliberately. */
  allowLive: z.boolean().default(false),
  /** Live venue: gateio (reachable) or binance. */
  liveBackend: z.union(['gateio', 'binance']).default('gateio'),
  timeoutMs: z.natural().default(15_000),
  /** Credential reference names resolved through the DSH credential store, then the environment. */
  binanceKeyRef: z.string().default('BINANCE_API_KEY'),
  binanceSecretRef: z.string().default('BINANCE_API_SECRET'),
  gateKeyRef: z.string().default('GATE_API_KEY'),
  gateSecretRef: z.string().default('GATE_API_SECRET'),
  /** Local HTTP port for the QBot home panel; the bundle patch uses 8791 on Windows (the WSL engine owns 8790). */
  panelPort: z.natural().default(8790),
  /** Symbol shown in the home panel market strip. */
  panelSymbol: z.string().default('BTCUSDT'),
  /** Compiled C++ risk kernel used as an extra entry gate; empty = bundle-relative, then WSL on Windows. */
  cppBinPath: z.string().default(''),
  /** WSL distro used on Windows; empty = first installed distro. */
  cppWslDistro: z.string().default(''),
  /** Linux path of the ELF inside that distro; empty = derive it from the bundle/source checkout. */
  cppWslBinPath: z.string().default(''),
  /** Percent of equity risked by the C++ engine when validating an entry. */
  cppRiskPct: z.number().default(1),
  cppTimeoutMs: z.natural().default(10_000),
  /** Autonomous trading loop. It runs in paper/testnet by default. */
  autopilotEnabled: z.boolean().default(true),
  autopilotIntervalMinutes: z.natural().default(60),
  autopilotStartupDelaySeconds: z.natural().default(20),
  autopilotSymbols: z.string().default('BTCUSDT,ETHUSDT,SOLUSDT'),
  autopilotProvider: z.string().default('opencode-go'),
  autopilotModel: z.string().default('deepseek-v4.1-flash'),
  autopilotMaxTokens: z.natural().default(16000),
  autopilotAllowTestnet: z.boolean().default(true),
  autopilotAllowLive: z.boolean().default(false),
  /** Comma-separated provider:model@role committee members. One entry disables committee mode. */
  autopilotModels: z.string().default('opencode-go:deepseek-v4.1-flash'),
  /** Reasoning effort passed to every direct QBot LLM call. */
  autopilotReasoningEffort: z.string().default('max'),
  /** Minimum weighted agreement before a committee signal is acted on. */
  autopilotCommitteeMinAgreement: z.number().default(0.6),
  /** Peak-to-current equity drawdown that pauses new entries. */
  autopilotMaxDrawdownPct: z.number().default(10),
  /** Consecutive cycle failures before autopilot pauses itself. */
  autopilotMaxConsecutiveErrors: z.natural().default(3),
  /** Equity samples retained for the console chart. */
  autopilotEquityHistoryLimit: z.natural().default(500),
  /** Run a self-review every N cycles (0 disables). */
  autopilotReviewIntervalCycles: z.natural().default(20),
  /** When true, a review may replace SKILL.md after writing a backup. */
  autopilotAutoEditSkill: z.boolean().default(false),
  /** Portfolio heat cap in percent of equity (open stop-risk). */
  autopilotMaxPortfolioHeatPct: z.number().default(3.0),
  /** Same-direction pair correlation above this is treated as duplicated risk. */
  autopilotMaxPairCorrelation: z.number().default(0.85),
  /** Dream-RSI style offline replay of exploration controllers. */
  dreamEnabled: z.boolean().default(true),
  dreamIntervalCycles: z.natural().default(20),
  dreamMinImprovement: z.number().default(0.0001),
  dreamMaxCandidates: z.natural().default(12),
  /** Adverse slippage applied by the C++ paper-sim replay, in basis points. */
  dreamSlippageBps: z.number().default(2),
  /** Allow model-generated controller code to affect live decisions (sandboxed). */
  dreamAllowControllerCode: z.boolean().default(true),
})

/** Pretty JSON tool output. */
function json(value) {
  return JSON.stringify(value, null, 2)
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Mount the desk tool set.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    ctx.logger?.error?.('[qbot-desk] ctx.tools is unavailable; trading tools were not registered')
    return
  }

  const credentials = (() => {
    try {
      return ctx.get?.('credentials')
    } catch {
      return undefined
    }
  })()

  /** Resolve one credential reference through the store, then the environment. */
  const resolveCredential = async (ref) => {
    if (ref === undefined || ref === '') return undefined
    if (credentials?.resolve !== undefined) {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved?.key) return resolved.key
      } catch {}
    }
    const value = process.env[ref]
    return value !== undefined && value.length > 0 ? value : undefined
  }

  const home = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  const stateDir = config.stateDir !== ''
    ? config.stateDir
    : (process.env.QBOT_STATE_DIR ? process.env.QBOT_STATE_DIR : resolve(home, 'desk'))
  const market = createMarket(config.marketProvider)
  const desk = createDesk({
    stateDir,
    market,
    resolveCredential,
    config: {
      paperWallet: config.paperWallet,
      takerFeeRate: config.takerFeeRate,
      maintenanceRate: config.maintenanceRate,
      defaultLeverage: config.defaultLeverage,
      maxLeverage: config.maxLeverage,
      maxOrderNotional: config.maxOrderNotional,
      maxGrossNotional: config.maxGrossNotional,
      maxDailyLoss: config.maxDailyLoss,
      allowLive: config.allowLive,
      liveBackend: config.liveBackend,
      timeoutMs: config.timeoutMs,
      credentials: {
        binanceApiKey: config.binanceKeyRef,
        binanceApiSecret: config.binanceSecretRef,
        gateApiKey: config.gateKeyRef,
        gateApiSecret: config.gateSecretRef,
      },
    },
  })

  ctx.logger?.info?.(`[qbot-desk] desk ready at ${stateDir} mode=${desk.mode().mode} market=${config.marketProvider} allowLive=${config.allowLive}`)

  // Shared mutable autopilot status consumed by the home panel and the
  // qbot-autopilot loop itself.
  const autopilotState = {
    enabled: config.autopilotEnabled === true,
    running: false,
    cycle: 0,
    startedAt: null,
    lastRunAt: null,
    nextRunAt: null,
    lastDecision: null,
    lastError: null,
    lastActions: [],
    lastSummary: '',
    lastRegime: '',
    decisionHistory: [],
    consecutiveErrors: 0,
    pauseReason: null,
    lastPauseAt: null,
    equityHistory: [],
    peakEquity: null,
    drawdownPct: 0,
    modelStats: {},
    pendingVotes: [],
    reviews: [],
    lastPortfolio: null,
    dreamController: null,
    dreamScore: null,
    dreamNodeCount: 0,
    dreamLastResult: null,
    dreamHistory: [],
    dreamRunning: false,
    dreamLastRunAt: null,
    dreamLastError: null,
  }
  const qbotCore = { market, desk, config, autopilotState, autopilotControl: null }

  /** Build a compact status payload for the QBot home panel. */
  const panelStatus = async () => {
    const status = await desk.status()
    const history = desk.history({ limit: 8 })
    let marketStrip
    try {
      const ticker = await market.ticker(config.panelSymbol)
      const candles = await market.candles(config.panelSymbol, '1h', 200)
      const ind = indicators(candles, 14)
      const close = Number(ind.last)
      const atrPct = Number(ind.atrPercent)
      const emaFast = Number(ind.emaFast)
      const emaSlow = Number(ind.emaSlow)
      const ema200 = Number(ind.ema200)
      let regime = 'range'
      if (Number.isFinite(emaFast) && Number.isFinite(emaSlow) && Number.isFinite(ema200)) {
        if (close > ema200 && emaFast > emaSlow) regime = 'trend_up'
        else if (close < ema200 && emaFast < emaSlow) regime = 'trend_down'
      }
      let volatility = 'normal'
      if (Number.isFinite(atrPct)) {
        if (atrPct >= 4) volatility = 'high'
        else if (atrPct <= 1.2) volatility = 'low'
      }
      if (regime === 'range' && volatility === 'high') regime = 'chaotic'
      marketStrip = {
        symbol: normalizeSymbol(config.panelSymbol).gate,
        last: close,
        changePercent: ind.changePercent,
        atrPercent: Number.isFinite(atrPct) ? atrPct : undefined,
        rsi: ind.rsi,
        regime,
        volatility,
        ticker: { last: ticker.last, mark: ticker.mark },
      }
    } catch (error) {
      marketStrip = { symbol: normalizeSymbol(config.panelSymbol).gate, error: String(error?.message ?? error) }
    }
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      mode: status.mode,
      account: status.account,
      positions: status.positions,
      orders: status.orders,
      recentFills: history.fills,
      market: marketStrip,
      autopilot: autopilotState,
    }
  }

  /** Static console assets shipped with the bundle: served below so the desktop install has a UI. */
  const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

  /** Tiny CORS-enabled JSON server: JSON API plus the standalone QBot console page. */
  const panelPort = Number(config.panelPort) || 8790
  const panelServer = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname

    // The standalone console (monitoring + committee + mode switch + start/stop).
    if (pathname === '/' || pathname === '/console') {
      try {
        const body = await readFile(resolve(assetsDir, 'qbot-console.html'))
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(body)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(String(error?.message ?? error))
      }
      return
    }

    // Floating monitor asset (the same script the QBot engine web app loads).
    if (pathname === '/qbot-panel.js') {
      try {
        const body = await readFile(resolve(assetsDir, 'qbot-panel.js'))
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
        response.end(body)
      } catch (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('not found')
      }
      return
    }

    if (pathname === '/qbot/control' && request.method === 'POST') {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const action = String(payload.action ?? '').toLowerCase()
        if (action === 'pause') {
          autopilotState.enabled = false
          qbotCore.autopilotControl?.pause?.()
        } else if (action === 'resume') {
          autopilotState.enabled = true
          qbotCore.autopilotControl?.resume?.()
        } else if (action === 'run_once') {
          const started = qbotCore.autopilotControl?.runNow?.()
          if (started !== true && autopilotState.running !== true) throw new Error('autopilot is not ready to run')
        } else if (action === 'dream_now') {
          const started = qbotCore.autopilotControl?.runDream?.()
          if (started !== true && autopilotState.dreamRunning !== true) throw new Error('dream replay is not ready')
        } else if (action === 'close_all') {
          // Emergency de-risking: close paper/exchange positions through the
          // desk, which keeps reduce-only semantics.
          const status = await desk.status()
          for (const position of status.positions ?? []) {
            try { await desk.close({ symbol: position.symbol, confirmation: 'CLOSE' }) } catch {}
          }
        } else if (action === 'set_mode') {
          // Mode switch from the console; live still needs the durable LIVE confirmation
          // and allowLive=true in configuration, exactly like the desk_mode tool.
          const mode = String(payload.mode ?? '').toLowerCase()
          if (!['paper', 'testnet', 'live'].includes(mode)) throw new Error('mode must be paper, testnet, or live')
          await desk.setMode(mode, { confirmation: payload.confirmation, liveBackend: payload.live_backend })
        } else if (action === 'set_interval') {
          const minutes = Math.max(1, Math.min(24 * 60, Number(payload.minutes)))
          if (!Number.isFinite(minutes)) throw new Error('minutes must be a number')
          config.autopilotIntervalMinutes = minutes
          qbotCore.autopilotControl?.setIntervalMinutes?.(minutes)
        } else {
          throw new Error(`unknown control action "${action}"`)
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, autopilot: autopilotState }))
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
      return
    }

    if (pathname !== '/qbot/status') {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }
    try {
      const body = JSON.stringify(await panelStatus())
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(body)
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  })
  ctx.effect(() => {
    // A port already owned by another QBot engine (the WSL panel uses 8790)
    // must never take the desk down: warn and keep trading without the panel.
    panelServer.on('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        ctx.logger?.warn?.(`[qbot-desk] panel port ${panelPort} is already in use; home panel disabled, desk keeps running. Set panelPort / QBOT_PANEL_PORT to another port.`)
        return
      }
      ctx.logger?.warn?.(`[qbot-desk] panel server error: ${error.message}`)
    })
    panelServer.listen(panelPort, '127.0.0.1', () => ctx.logger?.info?.(`[qbot-desk] console on http://127.0.0.1:${panelPort}/ · JSON on http://127.0.0.1:${panelPort}/qbot/status`))
    return () => {
      if (panelServer.listening) panelServer.close()
    }
  }, 'qbot home panel server')

  // The shared market/desk instance is exposed as a Cordis service.  Task
  // plugins (market/news/risk/execution/autopilot) inject `qbotCore` and
  // register only their own contributions, so state and caches stay shared.
  if (typeof ctx.provide === 'function') {
    ctx.provide('qbotCore', qbotCore)
  } else {
    ctx.set?.('qbotCore', qbotCore)
  }
  ctx.logger?.info?.('[qbot-core] shared qbotCore service ready')
}
