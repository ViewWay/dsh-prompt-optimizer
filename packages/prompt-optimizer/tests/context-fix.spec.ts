/** Pure repair computation: pair subjects, stale references, near-name files, writability. */
import { describe, expect, it } from 'vitest'
import {
  isWithin,
  nearestExistingFile,
  plainMergeText,
  referenceOfDetail,
  splitPairSubject,
  stripReference,
} from '../src/context-fix.ts'

describe('context-fix pure helpers', () => {
  it('splits a left ≈ right pair subject and rejects anything else', () => {
    expect(splitPairSubject('i2c-a ≈ i2c-b')).toEqual({ left: 'i2c-a', right: 'i2c-b' })
    expect(() => splitPairSubject('only-one')).toThrow('is not a left ≈ right pair')
    expect(() => splitPairSubject('a ≈ b ≈ c')).toThrow('is not a left ≈ right pair')
  })

  it('extracts the quoted reference from a stale-reference detail and rejects other text', () => {
    expect(referenceOfDetail('references "guide.md", which does not exist in the skill directory')).toBe('guide.md')
    expect(() => referenceOfDetail('body is 9000 characters')).toThrow('does not name a quoted stale reference')
  })

  it('strips a stale reference everywhere and drops the bullets it empties', () => {
    const body = [
      '# 标题',
      '',
      '- Read ./gone.md first',
      '- Also open ./gone.md and ./live.md',
      '- Keep this line',
    ].join('\n')
    expect(stripReference(body, './gone.md')).toBe([
      '# 标题',
      '',
      '- Read  first',
      '- Also open  and ./live.md',
      '- Keep this line',
    ].join('\n'))
  })

  it('ranks near-name files: stem kinship qualifies, same extension boosts, nothing plausible yields undefined', () => {
    expect(nearestExistingFile('guide.md', ['guide-v2.md', 'readme.md', 'guide.md'])).toBe('guide-v2.md')
    expect(nearestExistingFile('uart.md', ['uart-notes.txt', 'wire.md'])).toBe('uart-notes.txt')
    expect(nearestExistingFile('guilde.md', ['guide.md', 'present.md'])).toBe('guide.md')
    expect(nearestExistingFile('guide.md', ['unrelated.md'])).toBeUndefined()
    expect(nearestExistingFile('guide.md', [])).toBeUndefined()
  })

  it('bounds writability to the root directory itself or its children', () => {
    expect(isWithin('/proj/.dsh/skills', '/proj/.dsh/skills')).toBe(true)
    expect(isWithin('/proj/.dsh/skills/uart', '/proj/.dsh/skills')).toBe(true)
    expect(isWithin('/packaged/uart', '/proj/.dsh/skills')).toBe(false)
    expect(isWithin('/proj/.dsh/skills-other/uart', '/proj/.dsh/skills')).toBe(false)
  })

  it('normalizes a raw merge reply by stripping whole-file fences and trimming', () => {
    expect(plainMergeText('```markdown\n合并文本\n```')).toBe('合并文本')
    expect(plainMergeText('  合并文本  ')).toBe('合并文本')
    expect(plainMergeText('```\n```')).toBe('')
  })
})
