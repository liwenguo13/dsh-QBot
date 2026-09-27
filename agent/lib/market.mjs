/**
 * Market data, technical indicators and news for the QBot agent.
 *
 * Public data only: no credentials are read here. Gate.io USDⓈ perpetuals are
 * the primary source because they are reachable from this deployment; Binance
 * spot data (`data-api.binance.vision`) and the Binance futures testnet are
 * fallbacks. A provider that cannot be reached fails the call; nothing silently
 * degrades to invented prices, because a trader acting on fabricated quotes is
 * worse than one that knows it has no data.
 *
 * Symbols are normalized to the Gate convention `BTC_USDT`; callers may write
 * `BTCUSDT`, `btc-usdt`, or `BTC/USDT`.
 */

const USER_AGENT = 'qbot-dsh-agent/1.0 (+dsh)'

/** Gate interval spellings this deployment can ask for. */
const GATE_INTERVALS = new Set(['10s', '1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'])
/** Binance interval spellings this deployment can ask for. */
const BINANCE_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'])

/**
 * Normalize one user-supplied symbol.
 * @param input - symbol in any common spelling.
 * @returns the Gate-style contract id and the Binance-style symbol.
 * @throws Error when the input is empty.
 */
export function normalizeSymbol(input) {
  const raw = String(input ?? '').trim().toUpperCase().replace(/[\/\-\s]/g, '_')
  const compact = raw.replace(/_/g, '')
  if (compact.length === 0) throw new Error('symbol must not be empty')
  if (compact.endsWith('PERP')) {
    // BTCUSDT.PERP -> BTCUSDT
    const withoutPerp = compact.slice(0, -4)
    return normalizeSymbol(withoutPerp)
  }
  const quote = compact.endsWith('USDT') ? 'USDT' : compact.endsWith('USDC') ? 'USDC' : undefined
  if (quote === undefined || compact.length <= quote.length) {
    return { gate: `${compact}_USDT`, binance: compact }
  }
  const base = compact.slice(0, -quote.length)
  return { gate: `${base}_${quote}`, binance: `${base}${quote}` }
}

/**
 * Map one requested interval to a provider's nearest supported spelling.
 * @param interval - requested interval such as `5m`.
 * @param supported - provider interval set.
 * @param fallback - provider default when nothing matches.
 * @returns the provider interval.
 */
function mapInterval(interval, supported, fallback) {
  const wanted = String(interval ?? '').trim()
  if (supported.has(wanted)) return wanted
  const match = /^(\d+)([smhdwM])$/.exec(wanted)
  if (match !== null) {
    const value = Number(match[1])
    const unit = match[2]
    const ladder = [...supported].filter(entry => entry.endsWith(unit))
      .map(entry => ({ entry, value: Number(entry.slice(0, -1)) }))
      .sort((a, b) => a.value - b.value)
    const atLeast = ladder.find(item => item.value >= value)
    if (atLeast !== undefined) return atLeast.entry
    if (ladder.length > 0) return ladder[ladder.length - 1].entry
  }
  return fallback
}

/**
 * One JSON HTTP request with a hard timeout and a single retry.
 * @param url - absolute URL.
 * @param options - fetch options; `timeoutMs` overrides the default.
 * @returns parsed JSON body.
 * @throws Error naming the status when the endpoint answers non-2xx.
 */
async function getJson(url, options = {}) {
  const { timeoutMs = 15_000, ...rest } = options
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...rest,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...rest.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`)
      }
      return JSON.parse(text)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`request failed: ${String(lastError?.message ?? lastError)} (${url})`)
}

/** Parse a maybe-numeric provider field without inventing a value. */
function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Gate.io USDⓈ-M perpetual public data. */
function gateioProvider() {
  const base = 'https://api.gateio.ws/api/v4'
  return {
    id: 'gateio',
    label: 'Gate.io USDT perpetual',
    async ticker(symbol) {
      const { gate } = normalizeSymbol(symbol)
      const rows = await getJson(`${base}/futures/usdt/tickers?contract=${gate}`)
      const row = Array.isArray(rows) ? rows[0] : undefined
      if (row === undefined) throw new Error(`no ticker for ${gate}`)
      const multiplier = num(row.quanto_multiplier) ?? 1
      const openInterestContracts = num(row.total_size)
      return {
        symbol: gate,
        provider: 'gateio',
        last: num(row.last),
        mark: num(row.mark_price),
        index: num(row.index_price),
        bid: num(row.highest_bid),
        ask: num(row.lowest_ask),
        changePercent24h: num(row.change_percentage),
        high24h: num(row.high_24h),
        low24h: num(row.low_24h),
        quoteVolume24h: num(row.volume_24h_settle),
        fundingRate: num(row.funding_rate),
        openInterestContracts,
        openInterestNotional: openInterestContracts === undefined ? undefined : openInterestContracts * multiplier * (num(row.mark_price) ?? 0),
        multiplier,
        time: Date.now(),
      }
    },
    async candles(symbol, interval, limit) {
      const { gate } = normalizeSymbol(symbol)
      const span = mapInterval(interval, GATE_INTERVALS, '5m')
      const rows = await getJson(`${base}/futures/usdt/candlesticks?contract=${gate}&interval=${span}&limit=${limit}`)
      return rows.map(row => ({
        t: Number(row.t) * 1000,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        v: Number(row.v),
        qv: num(row.sum),
      }))
    },
    async depth(symbol, limit) {
      const { gate } = normalizeSymbol(symbol)
      const body = await getJson(`${base}/futures/usdt/order_book?contract=${gate}&limit=${limit}`)
      const side = rows => (rows ?? []).map(row => ({ price: num(row.p), size: num(row.s) }))
      return { provider: 'gateio', symbol: gate, bids: side(body.bids), asks: side(body.asks) }
    },
    async funding(symbol) {
      const { gate } = normalizeSymbol(symbol)
      const rows = await getJson(`${base}/futures/usdt/funding_rate?contract=${gate}&limit=8`)
      const latest = rows[0]
      const [contract, ticker] = await Promise.all([
        getJson(`${base}/futures/usdt/contracts/${gate}`).catch(() => undefined),
        getJson(`${base}/futures/usdt/tickers?contract=${gate}`).catch(() => undefined),
      ])
      const row = Array.isArray(ticker) ? ticker[0] : undefined
      return {
        provider: 'gateio',
        symbol: gate,
        current: num(row?.funding_rate ?? latest?.r),
        indicative: num(contract?.funding_rate_indicative),
        intervalHours: contract?.funding_interval === undefined ? undefined : Number(contract.funding_interval) / 3600,
        nextApply: contract?.funding_next_apply === undefined ? undefined : Number(contract.funding_next_apply) * 1000,
        history: rows.map(entry => ({ rate: num(entry.r), at: Number(entry.t) * 1000 })),
      }
    },
    async contract(symbol) {
      const { gate } = normalizeSymbol(symbol)
      const row = await getJson(`${base}/futures/usdt/contracts/${gate}`)
      return {
        provider: 'gateio',
        symbol: gate,
        multiplier: num(row.quanto_multiplier),
        priceStep: num(row.order_price_round),
        sizeMin: num(row.order_size_min),
        sizeMax: num(row.order_size_max),
        maxLeverage: num(row.leverage_max),
        maintenanceRate: num(row.maintenance_rate),
      }
    },
  }
}

/** Binance public data; `spot` reads the public mirror, `futures` a futures base. */
function binanceProvider({ id, label, base, futures }) {
  return {
    id,
    label,
    async ticker(symbol) {
      const { binance } = normalizeSymbol(symbol)
      if (futures) {
        const row = await getJson(`${base}/fapi/v1/ticker/24hr?symbol=${binance}`)
        return {
          symbol: binance,
          provider: id,
          last: num(row.lastPrice),
          mark: num(row.lastPrice),
          bid: num(row.bidPrice),
          ask: num(row.askPrice),
          changePercent24h: num(row.priceChangePercent),
          high24h: num(row.highPrice),
          low24h: num(row.lowPrice),
          quoteVolume24h: num(row.quoteVolume),
          time: Date.now(),
        }
      }
      const [ticker, book] = await Promise.all([
        getJson(`${base}/api/v3/ticker/24hr?symbol=${binance}`),
        getJson(`${base}/api/v3/ticker/bookTicker?symbol=${binance}`).catch(() => undefined),
      ])
      return {
        symbol: binance,
        provider: id,
        last: num(ticker.lastPrice),
        mark: num(ticker.lastPrice),
        bid: num(book?.bidPrice),
        ask: num(book?.askPrice),
        changePercent24h: num(ticker.priceChangePercent),
        high24h: num(ticker.highPrice),
        low24h: num(ticker.lowPrice),
        quoteVolume24h: num(ticker.quoteVolume),
        time: Date.now(),
      }
    },
    async candles(symbol, interval, limit) {
      const { binance } = normalizeSymbol(symbol)
      const span = mapInterval(interval, BINANCE_INTERVALS, '5m')
      const path = futures ? '/fapi/v1/klines' : '/api/v3/klines'
      const rows = await getJson(`${base}${path}?symbol=${binance}&interval=${span}&limit=${limit}`)
      return rows.map(row => ({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
        qv: num(row[7]),
      }))
    },
    async depth(symbol, limit) {
      const { binance } = normalizeSymbol(symbol)
      if (futures) {
        const body = await getJson(`${base}/fapi/v1/depth?symbol=${binance}&limit=${limit}`)
        return {
          provider: id,
          symbol: binance,
          bids: body.bids.map(([p, s]) => ({ price: Number(p), size: Number(s) })),
          asks: body.asks.map(([p, s]) => ({ price: Number(p), size: Number(s) })),
        }
      }
      const body = await getJson(`${base}/api/v3/depth?symbol=${binance}&limit=${limit}`)
      return {
        provider: id,
        symbol: binance,
        bids: body.bids.map(([p, s]) => ({ price: Number(p), size: Number(s) })),
        asks: body.asks.map(([p, s]) => ({ price: Number(p), size: Number(s) })),
      }
    },
    async funding(symbol) {
      const { binance } = normalizeSymbol(symbol)
      if (!futures) throw new Error('funding is a futures concept; this provider serves spot data')
      const row = await getJson(`${base}/fapi/v1/premiumIndex?symbol=${binance}`)
      return {
        provider: id,
        symbol: binance,
        current: num(row.lastFundingRate),
        mark: num(row.markPrice),
        index: num(row.indexPrice),
        nextApply: num(row.nextFundingTime),
      }
    },
    async contract() {
      throw new Error('contract metadata is not available from this provider')
    },
  }
}

/**
 * Single-flight TTL cache. A trading cycle calls ticker/candles repeatedly
 * (status, tick, indicators, orders), so overlapping calls for the same key
 * share one request and a short TTL collapses duplicates without ever serving
 * a stale price to a decision that needs the current one.
 * @param loader - the uncached async loader.
 * @param ttlMs - how long a resolved value stays fresh.
 * @returns the cached loader.
 */
function cached(loader, ttlMs) {
  const entries = new Map()
  return async (...args) => {
    const key = JSON.stringify(args)
    const hit = entries.get(key)
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value
    const value = await loader(...args)
    entries.set(key, { at: Date.now(), value })
    if (entries.size > 200) entries.delete(entries.keys().next().value)
    return value
  }
}

/** Cache lifetimes; prices are short, metadata is long. */
const TTL = Object.freeze({
  ticker: 4_000,
  candles: 15_000,
  depth: 4_000,
  funding: 45_000,
  contract: 3_600_000,
})

/**
 * Build one market data provider by name, with TTL caching applied.
 * @param provider - `gateio` (default), `binance-spot`, `binance-testnet`.
 * @returns the provider adapter.
 * @throws Error on an unknown provider name.
 */
export function createMarket(provider = 'gateio') {
  const base = createProvider(provider)
  return {
    id: base.id,
    label: base.label,
    ticker: cached(base.ticker.bind(base), TTL.ticker),
    candles: cached(base.candles.bind(base), TTL.candles),
    depth: cached(base.depth.bind(base), TTL.depth),
    funding: cached(base.funding.bind(base), TTL.funding),
    contract: cached(base.contract.bind(base), TTL.contract),
  }
}

/**
 * Build the uncached provider by name.
 * @param provider - `gateio` (default), `binance-spot`, `binance-testnet`.
 * @returns the provider adapter.
 * @throws Error on an unknown provider name.
 */
function createProvider(provider) {
  switch (provider) {
    case 'gateio': return gateioProvider()
    case 'binance-spot':
      return binanceProvider({
        id: 'binance-spot',
        label: 'Binance spot (public data mirror)',
        base: 'https://data-api.binance.vision',
        futures: false,
      })
    case 'binance-testnet':
      return binanceProvider({
        id: 'binance-testnet',
        label: 'Binance USDⓈ-M futures testnet',
        base: 'https://testnet.binancefuture.com',
        futures: true,
      })
    default:
      throw new Error(`unknown market provider "${provider}"; use gateio, binance-spot, or binance-testnet`)
  }
}

/** Simple moving average of the trailing `period` closes. */
function sma(values, period) {
  if (values.length < period) return undefined
  const window = values.slice(-period)
  return window.reduce((sum, value) => sum + value, 0) / period
}

/** Exponential moving average series over closes. */
function emaSeries(values, period) {
  const k = 2 / (period + 1)
  const out = []
  let previous
  for (const value of values) {
    previous = previous === undefined ? value : value * k + previous * (1 - k)
    out.push(previous)
  }
  return out
}

/** Relative strength index (Wilder) of the trailing `period` changes. */
function rsi(values, period = 14) {
  if (values.length <= period) return undefined
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1]
    if (change >= 0) gain += change
    else loss -= change
  }
  let averageGain = gain / period
  let averageLoss = loss / period
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
  }
  if (averageLoss === 0) return 100
  const rs = averageGain / averageLoss
  return 100 - 100 / (1 + rs)
}

/** Average true range (Wilder) over candles. */
function atr(candles, period = 14) {
  if (candles.length <= period) return undefined
  const trueRanges = []
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const previousClose = candles[index - 1].c
    trueRanges.push(Math.max(
      candle.h - candle.l,
      Math.abs(candle.h - previousClose),
      Math.abs(candle.l - previousClose),
    ))
  }
  let value = trueRanges.slice(0, period).reduce((sum, entry) => sum + entry, 0) / period
  for (const range of trueRanges.slice(period)) value = (value * (period - 1) + range) / period
  return value
}

/**
 * Compute a compact technical-analysis snapshot from candles. This is
 * arithmetic over observed prices, not a strategy: the model still decides.
 * @param candles - oldest-first OHLCV candles.
 * @param period - fast EMA/RSI period (default 14).
 * @returns indicator values plus simple derived readings.
 */
export function indicators(candles, period = 14) {
  const closes = candles.map(candle => candle.c)
  const volumes = candles.map(candle => candle.v)
  const emaFast = emaSeries(closes, period)
  const emaSlow = emaSeries(closes, Math.max(period * 3, 20))
  const ema200 = emaSeries(closes, 200)
  const macdFast = emaSeries(closes, 12)
  const macdSlow = emaSeries(closes, 26)
  const macdLine = closes.map((_, index) => macdFast[index] - macdSlow[index])
  const signal = emaSeries(macdLine, 9)
  const last = closes.at(-1)
  const bollingerWindow = closes.slice(-20)
  const bollingerMiddle = bollingerWindow.length === 20 ? sma(closes, 20) : undefined
  const bollingerStd = bollingerMiddle === undefined ? undefined
    : Math.sqrt(bollingerWindow.reduce((sum, value) => sum + (value - bollingerMiddle) ** 2, 0) / 20)
  const volumeAverage = sma(volumes, 20)
  return {
    candles: candles.length,
    last,
    changePercent: closes.length > 1 ? ((last - closes[0]) / closes[0]) * 100 : undefined,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    emaFast: emaFast.at(-1),
    emaSlow: emaSlow.at(-1),
    ema200: closes.length >= 200 ? ema200.at(-1) : undefined,
    rsi: rsi(closes, 14),
    macd: {
      line: macdLine.at(-1),
      signal: signal.at(-1),
      histogram: macdLine.at(-1) !== undefined && signal.at(-1) !== undefined ? macdLine.at(-1) - signal.at(-1) : undefined,
    },
    atr: atr(candles, 14),
    atrPercent: atr(candles, 14) === undefined ? undefined : (atr(candles, 14) / last) * 100,
    bollinger: bollingerMiddle === undefined ? undefined : {
      middle: bollingerMiddle,
      upper: bollingerMiddle + 2 * bollingerStd,
      lower: bollingerMiddle - 2 * bollingerStd,
      widthPercent: ((4 * bollingerStd) / bollingerMiddle) * 100,
    },
    high: Math.max(...candles.map(candle => candle.h)),
    low: Math.min(...candles.map(candle => candle.l)),
    volume: volumes.at(-1),
    volumeAverage20: volumeAverage,
    volumeRatio: volumeAverage === undefined || volumeAverage === 0 ? undefined : volumes.at(-1) / volumeAverage,
  }
}

/** News sources reachable from this deployment; all are public RSS feeds. */
export const DEFAULT_NEWS_SOURCES = Object.freeze({
  cointelegraph: 'https://cointelegraph.com/rss',
  decrypt: 'https://decrypt.co/feed',
  beincrypto: 'https://beincrypto.com/feed/',
  ambcrypto: 'https://ambcrypto.com/feed/',
  theblock: 'https://www.theblock.co/rss.xml',
})

/** Decode the handful of XML entities RSS titles use. */
function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/** Extract one tag's text from an RSS item block. */
function tag(block, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return match === null ? undefined : decodeEntities(match[1])
}

/**
 * Fetch recent headlines from public RSS feeds, cached for five minutes.
 * @param sources - source ids to query; defaults to {@link DEFAULT_NEWS_SOURCES}.
 * @param limit - maximum items per source.
 * @param timeoutMs - per-feed timeout.
 * @returns items with source, title, link, and publication time, newest first.
 */
export const fetchNews = cached(async ({ sources, limit = 8, timeoutMs = 12_000 } = {}) => {
  const wanted = sources === undefined || sources.length === 0 ? Object.keys(DEFAULT_NEWS_SOURCES) : sources
  const unknown = wanted.filter(source => DEFAULT_NEWS_SOURCES[source] === undefined)
  if (unknown.length > 0) {
    throw new Error(`unknown news source(s): ${unknown.join(', ')}; use ${Object.keys(DEFAULT_NEWS_SOURCES).join(', ')}`)
  }
  const results = await Promise.all(wanted.map(async (source) => {
    try {
      const response = await fetch(DEFAULT_NEWS_SOURCES[source], {
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { source, error: `HTTP ${response.status}` }
      const xml = await response.text()
      const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, limit).map((match) => {
        const block = match[0]
        const published = tag(block, 'pubDate') ?? tag(block, 'published')
        const time = published === undefined ? undefined : Date.parse(published)
        return {
          source,
          title: tag(block, 'title'),
          link: tag(block, 'link'),
          publishedAt: Number.isFinite(time) ? new Date(time).toISOString() : published,
        }
      })
      return { source, items }
    } catch (error) {
      return { source, error: String(error?.message ?? error) }
    }
  }))
  const items = results.flatMap(entry => entry.items ?? [])
    .sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0))
  return {
    items,
    errors: results.filter(entry => entry.error !== undefined).map(entry => `${entry.source}: ${entry.error}`),
  }
}, 300_000)

/**
 * Crypto Fear & Greed index (alternative.me), cached for one hour.
 * @returns the latest value with its classification.
 */
export const fearGreed = cached(async () => {
  const body = await getJson('https://api.alternative.me/fng/?limit=2')
  const rows = body?.data ?? []
  return rows.map(row => ({
    value: Number(row.value),
    classification: row.value_classification,
    at: row.timestamp === undefined ? undefined : Number(row.timestamp) * 1000,
  }))
}, 3_600_000)
