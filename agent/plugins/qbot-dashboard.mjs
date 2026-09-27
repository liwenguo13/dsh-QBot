/**
 * QBot dashboard lifecycle for the independent QBot DSH agent.
 *
 * Keeps QBot's stdlib Python dashboard (`python -m qbot dashboard`) alive for
 * the Web client while this DSH process runs. The plugin probes the port
 * before spawning, so a dashboard started outside DSH (or by another profile)
 * is never duplicated, and it kills only the child it owns on dispose.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'qbot-dashboard'

/** Dashboard columns resolved from cordis.yml or the environment. */
export const Config = z.object({
  qbotRoot: z.string().default(process.env.QBOT_ROOT || '/home/klein/Quantized Agent System'),
  python: z.string().default(process.env.QBOT_PYTHON || 'python3'),
  host: z.string().default('127.0.0.1'),
  port: z.natural().default(8787),
  autoStart: z.boolean().default(true),
  /** Dashboard stdout/stderr log; empty keeps the plugin log directory default. */
  logFile: z.string().default(''),
})

/**
 * Whether something already answers on the dashboard address.
 * @param host - dashboard bind address.
 * @param port - dashboard bind port.
 * @returns true when the port accepts an HTTP request.
 */
async function dashboardAlive(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) })
    return response.status < 500
  } catch {
    return false
  }
}

/**
 * Mount the dashboard supervisor.
 * @param ctx - Cordis context of the QBot agent process.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const logDir = process.env.QBOT_DSH_LOG_DIR || resolve(process.cwd(), 'logs')
  const logFile = config.logFile || resolve(logDir, 'qbot-dashboard.log')
  let child = null
  let disposed = false

  const log = (message) => {
    try {
      ctx.logger?.info?.(`[qbot-dashboard] ${message}`)
    } catch {}
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
    } catch {}
  }

  if (!config.autoStart) {
    log(`autoStart=false; dashboard left to the operator (http://${config.host}:${config.port})`)
  } else if (!existsSync(resolve(config.qbotRoot, 'qbot'))) {
    log(`qbot package not found under ${config.qbotRoot}; dashboard not started`)
  } else {
    void dashboardAlive(config.host, config.port).then((alive) => {
      if (disposed) return
      if (alive) {
        log(`dashboard already answering on http://${config.host}:${config.port}; reusing it`)
        return
      }
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        const out = openSync(logFile, 'a')
        child = spawn(
          config.python,
          ['-m', 'qbot', 'dashboard', '--host', config.host, '--port', String(config.port)],
          { cwd: config.qbotRoot, stdio: ['ignore', out, out], detached: true },
        )
        // A missing python must not crash the plugin: contain the async
        // spawn error and report it instead.
        child.on('error', (error) => {
          log(`dashboard spawn failed (${config.python}): ${String(error)}`)
          child = null
        })
        child.unref()
        log(`dashboard spawned pid=${child.pid} on http://${config.host}:${config.port}`)
      } catch (error) {
        log(`dashboard spawn failed: ${String(error)}`)
      }
    })
  }

  ctx.on('dispose', () => {
    disposed = true
    if (child !== null) {
      try {
        child.kill('SIGTERM')
      } catch {}
      child = null
    }
  })
}
