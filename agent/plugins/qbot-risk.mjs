/**
 * QBot risk task plugin.
 *
 * Registers the risk tool family over the shared qbotCore service. Keeping
 * the service separate means every family sees the same paper account, market
 * cache, and risk rails.
 */
import { registerRiskTools } from '../lib/tool-groups.mjs'

export const name = 'qbot-risk'
export const inject = ['tools', 'qbotCore']

export function apply(ctx) {
  const core = typeof ctx.get === 'function' ? ctx.get('qbotCore') : undefined
  if (!core) throw new Error('qbot-risk: qbotCore service is unavailable')
  registerRiskTools(ctx, core)
}
