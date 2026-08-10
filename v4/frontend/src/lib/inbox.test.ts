import { describe, it, expect } from 'vitest'
import { routingDisplay } from './inbox'
import type { RoutingResult } from '../types'

function result(overrides: Partial<RoutingResult> = {}): RoutingResult {
  return {
    inbox_id:         'inbox-1',
    status:           'routed',
    confidence:       0.92,
    target_doc_id:    'doc-1',
    target_doc_title: 'Tokyo Hotels',
    action:           'appended',
    reasoning:        'High semantic match to accommodation planning',
    rounds_used:      3,
    ...overrides,
  }
}

describe('routingDisplay', () => {
  it('returns green label for a routed/appended result', () => {
    const d = routingDisplay(result())
    expect(d.color).toBe('green')
    expect(d.label).toBe('Routed')
    expect(d.sublabel).toContain('Appended to')
    expect(d.sublabel).toContain('Tokyo Hotels')
    expect(d.confidence).toBe('92%')
    expect(d.docId).toBe('doc-1')
  })

  it('shows "Created" verb when action is created', () => {
    const d = routingDisplay(result({ action: 'created' }))
    expect(d.sublabel).toContain('Created')
    expect(d.sublabel).not.toContain('Appended')
  })

  it('returns amber label for hitl_pending', () => {
    const d = routingDisplay(result({ status: 'hitl_pending', confidence: 0.61 }))
    expect(d.color).toBe('amber')
    expect(d.label).toBe('Needs Review')
    expect(d.confidence).toBe('61%')
    expect(d.sublabel).toContain('queued for your review')
  })

  it('returns red label for failed status', () => {
    const d = routingDisplay(result({
      status:     'failed',
      action:     'failed',
      confidence: 0,
      reasoning:  'No relevant docs found after 6 rounds',
    }))
    expect(d.color).toBe('red')
    expect(d.label).toBe('Failed')
    expect(d.docId).toBeNull()
    expect(d.sublabel).toContain('No relevant docs')
    expect(d.confidence).toBe('n/a')
  })

  it('rounds confidence percentage correctly', () => {
    const d = routingDisplay(result({ confidence: 0.875 }))
    expect(d.confidence).toBe('88%')
  })

  it('handles missing target_doc_title gracefully', () => {
    const d = routingDisplay(result({ target_doc_title: null }))
    expect(d.sublabel).toContain('"doc"')
  })
})
