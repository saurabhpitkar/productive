export interface OutlineItem {
  level: number
  text:  string
}

export function computeOutline(body: string): string {
  const items: OutlineItem[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)/)
    if (m) items.push({ level: m[1].length, text: m[2].trim() })
  }
  return JSON.stringify(items)
}

export function parseOutline(outline: string): OutlineItem[] {
  try { return JSON.parse(outline || '[]') } catch { return [] }
}

export function extractOutlineFromBody(body: string): OutlineItem[] {
  const items: OutlineItem[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)/)
    if (m) items.push({ level: m[1].length, text: m[2].trim() })
  }
  return items
}
