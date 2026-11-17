// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface MetaPaymentNumber {
  phoneNumberId: string
  displayPhoneNumber: string
  amount: number
}

export interface MetaPaymentsSummary {
  available: true
  currency: string
  periodStart: string
  periodEnd: string
  total: number
  numbers: MetaPaymentNumber[]
}

export interface MetaPaymentsUnavailable {
  available: false
  reason: string
}

export type MetaPaymentsResult = MetaPaymentsSummary | MetaPaymentsUnavailable

export interface FreeServiceUsage {
  /** Outgoing non-template messages counted since `since`. */
  count: number
  /** Effective start of the counting window (ISO timestamp). */
  since: string
  /** Local start of the current month (ISO timestamp). */
  monthStart: string
  /** True when `since` came from a manual reset rather than the month. */
  reset: boolean
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
