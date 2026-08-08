import Dexie, { type Table } from 'dexie'
import type { Doc, DocList, OutboxEntry, SyncMeta } from '../types'

class ProductiveDB extends Dexie {
  docs!:     Table<Doc>
  lists!:    Table<DocList>
  syncMeta!: Table<SyncMeta>
  outbox!:   Table<OutboxEntry>

  constructor() {
    super('productive')
    this.version(1).stores({
      docs:     'id, status, priority, list_id, updated_at, due_date, flag, type',
      lists:    'id',
      syncMeta: 'key',
      outbox:   'id, created_at, failed',
    })
    // v2: remove 'type' index (type field removed from data model)
    this.version(2).stores({
      docs:     'id, status, priority, list_id, updated_at, due_date, flag',
      lists:    'id',
      syncMeta: 'key',
      outbox:   'id, created_at, failed',
    })
    // v3: add embedding field (stored as JSON text, not indexed)
    this.version(3).stores({
      docs:     'id, status, priority, list_id, updated_at, due_date, flag',
      lists:    'id',
      syncMeta: 'key',
      outbox:   'id, created_at, failed',
    })
  }
}

export const db = new ProductiveDB()
