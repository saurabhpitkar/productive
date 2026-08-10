import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { api } from '../api/client'

interface LinkRef { id: string; label: 'belongs_to' | 'requires' }

interface Props {
  docId:        string
  docName:      string
  docStatus:    string
  parentLinks:  LinkRef[]   // shown above root; 'requires' → arrow, 'belongs_to' → line only
  childLinks:   LinkRef[]   // shown below root; 'requires' → arrow, 'belongs_to' → line only
  onDocClick:   (id: string) => void
  compact?:     boolean
  className?:   string
}

const W       = 200
const L1_X    = 22
const L2_X    = 42
const CONN1_X = 10
const CONN2_X = 32
const ARROW   = 5
const ARROW_H = 3
const MAX     = 7   // max non-root nodes shown (slightly higher to accommodate siblings)

const SIZES = {
  normal:  { ROOT_H: 30, NODE_H: 24, GAP: 9, fsRoot: '10', fsNode: '9', textDy: 4 },
  compact: { ROOT_H: 22, NODE_H: 17, GAP: 3, fsRoot: '9',  fsNode: '8', textDy: 3 },
}

const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

interface LayoutNode {
  id: string; name: string; status: string
  x: number; y: number; w: number; h: number
  level: 0 | 1 | 2
  extra?: number
}
interface Edge {
  connX: number; fromY: number; toY: number; toX: number
  arrow: boolean  // false = line only (for 'belongs_to' relationships)
}

export function DocLinkGraph({ docId, docName, docStatus, parentLinks, childLinks, onDocClick, compact = false, className }: Props) {
  const { ROOT_H, NODE_H, GAP, fsRoot, fsNode, textDy } = SIZES[compact ? 'compact' : 'normal']

  // Grandchildren for 'requires' children (only shown when !hasParent)
  const [l2Req, setL2Req] = useState<Record<string, string[]>>({})
  // Siblings: other 'requires' children of each 'requires'-type parent
  const [siblingsMap, setSiblingsMap] = useState<Record<string, string[]>>({})

  const l1AllChildIds = childLinks.map(l => l.id)
  const reqParentIds  = parentLinks.filter(l => l.label === 'requires').map(l => l.id)
  const l1Key         = l1AllChildIds.slice(0, MAX).join(',')
  const parentKey     = reqParentIds.join(',')

  // Fetch grandchildren for ALL children (used to suppress redundant direct children)
  useEffect(() => {
    if (!l1AllChildIds.length) { setL2Req({}); return }
    let cancelled = false
    Promise.all(
      l1AllChildIds.slice(0, MAX).map(id =>
        api.getLinks(id)
          .then(ls => [id, ls.filter(l => l.label === 'requires').map(l => l.target_doc_id)] as [string, string[]])
          .catch(() => [id, []] as [string, string[]])
      )
    ).then(r => { if (!cancelled) setL2Req(Object.fromEntries(r)) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l1Key])

  // Fetch siblings (other requires-children of requires-parents, excluding current doc)
  useEffect(() => {
    if (!reqParentIds.length) { setSiblingsMap({}); return }
    let cancelled = false
    Promise.all(
      reqParentIds.map(pid =>
        api.getLinks(pid)
          .then(ls => [
            pid,
            ls.filter(l => l.label === 'requires' && l.target_doc_id !== docId).map(l => l.target_doc_id),
          ] as [string, string[]])
          .catch(() => [pid, []] as [string, string[]])
      )
    ).then(r => { if (!cancelled) setSiblingsMap(Object.fromEntries(r)) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKey, docId])

  const docInfoMap = useLiveQuery(async () => {
    const arr = await db.docs.toArray()
    return new Map(arr.map(d => [d.id, { name: d.name, status: d.status }]))
  }, [])

  if (!docInfoMap || (!parentLinks.length && !childLinks.length)) return null

  const info = (id: string) => {
    const d = docInfoMap.get(id)
    return { name: d?.name ?? '…', status: d?.status ?? 'todo' }
  }

  const hasParent  = parentLinks.length > 0
  const rootX      = hasParent ? L1_X : 0
  const childX     = hasParent ? L2_X : L1_X
  const childConnX = hasParent ? CONN2_X : CONN1_X

  // Docs reachable as grandchildren of 'belongs_to' children — suppress these from being shown as direct children
  // so the hierarchy is displayed as root → up-child → grandchild (not root → grandchild AND root → up-child → grandchild)
  const upChildGrandchildIds = new Set<string>(
    childLinks.filter(l => l.label === 'belongs_to').flatMap(l => l2Req[l.id] ?? [])
  )

  const seen = new Set<string>([docId])
  const layoutNodes: LayoutNode[] = []
  const edges: Edge[] = []
  let curY = 0
  let shown = 0
  let l1Shown = 0

  // ── 1. Parents (above root) ───────────────────────────────────────────────
  const parentInfos: { id: string; bottom: number; arrow: boolean }[] = []
  for (const { id, label } of parentLinks) {
    if (seen.has(id)) continue
    if (shown >= MAX) break
    seen.add(id)
    shown++; l1Shown++
    parentInfos.push({ id, bottom: curY + NODE_H, arrow: label === 'requires' })
    layoutNodes.push({ id, ...info(id), x: 0, y: curY, w: W - 2, h: NODE_H, level: 1 })
    curY += NODE_H + GAP
  }

  // ── 2. Root (current doc, violet) ─────────────────────────────────────────
  const rootY = curY
  layoutNodes.push({
    id: docId, name: docName, status: docStatus,
    x: rootX, y: rootY, w: W - rootX, h: ROOT_H, level: 0,
  })

  for (const { bottom, arrow } of parentInfos) {
    edges.push({ connX: CONN1_X, fromY: bottom, toY: rootY + ROOT_H / 2, toX: rootX, arrow })
  }

  curY = rootY + ROOT_H + GAP

  // ── 3. Siblings (other requires-children of requires-parents) ─────────────
  // Placed right after root so the branching from parent is visually contiguous
  for (const { id: pId, bottom: pBottom } of parentInfos.filter(p => p.arrow)) {
    for (const sibId of (siblingsMap[pId] ?? [])) {
      if (seen.has(sibId)) continue
      if (shown >= MAX) break
      seen.add(sibId)
      shown++; l1Shown++
      layoutNodes.push({ id: sibId, ...info(sibId), x: rootX, y: curY, w: W - rootX - 2, h: NODE_H, level: 1 })
      edges.push({ connX: CONN1_X, fromY: pBottom, toY: curY + NODE_H / 2, toX: rootX, arrow: true })
      curY += NODE_H + GAP
    }
  }

  // ── 4. Children of root ───────────────────────────────────────────────────
  for (const { id, label } of childLinks) {
    if (seen.has(id)) continue
    // Skip 'requires' children that are already reachable as grandchildren of an 'belongs_to' child
    if (label === 'requires' && upChildGrandchildIds.has(id)) continue
    if (shown >= MAX) break
    seen.add(id)
    shown++; l1Shown++
    const childNodeY = curY
    layoutNodes.push({ id, ...info(id), x: childX, y: curY, w: W - childX - 2, h: NODE_H, level: 1 })
    edges.push({ connX: childConnX, fromY: rootY + ROOT_H, toY: curY + NODE_H / 2, toX: childX, arrow: label === 'requires' })
    curY += NODE_H + GAP

    // Grandchildren — for all children when no parent (avoids 4 levels)
    if (!hasParent) {
      for (const gid of (l2Req[id] ?? [])) {
        if (seen.has(gid)) continue
        if (shown >= MAX) break
        seen.add(gid)
        shown++
        layoutNodes.push({ id: gid, ...info(gid), x: L2_X, y: curY, w: W - L2_X - 2, h: NODE_H, level: 2 })
        edges.push({ connX: CONN2_X, fromY: childNodeY + NODE_H, toY: curY + NODE_H / 2, toX: L2_X, arrow: true })
        curY += NODE_H + GAP
      }
    }
  }

  // ── Overflow ──────────────────────────────────────────────────────────────
  // Use a deduplicated set to avoid double-counting nodes that appear in multiple siblings lists
  const wantToShowSet = new Set<string>([
    ...parentLinks.map(l => l.id),
    ...childLinks.filter(l => !(l.label === 'requires' && upChildGrandchildIds.has(l.id))).map(l => l.id),
    ...parentInfos.filter(p => p.arrow).flatMap(({ id }) => siblingsMap[id] ?? []),
  ])
  const overflow = wantToShowSet.size - l1Shown
  if (overflow > 0) {
    layoutNodes.push({ id: '__ov', name: '', status: '', x: childX, y: curY, w: W - childX - 2, h: NODE_H, level: 1, extra: overflow })
    edges.push({ connX: childConnX, fromY: rootY + ROOT_H, toY: curY + NODE_H / 2, toX: childX, arrow: true })
    curY += NODE_H + GAP
  }

  const svgH = curY - GAP + 2

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={className}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${svgH}`}
        style={{ display: 'block', overflow: 'visible' }}
        aria-hidden
      >
        {edges.map((e, i) => {
          const ax = e.toX - ARROW
          return (
            <g key={i} className="stroke-indigo-300 dark:stroke-indigo-700 fill-indigo-300 dark:fill-indigo-700">
              <polyline
                points={`${e.connX},${e.fromY} ${e.connX},${e.toY} ${e.arrow ? ax : e.toX},${e.toY}`}
                fill="none"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {e.arrow && (
                <polygon
                  points={`${ax},${e.toY - ARROW_H} ${e.toX},${e.toY} ${ax},${e.toY + ARROW_H}`}
                  stroke="none"
                />
              )}
            </g>
          )
        })}

        {layoutNodes.map(n => {
          const isRoot      = n.level === 0
          const isOverflow  = n.extra !== undefined
          const isClickable = !isRoot && !isOverflow
          const isDone      = n.status === 'done'
          const maxChars    = (isRoot ? 26 : n.level === 1 ? 21 : 17) - (isDone ? 2 : 0)
          return (
            <g
              key={n.id}
              className={isClickable ? 'group cursor-pointer' : ''}
              onClick={isClickable ? () => onDocClick(n.id) : undefined}
              style={{ cursor: isClickable ? 'pointer' : 'default' }}
            >
              <rect
                x={n.x} y={n.y} width={n.w} height={n.h} rx={5}
                strokeWidth="1.5"
                className={
                  isRoot
                    ? 'fill-violet-600 dark:fill-violet-700 stroke-violet-700 dark:stroke-violet-600'
                    : isOverflow
                    ? 'fill-gray-50 dark:fill-gray-800 stroke-gray-200 dark:stroke-gray-700'
                    : n.level === 1
                    ? 'fill-white dark:fill-gray-800 stroke-indigo-200 dark:stroke-indigo-800 group-hover:stroke-indigo-400 dark:group-hover:stroke-indigo-500 transition-colors'
                    : 'fill-gray-50 dark:fill-gray-800 stroke-indigo-100 dark:stroke-indigo-900 group-hover:stroke-indigo-300 dark:group-hover:stroke-indigo-600 transition-colors'
                }
              />
              {isOverflow ? (
                <text
                  x={n.x + n.w / 2} y={n.y + n.h / 2 + textDy}
                  textAnchor="middle" fontSize={fsNode}
                  className="fill-gray-400 dark:fill-gray-500"
                >
                  +{n.extra} more
                </text>
              ) : (
                <text x={n.x + 6} y={n.y + n.h / 2 + textDy} fontSize={isRoot ? fsRoot : fsNode}>
                  {isDone && <tspan className="fill-green-500 dark:fill-green-400">✓ </tspan>}
                  <tspan className={
                    isRoot      ? 'fill-white'
                    : n.level === 1 ? 'fill-gray-700 dark:fill-gray-200'
                    : 'fill-gray-500 dark:fill-gray-400'
                  }>
                    {trunc(n.name, maxChars)}
                  </tspan>
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
