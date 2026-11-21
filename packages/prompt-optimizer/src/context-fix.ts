/**
 * Deterministic repair computation for context-doctor findings: strip a stale
 * file reference out of a skill body, rank near-name replacement files, and
 * split the pair subjects the scan reports. Pure functions only — the service
 * owns I/O and the model rounds.
 * @module @yimiliya/dsh-prompt-optimizer
 */

/** Separator the scan joins `left ≈ right` pair subjects with. */
const PAIR_SEPARATOR = ' ≈ '

/**
 * Split one `left ≈ right` finding subject into its two names.
 * @param subject - finding subject exactly as the scan reported it.
 * @returns the two names in reported order.
 * @throws when the subject carries no pair separator.
 */
export function splitPairSubject(subject: string): { readonly left: string; readonly right: string } {
  const parts = subject.split(PAIR_SEPARATOR)
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`the finding subject "${subject}" is not a left ≈ right pair`)
  }
  return { left: parts[0]!, right: parts[1]! }
}

/**
 * Extract the quoted reference path from one stale-reference finding detail.
 * @param detail - finding detail exactly as the scan reported it.
 * @returns the reference the finding named.
 * @throws when the detail carries no quoted reference.
 */
export function referenceOfDetail(detail: string): string {
  const match = /references "([^"]+)", which does not exist/.exec(detail)
  if (match === null) {
    throw new Error('the finding detail does not name a quoted stale reference')
  }
  return match[1]!
}

/**
 * Remove every occurrence of one stale reference from a skill body and drop
 * the list lines it leaves empty. A `./` or `/` path prefix directly before
 * the reference goes with it, so a mid-sentence removal leaves no dangling
 * path chrome. Deterministic and content-preserving: any line that still
 * carries other content stays, minus the reference itself.
 * @param body - complete skill definition text.
 * @param reference - stale relative path the scan flagged.
 * @returns the repaired body; identical to the input when the reference never appears verbatim.
 */
export function stripReference(body: string, reference: string): string {
  const lines = body.split('\n').map(line => line
    .replaceAll(`./${reference}`, '')
    .replaceAll(`/${reference}`, '')
    .replaceAll(reference, ''))
  const kept: string[] = []
  for (const line of lines) {
    const isBareBullet = /^\s*[-*]\s*$/.test(line)
    if (isBareBullet) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Rank existing files as a replacement target for one stale reference:
 * stem kinship (one basename containing the other, or a shared prefix of at
 * least three characters) qualifies a candidate, and a same extension then
 * boosts it — extension alone never qualifies anything. Deterministic.
 * @param reference - stale relative path the scan flagged.
 * @param existing - relative paths that do exist in the skill directory.
 * @returns the best candidate above zero score, or undefined when nothing plausibly matches.
 */
export function nearestExistingFile(reference: string, existing: readonly string[]): string | undefined {
  const refBase = reference.split('/').pop() ?? reference
  const refStem = refBase.replace(/\.[^.]+$/, '')
  const refExt = refBase.includes('.') ? `.${refBase.split('.').pop()}` : ''
  let best: { readonly path: string; readonly score: number } | undefined
  for (const path of existing) {
    if (path === reference) continue
    const base = path.split('/').pop() ?? path
    const stem = base.replace(/\.[^.]+$/, '')
    const ext = base.includes('.') ? `.${base.split('.').pop()}` : ''
    let score = 0
    if (stem !== '' && (stem.includes(refStem) || refStem.includes(stem))) score += 2
    let shared = 0
    while (shared < stem.length && shared < refStem.length && stem[shared] === refStem[shared]) shared += 1
    if (shared >= 3) score += 1
    if (score > 0 && refExt !== '' && ext === refExt) score += 3
    if (score > 0 && (best === undefined || score > best.score)) best = { path, score }
  }
  return best?.path
}

/**
 * Whether one directory path is the target directory itself or nested inside
 * it — the writability boundary for skill repairs.
 * @param dir - candidate directory the skill lives in.
 * @param root - writable root (the distillation target directory).
 * @returns true when `dir` equals `root` or lies under it.
 */
export function isWithin(dir: string, root: string): boolean {
  if (dir === root) return true
  return dir.startsWith(`${root}/`)
}

/**
 * Normalize one raw model merge output: strip a whole-file code fence and
 * trim surrounding whitespace, so a fenced reply still yields usable text.
 * @param response - complete assembled merge response.
 * @returns the trimmed merge text; empty when the model returned nothing.
 */
export function plainMergeText(response: string): string {
  return response.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
}
