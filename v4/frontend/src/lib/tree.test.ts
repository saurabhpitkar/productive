import { describe, it, expect } from 'vitest'
import { buildTree } from './tree'
import type { Doc, DocLinkInfo } from '../types'

function doc(id: string, name = id): Doc {
  return {
    id, name, body: '', note_outline: '', due_date: null, due_time: null,
    flag: null, list_id: null, priority: null, status: 'todo',
    tags: {}, theme_ids: [], linked_doc_ids: [], embedding: null,
    hitl_required: false, hitl_status: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }
}

function up(source: string, target: string): DocLinkInfo {
  return { source_doc_id: source, target_doc_id: target, label: 'belongs_to', created_at: '2026-01-01T00:00:00Z' }
}

describe('buildTree', () => {
  it('returns all docs as roots when there are no up-links', () => {
    const docs = [doc('a'), doc('b'), doc('c')]
    const tree = buildTree(docs, [])
    expect(tree).toHaveLength(3)
    expect(tree.every(n => n.children.length === 0)).toBe(true)
  })

  it('builds a simple parent → child hierarchy', () => {
    const docs  = [doc('parent'), doc('child')]
    const links = [up('child', 'parent')]
    const tree  = buildTree(docs, links)
    // 'child' has parent so only 'parent' is root
    expect(tree).toHaveLength(1)
    expect(tree[0].doc.id).toBe('parent')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].doc.id).toBe('child')
  })

  it('handles two levels of nesting', () => {
    const docs  = [doc('root'), doc('mid'), doc('leaf')]
    const links = [up('mid', 'root'), up('leaf', 'mid')]
    const [root] = buildTree(docs, links)
    expect(root.doc.id).toBe('root')
    expect(root.children[0].doc.id).toBe('mid')
    expect(root.children[0].children[0].doc.id).toBe('leaf')
  })

  it('ignores links where source or target doc is missing', () => {
    const docs  = [doc('a')]
    const links = [up('a', 'ghost'), up('ghost', 'a')]
    const tree  = buildTree(docs, links)
    // both links reference unknown 'ghost' → 'a' has no valid parent → 'a' is root
    expect(tree).toHaveLength(1)
    expect(tree[0].doc.id).toBe('a')
    expect(tree[0].children).toHaveLength(0)
  })

  it('does not follow non-up link labels', () => {
    const docs  = [doc('a'), doc('b')]
    const links: DocLinkInfo[] = [
      { source_doc_id: 'a', target_doc_id: 'b', label: 'requires', created_at: '' },
      { source_doc_id: 'a', target_doc_id: 'b', label: 'related_to', created_at: '' },
    ]
    const tree = buildTree(docs, links)
    // neither doc is a child via up-link → both are roots
    expect(tree).toHaveLength(2)
  })

  it('handles multiple children under one parent', () => {
    const docs  = [doc('root'), doc('c1'), doc('c2'), doc('c3')]
    const links = [up('c1', 'root'), up('c2', 'root'), up('c3', 'root')]
    const [root] = buildTree(docs, links)
    expect(root.children).toHaveLength(3)
  })

  it('avoids infinite loops on cyclic up-links', () => {
    const docs  = [doc('a'), doc('b')]
    const links = [up('a', 'b'), up('b', 'a')]
    // Both docs have parents in a mutual cycle, so roots is empty.
    // The key invariant: buildTree must complete without hanging or throwing.
    expect(() => buildTree(docs, links)).not.toThrow()
  })
})
