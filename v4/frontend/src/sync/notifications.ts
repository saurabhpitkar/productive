import type { Doc } from '../types'

// Per-day deduplication: track which doc IDs have been notified today
const DATE_KEY = 'pa:notif-date'
const IDS_KEY  = 'pa:notif-ids'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function getNotifiedToday(): Set<string> {
  try {
    const saved = localStorage.getItem(DATE_KEY)
    if (saved !== todayISO()) {
      localStorage.setItem(DATE_KEY, todayISO())
      localStorage.setItem(IDS_KEY, '[]')
      return new Set()
    }
    return new Set(JSON.parse(localStorage.getItem(IDS_KEY) ?? '[]'))
  } catch { return new Set() }
}

function markNotified(id: string) {
  try {
    const s = getNotifiedToday()
    s.add(id)
    localStorage.setItem(IDS_KEY, JSON.stringify([...s]))
  } catch { /* private browsing */ }
}

// Normalize any date string to YYYY-MM-DD for safe comparison and parsing.
// Handles both the new ISO format (YYYY-MM-DD) and old format (MM-DD-YYYY).
function toISO(date: string): string {
  if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
    // MM-DD-YYYY → YYYY-MM-DD
    return `${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}`
  }
  return date
}

// Parse due_date to a local-timezone Date, handling both stored formats.
function parseDueDate(date: string): Date {
  const [y, m, d] = toISO(date).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function buildNotifOptions(doc: Doc): { title: string; options: NotificationOptions } {
  const parts: string[] = []

  if (doc.due_date) {
    const label = parseDueDate(doc.due_date)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    parts.push(`Due: ${label}${doc.due_time ? ' at ' + doc.due_time : ''}`)
  }
  if (doc.flag) parts.push('Flagged')
  if (doc.priority) parts.push(`Priority: ${doc.priority}`)

  return {
    title: doc.name,
    options: {
      body:  parts.join(' · ') || undefined,
      icon:  '/icon-192-v2.png',
      badge: '/icon-192-v2.png',
      tag:   doc.id,
    },
  }
}

async function showNotif(title: string, options: NotificationOptions) {
  try {
    // Use service worker registration so iOS PWA can show notifications
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready
      await reg.showNotification(title, options)
    } else {
      new Notification(title, options)
    }
  } catch { /* permission revoked mid-session */ }
}

const MAX_BATCH = 3   // show at most 3 individual notifications at once

// Called periodically while the app is open: show overdue/today docs not yet notified today.
// Limits to MAX_BATCH notifications per check to avoid a flood when the app resumes.
export async function checkAndNotifyDueDocs(docs: Doc[]) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const today   = todayISO()
  const notified = getNotifiedToday()

  const pending = docs.filter(doc => {
    if (!doc.due_date) return false
    if (doc.status === 'done' || doc.status === 'cancelled' || doc.status === 'archived') return false
    if (toISO(doc.due_date) > today) return false
    if (notified.has(doc.id)) return false
    return true
  })

  // Most overdue first (earliest date = most urgent)
  pending.sort((a, b) => toISO(a.due_date!).localeCompare(toISO(b.due_date!)))

  const toShow   = pending.slice(0, MAX_BATCH)
  const overflow = pending.length - MAX_BATCH

  for (let i = 0; i < toShow.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 200))
    const { title, options } = buildNotifOptions(toShow[i])
    await showNotif(title, options)
    markNotified(toShow[i].id)
  }

  if (overflow > 0) {
    await new Promise(r => setTimeout(r, 400))
    await showNotif(`${overflow} more doc${overflow > 1 ? 's' : ''} overdue`, {
      body:  'Open Productive to review all due items',
      icon:  '/icon-192-v2.png',
      badge: '/icon-192-v2.png',
      tag:   'pa-overflow',
    })
  }
}

// Schedule time-exact notifications for docs due within the next 24 hours
export function scheduleNotifications(docs: Doc[]) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const now = Date.now()
  docs
    .filter(d => (d.status === 'todo' || d.status === 'in_progress') && d.due_date && d.due_time)
    .forEach(doc => {
      const dueAt = new Date(`${toISO(doc.due_date!)}T${doc.due_time}:00`).getTime()
      const delay  = dueAt - now
      if (delay > 0 && delay < 86_400_000) {
        setTimeout(async () => {
          const { title, options } = buildNotifOptions(doc)
          await showNotif(title, options)
        }, delay)
      }
    })
}
