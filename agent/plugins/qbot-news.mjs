/**
 * QBot news task plugin.
 *
 * Registers the news tool family over the shared qbotCore service. Keeping
 * the service separate means every family sees the same paper account, market
 * cache, and risk rails.
 */
import { registerNewsTools } from '../lib/tool-groups.mjs'

export const name = 'qbot-news'
export const inject = ['tools', 'qbotCore']

export function apply(ctx) {
  const core = typeof ctx.get === 'function' ? ctx.get('qbotCore') : undefined
  if (!core) throw new Error('qbot-news: qbotCore service is unavailable')
  registerNewsTools(ctx, core)
}
