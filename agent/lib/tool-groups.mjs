/**
 * Shared QBot tool registration groups.
 *
 * Generated from the original monolithic desk plugin and kept as separate,
 * focused registrars so market / news / risk / execution tool families can be
 * mounted as independent Cordis plugins over one shared qbotCore service.
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import { runCpp } from './cpp.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_NEWS_SOURCES, fearGreed, fetchNews, indicators, normalizeSymbol } from './market.mjs'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}


/** Call the compiled C++ risk kernel with JSON on stdin (native or WSL backend). */
export async function runCppRisk(cpp, payload, timeoutMs = 10000) {
  const { stdout } = await runCpp(cpp, ['--risk-check'], JSON.stringify(payload), timeoutMs, 'C++ execution kernel')
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`C++ kernel returned invalid JSON: ${error.message}`)
  }
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

export function registerMarketTools(ctx, { market, config }) {
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

}

export function registerNewsTools(ctx, { market, config }) {
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

}

export function registerRiskTools(ctx, { desk, config }) {
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

}

export function registerExecutionTools(ctx, { desk, config }) {
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
      const reduceOnly = args.reduce_only === true
      let cppRisk
      let notional = args.notional === undefined ? undefined : Number(args.notional)
      let qty = args.qty === undefined ? undefined : Number(args.qty)

      // Risk-increasing entries must carry a protective stop and are validated
      // by the compiled C++ kernel before the desk sees the order.
      if (!reduceOnly) {
        const stopLoss = Number(args.stop_loss)
        if (!(stopLoss > 0)) throw new Error('desk_order entries require stop_loss; refusing to open risk without a protective stop')
        const ticker = await desk.market.ticker(args.symbol)
        const entry = Number(args.price) > 0 ? Number(args.price) : Number(ticker.mark ?? ticker.last)
        if (!(entry > 0)) throw new Error('no usable reference price for C++ risk validation')
        const status = await desk.status()
        const equity = Number(status.account?.equity ?? status.account?.totalMarginBalance ?? status.account?.totalWalletBalance)
        if (!(equity > 0)) throw new Error('no usable account equity for C++ risk validation')
        cppRisk = await runCppRisk(config, {
          equity,
          entry,
          stop: stopLoss,
          risk_pct: Number(config.cppRiskPct ?? 1),
          max_notional: Number(config.maxOrderNotional ?? 2000),
          max_leverage: Number(config.maxLeverage ?? 5),
        }, Number(config.cppTimeoutMs ?? 10000))
        if (cppRisk.ok !== true) throw new Error(cppRisk.error ?? 'C++ execution kernel rejected the order')
        const requestedNotional = notional !== undefined ? notional : (qty !== undefined ? qty * entry : undefined)
        if (requestedNotional !== undefined && requestedNotional > Number(cppRisk.notional)) {
          const scale = Number(cppRisk.notional) / requestedNotional
          if (notional !== undefined) notional = notional * scale
          if (qty !== undefined) qty = qty * scale
        }
      }

      const result = await desk.order({
        symbol: args.symbol,
        side: args.side,
        type,
        notional,
        qty,
        price: args.price === undefined ? undefined : Number(args.price),
        leverage: args.leverage === undefined ? undefined : Number(args.leverage),
        stopLoss: args.stop_loss === undefined ? undefined : Number(args.stop_loss),
        takeProfit: args.take_profit === undefined ? undefined : Number(args.take_profit),
        reduceOnly,
      })
      if (cppRisk !== undefined) result.cpp_risk = cppRisk
      return json(result)
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

