import { describe, it, expect } from 'vitest'
import { computeOutline, parseOutline, extractOutlineFromBody } from './outline'

describe('computeOutline', () => {
  it('returns empty JSON array for empty string', () => {
    expect(computeOutline('')).toBe('[]')
  })

  it('returns empty JSON array for body with no headings', () => {
    expect(computeOutline('Just some plain text\nNo headings here')).toBe('[]')
  })

  it('extracts H1', () => {
    const result = JSON.parse(computeOutline('# Hello World'))
    expect(result).toEqual([{ level: 1, text: 'Hello World' }])
  })

  it('extracts H1 through H6', () => {
    const body = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6'
    const result = JSON.parse(computeOutline(body))
    expect(result).toHaveLength(6)
    expect(result[0]).toEqual({ level: 1, text: 'H1' })
    expect(result[5]).toEqual({ level: 6, text: 'H6' })
  })

  it('ignores lines that are not headings', () => {
    const body = '# Title\nsome paragraph\n- bullet\n## Sub'
    const result = JSON.parse(computeOutline(body))
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe('Title')
    expect(result[1].text).toBe('Sub')
  })

  it('preserves heading order', () => {
    const body = '## First\n# Top\n### Deep'
    const result = JSON.parse(computeOutline(body))
    expect(result[0]).toEqual({ level: 2, text: 'First' })
    expect(result[1]).toEqual({ level: 1, text: 'Top' })
    expect(result[2]).toEqual({ level: 3, text: 'Deep' })
  })

  it('trims trailing whitespace from heading text', () => {
    const result = JSON.parse(computeOutline('# Heading   '))
    expect(result[0].text).toBe('Heading')
  })

  it('does not treat #without-space as heading', () => {
    expect(computeOutline('#NotAHeading')).toBe('[]')
  })

  it('handles 7+ hashes as not a heading (max H6)', () => {
    expect(computeOutline('####### Too deep')).toBe('[]')
  })

  it('handles multiline markdown document', () => {
    const body = `# Overview

Some intro text.

## Background

Details here.

### Sub-section

More details.

## Conclusion`
    const result = JSON.parse(computeOutline(body))
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ level: 1, text: 'Overview' })
    expect(result[3]).toEqual({ level: 2, text: 'Conclusion' })
  })
})

describe('parseOutline', () => {
  it('parses valid JSON array', () => {
    const items = parseOutline('[{"level":1,"text":"Title"}]')
    expect(items).toEqual([{ level: 1, text: 'Title' }])
  })

  it('returns empty array for empty string', () => {
    expect(parseOutline('')).toEqual([])
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseOutline('not json')).toEqual([])
  })
})

describe('extractOutlineFromBody', () => {
  it('returns OutlineItem array (not JSON string)', () => {
    const items = extractOutlineFromBody('# H1\n## H2')
    expect(Array.isArray(items)).toBe(true)
    expect(items[0]).toEqual({ level: 1, text: 'H1' })
  })

  it('matches computeOutline output when stringified', () => {
    const body = '# A\n## B\n### C'
    expect(JSON.stringify(extractOutlineFromBody(body))).toBe(computeOutline(body))
  })
})
