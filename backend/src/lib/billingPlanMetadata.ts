type PlanMetadataCarrier = { externalMetadata?: unknown }

/** Read the campaign's daily token quota from the opaque catalog snapshot stored on a plan.
 * Zero is meaningful: Autonomous uses it for an unlimited daily quota. */
export function dailyTokenLimitForPlan(plan: PlanMetadataCarrier): number | null {
  const metadata = plan.externalMetadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const raw = (metadata as Record<string, unknown>).daily_token_limit
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  if (typeof raw === 'string' && !raw.trim()) return null
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}
