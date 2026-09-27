/**
 * QBot trading desk: model-driven order execution with hard risk rails.
 *
 * Three modes share one tool surface:
 * - `paper` simulates fills, fees, leverage, stops, and liquidation against
 *   live public prices, persisted under the QBot home. Default, no credentials.
 * - `testnet` signs orders on the Binance USDⓈ-M futures testnet.
 * - `live` signs real orders on Gate.io USDT perpetuals (reachable from this
 *   deployment) or Binance USDⓈ-M futures.
 *
 * The desk never decides what to trade: the model does. What the desk owns is
 * execution correctness plus the limits that keep one bad model turn from
 * becoming an unbounded loss — leverage caps, notional caps, a daily-loss
 * circuit breaker, and a kill switch. Live mode additionally requires both
 * `allowLive: true` in configuration and an explicit `LIVE` confirmation.
 *
 * Paper positions and orders are evaluated lazily: every desk tool call first
 * runs {@link Desk.tick}, which fills crossed limit orders, triggers
 * stop-loss/take-profit exits, and liquidates positions whose loss reaches
 * their margin. No background price stream is needed, and a cycle that never
 * calls the desk never moves the paper account.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { normalizeSymbol } from './market.mjs'

const STATE_VERSION = 1
const EPSILON = 1e-12

/** One calendar-day key in the host's local zone. */
function dayKey(time = Date.now()) {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Round without float dust. */
function round(value, decimals = 8) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Floor a value to a step size using the step's own precision. */
function floorToStep(value, step) {
  if (!Number.isFinite(step) || step <= 0) return value
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2)
  return round(Math.floor(value / step + 1e-9) * step, decimals)
}

/** The persistent desk document before anything has happened. */
function defaultState(config) {
  return {
    version: STATE_VERSION,
    mode: 'paper',
    liveBackend: config.liveBackend,
    confirmedLiveAt: undefined,
    days: {},
    risk: {
      maxLeverage: config.maxLeverage,
      maxOrderNotional: config.maxOrderNotional,
      maxGrossNotional: config.maxGrossNotional,
      maxDailyLoss: config.maxDailyLoss,
      killSwitch: false,
    },
    paper: {
      startingWallet: config.paperWallet,
      wallet: config.paperWallet,
      realizedPnl: 0,
      totalFees: 0,
      positions: {},
      orders: [],
      fills: [],
      equity: [],
    },
    updatedAt: new Date().toISOString(),
  }
}

/** Atomic JSON persistence for one state document. */
function createStore(filename, config) {
  const load = () => {
    try {
      if (!existsSync(filename)) return defaultState(config)
      const parsed = JSON.parse(readFileSync(filename, 'utf8'))
      return parsed?.version === STATE_VERSION ? parsed : defaultState(config)
    } catch {
      return defaultState(config)
    }
  }
  const save = (state) => {
    mkdirSync(dirname(filename), { recursive: true })
    const tmp = `${filename}.tmp`
    state.updatedAt = new Date().toISOString()
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, filename)
  }
  return { load, save }
}

/**
 * Apply one paper fill. This function owns every balance mutation: callers
 * must not adjust `wallet`, `realizedPnl`, or `totalFees` themselves.
 * @param paper - the paper account.
 * @param position - the existing position on this symbol, when any.
 * @param fill - side, base size, price, existing leverage for adds.
 * @param feeRate - taker fee rate.
 * @returns the next position (undefined when flat), the fee, and realized PnL.
 * @throws Error when a reduce-only fill could not reduce anything.
 */
function paperApplyFill(paper, position, fill, feeRate) {
  const { side, size, price } = fill
  const notional = price * size
  if (position === undefined) {
    const leverage = fill.leverage ?? 1
    const margin = notional / leverage
    const fee = notional * feeRate
    paper.wallet -= margin + fee
    paper.totalFees += fee
    const at = new Date().toISOString()
    return {
      position: {
        symbol: fill.symbol, side, size, entry: price, leverage, margin,
        stopLoss: fill.stopLoss, takeProfit: fill.takeProfit, openedAt: at, updatedAt: at,
      },
      fee,
      realized: 0,
    }
  }
  if (position.side === side) {
    const leverage = position.leverage
    const addMargin = notional / leverage
    const fee = notional * feeRate
    const nextSize = position.size + size
    const entry = (position.entry * position.size + notional) / nextSize
    paper.wallet -= addMargin + fee
    paper.totalFees += fee
    return {
      position: { ...position, size: nextSize, entry, margin: position.margin + addMargin, updatedAt: new Date().toISOString() },
      fee,
      realized: 0,
    }
  }
  const closingSize = Math.min(size, position.size)
  const pnl = (price - position.entry) * closingSize * (position.side === 'long' ? 1 : -1)
  const releasedMargin = position.margin * (closingSize / position.size)
  let fee = notional * feeRate
  let realized = pnl
  paper.wallet += releasedMargin + pnl - fee
  paper.realizedPnl += pnl
  paper.totalFees += fee
  const remaining = position.size - closingSize
  if (remaining > EPSILON) {
    return {
      position: { ...position, size: remaining, margin: position.margin - releasedMargin, updatedAt: new Date().toISOString() },
      fee,
      realized,
    }
  }
  const flipSize = size - closingSize
  if (flipSize > EPSILON) {
    const flipNotional = price * flipSize
    const flipMargin = flipNotional / position.leverage
    const flipFee = flipNotional * feeRate
    paper.wallet -= flipMargin + flipFee
    paper.totalFees += flipFee
    fee += flipFee
    const at = new Date().toISOString()
    return {
      position: {
        symbol: position.symbol, side, size: flipSize, entry: price, leverage: position.leverage,
        margin: flipMargin, stopLoss: undefined, takeProfit: undefined, openedAt: at, updatedAt: at,
      },
      fee,
      realized,
    }
  }
  return { position: undefined, fee, realized }
}

/* ── Binance USDⓈ-M futures client (testnet and live share this code) ─────── */

/** Per-symbol order filters from `/fapi/v1/exchangeInfo`. */
function binanceFilters(exchangeInfo) {
  const filters = new Map()
  for (const symbol of exchangeInfo?.symbols ?? []) {
    const pick = type => symbol.filters?.find(filter => filter.filterType === type)
    filters.set(symbol.symbol, {
      tickSize: Number(pick('PRICE_FILTER')?.tickSize ?? 0.01),
      stepSize: Number(pick('LOT_SIZE')?.stepSize ?? 0.001),
      minQty: Number(pick('LOT_SIZE')?.minQty ?? 0.001),
      minNotional: Number(pick('MIN_NOTIONAL')?.notional ?? 5),
    })
  }
  return filters
}

/** Binance-style signed REST client; one class serves testnet and live. */
class BinanceClient {
  constructor({ base, testnet, apiKey, apiSecret, timeoutMs }) {
    this.base = base
    this.testnet = testnet
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.timeoutMs = timeoutMs
    this.timeOffset = 0
    this.filters = undefined
  }

  get label() {
    return this.testnet ? 'Binance USDⓈ-M futures testnet' : 'Binance USDⓈ-M futures (live)'
  }

  async request(path, { method = 'GET', params = {}, signed = false } = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    if (signed) {
      if (this.apiKey === undefined || this.apiSecret === undefined) {
        throw new Error(`${this.label} needs an API key and secret; store them in the QBot credential store or the environment`)
      }
      query.set('timestamp', String(Date.now() + this.timeOffset))
      query.set('recvWindow', '5000')
      query.set('signature', createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex'))
    }
    const url = `${this.base}${path}${query.toString().length > 0 ? `?${query.toString()}` : ''}`
    const headers = { 'user-agent': 'qbot-dsh-agent/1.0', accept: 'application/json' }
    if (this.apiKey !== undefined) headers['X-MBX-APIKEY'] = this.apiKey
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(this.timeoutMs) })
    const text = await response.text()
    let body
    try {
      body = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }
    if (!response.ok) {
      throw new Error(`${this.label} ${method} ${path} failed: ${response.status} ${body?.msg ?? body?.message ?? text.slice(0, 300)}`)
    }
    return body
  }

  async syncClock() {
    const time = await this.request('/fapi/v1/time')
    const serverTime = Number(time?.serverTime)
    if (Number.isFinite(serverTime)) this.timeOffset = serverTime - Date.now()
  }

  async loadFilters() {
    if (this.filters !== undefined) return
    this.filters = binanceFilters(await this.request('/fapi/v1/exchangeInfo'))
  }

  filtersFor(symbol) {
    const entry = this.filters?.get(symbol)
    if (entry === undefined) throw new Error(`no Binance filters cached for ${symbol}`)
    return entry
  }

  async account() {
    const body = await this.request('/fapi/v2/account', { signed: true })
    return {
      totalWalletBalance: Number(body.totalWalletBalance),
      totalUnrealizedProfit: Number(body.totalUnrealizedProfit),
      totalMarginBalance: Number(body.totalMarginBalance),
      availableBalance: Number(body.availableBalance),
    }
  }

  async positions(symbol) {
    const body = await this.request('/fapi/v2/positionRisk', { signed: true, params: symbol === undefined ? {} : { symbol } })
    return body
      .filter(entry => Number(entry.positionAmt) !== 0)
      .map(entry => ({
        symbol: entry.symbol,
        side: Number(entry.positionAmt) > 0 ? 'long' : 'short',
        size: Math.abs(Number(entry.positionAmt)),
        entryPrice: Number(entry.entryPrice),
        markPrice: Number(entry.markPrice),
        liquidationPrice: Number(entry.liquidationPrice),
        unrealizedPnl: Number(entry.unRealizedProfit),
        leverage: Number(entry.leverage),
      }))
  }

  async openOrders(symbol) {
    const body = await this.request('/fapi/v1/openOrders', { signed: true, params: symbol === undefined ? {} : { symbol } })
    return body.map(order => ({
      id: String(order.orderId),
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      type: order.type.toLowerCase(),
      price: Number(order.price),
      stopPrice: Number(order.stopPrice),
      qty: Number(order.origQty),
      status: order.status,
      reduceOnly: order.reduceOnly,
    }))
  }

  async setLeverage(symbol, leverage) {
    await this.request('/fapi/v1/leverage', { method: 'POST', signed: true, params: { symbol, leverage: Math.trunc(leverage) } })
  }

  async placeOrder(request) {
    await this.loadFilters()
    const filters = this.filtersFor(request.symbol)
    const quantity = request.qty !== undefined
      ? floorToStep(request.qty, filters.stepSize)
      : floorToStep(request.notional / request.referencePrice, filters.stepSize)
    if (!(quantity >= filters.minQty)) {
      throw new Error(`quantity ${quantity} is below the exchange minimum ${filters.minQty} for ${request.symbol}`)
    }
    const params = {
      symbol: request.symbol,
      side: request.side === 'long' ? 'BUY' : 'SELL',
      type: request.type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: String(quantity),
      newOrderRespType: 'RESULT',
    }
    if (request.type === 'limit') {
      params.price = String(floorToStep(request.price, filters.tickSize))
      params.timeInForce = 'GTC'
    }
    if (request.reduceOnly === true) params.reduceOnly = 'true'
    await this.syncClock()
    const order = await this.request('/fapi/v1/order', { method: 'POST', signed: true, params })
    const avgPrice = Number(order.avgPrice)
    const limitPrice = Number(order.price)
    const result = {
      id: String(order.orderId),
      status: order.status,
      symbol: order.symbol,
      side: request.side,
      type: request.type,
      qty: Number(order.origQty ?? quantity),
      price: avgPrice > 0 ? avgPrice : limitPrice > 0 ? limitPrice : request.referencePrice,
    }
    if (request.stopLoss !== undefined || request.takeProfit !== undefined) {
      const closeSide = request.side === 'long' ? 'SELL' : 'BUY'
      const bracket = (type, stopPrice) => this.request('/fapi/v1/order', {
        method: 'POST',
        signed: true,
        params: {
          symbol: request.symbol,
          side: closeSide,
          type,
          stopPrice: String(floorToStep(stopPrice, filters.tickSize)),
          closePosition: 'true',
          workingType: 'MARK_PRICE',
        },
      })
      if (request.stopLoss !== undefined) await bracket('STOP_MARKET', request.stopLoss)
      if (request.takeProfit !== undefined) await bracket('TAKE_PROFIT_MARKET', request.takeProfit)
      result.protection = { stopLoss: request.stopLoss, takeProfit: request.takeProfit }
    }
    return result
  }

  async cancelOrder({ symbol, id }) {
    await this.syncClock()
    if (id === undefined) {
      await this.request('/fapi/v1/allOpenOrders', { method: 'DELETE', signed: true, params: symbol === undefined ? {} : { symbol } })
      return { canceled: 'all', symbol: symbol ?? 'every symbol' }
    }
    const body = await this.request('/fapi/v1/order', { method: 'DELETE', signed: true, params: { symbol, orderId: id } })
    return { canceled: String(body.orderId), symbol: body.symbol, status: body.status }
  }
}

/* ── Gate.io USDT perpetual client (live) ─────────────────────────────────── */

/** Gate API v4 signature: method\npath\nquery\nsha512(body)\ntimestamp. */
function gateSignature(secret, method, path, query, body, timestamp) {
  const hashed = createHash('sha512').update(body ?? '').digest('hex')
  return createHmac('sha512', secret)
    .update(`${method}\n${path}\n${query ?? ''}\n${hashed}\n${timestamp}`)
    .digest('hex')
}

/** Gate.io USDT perpetual client; the reachable live backend. */
class GateClient {
  constructor({ base, apiKey, apiSecret, timeoutMs }) {
    this.base = base
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.timeoutMs = timeoutMs
    this.contracts = new Map()
  }

  get label() {
    return 'Gate.io USDT perpetual (live)'
  }

  async request(method, path, { query = {}, body } = {}) {
    if (this.apiKey === undefined || this.apiSecret === undefined) {
      throw new Error(`${this.label} needs an API key and secret; store them in the QBot credential store or the environment`)
    }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const queryString = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ).toString()
    const payload = body === undefined ? '' : JSON.stringify(body)
    const url = `${this.base}${path}${queryString.length > 0 ? `?${queryString}` : ''}`
    const response = await fetch(url, {
      method,
      headers: {
        'user-agent': 'qbot-dsh-agent/1.0',
        accept: 'application/json',
        'content-type': 'application/json',
        KEY: this.apiKey,
        Timestamp: timestamp,
        SIGN: gateSignature(this.apiSecret, method, path, queryString, payload, timestamp),
      },
      body: payload.length > 0 ? payload : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      parsed = { raw: text }
    }
    if (!response.ok) {
      throw new Error(`${this.label} ${method} ${path} failed: ${response.status} ${parsed?.message ?? parsed?.label ?? text.slice(0, 300)}`)
    }
    return parsed
  }

  async contractInfo(symbol) {
    if (this.contracts.has(symbol)) return this.contracts.get(symbol)
    const row = await this.request('GET', `/futures/usdt/contracts/${symbol}`)
    const info = {
      multiplier: Number(row.quanto_multiplier),
      priceStep: Number(row.order_price_round),
      sizeMin: Number(row.order_size_min ?? 1),
      maxLeverage: Number(row.leverage_max ?? 100),
      maintenanceRate: Number(row.maintenance_rate ?? 0.005),
    }
    this.contracts.set(symbol, info)
    return info
  }

  async account() {
    const body = await this.request('GET', '/futures/usdt/accounts')
    return {
      totalWalletBalance: Number(body.total),
      totalUnrealizedProfit: Number(body.unrealised_pnl),
      totalMarginBalance: Number(body.total) + Number(body.unrealised_pnl),
      availableBalance: Number(body.available),
    }
  }

  async positions(symbol) {
    const body = await this.request('GET', '/futures/usdt/positions', { query: { holding: 'true' } })
    return (Array.isArray(body) ? body : [])
      .filter(entry => Number(entry.size) !== 0 && (symbol === undefined || entry.contract === symbol))
      .map(entry => ({
        symbol: entry.contract,
        side: Number(entry.size) > 0 ? 'long' : 'short',
        size: Math.abs(Number(entry.size)),
        entryPrice: Number(entry.entry_price),
        markPrice: Number(entry.mark_price),
        liquidationPrice: Number(entry.liq_price),
        unrealizedPnl: Number(entry.unrealised_pnl),
        leverage: Number(entry.leverage),
      }))
  }

  async openOrders(symbol) {
    const body = await this.request('GET', '/futures/usdt/orders', {
      query: { status: 'open', ...(symbol === undefined ? {} : { contract: symbol }) },
    })
    return (Array.isArray(body) ? body : []).map(order => ({
      id: String(order.id),
      symbol: order.contract,
      side: Number(order.size) > 0 ? 'long' : 'short',
      type: Number(order.price) === 0 ? 'market' : 'limit',
      price: Number(order.price),
      qty: Math.abs(Number(order.size)),
      status: order.status,
      reduceOnly: order.reduce_only === true,
    }))
  }

  async setLeverage(symbol, leverage) {
    await this.request('POST', `/futures/usdt/positions/${symbol}/leverage`, { query: { leverage: Math.trunc(leverage) } })
  }

  async placeOrder(request) {
    const info = await this.contractInfo(request.symbol)
    const contracts = request.qty !== undefined
      ? Math.round(request.qty / info.multiplier)
      : Math.round(request.notional / request.referencePrice / info.multiplier)
    if (contracts < info.sizeMin) {
      throw new Error(`order is ${contracts} contract(s), below the minimum ${info.sizeMin} for ${request.symbol}`)
    }
    const body = {
      contract: request.symbol,
      size: request.side === 'long' ? contracts : -contracts,
      price: request.type === 'limit' ? String(round(request.price, 10)) : '0',
      tif: request.type === 'limit' ? 'gtc' : 'ioc',
      text: 't-qbotsdk',
    }
    if (request.reduceOnly === true) body.reduce_only = true
    const order = await this.request('POST', '/futures/usdt/orders', { body })
    return {
      id: String(order.id),
      status: order.status,
      symbol: order.contract,
      side: request.side,
      type: request.type,
      qty: Math.abs(Number(order.size)) * info.multiplier,
      price: Number(order.price) > 0 ? Number(order.price) : request.referencePrice,
      note: 'stop-loss/take-profit brackets are not placed on Gate.io; manage exits in your trading cycle',
    }
  }

  async cancelOrder({ symbol, id }) {
    if (id === undefined) {
      if (symbol === undefined) throw new Error('canceling every open order needs a symbol on Gate.io')
      const body = await this.request('DELETE', '/futures/usdt/orders', { query: { contract: symbol } })
      return { canceled: 'all', symbol, orders: (Array.isArray(body) ? body : []).map(order => String(order.id)) }
    }
    const body = await this.request('DELETE', `/futures/usdt/orders/${id}`)
    return { canceled: String(body.id), symbol: body.contract, status: body.status }
  }
}

/* ── Desk ─────────────────────────────────────────────────────────────────── */

/**
 * Build the trading desk.
 * @param options - state directory, resolved config, market adapter, and the
 *   credential resolver the plugin supplies.
 * @returns the desk API the tool layer calls.
 */
export function createDesk(options) {
  const { stateDir, config, market, resolveCredential } = options
  const filename = resolve(stateDir, 'state.json')
  const store = createStore(filename, config)
  let state = store.load()

  /** Advance the per-mode daily equity baseline at a date rollover. */
  const ensureDay = () => {
    const today = dayKey()
    const entry = state.days[state.mode]
    if (entry?.key !== today) {
      state.days[state.mode] = { key: today, startEquity: undefined }
      store.save(state)
    }
  }

  /** Mark prices for a set of symbols, fetched concurrently. */
  const markPrices = async (symbols) => {
    const entries = await Promise.all(symbols.map(async (symbol) => {
      try {
        const ticker = await market.ticker(symbol)
        const price = ticker.mark ?? ticker.last
        return [symbol, Number.isFinite(price) ? price : undefined]
      } catch {
        return [symbol, undefined]
      }
    }))
    return Object.fromEntries(entries.filter(([, price]) => price !== undefined))
  }

  /** Account equity including open paper positions at current marks. */
  const paperEquity = (prices) => {
    let equity = state.paper.wallet
    for (const position of Object.values(state.paper.positions)) {
      const mark = prices[position.symbol] ?? position.entry
      const unrealized = (mark - position.entry) * position.size * (position.side === 'long' ? 1 : -1)
      equity += position.margin + unrealized
    }
    return equity
  }

  /** Fill one paper order/exit and record the fill. */
  const settlePaper = (position, fill, reason) => {
    const applied = paperApplyFill(state.paper, position, fill, config.takerFeeRate)
    state.paper.fills.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      symbol: fill.symbol,
      side: fill.side,
      qty: round(fill.size, 10),
      price: fill.price,
      reason,
      realizedPnl: round(applied.realized, 8),
      fee: round(applied.fee, 8),
    })
    if (applied.position === undefined || applied.position.size <= EPSILON) return undefined
    return applied.position
  }

  /**
   * Lazy maintenance for the paper account: liquidations and protective exits
   * first, then crossed limit orders. Called by every tool before it acts.
   */
  const tick = async () => {
    if (state.mode !== 'paper') return
    ensureDay()
    const symbols = new Set([...Object.keys(state.paper.positions), ...state.paper.orders.map(order => order.symbol)])
    if (symbols.size === 0) return
    const prices = await markPrices([...symbols])
    let changed = false

    for (const [symbol, position] of Object.entries(state.paper.positions)) {
      const mark = prices[symbol]
      if (mark === undefined) continue
      const pnl = (mark - position.entry) * position.size * (position.side === 'long' ? 1 : -1)
      const liquidated = pnl <= -position.margin * 0.95
      const hitStop = position.stopLoss !== undefined
        && (position.side === 'long' ? mark <= position.stopLoss : mark >= position.stopLoss)
      const hitTarget = position.takeProfit !== undefined
        && (position.side === 'long' ? mark >= position.takeProfit : mark <= position.takeProfit)
      if (!liquidated && !hitStop && !hitTarget) continue
      const next = settlePaper(position, {
        symbol,
        side: position.side === 'long' ? 'short' : 'long',
        size: position.size,
        price: mark,
        leverage: position.leverage,
      }, liquidated ? 'liquidation' : hitStop ? 'stop-loss' : 'take-profit')
      if (next === undefined) delete state.paper.positions[symbol]
      else state.paper.positions[symbol] = next
      changed = true
    }

    const pending = []
    for (const order of state.paper.orders) {
      const mark = prices[order.symbol]
      const crossed = mark !== undefined && (order.side === 'long' ? mark <= order.price : mark >= order.price)
      if (!crossed) {
        pending.push(order)
        continue
      }
      const position = state.paper.positions[order.symbol]
      if (order.reduceOnly === true && (position === undefined || position.side === order.side)) {
        pending.push(order)
        continue
      }
      const notional = order.price * order.size
      if (order.reduceOnly !== true) {
        const needed = notional / order.leverage + notional * config.takerFeeRate
        if (state.paper.wallet < needed) {
          pending.push(order)
          continue
        }
      }
      const next = settlePaper(position, {
        symbol: order.symbol,
        side: order.side,
        size: order.size,
        price: order.price,
        leverage: order.leverage,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
      }, 'limit-fill')
      if (next === undefined) delete state.paper.positions[order.symbol]
      else state.paper.positions[order.symbol] = next
      changed = true
    }
    if (pending.length !== state.paper.orders.length) state.paper.orders = pending
    if (changed) {
      const equity = paperEquity(prices)
      state.paper.equity.push({ at: Date.now(), equity: round(equity, 4) })
      if (state.paper.equity.length > 5000) state.paper.equity = state.paper.equity.slice(-5000)
      store.save(state)
    }
  }

  /** Shared risk checks applied before any order is accepted. */
  const assertRisk = (request, context) => {
    const risk = state.risk
    if (risk.killSwitch === true && request.entry) {
      throw new Error('desk kill switch is on: new entries are refused until desk_risk clears it')
    }
    if (request.leverage !== undefined && request.leverage > risk.maxLeverage) {
      throw new Error(`leverage ${request.leverage} exceeds the configured cap ${risk.maxLeverage}`)
    }
    if (request.reduceOnly === true) return
    if (request.notional !== undefined && request.notional > risk.maxOrderNotional) {
      throw new Error(`order notional ${round(request.notional, 2)} exceeds the configured per-order cap ${risk.maxOrderNotional}`)
    }
    if (context.dayPnl !== undefined && context.dayPnl <= -Math.abs(risk.maxDailyLoss)) {
      throw new Error(`daily loss ${round(context.dayPnl, 2)} reached the configured limit ${risk.maxDailyLoss}: entries are refused until the next day`)
    }
    if (request.notional !== undefined && context.grossNotional !== undefined
      && context.grossNotional + request.notional > risk.maxGrossNotional) {
      throw new Error(`order would push gross notional to ${round(context.grossNotional + request.notional, 2)}, above the configured cap ${risk.maxGrossNotional}`)
    }
    if (context.equity !== undefined && context.equity <= 0) {
      throw new Error('account equity is not positive; entries are refused')
    }
  }

  /** The exchange client for the current mode. */
  const exchange = async () => {
    if (state.mode === 'testnet') {
      const [apiKey, apiSecret] = await Promise.all([
        resolveCredential(config.credentials.binanceApiKey),
        resolveCredential(config.credentials.binanceApiSecret),
      ])
      return new BinanceClient({ base: 'https://testnet.binancefuture.com', testnet: true, apiKey, apiSecret, timeoutMs: config.timeoutMs })
    }
    if (state.mode === 'live') {
      if (config.allowLive !== true) {
        throw new Error('live trading is disabled in QBot configuration (allowLive: false); enable it in agent/cordis.patch.yml first')
      }
      if (state.liveBackend === 'binance') {
        const [apiKey, apiSecret] = await Promise.all([
          resolveCredential(config.credentials.binanceApiKey),
          resolveCredential(config.credentials.binanceApiSecret),
        ])
        return new BinanceClient({ base: 'https://fapi.binance.com', testnet: false, apiKey, apiSecret, timeoutMs: config.timeoutMs })
      }
      const [apiKey, apiSecret] = await Promise.all([
        resolveCredential(config.credentials.gateApiKey),
        resolveCredential(config.credentials.gateApiSecret),
      ])
      return new GateClient({ base: 'https://api.gateio.ws/api/v4', apiKey, apiSecret, timeoutMs: config.timeoutMs })
    }
    return undefined
  }

  /** Normalize an order/close symbol to the active backend's spelling. */
  const backendSymbol = (client, symbol) => {
    const normalized = normalizeSymbol(symbol)
    return client instanceof BinanceClient ? normalized.binance : normalized.gate
  }

  /** The exchange-side day P&L, cached per mode. */
  const exchangeDayPnl = (equity) => {
    const entry = state.days[state.mode]
    if (entry === undefined || entry.startEquity === undefined) {
      state.days[state.mode] = { key: dayKey(), startEquity: equity }
      store.save(state)
      return 0
    }
    return equity - entry.startEquity
  }

  return {
    config,
    stateFile: filename,
    market,

    /** Current mode and live-confirmation state. */
    mode() {
      return { mode: state.mode, liveBackend: state.liveBackend, confirmedLiveAt: state.confirmedLiveAt }
    },

    /**
     * Switch trading mode. `live` needs `allowLive: true` and an explicit
     * `confirmation: "LIVE"`, and records a durable confirmation timestamp.
     */
    async setMode(mode, { confirmation, liveBackend } = {}) {
      if (!['paper', 'testnet', 'live'].includes(mode)) throw new Error(`unknown mode "${mode}"`)
      if (mode === 'live') {
        if (config.allowLive !== true) {
          throw new Error('live trading is disabled in QBot configuration (allowLive: false); enable it in agent/cordis.patch.yml first')
        }
        if (String(confirmation ?? '') !== 'LIVE') throw new Error('switching to live requires confirmation="LIVE"')
        state.confirmedLiveAt = new Date().toISOString()
      }
      if (liveBackend !== undefined) {
        if (!['gateio', 'binance'].includes(liveBackend)) throw new Error(`unknown live backend "${liveBackend}"`)
        state.liveBackend = liveBackend
      }
      state.mode = mode
      store.save(state)
      return this.mode()
    },

    tick,

    /** Account, positions, orders, and risk for the active mode. */
    async status() {
      await tick()
      if (state.mode === 'paper') {
        const symbols = Object.keys(state.paper.positions)
        const prices = symbols.length > 0 ? await markPrices(symbols) : {}
        const equity = paperEquity(prices)
        ensureDay()
        const entry = state.days.paper
        if (entry.startEquity === undefined) {
          entry.startEquity = equity
          store.save(state)
        }
        return {
          mode: 'paper',
          desk_file: filename,
          account: {
            equity: round(equity, 4),
            free: round(state.paper.wallet, 4),
            realizedPnl: round(state.paper.realizedPnl, 4),
            dayPnl: round(equity - entry.startEquity, 4),
            totalFees: round(state.paper.totalFees, 4),
            startingWallet: state.paper.startingWallet,
          },
          positions: Object.values(state.paper.positions).map(position => {
            const mark = prices[position.symbol] ?? position.entry
            const unrealized = (mark - position.entry) * position.size * (position.side === 'long' ? 1 : -1)
            return {
              ...position,
              mark,
              unrealizedPnl: round(unrealized, 4),
              notional: round(mark * position.size, 4),
              liquidationPrice: round(
                position.side === 'long'
                  ? position.entry * (1 - 1 / position.leverage + config.maintenanceRate)
                  : position.entry * (1 + 1 / position.leverage - config.maintenanceRate),
                6,
              ),
            }
          }),
          orders: state.paper.orders,
          risk: state.risk,
        }
      }
      const client = await exchange()
      const [account, positions, orders] = await Promise.all([
        client.account(),
        client.positions(),
        client.openOrders(),
      ])
      const equity = account.totalMarginBalance ?? account.totalWalletBalance
      ensureDay()
      return {
        mode: state.mode,
        backend: client.label,
        account: { ...account, equity: round(equity, 4), dayPnl: round(exchangeDayPnl(equity), 4) },
        positions,
        orders,
        risk: state.risk,
      }
    },

    /**
     * Place one order after risk checks. `notional` sizes by USDT value, `qty`
     * by base units. Entries may carry `stopLoss`/`takeProfit` prices.
     */
    async order(request) {
      await tick()
      const normalized = normalizeSymbol(request.symbol)
      const side = request.side === 'short' ? 'short' : 'long'
      const type = request.type === 'limit' ? 'limit' : 'market'
      const leverage = request.leverage ?? config.defaultLeverage
      if (!Number.isFinite(leverage) || leverage < 1) throw new Error('leverage must be a number >= 1')
      const ticker = await market.ticker(normalized.gate)
      const referencePrice = Number(request.price) > 0 ? Number(request.price) : (ticker.mark ?? ticker.last)
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error(`no usable price for ${normalized.gate}`)
      const notional = request.notional ?? (request.qty !== undefined ? request.qty * referencePrice : undefined)
      if (notional === undefined || !(notional > 0)) throw new Error('order needs a positive notional or qty')
      const size = request.qty !== undefined ? request.qty : notional / referencePrice
      const reduceOnly = request.reduceOnly === true

      if (state.mode === 'paper') {
        const existing = state.paper.positions[normalized.gate]
        if (reduceOnly && (existing === undefined || existing.side === side)) {
          throw new Error(`reduce-only ${side} order has no opposite paper position on ${normalized.gate}`)
        }
        const prices = await markPrices(Object.keys(state.paper.positions))
        const equity = paperEquity(prices)
        const grossNotional = Object.values(state.paper.positions).reduce((sum, position) => sum + position.entry * position.size, 0)
        ensureDay()
        const entry = state.days.paper
        if (entry.startEquity === undefined) entry.startEquity = equity
        assertRisk(
          { notional, leverage, entry: !reduceOnly, reduceOnly },
          { equity, grossNotional, dayPnl: equity - entry.startEquity },
        )
        if (type === 'limit') {
          const queued = {
            id: randomUUID(), symbol: normalized.gate, side, type, price: referencePrice, size,
            leverage, reduceOnly, stopLoss: request.stopLoss, takeProfit: request.takeProfit,
            createdAt: new Date().toISOString(),
          }
          state.paper.orders.push(queued)
          store.save(state)
          return { mode: 'paper', queued, note: 'fills lazily on the next desk call once price crosses' }
        }
        const next = settlePaper(existing, {
          symbol: normalized.gate, side, size, price: referencePrice, leverage,
          stopLoss: request.stopLoss, takeProfit: request.takeProfit,
        }, reduceOnly ? 'reduce' : 'market')
        if (next === undefined) delete state.paper.positions[normalized.gate]
        else state.paper.positions[normalized.gate] = next
        store.save(state)
        return {
          mode: 'paper',
          order: {
            symbol: normalized.gate, side, type, qty: round(size, 10), price: referencePrice,
            notional: round(notional, 4), leverage, reduceOnly,
            stopLoss: request.stopLoss, takeProfit: request.takeProfit,
          },
          equity: round(paperEquity(await markPrices(Object.keys(state.paper.positions))), 4),
        }
      }

      const client = await exchange()
      const symbol = backendSymbol(client, request.symbol)
      const [account, positions] = await Promise.all([client.account(), client.positions()])
      const equity = account.totalMarginBalance ?? account.totalWalletBalance
      const grossNotional = positions.reduce((sum, position) => sum + position.entryPrice * position.size, 0)
      assertRisk(
        { notional, leverage, entry: !reduceOnly, reduceOnly },
        { equity, grossNotional, dayPnl: exchangeDayPnl(equity) },
      )
      if (client instanceof BinanceClient) await client.setLeverage(symbol, leverage)
      const placement = await client.placeOrder({
        symbol, side, type, qty: request.qty, notional, price: request.price,
        referencePrice, leverage, reduceOnly,
        stopLoss: request.stopLoss, takeProfit: request.takeProfit,
      })
      return { mode: state.mode, backend: client.label, order: placement }
    },

    /** Cancel one order by id, or every open order for a symbol. */
    async cancel({ symbol, id } = {}) {
      await tick()
      if (state.mode === 'paper') {
        const wanted = symbol === undefined ? undefined : normalizeSymbol(symbol).gate
        const before = state.paper.orders.length
        state.paper.orders = state.paper.orders.filter(order => {
          if (id !== undefined) return order.id !== id
          if (wanted === undefined) return false
          return order.symbol !== wanted
        })
        store.save(state)
        return { mode: 'paper', canceled: before - state.paper.orders.length, remaining: state.paper.orders }
      }
      const client = await exchange()
      const wanted = symbol === undefined ? undefined : backendSymbol(client, symbol)
      return { mode: state.mode, backend: client.label, ...(await client.cancelOrder({ symbol: wanted, id })) }
    },

    /** Close all or part of one position at market. */
    async close({ symbol, qty, confirmation } = {}) {
      await tick()
      if (!symbol) throw new Error('close needs a symbol')
      if (state.mode === 'live' && String(confirmation ?? '') !== 'CLOSE') {
        throw new Error('closing a live position requires confirmation="CLOSE" (de-risking guard)')
      }
      const gate = normalizeSymbol(symbol).gate
      if (state.mode === 'paper') {
        const position = state.paper.positions[gate]
        if (position === undefined) throw new Error(`no paper position on ${gate}`)
        const size = qty !== undefined ? Math.min(qty, position.size) : position.size
        const ticker = await market.ticker(gate)
        const price = ticker.mark ?? ticker.last
        if (!Number.isFinite(price)) throw new Error(`no usable price for ${gate}`)
        const next = settlePaper(position, {
          symbol: gate, side: position.side === 'long' ? 'short' : 'long', size, price, leverage: position.leverage,
        }, 'close')
        if (next === undefined) delete state.paper.positions[gate]
        else state.paper.positions[gate] = next
        store.save(state)
        return { mode: 'paper', closed: { symbol: gate, qty: round(size, 10), price } }
      }
      const client = await exchange()
      const exchangeSymbol = backendSymbol(client, symbol)
      const positions = await client.positions(client instanceof BinanceClient ? exchangeSymbol : undefined)
      const position = positions.find(entry => entry.symbol === exchangeSymbol)
      if (position === undefined) throw new Error(`no open position on ${symbol}`)
      const size = qty !== undefined ? Math.min(qty, position.size) : position.size
      const ticker = await market.ticker(gate)
      const price = ticker.mark ?? ticker.last
      const order = await client.placeOrder({
        symbol: exchangeSymbol,
        side: position.side === 'long' ? 'short' : 'long',
        type: 'market',
        qty: size,
        referencePrice: price,
        reduceOnly: true,
      })
      return { mode: state.mode, backend: client.label, closed: { symbol: exchangeSymbol, qty: size, price }, order }
    },

    /** Set leverage for one symbol on the active backend. */
    async setLeverage({ symbol, leverage } = {}) {
      if (!symbol || !Number.isFinite(leverage) || leverage < 1) throw new Error('setLeverage needs a symbol and leverage >= 1')
      if (leverage > state.risk.maxLeverage) throw new Error(`leverage ${leverage} exceeds the configured cap ${state.risk.maxLeverage}`)
      const gate = normalizeSymbol(symbol).gate
      if (state.mode === 'paper') {
        const position = state.paper.positions[gate]
        if (position !== undefined) {
          position.leverage = leverage
          position.margin = (position.entry * position.size) / leverage
        }
        store.save(state)
        return { mode: 'paper', symbol: gate, leverage }
      }
      const client = await exchange()
      const exchangeSymbol = backendSymbol(client, symbol)
      await client.setLeverage(exchangeSymbol, leverage)
      return { mode: state.mode, backend: client.label, symbol: exchangeSymbol, leverage: Math.trunc(leverage) }
    },

    /** Update stop-loss / take-profit on one position (paper desk). */
    setProtection({ symbol, stopLoss, takeProfit, confirmation } = {}) {
      if (!symbol) throw new Error('setProtection needs a symbol')
      const gate = normalizeSymbol(symbol).gate
      if (state.mode !== 'paper') {
        throw new Error('manual protection updates are currently implemented only on the paper desk; on live/testnet attach stopLoss/takeProfit when placing the order')
      }
      const position = state.paper.positions[gate]
      if (position === undefined) throw new Error(`no open paper position on ${gate}`)
      if (stopLoss !== undefined) {
        const value = Number(stopLoss)
        if (!Number.isFinite(value) || value <= 0) throw new Error('stopLoss must be a positive price')
        if (position.side === 'long' && value >= position.entry) throw new Error('long stopLoss must be below entry')
        if (position.side === 'short' && value <= position.entry) throw new Error('short stopLoss must be above entry')
        position.stopLoss = value
      }
      if (takeProfit !== undefined) {
        const value = Number(takeProfit)
        if (!Number.isFinite(value) || value <= 0) throw new Error('takeProfit must be a positive price')
        if (position.side === 'long' && value <= position.entry) throw new Error('long takeProfit must be above entry')
        if (position.side === 'short' && value >= position.entry) throw new Error('short takeProfit must be below entry')
        position.takeProfit = value
      }
      store.save(state)
      return {
        mode: 'paper',
        symbol: gate,
        size: position.size,
        entry: position.entry,
        side: position.side,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        confirmation: confirmation === true,
      }
    },

    /** Recent fills and the paper equity trail. */
    history({ limit = 20 } = {}) {
      return {
        mode: state.mode,
        realizedPnl: round(state.paper.realizedPnl, 4),
        totalFees: round(state.paper.totalFees, 4),
        fills: state.paper.fills.slice(-limit).reverse(),
        equity: state.paper.equity.slice(-limit),
        note: state.mode === 'paper' ? undefined : 'fills and equity shown here are the local paper journal, not the exchange ledger',
      }
    },

    /** Read or update the risk rails. */
    risk(patch = {}) {
      for (const field of ['maxLeverage', 'maxOrderNotional', 'maxGrossNotional', 'maxDailyLoss']) {
        if (patch[field] !== undefined) {
          const value = Number(patch[field])
          if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`)
          state.risk[field] = value
        }
      }
      if (patch.killSwitch !== undefined) state.risk.killSwitch = patch.killSwitch === true
      store.save(state)
      return state.risk
    },
  }
}
