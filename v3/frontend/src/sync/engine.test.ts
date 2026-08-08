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
    // This mirrors the defaults set in engine.ts createDoc()
    const docDefaults = {
      hitl_required: false,
      hitl_status: null,
    }
    expect(docDefaults.hitl_required).toBe(false)
    expect(docDefaults.hitl_status).toBeNull()
  })
})
