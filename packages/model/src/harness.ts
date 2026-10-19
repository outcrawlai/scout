/**
 * The port that runs an injected {@link ModelPlan}.
 *
 * The host's plan says WHICH models run an agent, by role: the actuator chain
 * (the hands, rank 0 first), an optional planner and an optional brain, each
 * with its measured per-model knobs (action deadline, extraction hedge,
 * upstream order, reply schema). This file says what happens when one of them
 * will not answer and how the pair keeps the expensive half away from the
 * page. A host that pins the whole thing to one model for an afternoon's
 * debugging hands in a one-model plan; nothing here reads a model id from
 * anywhere else. Nothing here reaches a customer: the only string this module
 * puts anywhere a caller can read is the unchanged text of whatever error
 * survived every fallback.
 *
 * ── Why the chain is clients and not one client with a list ─────────────────
 *
 * `ModelClient` holds one provider, one model and one session, and its
 * attribution, estimates and failure records are all per model. A host that
 * routes one slot's model elsewhere gives that slot its own provider
 * ({@link HarnessPortOptions.providerFor}); a client is never asked to hold two.
 *
 * So a chain is N clients over ONE shared {@link CostLedger}, not one client
 * that swaps its model field. Every rank is priced, every rank is attributable,
 * the ledger stays one accumulator, and a cross-provider chain needs nothing
 * loosened. A planner/actuator pair is the same
 * construction with two roles instead of three ranks.
 *
 * ── What failover is for, and what it is not for ────────────────────────────
 *
 * Failing over costs a wasted call: the primary was asked, it did not answer,
 * and the clock ran. That is worth paying when another model would have
 * succeeded and worth nothing otherwise, so {@link shouldFailOver} is a closed
 * decision over the error taxonomy in `./provider` rather than a catch-all.
 *
 * It fires on a timeout, a 429 and a 5xx — the provider asking us to wait, which
 * is `errorFrom`'s own `retryable` set — and ALSO on a 400 or a 404, which that
 * set marks non-retryable. The divergence is deliberate and it is the case a
 * chain exists for: the gateway answers 400 for an unknown model id, so a preview
 * slug being decommissioned under us presents as a permanent 400 on every call.
 * Retrying the same slug is pointless; the next rank is the entire remedy.
 *
 * It does NOT fire on 401, 402 or 403. Those are the same on every rank, so
 * trying two more triples the latency in front of the one error whose text tells
 * an operator what to fix.
 *
 * It does NOT fire on {@link ModelUnusableError}. The model answered and we were
 * billed, and a refusal is the model's verdict on a page it could see —
 * `AgentStopReason`'s `gave-up` exists to carry exactly that as a first-class
 * outcome. Failing over would bill twice for one answer and turn a verdict into
 * a retry loop.
 *
 * It does NOT fire on {@link ModelSchemaError} either: billed, and a second
 * model is as likely to miss the same grammar. That is now MEASURED rather than
 * argued, and it measured worse than "as likely": on the Facebook Ad Library
 * page (2026-09-12, AdCountStable) the rank-1 hands model
 * answered 11 of the page's 26 ads in 4 of 6
 * replays of one fixed render, because it deduplicates identical ad creatives —
 * with `stopReason: 'stop'`, no warning, and nothing on the wire to separate it
 * from a complete answer. Demoting a schema failure would therefore trade a 500
 * for a quietly shorter 200, which is a worse outcome wearing a better status
 * code. The remedy for a malformed reply is to TELL THE SAME MODEL what was
 * wrong and ask it again — `ModelClient.choose` has always done that and
 * `ModelClient.extract` now does too — and neither of those is a demotion.
 *
 * ── Demotion holds for a cooldown, then the primary is asked again ────────
 *
 * A run that demotes stays on the lower rank for {@link FAILOVER_COOLDOWN_MS},
 * then goes back to rank 0 on its next call. If rank 0 fails again the chain
 * demotes again and the cooldown doubles, up to {@link FAILOVER_COOLDOWN_CAP_MS};
 * once rank 0 answers, the cooldown returns to its base.
 *
 * It used to be sticky for the whole run, for two reasons, the first of which
 * still bounds the design: a flapping chain spends one failed primary call per step, and
 * the in-client action cache of the time put the model id in its key, so
 * flapping thrashed it. A cooldown keeps both to at most one probe per window.
 * Sticky cost more than it saved once the primary's faults became brief and
 * frequent: from 12Z on 2026-09-24 the gateway's inline 502 from the rank-0
 * model's upstream was 7-16% of every agent step, and rank 1 is roughly
 * 17x rank 0's per-minute cost on a content-heavy page (the host's measurement),
 * so one double failure moved the rest of a run onto the expensive model and
 * off the primary that is supposed to take every action.
 *
 * One demotion does not hold: a LONE STALL, where rank 0 timed out on one call
 * while its previous call answered. The next rank answers that call and the
 * next call goes back to rank 0 ({@link LONE_STALL_HOLD_MS}, with the
 * measurement). A stall is also cut sooner than it used to be — an action call
 * to a model with a measured tail waits its {@link PlanModel.actionDeadlineMs}, not the
 * client's 60 s — because a customer pays browser time for every second of it.
 *
 * The lifetime is the run's: `ModelBinder.forJob` mints one of these per run.
 * Every step records the rank that answered it (`ModelChoice.modelRank`, then
 * `StepTrace.modelRank`) so a demotion and a recovery are visible per step.
 *
 * ── What the customer sees ─────────────────────────────────────────────────
 *
 * A slower step and a rank number on it. `StepTrace.modelRank` says which rank
 * answered — 0, 1 or 2 — and never a slug: the chain behind a plan is the
 * host's, and the rank is enough for an A/B that knows the plan. The failed call's
 * tokens go to the ledger through the client's own failure path — our cost,
 * correctly recorded — and never into the `Usage` the step returns. `status`,
 * `stopReason` and the cache verdict are untouched.
 *
 * The operator, by contrast, gets a line per demotion and per recovery through
 * {@link HarnessPortOptions.onFailover}, because failover share is the number
 * that decides whether the published price holds.
 */

import {
  ExtractionFailedError,
  addDecimal,
  isRecord,
  type AgentCaps,
  type Clock,
  systemClock,
  type JsonSchema,
  type Usage,
} from '@outcrawl/scout-core';
import { ACTIONABLE_ROLES, actionNamedAsTool, validateAction } from '@outcrawl/runtime';
import type {
  Action,
  AgentPrompt,
  AxNode,
  AxTree,
  CapState,
  ExtractInput,
  ExtractOutcome,
  ModelChoice,
  ModelPort,
  StepBrief,
  StepTrace,
} from '@outcrawl/runtime';

import {
  BRAIN_SCHEMA,
  BRAIN_SYSTEM_PROMPT,
  BrainThread,
  briefElements,
  briefFacts,
  EYES_INSTRUCTION,
  EYES_SCHEMA,
  EYES_SYSTEM_PROMPT,
  HANDS_CANNOT,
  decisionLine,
  directAction,
  envelopeOf,
  eyesPage,
  handsGuidance,
  isPageText,
  rawBrief,
  readBrief,
  selectBrief,
  readDecision,
  actionKey,
  alternativesFor,
  refIndex,
  onThisPageNow,
  repeatedActions,
  retryableNavigations,
  redirectedSite,
  searchedBefore,
  reconciledNavigate,
  rankedReadGap,
  wrongListItem,
  unconfirmedSlot,
  alreadyRead,
  factsBesideReads,
  unreadResults,
  comboboxMiss,
  readWithConditions,
  wholeRead,
  listingVerdicts,
  reloadAsNavigate,
  threadReply,
  repeatedPlaces,
  type Brief,
  type BrainDecision,
  type BrainNotes,
  type QueuedStep,
} from './brain';
import {
  ModelClient,
  extractPromptText,
  type ExtractResult,
  type ModelCallOptions,
  type ModelClientOptions,
  type SessionAttribution,
} from './client';
import { CostLedger } from './ledger';
import type { RateCard } from './rates';
import {
  ModelConfigError,
  ModelProviderError,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  type ModelProvider,
  type ReasoningConfig,
} from './provider';

/* ------------------------------------------------------------------ *
 * The plan the host injects
 * ------------------------------------------------------------------ */

/** The environment, injected, so a reader is testable without mutating the real one. */
export type EnvLookup = Readonly<Record<string, string | undefined>>;

/**
 * The events a planner may be consulted on. See {@link PlanTriggers}:
 * `start` the run's first step, `trouble` a failed step, `stall` steps with no
 * progress, `done` a proposed finish to check.
 */
export type PlanTrigger = 'start' | 'trouble' | 'stall' | 'done';

/** Every trigger, for a plan that names none. */
export const PLAN_TRIGGERS: readonly PlanTrigger[] = Object.freeze(['start', 'trouble', 'stall', 'done']);

/**
 * One model a plan uses in one role, with everything the port needs to call
 * it. The host decides every value; this package has no model of its own.
 */
export interface PlanModel {
  /** The model id, exactly as the provider is sent it. */
  readonly model: string;
  /** Its place in the role's chain: 0 is asked first. */
  readonly rank: number;
  /**
   * The cost gate's expected calls per step for this model. For an actuator it
   * is 1. For a planner it is NOT a schedule: the port calls the planner on
   * events (see {@link PlanTriggers}), and this is the replay-measured rate of
   * those events that the host's cost gate prices.
   */
  readonly callsPerStep: number;
  /** A planner's triggers; absent means every one ({@link PLAN_TRIGGERS}). */
  readonly triggers?: readonly PlanTrigger[];
  /** A brain's reasoning effort. Absent sends no reasoning field. */
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * How long an ACTION call to this model may take before the chain stops
   * waiting, for a model whose tail has been measured. Absent is the client's
   * own ceiling. A host `timeoutMs` below it still wins: it is the run's.
   */
  readonly actionDeadlineMs?: number;
  /**
   * While the hedge is on ({@link HarnessPortOptions.hedgeMs}), how long a
   * rank-0 EXTRACTION on this model may go unanswered before the same model is
   * asked again beside it. Absent is never.
   */
  readonly extractHedgeMs?: number;
  /**
   * Whether this model's action reply asks for the `reasoning` field. `false`
   * for a model whose provider refuses a reply schema that asks for its
   * reasoning (see `AGENT_REPLY_SCHEMA_WITHOUT_REASONING` in `./client`).
   */
  readonly replyReasoning: boolean;
  /** Upstreams this model's calls try first, for a gateway that routes (`ModelRequest.providerOrder`). */
  readonly providerOrder?: readonly string[];
}

/**
 * Which models run an agent, by role, injected by the host.
 *
 * `actuators` — the hands: the model that reads the page and acts — is never
 * empty and is in ascending rank order: rank 0 is asked first and each next
 * rank is the failover. `planner` is absent for a plan that has none. `brain`,
 * when present, decides every step and the actuators are its eyes and hands;
 * see `./brain`.
 */
export interface ModelPlan {
  readonly actuators: readonly PlanModel[];
  readonly planner?: PlanModel;
  readonly brain?: PlanModel;
}

/* ------------------------------------------------------------------ *
 * The failover decision
 * ------------------------------------------------------------------ */

/**
 * Statuses that mean "ask a different model", beyond the retryable set.
 *
 * A 400 is the gateway's answer for an unknown model id and a 404 is a model that
 * has been withdrawn. Both are permanent for the slug and irrelevant to the next
 * one, which is the opposite of what `retryable` means and exactly what a chain
 * is for.
 */
const DEAD_MODEL_STATUSES: Readonly<Record<number, true>> = { 400: true, 404: true };

/**
 * Stop reasons that mean the model NEVER ANSWERED, as opposed to answering
 * something we cannot use.
 *
 * A truncation is not a refusal, and collapsing them was a real defect rather
 * than a hypothetical: `finish_reason: 'length'` on a reasoning model returns an
 * EMPTY content string, which is the model having spent its whole ceiling
 * thinking and emitted nothing. Treating that as a verdict meant a measured
 * three-task pilot recorded twelve failed calls and ZERO failovers — ranks 1
 * and 2 were never asked, on a run that could not take a single step.
 *
 * So these demote and a `refusal` does not. The distinction is whether there is
 * an answer to respect: a refusal is the model's judgement about a page it could
 * see and `AgentStopReason.gave-up` carries it; a truncation is our ceiling
 * being too low for that model's reasoning ratio, and another model has a
 * different ratio.
 *
 * The ceiling is still the real fix — see `HARNESS_ACTION_TOKENS`, which is set
 * above the measured floor precisely so this arm stays cold. This is the
 * backstop for the NEXT model whose floor nobody has measured, and a backstop
 * that costs one extra billed call beats a run that cannot start.
 */
const UNANSWERED_STOP_REASONS: Readonly<Record<string, true>> = {
  length: true,
  max_tokens: true,
};

/**
 * Whether another rank could plausibly answer where this one did not.
 *
 * The full reasoning is in the module comment. In short: yes for a timeout, a
 * 429, a 5xx, a dead-model 4xx and a reply truncated before it said anything;
 * no for a credential or quota failure, which every rank shares, and no for an
 * answer we were billed for and can read.
 */
export function shouldFailOver(thrown: unknown): boolean {
  if (thrown instanceof ModelTimeoutError) {
    return true;
  }
  if (thrown instanceof ModelUnusableError) {
    return UNANSWERED_STOP_REASONS[thrown.stopReason] === true;
  }
  if (thrown instanceof ModelProviderError) {
    // `upstreamStatus`, not `status`: an upstream 502 the gateway reports inline
    // on an HTTP 200 is the same dead upstream as a bare 502, and keying this on
    // the wire status left the chain unable to demote on it — 17 of 423
    // finished acct_bench runs ended on it after 12Z on 2026-09-24.
    // `ModelClient` has already resent it once to this rank by the time it
    // arrives here, so this is "resend first, fail over after".
    const status = thrown.upstreamStatus;
    return status === 429 || status >= 500 || DEAD_MODEL_STATUSES[status] === true;
  }
  // Everything else — a schema failure, a config error, a bug — is either billed
  // and readable or ours. Neither is fixed by paying a second model.
  return false;
}

/** Why the live rank changed, for the operator line. One of a closed set. */
export type FailoverTrigger =
  | 'timeout'
  | 'rate-limit'
  | 'provider-fault'
  | 'model-unavailable'
  | 'truncated-reply'
  /** Not a failure: the cooldown ran out and the chain went back to rank 0. */
  | 'cooldown-elapsed';

/** How long a demotion holds before rank 0 is asked again. */
export const FAILOVER_COOLDOWN_MS = 60_000;

/**
 * The ceiling the cooldown doubles to while rank 0 keeps failing its probes:
 * 60 s, 120 s, 240 s, 480 s. At most one wasted primary call per window, so an
 * upstream that stays down costs a run one call every eight minutes.
 */
export const FAILOVER_COOLDOWN_CAP_MS = 480_000;

/**
 * How long a demotion holds after a LONE STALL — one timed-out call by rank 0
 * whose previous call did not time out, with no outage being probed: zero. The
 * next rank answers the stalled call, and the next call asks rank 0 again.
 *
 * MEASURED, same window as the measurement behind {@link PlanModel.actionDeadlineMs}: of the 23 timeouts, 20
 * fell while rank 0 was answering OTHER sessions' calls normally inside the
 * stall's own 60 s window or the 60 s after it (the other 3 had no other traffic
 * to compare against) — a stalled request, not a down model. Holding the
 * demotion for {@link FAILOVER_COOLDOWN_MS} anyway moved every step of the next
 * minute onto rank 1, which cost 13.7x rank 0 per input token (median
 * provider USD per million input tokens per step, 0.6075 over n=395 rank-1
 * steps against 0.0444 over n=10,658 rank-0 steps). On `run_9b6afae6` that was
 * the larger part of the bill: its step 1 on rank 1 cost $0.00757 (4.02
 * credits on a 3.00 budget) for 14,371 input tokens, which rank 0's median rate
 * prices at about $0.0006.
 *
 * Every other demotion — a rate limit, a 5xx, a truncation, a second stall in
 * a row, a failed probe — still holds for the cooldown: those are what an
 * outage looks like, and the cooldown exists for them.
 */
export const LONE_STALL_HOLD_MS = 0;

/**
 * The variable that turns the hedge on: milliseconds a rank-0 action call may
 * go unanswered before the same slug is asked again beside it (extractions
 * hedge at their {@link PlanModel.extractHedgeMs} while this is on). Unset, empty or `0` is
 * off, which is the default. See {@link HarnessPortOptions.hedgeMs}.
 */
export const MODEL_HEDGE_ENV = 'OUTCRAWL_MODEL_HEDGE_MS';

/**
 * The largest {@link MODEL_HEDGE_ENV} accepted: the client's general call
 * ceiling. A primary still unanswered at 60 s has already timed out, so a
 * larger threshold could never fire — and `setTimeout` clamps a delay of 2^31
 * ms or more to 1 ms (measured in Bun 1.4.0, HedgeReview 2026-09-28), which
 * would turn an operator's "effectively off" into a hedge on every call.
 */
const MAX_HEDGE_MS = 60_000;

/**
 * {@link MODEL_HEDGE_ENV}, read: `undefined` when off, a positive integer of
 * milliseconds up to {@link MAX_HEDGE_MS} when on. Anything else is refused
 * rather than guessed at — a typo must not quietly run an A/B arm that is not
 * the one the operator named.
 */
export function modelHedgeMsFrom(env: EnvLookup): number | undefined {
  const raw = (env[MODEL_HEDGE_ENV] ?? '').trim();
  if (raw === '' || raw === '0') {
    return undefined;
  }
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_HEDGE_MS) {
    throw new ModelConfigError(
      `${MODEL_HEDGE_ENV} must be a whole number of milliseconds from 1 to ${String(MAX_HEDGE_MS)} ` +
        `(or unset, or 0, for off), got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

function triggerOf(thrown: unknown): FailoverTrigger {
  if (thrown instanceof ModelTimeoutError) {
    return 'timeout';
  }
  if (thrown instanceof ModelProviderError) {
    if (thrown.upstreamStatus === 429) {
      return 'rate-limit';
    }
    return thrown.upstreamStatus >= 500 ? 'provider-fault' : 'model-unavailable';
  }
  if (thrown instanceof ModelUnusableError) {
    return 'truncated-reply';
  }
  return 'provider-fault';
}

/** One demotion, as the host's logger receives it. Slugs; operator-only. */
export interface FailoverEvent {
  readonly from: string;
  readonly to: string;
  readonly trigger: FailoverTrigger;
  /** The agent step the demotion happened on, or `-1` for a non-step call. */
  readonly step: number;
  readonly message: string;
  /**
   * On a demotion, how long the chain stays off rank 0 before asking it again:
   * 0 for a lone stall ({@link LONE_STALL_HOLD_MS}), the cooldown otherwise.
   * Absent on a recovery (`cooldown-elapsed`).
   */
  readonly holdMs?: number;
}

/* ------------------------------------------------------------------ *
 * The planner's window on the run
 * ------------------------------------------------------------------ */

/**
 * Everything the planner is allowed to see.
 *
 * THIS TYPE IS THE ECONOMIC ARGUMENT, EXPRESSED SO IT CANNOT BE FORGOTTEN.
 *
 * Cost is input, and input is the snapshot: a measured 529,164 input tokens per
 * minute on a real content-heavy production run, which is the accessibility tree
 * re-sent every step. A frontier reasoner on that burn costs roughly $1.10 a
 * minute against a published per-minute price worth roughly $0.016 — 69x. So the
 * pair is only viable while the reasoner never sees a tree, and at 69x an
 * advisory boundary is not a boundary.
 *
 * Hence a distinct type with no tree in it, built by {@link planDigestFrom},
 * whose parameter is a `Pick` of `AgentPrompt` that does not include `text` or
 * `tree`. The planner's call site takes this and has no `AxTree` in scope, so
 * there is nothing to interpolate by accident. `ModelPort.choose` — the seam
 * that does carry the rendered tree — stays the actuator's alone.
 *
 * `actionableNodes` is a COUNT for the same reason: the planner needs to know
 * whether the page offers anything to act on, and a number answers that in one
 * token where a list would answer it in thousands.
 */
export interface PlanDigest {
  readonly task: string;
  readonly step: number;
  /** Where the page is. A url and a title, never its content. */
  readonly location: readonly { readonly url: string; readonly title?: string }[];
  /** How many nodes the actuator could act on. A count, never the nodes. */
  readonly actionableNodes: number;
  readonly goals: readonly { readonly goal: string; readonly status: string }[];
  readonly findings: readonly string[];
  readonly ruledOut: readonly string[];
  /** The recent past, reduced to what was tried and whether it worked. */
  readonly recent: readonly {
    readonly step: number;
    readonly action: string;
    readonly failed: boolean;
  }[];
  readonly caps?: { readonly limits: AgentCaps; readonly used: CapState };
  readonly notice?: string;
}

/**
 * The fields of an `AgentPrompt` the planner may be built from.
 *
 * Named as a type rather than inlined because it is a contract: `text` and
 * `tree` are absent from it, and that absence is what makes the boundary
 * structural. Adding either here would defeat the entire pairing, so it is
 * written down where a reviewer will see it.
 */
export type PlanView = Pick<
  AgentPrompt,
  'task' | 'step' | 'history' | 'memory' | 'tabs' | 'caps' | 'notice'
>;

/** How many past steps the planner is shown. Enough to see a loop, not a run. */
const PLAN_HISTORY_STEPS = 8;

/**
 * The digest, from the parts of a prompt that carry no page content.
 *
 * `history` is reduced to `{step, action, failed}` — the action's type and its
 * arguments are the run's own words, not the page's, and `StepTrace` carries a
 * `snapshotHash` rather than a tree, which was checked rather than assumed. The
 * last {@link PLAN_HISTORY_STEPS} only: a planner that re-reads forty steps every
 * call pays for the whole run again on each one, and a loop is visible in eight.
 */
export function planDigestFrom(view: PlanView, actionableNodes: number): PlanDigest {
  const history = view.history.slice(-PLAN_HISTORY_STEPS);
  return {
    task: view.task,
    step: view.step,
    location: (view.tabs ?? []).map((tab) => ({
      url: tab.url,
      ...(tab.title === undefined ? {} : { title: tab.title }),
    })),
    actionableNodes,
    goals: (view.memory?.goals ?? []).map((goal) => ({ goal: goal.goal, status: goal.status })),
    findings: (view.memory?.findings ?? []).map((finding) => finding.text),
    ruledOut: (view.memory?.ruledOut ?? []).map((entry) => entry.text),
    recent: history.map((trace) => ({
      step: trace.index,
      action: trace.action.type,
      failed: trace.error !== undefined,
    })),
    ...(view.caps === undefined ? {} : { caps: view.caps }),
    ...(view.notice === undefined ? {} : { notice: view.notice }),
  };
}

/**
 * What the planner is asked to produce. Short on purpose: output is 12x input.
 *
 * Exported for the same reason `AGENT_SYSTEM_PROMPT` is: a measurement that
 * retypes the contract measures the retype.
 */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    strategy: { type: 'string' },
    next: { type: 'array', items: { type: 'string' } },
    avoid: { type: 'array', items: { type: 'string' } },
  },
  required: ['strategy', 'next'],
  additionalProperties: false,
} as const;

/** Exported for measurement. See {@link PLAN_SCHEMA}. */
export const PLAN_INSTRUCTION = [
  'You are the planner for a browser agent. You are NOT looking at the page: you see the task,',
  'where the run is, what it has learned, and what it has already tried. Another model does the',
  'clicking and it does see the page.',
  'Decide the strategy for the next few steps. `strategy` is one or two sentences of direction.',
  '`next` is the ordered sub-goals to pursue now. `avoid` is anything already ruled out or looping.',
  'Be brief: every word here is re-read by the model that acts.',
].join(' ');

/** The planner's answer, as the actuator's prompt will carry it. */
interface PlanGuidance {
  readonly strategy: string;
  readonly next: readonly string[];
  readonly avoid: readonly string[];
  /** The step it was produced on, so staleness is visible in the prompt. */
  readonly atStep: number;
}

/**
 * The planner's answer as prompt text for the actuator.
 *
 * Prepended rather than merged into `AgentMemory`, because memory is the loop's
 * and is written from the actuator's own reply envelope. A port that reached into
 * it would be a second writer of one field, and the two would disagree on the
 * step where both wrote.
 */
function renderGuidance(plan: PlanGuidance): string {
  const lines = [`## Plan (revised at step ${String(plan.atStep)})`, plan.strategy];
  if (plan.next.length > 0) {
    lines.push('Next:', ...plan.next.map((goal) => `- ${goal}`));
  }
  if (plan.avoid.length > 0) {
    lines.push('Avoid:', ...plan.avoid.map((entry) => `- ${entry}`));
  }
  return `${lines.join('\n')}\n\n`;
}

function readGuidance(data: unknown, atStep: number): PlanGuidance | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const strategy = record['strategy'];
  if (typeof strategy !== 'string' || strategy.trim() === '') {
    return undefined;
  }
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    strategy,
    next: strings(record['next']),
    avoid: strings(record['avoid']),
    atStep,
  };
}

/* ------------------------------------------------------------------ *
 * When the planner is worth asking
 * ------------------------------------------------------------------ */

/**
 * Consecutive steps with no progress before the planner is consulted.
 *
 * MEASURED, not chosen: over 698 finished production runs (scout-1, voyager-1
 * and unlabelled, 2026-09-10..24), with progress defined exactly as
 * {@link PlanTriggers} defines it, the longest no-progress streak separates
 * runs that did not complete from runs that did best at 2 — P(streak >= 2) is
 * 0.345 for runs that did not complete against 0.117 for runs that did, a
 * Youden J of 0.228, against 0.071 at 1 and 0.186 at 3.
 */
export const STALL_STEPS = 2;

/**
 * How many characters of a proposed `done` summary the completion check sees.
 *
 * The summary is the actuator's words and may quote the page, which is what
 * the digest otherwise never carries; bounded so a completion check cannot
 * cost like a tree.
 */
const COMPLETION_SUMMARY_CHARS = 2_000;

/**
 * Failures of the ACTUATOR'S OWN CALL, not of the strategy.
 *
 * The message prefixes of every `ModelError` subclass in `./provider`
 * (timeout, provider refusal, unusable answer, schema violation). A strategy
 * change cannot fix the provider returning 502 or the model emitting a bad
 * ref, so a failed step carrying one of these is not a reason to re-plan. The
 * loop records these errors as step errors verbatim, which is why a prefix is
 * enough, and they are this package's own strings.
 */
const MODEL_CALL_FAILURE_PREFIXES = ['the model ', 'model provider refused'] as const;


/**
 * The planner's triggers, as a fold over what the port is shown each step.
 *
 * THE PLANNER IS CALLED WHEN THE RUN HOLDS SOMETHING IT HAS NOT SEEN THAT
 * BEARS ON STRATEGY, and never on a clock. It replaced `step % 5 === 0`, which
 * a replay of 719 production runs (6,245 steps, 2026-09-10..24) found firing
 * with no trigger condition present on 609 of its 1,544 calls (39.4%).
 *
 * - `start`: the first call a port sees. There is no strategy yet.
 * - `trouble`: a step since the last plan failed for a reason other than the
 *   actuator's own call ({@link MODEL_CALL_FAILURE_PREFIXES}), a verified action was
 *   contradicted by the page, or a new ruled-out entry appeared.
 * - `stall`: {@link STALL_STEPS} consecutive steps without progress. Progress
 *   is a page state this run has not seen before, a new finding, a sub-goal
 *   changing status, or a successful `extract`. A revisited page is not
 *   progress, which is what makes a loop a stall.
 * - `done`: the completion check, below.
 *
 * A slot fires only on the triggers it names ({@link PlanModel.triggers},
 * default all four), so a lab arm can A/B which ones earn their cost. The
 * bookkeeping runs either way; the one interaction is that a disabled trigger
 * never marks an episode answered, so each subset's rate is replayed on its own.
 *
 * EACH EPISODE IS ANSWERED ONCE. After a `trouble` or `stall` plan, further
 * trouble does not re-plan until the run makes progress: the planner has seen
 * the failure, and a digest that differs only by one more failed step buys
 * nothing. A stall that survives its plan re-fires at doubling intervals
 * (2, 4, 8 ... steps) — a cost bound, not a measured benefit: with constant
 * re-firing the replay spent 657 stall calls, with doubling 397.
 *
 * WHAT IT COSTS, from the same replay: 0.353 planner calls per step pooled
 * against the timer's 0.247 (median 2 calls a run against 1, p90 6 against 4),
 * and the difference is almost all in short runs — a run of 1-4 steps pays a
 * start plan and a completion check, 0.609 calls per step against 0.365, while
 * runs of 20+ steps pay 0.213 against 0.208. The completion check's re-asked
 * actuator call on a veto is not in these figures: no production run had a
 * planner judging `done`, so the veto rate is unmeasured.
 *
 * The completion check before `done` is gated the same way: once per
 * progress episode, so a `done` the loop itself refuses, re-proposed on an
 * unchanged page, is not judged twice.
 *
 * Idempotent per step: the loop may ask the model more than once for one step
 * (a re-observe after the page moved), and only the first ask of a step folds.
 */
class PlanTriggers {
  /** Which triggers this slot fires on. See {@link PlanModel.triggers}. */
  readonly #on: Readonly<Record<PlanTrigger, boolean>>;
  #observedStep = -1;
  /** A trouble or stall plan was made and the run has not progressed since. */
  #answered = false;
  #doneChecked = false;
  #stall = 0;
  #nextStall = STALL_STEPS;
  readonly #seen = new Set<string>();
  #lastFinding = -1;
  #lastRuledOut = -1;
  #goals: string | undefined;
  /** History entries at or past this index have not been folded yet. */
  #historyFrom = 0;

  constructor(triggers: readonly PlanTrigger[]) {
    this.#on = {
      start: triggers.includes('start'),
      trouble: triggers.includes('trouble'),
      stall: triggers.includes('stall'),
      done: triggers.includes('done'),
    };
  }

  /** Fold this step's prompt in and say why to plan, if at all. */
  observe(prompt: AgentPrompt): readonly PlanTrigger[] {
    if (prompt.step <= this.#observedStep) {
      return [];
    }
    const first = this.#observedStep < 0;
    this.#observedStep = prompt.step;

    const fresh = prompt.history.filter((trace) => trace.index >= this.#historyFrom);
    const last = prompt.history.at(-1);
    if (last !== undefined) {
      this.#historyFrom = last.index + 1;
    }
    if (first) {
      // A resumed run arrives with history. Its pages are not new to it.
      for (const trace of prompt.history) {
        this.#seen.add(trace.snapshotHash);
      }
    }

    const memory = prompt.memory;
    const newestFinding = Math.max(-1, ...(memory?.findings ?? []).map((entry) => entry.step));
    const newestRuledOut = Math.max(-1, ...(memory?.ruledOut ?? []).map((entry) => entry.step));
    const goals = (memory?.goals ?? []).map((goal) => `${goal.id}:${goal.status}`).join('|');

    let trouble = false;
    if (!first) {
      const failed = fresh.some(
        (trace) =>
          (trace.error !== undefined &&
            !MODEL_CALL_FAILURE_PREFIXES.some((prefix) => trace.error?.startsWith(prefix) === true)) ||
          trace.check?.verdict === 'contradicted',
      );
      // Read BEFORE progress clears `#answered`: a failure inside an episode
      // the planner already answered is not news, even if the page then moves.
      trouble = (failed || newestRuledOut > this.#lastRuledOut) && !this.#answered;
      const progressed =
        !this.#seen.has(prompt.snapshotHash) ||
        newestFinding > this.#lastFinding ||
        goals !== this.#goals ||
        (last !== undefined && last.action.type === 'extract' && last.error === undefined);
      if (progressed) {
        this.#answered = false;
        this.#doneChecked = false;
        this.#stall = 0;
        this.#nextStall = STALL_STEPS;
      } else {
        this.#stall += 1;
      }
    }
    this.#seen.add(prompt.snapshotHash);
    this.#lastFinding = newestFinding;
    this.#lastRuledOut = newestRuledOut;
    this.#goals = goals;

    const reasons: PlanTrigger[] = [];
    if (first && this.#on.start) {
      reasons.push('start');
    }
    if (trouble && this.#on.trouble) {
      reasons.push('trouble');
    }
    if (this.#stall >= this.#nextStall && this.#on.stall) {
      reasons.push('stall');
    }
    if (reasons.length > 0) {
      if (reasons.includes('stall')) {
        this.#nextStall = this.#stall * 2;
      }
      if (reasons.includes('trouble') || reasons.includes('stall')) {
        this.#answered = true;
      }
    }
    return reasons;
  }

  /** Whether a proposed `done` should be judged, consuming the check if so. */
  takeCompletionCheck(): boolean {
    if (!this.#on.done || this.#doneChecked) {
      return false;
    }
    this.#doneChecked = true;
    return true;
  }
}

/** What the completion check answers. Exported for measurement. */
export const COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: { type: 'string' },
    next: { type: 'array', items: { type: 'string' } },
  },
  required: ['complete'],
  additionalProperties: false,
} as const;

/** Exported for measurement. See {@link COMPLETION_SCHEMA}. */
export const COMPLETION_INSTRUCTION = [
  'You are the planner for a browser agent. You are NOT looking at the page. The agent that does',
  'see the page proposes to END THE RUN now, with the summary in `proposedDone`.',
  'Judge only against the task as stated and what the run has established (goals, findings,',
  'recent steps). `complete` is true when every part the task asks for is established or the',
  'summary credibly reports it. Otherwise `complete` is false, `missing` names in one sentence',
  'what is not yet done, and `next` is the ordered sub-goals to do it. Be brief.',
].join(' ');

function readCompletion(
  data: unknown,
): { readonly complete: boolean; readonly missing: string; readonly next: readonly string[] } | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record['complete'] !== 'boolean') {
    return undefined;
  }
  const missing = record['missing'];
  const next = record['next'];
  return {
    complete: record['complete'],
    missing: typeof missing === 'string' ? missing : '',
    next: Array.isArray(next) ? next.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

/**
 * The reply ceiling every harness client gets, and why it is not the library's.
 *
 * `ModelClient`'s own `DEFAULT_ACTION_TOKENS` is 1024, which was measured
 * against a model that answers in content. EVERY MODEL IN EVERY CHAIN HERE IS A
 * REASONING MODEL, and `max_tokens` covers reasoning tokens as well as content,
 * so 1024 is below the floor of the one that drives every run.
 *
 * Measured against the gateway on a page-shaped prompt (~1,700 prompt tokens, a
 * 120-node tree), the rank-0 hands model (its preview release):
 *
 *     max_tokens 1024 -> finish_reason 'length', 1018 completion, 1018 reasoning, content ''
 *     max_tokens 1024 -> finish_reason 'length', 1007 completion, 1007 reasoning, content ''
 *     max_tokens 4096 -> finish_reason 'stop',   1571 completion, 1529 reasoning, valid JSON
 *     max_tokens 4096 -> finish_reason 'stop',   1684 completion, 1645 reasoning, valid JSON
 *
 * It spends 1,529-1,645 reasoning tokens to emit roughly fifty tokens of JSON —
 * a 30:1 ratio — so at 1024 the reply is truncated to an EMPTY content string
 * and `parseAgentReply` raises `ModelUnusableError` on every single call. A
 * pilot of three real tasks scored 0/3 with twelve steps, twelve failed model
 * calls, zero actions and `about:blank` as the final url: the agent never
 * navigated once, and the whole run cost $0.0024 to learn nothing.
 *
 * THE CHAIN HIDES THIS RATHER THAN RESCUING IT, and this paragraph used to
 * claim the opposite. It said `shouldFailOver` "refuses to demote" on a
 * truncation; {@link UNANSWERED_STOP_REASONS} lists `length` and `max_tokens`,
 * so it demotes — deliberately, because a reasoning model truncated to an empty
 * content string never answered and another rank has a different reasoning
 * ratio. What follows from that is the reverse of what was written: a ceiling
 * too low for the work does not fail, it walks the whole chain spending a
 * billed call per rank and then reports the last rank's error.
 *
 * MEASURED on production 2026-09-12, on the extraction side of the same
 * mechanism: one Facebook Ad Library scrape for `acct_mit` truncated on
 * the rank-0 hands model, demoted, truncated on
 * the rank-1 hands model, demoted, truncated on
 * the rank-2 hands model, and answered `internal` after 74.6 s
 * (`inc_7bd10cc4-982c-473c-a0b1-f46c8ee2d2c2`). Three billed replies, no
 * answer, and the only trace of the cause was three `model.failover` lines with
 * `trigger: truncated-reply`. So the ceiling has to be correct HERE: the chain
 * makes a wrong one expensive and slow instead of visible.
 *
 * 4096 and not 2048: the observed maximum is 1,684 and a ceiling with only 20%
 * headroom over the worst observation is a ceiling that truncates on the first
 * page harder than anything measured. Output is billed per token ACTUALLY
 * emitted, not per token allowed, so headroom here costs nothing.
 */
const HARNESS_ACTION_TOKENS = 4096;

export interface HarnessPortOptions {
  readonly plan: ModelPlan;
  readonly provider: ModelProvider;
  /** The host's rate card, forwarded to every client. See `ModelClientOptions.rates`. */
  readonly rates?: RateCard;
  /**
   * The provider for one slot's slug, overriding {@link provider} where it
   * answers one. A lab run on a subscription (OC-286) passes
   * `subscriptionProviderFor(credential)` here, so its frontier slug goes to
   * the subscription while a `-plan` arm's rank-0 actuator stays on
   * {@link provider}. `undefined` for a slug means {@link provider}.
   */
  readonly providerFor?: (slug: string) => ModelProvider | undefined;
  /**
   * The provider the BRAIN's thread goes to, when the host routes it away
   * from {@link provider}: a lab run whose arm puts the brain on a flat-rate
   * subscription passes that subscription's thread-capable provider here.
   * Never {@link providerFor}, whose per-call providers refuse a thread.
   * Absent: {@link provider}.
   */
  readonly brainProvider?: ModelProvider;
  readonly session: SessionAttribution;
  readonly ledger: CostLedger;
  /** One line per demotion, to the host's logger. Slugs; operator-only. */
  readonly onFailover?: (event: FailoverEvent) => void;
  /**
   * One line per schema correction, to the host's logger.
   *
   * Forwarded for `onFailover`'s reason: this mechanism spends a real model
   * call, it is on with no configuration, and the fleet's only evidence that it
   * fires at all — or that it is firing on every step, which would be a broken
   * grammar rather than a recovery — is this line.
   */
  readonly onCorrection?: ModelClientOptions['onCorrection'];
  /**
   * One line per repaired reply and one per resent extraction, to the host's
   * logger.
   *
   * Forwarded for {@link onCorrection}'s reason, and the repair line has one of
   * its own: it is the only evidence that a reply arrived in a shape the
   * provider promised to enforce. A repair rate that climbs means the pool
   * behind this slug stopped honouring `response_format`; a rate of zero means
   * the repair is dead code somebody should delete.
   */
  readonly onRepair?: ModelClientOptions['onRepair'];
  readonly onResend?: ModelClientOptions['onResend'];
  /** One line per provider call, forwarded to every client. See `ModelCallEvent`. */
  readonly onCall?: ModelClientOptions['onCall'];
  /**
   * Every withdrawn call — a hedge's loser, the run's cancel — as HOUSE spend
   * at an estimate, forwarded to every client. See `ModelClientOptions.onWithdrawn`.
   */
  readonly onWithdrawn?: ModelClientOptions['onWithdrawn'];
  /** Forwarded to every client this port mints: the resend backoff sleeps on it. */
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  /**
   * How hard an ACTUATOR may think, forwarded to every client this port mints.
   *
   * This seam did not exist until 2026-09-08 and its absence was a live cost:
   * `ModelClient.actionReasoning` was declared and documented, nothing could
   * reach it through a harness, so every production actuator call took the
   * PROVIDER'S default. That default is not ours to rely on — it was off on
   * the rank-0 hands model's preview release and on for the GA release
   * that replaced it, and the change arrived with no notice and no error.
   *
   * Safe for the planner despite the shared `client()` factory below: this
   * governs the ACTION call, and a planner reasons through `extract`, which
   * reads {@link ModelClientOptions.extractReasoning} instead.
   */
  readonly actionReasoning?: ReasoningConfig;
  /**
   * Overrides {@link HARNESS_ACTION_TOKENS}.
   *
   * Present because this port constructs its own clients, so without it a
   * caller who discovers a model whose reasoning floor is higher again has no
   * way to raise the ceiling from outside — which is the state a measured
   * 0/3 pilot found, and it is not a state a host should be able to be in.
   */
  readonly maxActionTokens?: number;
  /**
   * How hard the BRAIN may think on its decision, overriding the plan's
   * own `brain.effort`. For measurement; the worker passes nothing and the
   * plan decides.
   */
  readonly brainReasoning?: ReasoningConfig;
  /**
   * Brain mode: how the page brief is made (owner lever 2).
   * - `'raw-or-select'` (default): a page that fits `RAW_VIEW` goes as is; a
   *   bigger one is chosen by rule (`selectBrief`), so the eyes never run.
   *   BrainMeasure 52×3, 2026-10-02 21:54-21:58Z: 148/148 of 156, $0.00362/step,
   *   p50 2.38 s, against raw-or-eyes 148/147, $0.00384, p50 3.43 s.
   * - `'raw-or-eyes'`: the same, but a bigger page goes to the eyes.
   * - `'eyes'`: always the eyes, for measuring that path on its own.
   */
  readonly brainView?: 'raw-or-eyes' | 'raw-or-select' | 'eyes';
  /**
   * THE HEDGE: when rank 0 has not answered an action call this many
   * milliseconds in, the SAME slug is asked the same question again beside it,
   * the first valid answer is the step's, and the other call is withdrawn
   * (`AbortController`) so it stops costing. While this is on, a rank-0
   * extraction is hedged the same way at its model's
   * {@link PlanModel.extractHedgeMs}. Absent is off, which is the default: {@link MODEL_HEDGE_ENV} sets it.
   *
   * THE SAME SLUG, NOT RANK 1 (OC-240). Until 2026-10-01 the second ask went to
   * rank 1, the rank-1 hands model, and the hedge was the run's single
   * most expensive habit: both Macs' `model.call` lines 2026-09-28T06:15Z to
   * 09-30T23:29Z, 225 hedge arms on 6,746 rank-0 action calls (3.3%) were
   * $1.0022 of $4.1169 model spend (24.3%); a winning arm cost a median 15.9x
   * the same session's previous rank-0 call (n=197, p90 21.6x). On
   * `run_d26506d1` (Scale, budget 3.00) one hedged step cost 2.55 credits of a
   * two-step task that capped at 2.999999 where three runs of the same task
   * cost 0.58-0.99. And a stall is a stalled REQUEST, not a slow model: of the
   * 74 hedges for which another session sent the rank-0 model an action call within 2 s
   * of the hedge starting, that call answered inside 10 s in 72. So the second
   * ask goes to the slug that is answering everyone else, at its price, and a
   * hedged call costs the run at most two calls of the primary.
   *
   * THE HEDGE ONLY EVER MAKES A SLOW CALL FASTER; IT NEVER DECIDES A FAILURE.
   * Whichever arm answers validly first is the call's answer and nothing is
   * demoted — the primary's own slug answered. A hedge that fails first is
   * forgotten and the primary decides, as if there had been none. A primary
   * that fails while the hedge is still asking (its deadline, a 5xx, a
   * credential) withdraws the hedge and fails exactly as an unhedged call
   * does: demoted on what {@link shouldFailOver} demotes on, thrown otherwise.
   * So a call that stalls on both arms gives up at the primary's own deadline
   * ({@link PlanModel.actionDeadlineMs}) and goes down the chain as today.
   *
   * ONLY FROM RANK 0. The thresholds are sized to the primary's measured tail;
   * a demoted chain's tail is not measured. A planner call is swallowed on
   * failure anyway, and is never hedged.
   *
   * BILLING IS THE EXISTING RULE, NOT A NEW ONE. Every call is on the ledger at
   * what the provider stated for it, whichever arm won: a loser that answered
   * before it could be withdrawn is billed like any answered call; a loser
   * withdrawn before it answered is recorded `cancelled` at `'0'`, so the run
   * is never charged for it. The run is charged from that ledger through
   * `CapLedger`, whose budget clamp does not know or care that two calls ran
   * at once. MEASURED 2026-09-28: the gateway DOES bill a withdrawn call whose
   * generation then completes upstream (3 of 3 rank-0 calls aborted at ~900
   * ms carry a `total_cost`; 4 of 4 aborted at ~400 ms have no generation
   * record), so a withdrawn loser is house spend, and is reported as such
   * through {@link onWithdrawn} at an estimate.
   *
   * THE PRODUCTION VALUE IS 10000, the healthy p99. Rank-0 action calls that
   * answered, `run_records` 2026-09-21T04Z..09-28T04Z, n=12,004: p50 1.21 s,
   * p99 9.49 s, 0.80% slower than 10 s, so the hedge starts on under 1% of
   * healthy calls plus every stall. The tail it is for is measured by
   * `scripts/measure-action-latency.ts`.
   */
  readonly hedgeMs?: number;
  /**
   * THE RUN'S CANCEL, withdrawing whatever action or extract call is in flight
   * when the run's owner stops the run, so a cancelled run is not held open —
   * nor its model kept generating — for a reply nobody will read. Measured on
   * production 2026-09-21..28 (n=35 cancels): extract steps of 65 and 157 s
   * ran to completion after the owner had asked the run to stop.
   *
   * A withdrawn call is recorded `cancelled` at `'0'`, the hedge loser's rule
   * above, so it is never the customer's; it is reported through
   * {@link onWithdrawn} as house spend. Never a failover trigger: nobody is
   * waiting for another rank's answer either.
   */
  readonly signal?: AbortSignal;
}

/**
 * One harness, as the agent loop's `ModelPort`.
 *
 * Holds one `ModelClient` per slot over the caller's shared ledger, calls the
 * planner on the events {@link PlanTriggers} names, and demotes through the
 * actuator chain when a call fails in a way another model could survive.
 */
export class HarnessModelPort implements ModelPort {
  /**
   * The actuator chain. `eyes` is the same slug's brief-writing client, minted
   * only when the harness has a brain: it fails over with the chain.
   */
  readonly #actuators: readonly ActuatorSlot[];
  readonly #planner: { readonly slug: string; readonly client: ModelClient } | undefined;
  /** The brain and its thread for this run, when the harness has one. See `./brain`. */
  readonly #brain: BrainSlot | undefined;
  readonly #triggers: PlanTriggers;
  readonly #onFailover: (event: FailoverEvent) => void;
  /**
   * The live rank. Forward on a failure, back to 0 once {@link #holdMs} has
   * passed since the primary last failed. See the module comment.
   */
  #rank = 0;
  /** `#clock.now()` when rank 0 last failed over. Meaningless while `#rank` is 0. */
  #demotedAt = 0;
  /** How long a demotion holds. Doubles on a failed recovery, resets on a good one. */
  #cooldownMs = FAILOVER_COOLDOWN_MS;
  /**
   * How long the CURRENT demotion holds: {@link #cooldownMs} when it began, or
   * 0 for a lone stall. Read by the recovery check only.
   */
  #holdMs = FAILOVER_COOLDOWN_MS;
  /** True from a recovery until rank 0 has answered or failed once. */
  #probing = false;
  /**
   * True from a lone stall of rank 0 until a call to rank 0 succeeds. While
   * set, a second failure is not lone: it holds the demotion for the cooldown
   * as any other does.
   */
  #stalled = false;
  readonly #clock: Clock;
  /** {@link HarnessPortOptions.hedgeMs}; `undefined` is off. */
  readonly #hedgeMs: number | undefined;
  /** {@link HarnessPortOptions.signal}. */
  readonly #signal: AbortSignal | undefined;
  /** {@link HarnessPortOptions.brainView}. */
  readonly #view: NonNullable<HarnessPortOptions['brainView']>;
  /** Steps the brain queued and has not seen run yet (owner lever 1). */
  #queue: QueuedStep[] | undefined;
  /** What the queued steps that ran were expected to do, for the brain's next decision. */
  #expected: string[] = [];
  /** The newest reads, whole, for the brain's thread. See `wholeRead`. */
  #fullReads: string[] = [];
  /**
   * THE QUALIFYING LISTINGS THE RUN'S READS FOUND, by name: what a list read
   * marked PASS against the task's filters, kept until a later read of the
   * same listing fails it, so a detour (a filter, another search, a page
   * change) cannot lose one. On production amazon-gaming-80k, 4 of 4 misses
   * had read the third qualifier as PASS in their first read, left the page,
   * and answered with two (c8e6444f, 2026-10-05).
   */
  readonly #qualifiers = new Map<string, { readonly text: string; readonly url: string }>();
  #qualifiersSeen = 0;
  #qualifiersShown = '';
  /** Navigates the check misjudged, corrected, by step index. See {@link HarnessModelPort.#reconcile}. */
  readonly #reconciled = new Map<number, StepTrace>();
  /** The facts block the thread last kept, so an unchanged page is not kept twice. */
  #lastFacts: string | undefined;
  /** This step's uncached tail (the tool replies whole, then the elements), sent with every brain call of the step. */
  #tail = '';
  /** Every tail the brain was shown this run: they ride outside the thread, so the untraced-name check keeps them. In memory only. */
  readonly #tails: string[] = [];
  /** The brief the brain decided this step on, for the step record (`ModelChoice.brief`); unset on a queued step. */
  #stepBrief: StepBrief | undefined;
  /** The trace's own refusals: they quote the untraced names, so they are not what the brain was shown. */
  readonly #untraced: string[] = [];
  /** Why the brain's last done was turned into a read, told to it next turn. */
  #held: string | undefined;
  /** True when the current brain step re-decided: its first decision's queue no longer applies. */
  #redecided = false;
  /** This step's repeated actions, by key. See `repeatedActions`. */
  #repeats: ReadonlyMap<string, { readonly text: string; readonly count: number; readonly failed: boolean }> = new Map();
  #plan: PlanGuidance | undefined;

  constructor(options: HarnessPortOptions) {
    const client = (slot: PlanModel, role?: Partial<ModelClientOptions>): ModelClient => {
      const measured = slot.actionDeadlineMs;
      return new ModelClient({
        provider: options.providerFor?.(slot.model) ?? options.provider,
        model: slot.model,
        extractModel: slot.model,
        replyReasoning: slot.replyReasoning,
        session: options.session,
        ledger: options.ledger,
        maxActionTokens: options.maxActionTokens ?? HARNESS_ACTION_TOKENS,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        // A host ceiling below the measured one still wins: it is the run's.
        ...(measured === undefined
          ? {}
          : { actionTimeoutMs: Math.min(measured, options.timeoutMs ?? measured) }),
        ...(options.actionReasoning === undefined
          ? {}
          : { actionReasoning: options.actionReasoning }),
        ...(options.onCorrection === undefined ? {} : { onCorrection: options.onCorrection }),
        ...(options.onRepair === undefined ? {} : { onRepair: options.onRepair }),
        ...(options.onResend === undefined ? {} : { onResend: options.onResend }),
        ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
        ...(options.onWithdrawn === undefined ? {} : { onWithdrawn: options.onWithdrawn }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.rates === undefined ? {} : { rates: options.rates }),
        ...role,
      });
    };

    const brain = options.plan.brain;
    // The plan's own effort unless the caller overrides it (a measurement).
    const brainReasoning: ReasoningConfig | undefined =
      options.brainReasoning ?? (brain?.effort === undefined ? undefined : { effort: brain.effort });
    this.#actuators = options.plan.actuators.map((slot) => ({
      slug: slot.model,
      ...(slot.extractHedgeMs === undefined ? {} : { extractHedgeMs: slot.extractHedgeMs }),
      client: client(slot),
      ...(brain === undefined
        ? {}
        : {
            // The eyes think as little as the actuator does: a brief is
            // reading, not deciding. Same provider, ledger and deadline.
            eyes: client(slot, {
              extractSystemPrompt: EYES_SYSTEM_PROMPT,
              maxExtractTokens: EYES_MAX_TOKENS,
              ...(options.actionReasoning === undefined ? {} : { extractReasoning: options.actionReasoning }),
            }),
          }),
    }));
    this.#brain =
      brain === undefined
        ? undefined
        : {
            slug: brain.model,
            ...(brain.providerOrder === undefined ? {} : { providerOrder: brain.providerOrder }),
            // Never the host's per-model provider (`providerFor`), whatever the
            // model: a flat-rate subscription provider refuses a multi-turn
            // thread. A host that routes the thread elsewhere says so.
            client: client(brain, {
              provider: options.brainProvider ?? options.provider,
              extractSystemPrompt: BRAIN_SYSTEM_PROMPT,
              maxExtractTokens: BRAIN_MAX_TOKENS,
              ...(brainReasoning === undefined ? {} : { extractReasoning: brainReasoning }),
            }),
            thread: new BrainThread((kept) => extractPromptText(brainInput(kept))),
          };
    const planner = options.plan.planner;
    // `callsPerStep` is deliberately not read here: for a planner it is the
    // cost gate's expected rate, and the schedule is the triggers.
    this.#planner = planner === undefined ? undefined : { slug: planner.model, client: client(planner) };
    this.#triggers = new PlanTriggers(planner?.triggers ?? PLAN_TRIGGERS);
    this.#onFailover = options.onFailover ?? (() => undefined);
    this.#clock = options.clock ?? systemClock;
    this.#hedgeMs = options.hedgeMs;
    this.#signal = options.signal;
    this.#view = options.brainView ?? 'raw-or-select';
  }

  /** Which slug is live. Operator diagnostics only; never serialized. */
  get activeModel(): string {
    return this.#actuators[Math.min(this.#rank, this.#actuators.length - 1)]?.slug ?? '';
  }

  /**
   * The agent step: plan when a trigger holds, act, and have the planner judge
   * a proposed `done` before it stands — demoting on the way if the live
   * actuator will not answer.
   *
   * Every call this step made is folded into the returned choice's `Usage`
   * (attribution; `OUTCRAWL_UNPRICED_KINDS` includes `tokens`). Its COST is in
   * the session's `CostLedger`, which is what the run is charged from. The
   * planner's SLUG is folded nowhere.
   *
   * THE COMPLETION CHECK CANNOT DEADLOCK A RUN. A veto re-asks the actuator
   * once, with the planner's reason in front of it; whatever it answers is the
   * step's answer, including `done` again — it sees the page and the planner
   * does not. The check is consumed until the run next makes progress.
   */
  readonly choose = async (prompt: AgentPrompt): Promise<ModelChoice> => {
    if (this.#brain !== undefined) {
      this.#stepBrief = undefined;
      const choice = await this.#brainStep(this.#brain, prompt);
      const brief = this.#stepBrief;
      // A reload chosen as a key press runs as the navigate it means (see
      // `reloadAsNavigate`): brain mode only, where the decision is ours.
      const reload = reloadAsNavigate(choice.action, prompt.tree.url);
      const chosen = reload === undefined ? choice : { ...choice, action: reload };
      return brief === undefined ? chosen : { ...chosen, brief };
    }
    const planner = this.#planner;
    const spent: { readonly usage?: Usage }[] = [];
    if (planner !== undefined && this.#triggers.observe(prompt).length > 0) {
      // Only a digest crosses into the planner. `prompt.text` and `prompt.tree`
      // are in scope here and are deliberately not passed: `planDigestFrom`
      // cannot accept them, and `#askPlanner` takes nothing else.
      const answer = await this.#askPlanner(
        planner.client,
        PLAN_INSTRUCTION,
        PLAN_SCHEMA,
        planDigestFrom(prompt, countActionable(prompt)),
      );
      if (answer !== undefined) {
        spent.push(answer);
        this.#plan = readGuidance(answer.data, prompt.step) ?? this.#plan;
      }
    }

    const choice = await this.#act(prompt, '');
    if (planner === undefined || choice.action.type !== 'done' || !this.#triggers.takeCompletionCheck()) {
      return foldSpend(choice, spent);
    }

    const summary = choice.action.summary ?? '';
    const answer = await this.#askPlanner(planner.client, COMPLETION_INSTRUCTION, COMPLETION_SCHEMA, {
      ...planDigestFrom(prompt, countActionable(prompt)),
      proposedDone: { summary: summary.slice(0, COMPLETION_SUMMARY_CHARS) },
    });
    const verdict = answer === undefined ? undefined : readCompletion(answer.data);
    if (answer !== undefined) {
      spent.push(answer);
    }
    if (verdict === undefined || verdict.complete) {
      return foldSpend(choice, spent);
    }

    this.#plan = {
      strategy: `Not finished yet: ${verdict.missing === '' ? 'the task is not fully done' : verdict.missing}`,
      next: verdict.next,
      avoid: this.#plan?.avoid ?? [],
      atStep: prompt.step,
    };
    spent.push(choice);
    const reconsidered = await this.#act(
      prompt,
      '## Completion check\nYou proposed `done`. The planner, who cannot see the page, judged the task NOT ' +
        'complete (see the plan above). Do what is missing. If the page in front of you shows it IS ' +
        'complete, answer `done` again and say in the summary where that is shown.\n\n',
    );
    return foldSpend(reconsidered, spent);
  };

  /** One actuator call, with the plan and an optional note in front of the page. */
  async #act(prompt: AgentPrompt, note: string): Promise<ModelChoice> {
    const head = `${this.#plan === undefined ? '' : renderGuidance(this.#plan)}${note}`;
    const guided = head === '' ? prompt : { ...prompt, text: `${head}${prompt.text}` };
    const choice = await this.#withFailover((slot, call) => slot.client.choose(guided, call), prompt.step, 'action');
    // The rank that answered, onto the step record: `#withFailover` moves
    // `#rank` only when a rank fails, so it names the one that just succeeded.
    return { ...choice, modelRank: this.#rank };
  }

  /**
   * BRAIN MODE: eyes, brain, then hands only when the decision needs
   * grounding. See `./brain` for the contract and why every failure here
   * falls back to the plain actuator step.
   *
   * THE RUN ENDS ONLY ON THE BRAIN'S WORD. A `done`/`fail` or a final extract
   * reaches the loop only when the brain decided it; the hands proposing one
   * sends the brain the proposal to decide on (once per step), and a hands
   * extract is never final. The one exception is a brain that gave no usable
   * decision at all: that step is plain scout-1, terminal actions included, so
   * a brain outage cannot hold a run open forever.
   *
   * Every call — eyes, brain, hands, re-decide — is on the session's ledger at
   * the provider's price, and its tokens are folded into the step's usage.
   */
  async #brainStep(brain: BrainSlot, raw: AgentPrompt): Promise<ModelChoice> {
    const prompt = this.#reconcile(raw);
    // Every step's tool replies, queued steps included: the prompt carries only
    // the newest three, and a queued run of reads would otherwise reach the
    // brain as its last three at most (see `BrainThread.observe`).
    brain.thread.observe(prompt);
    // A dropdown that took another option than the one typed stops the queue
    // and is the brain's to see, never silently accepted.
    const missed = comboboxMiss(prompt);
    if (missed !== undefined) {
      this.#queue = undefined;
      this.#expected.push(missed);
    }
    const queued = await this.#runQueued(prompt);
    if (queued !== undefined) {
      return queued;
    }
    this.#redecided = false;
    const spent: { readonly usage?: Usage }[] = [];
    // A page small enough to send as is needs no eyes call (owner lever 2).
    let brief: Brief | undefined =
      this.#view === 'eyes'
        ? undefined
        : (rawBrief(prompt.tree) ?? (this.#view === 'raw-or-select' ? selectBrief(prompt.tree, prompt.task, prompt.today) : undefined));
    let briefFailure: string | undefined;
    if (brief === undefined) {
      try {
        const seen = await this.#withFailover(
          (slot, call) =>
            (slot.eyes ?? slot.client).extract(
              { instruction: EYES_INSTRUCTION, schema: EYES_SCHEMA, content: { kind: 'markdown', markdown: eyesPage(prompt) } },
              call,
            ),
          prompt.step,
        );
        spent.push(seen);
        brief = readBrief(seen.data, prompt.tree);
        briefFailure = brief === undefined ? 'the eyes answered without a page state' : undefined;
      } catch (thrown) {
        throwIfSubscription(thrown);
        briefFailure = thrown instanceof Error ? thrown.message.slice(0, 200) : String(thrown);
      }
    }

    // CLASS MECHANISMS, read off the record and the tree, not left to the
    // brain's judgment (owner bar 2026-10-02 ~21:50Z):
    // - a failed or no-effect action: its alternatives on the page, links with
    //   their URL, are added to the brief;
    // - a loop: actions repeated in the last steps are named, will not run
    //   again (#route), and are ruled out in the loop's memory.
    const alternatives = alternativesFor(prompt.tree, prompt.history);
    if (brief !== undefined && alternatives.length > 0) {
      const listed = new Set(brief.elements.map((element) => element.ref));
      brief = {
        ...brief,
        elements: [...brief.elements, ...alternatives.filter((element) => !listed.has(element.ref))],
        notices: [...brief.notices, `Last action did not work; other routes: ${alternatives.map((element) => `[${element.ref}]`).join(' ')}`],
      };
    }
    this.#repeats = repeatedActions(onThisPageNow(prompt.history, prompt.tree, prompt.snapshotHash));
    const warnings = [
      ...[...this.#repeats.values()].map(
        (entry) =>
          `${entry.failed ? 'FAILED' : `REPEATED ${String(entry.count)}x`}: ${entry.text} — it will not run again unchanged; take a different route.`,
      ),
      ...retryableNavigations(prompt.history).map(
        (key) => `TIMED OUT once: ${key} — one exact retry is reasonable; only a second identical failure rules it out.`,
      ),
      ...repeatedPlaces(prompt.history),
      ...[redirectedSite(prompt.history, prompt.tree.url)].filter((line): line is string => line !== undefined),
      ...(this.#held === undefined ? [] : [this.#held]),
    ];
    this.#held = undefined;
    const expected = this.#expected;
    this.#expected = [];
    // A page the thread already holds, word for word, is not written again:
    // every kept token is a cache write now and a cache read on every later
    // step (owner cost lever 2: "never re-send unchanged facts").
    const facts = factsBesideReads(briefFacts(brief, briefFailure), prompt.tree.url, prompt.extracted ?? [], this.#fullReads);
    const sameFacts = facts === this.#lastFacts;
    const qualifying = this.#qualifyingNote(prompt);
    const kept = `${brain.thread.step(prompt, expected, warnings, this.#fullReads)}\n${sameFacts ? 'Page and facts: unchanged since your last turn.' : facts}${qualifying === undefined ? '' : `\n${qualifying}`}`;
    const elements = briefElements(prompt.tree, brief);
    // The tool replies of this turn, whole, ride the tail with the elements:
    // the thread keeps their short form (see `toolReplies`).
    const toolsOnce = brain.thread.once();
    this.#tail = toolsOnce === '' ? elements : `${toolsOnce}\n${elements}`;
    this.#tails.push(this.#tail);
    // The page as the brain read it, whole, for the step record: never the
    // "unchanged" line the thread got instead, so one record answers what it
    // was shown. Never a tool reply: a trace is durable.
    this.#stepBrief = { facts, elements };
    const first = await this.#decide(brain, prompt.step, kept, this.#tail, spent);
    // Held only once the thread committed the turn that carried them.
    if (first !== undefined) {
      this.#lastFacts = facts;
    }
    if (first === undefined) {
      return foldSpend(await this.#act(prompt, ''), spent);
    }
    const choice = await this.#route(brain, prompt, brief, needAsPlan(first, prompt), spent, true);
    // Queued only when the step went the way the brain decided it: a
    // re-decide inside #route clears the queue, and a step that ended the run
    // has nothing after it.
    this.#queue = !this.#redecided && first.then.length > 0 ? [...first.then] : undefined;
    return foldSpend(choice, spent);
  }

  /**
   * The qualifying listings line, when the set changed since the thread last
   * held it: new reads' PASS listings added (at most {@link QUALIFIERS_KEPT},
   * by name), a listing a later read FAILs dropped.
   */
  #qualifyingNote(prompt: AgentPrompt): string | undefined {
    const reads = prompt.extracted ?? [];
    for (const entry of reads.slice(this.#qualifiersSeen)) {
      const parsed = /^extracted on (\S+): ("[\s\S]*")$/.exec(entry.text);
      if (parsed === null) continue;
      const whole = wholeRead(entry.text, this.#fullReads);
      let read: string;
      try {
        read = whole === undefined ? (JSON.parse(parsed[2]!) as string) : (JSON.parse(whole.slice(whole.indexOf(': ') + 2)) as string);
      } catch {
        continue;
      }
      for (const verdict of listingVerdicts(read)) {
        if (!verdict.pass) this.#qualifiers.delete(verdict.key);
        else if (!this.#qualifiers.has(verdict.key) && this.#qualifiers.size < QUALIFIERS_KEPT) this.#qualifiers.set(verdict.key, { text: verdict.text, url: parsed[1]! });
      }
    }
    this.#qualifiersSeen = reads.length;
    if (this.#qualifiers.size === 0) return undefined;
    const line = `Qualifying listings your reads marked PASS so far (kept until a read fails one): ${[...this.#qualifiers.values()].map((entry, index) => `${String(index + 1)}) ${entry.text} [${entry.url.slice(0, 100)}]`).join('; ')}`;
    if (line === this.#qualifiersShown) return undefined;
    this.#qualifiersShown = line;
    return line;
  }

  /**
   * The prompt with every navigate the check misjudged (see
   * `reconciledNavigate`) read as the success it was. Only the newest step can
   * be judged against the tree; the port remembers each verdict so an older
   * step stays corrected in the repeat window, the thread and the queue.
   */
  #reconcile(prompt: AgentPrompt): AgentPrompt {
    const last = prompt.history.at(-1);
    if (last !== undefined && !this.#reconciled.has(last.index)) {
      const fixed = reconciledNavigate(last, prompt.tree.url);
      if (fixed !== undefined) {
        this.#reconciled.set(last.index, fixed);
      }
    }
    if (this.#reconciled.size === 0) {
      return prompt;
    }
    return { ...prompt, history: prompt.history.map((trace) => this.#reconciled.get(trace.index) ?? trace) };
  }

  /**
   * A step the brain queued (owner lever 1), run with no brain call and no
   * eyes call, or `undefined` when the brain must decide: nothing queued, the
   * last step failed or changed nothing, or the queued action does not fit the
   * page now. A queued action runs exactly as written once the loop's own
   * validator accepts it on the CURRENT tree; queued words go to the hands
   * and are gated like any hands step. Its expectation is shown to the brain
   * at its next decision, beside what actually happened.
   */
  async #runQueued(prompt: AgentPrompt): Promise<ModelChoice | undefined> {
    const queue = this.#queue;
    const next = queue?.[0];
    if (queue === undefined || next === undefined) {
      this.#queue = undefined;
      return undefined;
    }
    const last = prompt.history.at(-1);
    if (last === undefined || last.error !== undefined || last.check?.verdict === 'contradicted') {
      this.#queue = undefined;
      return undefined;
    }
    // NOT ON A PAGE THAT IS NOT THERE. A queued step was planned against the
    // page the brain expected to land on; the loop's settle has already waited
    // its whole budget for it, and the document is still unrendered. Acting
    // anyway is acting blind (2026-10-04 probes: IW21 pressed a queued Escape
    // on a 1-node document still parsing; IW12 queued two scrolls and a read
    // that answered "0 paragraphs"). The rest of the queue is dropped and the
    // brain decides, with the page as it stands in front of it.
    if (prompt.unrendered !== undefined) {
      this.#queue = undefined;
      const waited = (prompt.unrendered.waitedMs / 1000).toFixed(1);
      // Under the 60 characters the thread keeps of each expectation.
      this.#expected.push(`${String(queue.length)} queued NOT run: page unrendered after ${waited}s`);
      return undefined;
    }
    queue.shift();
    if (queue.length === 0) {
      this.#queue = undefined;
    }
    this.#expected.push(next.expect === '' ? 'the queued step to work' : next.expect);
    if (next.read !== undefined) {
      // PLAN AHEAD (owner cost lever, 2026-10-03): a queued read runs with no
      // brain call; its result comes back with the others on the brain's next
      // turn. Final only as the queue's last step on a run that has read and
      // noted nothing (the extract case's own rule): then it ends the run and
      // closes the plan, as the brain's finish would.
      const final =
        next.read.final &&
        this.#queue === undefined &&
        (prompt.extracted ?? []).length === 0 &&
        (prompt.memory?.findings ?? []).length === 0;
      const envelope = final ? envelopeOf(finishClosures({ notes: {}, answer: next.read.instruction }, prompt)) : undefined;
      return {
        action: {
          type: 'extract',
          instruction: final ? next.read.instruction : (readWithConditions(next.read.instruction, prompt.task) ?? next.read.instruction),
          ...(final ? { final: true } : {}),
        },
        reasoning: `queued: ${next.expect}`,
        ...(envelope === undefined ? {} : { envelope }),
        modelRank: this.#rank,
      };
    }
    if (next.action !== undefined) {
      const validated = validateAction(next.action, prompt.tree);
      if (!validated.ok) {
        this.#queue = undefined;
        this.#expected.push(`queued ${JSON.stringify(next.action)} did not fit the page: ${validated.errors.join('; ')}`);
        return undefined;
      }
      return { action: validated.value, reasoning: `queued: ${next.expect}`, modelRank: this.#rank };
    }
    const words: BrainDecision = { kind: 'instruct', instruction: next.say ?? '', why: next.expect, notes: {}, need: [], then: [] };
    const choice = await this.#act(prompt, handsGuidance(words));
    // Hands acting alone are held to the brain's refusals too: a delegated
    // loop (the same click again, a dead link, a disabled element) goes back.
    this.#repeats = repeatedActions(onThisPageNow(prompt.history, prompt.tree, prompt.snapshotHash));
    const refused = this.#refusal(choice.action, prompt.tree, prompt.history);
    if (refused !== undefined) {
      this.#queue = undefined;
      this.#expected.push(`the hands, acting alone, chose something that cannot run: ${refused}`);
      return undefined;
    }
    if (choice.reasoning?.trimStart().startsWith(HANDS_CANNOT) === true || choice.action.type === 'done' || choice.action.type === 'fail') {
      // The hands could not do it, or want to stop: the brain decides this
      // step after all. The hands' call is on the ledger either way.
      this.#queue = undefined;
      this.#expected.push(`the hands could not "${next.say ?? ''}": ${choice.reasoning ?? choice.action.type}`);
      return undefined;
    }
    return gateHands(choice, words);
  }

  /**
   * One brain call on the run's thread: `kept` (the step's compact text and
   * the page's facts, replayed on every later call) and `once` (the elements,
   * sent in this call only). `undefined` when the call failed or the reply was
   * not a decision; a failed call is not committed, so the step's news is
   * shown again next step.
   */
  async #decide(
    brain: BrainSlot,
    step: number,
    kept: string,
    once: string,
    spent: { readonly usage?: Usage }[],
  ): Promise<BrainDecision | undefined> {
    let result: ExtractResult;
    try {
      result = await brain.client.extract(
        brainInput(kept),
        {
          turns: brain.thread.turns(),
          cache: true,
          // The elements ride outside the cached prefix: never replayed.
          ...(once === '' ? {} : { tail: once }),
          ...(brain.providerOrder === undefined ? {} : { providerOrder: brain.providerOrder }),
          salvageTruncated: true,
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
        },
      );
    } catch (thrown) {
      throwIfSubscription(thrown);
      return undefined;
    }
    spent.push(result);
    const decision = readDecision(result.data);
    brain.thread.commit(step, kept, threadReply(result.data, result.text), decisionLine(step, decision), decision?.need ?? [], result.sent);
    return decision;
  }

  /** A decision, carried out: directly when it can be, through the hands when it needs the page. */
  async #route(
    brain: BrainSlot,
    prompt: AgentPrompt,
    brief: Brief | undefined,
    decision: BrainDecision,
    spent: { readonly usage?: Usage }[],
    mayRedecide: boolean,
  ): Promise<ModelChoice> {
    const decided = (action: Action, notes: BrainNotes = decision.notes): ModelChoice => {
      const envelope = envelopeOf(this.#mechanismNotes(notes, action, prompt, brief));
      return {
        action,
        ...(decision.why === '' ? {} : { reasoning: decision.why }),
        ...(envelope === undefined ? {} : { envelope }),
        modelRank: this.#rank,
      };
    };
    // A NOTE OR ANSWER NAMING WHAT NOTHING SHOWED. Its named things (words
    // with a capital or a digit, past a clause's first word) must each be in
    // what the brain was shown: the task, this page's brief, its thread, the
    // run's reads, notes and tool results. Else back to the brain once with
    // the names; if it insists, the note is dropped (an answer stands: the
    // port cannot write one). Taxonomy AB9, run_ed91c6ba (2026-10-04): a
    // challenge page read back "No accessibility tree content", and the brain
    // noted "real vitamin search results loaded (Vitamin D3, Centrum listings
    // with prices)", which the run returned as what it found.
    const claim = decision.kind === 'done' ? decision.answer : decision.notes.finding;
    if (claim !== undefined) {
      const shown = [...shownTo(brain, prompt, brief), ...this.#tails, ...this.#fullReads].filter(
        (text) => !this.#untraced.some((refusal) => text.includes(refusal)),
      );
      const unseen = untracedNames(claim, shown);
      if (unseen.length > 0 && mayRedecide) {
        this.#redecided = true;
        const what = decision.kind === 'done' ? 'Your answer' : 'Your note';
        const refusal = `${what} names ${unseen.slice(0, 4).map((name) => JSON.stringify(name)).join(', ')}, which no page, read or note of this run showed you, so it was not taken.`;
        this.#untraced.push(refusal);
        const again = await this.#decide(
          brain,
          prompt.step,
          `${refusal} State only what was shown; if a read came back empty or the page was a challenge, say that.`,
          this.#tail,
          spent,
        );
        if (again !== undefined) {
          return this.#route(brain, prompt, brief, again, spent, false);
        }
      }
      if (unseen.length > 0 && decision.kind !== 'done') {
        const { finding: _dropped, ...rest } = decision.notes;
        decision = { ...decision, notes: rest };
      }
    }
    switch (decision.kind) {
      case 'act': {
        const refused = this.#refusal(decision.action, prompt.tree, prompt.history);
        if (refused !== undefined) {
          // A LOOP OR A DEAD TARGET, refused. Once back to the brain with the
          // reason; if it insists, the hands pick a different route.
          if (mayRedecide) {
            this.#redecided = true;
            const again = await this.#decide(
              brain,
              prompt.step,
              `${refused}, so it will not run. Choose a different route.`,
              this.#tail,
              spent,
            );
            if (again !== undefined) {
              return this.#route(brain, prompt, brief, again, spent, false);
            }
          }
          const instead: BrainDecision = {
            kind: 'instruct',
            instruction: `Take a different route toward the task: ${refused}.`,
            why: '',
            notes: decision.notes,
            need: [],
            then: [],
          };
          return this.#ground(brain, prompt, brief, instead, spent, false);
        }
        // Once, and only once: a brain that insists after reading the reason
        // has its navigate run.
        const unread = mayRedecide ? unreadResults(prompt, decision.action) : undefined;
        if (unread !== undefined) {
          this.#redecided = true;
          const again = await this.#decide(
            brain,
            prompt.step,
            `${unread}, so that navigate did not run. Read these results first (each item against the task's filters), then search elsewhere if they fall short.`,
            this.#tail,
            spent,
          );
          if (again !== undefined) {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        // A VERB SENT AS A TOOL (run_f340ace4: `callTool` with tool
        // `purchase.begin`) is refused with the action spelled out, once back
        // to the brain; the hands cannot ground a verb that names no element.
        const tool = decision.action['type'] === 'callTool' ? decision.action['tool'] : undefined;
        const asTool = mayRedecide && typeof tool === 'string' ? actionNamedAsTool(tool) : undefined;
        if (asTool !== undefined) {
          this.#redecided = true;
          const again = await this.#decide(brain, prompt.step, `That callTool did not run: ${asTool}.`, this.#tail, spent);
          if (again !== undefined) {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        const direct = directAction(decision.action, brief, prompt.tree);
        if (direct.ok) {
          return decided(direct.action);
        }
        // A PURCHASE VERB THE VALIDATOR REFUSED goes back to the brain once
        // with the refusal, which spells the action out, rather than to the
        // hands: as with a verb sent as a tool above, the hands cannot ground
        // a verb that names no element.
        const type = decision.action['type'];
        if (mayRedecide && (type === 'purchase.begin' || type === 'purchase.end')) {
          this.#redecided = true;
          const again = await this.#decide(brain, prompt.step, `That ${type} did not run: ${direct.why}.`, this.#tail, spent);
          if (again !== undefined) {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        return this.#ground(brain, prompt, brief, decision, spent, mayRedecide);
      }
      case 'instruct':
        return this.#ground(brain, prompt, brief, decision, spent, mayRedecide);
      case 'extract': {
        const earlier = mayRedecide ? alreadyRead(prompt) : undefined;
        if (earlier !== undefined) {
          this.#redecided = true;
          const again = await this.#decide(
            brain,
            prompt.step,
            `That read was not run: this page is unchanged since your read at step ${String(earlier.step + 1)}, which returned: ${(wholeRead(earlier.text, this.#fullReads) ?? earlier.text).slice(0, 1_800)}. Answer from it, or act; reading it again returns the same.`,
            this.#tail,
            spent,
          );
          if (again !== undefined) {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        // A NON-FINAL READ OF A PAGE SHOWN WHOLE: the brief was the page itself
        // (raw view, nothing cut), so a read returns nothing the brain does not
        // already have, and costs a hands call plus the brain turn that reads
        // its result. Once back, to answer or act from what it was shown
        // (sealed set, long-history: re-read something already visible
        // instead of acting on it, 2026-10-03, abstract mode only). A final
        // read is left alone: it is the run's answer, in one step.
        if (mayRedecide && earlier === undefined && !decision.final && brief !== undefined && !brief.partial && brief.page.includes('(the whole page')) {
          this.#redecided = true;
          const again = await this.#decide(
            brain,
            prompt.step,
            'That read was not run: this whole page is already in your brief (Facts and Elements above), so a read returns nothing new. Act on it, or answer from it.',
            this.#tail,
            spent,
          );
          if (again !== undefined && again.kind !== 'extract') {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        // A read is a look — unless the brain says the read IS the answer
        // ("final"): then it ends the run as the brain's finish would, closing
        // the plan, and saves the brain the turn that only repeats it (owner
        // lever 3, 2026-10-03: "merge read then done into one step").
        // Not when the run has already read or noted something: then the
        // answer may draw on another page, and a final read returns only this
        // one (dev2 X5/X15, two named sources: the run ended on the second
        // source's figure alone). It reads as a look, and the brain answers.
        return decision.final && (prompt.extracted ?? []).length === 0 && (prompt.memory?.findings ?? []).length === 0
          ? decided({ type: 'extract', instruction: decision.extract, final: true }, finishClosures({ notes: decision.notes, answer: decision.extract }, prompt))
          : decided({ type: 'extract', instruction: readWithConditions(decision.extract, prompt.task) ?? decision.extract });
      }
      case 'done':
        // NO ANSWER OFF A PARTIAL VIEW. A done on a page the brief showed only
        // part of, with no read of it since the last change, is held: the page
        // is read first, and the brain answers from the read next turn (live10,
        // 2026-10-02: demoqa reported Subjects "Maths" against a confirmation
        // table of "Maths, Physics"; httpbin reported the form's labels for
        // its echoed values). Not when every figure the answer states was
        // shown to the brain (see `answerShown`): then the read can only
        // re-read the page in front of it, which is often not the answer's.
        if (
          mayRedecide &&
          brief?.partial === true &&
          !readSinceChange(prompt.history) &&
          !answerShown(decision.answer, [
            prompt.task,
            briefFacts(brief, undefined),
            briefElements(prompt.tree, brief),
            // What the brain was shown, never what it said: its own reply to this
            // step is already on the thread.
            ...brain.thread.turns().flatMap((turn) => (turn.role === 'user' ? [turn.content] : [])),
            ...(prompt.extracted ?? []).map((entry) => entry.text),
            ...(prompt.memory?.findings ?? []).map((entry) => entry.text),
            ...(prompt.toolResults ?? []).map((entry) => entry.text),
          ])
        ) {
          this.#held = `Your done was held: this page's view was partial, so it was read first. Check your answer against that read; what earlier pages showed still counts.`;
          return decided({
            type: 'extract',
            instruction: `Every value the task asks to report, exactly as this page shows it. Draft answer to check: ${decision.answer.slice(0, 240)}`,
          });
        }
        {
          // NOT CURRENT, AND THE PAGE SAYS SO: a task about now, answered off
          // a page whose own words mark what it shows as saved, cached or
          // dated, while it offers the control that refreshes it. Back to the
          // brain once with that control named (dev5 D6, 2/2: an order status
          // "as of Sep 28 … may be delayed" reported as current beside a
          // "Refresh status" button; heldout3 mode "extracts a figure the
          // page flags as stale or cached instead of refreshing it first").
          const refresh = mayRedecide ? staleWithRefresh(prompt.task, brief) : undefined;
          if (refresh !== undefined) {
            this.#redecided = true;
            const again = await this.#decide(
              brain,
              prompt.step,
              `Your done was held: the page marks what it shows as not current ("${refresh.marker}"), and the task asks for now. Refresh it first: [${refresh.ref}] "${refresh.label}".`,
              this.#tail,
              spent,
            );
            if (again !== undefined) {
              return this.#route(brain, prompt, brief, again, spent, false);
            }
          }
        }
        {
          // An answer from the wrong entry of a list the run itself recorded:
          // back to the brain once, with the mismatch named (C1).
          const notes = [...(prompt.memory?.findings ?? []).map((entry) => entry.text), ...(prompt.extracted ?? []).map((entry) => entry.text)];
          const wrong = wrongListItem(prompt.task, notes, prompt.tree.root.name ?? '');
          if (mayRedecide && wrong !== undefined) {
            this.#redecided = true;
            const again = await this.#decide(brain, prompt.step, `Your done was held: ${wrong}. Go to that item and answer from it.`, this.#tail, spent);
            if (again !== undefined) {
              return this.#route(brain, prompt, brief, again, spent, false);
            }
          }
          // A ranked slot filled by an item the answer itself calls
          // unconfirmed: once back, with the rule (amazon, run_876f0730).
          const slot = unconfirmedSlot(decision.answer);
          if (mayRedecide && slot !== undefined) {
            this.#redecided = true;
            const again = await this.#decide(
              brain,
              prompt.step,
              `Your done was held: slot ${slot} is not confirmed to meet the task's conditions. Ranked slots take only items confirmed against every condition, best first; an unconfirmed item may follow as an aside. If fewer confirmed items exist than the task asks for, list those and say how many qualify.`,
              this.#tail,
              spent,
            );
            if (again !== undefined) {
              return this.#route(brain, prompt, brief, again, spent, false);
            }
          }
        }
        {
          // No `unconfirmed` list (ws/doubt-off): a doubt the brain keeps goes in
          // its answer, where the loop's door reads it (`admittedGaps`).
          // Its evidence goes on the action, each entry beside the condition
          // it answers when there is one entry per condition: a schema-less
          // run returns it under the answer (runtime `answerWithEvidence`).
          // Only entries that cite what was read are kept; a "not confirmed"
          // entry is dropped, so the answer lists sources, never a list of
          // what was not read. Judge-only replay on BU Bench V1 (2026-10-16,
          // build 958babb1, the 65 runs of 300 whose evidence held such an
          // entry, 2 rejudges each): 29 passes as recorded, 38 with those
          // entries dropped from the answer and the done step, 11 runs up and
          // 0 down; dropping them from the answer alone gave 32.
          const need = brain.thread.need();
          const labelled = decision.evidence.map((entry, index) => (need.length === decision.evidence.length ? `${need[index]!}: ${entry}` : entry));
          const evidence = labelled.filter((entry) => !NOT_CONFIRMED.test(entry));
          return decided({ type: 'done', summary: decision.answer, ...(evidence.length > 0 ? { evidence } : {}) }, finishClosures(decision, prompt));
        }
      case 'fail':
        // A FAIL THAT NAMES WHERE THE ANSWER IS IS ASKED ONCE MORE: it ends
        // the run with no answer while its own reason names a site or URL that
        // has one (dev2 Y4, 2 of 15 samples: "needs the US site (ikea.com/us)"
        // on the UK store page). Only then: asked of every fail, it turned
        // correct refusals into actions ("an account already exists" into
        // "Sign in instead", "limit 5 per order" into a nav link; dev3 F3 and
        // F8, 4 of 4, 2026-10-03). A second fail stands.
        if (mayRedecide && NAMES_A_SITE.test(decision.answer)) {
          this.#redecided = true;
          const again = await this.#decide(
            brain,
            prompt.step,
            `You chose fail: "${decision.answer.slice(0, 160)}". A fail ends the run with no answer. If a page or site you can reach has it, go there now; fail again only if no route remains.`,
            this.#tail,
            spent,
          );
          if (again !== undefined) {
            return this.#route(brain, prompt, brief, again, spent, false);
          }
        }
        return decided({ type: 'fail', reason: decision.answer });
    }
  }

  /**
   * Why an action must not run as is, or `undefined`: it repeats an action
   * already taken twice, or once with no effect (see `repeatedActions`), or
   * its target is disabled on the page.
   */
  #refusal(action: Readonly<Record<string, unknown>> | Action, tree: AxTree, history: readonly StepTrace[] = []): string | undefined {
    const key = actionKey(action);
    if (key === undefined) {
      return undefined;
    }
    const searched = searchedBefore(history, action, tree);
    if (searched !== undefined) {
      return searched;
    }
    // A navigate to the page the browser is already on reloads it and changes
    // nothing a no-effect click did not (L1, 2026-10-03 01:47Z, 1 of 6).
    const url = (action as Readonly<Record<string, unknown>>)['url'];
    if ((action as Readonly<Record<string, unknown>>)['type'] === 'navigate' && typeof url === 'string' && sameUrl(url, tree.url)) {
      return `navigate ${clipUrl(url)} is the page already open`;
    }
    const repeat = this.#repeats.get(key);
    if (repeat !== undefined) {
      return repeat.failed
        ? `${repeat.text} already failed or changed nothing`
        : `${repeat.text} was already done ${String(repeat.count)} times`;
    }
    const target = refIndex(tree).get(key.split(' ')[1] ?? '');
    return target?.state?.disabled === true ? `${key} targets a disabled element` : undefined;
  }

  /**
   * The brain's notes plus what the class mechanisms add on their own:
   * - COLLECT BEFORE LEAVE: on a task that asks to collect or record, an
   *   action that leaves the page records the page (title and its first facts)
   *   as a finding when the brain wrote none — BrainMeasure M1, the title lost
   *   on every navigate;
   * - LOOP: the first repeated action this step is ruled out in the loop's
   *   memory, unless the memory already holds it.
   */
  #mechanismNotes(notes: BrainNotes, action: Action, prompt: AgentPrompt, brief: Brief | undefined): BrainNotes {
    let out = notes;
    const leaving =
      action.type === 'navigate' ||
      action.type === 'openTab' ||
      (action.type === 'click' && refIndex(prompt.tree).get(actionKey(action)?.split(' ')[1] ?? '')?.role === 'link');
    if (leaving && out.finding === undefined && COLLECT_TASK.test(prompt.task)) {
      // The page's own text: its link labels are navigation, not what it says
      // (BrainMeasure M1, 22:18Z: a finding of "Jump to content").
      const facts = (brief?.facts ?? []).filter(isPageText).slice(0, 2).join('; ');
      out = { ...out, finding: `On "${prompt.tree.root.name ?? prompt.tree.url}"${facts === '' ? '' : `: ${facts}`}`.slice(0, 240) };
    }
    const repeat = [...this.#repeats.values()][0];
    const already = (prompt.memory?.ruledOut ?? []).some((entry) => repeat !== undefined && entry.text.includes(repeat.text));
    if (repeat !== undefined && out.ruledOut === undefined && !already) {
      out = { ...out, ruledOut: `repeating ${repeat.text} (${String(repeat.count)}x, no progress)` };
    }
    return out;
  }

  /**
   * The hands: the full actuator prompt with the decision on top. A hands
   * reply that says it CANNOT, or that tries to end the run, goes back to the
   * brain once with the reason; whatever stands is gated so it cannot end the
   * run on the hands' word.
   */
  async #ground(
    brain: BrainSlot,
    prompt: AgentPrompt,
    brief: Brief | undefined,
    decision: BrainDecision,
    spent: { readonly usage?: Usage }[],
    mayRedecide: boolean,
  ): Promise<ModelChoice> {
    let choice: ModelChoice;
    try {
      choice = await this.#act(prompt, handsGuidance(decision));
    } catch (thrown) {
      // Hands that cannot produce a usable reply leave the step to the brain,
      // once: it can name the action itself (BrainMeasure C1, 2026-10-02
      // 22:03Z: two malformed hands replies to "go back to the front page",
      // and the step died with a usable brain one call away).
      if (!mayRedecide || !(thrown instanceof ModelSchemaError || thrown instanceof ModelUnusableError)) {
        throw thrown;
      }
      this.#redecided = true;
      const again = await this.#decide(
        brain,
        prompt.step,
        'The hands could not carry that out (their reply was unusable). Give the action yourself: "act" with a ref listed this turn, a URL to navigate to, or a key to press.',
        this.#tail,
        spent,
      );
      if (again === undefined) {
        throw thrown;
      }
      return this.#route(brain, prompt, brief, again, spent, false);
    }
    const head = choice.action;
    const cannot = choice.reasoning?.trimStart().startsWith(HANDS_CANNOT) === true;
    const ends = head.type === 'done' || head.type === 'fail';
    // The hands are held to the same refusals as the brain: no repeat of a
    // failed or looping action, nothing on a disabled element (BrainMeasure
    // L1: the brain said "say", the hands re-clicked the dead link).
    const refused = this.#refusal(head, prompt.tree, prompt.history);
    // A read in place of the step the brain said is the hands deciding what
    // to do: back to the brain (BrainMeasure L1, 2026-10-02 ~22:00Z: told to
    // reach the part another way, the hands read the results page instead).
    const reads = head.type === 'extract';
    if (mayRedecide && (cannot || ends || reads || refused !== undefined)) {
      spent.push(choice);
      this.#redecided = true;
      const why =
        head.type === 'done'
          ? `The hands proposed to END THE RUN instead, with: ${JSON.stringify(head.summary ?? '')}.`
          : head.type === 'fail'
            ? `The hands proposed to GIVE UP instead, because: ${JSON.stringify(head.reason)}.`
            : refused !== undefined
              ? `The hands chose something that cannot run: ${refused}.`
              : reads
                ? `The hands proposed to READ this page instead: ${JSON.stringify(head.instruction ?? '')}.`
              : `The hands could not carry that out: ${JSON.stringify(choice.reasoning ?? '')}.`;
      const again = await this.#decide(
        brain,
        prompt.step,
        `${why} Same page. Decide again; ending the run is yours to decide.`,
        this.#tail,
        spent,
      );
      if (again !== undefined) {
        return this.#route(brain, prompt, brief, again, spent, false);
      }
    }
    if (refused !== undefined) {
      // NEVER RUN WHAT WAS REFUSED, even past the one re-decide: the hands'
      // first alternative that is not refused, else one more hands call told
      // what not to do (BrainMeasure L1, 2026-10-03 01:44Z: the dead link
      // re-clicked on the fallback path, 2 of 6 samples).
      const other = (choice.alternatives ?? []).find((action) => this.#refusal(action, prompt.tree, prompt.history) === undefined);
      if (other !== undefined) {
        return gateHands({ ...choice, action: other }, decision);
      }
      spent.push(choice);
      const retry = await this.#act(prompt, handsGuidance({ ...decision, why: `Not this, which cannot run: ${refused}. Choose a different element or route.` }));
      if (this.#refusal(retry.action, prompt.tree, prompt.history) === undefined) {
        return gateHands(retry, decision);
      }
      spent.push(retry);
      // Still the refused element: take the other way to the same place that
      // the tree itself offers (a sibling or same-named link of the element
      // that failed: the image link beside a dead title link), else a look.
      const alternative = alternativesFor(prompt.tree, prompt.history).find(
        (element) =>
          ['link', 'button', 'img', 'image'].includes(element.role) && this.#refusal({ type: 'click', ref: element.ref }, prompt.tree, prompt.history) === undefined,
      );
      const clicked = alternative === undefined ? undefined : validateAction({ type: 'click', ref: alternative.ref }, prompt.tree);
      const fallback: Action =
        clicked?.ok === true
          ? clicked.value
          : { type: 'extract', instruction: 'what on this page leads toward the task, other than the element that did nothing' };
      return gateHands({ ...retry, action: fallback }, decision);
    }
    return gateHands(choice, decision);
  }

  /**
   * Extraction, down the same chain.
   *
   * Rank 0 is the actuator, not the planner: an extraction reads content that is
   * already on the page, which is the actuator's job description, and sending
   * page text to the reasoner is the one thing this whole design exists to
   * prevent.
   *
   * THE ONE PLACE A MODEL FAILURE BECOMES A CUSTOMER ERROR, and it is here
   * rather than inside `ModelClient` for a reason the chain makes visible: a
   * client-level wrap would hide the very fields {@link shouldFailOver} reads,
   * so a rate limit would stop demoting. Here the chain has already had its
   * turn, the client has already had its corrections and resends, and what is
   * left is final. See {@link extractionRefusal}.
   */
  async extract(input: ExtractInput): Promise<ExtractOutcome> {
    let outcome: ExtractOutcome;
    try {
      outcome = await this.#withFailover((slot, call) => slot.client.extract(input, call), -1, 'extract');
    } catch (thrown) {
      throw extractionRefusal(thrown);
    }
    const checked = checkRankedRead(input, outcome);
    if (this.#brain !== undefined) {
      // The whole result, for the brain: the loop keeps 600 characters of it
      // (see `wholeRead`). Kept in every form the loop may have clipped.
      const data = checked.data;
      const body = isRecord(data) && 'answer' in data && 'complete' in data ? data['answer'] : data;
      const forms = typeof body === 'string' ? [body] : [JSON.stringify(body) ?? ''];
      this.#fullReads = [...this.#fullReads, ...forms].slice(-8);
    }
    return checked;
  }

  /**
   * The schema suggestion, through the same failover rank as everything else.
   *
   * Unlike {@link HarnessModelPort.extract} above, a failure here is SWALLOWED
   * rather than converted into a refusal. `extract` throwing is how a caller
   * learns its extraction did not happen; this call has no such caller — the
   * run never reads the result and the customer never asked for it — so the
   * only honest thing a total failure can produce is "no suggestion".
   */
  async suggestSchema(task: string): Promise<JsonSchema | null> {
    try {
      return await this.#withFailover((slot) => slot.client.suggestSchema(task), -1);
    } catch {
      return null;
    }
  }

  /**
   * Run a call against the live rank, demoting through the remaining ranks while
   * the failure is one another model could survive — and, for an action or
   * extract call on rank 0 with {@link HarnessPortOptions.hedgeMs} set, asking
   * the same slug again beside a call that is slow to answer.
   *
   * The last rank's error is rethrown untouched. It is the only thing a customer
   * ever sees from this module, and it is the provider's own message about the
   * final model — which carries no slug, because `ModelProviderError`'s text is
   * `model provider refused (<status> <code>): <message>`.
   */
  async #withFailover<T>(
    call: (slot: ActuatorSlot, options: ModelCallOptions) => Promise<T>,
    step: number,
    hedgeable?: 'action' | 'extract',
  ): Promise<T> {
    // RECOVERY FIRST: a demoted chain whose hold has run out goes back to the
    // primary before this call, not after it. See the module comment.
    if (this.#rank > 0 && this.#clock.now() - this.#demotedAt >= this.#holdMs) {
      const from = this.#actuators[this.#rank];
      const primary = this.#actuators[0];
      this.#rank = 0;
      // A lone stall's return is not a probe of an outage: a failure on it is
      // an ordinary demotion at the base cooldown, not a doubled one.
      this.#probing = !this.#stalled;
      if (from !== undefined && primary !== undefined) {
        this.#onFailover({
          from: from.slug,
          to: primary.slug,
          trigger: 'cooldown-elapsed',
          step,
          message: this.#stalled
            ? 'the primary is asked again on the next call: its last call stalled alone, so the demotion was not held'
            : `the primary is retried after ${String(this.#holdMs / 1000)} s on a lower rank`,
        });
      }
    }
    for (;;) {
      const current = this.#actuators[this.#rank];
      if (current === undefined) {
        throw new ModelConfigError('the harness actuator chain is empty, so there is nothing to call');
      }
      const hedgeMs = this.#hedgeMsFor(hedgeable, current);
      const settled =
        hedgeMs === undefined
          ? await settle(call(current, this.#signal === undefined ? {} : { signal: this.#signal }))
          : await this.#hedged(call, current, hedgeMs);
      if (settled.ok) {
        if (this.#rank === 0) {
          this.#stalled = false;
          if (this.#probing) {
            // The primary answered its probe: the outage is over, so the next
            // one starts from the base cooldown rather than a doubled one.
            this.#probing = false;
            this.#cooldownMs = FAILOVER_COOLDOWN_MS;
          }
        }
        return settled.value;
      }
      const next = this.#actuators[this.#rank + 1];
      const thrown = settled.error;
      if (next === undefined || !shouldFailOver(thrown)) {
        throw thrown;
      }
      this.#demote(
        current,
        next,
        triggerOf(thrown),
        thrown instanceof ModelTimeoutError,
        thrown instanceof Error ? thrown.message : String(thrown),
        step,
      );
    }
  }

  /**
   * How long this call may go unanswered before it is hedged, or `undefined`
   * for never. See {@link HarnessPortOptions.hedgeMs}: rank 0 only, actions at
   * the operator's threshold, extractions at the slug's measured one.
   */
  #hedgeMsFor(hedgeable: 'action' | 'extract' | undefined, slot: ActuatorSlot): number | undefined {
    if (hedgeable === undefined || this.#hedgeMs === undefined || this.#rank !== 0) {
      return undefined;
    }
    return hedgeable === 'action' ? this.#hedgeMs : slot.extractHedgeMs;
  }

  /**
   * One call with the same client asked again beside it after `hedgeMs`. See
   * {@link HarnessPortOptions.hedgeMs} for the rules; this is them, in order of
   * what settles first. Never demotes: the settlement it returns is what the
   * chain acts on, exactly as for an unhedged call.
   */
  async #hedged<T>(
    call: (slot: ActuatorSlot, options: ModelCallOptions) => Promise<T>,
    client: ActuatorSlot,
    hedgeMs: number,
  ): Promise<Settled<T>> {
    const primaryAbort = new AbortController();
    const first = settle(call(client, { signal: this.#withRun(primaryAbort.signal) }));
    const early = await Promise.race([first, this.#clock.sleep(hedgeMs).then(() => undefined)]);
    if (early !== undefined) {
      // Answered, or failed, inside the threshold: no hedge.
      return early;
    }

    const hedgeAbort = new AbortController();
    const second = settle(call(client, { signal: this.#withRun(hedgeAbort.signal), hedge: true }));
    const winner = await Promise.race([
      first.then((result) => ({ hedge: false, result })),
      second.then((result) => ({ hedge: true, result })),
    ]);

    if (!winner.hedge) {
      // The primary answered, or failed — at its deadline or otherwise. Either
      // way the hedge has nothing left to do: a failure goes down the chain or
      // is thrown exactly as an unhedged one would be.
      hedgeAbort.abort();
      return winner.result;
    }
    if (!winner.result.ok) {
      // A hedge that failed first is forgotten: the primary decides the call,
      // as if it had never been hedged. Its failure is already on the ledger.
      return first;
    }
    primaryAbort.abort();
    return winner.result;
  }

  /** A hedge's own withdrawal, or the run's cancel, whichever comes first. */
  #withRun(own: AbortSignal): AbortSignal {
    return this.#signal === undefined ? own : AbortSignal.any([own, this.#signal]);
  }

  /**
   * Move the live rank one down, and — when it is rank 0 that is leaving —
   * decide how long the demotion holds. `stall` marks a primary that did not
   * answer (a timeout) as opposed to one that failed.
   */
  #demote(
    from: { readonly slug: string },
    to: { readonly slug: string },
    trigger: FailoverTrigger,
    stall: boolean,
    message: string,
    step: number,
  ): void {
    if (this.#rank === 0) {
      // A LONE STALL: this one call did not answer, the primary's previous call
      // did, and no outage is being probed. The next rank answers THIS call
      // and the next call goes back to the primary — see `LONE_STALL_HOLD_MS`
      // for the measurement. A second failure in a row is not lone and holds
      // for the cooldown, so an upstream that is really down costs at most one
      // extra stall before the chain holds.
      const lone = stall && !this.#probing && !this.#stalled;
      if (this.#probing) {
        // Promoted, asked, failed again: the upstream is still down, so
        // wait twice as long before asking it next time.
        this.#probing = false;
        this.#cooldownMs = Math.min(this.#cooldownMs * 2, FAILOVER_COOLDOWN_CAP_MS);
      }
      this.#stalled = lone;
      this.#holdMs = lone ? LONE_STALL_HOLD_MS : this.#cooldownMs;
      this.#demotedAt = this.#clock.now();
    }
    this.#rank += 1;
    this.#onFailover({ from: from.slug, to: to.slug, trigger, step, message, holdMs: this.#holdMs });
  }

  /**
   * One planner call, over a digest and never over the page.
   *
   * The parameter is a {@link PlanDigest}, so the tree cannot be passed here by
   * accident; the completion check adds the actuator's own proposed summary,
   * bounded by {@link COMPLETION_SUMMARY_CHARS}.
   *
   * A planner failure is NOT a step failure and is deliberately swallowed: the
   * previous plan stays in force, the actuator still has the page in front of it,
   * and losing a run because the strategist was rate-limited would be the pair
   * making the product less reliable than the single model it replaced. The
   * ledger still has the failed call.
   */
  async #askPlanner(
    planner: ModelClient,
    instruction: string,
    schema: object,
    digest: PlanDigest & { readonly proposedDone?: { readonly summary: string } },
  ): Promise<ExtractOutcome | undefined> {
    try {
      return await planner.extract({
        instruction,
        schema: schema as ExtractInput['schema'],
        content: { kind: 'markdown', markdown: JSON.stringify(digest, null, 1) },
      });
    } catch (thrown) {
      // A subscription that refused this run's credential, or has none for
      // it, is NOT a rate-limited strategist: swallowing it would leave a
      // `-plan` lab arm acting on its rank-0 actuator alone while its results say a
      // frontier planner ran. It fails the step instead (OC-286).
      if (thrown instanceof ModelProviderError && thrown.providerCode.startsWith('subscription_')) {
        throw thrown;
      }
      return undefined;
    }
  }
}

/** A call's outcome as a value, so two calls can be raced without a rejection escaping. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Never rejects. Shared by the plain call and both arms of a hedge. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/**
 * A choice with every other call the step made folded in: tokens summed into
 * `usage`. Money is not folded here — every call is in the session's
 * `CostLedger` at the provider's own price, and the runtime charges the run
 * from that total, so the planner and a re-asked actuator are billed whether
 * or not their reply was used.
 */
function foldSpend(choice: ModelChoice, spent: readonly { readonly usage?: Usage }[]): ModelChoice {
  let usage = choice.usage;
  for (const extra of spent) {
    if (extra.usage !== undefined) {
      usage = mergeUsage(usage, extra.usage);
    }
  }
  return { ...choice, ...(usage === undefined ? {} : { usage }) };
}

/**
 * An exhausted extraction, as an error the CUSTOMER can read — or unchanged,
 * when it is one of ours.
 *
 * ── What this fixes ────────────────────────────────────────────────────────
 *
 * `toOutcrawlError` in `@outcrawl/api` drops any plain `Error` to
 * `new InternalError(incidentId)`, and every error in `./provider` is a plain
 * `Error`. So a `json`-format scrape whose extraction failed answered HTTP 500
 * `{"code":"internal","details":{"incidentId":…}}` — the product telling a
 * customer it had crashed, about a request that commonly succeeds on the next
 * attempt. Measured on the Facebook Ad Library page with `acct_mit`'s key,
 * 2026-09-12: 3 of 20 replays of one fixed 47,401-character render, and 7 of 37
 * calls in AdCountStable's wider arm. `ModelUnusableError` reaching the wire as
 * `internal` is also incident `inc_7bd10cc4-982c-473c-a0b1-f46c8ee2d2c2`,
 * `acct_mit`, the same day.
 *
 * ── Why the split, and where it is drawn ───────────────────────────────────
 *
 * {@link ExtractionFailedError} promises the customer a retry is worth making,
 * so it may only be raised where that is TRUE. It is raised for the failures
 * that are model sampling or a momentary provider fault — measured: 17 of those
 * same 20 replays satisfied the identical schema — and NOT for:
 *
 * - A non-retryable `ModelProviderError`: a 401 or 403 is our credential, a 402
 *   is our billing, a 400 or 404 is a slug we withdrew. Every one of them is
 *   ours, none of them clears on a retry, and "retry" would be false advice. An
 *   `internal` with an incident id is the honest answer, which is exactly what
 *   `internal` is for.
 * - `ModelConfigError`: our own bug by construction.
 * - A refusal or a content filter. The model ANSWERED — it declined on the
 *   content — so nothing was cut off and nothing is momentary. There is no
 *   honest code in `OUTCRAWL_ERROR_CODES` for "the model would not answer about
 *   this page", inventing a second code on one unmeasured family would be
 *   guessing, and this one stays `internal` until somebody measures it. Stated
 *   here rather than left to be discovered.
 *
 * ── What goes in `detail`, and what must never ─────────────────────────────
 *
 * The detail reaches the customer, so it carries the validator's own lines
 * (which name a path and a value from THEIR page) and, for everything else,
 * only our own words plus the provider's status and code. Never the provider's
 * free-text message: it is the one string in this path that can name a model,
 * and the host's rule is that no slug reaches a customer.
 * Capped, because a hundred violations are not a sentence.
 */
function extractionRefusal(thrown: unknown): unknown {
  if (thrown instanceof ModelSchemaError) {
    return new ExtractionFailedError('schema', clipDetail(thrown.violations.join('; ')));
  }
  if (thrown instanceof ModelUnusableError) {
    return UNUSABLE_IS_NO_ANSWER[thrown.stopReason] === true
      ? new ExtractionFailedError(
          'no-answer',
          `the generation ended as '${thrown.stopReason}' with nothing usable in it`,
        )
      : thrown;
  }
  if (thrown instanceof ModelTimeoutError) {
    return new ExtractionFailedError('no-answer', thrown.message);
  }
  if (thrown instanceof ModelProviderError && thrown.retryable) {
    return new ExtractionFailedError(
      'no-answer',
      `the model provider answered ${String(thrown.status)} ${thrown.providerCode}`,
    );
  }
  return thrown;
}

/**
 * The stop reasons that mean the reply never arrived, for the purpose of
 * telling a CUSTOMER so.
 *
 * Wider than {@link UNANSWERED_STOP_REASONS}, which decides whether to demote,
 * and the difference is deliberate: `error` means the upstream died
 * mid-generation, which `ModelClient.extract` resends on the same rank rather
 * than demoting for (see its `worthResending`), but by the time it reaches here
 * the resends are spent and the customer's fact is the same as a truncation's —
 * no answer was produced.
 */
const UNUSABLE_IS_NO_ANSWER: Readonly<Record<string, true>> = {
  length: true,
  max_tokens: true,
  error: true,
};

/** 200 characters of it. A customer-visible sentence, not a log. */
function clipDetail(detail: string): string {
  return detail.length > 200 ? `${detail.slice(0, 200)}...` : detail;
}

/**
 * How many nodes on the page the actuator could act on.
 *
 * `ACTIONABLE_ROLES` and not a node count: every `AxNode` carries a `ref`, so
 * counting refs would count headings and static text and tell the planner a
 * page of prose was full of controls. The role set is the runtime's own, so this
 * number means the same thing the loop means by it.
 *
 * A count and not a list, and that is the whole point of the function existing:
 * the tree is in scope here and the integer is what leaves. The planner needs to
 * know whether there is anything to act on, which one number answers and
 * thousands of tokens would answer no better.
 */
function countActionable(prompt: AgentPrompt): number {
  let total = 0;
  const walk = (node: AxNode): void => {
    if (ACTIONABLE_ROLES.has(node.role)) {
      total += 1;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(prompt.tree.root);
  return total;
}

/**
 * Two token counts, summed.
 *
 * `cache` and `inferenceTimeMs` come from the ACTUATOR's call and are not
 * combined: the cache verdict is a statement about the action cache, which the
 * planner does not use, and an inference time that added two concurrent-ish
 * calls together would report a step as slower than it was.
 */
function mergeUsage(step: Usage | undefined, planner: Usage): Usage {
  const base = step ?? {};
  const add = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);

  const inputTokens = add(base.inputTokens, planner.inputTokens);
  const outputTokens = add(base.outputTokens, planner.outputTokens);
  const reasoningTokens = add(base.reasoningTokens, planner.reasoningTokens);
  const cachedInputTokens = add(base.cachedInputTokens, planner.cachedInputTokens);

  return {
    ...base,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

/* ------------------------------------------------------------------ *
 * Brain mode plumbing
 * ------------------------------------------------------------------ */

/** One rank of the actuator chain. `eyes` exists only on a brain harness. */
interface ActuatorSlot {
  readonly slug: string;
  /** {@link PlanModel.extractHedgeMs}. */
  readonly extractHedgeMs?: number;
  readonly client: ModelClient;
  readonly eyes?: ModelClient;
}

interface BrainSlot {
  readonly slug: string;
  /** {@link PlanModel.providerOrder}. */
  readonly providerOrder?: readonly string[];
  readonly client: ModelClient;
  readonly thread: BrainThread;
}

/**
 * The eyes' reply ceiling. A brief is at most 6 facts and 10 elements (~300
 * tokens, measured 564-711 at the old 25-element brief, n=2); the actuator's
 * reasoning is off on every scout-1 rank, so this is headroom, not a budget
 * the reasoning eats. A truncated brief demotes like any truncation.
 */
const EYES_MAX_TOKENS = 1_536;

/**
 * The brain's reply ceiling, its reasoning INCLUDED: `max_tokens` covers the
 * reasoning the plan's effort asks for as well as the reply, and the two are
 * cut together. A cut reply with no whole decision in it is unusable, and the
 * step falls back to plain scout-1 with no strategy from the brain.
 *
 * 3,000, not 1,000. MEASURED, the fleet's per-call lines, 2026-10-07 to 10-14:
 * 1,124 of 17,551 brain calls (6.4%) came back cut at 1,000 and unusable. On
 * the research benchmark runs of 10-13 it was 596 of 3,444 (17.3%, 2.9 a run),
 * and 403 of those had spent 300+ of the 1,000 on reasoning. It grows with
 * the thread: 6% of calls under 5k context tokens, 19-27% past 10k, where a
 * long research run spends its steps. Uncut (at 4,000), finished replies at
 * the plan's effort ran p50 483 / p99 1,945 / max 2,192 tokens (n=142,
 * 2026-10-14), 16% of them over 1,000; at 2,000 and 4,000 no reply was cut by
 * its reasoning (0 of 226). 3,000 is the observed max plus a third.
 *
 * The ceiling still bounds a RUNAWAY: a reply that slips into tool-call markup
 * and repeats it until cut (21 of 324 calls, 6.5%, the same day), which bills
 * the whole ceiling at any height and no ceiling rescues. That is most of
 * what the raise costs: on the 10-13 distribution at most +$0.025 a run
 * (+15% of brain spend), $0.019 of it runaways running longer and $0.006 the
 * replies that now finish. A ceiling bills nothing a finished reply does not
 * use. (Before: 1,000, not 600, because reasoning counts against it,
 * BrainMeasure M1 2026-10-02; the 4,096 runaway BrainMeasure measured that
 * day is the runaway above.) The runaways were the brain answering in text
 * with no tool offered; its model now answers through an offered tool
 * ('tool_auto', see `StructuredOutputMode`), and on replayed brain prompts
 * none ran away (0 of 213, 2026-10-14, against 14 of 213 in text).
 *
 * 4,000 for `page.script` and `code.run` (ws/page-script 2026-10-17, ws/code-run
 * 2026-10-18): each tool's `code` argument is written in the reply, on top of
 * the reasoning above (p99 1,945), and a reply cut mid-script is a step with
 * no decision. MEASURED, n=1, dev-set smoke run_05797e11 (2026-10-17): the
 * brain reply carrying a 558-character script was 535 completion tokens, its
 * reasoning (259 characters) included. MEASURED, dev-set sub-runner smoke of
 * 10f0e323b (2026-10-18, n=3 code.run replies over 2 runs): programs of 362,
 * 512 and 507 characters came in replies of 336, 364 and 1,205 completion
 * tokens, reasoning included; the largest of the 55 brain replies in those
 * runs was 1,757. How those tokens split between the code and the rest is not
 * measured. A finished reply bills only what it wrote.
 */
const BRAIN_MAX_TOKENS = 4_000;

/** A task that asks the run to collect or record things as it goes. */
const COLLECT_TASK = /\b(record|collect|note down|write down|keep track|list (each|every|all)|for each|each of the|every one)\b/i;

/** An evidence entry that says its condition was not read, the brain's own wording in its done template. */
const NOT_CONFIRMED = /not confirmed/i;

/** The brain's extract input for one kept step. One builder, so the thread replays exactly what was sent. */
function brainInput(kept: string): ExtractInput {
  return { instruction: null, schema: BRAIN_SCHEMA, content: { kind: 'markdown', markdown: kept } };
}

/**
 * A subscription refusal is never swallowed in brain mode either: a lab arm
 * acting on its rank-0 actuator alone while its results claim a frontier brain ran is the
 * failure OC-286 names for the planner.
 */
function throwIfSubscription(thrown: unknown): void {
  if (thrown instanceof ModelProviderError && thrown.providerCode.startsWith('subscription_')) {
    throw thrown;
  }
}

/** Two URLs naming the same page: scheme, host case, trailing slash and fragment aside. */
function sameUrl(left: string, right: string): boolean {
  const norm = (value: string): string => {
    try {
      const parsed = new URL(value);
      return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch {
      return value.replace(/#.*$/, '').replace(/\/+$/, '');
    }
  };
  return norm(left) === norm(right);
}

function clipUrl(url: string): string {
  return url.length <= 100 ? url : `${url.slice(0, 99)}…`;
}

/**
 * A FINAL read of a rank range checked against the page's own numbering
 * ({@link rankedReadGap}): a wrong one is returned incomplete, with the exact
 * ranks it gets wrong as `missing`, so the loop keeps it as a look and says
 * why. Only a final read's reply carries `complete`; every other read, and
 * every read with no rank range, is returned as it came.
 */
function checkRankedRead(input: ExtractInput, outcome: ExtractOutcome): ExtractOutcome {
  const data = outcome.data;
  if (input.content.kind !== 'tree' || input.instruction === null || !isRecord(data) || data['complete'] !== true) {
    return outcome;
  }
  const gap = rankedReadGap(input.instruction, input.content.tree, data['answer']);
  return gap === undefined ? outcome : { ...outcome, data: { ...data, complete: false, missing: `checked against the page's numbered list: ${gap}` } };
}

/**
 * THE BRAIN'S FINISH CLOSES THE PLAN. A brain `done` is its judgment that the
 * task is complete — the brain is the run's planner, and its rules hold a done
 * until every condition has evidence — so every sub-goal still open is closed
 * with it: the brain's own closure first (`goal`, a `failed` one kept as
 * failed), then `done` for the rest, summarised by the answer. Without
 * this the loop's finish gate (one closure per reply, `FINISH_HOLD_TOLERANCE`
 * refusals) held complete answers for three steps and reported the run
 * `partial` (live10 on main 600e4e28, 4 of 10 correct runs, 2026-10-02).
 */
function finishClosures(decision: { readonly notes: BrainNotes; readonly answer: string }, prompt: AgentPrompt): BrainNotes {
  const own = decision.notes.goal === undefined ? [] : [decision.notes.goal];
  const named = new Set(own.map((update) => update.id));
  const rest = (prompt.memory?.goals ?? [])
    .filter((goal) => goal.status !== 'done' && goal.status !== 'failed' && !named.has(goal.id))
    .map((goal) => ({ id: goal.id, status: 'done' as const, summary: `closed by the finish: ${decision.answer.slice(0, 120)}` }));
  if (own.length + rest.length === 0) {
    return decision.notes;
  }
  const { goal: _single, goals: _list, ...notes } = decision.notes;
  return { ...notes, goals: [...own, ...rest] };
}

/**
 * The task's conditions ARE the plan: on the run's first decision with no
 * plan yet, each `need` item becomes sub-goal `n1`, `n2`, ... — one list in
 * the brain's first reply rather than two that say the same thing (owner
 * lever 1, 2026-10-03: ~70 output tokens of `plan` per run). A plan the brain
 * states itself, or a run that already has one, is left alone.
 */
function needAsPlan(decision: BrainDecision, prompt: AgentPrompt): BrainDecision {
  if (decision.need.length === 0 || decision.notes.plan !== undefined || (prompt.memory?.goals ?? []).length > 0) {
    return decision;
  }
  return { ...decision, notes: { ...decision.notes, plan: decision.need.map((goal, index) => ({ id: `n${String(index + 1)}`, goal })) } };
}

/** Actions that leave a page's content as it was: a read after only these still reads this page. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(['extract', 'scroll', 'wait']);

/** The run has read the page since its last action that could change it. */
function readSinceChange(history: readonly StepTrace[]): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const type = history[index]!.action.type;
    if (type === 'extract') {
      return true;
    }
    if (!READ_ONLY_ACTIONS.has(type)) {
      return false;
    }
  }
  return false;
}

/** A URL or a bare domain ("ikea.com/us"), not an email address's domain. */
const NAMES_A_SITE = /https?:\/\/|(?<![@\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|gov|edu|io|dev|co|uk|de|fr|in|ca|au)\b/i;

/** The figures in a text: digit runs with their inner separators ("5,571.7", "14:47", "2026-10-04"), commas dropped. */
function figuresIn(text: string): readonly string[] {
  return [...grouped(text).matchAll(/\d(?:[\d,.:/-]*\d)?/g)].map((match) => plainFigure(match[0].replaceAll(',', '')));
}

/**
 * A text with its thousands written plainly: "9.733.276" (dot-grouped, as
 * many locales write it), "9 733 276" and "9’733’276" become "9733276", so a
 * draft's "9,733,276" is the figure the page showed (sealed heldout6 on
 * a506a744, abstract: a dot-grouped count held 4 of 4 correct dones for a
 * re-read).
 */
function grouped(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{3}){2,}\b/g, (run) => run.replaceAll('.', ''))
    // A decimal comma ("0,8 %", "3,5 kg"): English never groups one or two digits.
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/\b\d{1,3}(?:[\u00a0\u202f ’'](?=\d{3}\b)\d{3})+\b/g, (run) => run.replace(/[\u00a0\u202f ’']/g, ''));
}

/** A figure without trailing decimal zeros: "1299.00" is "1299", "4.50" is "4.5". */
function plainFigure(figure: string): string {
  return /^\d+\.\d+$/.test(figure) ? figure.replace(/\.?0+$/, '') : figure;
}

/**
 * Whether every figure a done's answer states is one the brain was shown: on
 * this page's brief, in an earlier turn of its thread (earlier pages' briefs,
 * reads and notes), in the run's reads, notes and tool results, or in the task.
 * An answer with no figure is never counted as shown: a name or a list can be
 * shown in part and still read as whole (live10 demoqa, "Maths" for "Maths,
 * Physics").
 *
 * WHY: the partial-view hold exists for an answer made of values the view HID.
 * Held when every value it states was in front of the brain, it re-read the
 * current page and told the brain to answer from that read, which is wrong
 * whenever the answer comes from another page: a stale release or a forum post
 * open now (current fee, retailer price), or two named sources where only the
 * last is on screen. Measured on dev2 conflicting-facts, full-size pages, main
 * 307d4c9d: 0/45, every miss a held correct done (2026-10-03 00:02Z, n=15x3).
 */
/** Everything the brain was shown this run, as `answerShown` reads it. */
/** How many qualifying listings the port keeps for the brain: a ranked task asks for a few. */
const QUALIFIERS_KEPT = 8;

function shownTo(brain: BrainSlot, prompt: AgentPrompt, brief: Brief | undefined): readonly string[] {
  return [
    prompt.task,
    prompt.tree.url,
    prompt.tree.root.name ?? '',
    briefFacts(brief, undefined),
    briefElements(prompt.tree, brief),
    ...brain.thread.turns().flatMap((turn) => (turn.role === 'user' ? [turn.content] : [])),
    ...(prompt.extracted ?? []).map((entry) => entry.text),
    ...(prompt.memory?.findings ?? []).map((entry) => entry.text),
    ...(prompt.toolResults ?? []).map((entry) => entry.text),
  ];
}

/**
 * The named things a claim states that nothing shown says: words carrying a
 * digit ("D3", "4K"), and capitalised words past a clause's first word
 * ("Centrum"), matched case-blind as text anywhere in what was shown.
 * Exported for measurement.
 */
export function untracedNames(claim: string, shown: readonly string[]): readonly string[] {
  const seen = shown.join('\n').toLowerCase().replace(/[’']/g, "'");
  const traced = (word: string): boolean => {
    const key = word.toLowerCase().replace(/[’']/g, "'");
    if (seen.includes(key) || seen.includes(key.replace(/s$/u, ''))) return true;
    // A joined token ("i5-13420H", "10 am–5 pm") whose parts were each shown.
    const parts = key.split(/[-–—/]/u).filter((part) => part.length > 0);
    return parts.length > 1 && parts.every((part) => seen.includes(part));
  };
  const out: string[] = [];
  for (const clause of claim.split(/[.;:!?()\[\]"“”]+|\s[-–—]\s/u)) {
    const words = clause.trim().split(/[\s,]+/u).filter(Boolean);
    words.forEach((raw, index) => {
      const word = raw
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        // A possessive is its name: "Acme's" is "Acme".
        .replace(/['’]s$/u, '');
      if (word.length < 2) return;
      // A figure, however written ("60k", "4.1★", "119k", "30%", "5,050mAh"),
      // is `answerShown`'s to judge; here only codes and names.
      if (/^\d[\d,.]*[a-z%]{0,4}$/iu.test(word)) return;
      // A figure with a unit or a word ("3-point", "312/GB"), a contraction ("I'm"), an acronym ("RAM", "USB").
      if (/^\d[\d,.]*[-/]\p{L}+$/u.test(word) || /^i['’]/iu.test(word) || /^\p{Lu}{2,4}$/u.test(word)) return;
      const code = /\d/.test(word) && /\p{L}/u.test(word);
      const named = index > 0 && /^\p{Lu}/u.test(word) && word.length >= 3 && !CALENDAR_OR_CURRENCY.test(word);
      if ((code || named) && !traced(word) && !out.includes(word)) out.push(word);
    });
  }
  return out;
}

/** Month and day names, and currency codes: said in an answer however the page wrote the date or price. */
const CALENDAR_OR_CURRENCY =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|usd|eur|gbp|inr|cad|aud|jpy|chf|utc|gmt)$/iu;

function answerShown(answer: string, shown: readonly string[]): boolean {
  const figures = figuresIn(answer);
  if (figures.length === 0) {
    return false;
  }
  // Each shown figure, and the parts of a joined one ("3-5" shows 3 and 5).
  // Each shown figure, and the parts of a joined one ("3-5" shows 3 and 5,
  // the date "31.12.2025" shows 31, 12 and 2025).
  const seen = new Set(
    shown
      .flatMap(figuresIn)
      .flatMap((figure) => [figure, ...figure.split(/[-/]/).filter(Boolean).map(plainFigure), ...(/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(figure) ? figure.split('.') : [])]),
  );
  const digits = [...seen].map(significant).filter((value): value is string => value !== undefined);
  // A figure also counts when it is a shown figure rounded at another scale:
  // "about $1.18 billion" for a shown "$1,184.6 million" (dev4 C13, 2 of 2
  // samples: the exact figure, then its rounding, and the rounding held the
  // done for a re-read). Two significant digits at least, so "about 2" never
  // matches by rounding alone.
  // Operands of 100 and up only: small numbers (counts, ranks, ids) are on
  // every page, and sums of them would make almost any small answer "shown".
  const numbers = [...seen].filter((value) => /^\d+(?:\.\d+)?$/.test(value)).map(Number).filter((value) => value >= 100);
  return figures.every((figure) => {
    if (seen.has(figure)) return true;
    // A range or date the draft joins ("3-5", "10/4/2026") that the page wrote
    // apart ("3 – 5 days", "Oct 4, 2026"): each part shown.
    const parts = figure.split(/[-/]/).filter(Boolean);
    if (parts.length > 1 && parts.every((part) => seen.has(plainFigure(part)))) return true;
    if (isDifferenceOrSum(figure, numbers)) return true;
    const own = significant(figure);
    if (own !== undefined && own.length >= 2 && digits.some((other) => other.length > own.length && roundedTo(other, own.length) === own)) return true;
    // A whole number rounded at its own scale ("about 5,400"): a shown number,
    // or the difference or sum of two, of the same size that rounds to it
    // (dev8 K1, 2026-10-04: "the figures differ by about 5,400" for 1,284,396
    // and 1,279,000 held 10 of 10 correct dones for a re-read).
    return roundedWhole(figure, numbers);
  });
}

/** A task about the present: "right now", "current", "latest", "today". */
const ASKS_NOW = /\b(now|current(?:ly)?|latest|today|live)\b/i;
/** A page's own words that what it shows is not live. */
const NOT_CURRENT = /\b(saved results?|cached|offline copy|not live|may be delayed|as of [A-Z][a-z]{2,8}\.? \d{1,2}|from \d+ (?:days?|hours?) ago|\d+ (?:days?|hours?) ago)\b/i;
/** A control that fetches the live state. */
const REFRESHES = /\b(refresh|reload|load live|view live|live (?:quote|price|page|status)|update (?:prices|status|results))\b/i;

/**
 * The refresh control to use and the page's own staleness words, when a task
 * about now meets a page that says it is not current and offers a refresh.
 * Both halves are the PAGE's words: no date arithmetic, so a page that merely
 * shows a date is never held.
 */
function staleWithRefresh(task: string, brief: Brief | undefined): { readonly ref: string; readonly label: string; readonly marker: string } | undefined {
  if (brief === undefined || !ASKS_NOW.test(task)) return undefined;
  const marker = [...brief.notices, ...brief.facts].map((text) => NOT_CURRENT.exec(text)?.[0]).find((found) => found !== undefined);
  const control = brief.elements.find((element) => REFRESHES.test(element.label));
  return marker === undefined || control === undefined ? undefined : { ref: control.ref, label: control.label, marker };
}

/**
 * Whether `figure` is the difference or sum of two shown numbers, at the
 * figure's own precision: arithmetic the brain did on what it was shown
 * ("the sources differ by 12 miles" for 2,650 and 2,638; dev2 X15, 2 of 3
 * samples held for a re-read on main ee8ced57, 2026-10-03 03:51Z).
 */
function isDifferenceOrSum(figure: string, numbers: readonly number[]): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(figure) || figure.length < 2 || numbers.length > 400) return false;
  const decimals = figure.split('.')[1]?.length ?? 0;
  const target = Number(figure);
  const same = (value: number): boolean => Number(value.toFixed(decimals)) === target;
  for (let i = 0; i < numbers.length; i += 1) {
    for (let j = i + 1; j < numbers.length; j += 1) {
      const a = numbers[i]!;
      const b = numbers[j]!;
      if (same(Math.abs(a - b)) || same(a + b)) return true;
    }
  }
  return false;
}

/** A plain number's significant digits ("1184.6" -> "11846", "0.052" -> "52"), or `undefined` for a time, date or range. */
function significant(figure: string): string | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(figure)) return undefined;
  const stripped = figure.replace('.', '').replace(/^0+/, '');
  return stripped === '' ? undefined : stripped;
}

/** Whether a whole number with trailing zeros ("5400") is a shown number, or a sum or difference of two, rounded to its own leading digits. */
function roundedWhole(figure: string, numbers: readonly number[]): boolean {
  const head = /^([1-9]\d+?)0+$/.exec(figure)?.[1];
  if (head === undefined || numbers.length > 400) return false;
  const matches = (value: number): boolean => {
    const whole = String(Math.round(value));
    return whole.length === figure.length && roundedTo(whole, head.length) === head;
  };
  for (let i = 0; i < numbers.length; i += 1) {
    if (matches(numbers[i]!)) return true;
    for (let j = i + 1; j < numbers.length; j += 1) {
      if (matches(Math.abs(numbers[i]! - numbers[j]!)) || matches(numbers[i]! + numbers[j]!)) return true;
    }
  }
  return false;
}

/** `digits` rounded half up to its first `length` digits, as digits ("11846", 3 -> "118"). */
function roundedTo(digits: string, length: number): string {
  const head = BigInt(digits.slice(0, length)) + (Number(digits[length] ?? '0') >= 5 ? 1n : 0n);
  return head.toString();
}

/**
 * The hands' choice, unable to end the run on the hands' word: no `done` or
 * `fail` the brain did not decide (the first non-terminal alternative stands
 * in, else a look at the page the brain will read), and no extract that ends
 * the run — `final` stripped, and an instruction added where one was missing,
 * because the loop treats an instructionless extract as the answer.
 */
function gateHands(choice: ModelChoice, decision: BrainDecision): ModelChoice {
  const instruction = decision.kind === 'instruct' ? decision.instruction : 'the facts on this page that bear on the task';
  const look = (action: Action): Action =>
    action.type === 'extract' ? { type: 'extract', instruction: action.instruction ?? instruction } : action;
  const terminal = (action: Action): boolean => action.type === 'done' || action.type === 'fail';
  const head = terminal(choice.action)
    ? (choice.alternatives?.find((action) => !terminal(action)) ?? { type: 'extract', instruction })
    : choice.action;
  const alternatives = (choice.alternatives ?? []).filter((action) => !terminal(action)).map(look);
  const then = choice.envelope?.then?.map((element) =>
    isRecord(element) && element['type'] === 'extract' ? { type: 'extract', instruction: typeof element['instruction'] === 'string' ? element['instruction'] : instruction } : element,
  );
  const brainNotes = envelopeOf(decision.notes);
  const envelope =
    choice.envelope === undefined && brainNotes === undefined
      ? undefined
      : { ...choice.envelope, ...(then === undefined ? {} : { then }), ...brainNotes };
  const { alternatives: _dropped, envelope: _replaced, ...rest } = choice;
  return {
    ...rest,
    action: look(head),
    ...(alternatives.length === 0 ? {} : { alternatives }),
    ...(envelope === undefined ? {} : { envelope }),
  };
}
