/**
 * The bundled role library shipped in `packages/prompt-optimizer/roles` is a
 * copy of the repository catalog in `docs/roles`; this spec keeps the two in
 * lockstep and holds every shipped file to the service's listing contract.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const catalogDir = path.join(root, 'docs', 'roles')
const shippedDir = path.join(root, 'packages', 'prompt-optimizer', 'roles')
const ROLE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/

const shippedFiles = readdirSync(shippedDir).filter(name => ROLE_FILE_PATTERN.test(name)).sort()
const catalogFiles = readdirSync(catalogDir).filter(name => ROLE_FILE_PATTERN.test(name)).sort()

describe('bundled role library', () => {
  it('stays in lockstep with the docs/roles catalog', () => {
    expect(shippedFiles).toEqual(catalogFiles)
    for (const name of shippedFiles) {
      expect(readFileSync(path.join(shippedDir, name), 'utf8'))
        .toBe(readFileSync(path.join(catalogDir, name), 'utf8'))
    }
  })

  it('holds every shipped definition to the service contract', () => {
    expect(shippedFiles.length).toBeGreaterThan(0)
    expect(shippedFiles.length).toBeLessThanOrEqual(500)
    for (const name of shippedFiles) {
      const text = readFileSync(path.join(shippedDir, name), 'utf8')
      expect(text.startsWith('# '), `${name} must start with an H1 heading`).toBe(true)
      expect(text.length, `${name} must stay within the character cap`).toBeLessThanOrEqual(8000)
    }
  })
})
