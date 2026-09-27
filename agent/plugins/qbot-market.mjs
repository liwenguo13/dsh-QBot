/**
 * QBot market task plugin.
 *
 * Registers the market tool family over the shared qbotCore service. Keeping
 * the service separate means every family sees the same paper account, market
 * cache, and risk rails.
 */
import { registerMarketTools } from '../lib/tool-groups.mjs'

export const name = 'qbot-market'
export const inject = ['tools', 'qbotCore']

export function apply(ctx) {
  const core = typeof ctx.get === 'function' ? ctx.get('qbotCore') : undefined
  if (!core) throw new Error('qbot-market: qbotCore service is unavailable')
  registerMarketTools(ctx, core)
}
