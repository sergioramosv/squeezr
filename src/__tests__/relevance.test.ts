import { describe, it, expect } from 'vitest'
import { tokenize, bm25Scores, rankByRelevance } from '../relevance.js'

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Foo.Bar(baz)')).toEqual(['foo', 'bar', 'baz'])
  })
  it('drops 1-char noise tokens but keeps numbers/identifiers', () => {
    expect(tokenize('a in the db_pool 42')).toEqual(['in', 'the', 'db_pool', '42'])
  })
  it('returns [] for empty/symbol-only input', () => {
    expect(tokenize('   %%$$  ')).toEqual([])
  })
})

describe('bm25Scores', () => {
  it('scores a matching doc above a non-matching one', () => {
    const docs = ['the database connection failed', 'the cat sat on the mat']
    const s = bm25Scores('database connection', docs)
    expect(s[0]).toBeGreaterThan(s[1])
  })

  it('weights a RARE query term more than a common one (idf)', () => {
    // "apple" appears in 1 doc (rare), "banana" in 3 (common). A doc matching the
    // rare term should outscore a doc matching only the common one.
    const docs = ['apple', 'banana', 'banana', 'banana']
    const s = bm25Scores('apple banana', docs)
    expect(s[0]).toBeGreaterThan(s[1])
  })

  it('returns all-zero scores when the query has no usable terms', () => {
    const docs = ['anything here', 'and here']
    expect(bm25Scores('', docs)).toEqual([0, 0])
    expect(bm25Scores('%%%', docs)).toEqual([0, 0])
  })

  it('gives a non-matching doc a score of 0', () => {
    const docs = ['relevant match here', 'totally unrelated']
    const s = bm25Scores('relevant', docs)
    expect(s[1]).toBe(0)
    expect(s[0]).toBeGreaterThan(0)
  })

  it('does not let a long repetitive doc dominate unboundedly (length normalization)', () => {
    const short = 'error'
    const long = ('error ' + 'filler '.repeat(200)).trim()
    const s = bm25Scores('error', [short, long])
    // the concise doc that is mostly the query term should score at least as high
    expect(s[0]).toBeGreaterThanOrEqual(s[1])
  })

  it('is deterministic', () => {
    const docs = ['alpha beta', 'beta gamma', 'gamma delta']
    expect(bm25Scores('beta gamma', docs)).toEqual(bm25Scores('beta gamma', docs))
  })

  it('produces one score per doc', () => {
    const docs = ['a b c', 'd e f', 'g h i']
    expect(bm25Scores('a', docs).length).toBe(3)
  })
})

describe('rankByRelevance', () => {
  it('returns document indices sorted by descending relevance', () => {
    const docs = ['no match', 'strong error error match', 'weak error']
    const order = rankByRelevance('error', docs)
    expect(order[0]).toBe(1) // most "error" hits
    expect(order[order.length - 1]).toBe(0) // no match last
  })

  it('is a stable permutation of all indices', () => {
    const docs = ['a', 'b', 'c', 'd']
    const order = rankByRelevance('a b', docs)
    expect([...order].sort((x, y) => x - y)).toEqual([0, 1, 2, 3])
  })
})
