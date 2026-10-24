/**
 * v1 safety screening for verify check commands: a coarse deny-list matched
 * over a normalized form of the command text. The screen is the host-side
 * floor beneath the user's click-through approval, not a sandbox.
 * @module @yimiliya/dsh-prompt-optimizer/verify-policy
 */

/** Verdict of one {@link screenVerifyCommand} pass. */
export type VerifyCommandVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Normalize a command for matching: lowercase it, strip quote characters, and
 * collapse whitespace runs to single spaces.
 * @param command - fully substituted check command.
 * @returns the normalized command text.
 */
function normalizeCommand(command: string): string {
  return command.replaceAll(/['"]/g, '').toLowerCase().replaceAll(/\s+/g, ' ').trim()
}

/** Network fetch/listen utilities a check command never needs. */
const NETWORK_COMMAND = /\b(curl|wget|nc|ncat|netcat)\b/
/** A shell directly on the receiving end of a pipe, with or without a space. */
const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh)\b/
/** Process substitution spawns an interpreter the command line never names. */
const PROCESS_SUBSTITUTION = /<\(/
/** Destructive verbs, longest first so the captured token is exact. */
const DESTRUCTIVE_COMMAND = /\b(rmdir|mkfs|shred|rm)\b/
/** `dd` duplicating from an input device. */
const DD_INPUT = /\bdd if=/
/** Redirection onto a raw disk device. */
const DEVICE_REDIRECT = />{1,2}\s*\/dev\/sd/
/** sudo as a whole word. */
const SUDO = /\bsudo\b/
/** su (switch user) as a whole word. */
const SU = /\bsu\b/
/** World-writable permissions granted at or below the filesystem root. */
const CHMOD_777_ROOT = /chmod 777 \//
/** Recursive ownership change at or below the filesystem root. */
const CHOWN_RECURSIVE_ROOT = /chown -R \//
/** Redirection targets a check command must never write into. */
const PROTECTED_REDIRECT_TARGETS = ['/etc/', '/usr/', '~/.ssh/', '~/.zshrc', '~/.bashrc', '~/.profile'] as const

/**
 * Screen one fully substituted check command against the v1 deny-list.
 *
 * v1 known limits, deliberate scope: obfuscation — `$IFS` splitting,
 * character splicing beyond quote stripping, base64-decode pipes — is NOT
 * covered. This is a normalization-plus-deny-list, not a command parser.
 *
 * @param command - fully substituted check command.
 * @returns ok unless the normalized command matches a deny rule, whose short
 * stable lowercase reason then names the rule that fired.
 */
export function screenVerifyCommand(command: string): VerifyCommandVerdict {
  const normalized = normalizeCommand(command)
  const network = NETWORK_COMMAND.exec(normalized)
  if (network !== null) return { ok: false, reason: `network command: ${network[1]}` }
  const pipe = PIPE_TO_SHELL.exec(normalized)
  if (pipe !== null) return { ok: false, reason: `pipe to shell: ${pipe[1]}` }
  if (PROCESS_SUBSTITUTION.test(normalized)) return { ok: false, reason: 'process substitution' }
  const destructive = DESTRUCTIVE_COMMAND.exec(normalized)
  if (destructive !== null) return { ok: false, reason: `destructive command: ${destructive[1]}` }
  if (DD_INPUT.test(normalized)) return { ok: false, reason: 'destructive command: dd' }
  if (DEVICE_REDIRECT.test(normalized)) return { ok: false, reason: 'destructive device redirect' }
  if (SUDO.test(normalized)) return { ok: false, reason: 'privilege escalation: sudo' }
  if (SU.test(normalized)) return { ok: false, reason: 'privilege escalation: su' }
  if (CHMOD_777_ROOT.test(normalized)) return { ok: false, reason: 'privilege escalation: chmod 777 /' }
  if (CHOWN_RECURSIVE_ROOT.test(normalized)) return { ok: false, reason: 'privilege escalation: chown -R /' }
  for (const match of normalized.matchAll(/>{1,2}\s*(\S+)/g)) {
    const target = match[1] ?? ''
    const protectedTarget = PROTECTED_REDIRECT_TARGETS.find(prefix => target.startsWith(prefix))
    if (protectedTarget !== undefined) {
      return { ok: false, reason: `redirect into protected path: ${protectedTarget}` }
    }
  }
  return { ok: true }
}
