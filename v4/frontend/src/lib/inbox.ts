import type { RoutingResult } from '../types'

export interface RoutingDisplay {
  label:      string                     // "Routed" | "Needs Review" | "Failed"
  sublabel:   string                     // human-readable detail
  color:      'green' | 'amber' | 'red'
  docId:      string | null
  confidence: string                     // "87%" or "n/a"
}

export function routingDisplay(result: RoutingResult): RoutingDisplay {
  const pct = result.confidence > 0
    ? `${Math.round(result.confidence * 100)}%`
    : 'n/a'

  if (result.status === 'routed') {
    const verb = result.action === 'created' ? 'Created' : 'Appended to'
    return {
      label:      'Routed',
      sublabel:   `${verb} "${result.target_doc_title ?? 'doc'}" · confidence ${pct}`,
      color:      'green',
      docId:      result.target_doc_id,
      confidence: pct,
    }
  }

  if (result.status === 'hitl_pending') {
    return {
      label:      'Needs Review',
      sublabel:   `Confidence ${pct} — queued for your review`,
      color:      'amber',
      docId:      result.target_doc_id,
      confidence: pct,
    }
  }

  return {
    label:      'Failed',
    sublabel:   result.reasoning || 'Routing did not complete',
    color:      'red',
    docId:      null,
    confidence: 'n/a',
  }
}
