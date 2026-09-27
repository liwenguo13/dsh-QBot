/**
 * QBot Dream-RSI history replay and controller evolution.
 *
 * Every cycle is a grounded node: real prices, model branches, portfolio state
 * and executed actions.  Replay selects a controller policy, picks a branch
 * from each node, converts the selected opens/closes into a C++ paper-ledger
 * simulation (fees, slippage, funding), and scores the resulting equity curve.
 * No unseen future is invented: it only replays decisions that actually
 * happened and prices that were actually observed.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { runCpp } from './cpp.mjs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { normalizeSymbol } from './market.mjs'

export function workspaceDir() {
  return process.env.QBOT_WORKSPACE ?? resolve(homedir(), '.qbot-dsh', 'workspace')
}

export function treePath() {
  return resolve(workspaceDir(), 'dream', 'discovery-tree.jsonl')
}

export function controllerPath() {
  return resolve(workspaceDir(), 'dream', 'controller.json')
}

export async function saveController(controller) {
  const path = controllerPath()
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(controller, null, 2), 'utf8')
  return controller
}

export async function loadController() {
  const path = controllerPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return sanitiseController(parsed, defaultController())
  } catch {
    return null
  }
}

export function defaultController(version = 1, name = 'default-v1') {
  return {
    version,
    name,
    minConfidence: 0.55,
    riskScale: 1.0,
    maxActions: 4,
    heatCapPct: 3.0,
    correlationLimit: 0.85,
    committeeMinAgreement: 0.6,
    branchStrategy: 'aggregate',
    modelCallCost: 0.0,
    tradeCost: 0.02,
    code: '',
    createdAt: new Date().toISOString(),
  }
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

function actionKind(action) {
  return String(action.action ?? action.type ?? '').toLowerCase()
}

function isOpenAction(action) {
  const kind = actionKind(action)
  return kind === 'open' || kind === 'order' || kind === 'long' || kind === 'short'
}

function isCloseAction(action) {
  const kind = actionKind(action)
  return kind === 'close' || kind === 'flat'
}

function actionSide(action) {
  const kind = actionKind(action)
  if (kind === 'short') return 'short'
  if (kind === 'long') return 'long'
  return String(action.side ?? 'long').toLowerCase() === 'short' ? 'short' : 'long'
}

function maxDrawdownPct(curve) {
  let peak = curve[0] ?? 0
  let worst = 0
  for (const value of curve) {
    peak = Math.max(peak, value)
    worst = Math.max(worst, peak - value)
  }
  return worst
}

export function sanitiseController(candidate, base) {
  const fallback = base ?? defaultController()
  const value = candidate && typeof candidate === 'object' ? candidate : {}
  const pick = (field, low, high) => {
    const raw = Number(value[field] ?? fallback[field])
    if (!Number.isFinite(raw)) return Number(fallback[field])
    return Math.max(low, Math.min(high, raw))
  }
  const strategy = String(value.branchStrategy ?? fallback.branchStrategy ?? 'aggregate')
  const branchStrategy = ['aggregate', 'primary', 'best_confidence'].includes(strategy) ? strategy : 'aggregate'
  const rawCode = typeof value.code === 'string' ? value.code.slice(0, 2000) : (typeof fallback.code === 'string' ? fallback.code : '')
  const forbidden = /(require|process|globalThis|constructor|Function|eval|import\s*\()/.test(rawCode)
  return {
    version: Number.isFinite(Number(value.version)) ? Math.max(1, Math.trunc(Number(value.version))) : Number(fallback.version ?? 1),
    name: String(value.name || `dream-${Date.now()}`).slice(0, 80),
    minConfidence: pick('minConfidence', 0.20, 0.95),
    riskScale: pick('riskScale', 0.10, 2.00),
    maxActions: Math.trunc(pick('maxActions', 1, 8)),
    heatCapPct: pick('heatCapPct', 0.50, 10.00),
    correlationLimit: pick('correlationLimit', 0.30, 1.00),
    committeeMinAgreement: pick('committeeMinAgreement', 0.50, 1.00),
    branchStrategy,
    modelCallCost: Number(fallback.modelCallCost ?? 0.01),
    tradeCost: Number(fallback.tradeCost ?? 0.02),
    code: forbidden ? '' : rawCode,
    createdAt: new Date().toISOString(),
  }
}

export function proposeNeighborControllers(current, limit = 12) {
  const base = sanitiseController(current, current)
  const candidates = [{ ...base, name: `${base.name}-baseline` }]
  const numeric = [
    ['minConfidence', 0.05, 0.30, 0.90],
    ['riskScale', 0.2, 0.2, 2.0],
    ['maxActions', 1, 1, 6],
    ['heatCapPct', 1.0, 1.0, 10.0],
    ['correlationLimit', 0.1, 0.5, 1.0],
    ['committeeMinAgreement', 0.05, 0.5, 1.0],
  ]
  for (const [field, step, low, high] of numeric) {
    for (const direction of [1, -1]) {
      const next = { ...base }
      next[field] = clamp(Number((Number(base[field]) + direction * step).toFixed(4)), low, high)
      next.name = `${base.name}-${field}${direction > 0 ? '+' : '-'}`
      candidates.push(next)
    }
  }
  for (const strategy of ['aggregate', 'primary', 'best_confidence']) {
    if (strategy !== base.branchStrategy) {
      candidates.push({ ...base, branchStrategy: strategy, name: `${base.name}-branch-${strategy}` })
    }
  }
  const codeVariants = [
    '(ctx) => ({ allow: true, scale: ctx.confidence >= 0.7 ? 1 : 0.5 })',
    '(ctx) => ({ allow: ctx.confidence >= 0.6, scale: 1 })',
    '(ctx) => ({ allow: true, scale: 0.75 })',
  ].filter((code) => code !== base.code)
  for (let i = 0; i < codeVariants.length; i += 1) {
    candidates.push({ ...base, code: codeVariants[i], name: `${base.name}-code-${i + 1}` })
  }
  return candidates
}

/** Select the model decision branch from one recorded node. */
export function selectBranchDecision(node, controller) {
  const branches = node?.branches
  if (branches && typeof branches === 'object') {
    if (controller.branchStrategy === 'primary' && Array.isArray(branches.members) && branches.members.length > 0) {
      return branches.members[0].decision ?? branches.aggregate ?? null
    }
    if (controller.branchStrategy === 'best_confidence' && Array.isArray(branches.members) && branches.members.length > 0) {
      return branches.members
        .slice()
        .sort((a, b) => Number(b.decision?.confidence ?? 0) - Number(a.decision?.confidence ?? 0))[0].decision ?? branches.aggregate ?? null
    }
    return branches.aggregate ?? null
  }
  return node?.decision ?? null
}

/** Apply parameter and optional sandboxed code policy to a list of actions. */
export function applyControllerToActions(actions, controller, defaultConfidence = 0.5) {
  const minConfidence = Number(controller.minConfidence ?? 0.55)
  const maxActions = Math.max(1, Number(controller.maxActions ?? 4))
  const scale = Math.max(0.05, Number(controller.riskScale ?? 1))
  let codeFn = null
  if (typeof controller.code === 'string' && controller.code.trim().length > 0) {
    try {
      const sandbox = { Math, JSON, Number, Array, Object, String, Boolean }
      const context = vm.createContext(sandbox)
      const fn = vm.runInContext(`(${controller.code})`, context, { timeout: 30 })
      if (typeof fn === 'function') codeFn = fn
    } catch {
      codeFn = null
    }
  }
  const transformed = []
  for (const action of (Array.isArray(actions) ? actions : [])
    .filter((entry) => !isOpenAction(entry) || Number(entry.confidence ?? defaultConfidence) >= minConfidence)
    .slice(0, maxActions)) {
    const next = { ...action }
    if (isOpenAction(next)) {
      if (Number(next.notional) > 0) next.notional = Number(next.notional) * scale
      else if (Number(next.qty) > 0) next.qty = Number(next.qty) * scale
      if (codeFn) {
        try {
          const result = codeFn({
            symbol: next.symbol,
            side: actionSide(next),
            confidence: Number(next.confidence ?? defaultConfidence),
            notional: next.notional,
            qty: next.qty,
          })
          if (result && result.allow === false) continue
          if (result && Number(result.scale) > 0) {
            if (Number(next.notional) > 0) next.notional *= Number(result.scale)
            else if (Number(next.qty) > 0) next.qty *= Number(result.scale)
          }
        } catch {
          // Broken generated controller code simply has no effect.
        }
      }
    }
    transformed.push(next)
  }
  return transformed
}

/** Select a branch decision, then apply the controller policy to its actions. */
export function selectControllerActions(node, controller) {
  const decision = selectBranchDecision(node, controller)
  if (!decision) return []
  return applyControllerToActions(decision.actions, controller, Number(decision.confidence ?? 0.5))
}

async function runCppPaperSim(cpp, payload, timeoutMs = 20000) {
  const { stdout } = await runCpp(cpp, ['--paper-sim'], JSON.stringify(payload), timeoutMs, 'C++ paper-sim')
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`invalid C++ paper-sim JSON: ${error.message}`)
  }
}

/**
 * Replay a controller against grounded nodes, with the C++ paper ledger doing
 * fee, slippage and funding accounting.
 */
export async function replayController(nodes, controller, options = {}) {
  const simNodes = []
  let modelCalls = 0
  let trades = 0
  for (const node of nodes ?? []) {
    if (!node || node.mode !== 'paper') continue
    if (!node.prices || typeof node.prices !== 'object') continue
    const actions = selectControllerActions(node, controller)
    const fills = []
    for (const action of actions) {
      if (isCloseAction(action)) {
        const symbol = action.symbol ? normalizeSymbol(action.symbol).gate : ''
        const price = Number(node.prices[symbol])
        if (symbol && price > 0) fills.push({ symbol, close: true, price, fee_rate: Number(options.feeRate ?? 0.0005) })
        continue
      }
      if (!isOpenAction(action)) continue
      const symbol = action.symbol ? normalizeSymbol(action.symbol).gate : ''
      const price = Number(node.prices[symbol])
      if (!symbol || !(price > 0)) continue
      let qty = Number(action.qty ?? 0)
      if (!(qty > 0)) {
        const notional = Number(action.notional ?? 0)
        if (notional > 0) qty = notional / price
      }
      if (!(qty > 0)) continue
      fills.push({ symbol, side: actionSide(action) === 'short' ? 'sell' : 'buy', qty, price, fee_rate: Number(options.feeRate ?? 0.0005) })
      trades += 1
    }
    const memberCount = Array.isArray(node.branches?.members) ? node.branches.members.length : Number(node.modelCalls ?? 1)
    modelCalls += controller.branchStrategy === 'primary' ? 1 : Math.max(1, memberCount)
    simNodes.push({
      index: node.cycle ?? simNodes.length,
      prices: node.prices,
      funding_rates: node.fundingRates ?? {},
      fills,
    })
  }
  if (simNodes.length === 0) {
    return { score: 0, totalReturnPct: 0, maxDrawdownPct: 0, trades: 0, modelCalls: 0, fees: 0, fundingPnl: 0, nodes: 0, controller, curve: [] }
  }
  const sim = await runCppPaperSim(options, {
    wallet: Number(options.wallet ?? 10000),
    slippage_bps: Number(options.slippageBps ?? 2),
    fee_rate: Number(options.feeRate ?? 0.0005),
    nodes: simNodes,
  }, Number(options.timeoutMs ?? 20000))

  const curve = (sim.equity_curve ?? []).map((row) => Number(row.equity)).filter((value) => Number.isFinite(value))
  const initial = Number(options.wallet ?? 10000)
  const final = curve.length > 0 ? curve[curve.length - 1] : initial
  const totalReturnPct = initial > 0 ? (final / initial - 1) * 100 : 0
  const drawdown = maxDrawdownPct(curve)
  const costPenalty = modelCalls * Number(controller.modelCallCost ?? 0.01) + trades * Number(controller.tradeCost ?? 0.02)
  const score = totalReturnPct - drawdown * 0.8 - costPenalty
  return {
    score: Number(score.toFixed(6)),
    totalReturnPct: Number(totalReturnPct.toFixed(6)),
    maxDrawdownPct: Number(drawdown.toFixed(6)),
    trades,
    modelCalls,
    fees: Number(sim.fees ?? 0),
    fundingPnl: Number(sim.funding_pnl ?? 0),
    nodes: simNodes.length,
    controller,
    curve: curve.map((equity) => Number(equity.toFixed(6))),
  }
}

/** Keep the current controller in the candidate set, so replay metrics never regress by selection. */
export async function evolveController(current, nodes, maxCandidates = 12, extraCandidates = [], options = {}) {
  const candidates = proposeNeighborControllers(current, maxCandidates).map((candidate) => sanitiseController(candidate, current))
  for (const candidate of extraCandidates) candidates.push(sanitiseController(candidate, current))
  const unique = new Map()
  for (const candidate of [...candidates, sanitiseController(current, current)]) {
    const key = JSON.stringify({
      minConfidence: candidate.minConfidence,
      riskScale: candidate.riskScale,
      maxActions: candidate.maxActions,
      heatCapPct: candidate.heatCapPct,
      correlationLimit: candidate.correlationLimit,
      committeeMinAgreement: candidate.committeeMinAgreement,
      branchStrategy: candidate.branchStrategy,
      modelCallCost: candidate.modelCallCost,
      tradeCost: candidate.tradeCost,
      code: candidate.code,
    })
    if (!unique.has(key)) unique.set(key, candidate)
  }
  const controllers = [...unique.values()]
  const results = []
  for (const candidate of controllers) results.push(await replayController(nodes, candidate, options))
  const currentResult = await replayController(nodes, current, options)
  const best = results.reduce((winner, result) => (result.score > winner.score ? result : winner), currentResult)
  const chosen = best.score > currentResult.score + 0.0001 ? best.controller : { ...current }
  return { current: currentResult, best, chosen, results }
}

export async function recordNode(node) {
  const path = treePath()
  await mkdir(resolve(path, '..'), { recursive: true })
  await appendFile(path, JSON.stringify(node) + '\n', 'utf8')
}

export async function loadNodes(limit = 2000) {
  const path = treePath()
  if (!existsSync(path)) return []
  try {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
