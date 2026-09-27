/**
 * QBot execution task plugin.
 *
 * Registers the execution tool family over the shared qbotCore service. Keeping
 * the service separate means every family sees the same paper account, market
 * cache, and risk rails.
 */
import { registerExecutionTools } from '../lib/tool-groups.mjs'

export const name = 'qbot-execution'
export const inject = ['tools', 'qbotCore']

export function apply(ctx) {
  const core = typeof ctx.get === 'function' ? ctx.get('qbotCore') : undefined
  if (!core) throw new Error('qbot-execution: qbotCore service is unavailable')
  registerExecutionTools(ctx, core)
}
