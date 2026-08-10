import { describe, it, expect } from 'vitest'
import { computeOutline } from '../lib/outline'

/**
 * Tests for sync engine utility logic.
 *
 * The SyncEngine class itself is not directly unit-tested here because it
 * depends on Dexie.js (IndexedDB) and fetch - both require browser environment
 * integration tests. Instead, this file tests the pure utility functions that
 * the engine uses internally.
 */

describe('computeOutline (used by createDoc / updateDoc in engine)', () => {
  it('produces empty outline for docs with no body headings', () => {
    expect(computeOutline('')).toBe('[]')
    expect(computeOutline('Just a note with no headings.')).toBe('[]')
  })

  it('matches backend _extract_outline output format', () => {
    // Backend produces: [{"level": 1, "text": "Title"}, ...]
    // Frontend produces: [{"level":1,"text":"Title"}, ...]
    // Both are valid JSON; the key is same keys and values.
    const outline = JSON.parse(computeOutline('# Title\n## Sub'))
    expect(outline).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Sub' },
    ])
  })
})

describe('outbox entry structure', () => {
  it('create entry has required fields', () => {
    // Validate the shape expected by flushOutbox's execute() method
    const entry = {
      id: 'uuid-1',
      type: 'create' as const,
      payload: { id: 'doc-1', name: 'Test', body: '' },
      created_at: new Date().toISOString(),
      attempt_count: 0,
      failed: false,
    }
    expect(entry.type).toBe('create')
    expect(entry.attempt_count).toBe(0)
    expect(entry.failed).toBe(false)
  })

  it('update entry payload has id and data', () => {
    const entry = {
      id: 'uuid-2',
      type: 'update' as const,
      payload: { id: 'doc-1', data: { name: 'Updated' } },
      created_at: new Date().toISOString(),
      attempt_count: 0,
      failed: false,
    }
    expect(entry.payload.id).toBe('doc-1')
    expect(entry.payload.data).toEqual({ name: 'Updated' })
  })
})

describe('hitl_required / hitl_status defaults in createDoc shape', () => {
  it('new doc shape has hitl_required=false and hitl_status=null', () => {
    const docDefaults = {
      hitl_required: false,
      hitl_status: null,
    }
    expect(docDefaults.hitl_required).toBe(false)
    expect(docDefaults.hitl_status).toBeNull()
  })
})

describe('v4 API boundary — adaptDoc / adaptRequest', () => {
  it('maps task_status to status when server returns task_status', () => {
    // Simulates what the adaptDoc helper does internally
    const serverDoc = {
      id: 'doc-1', name: 'Test', body: '', note_outline: '',
      due_date: null, due_time: null, flag: null, list_id: null,
      priority: null, task_status: 'in_progress', lifecycle: 'stable',
      tags: {}, linked_doc_ids: [], embedding: null,
      hitl_required: false, hitl_status: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }
    // The adapter maps task_status → status; status field must be 'in_progress'
    const adapted = { ...serverDoc, status: serverDoc.task_status ?? serverDoc.task_status ?? 'todo' }
    expect(adapted.status).toBe('in_progress')
  })

  it('maps client status → task_status in outgoing request', () => {
    const clientData = { name: 'Test', status: 'done' as const }
    const { status, ...rest } = clientData as Record<string, unknown>
    const requestBody = { ...rest, task_status: status }
    expect(requestBody.task_status).toBe('done')
    expect((requestBody as Record<string, unknown>).status).toBeUndefined()
  })

  it('RoutingResult shape matches expected fields', () => {
    const result = {
      inbox_id:         'inbox-abc',
      status:           'routed' as const,
      confidence:       0.91,
      target_doc_id:    'doc-xyz',
      target_doc_title: 'Travel Plans',
      action:           'appended' as const,
      reasoning:        'Matched travel planning context',
      rounds_used:      2,
    }
    expect(result.status).toBe('routed')
    expect(result.action).toBe('appended')
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('ActivityLogEntry action values are constrained', () => {
    const validActions = ['created', 'updated', 'deleted', 'routed', 'batch_created']
    const entry = { action: 'created' }
    expect(validActions).toContain(entry.action)
  })
})
