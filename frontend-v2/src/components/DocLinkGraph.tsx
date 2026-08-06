import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { api } from '../api/client'

interface Props {
  docId: string
  docName: string
  docStatus: string
  l1Links: { id: string; label: 'requires' | 'up' }[]
  onDocClick: (id: string) => void
  compact?: boolean   // tighter layout - 5 nodes fit in ~151px (mobile)
  className?: string
}

const W       = 200
const L1_X    = 22
const L2_X    = 42
const CONN1_X = 10
const CONN2_X = 32
const ARROW   = 5
const ARROW_H = 3
const MAX     = 5

// Normal vs compact sizes
const SIZES = {
  normal:  { ROOT_H: 30, NODE_H: 24, GAP: 9, fsRoot: '10', fsNode: '9', textDy: 4 },
  compact: { ROOT_H: 22, NODE_H: 17, GAP: 3, fsRoot: '9',  fsNode: '8', textDy: 3 },
}

const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

type L2Data = { up: string[]; req: string[] }

interface LayoutNode {
  id: string; name: string; status: string
  x: number; y: number; w: number; h: number
  level: 0 | 1 | 2
  extra?: number
}
interface Edge {
  connX: number
  fromY: number   // start of vertical segment (root/parent edge)
  toY: number     // child midY (vertical endpoint, then goes horizontal)
  toX: number     // child left edge (horizontal endpoint = arrowhead)
}

export function DocLinkGraph({ docId, docName, docStatus, l1Links, onDocClick, compact = false, className }: Props) {
  const { ROOT_H, NODE_H, GAP, fsRoot, fsNode, textDy } = SIZES[compact ? 'compact' : 'normal']
  const [l2Map, setL2Map] = useState<Record<string, L2Data>>({})

  const docInfoMap = useLiveQuery(async () => {
    const arr = await db.docs.toArray()
    return new Map(arr.map(d => [d.id, { name: d.name, status: d.status }]))
  }, [])

  const l1Key = l1Links.slice(0, MAX).map(l => l.id).join(',')

  useEffect(() => {
    if (!l1Links.length) return
    let cancelled = false
    Promise.all(
      l1Links.slice(0, MAX).map(l =>
        api.getLinks(l.id)
          .then(links => [l.id, {
            up:  links.filter(x => x.label === 'up').map(x => x.target_doc_id),
            req: links.filter(x => x.label === 'requires').map(x => x.target_doc_id),
          }] as [string, L2Data])
          .catch(() => [l.id, { up: [], req: [] }] as [string, L2Data])
      )
    ).then(results => {
      if (!cancelled) setL2Map(Object.fromEntries(results))
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l1Key])

  if (!docInfoMap || !l1Links.length) return null

  // ── Separate and dedup linked docs ───────────────────────────────────────
  const seen = new Set<string>([docId])
  const info = (id: string) => {
    const d = docInfoMap.get(id)
    return { name: d?.name ?? '…', status: d?.status ?? 'todo' }
  }

  type Role = 'l1up' | 'l2up' | 'l1req' | 'l2req'
  interface AllNode { id: string; name: string; status: string; role: Role; parentId?: string }
  const allNodes: AllNode[] = []

  const l1UpIds  = l1Links.filter(l => l.label === 'up').map(l => l.id)
  const l1ReqIds = l1Links.filter(l => l.label === 'requires').map(l => l.id)

  // Priority 1: level-1 up (parents - shown above root)
  for (const id of l1UpIds) {
    if (seen.has(id)) continue
    seen.add(id)
    allNodes.push({ id, ...info(id), role: 'l1up' })
  }
  // Priority 2: level-1 requires (children - shown below root)
  for (const id of l1ReqIds) {
    if (seen.has(id)) continue
    seen.add(id)
    allNodes.push({ id, ...info(id), role: 'l1req' })
  }
  // Priority 3: level-2 requires (grandchildren)
  for (const pid of l1ReqIds) {
    for (const id of l2Map[pid]?.req ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      allNodes.push({ id, ...info(id), role: 'l2req', parentId: pid })
    }
  }
  // Priority 4: level-2 up (grandparents)
  for (const pid of l1UpIds) {
    for (const id of l2Map[pid]?.up ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      allNodes.push({ id, ...info(id), role: 'l2up', parentId: pid })
    }
  }

  const shown    = allNodes.slice(0, MAX)
  const overflow = allNodes.length - shown.length

  // ── Layout ───────────────────────────────────────────────────────────────
  const visL2Up  = shown.filter(n => n.role === 'l2up')
  const visL1Up  = shown.filter(n => n.role === 'l1up')
  const visL1Req = shown.filter(n => n.role === 'l1req')
  const visL2Req = shown.filter(n => n.role === 'l2req')

  const layoutNodes: LayoutNode[] = []
  const edges: Edge[] = []

  // Compute root Y: above section height = (n_l2up + n_l1up) × (NODE_H + GAP)
  const aboveCount = visL2Up.length + visL1Up.length
  const rootY = aboveCount > 0 ? aboveCount * (NODE_H + GAP) : 0

  // Track L1 positions for L2 edge routing
  const l1UpY:  Record<string, number> = {}
  const l1ReqY: Record<string, number> = {}

  // ── ABOVE section (l2_up then l1_up, top-to-bottom) ─────────────────────
  let curY = 0

  for (const n of visL2Up) {
    layoutNodes.push({ id: n.id, name: n.name, status: n.status, x: L2_X, y: curY, w: W - L2_X - 2, h: NODE_H, level: 2 })
    // Connector: from l1_up's TOP (l1UpY set below), going UP to this node's mid
    // We'll add these edges after computing l1UpY
    curY += NODE_H + GAP
  }

  for (const n of visL1Up) {
    l1UpY[n.id] = curY
    layoutNodes.push({ id: n.id, name: n.name, status: n.status, x: L1_X, y: curY, w: W - L1_X - 2, h: NODE_H, level: 1 })
    // Connector from root TOP going UP to this node's mid
    edges.push({ connX: CONN1_X, fromY: rootY, toY: curY + NODE_H / 2, toX: L1_X })
    curY += NODE_H + GAP
  }

  // Now add l2_up edges (need l1UpY populated)
  for (const n of visL2Up) {
    const pid = n.parentId
    const pY  = pid ? (l1UpY[pid] ?? 0) : 0
    edges.push({ connX: CONN2_X, fromY: pY, toY: layoutNodes.find(x => x.id === n.id)!.y + NODE_H / 2, toX: L2_X })
  }

  // ── Root node ────────────────────────────────────────────────────────────
  layoutNodes.push({ id: docId, name: docName, status: docStatus, x: 0, y: rootY, w: W, h: ROOT_H, level: 0 })

  curY = rootY + ROOT_H + GAP

  // ── BELOW section (l1_req then l2_req, top-to-bottom) ───────────────────
  for (const n of visL1Req) {
    l1ReqY[n.id] = curY
    layoutNodes.push({ id: n.id, name: n.name, status: n.status, x: L1_X, y: curY, w: W - L1_X - 2, h: NODE_H, level: 1 })
    edges.push({ connX: CONN1_X, fromY: rootY + ROOT_H, toY: curY + NODE_H / 2, toX: L1_X })
    curY += NODE_H + GAP
  }

  for (const n of visL2Req) {
    const pid = n.parentId
    const pY  = pid ? (l1ReqY[pid] ?? rootY + ROOT_H) : rootY + ROOT_H
    layoutNodes.push({ id: n.id, name: n.name, status: n.status, x: L2_X, y: curY, w: W - L2_X - 2, h: NODE_H, level: 2 })
    edges.push({ connX: CONN2_X, fromY: pY + NODE_H, toY: curY + NODE_H / 2, toX: L2_X })
    curY += NODE_H + GAP
  }

  if (overflow > 0) {
    layoutNodes.push({ id: '__ov', name: '', status: '', x: L1_X, y: curY, w: W - L1_X - 2, h: NODE_H, level: 1, extra: overflow })
    edges.push({ connX: CONN1_X, fromY: rootY + ROOT_H, toY: curY + NODE_H / 2, toX: L1_X })
    curY += NODE_H + GAP
  }

  const svgH = curY - GAP + 2

  // ── Render ───────────────────────────────────────────────────────────────
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
                points={`${e.connX},${e.fromY} ${e.connX},${e.toY} ${ax},${e.toY}`}
                fill="none"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polygon
                points={`${ax},${e.toY - ARROW_H} ${e.toX},${e.toY} ${ax},${e.toY + ARROW_H}`}
                stroke="none"
              />
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
                    ? 'fill-indigo-600 dark:fill-indigo-700 stroke-indigo-700 dark:stroke-indigo-600'
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
                    isRoot ? 'fill-white'
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
