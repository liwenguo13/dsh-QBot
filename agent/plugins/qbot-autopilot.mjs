/**
 * QBot autonomous trading loop.
 *
 * The loop wakes on a fixed cadence, builds market/news/account context, asks
 * one or more configured models for a strict JSON decision, aggregates a
 * committee vote when needed, validates risk-increasing entries through the
 * compiled C++ kernel, then executes holds/opens/closes through the shared
 * desk. No user command is required once the profile is running.
 */
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fearGreed, fetchNews, indicators, normalizeSymbol } from '../lib/market.mjs'
import { runCppRisk } from '../lib/tool-groups.mjs'
import { applyControllerToActions, defaultController, evolveController, loadController, loadNodes, recordNode, sanitiseController, saveController } from '../lib/dream.mjs'

export const name = 'qbot-autopilot'
export const inject = ['llm', 'tools', 'qbotCore']

const ROLE_INSTRUCTIONS = {
  trend: 'Your committee role is the trend trader: prioritise trend continuation, pullback stabilisation and breakout retests.',
  reversal: 'Your committee role is the reversal trader: prioritise range edges, overbought/oversold extremes, false breakouts and mean-reversion opportunities.',
  news: 'Your committee role is the news and flow trader: prioritise news, ETF flows, funding rates, positioning crowding and macro events.',
  risk: 'Your committee role is the risk-control trader: prioritise capital preservation and low drawdown, reject uncertain trades, and prefer flat over risk.',
  macro: 'Your committee role is the macro trader: prioritise rates, liquidity, the US dollar and the overall direction of risk assets.',
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model did not return a JSON object')
  return JSON.parse(text.slice(start, end + 1))
}

function workspaceDir() {
  if (process.env.QBOT_WORKSPACE) return process.env.QBOT_WORKSPACE
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME, 'workspace')
  return resolve(homedir(), '.qbot-dsh', 'workspace')
}

/** Skill roots in priority order: workspace copy, DSH user skills (installer-seeded), legacy QBot home. */
function skillRoots() {
  const roots = [resolve(workspaceDir(), 'skills')]
  if (process.env.DSH_HOME) roots.push(resolve(process.env.DSH_HOME, 'skills'))
  roots.push(resolve(homedir(), '.dsh', 'skills'))
  return roots
}

/** Directory of one skill, preferring an existing root so reviews update the copy sessions read. */
function skillDirFor(name) {
  const roots = skillRoots()
  for (const root of roots) {
    const dir = resolve(root, name)
    if (existsSync(dir)) return dir
  }
  return resolve(roots[0], name)
}

async function appendJournal(text) {
  const dir = resolve(workspaceDir(), 'journal')
  await mkdir(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const line = `- ${new Date().toISOString()} [autopilot] ${String(text).replace(/\s+/g, ' ').trim()}\n`
  await appendFile(resolve(dir, `${day}.md`), line, 'utf8')
}

function parseModelSpecs(value) {
  const parts = String(value || 'opencode-go:deepseek-v4.1-flash')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const specs = []
  for (const entry of parts) {
    const at = entry.lastIndexOf('@')
    const base = at > 0 ? entry.slice(0, at).trim() : entry
    const role = at > 0 ? entry.slice(at + 1).trim().toLowerCase() : ''
    const index = base.indexOf(':')
    const provider = index < 0 ? 'opencode-go' : base.slice(0, index).trim()
    const model = index < 0 ? base.trim() : base.slice(index + 1).trim()
    if (provider && model) specs.push({ provider, model, role, label: `${provider}:${model}${role ? `@${role}` : ''}` })
  }
  return specs.length > 0 ? specs : [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', label: 'opencode-go:deepseek-v4.1-flash' }]
}

function weightedAverage(items) {
  const total = items.reduce((sum, item) => sum + item[1], 0)
  if (total <= 0) return 0
  return items.reduce((sum, item) => sum + item[0] * item[1], 0) / total
}

/**
 * Aggregate one committee round into a single decision.
 *
 * Majority direction wins only when its confidence-weighted share reaches the
 * configured threshold. A strong close/flat majority wins over open signals.
 * Disagreement becomes hold rather than a coin flip.
 */
export function aggregateDecisions(decisions, minAgreement = 0.6) {
  const valid = decisions.filter((entry) => entry && typeof entry === 'object' && entry.ok !== false)
  if (valid.length === 0) throw new Error('committee produced no valid decisions')
  if (valid.length === 1) return valid[0].decision ?? valid[0]

  const regimeWeights = {}
  const summaries = []
  const symbolVotes = new Map()
  const decisionConfidences = []

  for (const entry of valid) {
    const decision = entry.decision ?? entry
    const weight = Math.max(0.05, Math.min(1, Number(decision.confidence ?? 0.5)))
    decisionConfidences.push([Number(decision.confidence ?? 0.5), weight])
    const regime = String(decision.regime ?? 'uncertain')
    regimeWeights[regime] = (regimeWeights[regime] ?? 0) + weight
    if (decision.summary) summaries.push(String(decision.summary).slice(0, 180))
    for (const action of Array.isArray(decision.actions) ? decision.actions : []) {
      const symbol = action.symbol ? normalizeSymbol(action.symbol).gate : ''
      if (!symbol) continue
      const kind = String(action.action ?? action.type ?? '').toLowerCase()
      const state = symbolVotes.get(symbol) ?? { openLong: 0, openShort: 0, close: 0, total: 0, actions: [] }
      const confidence = Math.max(0.05, Math.min(1, Number(action.confidence ?? decision.confidence ?? 0.5)))
      if (kind === 'close' || kind === 'flat') {
        state.close += confidence
      } else if (kind === 'open' || kind === 'order' || kind === 'long' || kind === 'short') {
        const side = String(action.side ?? (kind === 'short' ? 'short' : 'long')).toLowerCase()
        if (side === 'short') state.openShort += confidence
        else state.openLong += confidence
      } else {
        continue
      }
      state.total += confidence
      state.actions.push({ action, confidence, kind })
      symbolVotes.set(symbol, state)
    }
  }

  const topRegime = Object.entries(regimeWeights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'uncertain'
  const topConfidence = weightedAverage(decisionConfidences)
  const actions = []

  for (const [symbol, state] of symbolVotes) {
    const total = state.total || 1
    const closeShare = state.close / total
    const agreement = Math.max(state.openLong, state.openShort) / total
    const direction = state.openLong >= state.openShort ? 1 : -1

    if (closeShare >= minAgreement && state.close >= Math.max(state.openLong, state.openShort)) {
      actions.push({ action: 'close', symbol, confidence: closeShare, reason: 'committee majority: close' })
      continue
    }
    if (agreement < minAgreement) {
      actions.push({ action: 'hold', symbol, confidence: agreement, reason: 'committee disagreement below threshold' })
      continue
    }

    const wanted = direction > 0 ? state.openLong : state.openShort
    const matching = state.actions.filter((item) => {
      const side = String(item.action.side ?? (item.kind === 'short' ? 'short' : 'long')).toLowerCase()
      return (direction > 0 && side !== 'short') || (direction < 0 && side === 'short')
    })
    const notionals = []
    const stops = []
    const targets = []
    const leverages = []
    const reasons = []
    for (const item of matching) {
      const a = item.action
      if (Number(a.notional) > 0) notionals.push([Number(a.notional), item.confidence])
      else if (Number(a.qty) > 0) notionals.push([Number(a.qty), item.confidence])
      if (Number(a.stop_loss) > 0) stops.push([Number(a.stop_loss), item.confidence])
      if (Number(a.take_profit) > 0) targets.push([Number(a.take_profit), item.confidence])
      if (Number(a.leverage) > 0) leverages.push([Number(a.leverage), item.confidence])
      if (a.reason) reasons.push(String(a.reason).slice(0, 160))
    }
    actions.push({
      action: 'open',
      symbol,
      side: direction > 0 ? 'long' : 'short',
      notional: notionals.length > 0 ? weightedAverage(notionals) : undefined,
      stop_loss: stops.length > 0 ? weightedAverage(stops) : undefined,
      take_profit: targets.length > 0 ? weightedAverage(targets) : undefined,
      leverage: leverages.length > 0 ? weightedAverage(leverages) : undefined,
      confidence: agreement * weightedAverage(decisionConfidences),
      reason: `committee ${wanted > 0 ? 'majority long' : 'majority short'}: ${reasons.join(' | ')}`,
    })
  }

  return {
    regime: topRegime,
    confidence: topConfidence,
    summary: `committee vote (${valid.length} models): ${summaries.join(' || ').slice(0, 1200)}`,
    actions,
    no_trade_reason: actions.some((a) => a.action === 'open') ? '' : 'committee reached no actionable consensus',
    _committee: { members: valid.length, minAgreement },
  }
}

export function apply(ctx, config) {
  const core = typeof ctx.get === 'function' ? ctx.get('qbotCore') : undefined
  if (!core) throw new Error('qbot-autopilot requires the qbotCore service')
  const { market, desk, config: coreConfig, autopilotState } = core
  const state = autopilotState
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  const symbols = String(coreConfig.autopilotSymbols || 'BTCUSDT')
    .split(',')
    .map((entry) => normalizeSymbol(entry).gate)
    .filter(Boolean)
  const modelSpecs = parseModelSpecs(coreConfig.autopilotModels)
  let minAgreement = Math.max(0.5, Math.min(1, Number(coreConfig.autopilotCommitteeMinAgreement ?? 0.6)))
  if (!state.dreamController) state.dreamController = defaultController()
  let controller = state.dreamController
  const dreamIntervalCycles = Math.max(0, Number(coreConfig.dreamIntervalCycles ?? 20))
  const dreamMaxCandidates = Math.max(2, Number(coreConfig.dreamMaxCandidates ?? 12))
  const maxDrawdownPct = Math.max(1, Number(coreConfig.autopilotMaxDrawdownPct ?? 10))
  const maxConsecutiveErrors = Math.max(1, Number(coreConfig.autopilotMaxConsecutiveErrors ?? 3))
  const reviewIntervalCycles = Math.max(0, Number(coreConfig.autopilotReviewIntervalCycles ?? 20))
  const equityHistoryLimit = Math.max(60, Number(coreConfig.autopilotEquityHistoryLimit ?? 500))
  let intervalMs = Math.max(1, Number(coreConfig.autopilotIntervalMinutes || 60)) * 60 * 1000
  const startupDelayMs = Math.max(0, Number(coreConfig.autopilotStartupDelaySeconds || 20)) * 1000

  let stopped = false
  let timer

  /** The provider that actually carries this model: the desktop profile names the route opencode-go-live. */
  const providerCache = new Map()
  async function resolveProviderFor(spec) {
    const key = `${spec.provider}:${spec.model}`
    if (providerCache.has(key)) return providerCache.get(key)
    let target = spec
    if (typeof llm.listModels === 'function') {
      for (const provider of [...new Set([spec.provider, 'opencode-go-live', 'opencode-go'])]) {
        try {
          const models = await llm.listModels(provider)
          if (Array.isArray(models) && models.some((model) => model.id === spec.model)) {
            target = provider === spec.provider ? spec : { ...spec, provider }
            break
          }
        } catch {}
      }
    }
    providerCache.set(key, target)
    return target
  }
  async function callModel(spec, system, user) {
    if (!llm || typeof llm.stream !== 'function') throw new Error('DSH llm service is unavailable')
    const roleText = spec.role && ROLE_INSTRUCTIONS[spec.role] ? `\n\n${ROLE_INSTRUCTIONS[spec.role]}` : ''
    const target = await resolveProviderFor(spec)
    const options = {
      provider: target.provider,
      model: spec.model,
      reasoningEffort: String(coreConfig.autopilotReasoningEffort || 'max'),
      system: `${system}${roleText}`,
      temperature: 0.2,
      maxTokens: Number(coreConfig.autopilotMaxTokens || 4000),
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'qbot-autopilot' },
      }],
    }
    let text = ''
    let blockText = ''
    let finish
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block?.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    // A failed generation ends with an error/aborted finish instead of throwing, so surface it
    // here rather than letting an empty string masquerade as a malformed JSON answer.
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      const failure = finish.failure ?? {}
      throw new Error(`LLM call ${finish.kind} (${target.provider}:${spec.model}): ${String(failure.message ?? failure.code ?? JSON.stringify(failure)).slice(0, 300)}`)
    }
    const output = text || blockText
    if (String(output).trim() === '') {
      throw new Error(`LLM returned no text (${target.provider}:${spec.model} finish=${finish?.kind ?? 'unknown'})`)
    }
    return output
  }

  async function callAndParse(spec, system, user) {
    let raw = await callModel(spec, system, user)
    try {
      return extractJson(raw)
    } catch (firstError) {
      raw = await callModel(spec, `${system}\n\nThe previous output was not valid JSON. This time return exactly one JSON object, with no explanation, Markdown or tool calls.`, user)
      return extractJson(raw)
    }
  }

  async function readSkill() {
    try {
      const path = resolve(skillDirFor('qbot-trading'), 'SKILL.md')
      if (existsSync(path)) return await readFile(path, 'utf8')
    } catch {}
    return ''
  }

  function modelWeight(label) {
    const stats = state.modelStats?.[label]
    if (!stats || stats.votes < 3) return 1
    const accuracy = stats.correct / Math.max(1, stats.votes)
    return Math.max(0.5, Math.min(1.5, 0.5 + accuracy))
  }

  function evaluatePendingVotes(context) {
    if (!Array.isArray(state.pendingVotes) || state.pendingVotes.length === 0) return
    const remaining = []
    for (const vote of state.pendingVotes) {
      const strip = context.market?.[vote.symbol]
      const price = Number(strip?.ticker?.mark ?? strip?.ticker?.last)
      if (!(price > 0)) {
        remaining.push(vote)
        continue
      }
      const stats = state.modelStats[vote.model] ?? { votes: 0, correct: 0, lastAt: null }
      const move = (price / vote.entry - 1) * (vote.side === 'long' ? 1 : -1)
      stats.votes += 1
      if (move > 0) stats.correct += 1
      stats.lastAt = new Date().toISOString()
      state.modelStats[vote.model] = stats
    }
    state.pendingVotes = remaining.slice(-500)
  }

  function recordPendingVotes(memberResults, context) {
    for (const entry of memberResults) {
      if (!entry.ok) continue
      const decision = entry.decision ?? {}
      for (const action of Array.isArray(decision.actions) ? decision.actions : []) {
        const kind = String(action.action ?? action.type ?? '').toLowerCase()
        if (kind !== 'open' && kind !== 'order' && kind !== 'long' && kind !== 'short') continue
        const symbol = action.symbol ? normalizeSymbol(action.symbol).gate : ''
        const price = Number(context.market?.[symbol]?.ticker?.mark ?? context.market?.[symbol]?.ticker?.last)
        if (!symbol || !(price > 0)) continue
        const side = String(action.side ?? (kind === 'short' ? 'short' : 'long')).toLowerCase() === 'short' ? 'short' : 'long'
        state.pendingVotes = [
          ...(Array.isArray(state.pendingVotes) ? state.pendingVotes : []),
          { model: entry.spec.label, symbol, side, entry: price, at: new Date().toISOString(), cycle: state.cycle },
        ].slice(-500)
      }
    }
  }

  async function runReview(status) {
    const spec = modelSpecs[0]
    const history = (state.decisionHistory ?? []).slice(-20)
    const fills = desk.history({ limit: 30 }).fills
    const reviewContext = { cycle: state.cycle, mode: status.mode, stats: state.modelStats, history, fills }
    const system = 'You are the QBot trading reviewer. Based on the decision history, model votes and paper fills from the autonomous loop, summarise verifiable patterns and propose edits to the qbot-trading skill. Output JSON only, no Markdown.'
    const user = 'Review context:\n\n' + JSON.stringify(reviewContext) + '\n\nOutput format:\n{"insights":"2-5 findings","suggested_skill_notes":"rules to write into qbot-trading","confidence":0.0}'
    const raw = await callModel(spec, system, user)
    const review = extractJson(raw)
    const reviewLine = `\n## Automated review ${new Date().toISOString()}\n\n- cycle: ${state.cycle}\n- insights: ${String(review.insights ?? '').trim()}\n- suggestions: ${String(review.suggested_skill_notes ?? '').trim()}\n`
    const skillDir = skillDirFor('qbot-trading')
    await mkdir(skillDir, { recursive: true })
    await appendFile(resolve(skillDir, 'REVIEW.md'), reviewLine, 'utf8')
    state.reviews = [
      ...(Array.isArray(state.reviews) ? state.reviews : []),
      { at: new Date().toISOString(), cycle: state.cycle, insights: review.insights ?? '', suggested: review.suggested_skill_notes ?? '', confidence: Number(review.confidence ?? 0) },
    ].slice(-50)
    if (coreConfig.autopilotAutoEditSkill === true && typeof review.skill_markdown === 'string' && review.skill_markdown.length > 200) {
      const skillPath = resolve(skillDir, 'SKILL.md')
      if (existsSync(skillPath)) await copyFile(skillPath, resolve(skillDir, 'SKILL.md.bak'))
      await writeFile(skillPath, review.skill_markdown, 'utf8')
      await appendJournal(`cycle=${state.cycle} auto-edited qbot-trading/SKILL.md from review`)
    }
    await appendJournal(`cycle=${state.cycle} review=${String(review.insights ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
  }

  function pearson(a, b) {
    const n = Math.min(a.length, b.length)
    if (n < 10) return 0
    const aa = a.slice(-n)
    const bb = b.slice(-n)
    const meanA = aa.reduce((sum, value) => sum + value, 0) / n
    const meanB = bb.reduce((sum, value) => sum + value, 0) / n
    let num = 0
    let denA = 0
    let denB = 0
    for (let i = 0; i < n; i += 1) {
      const da = aa[i] - meanA
      const db = bb[i] - meanB
      num += da * db
      denA += da * da
      denB += db * db
    }
    return denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 0
  }

  async function buildContext(status) {
    const marketContext = {}
    const returnSeries = {}
    for (const symbol of symbols) {
      try {
        const [ticker, candles] = await Promise.all([
          market.ticker(symbol),
          market.candles(symbol, '1h', 160),
        ])
        const closes = candles.map((candle) => Number(candle.c)).filter((value) => value > 0)
        const returns = []
        for (let i = 1; i < closes.length; i += 1) returns.push(closes[i] / closes[i - 1] - 1)
        returnSeries[symbol] = returns
        marketContext[symbol] = {
          ticker: { last: ticker.last, mark: ticker.mark, volume24h: ticker.quoteVolume24h, fundingRate: ticker.fundingRate },
          indicators: indicators(candles, 14),
        }
      } catch (error) {
        marketContext[symbol] = { error: String(error?.message ?? error) }
      }
    }
    const [news, sentiment] = await Promise.all([
      fetchNews({ limit: 5 }).catch((error) => ({ items: [], errors: [String(error?.message ?? error)] })),
      fearGreed().catch(() => []),
    ])

    const equity = Number(status.account?.equity ?? 0)
    let heatUsdt = 0
    let grossNotional = 0
    for (const position of status.positions ?? []) {
      const size = Math.abs(Number(position.size ?? 0))
      const mark = Number(position.mark ?? position.entry ?? 0)
      const entry = Number(position.entry ?? mark)
      const stop = Number(position.stopLoss ?? 0)
      grossNotional += size * mark
      const unitRisk = stop > 0 ? Math.abs(entry - stop) : entry * 0.03
      heatUsdt += size * unitRisk
    }
    const heatPct = equity > 0 ? heatUsdt / equity * 100 : 0
    const correlations = {}
    const names = Object.keys(returnSeries)
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        correlations[`${names[i]}/${names[j]}`] = Number(pearson(returnSeries[names[i]], returnSeries[names[j]]).toFixed(3))
      }
    }
    return {
      time: new Date().toISOString(),
      mode: status.mode,
      account: status.account,
      positions: status.positions,
      orders: status.orders,
      recentFills: desk.history({ limit: 8 }).fills,
      market: marketContext,
      news,
      fearGreed: sentiment,
      risk: status.risk,
      portfolio: {
        heatPct: Number(heatPct.toFixed(3)),
        heatUsdt: Number(heatUsdt.toFixed(4)),
        grossNotional: Number(grossNotional.toFixed(4)),
        grossPct: equity > 0 ? Number((grossNotional / equity * 100).toFixed(3)) : 0,
        maxHeatPct: Number(coreConfig.autopilotMaxPortfolioHeatPct ?? 3),
        correlations,
      },
    }
  }

  async function executeAction(action, status) {
    const kind = String(action.action ?? action.type ?? '').toLowerCase()
    if (kind === '' || kind === 'hold' || kind === 'no_trade') return null
    if (kind === 'close' || kind === 'flat') {
      if (!action.symbol) throw new Error('close action requires symbol')
      const result = await desk.close({ symbol: action.symbol, qty: action.qty === undefined ? undefined : Number(action.qty) })
      return { kind: 'close', ...result }
    }
    if (kind === 'open' || kind === 'order' || kind === 'long' || kind === 'short') {
      const resolved = normalizeSymbol(action.symbol)
      if (!symbols.includes(resolved.gate)) throw new Error(`symbol ${resolved.gate} is not in autopilotSymbols`)
      const side = String(action.side ?? (kind === 'short' ? 'short' : 'long')).toLowerCase() === 'short' ? 'short' : 'long'
      const stopLoss = Number(action.stop_loss)
      if (!(stopLoss > 0)) throw new Error('open action requires a positive stop_loss')
      const ticker = await market.ticker(action.symbol)
      const entry = Number(ticker.mark ?? ticker.last)
      if (!(entry > 0)) throw new Error('no usable market price for entry validation')
      const equity = Number(status.account?.equity)
      if (!(equity > 0)) throw new Error('no usable account equity')
      const requested = Number(action.notional ?? action.amount ?? 0) || (Number(action.qty) * entry)
      if (!(requested > 0)) throw new Error('open action needs positive notional or qty')
      const cpp = await runCppRisk(coreConfig, {
        equity,
        entry,
        stop: stopLoss,
        risk_pct: Number(coreConfig.cppRiskPct ?? 1),
        max_notional: Number(coreConfig.maxOrderNotional ?? 2000),
        max_leverage: Number(coreConfig.maxLeverage ?? 5),
      }, Number(coreConfig.cppTimeoutMs ?? 10000))
      if (cpp.ok !== true) throw new Error(cpp.error ?? 'C++ risk kernel rejected the entry')
      const notional = Math.min(requested, Number(cpp.notional), Number(coreConfig.maxOrderNotional ?? requested))
      const result = await desk.order({
        symbol: action.symbol,
        side,
        type: 'market',
        notional,
        leverage: action.leverage === undefined ? undefined : Number(action.leverage),
        stopLoss,
        takeProfit: action.take_profit === undefined ? undefined : Number(action.take_profit),
      })
      return { kind: 'open', requestedNotional: requested, approvedCppNotional: Number(cpp.notional), ...result }
    }
    throw new Error(`unsupported autopilot action "${kind}"`)
  }

  function isOpenAction(action) {
    const kind = String(action.action ?? action.type ?? '').toLowerCase()
    return kind === 'open' || kind === 'order' || kind === 'long' || kind === 'short'
  }

  function applyControllerPolicy(actions, activeController) {
    const policy = coreConfig.dreamAllowControllerCode === false ? { ...activeController, code: '' } : activeController
    return applyControllerToActions(actions, policy, 0.5)
  }


  function applyPortfolioBudget(actions, context, status) {
    const equity = Number(status.account?.equity ?? 0)
    if (!(equity > 0)) return actions
    const maxHeat = Number(controller.heatCapPct ?? coreConfig.autopilotMaxPortfolioHeatPct ?? 3)
    const maxPairCorrelation = Number(controller.correlationLimit ?? coreConfig.autopilotMaxPairCorrelation ?? 0.85)
    const openPlans = []
    for (const action of actions) {
      const kind = String(action.action ?? action.type ?? '').toLowerCase()
      if (kind !== 'open' && kind !== 'order' && kind !== 'long' && kind !== 'short') continue
      const symbol = action.symbol ? normalizeSymbol(action.symbol).gate : ''
      const mark = Number(context.market?.[symbol]?.ticker?.mark ?? context.market?.[symbol]?.ticker?.last)
      const stop = Number(action.stop_loss)
      let notional = Number(action.notional ?? 0)
      if (!(notional > 0) && Number(action.qty) > 0 && mark > 0) notional = Number(action.qty) * mark
      if (!symbol || !(mark > 0) || !(notional > 0)) continue
      const stopPct = stop > 0 ? Math.abs(mark - stop) / mark * 100 : 3
      openPlans.push({
        action, symbol, mark, notional, stopPct,
        riskPct: notional / equity * stopPct,
        side: String(action.side ?? (kind === 'short' ? 'short' : 'long')).toLowerCase() === 'short' ? 'short' : 'long',
      })
    }
    if (openPlans.length === 0) return actions

    const currentHeat = Number(context.portfolio?.heatPct ?? 0)
    const proposedHeat = openPlans.reduce((sum, plan) => sum + plan.riskPct, 0)
    if (currentHeat + proposedHeat > maxHeat && proposedHeat > 0) {
      const scale = Math.max(0, (maxHeat - currentHeat) / proposedHeat)
      for (const plan of openPlans) {
        plan.notional *= scale
        plan.action.notional = plan.notional
        plan.action.reason = `${String(plan.action.reason ?? '')} [portfolio heat scale ${scale.toFixed(2)}]`
      }
    }

    for (let i = 0; i < openPlans.length; i += 1) {
      for (let j = i + 1; j < openPlans.length; j += 1) {
        const a = openPlans[i]
        const b = openPlans[j]
        if (a.side !== b.side) continue
        const key = `${a.symbol}/${b.symbol}`
        const reverse = `${b.symbol}/${a.symbol}`
        const correlation = Number(context.portfolio?.correlations?.[key] ?? context.portfolio?.correlations?.[reverse] ?? 0)
        if (correlation <= maxPairCorrelation) continue
        const weaker = Number(a.action.confidence ?? 0) <= Number(b.action.confidence ?? 0) ? a : b
        weaker.notional *= 0.5
        weaker.action.notional = weaker.notional
        weaker.action.reason = `${String(weaker.action.reason ?? '')} [correlation ${correlation.toFixed(2)} with ${a === weaker ? b.symbol : a.symbol}; halved]`
      }
    }

    return actions.filter((action) => {
      const kind = String(action.action ?? action.type ?? '').toLowerCase()
      if (kind !== 'open' && kind !== 'order' && kind !== 'long' && kind !== 'short') return true
      const plan = openPlans.find((item) => item.action === action)
      if (!plan || plan.notional >= 5) return true
      action.action = 'hold'
      action.reason = `${String(action.reason ?? '')} [dropped: portfolio budget too small]`
      delete action.side
      delete action.stop_loss
      return true
    })
  }

  async function runDreamEvolution(trigger = 'auto') {
    if (coreConfig.dreamEnabled === false) return false
    if (state.dreamRunning) return false
    state.dreamRunning = true
    try {
      const nodes = await loadNodes(2000)
      state.dreamNodeCount = nodes.length
      if (nodes.length < 2) {
        state.dreamLastError = 'not enough grounded nodes for replay'
        state.dreamLastRunAt = new Date().toISOString()
        return false
      }
      const replayOptions = {
        cppBinPath: coreConfig.cppBinPath,
        cppWslDistro: coreConfig.cppWslDistro,
        cppWslBinPath: coreConfig.cppWslBinPath,
        slippageBps: Number(coreConfig.dreamSlippageBps ?? 2),
        feeRate: Number(coreConfig.takerFeeRate ?? 0.0005),
        wallet: Number(coreConfig.paperWallet ?? 10000),
        timeoutMs: Number(coreConfig.cppTimeoutMs ?? 20000),
      }
      const neighbor = await evolveController(controller, nodes, dreamMaxCandidates, [], replayOptions)
      const modelCandidates = await proposeModelControllers(nodes, neighbor.current, neighbor.results).catch(() => [])
      const evolution = modelCandidates.length > 0
        ? await evolveController(controller, nodes, dreamMaxCandidates, modelCandidates, replayOptions)
        : neighbor
      const currentScore = Number(evolution.current?.score ?? 0)
      const bestScore = Number(evolution.best?.score ?? currentScore)
      const improved = bestScore > currentScore + Number(coreConfig.dreamMinImprovement ?? 0.0001)
      if (improved && evolution.best?.controller) {
        controller = { ...evolution.best.controller, version: Number(controller.version ?? 1) + 1, createdAt: new Date().toISOString() }
        state.dreamController = controller
        state.dreamScore = bestScore
      } else {
        state.dreamScore = currentScore
      }
      state.dreamLastResult = {
        trigger,
        current: evolution.current,
        best: evolution.best,
        chosen: controller,
        improved,
      }
      state.dreamLastError = null
      state.dreamHistory = [
        ...(Array.isArray(state.dreamHistory) ? state.dreamHistory : []),
        { at: new Date().toISOString(), cycle: state.cycle, trigger, improved, currentScore, bestScore, chosen: controller.name },
      ].slice(-30)
      await appendJournal(`cycle=${state.cycle} trigger=${trigger} dream replay current=${currentScore.toFixed(4)} best=${bestScore.toFixed(4)} improved=${improved} controller=${controller.name} v${controller.version}`)
      return true
    } catch (error) {
      state.dreamLastError = String(error?.message ?? error)
      state.lastError = `dream replay failed: ${state.dreamLastError}`
      return false
    } finally {
      state.dreamRunning = false
      state.dreamLastRunAt = new Date().toISOString()
    }
  }

  async function proposeModelControllers(nodes, currentResult, neighborResults) {
    const spec = modelSpecs[0]
    const compactResults = (neighborResults ?? []).slice(0, 10).map((result) => ({
      name: result.controller?.name,
      score: result.score,
      totalReturnPct: result.totalReturnPct,
      winRate: result.winRate,
      trades: result.trades,
      maxDrawdownPct: result.maxDrawdownPct,
      params: {
        minConfidence: result.controller?.minConfidence,
        riskScale: result.controller?.riskScale,
        maxActions: result.controller?.maxActions,
        heatCapPct: result.controller?.heatCapPct,
        correlationLimit: result.controller?.correlationLimit,
        committeeMinAgreement: result.controller?.committeeMinAgreement,
      },
    }))
    const context = {
      currentController: controller,
      currentReplay: currentResult,
      neighborResults: compactResults,
      recentTree: (nodes ?? []).slice(-20).map((node) => ({
        cycle: node.cycle,
        mode: node.mode,
        equity: node.equity,
        drawdownPct: node.drawdownPct,
        heatPct: node.heatPct,
        decision: node.decision,
        executed: node.executed,
      })),
    }
    const system = 'You are the QBot controller-development agent. Base new exploration-controller parameters only on the provided real replay results and real history nodes. Do not invent history, do not modify model weights; optimise only scheduling, filtering and risk-budget policy. Output JSON only.'
    const user = 'Based on the real history and replay results below, propose 2-4 new controller parameter combinations. You may optimise parameters, branchStrategy and sandboxed strategy code together. code must be a single arrow-function expression taking ctx and returning {"allow":boolean,"scale":number}; require/process/eval/import/Function/constructor are forbidden. Output JSON only.\n\n' + JSON.stringify(context) + '\n\nOutput format:\n{"controllers":[{"name":"dream-...","minConfidence":0.55,"riskScale":1.0,"maxActions":4,"heatCapPct":3.0,"correlationLimit":0.85,"committeeMinAgreement":0.6,"branchStrategy":"aggregate","code":"(ctx) => ({ allow: true, scale: 1 })"}]}'
    const raw = await callModel(spec, system, user)
    const parsed = extractJson(raw)
    const list = Array.isArray(parsed.controllers) ? parsed.controllers : []
    return list
      .slice(0, Math.max(1, Number(coreConfig.dreamMaxCandidates ?? 12)))
      .map((candidate) => sanitiseController(candidate, controller))
  }

  async function runCycle() {
    if (stopped || state.running) return
    state.running = true
    state.cycle += 1
    state.startedAt = new Date().toISOString()
    try {
      const status = await desk.status()
      const equity = Number(status.account?.equity)
      if (Number.isFinite(equity) && equity > 0) {
        state.equityHistory = [...(state.equityHistory ?? []), { at: new Date().toISOString(), equity }].slice(-equityHistoryLimit)
        state.peakEquity = Math.max(Number(state.peakEquity ?? equity), equity)
        state.drawdownPct = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity * 100 : 0
      }
      if (status.mode === 'live' && coreConfig.autopilotAllowLive !== true) {
        throw new Error('autopilot is paused in live mode: set autopilotAllowLive=true deliberately first')
      }
      if (status.mode === 'testnet' && coreConfig.autopilotAllowTestnet !== true) {
        throw new Error('autopilot is paused in testnet mode: set autopilotAllowTestnet=true first')
      }
      if (state.drawdownPct >= maxDrawdownPct) {
        state.enabled = false
        state.pauseReason = `drawdown ${state.drawdownPct.toFixed(2)}% >= ${maxDrawdownPct}%`
        state.lastPauseAt = new Date().toISOString()
        await appendJournal(`cycle=${state.cycle} autopilot paused: ${state.pauseReason}`)
        return
      }
      const dayPnl = Number(status.account?.dayPnl ?? 0)
      const maxDailyLoss = Number(coreConfig.maxDailyLoss ?? 500)
      if (dayPnl <= -maxDailyLoss) {
        state.enabled = false
        state.pauseReason = `daily PnL ${dayPnl.toFixed(2)} <= -${maxDailyLoss}`
        state.lastPauseAt = new Date().toISOString()
        await appendJournal(`cycle=${state.cycle} autopilot paused: ${state.pauseReason}`)
        return
      }

      const context = await buildContext(status)
      evaluatePendingVotes(context)
      const skill = await readSkill()
      const system = `You are QBot, a fully autonomous, low-frequency crypto perpetual-futures trading agent. No human trader is directing you; unless the user interrupts, you must keep observing, deciding and recording on your own.\n\n${skill}\n\nOutput requirements: return exactly one JSON object, no Markdown, no explanation. Action types are limited to open / close / hold. An open must include stop_loss; you propose the target notional, but the C++ risk kernel truncates it.`
      const user = `Current trading context:\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nReturn the decision JSON in this format:\n{\n  "regime": "trend_up|trend_down|range|chaotic",\n  "confidence": 0.0,\n  "summary": "short summary",\n  "actions": [\n    {"action":"open","symbol":"BTCUSDT","side":"long|short","notional":500,"leverage":2,"stop_loss":72000,"take_profit":80000,"confidence":0.7,"reason":"..."},\n    {"action":"close","symbol":"ETHUSDT","qty":0.1,"reason":"..."},\n    {"action":"hold","symbol":"SOLUSDT","reason":"..."}\n  ],\n  "no_trade_reason": ""\n}`

      const memberResults = modelSpecs.length === 1
        ? [{ spec: modelSpecs[0], ok: true, decision: await callAndParse(modelSpecs[0], system, user) }]
        : (await Promise.all(modelSpecs.map(async (spec) => {
            try {
              return { spec, ok: true, decision: await callAndParse(spec, system, user) }
            } catch (error) {
              return { spec, ok: false, error: String(error?.message ?? error) }
            }
          })))
      const successful = memberResults.filter((entry) => entry.ok)
      if (successful.length === 0) {
        throw new Error(`all committee models failed: ${memberResults.map((entry) => entry.error).join('; ')}`)
      }
      for (const entry of successful) {
        const weight = modelWeight(entry.spec.label)
        const decision = entry.decision ?? {}
        decision.confidence = Math.max(0.05, Math.min(1, Number(decision.confidence ?? 0.5) * weight))
        for (const action of Array.isArray(decision.actions) ? decision.actions : []) {
          action.confidence = Math.max(0.05, Math.min(1, Number(action.confidence ?? decision.confidence) * weight))
        }
      }
      let decision
      if (controller.branchStrategy === 'primary' && successful.length > 0) {
        decision = successful[0].decision
      } else if (controller.branchStrategy === 'best_confidence' && successful.length > 0) {
        decision = successful
          .slice()
          .sort((a, b) => Number(b.decision?.confidence ?? 0) - Number(a.decision?.confidence ?? 0))[0].decision
      } else {
        decision = successful.length === 1
          ? successful[0].decision
          : aggregateDecisions(successful.map((entry) => ({ ...entry, ok: true })), Number(controller.committeeMinAgreement ?? minAgreement))
      }
      decision._committee = {
        members: memberResults.map((entry) => ({
          model: entry.spec.label,
          ok: entry.ok,
          error: entry.error ?? null,
          regime: entry.decision?.regime ?? null,
          confidence: Number(entry.decision?.confidence ?? 0),
          summary: String(entry.decision?.summary ?? '').slice(0, 240),
          actions: Array.isArray(entry.decision?.actions) ? entry.decision.actions.slice(0, 4) : [],
        })),
        successful: successful.length,
        minAgreement,
      }
      recordPendingVotes(successful, context)
      state.lastDecision = decision
      state.lastSummary = String(decision.summary ?? '')
      state.lastRegime = String(decision.regime ?? '')
      state.decisionHistory = [
        ...(Array.isArray(state.decisionHistory) ? state.decisionHistory : []),
        {
          at: new Date().toISOString(),
          cycle: state.cycle,
          regime: state.lastRegime,
          confidence: Number(decision.confidence ?? 0),
          summary: state.lastSummary,
          actions: Array.isArray(decision.actions) ? decision.actions.slice(0, 4) : [],
          noTradeReason: String(decision.no_trade_reason ?? ''),
          committee: decision._committee,
        },
      ].slice(-20)
      state.lastPortfolio = context.portfolio
      const rawActions = Array.isArray(decision.actions) ? decision.actions.slice(0, 6) : []
      let actions = applyControllerPolicy(rawActions.map((action) => ({ ...action })), controller)
      actions = applyPortfolioBudget(actions, context, status)
      const results = []
      for (const action of actions) {
        try {
          const result = await executeAction(action, status)
          if (result !== null) results.push(result)
        } catch (error) {
          results.push({ kind: String(action.action ?? action.type ?? 'unknown'), symbol: action.symbol, error: String(error?.message ?? error) })
        }
      }
      state.lastActions = results
      state.consecutiveErrors = 0
      state.pauseReason = null
      state.lastError = null

      const prices = {}
      for (const symbol of symbols) prices[symbol] = Number(context.market?.[symbol]?.ticker?.mark ?? context.market?.[symbol]?.ticker?.last ?? 0)
      const fundingRates = {}
      for (const symbol of symbols) fundingRates[symbol] = Number(context.market?.[symbol]?.ticker?.fundingRate ?? 0)
      await recordNode({
        id: state.cycle,
        at: new Date().toISOString(),
        cycle: state.cycle,
        mode: status.mode,
        equity: Number(status.account?.equity ?? 0),
        prices,
        fundingRates,
        positions: status.positions,
        controller: { ...controller },
        decision: { ...decision, actions: rawActions },
        branches: {
          aggregate: { ...decision, actions: rawActions },
          members: successful.map((entry) => ({ model: entry.spec.label, decision: entry.decision })),
        },
        modelCalls: memberResults.length,
        executed: results,
        drawdownPct: state.drawdownPct,
        heatPct: context.portfolio?.heatPct,
      })
      state.dreamNodeCount = Number(state.dreamNodeCount ?? 0) + 1

      if (coreConfig.dreamEnabled !== false && dreamIntervalCycles > 0 && state.cycle % dreamIntervalCycles === 0) {
        await runDreamEvolution('auto')
      }

      if (reviewIntervalCycles > 0 && state.cycle % reviewIntervalCycles === 0) {
        try { await runReview(status) } catch (error) { state.lastError = `auto-review failed: ${String(error?.message ?? error)}` }
      }
      await appendJournal(`cycle=${state.cycle} mode=${status.mode} models=${modelSpecs.length} regime=${decision.regime ?? '--'} actions=${JSON.stringify(results)} summary=${decision.summary ?? ''}`)
    } catch (error) {
      state.consecutiveErrors = Number(state.consecutiveErrors ?? 0) + 1
      state.lastError = String(error?.message ?? error)
      if (state.consecutiveErrors >= maxConsecutiveErrors) {
        state.enabled = false
        state.pauseReason = `autopilot paused after ${state.consecutiveErrors} consecutive errors: ${state.lastError}`
        state.lastPauseAt = new Date().toISOString()
      }
      try { await appendJournal(`cycle=${state.cycle} error=${state.lastError} consecutive=${state.consecutiveErrors}`) } catch {}
      ctx.logger?.error?.(`[qbot-autopilot] cycle failed: ${state.lastError}`)
    } finally {
      state.running = false
      state.lastRunAt = new Date().toISOString()
    }
  }

  function scheduleNext(delayOverride) {
    if (stopped || !state.enabled) return
    if (timer !== undefined) clearTimeout(timer)
    const delay = delayOverride === undefined ? (state.cycle === 0 ? startupDelayMs : intervalMs) : Math.max(0, Number(delayOverride))
    state.nextRunAt = new Date(Date.now() + delay).toISOString()
    timer = setTimeout(async () => {
      await runCycle()
      scheduleNext()
    }, delay)
  }

  const control = {
    pause() {
      state.enabled = false
      state.nextRunAt = null
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      ctx.logger?.info?.('[qbot-autopilot] paused by control')
    },
    resume() {
      if (stopped) return
      state.enabled = true
      state.pauseReason = null
      state.consecutiveErrors = 0
      if (!state.running) scheduleNext(0)
      ctx.logger?.info?.('[qbot-autopilot] resumed by control')
    },
    runNow() {
      if (stopped || state.running) return false
      state.enabled = true
      void runCycle().finally(() => {
        if (!stopped && state.enabled) scheduleNext()
      })
      return true
    },
    runDream() {
      if (stopped || state.dreamRunning) return false
      void runDreamEvolution('manual')
      return true
    },
    setIntervalMinutes(minutes) {
      const value = Math.max(1, Math.min(24 * 60, Number(minutes)))
      intervalMs = value * 60 * 1000
      coreConfig.autopilotIntervalMinutes = value
      if (!stopped && state.enabled) scheduleNext()
      return value
    },
  }
  core.autopilotControl = control

  ctx.tools.register(defineTool({
    name: 'autopilot_status',
    description: 'Read the autonomous QBot trading loop status: enabled, running, cycle, last run, next run, last decision, committee state and last error.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      return json(state)
    },
  }))

  ctx.effect(() => {
    ctx.logger?.info?.(`[qbot-autopilot] loop enabled=${state.enabled} interval=${intervalMs / 60000}min models=${modelSpecs.map((spec) => spec.label).join(',')} symbols=${symbols.join(',')}`)
    void loadNodes(2000).then((nodes) => { state.dreamNodeCount = nodes.length }).catch(() => {})
    void loadController().then((saved) => {
      if (saved) {
        controller = saved
        state.dreamController = controller
        ctx.logger?.info?.(`[qbot-autopilot] restored controller ${controller.name} v${controller.version}`)
      }
    }).catch(() => {})
    scheduleNext()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'qbot autonomous trading loop')
}
