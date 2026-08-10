import type { HitlReview } from '../types'

const BASE = '/api/v1/hitl'

export async function fetchReviews(outcome?: string): Promise<HitlReview[]> {
  const url = outcome ? `${BASE}/reviews?outcome=${encodeURIComponent(outcome)}` : `${BASE}/reviews`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load reviews')
  return res.json()
}

export async function fetchReview(id: string): Promise<HitlReview> {
  const res = await fetch(`${BASE}/reviews/${id}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load review')
  return res.json()
}

export async function resolveReview(
  id: string,
  outcome: 'approved' | 'rejected' | 'cancelled',
  human_notes?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/reviews/${id}/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome, human_notes: human_notes ?? null }),
  })
  if (!res.ok) throw new Error('Failed to resolve review')
}
