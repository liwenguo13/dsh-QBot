/**
 * QBot trading-desk tools: market data, analysis, news, and order execution.
 *
 * These are the model's hands in the market. Everything here is a primitive —
 * the model reads the market, forms a view, sizes a position, and sends an
 * order; the desk enforces the hard risk rails (leverage, notional, daily
 * loss, kill switch) and the live-mode confirmation gate.
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDesk } from '../lib/desk.mjs'
import { createMarket, DEFAULT_NEWS_SOURCES, fearGreed, fetchNews, indicators, normalizeSymbol } from '../lib/market.mjs'

export const name = 'qbot-desk'
export const inject = ['tools']

/** Desk, market, and safety configuration resolved from cordis.yml. */
export const Config = z.object({
  /** Where the desk state lives; defaults to `$DSH_HOME/desk`. */
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
  /** Local HTTP port for the QBot home panel. */
  panelPort: z.natural().default(8790),
  /** Symbol shown in the home panel market strip. */
  panelSymbol: z.string().default('BTCUSDT'),
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
  const stateDir = config.stateDir !== '' ? config.stateDir : resolve(home, 'desk')
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
    }
  }

  /** Tiny CORS-enabled JSON server consumed by apps/web/public/qbot-panel.js. */
  const panelPort = Number(config.panelPort) || 8790
  const panelServer = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
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
    panelServer.on('error', (error) => ctx.logger?.warn?.(`[qbot-desk] panel server error: ${error.message}`))
    panelServer.listen(panelPort, '127.0.0.1', () => ctx.logger?.info?.(`[qbot-desk] home panel JSON on http://127.0.0.1:${panelPort}/qbot/status`))
    return () => panelServer.close()
  }, 'qbot home panel server')

  ctx.tools.register(defineTool({
    name: 'market_data',
    description: 'Read public market data: ticker/24h stats, OHLCV candles, order book depth, funding rate, or contract metadata.',
    parameters: {
      kind: { type: 'string', enum: ['ticker', 'candles', 'depth', 'funding', 'contract'], required: true, description: 'which reading to fetch' },
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT or BTC_USDT' },
      interval: { type: 'string', description: 'candle interval for kind=candles: 1m 5m 15m 30m 1h 4h 1d (default 5m)' },
      limit: { type: 'number', description: 'candles or depth levels (default 100 candles, 20 levels)' },
    },
    output: textOutput,
    async execute(args) {
      const symbol = normalizeSymbol(args.symbol)
      switch (args.kind) {
        case 'ticker':
          return json(await market.ticker(args.symbol))
        case 'candles': {
          const limit = Math.min(1000, Math.max(10, Number(args.limit ?? 100)))
          const candles = await market.candles(args.symbol, args.interval ?? '5m', limit)
          return json({
            symbol: symbol.gate,
            interval: args.interval ?? '5m',
            count: candles.length,
            candles: candles.map(candle => ({ t: new Date(candle.t).toISOString(), o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v })),
          })
        }
        case 'depth': {
          const levels = Math.min(50, Math.max(5, Number(args.limit ?? 20)))
          const book = await market.depth(args.symbol, levels)
          const bestBid = book.bids[0]?.price
          const bestAsk = book.asks[0]?.price
          const spread = bestBid !== undefined && bestAsk !== undefined ? Number((bestAsk - bestBid).toFixed(8)) : undefined
          return json({ ...book, spread })
        }
        case 'funding':
          return json(await market.funding(args.symbol))
        case 'contract':
          return json(await market.contract(args.symbol))
        default:
          throw new Error(`unknown kind "${args.kind}"`)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_indicators',
    description: 'Compute technical indicators from candles (SMA/EMA, RSI, MACD, ATR, Bollinger, volume ratio). Arithmetic over observed prices, not a signal.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      interval: { type: 'string', description: 'candle interval (default 15m)' },
      limit: { type: 'number', description: 'candles to analyze (default 300, max 1000)' },
      period: { type: 'number', description: 'fast EMA/RSI period (default 14)' },
    },
    output: textOutput,
    async execute(args) {
      const limit = Math.min(1000, Math.max(60, Number(args.limit ?? 300)))
      const candles = await market.candles(args.symbol, args.interval ?? '15m', limit)
      return json({
        symbol: normalizeSymbol(args.symbol).gate,
        interval: args.interval ?? '15m',
        ...indicators(candles, Math.max(2, Number(args.period ?? 14))),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_news',
    description: 'Fetch recent crypto headlines from public RSS sources and the Fear & Greed index.',
    parameters: {
      sources: { type: 'array', items: { type: 'string', enum: Object.keys(DEFAULT_NEWS_SOURCES) }, description: `subset of ${Object.keys(DEFAULT_NEWS_SOURCES).join(', ')}` },
      limit: { type: 'number', description: 'items per source (default 6)' },
    },
    output: textOutput,
    async execute(args) {
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 6)))
      const [news, sentiment] = await Promise.all([
        fetchNews({ sources: args.sources, limit }),
        fearGreed().catch(() => undefined),
      ])
      return json({ ...news, fearGreed: sentiment })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_status',
    description: 'Read the trading desk: mode, account equity and PnL, open positions with unrealized PnL, open orders, and risk limits.',
    parameters: {},
    output: textOutput,
    async execute() {
      return json(await desk.status())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_order',
    description: 'Place one order on the active desk (paper/testnet/live). Size with notional (USDT) or qty (base units). Entries may attach stop_loss and take_profit prices. Risk caps are enforced and refusals explain why.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      side: { type: 'string', enum: ['long', 'short'], required: true, description: 'long buys, short sells' },
      type: { type: 'string', enum: ['market', 'limit'], description: 'default market' },
      notional: { type: 'number', description: 'order size in USDT, e.g. 200' },
      qty: { type: 'number', description: 'order size in base units; wins over notional' },
      price: { type: 'number', description: 'limit price (required for type=limit)' },
      leverage: { type: 'number', description: 'leverage for this entry (default from config)' },
      stop_loss: { type: 'number', description: 'protective stop price' },
      take_profit: { type: 'number', description: 'protective target price' },
      reduce_only: { type: 'boolean', description: 'true only closes an existing opposite position' },
    },
    output: textOutput,
    async execute(args) {
      const type = args.type === 'limit' ? 'limit' : 'market'
      if (type === 'limit' && !(Number(args.price) > 0)) throw new Error('type=limit requires a positive price')
      return json(await desk.order({
        symbol: args.symbol,
        side: args.side,
        type,
        notional: args.notional === undefined ? undefined : Number(args.notional),
        qty: args.qty === undefined ? undefined : Number(args.qty),
        price: args.price === undefined ? undefined : Number(args.price),
        leverage: args.leverage === undefined ? undefined : Number(args.leverage),
        stopLoss: args.stop_loss === undefined ? undefined : Number(args.stop_loss),
        takeProfit: args.take_profit === undefined ? undefined : Number(args.take_profit),
        reduceOnly: args.reduce_only === true,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_cancel',
    description: 'Cancel one order by id, or every open order for a symbol when no id is given.',
    parameters: {
      symbol: { type: 'string', description: 'symbol whose open orders should be canceled' },
      order_id: { type: 'string', description: 'exact order id to cancel' },
    },
    output: textOutput,
    async execute(args) {
      return json(await desk.cancel({ symbol: args.symbol, id: args.order_id }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_close',
    description: 'Close all or part of one open position at market. On the live desk a close additionally needs confirmation="CLOSE".',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      qty: { type: 'number', description: 'base units to close; default closes the whole position' },
      confirmation: { type: 'string', description: 'must be CLOSE on the live desk' },
    },
    output: textOutput,
    async execute(args) {
      return json(await desk.close({
        symbol: args.symbol,
        qty: args.qty === undefined ? undefined : Number(args.qty),
        confirmation: args.confirmation,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_leverage',
    description: 'Set leverage for one symbol on the active desk backend (bounded by the configured cap).',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      leverage: { type: 'number', required: true, description: 'leverage >= 1' },
    },
    output: textOutput,
    async execute(args) {
      return json(await desk.setLeverage({ symbol: args.symbol, leverage: Number(args.leverage) }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_history',
    description: 'Read recent paper fills, realized PnL, fees, and the equity trail.',
    parameters: {
      limit: { type: 'number', description: 'entries to return (default 20)' },
    },
    output: textOutput,
    async execute(args) {
      return json(desk.history({ limit: Math.min(200, Math.max(1, Number(args.limit ?? 20))) }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_mode',
    description: 'Switch the trading desk between paper, testnet, and live. Live needs confirmation="LIVE" and allowLive enabled in configuration; the gate is durable until switched back.',
    parameters: {
      mode: { type: 'string', enum: ['paper', 'testnet', 'live'], required: true, description: 'target mode' },
      confirmation: { type: 'string', description: 'must be LIVE when switching to live' },
      live_backend: { type: 'string', enum: ['gateio', 'binance'], description: 'live venue, default gateio' },
    },
    output: textOutput,
    async execute(args) {
      return json(await desk.setMode(args.mode, { confirmation: args.confirmation, liveBackend: args.live_backend }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_risk',
    description: 'Read or update the desk risk rails: max leverage, per-order notional cap, gross notional cap, daily loss cap, and the kill switch.',
    parameters: {
      max_leverage: { type: 'number', description: 'new leverage cap' },
      max_order_notional: { type: 'number', description: 'new per-order USDT cap' },
      max_gross_notional: { type: 'number', description: 'new gross exposure cap in USDT' },
      max_daily_loss: { type: 'number', description: 'new daily loss cap in USDT' },
      kill_switch: { type: 'boolean', description: 'true blocks all new entries; false clears it' },
    },
    output: textOutput,
    async execute(args) {
      const patch = {
        maxLeverage: args.max_leverage,
        maxOrderNotional: args.max_order_notional,
        maxGrossNotional: args.max_gross_notional,
        maxDailyLoss: args.max_daily_loss,
        killSwitch: args.kill_switch,
      }
      return json(desk.risk(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desk_protect',
    description: 'Update stop-loss / take-profit on one paper position after entry. On live/testnet, attach protection when placing the order instead.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      stop_loss: { type: 'number', description: 'new stop-loss price' },
      take_profit: { type: 'number', description: 'new take-profit price' },
    },
    output: textOutput,
    async execute(args) {
      return json(desk.setProtection({
        symbol: args.symbol,
        stopLoss: args.stop_loss === undefined ? undefined : Number(args.stop_loss),
        takeProfit: args.take_profit === undefined ? undefined : Number(args.take_profit),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'position_size',
    description: 'Compute a risk-based position size from account equity, entry, stop, and risk budget. Returns qty, notional, leverage needed, and the resulting R multiple.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      entry: { type: 'number', required: true, description: 'planned entry price' },
      stop: { type: 'number', required: true, description: 'protective stop price' },
      risk_pct: { type: 'number', description: 'percent of equity to risk (default 1, max 5)' },
      take_profit: { type: 'number', description: 'optional target for the R calculation' },
    },
    output: textOutput,
    async execute(args) {
      const status = await desk.status()
      const equity = Number(status.account?.equity ?? status.account?.totalMarginBalance ?? status.account?.totalWalletBalance)
      const entry = Number(args.entry)
      const stop = Number(args.stop)
      const riskPct = Math.max(0.05, Math.min(5, Number(args.risk_pct ?? 1)))
      if (!Number.isFinite(equity) || equity <= 0) throw new Error('no usable account equity')
      if (!Number.isFinite(entry) || entry <= 0) throw new Error('entry must be positive')
      if (!Number.isFinite(stop) || stop <= 0) throw new Error('stop must be positive')
      const riskPerUnit = Math.abs(entry - stop)
      if (riskPerUnit <= 0) throw new Error('entry and stop must differ')
      const riskAmount = equity * riskPct / 100
      let qty = riskAmount / riskPerUnit
      let notional = qty * entry
      const maxNotional = Math.min(config.maxOrderNotional, Number(status.risk?.maxOrderNotional ?? config.maxOrderNotional))
      if (notional > maxNotional) {
        const scale = maxNotional / notional
        qty *= scale
        notional = maxNotional
      }
      const tp = Number(args.take_profit)
      const rMultiple = Number.isFinite(tp)
        ? Math.abs(tp - entry) / riskPerUnit
        : undefined
      return json({
        symbol: normalizeSymbol(args.symbol).gate,
        equity: round(equity, 4),
        riskPct,
        riskAmount: round(riskAmount, 4),
        entry,
        stop,
        qty: round(qty, 10),
        notional: round(notional, 4),
        oneR: round(riskAmount, 4),
        takeProfit: Number.isFinite(tp) ? tp : undefined,
        rMultiple: rMultiple === undefined ? undefined : round(rMultiple, 3),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'market_regime',
    description: 'Classify the current market regime for one symbol from 4h candles: trend up/down, range, or chaotic; includes volatility and momentum context. Descriptive only, not a trade signal.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'e.g. BTCUSDT' },
      interval: { type: 'string', description: 'analysis interval, default 4h' },
      lookback: { type: 'number', description: 'candles to analyze, default 300' },
    },
    output: textOutput,
    async execute(args) {
      const interval = args.interval ?? '4h'
      const lookback = Math.min(1000, Math.max(120, Number(args.lookback ?? 300)))
      const candles = await market.candles(args.symbol, interval, lookback)
      const ind = indicators(candles, 14)
      const close = Number(ind.last)
      const atrPct = Number(ind.atrPercent)
      const emaFast = Number(ind.emaFast)
      const emaSlow = Number(ind.emaSlow)
      const ema200 = Number(ind.ema200)
      const rsi = Number(ind.rsi)
      const macdHist = Number(ind.macd?.hist)
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
      const bias = regime === 'trend_up' && rsi < 70
        ? 'long_pullback_preferred'
        : regime === 'trend_down' && rsi > 30
          ? 'short_pullback_preferred'
          : 'wait_for_confirmation'
      return json({
        symbol: normalizeSymbol(args.symbol).gate,
        interval,
        regime,
        volatility,
        bias,
        last: close,
        atrPercent: Number.isFinite(atrPct) ? round(atrPct, 3) : undefined,
        rsi: Number.isFinite(rsi) ? round(rsi, 2) : undefined,
        emaFast: Number.isFinite(emaFast) ? emaFast : undefined,
        emaSlow: Number.isFinite(emaSlow) ? emaSlow : undefined,
        ema200: Number.isFinite(ema200) ? ema200 : undefined,
        macdHist: Number.isFinite(macdHist) ? macdHist : undefined,
        bollingerPosition: ind.bollinger?.position,
        volumeRatio: ind.volumeRatio,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_append',
    description: 'Append one timestamped line to the QBot workspace trading journal.',
    parameters: {
      text: { type: 'string', required: true, description: 'entry to append' },
      tags: { type: 'array', items: { type: 'string' }, description: 'optional short tags' },
    },
    output: textOutput,
    async execute(args) {
      const workspace = process.env.QBOT_WORKSPACE ?? resolve(homedir(), '.qbot-dsh', 'workspace')
      const dir = resolve(workspace, 'journal')
      await mkdir(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      const file = resolve(dir, `${day}.md`)
      const tags = Array.isArray(args.tags) && args.tags.length > 0 ? ` [${args.tags.join(', ')}]` : ''
      const line = `- ${new Date().toISOString()}${tags} ${String(args.text).trim()}\n`
      await appendFile(file, line, 'utf8')
      return json({ ok: true, file, appended: line.trim() })
    },
  }))
}
