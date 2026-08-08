import { db } from '../db'
import { api } from '../api/client'
import { useSyncStore } from '../store/ui'
import { scheduleNotifications } from './notifications'
import { computeOutline } from '../lib/outline'
import type { Doc, DocList, OutboxEntry, LinkLabel } from '../types'

// When the tab is visible, sync every 30s regardless of the user-chosen background interval.
const ACTIVE_INTERVAL_MS  = 30_000
const DEFAULT_INTERVAL_MS = Number(import.meta.env.VITE_SYNC_INTERVAL_MS ?? 180_000)

class SyncEngine {
  private timer:        ReturnType<typeof setInterval> | null = null
  private running       = false
  private backgroundMs  = DEFAULT_INTERVAL_MS
  private currentUserId = ''

  private effectiveInterval(): number {
    return document.visibilityState === 'visible' ? ACTIVE_INTERVAL_MS : this.backgroundMs
  }

  private scheduleTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.run(), this.effectiveInterval())
  }

  async start(userId: string) {
    this.currentUserId = userId
    const meta = await db.syncMeta.get('main')
    if (meta?.user_id && meta.user_id !== userId) {
      // Different user: wipe everything so stale data never shows
      await db.transaction('rw', db.docs, db.lists, db.syncMeta, db.outbox, async () => {
        await db.docs.clear()
        await db.lists.clear()
        await db.outbox.clear()
        await db.syncMeta.clear()
      })
    } else {
      // Same user (or first login): drop syncMeta so delta() falls through to
      // fullLoad(), which clears docs/lists and re-fetches from the server.
      // This guarantees server-state wins on every login — delta runs every
      // 30 s while the app is active, but start() is only called on login.
      await db.syncMeta.delete('main')
    }
    db.outbox.filter(e => e.failed === true)
      .modify({ failed: false, attempt_count: 0 })
      .catch(() => {})
    this.run()
    this.scheduleTimer()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Called from App.tsx on visibilitychange - switches between active/background intervals. */
  onVisibilityChange() {
    if (document.visibilityState === 'visible') this.run()
    this.scheduleTimer()
  }

  /** Called from Layout when the user changes the sync interval in Settings. */
  setBackgroundIntervalMs(ms: number) {
    this.backgroundMs = ms
    // Reschedule only affects the timer when we're in the background.
    if (document.visibilityState !== 'visible') this.scheduleTimer()
  }

  async run() {
    if (this.running) return
    this.running = true
    useSyncStore.getState().setSyncing(true)
    try {
      await this.delta()
      await this.flushOutbox()
      useSyncStore.getState().setLastSync(new Date().toISOString())
      useSyncStore.getState().setSyncError(null)
      const upcoming = await db.docs
        .filter(d => !!d.due_date && d.status !== 'done' && d.status !== 'cancelled' && d.status !== 'archived')
        .toArray()
      scheduleNotifications(upcoming)
    } catch (e) {
      console.warn('[sync]', e)
      useSyncStore.getState().setSyncError(e instanceof Error ? e.message : 'Network error')
    } finally {
      this.running = false
      useSyncStore.getState().setSyncing(false)
    }
  }

  private async delta() {
    const meta = await db.syncMeta.get('main')
    if (!meta) return this.fullLoad()

    const { docs, lists, deleted_doc_ids, deleted_list_ids } = await api.delta(meta.last_sync_at)
    await db.transaction('rw', db.docs, db.lists, db.syncMeta, async () => {
      if (docs.length)               await db.docs.bulkPut(docs)
      if (lists.length)              await db.lists.bulkPut(lists)
      if (deleted_doc_ids?.length)   await db.docs.bulkDelete(deleted_doc_ids)
      if (deleted_list_ids?.length)  await db.lists.bulkDelete(deleted_list_ids)
      await db.syncMeta.put({ key: 'main', last_sync_at: new Date().toISOString() })
    })
  }

  private async fullLoad() {
    const [docsResp, lists] = await Promise.all([api.getDocs({ limit: '1000' }), api.getLists()])
    await db.transaction('rw', db.docs, db.lists, db.syncMeta, async () => {
      await db.docs.clear()
      await db.lists.clear()
      await db.docs.bulkPut(docsResp.items)
      await db.lists.bulkPut(lists)
      await db.syncMeta.put({ key: 'main', last_sync_at: new Date().toISOString(), user_id: this.currentUserId })
    })
  }

  private async flushOutbox() {
    const pending = await db.outbox.filter(e => !e.failed).sortBy('created_at')
    useSyncStore.getState().setPendingCount(pending.length)

    for (const entry of pending) {
      try {
        await this.execute(entry)
        await db.outbox.delete(entry.id)
      } catch {
        const attempts = entry.attempt_count + 1
        await db.outbox.update(entry.id, { attempt_count: attempts, failed: attempts >= 5 })
      }
    }

    const failed = await db.outbox.filter(e => e.failed === true).count()
    useSyncStore.getState().setFailedCount(failed)
    useSyncStore.getState().setPendingCount(0)
  }

  private async execute(entry: OutboxEntry) {
    const p = entry.payload
    switch (entry.type) {
      case 'create':   await api.createDoc(p as Partial<Doc>); break
      case 'update':   await api.updateDoc(p.id as string, p.data as Partial<Doc>); break
      case 'delete':   await api.deleteDoc(p.id as string); break
      case 'link':     await api.addLink(p.source_id as string, p.target_id as string, (p.label as string) ?? 'related_to'); break
      case 'unlink':   await api.removeLink(p.source_id as string, p.target_id as string); break
    }
  }
}

export const syncEngine = new SyncEngine()

// ── Mutation helpers (optimistic write → outbox) ──────────────────────────────

const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()

export async function createDoc(
  data: Omit<Doc, 'id' | 'created_at' | 'updated_at' | 'linked_doc_ids' | 'note_outline' | 'embedding' | 'hitl_required' | 'hitl_status'>
): Promise<Doc> {
  const doc: Doc = {
    id: uid(), linked_doc_ids: [], created_at: now(), updated_at: now(),
    note_outline: computeOutline(data.body || ''),
    embedding: null,
    hitl_required: false,
    hitl_status: null,
    ...data,
  }
  await db.docs.put(doc)
  await db.outbox.put({ id: uid(), type: 'create', payload: doc as unknown as Record<string, unknown>, created_at: now(), attempt_count: 0, failed: false })
  syncEngine.run()
  return doc
}

export async function updateDoc(id: string, data: Partial<Omit<Doc, 'note_outline'>>) {
  const extra: Partial<Doc> = {}
  if ('body' in data && typeof data.body === 'string') {
    extra.note_outline = computeOutline(data.body)
  }
  await db.docs.update(id, { ...data, ...extra, updated_at: now() })
  await db.outbox.put({ id: uid(), type: 'update', payload: { id, data: { ...data, ...extra } }, created_at: now(), attempt_count: 0, failed: false })
  syncEngine.run()
}

export async function deleteDoc(id: string) {
  // Strip the deleted doc from linked_doc_ids of any doc that references it.
  const referencing = await db.docs.filter(d => d.linked_doc_ids.includes(id)).toArray()
  if (referencing.length) {
    await db.docs.bulkPut(
      referencing.map(d => ({ ...d, linked_doc_ids: d.linked_doc_ids.filter((lid: string) => lid !== id) }))
    )
  }
  await db.docs.delete(id)
  await db.outbox.put({ id: uid(), type: 'delete', payload: { id }, created_at: now(), attempt_count: 0, failed: false })
  syncEngine.run()
}

export async function addLink(sourceId: string, targetId: string, label: LinkLabel = 'related_to') {
  const now_ = now()
  await db.docs.update(sourceId, (doc) => {
    if (!doc.linked_doc_ids.includes(targetId)) doc.linked_doc_ids.push(targetId)
    doc.updated_at = now_
  })
  await db.outbox.put({
    id: uid(), type: 'link',
    payload: { source_id: sourceId, target_id: targetId, label },
    created_at: now_, attempt_count: 0, failed: false,
  })
  syncEngine.run()
}

export async function removeLink(sourceId: string, targetId: string) {
  const now_ = now()
  await db.docs.update(sourceId, (doc) => {
    doc.linked_doc_ids = doc.linked_doc_ids.filter((id: string) => id !== targetId)
    doc.updated_at = now_
  })
  await db.outbox.put({
    id: uid(), type: 'unlink',
    payload: { source_id: sourceId, target_id: targetId },
    created_at: now_, attempt_count: 0, failed: false,
  })
  syncEngine.run()
}

export async function createList(name: string): Promise<DocList> {
  const list = await api.createList({ list_name: name })
  await db.lists.put(list)
  return list
}

export async function renameList(id: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  await db.lists.update(id, { list_name: trimmed })
  await api.updateList(id, { list_name: trimmed })
  syncEngine.run()
}

export async function deleteList(id: string, deleteAssociatedDocs = false) {
  if (deleteAssociatedDocs) {
    const memberIds = (await db.docs.where('list_id').equals(id).primaryKeys()) as string[]
    for (const docId of memberIds) await deleteDoc(docId)
  }
  await db.lists.delete(id)
  await api.deleteList(id)
  syncEngine.run()
}
