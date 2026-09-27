/**
 * QBot model-facing tools for the independent QBot DSH agent.
 *
 * Every tool reaches the QBot Python runtime under `qbotRoot` through the same
 * CLI a human would run, so the agent can inspect market state, validate
 * configuration, request runtime mode changes, backtest, and trigger exactly
 * one trading cycle without a human editing `.env` or JSON files by hand.
 * Live-money paths keep the CLI's confirmation tokens.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

export const name = 'qbot-tools'
export const inject = ['tools']

/** QBot runtime columns resolved from cordis.yml or the environment. */
export const Config = z.object({
  qbotRoot: z.string().default(process.env.QBOT_ROOT || '/home/klein/Quantized Agent System'),
  python: z.string().default(process.env.QBOT_PYTHON || 'python3'),
  /** Wall-clock bound for one QBot CLI invocation. */
  runTimeoutMs: z.natural().default(300_000),
  /** Wall-clock bound for backtests, which replay many candles. */
  backtestTimeoutMs: z.natural().default(120_000),
})

const LOG_DIR = process.env.QBOT_DSH_LOG_DIR || resolve(process.cwd(), 'logs')

/** Append one lifecycle line the launcher can read. */
function mark(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(resolve(LOG_DIR, 'plugin-loaded.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/** Read one JSON file, falling back when it is absent or malformed. */
function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Replace one JSON file atomically so a concurrent reader never sees a partial write. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/**
 * Mount the QBot tool set.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const qbotRoot = config.qbotRoot
  const dataDir = process.env.QBOT_DATA_DIR || resolve(qbotRoot, 'data')
  const controlPath = resolve(dataDir, 'runtime_control.json')
  const statusPath = resolve(dataDir, 'runtime_status.json')

  /** Run one QBot CLI command against the configured root. */
  const runQbot = async (args, options = {}) => {
    const { stdout, stderr } = await execFileAsync(config.python, ['-m', 'qbot', ...args], {
      cwd: qbotRoot,
      timeout: options.timeoutMs ?? config.runTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    })
    return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  }

  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    ctx.logger?.error?.('[qbot-tools] ctx.tools is unavailable; QBot tools were not registered')
    mark('WARNING: qbot-tools could not reach ctx.tools')
    return
  }

  ctx.tools.register(defineTool({
    name: 'qbot_status',
    description: 'Read the current QBot runtime control and status JSON (mode, trading enabled, last cycle).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const control = readJson(controlPath, { mode: 'paper', trading_enabled: true })
      const status = readJson(statusPath, {})
      return JSON.stringify({ control, runtime_status: status, qbot_root: qbotRoot }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_state',
    description: 'Read QBot persisted state from its SQLite store: latest equity, recent orders, risk events and news.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return runQbot(['status'])
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_doctor',
    description: 'Validate QBot configuration and market connectivity without trading. Read-only diagnostic.',
    parameters: {
      check_llm: { type: 'boolean', description: 'also send a tiny prompt to the configured LLM (default false)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const argv = ['doctor']
      if (args.check_llm === true) argv.push('--check-llm')
      return runQbot(argv)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_control',
    description: 'Request a QBot runtime mode change or pause/resume trading. The running QBot trading loop applies it on its next cycle. Switching to live requires confirmation="LIVE".',
    parameters: {
      mode: { type: 'string', description: 'paper | testnet | live' },
      trading_enabled: { type: 'boolean', description: 'true = allow new entries, false = reduce-only' },
      confirmation: { type: 'string', description: 'must be LIVE when switching to live' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const current = readJson(controlPath, { mode: 'paper', trading_enabled: true, live_confirmed: false })
      const mode = String(args.mode || current.mode || 'paper').toLowerCase()
      if (!['paper', 'testnet', 'live'].includes(mode)) throw new Error(`invalid mode: ${mode}`)
      const tradingEnabled = args.trading_enabled === undefined
        ? current.trading_enabled !== false
        : Boolean(args.trading_enabled)
      let liveConfirmed = false
      if (mode === 'live') {
        if (String(args.confirmation || '') !== 'LIVE') throw new Error('live switch requires confirmation="LIVE"')
        liveConfirmed = true
      }
      const control = {
        mode,
        trading_enabled: tradingEnabled,
        live_confirmed: liveConfirmed,
        updated_at: new Date().toISOString(),
        requested_by: 'qbot-dsh-agent',
      }
      writeJsonAtomic(controlPath, control)
      return `QBot control submitted: ${JSON.stringify(control)}\nIt applies on the next trading cycle.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_news',
    description: 'Fetch a short snapshot of the configured QBot news sources as JSON.',
    parameters: {
      limit: { type: 'number', description: 'number of items, default 5' },
      force: { type: 'boolean', description: 'ignore the news cache (default false)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(20, Number(args.limit || 5)))
      const argv = ['news', '--json', '--limit', String(limit)]
      if (args.force === true) argv.push('--force')
      return runQbot(argv, { timeoutMs: 30_000 })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_backtest',
    description: 'Run a QBot historical backtest (mock market data by default) and return the JSON result.',
    parameters: {
      symbols: { type: 'string', description: 'comma-separated symbols, e.g. BTCUSDT,ETHUSDT' },
      bars: { type: 'number', description: 'number of candles, default 1000' },
      source: { type: 'string', description: 'mock | binance | file, default mock' },
      walk_forward: { type: 'boolean', description: 'run walk-forward validation (default false)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const symbols = String(args.symbols || 'BTCUSDT').replace(/\s+/g, '')
      const bars = Math.max(100, Math.min(20_000, Number(args.bars || 1000)))
      const source = String(args.source || 'mock').toLowerCase()
      if (!['mock', 'binance', 'file'].includes(source)) throw new Error('invalid backtest source')
      const argv = [
        'backtest', '--source', source,
        '--symbols', symbols, '--bars', String(bars), '--json',
      ]
      if (args.walk_forward === true) argv.push('--walk-forward')
      return runQbot(argv, { timeoutMs: config.backtestTimeoutMs })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_run_once',
    description: 'Run exactly one QBot trading cycle. Paper/testnet needs confirmation="RUN"; live needs confirmation="RUN_LIVE".',
    parameters: {
      mock_llm: { type: 'boolean', description: 'use the deterministic mock strategy instead of a real LLM' },
      confirmation: { type: 'string', required: true, description: 'RUN for paper/testnet, RUN_LIVE for live' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const control = readJson(controlPath, { mode: 'paper' })
      const mode = String(control.mode || 'paper')
      const expected = mode === 'live' ? 'RUN_LIVE' : 'RUN'
      if (String(args.confirmation || '') !== expected) {
        throw new Error(`confirmation must be "${expected}" for current mode "${mode}"`)
      }
      const env = {}
      if (args.mock_llm === true) env.MOCK_LLM = 'true'
      return runQbot(['run', '--once'], { env })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'qbot_log_tail',
    description: 'Read the tail of a QBot-related log file for diagnostics.',
    parameters: {
      lines: { type: 'number', description: 'number of lines, default 40' },
      file: { type: 'string', description: 'qbot | dsh | launcher | dashboard; default qbot' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const lines = Math.max(1, Math.min(500, Number(args.lines || 40)))
      const which = String(args.file || 'qbot').toLowerCase()
      const candidates = {
        qbot: resolve(qbotRoot, 'logs', 'qbot.log'),
        dsh: resolve(LOG_DIR, 'qbot-web.log'),
        launcher: resolve(LOG_DIR, 'qbot-launcher.log'),
        dashboard: resolve(LOG_DIR, 'qbot-dashboard.log'),
      }
      const path = candidates[which] || candidates.qbot
      if (!existsSync(path)) throw new Error(`log file not found: ${path}`)
      const { stdout } = await execFileAsync('tail', ['-n', String(lines), path], { timeout: 10_000 })
      return stdout || '(empty)'
    },
  }))

  mark('qbot-tools registered: qbot_status, qbot_state, qbot_doctor, qbot_control, qbot_news, qbot_backtest, qbot_run_once, qbot_log_tail')
}
