/** Pure context-doctor analysis: section sizing, skill findings, references, token estimates. */
import { describe, expect, it } from 'vitest'
import { analyzeSections, analyzeSkills, estimateTokens, referencesOf } from '../src/context-check.ts'

describe('analyzeSections', () => {
  it('sizes sections with shares and reports no findings for clean input', () => {
    const { stats, findings } = analyzeSections([
      { name: 'identity', text: 'a'.repeat(100) },
      { name: 'persona', text: 'b'.repeat(300) },
    ])
    expect(stats).toEqual([
      { name: 'identity', chars: 100, share: 0.25 },
      { name: 'persona', chars: 300, share: 0.75 },
    ])
    expect(findings).toEqual([])
  })

  it('flags an oversized section and near-duplicate sections', () => {
    const text = 'review the code carefully before submitting any change to the repository always '
    const { findings } = analyzeSections([
      { name: 'big', text: 'x'.repeat(4001) },
      { name: 'left', text: text.repeat(5) },
      { name: 'right', text: `${text.repeat(4)} plus one tail sentence` },
    ])
    expect(findings).toEqual([
      { kind: 'oversized-section', subject: 'big', detail: expect.stringContaining('4001 characters') },
      { kind: 'duplicate-section', subject: 'left ≈ right', detail: expect.stringContaining('%') },
    ])
  })
})

describe('referencesOf', () => {
  it('collects relative file references once each, capped', () => {
    const body = 'Read ./guide.md first, then data.csv and scripts/run.sh; guide.md repeats; also https://example.com/x.md is absolute.'
    expect(referencesOf(body)).toEqual(['guide.md', 'data.csv', 'scripts/run.sh'])
    expect(referencesOf(Array.from({ length: 20 }, (_, index) => `f${String(index)}.md`).join(' '))).toHaveLength(8)
  })

  it('collects nothing from a body without file-like references', () => {
    expect(referencesOf('Just prose, no paths. See the section below.')).toEqual([])
  })
})

describe('analyzeSkills', () => {
  it('flags oversized and duplicate bodies and missing references', async () => {
    const body = 'pin the bus speed and probe the pins before flashing any firmware change '.repeat(3)
    const findings = await analyzeSkills(
      [
        { name: 'big-skill', body: 'y'.repeat(6001) },
        { name: 'uart-a', body: `${body}alpha tail` },
        { name: 'uart-b', body: `${body}beta tail` },
        { name: 'with-refs', body: 'Follow ./exists.md then missing.md' },
      ],
      async (skill, reference) => skill !== 'with-refs' || reference === 'exists.md',
    )
    expect(findings).toEqual([
      { kind: 'oversized-skill', subject: 'big-skill', detail: expect.stringContaining('6001 characters') },
      { kind: 'duplicate-skill', subject: 'uart-a ≈ uart-b', detail: expect.any(String) },
      { kind: 'stale-skill-reference', subject: 'with-refs', detail: expect.stringContaining('missing.md') },
    ])
  })
})

describe('estimateTokens', () => {
  it('counts CJK characters one token each and Latin as one per four characters', () => {
    expect(estimateTokens('调试串口')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('调试 abcdefgh')).toBe(5)
  })
})
