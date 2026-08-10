import type { Doc, DocLinkInfo } from '../types'

export interface TreeNode {
  doc:      Doc
  children: TreeNode[]
}

// Build a tree from docs connected by 'belongs_to' links.
// Convention: child doc holds the 'belongs_to' link pointing at its parent
// (source_doc_id = child, target_doc_id = parent).
// Docs with no 'belongs_to' link to a known doc become roots.
export function buildTree(docs: Doc[], links: DocLinkInfo[]): TreeNode[] {
  const byId = new Map<string, Doc>(docs.map(d => [d.id, d]))

  // child id → parent id
  const childToParent = new Map<string, string>()
  // parent id → child ids
  const childrenOf = new Map<string, string[]>()

  for (const l of links) {
    if (l.label !== 'belongs_to') continue
    const child  = l.source_doc_id
    const parent = l.target_doc_id
    if (!byId.has(child) || !byId.has(parent)) continue
    childToParent.set(child, parent)
    const arr = childrenOf.get(parent) ?? []
    arr.push(child)
    childrenOf.set(parent, arr)
  }

  const roots = docs.filter(d => !childToParent.has(d.id))

  function toNode(doc: Doc, visited = new Set<string>()): TreeNode {
    if (visited.has(doc.id)) return { doc, children: [] }
    const next = new Set(visited)
    next.add(doc.id)
    const children = (childrenOf.get(doc.id) ?? [])
      .map(id => byId.get(id))
      .filter((d): d is Doc => d !== undefined)
      .map(d => toNode(d, next))
    return { doc, children }
  }

  return roots.map(d => toNode(d))
}
