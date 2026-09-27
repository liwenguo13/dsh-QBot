/**
 * QBot C++ execution-kernel bridge.
 *
 * This is the first integration point of the C++ core: QBot calls a compiled
 * C++ risk/position-sizing engine instead of doing that arithmetic only in JS.
 * The binary is intentionally small and dependency-free apart from OpenSSL in
 * the build; lib/cpp.mjs resolves it (native or, on Windows, through WSL) and
 * every tool fails with a clear error when it is missing.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cppStatus, runCpp } from '../lib/cpp.mjs'

export const name = 'qbot-cpp'
export const inject = ['tools']

export const Config = z.object({
  /** Native kernel path; empty = bundle-relative qbot_cpp(.exe), then WSL on Windows. */
  binPath: z.string().default(''),
  /** WSL distro used on Windows; empty = first installed distro. */
  cppWslDistro: z.string().default(''),
  /** Linux path of the ELF inside that distro; empty = derive it from the bundle/source checkout. */
  cppWslBinPath: z.string().default(''),
  timeoutMs: z.natural().default(10_000),
})

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

/** Parse one kernel JSON response, keeping the old diagnostic on malformed output. */
function parseKernel(stdout, label) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`)
  }
}

export function apply(ctx, config) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    ctx.logger?.error?.('[qbot-cpp] ctx.tools is unavailable; C++ tools were not registered')
    return
  }

  ctx.tools.register(defineTool({
    name: 'cpp_engine_status',
    description: 'Read the QBot C++ execution-kernel version and availability.',
    parameters: {},
    output: textOutput,
    async execute() {
      const { stdout, backend, binPath, distro } = await runCpp(config, ['--version'], undefined, config.timeoutMs, 'C++ engine')
      return json({
        ok: true,
        backend,
        binary: binPath,
        ...(distro === undefined ? {} : { distro }),
        version: stdout.trim(),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cpp_risk_size',
    description: 'Compute risk-based position size with the compiled C++ execution kernel (qbot_cpp).',
    parameters: {
      equity: { type: 'number', required: true, description: 'account equity in USDT' },
      entry: { type: 'number', required: true, description: 'planned entry price' },
      stop: { type: 'number', required: true, description: 'protective stop price' },
      risk_pct: { type: 'number', description: 'percent of equity to risk, default 1' },
      max_notional: { type: 'number', description: 'max order notional in USDT, default 2000' },
      max_leverage: { type: 'number', description: 'max leverage, default 5' },
    },
    output: textOutput,
    async execute(args) {
      const payload = {
        equity: Number(args.equity),
        entry: Number(args.entry),
        stop: Number(args.stop),
        risk_pct: args.risk_pct === undefined ? 1 : Number(args.risk_pct),
        max_notional: args.max_notional === undefined ? 2000 : Number(args.max_notional),
        max_leverage: args.max_leverage === undefined ? 5 : Number(args.max_leverage),
      }
      const { stdout } = await runCpp(config, ['--risk-check'], JSON.stringify(payload), config.timeoutMs, 'C++ engine')
      const result = parseKernel(stdout, 'C++ risk check')
      if (result.ok !== true) throw new Error(result.error ?? 'C++ risk check failed')
      return json(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cpp_order_plan',
    description: 'Compute an order plan (qty, notional, leverage, R multiple) with the compiled C++ kernel and a mandatory stop.',
    parameters: {
      equity: { type: 'number', required: true, description: 'account equity in USDT' },
      entry: { type: 'number', required: true, description: 'planned entry price' },
      stop: { type: 'number', required: true, description: 'protective stop price' },
      take_profit: { type: 'number', description: 'optional target price' },
      risk_pct: { type: 'number', description: 'percent of equity to risk, default 1' },
      max_notional: { type: 'number', description: 'max order notional in USDT, default 2000' },
      max_leverage: { type: 'number', description: 'max leverage, default 5' },
    },
    output: textOutput,
    async execute(args) {
      const payload = {
        equity: Number(args.equity),
        entry: Number(args.entry),
        stop: Number(args.stop),
        take_profit: args.take_profit === undefined ? undefined : Number(args.take_profit),
        risk_pct: args.risk_pct === undefined ? 1 : Number(args.risk_pct),
        max_notional: args.max_notional === undefined ? 2000 : Number(args.max_notional),
        max_leverage: args.max_leverage === undefined ? 5 : Number(args.max_leverage),
      }
      const { stdout } = await runCpp(config, ['--order-plan'], JSON.stringify(payload), config.timeoutMs, 'C++ engine')
      const result = parseKernel(stdout, 'C++ order plan')
      if (result.ok !== true) throw new Error(result.error ?? 'C++ order plan failed')
      return json(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cpp_paper_fill',
    description: 'Apply one fill to the local paper ledger with the compiled C++ kernel and return the updated wallet, position, realized PnL and fee.',
    parameters: {
      wallet: { type: 'number', required: true, description: 'current paper wallet cash' },
      qty: { type: 'number', required: true, description: 'current signed position qty' },
      entry_price: { type: 'number', required: true, description: 'current position average entry price' },
      fill_side: { type: 'string', enum: ['buy', 'sell'], required: true, description: 'fill side' },
      fill_qty: { type: 'number', required: true, description: 'fill quantity in base units' },
      fill_price: { type: 'number', required: true, description: 'fill price' },
      fee_rate: { type: 'number', description: 'taker fee rate, default 0.0005' },
    },
    output: textOutput,
    async execute(args) {
      const payload = {
        wallet: Number(args.wallet),
        position: { qty: Number(args.qty), entry_price: Number(args.entry_price) },
        fill: {
          side: String(args.fill_side),
          qty: Number(args.fill_qty),
          price: Number(args.fill_price),
          fee_rate: args.fee_rate === undefined ? 0.0005 : Number(args.fee_rate),
        },
      }
      const { stdout } = await runCpp(config, ['--paper-fill'], JSON.stringify(payload), config.timeoutMs, 'C++ engine')
      const result = parseKernel(stdout, 'C++ paper fill')
      if (result.ok !== true) throw new Error(result.error ?? 'C++ paper fill failed')
      return json(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cpp_paper_sim',
    description: 'Run the C++ paper-ledger simulator on a JSON payload with nodes, fills, funding rates and slippage. Returns equity curve, fees and funding PnL.',
    parameters: {
      payload_json: { type: 'string', required: true, description: 'JSON string: {wallet, slippage_bps, nodes:[{prices,funding_rates,fills}]}' },
    },
    output: textOutput,
    async execute(args) {
      const payload = JSON.parse(String(args.payload_json))
      const { stdout } = await runCpp(config, ['--paper-sim'], JSON.stringify(payload), config.timeoutMs * 3, 'C++ engine')
      const result = parseKernel(stdout, 'C++ paper simulation')
      if (result.ok !== true) throw new Error(result.error ?? 'C++ paper simulation failed')
      return json(result)
    },
  }))

  // Resolution is lazy: a missing kernel must never stop the plugin from
  // loading, it only fails the tool call that needs it.
  const status = cppStatus(config)
  if (status.ok) {
    ctx.logger?.info?.(`[qbot-cpp] C++ engine bridge ready (${status.backend}: ${status.binary}${status.distro === undefined ? '' : ` via ${status.distro}`})`)
  } else {
    ctx.logger?.warn?.(`[qbot-cpp] C++ engine unavailable: ${status.error}`)
  }
}