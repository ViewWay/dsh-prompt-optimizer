/**
 * Target-model capability tiers and the decline-to-optimize precheck. The
 * rewrite's best shape depends on what executes it: reasoning models plan
 * internally and are hurt by scaffolding, small local models cannot infer
 * unstated conventions, and the strongest optimization advice is sometimes to
 * not optimize at all.
 * @module @yimiliya/dsh-prompt-optimizer
 */

import type { ModelTier, PromptClarification, PromptOptimizeDirection, PromptOptimizeTarget, PromptSkipReason } from './types.ts'

/**
 * Model-id markers of reasoning models: `deepseek-reasoner`, `deepseek-r1`,
 * `o1-mini`, `o3`, `o4-mini`, `qwq-32b`, `*-thinking`. Word-ish boundaries on
 * both sides keep `4.1`, `t1`, and `llama3.1` from matching.
 */
const REASONING_MODEL_PATTERN = /(?:^|[^a-z0-9])(?:r1|reasoner|o1|o3|o4|qwq|qvq|thinking)(?![a-z0-9])/i

/** Providers that usually serve self-hosted models behind a gateway. */
const GATEWAY_PROVIDER_PATTERN = /litellm|vllm|ollama|llama\.?cpp|sglang|lm-?studio|localai/i

/**
 * Model-id markers of hosted frontier families: a gateway route to one of
 * these is a hosted model, not a small local one, whatever proxy fronts it.
 */
const HOSTED_MODEL_PATTERN = /gpt|claude|gemini|grok|deepseek|qwen-(?:max|plus|turbo)|kimi|doubao|minimax|ernie|hunyuan|glm-[45]/i

/** Open-weight families a small local deployment most often serves. */
const SMALL_FAMILY_PATTERN = /qwen|llama|phi|gemma|minicpm|internlm|yi|starcoder|codestral|falcon|olmo|tinyllama/i

/** Size suffixes (≤14B) that mark a small model inside a family id. */
const SMALL_SIZE_PATTERN = /(?:^|[^0-9.])(?:0\.5|1\.5|1\.8|2\.7|3|4|6\.7|7|8|9|11|12|13|14)[bx](?![a-z0-9])/i

/**
 * Classify one route's capability tier from its provider and model ids.
 * Deterministic and id-based only: reasoning markers win first (a distilled
 * R1 on a gateway is still a reasoning model), then gateways and explicit
 * small sizes mark `local-small`, everything else is `standard`.
 * @param provider - route key the optimization would dispatch on.
 * @param model - model id the optimization would dispatch on.
 * @returns the route's capability tier; `standard` when no marker matches.
 */
export function classifyModelTier(provider: string, model: string): ModelTier {
  if (REASONING_MODEL_PATTERN.test(model)) return 'reasoning'
  if (!HOSTED_MODEL_PATTERN.test(model) && (GATEWAY_PROVIDER_PATTERN.test(provider) || (SMALL_FAMILY_PATTERN.test(model) && SMALL_SIZE_PATTERN.test(model)))) {
    return 'local-small'
  }
  return 'standard'
}

/**
 * Guidance lines appended to an optimization system prompt for one tier;
 * `standard` adds nothing so the generic rewrite prompt stays byte-identical.
 * @param tier - classified tier of the round's route.
 * @returns the exact meta-prompt lines for the tier; empty for `standard`.
 */
export function modelTierBlock(tier: ModelTier): readonly string[] {
  switch (tier) {
    case 'reasoning':
      return [
        'Target model tier: a REASONING model that plans internally before answering.',
        '- Never add chain-of-thought scaffolding: no "think step by step", no worked reasoning sections, no restated instructions the model already follows — they add noise and can degrade reasoning models.',
        '- Spend the rewrite on specification completeness instead: inputs, outputs, edge cases, and the acceptance criteria stay fully explicit.',
        '- Keep the rewrite signal-dense: state constraints and facts directly; drop politeness and role-play framing.',
      ]
    case 'local-small':
      return [
        'Target model tier: a SMALL LOCAL model behind a self-hosted gateway; it cannot infer unstated conventions.',
        '- Make every invariant explicit: exact commands, exact file paths, exact output format, exact success condition.',
        '- Use short declarative sentences, one instruction per line; prefer an ordered step list over paragraphs.',
        '- When the output shape matters, include a literal template of the expected output.',
        '- Avoid indirect requests, idioms, and multi-clause sentences the model may parse only partially.',
      ]
    case 'standard':
      return []
  }
}

/** Longest draft the decline precheck still considers "short". */
const SKIP_DRAFT_MAX_CHARS = 240

/**
 * Everything the decline precheck needs about one request; every input comes
 * from the already-validated request and route, so the check stays pure.
 */
export interface DeclineCheckInput {
  /** Classified tier of the round's resolved route. */
  readonly tier: ModelTier
  /** Request target; standing SYSTEM prompts always justify a rewrite. */
  readonly target: PromptOptimizeTarget
  /** Complete draft text. */
  readonly draft: string
  /** Domain-guidance lines detected for the draft; nonempty means a rewrite has work to do. */
  readonly domainPriors: readonly string[]
  /** Role slug styling the round; a picked role always justifies a rewrite. */
  readonly role: string | undefined
  /** Requested direction; a steer always justifies a rewrite. */
  readonly direction: PromptOptimizeDirection | undefined
  /** Rejected earlier results; a retry always justifies a rewrite. */
  readonly previousAttempts: readonly string[]
  /** Interview answers the round carries; an interviewed draft always justifies a rewrite. */
  readonly clarifications?: readonly PromptClarification[]
}

/**
 * Whether the round should decline to rewrite: a short, unstructured, generic
 * draft aimed at a reasoning model gains nothing from rewriting — the model's
 * own planning already covers what scaffolding would add, and additions risk
 * hurting it. Every other shape keeps the rewrite.
 * @param input - the request's tier, target, draft, and conditioners.
 * @returns the stable skip reason, or undefined when the round should run.
 */
export function declineToOptimize(input: DeclineCheckInput): PromptSkipReason | undefined {
  if (input.tier !== 'reasoning') return undefined
  if (input.target !== 'draft') return undefined
  if (input.role !== undefined || input.direction !== undefined) return undefined
  if (input.previousAttempts.length > 0) return undefined
  if ((input.clarifications ?? []).length > 0) return undefined
  if (input.domainPriors.length > 0) return undefined
  const draft = input.draft.trim()
  if (draft.length > SKIP_DRAFT_MAX_CHARS) return undefined
  if (draft.length === 0) return undefined
  const structured = /^#{1,6}\s/m.test(draft) || /^\s*[-*]\s/m.test(draft) || draft.includes('```')
  if (structured) return undefined
  return 'reasoning-short-clear'
}
