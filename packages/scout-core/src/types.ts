/**
 * The agent's wire types: caps, steps, results and the questions a run asks,
 * plus the time seams and the few validators both trust boundaries share.
 *
 * Everything here is what the agent loop, its model port and its browser
 * binding exchange. A host's own wire contract (sessions, scrapes, billing,
 * accounts) lives with the host and imports these.
 */

import type { SpendCapRequest } from './spend';

/* ------------------------------------------------------------------ *
 * Usage, and the shared primitives
 * ------------------------------------------------------------------ */

/**
 * Counters, all integers, plus the one money field, `credits`. The counters
 * are safe as `number`: token counts and millisecond timings sit well inside
 * binary64's exact-integer range. `credits` is not a counter and is a string.
 *
 * The meter does not. `UsageEventRow.quantity` in `@outcrawl/persistence` is an
 * exact decimal string, and a surface that aggregates usage_events into this
 * shape is crossing string -> number. That direction is fine. **The reverse
 * never is**: append the string the meter produced, never a number that has
 * been through binary64 and back. Money and meters are not floats, and a
 * rounding error found in a reconciliation months later is unattributable.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  inferenceTimeMs?: number;
  cache?: { status: 'HIT' | 'MISS' | 'DISABLED'; reason?: string };
  /**
   * What THIS call was charged, in credits: an exact decimal string, e.g.
   * `"1"` or `"4.5"`. Never a float — money is not binary64 — and never
   * recomputed: it is the sum of the `metadata.credits` of every usage row
   * the call wrote, the same strings the ledger stores and the invoice sums.
   *
   * Present on `scrape` (a live render or a cache hit — a hit is charged the
   * same `page_load`), `search` (the results plus the hits it rendered), and
   * `crawl`: each page frame states that page's charge and the closing frame
   * states the whole crawl's. It is complete on all three: the rows written
   * after the response leaves — the response's own bytes (`bytes_egress`) and
   * the residential bandwidth counted at context close (`proxy_bytes`) — are
   * recorded at zero credits for these capabilities by the rate card.
   *
   * Absent elsewhere. An agent run states its charge as the run's own
   * `credits`, because it keeps charging after the call that started it
   * returns; the control-plane routes are free.
   */
  credits?: string;
}

/** A JSON Schema object. Drives `json` extraction and agent success detection. */
export type JsonSchema = { readonly [key: string]: unknown };

/** ISO 8601 instant, e.g. "2026-08-29T11:04:00.000Z". */
export type Timestamp = string;

/**
 * Frame-qualified node reference: `<frameOrdinal>-<backendNodeId>`.
 *
 * Backend node ids come from a per-renderer-process static map, and
 * cross-origin iframes run in different renderer processes under Site
 * Isolation, so a bare backendNodeId can collide across frames.
 */
export type NodeRef = `${number}-${number}`;

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

export const CAP_NAMES = ['steps', 'budget', 'duration'] as const;

export type CapName = (typeof CAP_NAMES)[number];

/**
 * The ceiling a run is answerable to. ONE field is required — `budget` — and
 * the other two are optional, unset by default, and still honoured when a
 * caller sends them.
 *
 * ## Why one, and why it is money
 *
 * These were three required fields until 2026-09-08, and two of the three were
 * the same axis measured in different units. Credits price the run's browser
 * time (a per-minute rate), its model usage and its bandwidth,
 * so a budget bounds SECONDS as well as everything else, while a duration `D`
 * bounds seconds only and leaves the invoice unbounded. The asymmetry is what
 * decides which one survives: money is the only unit that bounds the others,
 * and it is the only unit the invoice speaks.
 *
 * The runtime had already conceded the point in code:
 * `CapLedger.budgetRemainingMs()` converts remaining credits into a
 * MILLISECOND deadline, and the settle wait is clamped by
 * `Math.min(policy, durationRemaining, budgetRemaining)` — one `Math.min` over
 * two readings of one quantity.
 *
 * `steps` bounds neither. Measured across 314 recorded bench rows, seconds per
 * step runs 4.31 / p50 8.02 / p95 14.20 / 25.09 — a 5.8x spread — so a step
 * count bounds neither time nor money to better than about 6x, and which of
 * three ceilings fires is decided by page speed rather than by intent. MCP's
 * own defaults proved it: `{steps: 12, budget: '20.00', duration: '2m'}` binds
 * at 12 / 11.1 / 15.0 steps at the median page speed and at 12 / 8.3 / 8.5 at
 * the 95th, so no two of the three agreed about when the run should stop.
 * Runaway is now caught by a DEFECT DETECTOR instead: `NO_PROGRESS_TOLERANCE`
 * ended four real wanderers at 26, 29, 35 and 34 steps of a 60-step ceiling
 * with `cappedBy` unset, so `loop-detected` fires before a step cap can and
 * never reads as the caller's own ceiling.
 *
 * ## What one cap does NOT bound, which is why `steps` still exists
 *
 * Money bounds SPEND, not ACTION COUNT: five hundred clicks in thirty seconds
 * is three credits. A caller who needs to bound what a run DOES rather than
 * what it costs sets `steps`, explicitly, and gets exactly the ceiling they
 * named. It is unset by default because nobody can pick that number for
 * somebody else's task.
 */
export interface AgentCaps {
  /**
   * Hard stop on actions taken; the task then fails cleanly with partial data
   * attached.
   *
   * Optional and UNSET BY DEFAULT. Absent means unbounded by step count, and
   * the run is then bounded by `budget` — which, being priced on time, model
   * usage and bandwidth, is a bound on all three.
   */
  steps?: number;
  /**
   * Credits as a decimal string, e.g. "2.00". Not steps, not tokens.
   *
   * **What a credit BUYS (W44, 2026-09-25).** This is a ceiling on the
   * INVOICE, and an agent run's invoice is three terms: its model usage (the
   * provider's cost, converted to credits by the run's price list), its
   * browser time at a per-minute rate for as long as the run is open — paused,
   * held and handed over included — and the bytes it relays through a proxy
   * exit at a per-byte rate. `CapLedger` prices all three through the one
   * `RunPricing` its host injects, the same price list the host bills with, so
   * the cap and the bill cannot drift.
   */
  budget: string;
  /**
   * Wall clock: `<n>ms` | `<n>s` | `<n>m` | `<n>h`, e.g. "5m".
   *
   * Optional and UNSET BY DEFAULT. Absent means unbounded by wall clock — and
   * that is not unbounded in fact, because `budget` prices time: a budget of
   * `B` credits cannot fund more than `B` divided by the per-minute rate. A
   * duration is therefore a way to bound a run in the unit a calendar speaks
   * rather than a second ceiling the product needs.
   *
   * **There is no ceiling above this and there is deliberately no longer one.**
   * A run is a job rather than a held request, so nothing in the platform cuts
   * it off at a number the caller did not choose: `caps` is the customer's dial
   * and hours are normal. The `h` unit stopped being decorative on the day the
   * job model landed.
   *
   * What used to live here was `MAX_RUN_DURATION_MS`, a 15-minute refusal that
   * read as a product limit and was nothing of the kind — it was the edge's
   * `AbortSignal.timeout` on one forwarded `fetch`, quoted back to customers as
   * policy. Deleting the held request deleted the ceiling with it; it was never
   * tuned, because there was nothing to tune.
   */
  duration?: string;
  /**
   * Purchase money (wire contract §3): what the agent may PAY merchants, as
   * exact decimal strings in one ISO 4217 currency. Separate from `budget`,
   * which is credits for running the agent. Required whenever the run holds a
   * card; requires `merchants`.
   */
  spend?: SpendCapRequest;
}

/**
 * The step ceiling as a number a ledger can compare against. An absent `steps`
 * is UNBOUNDED, which is `Infinity` and not a large integer: a sentinel is a
 * number somebody eventually renders, and `steps 4 of 500` on a status line is
 * a limit that does not exist being reported as one.
 */
export function capStepCeiling(caps: AgentCaps): number {
  return caps.steps ?? Number.POSITIVE_INFINITY;
}

/**
 * The wall-clock ceiling in milliseconds, `Infinity` when unset. Parsed with
 * the same `parseDuration` both trust boundaries validate with, so a ledger
 * and a validator cannot disagree about what `"2m"` means.
 */
export function capDurationCeilingMs(caps: AgentCaps): number {
  return caps.duration === undefined ? Number.POSITIVE_INFINITY : parseDuration(caps.duration);
}

/* ------------------------------------------------------------------ *
 * What a run reports
 * ------------------------------------------------------------------ */

/**
 * `capped` is distinct from `partial` on purpose. Both return the data
 * collected so far, but they mean opposite things to whoever is reading:
 * `capped` is the system doing exactly what the caller told it to and the fix
 * is a bigger ceiling, while `partial` is the run genuinely failing to finish
 * and the fix is somewhere in the task or the site. Collapsing them would hide
 * the one distinction a customer acts on, and `SessionOutcome` already carries
 * `capped` for the same reason.
 *
 * `SessionStatus` — what `sessions.get` reports for the same run — has no
 * `capped` member at all, so this same distinction has to survive through a
 * SECOND field there. See `SessionStatus` and `SessionOutcome` below.
 */
export type AgentStatus = 'completed' | 'partial' | 'capped' | 'failed';

/**
 * Why the run stopped. `max-*` are the caps firing; a capped run is a normal
 * outcome, not an incident.
 *
 * `gave-up` is the MODEL's verdict and `error` is OURS, and they are separate
 * members for the same reason {@link AgentStatus} keeps `capped` apart from
 * `failed`: collapsing them hides the one distinction a customer acts on. A run
 * that ends `gave-up` chose `{"type":"fail","reason":"..."}` — an action the
 * agent loop advertises on every prompt — because the task could not be done on
 * the page in front of it. A run that ends `error` hit something that went
 * wrong on our side: a lost action-lock, a reference naming no node, a step
 * that threw. One means look at the task, the other means look at us, and while
 * they shared a string neither a dashboard nor a retry loop could tell which
 * had happened — so a caller retried, forever, something that will never
 * succeed.
 *
 * Neither is a status: {@link AgentStatus} still answers "did the caller get
 * what they asked for" (`failed` with no data, `partial` with some), and this
 * answers why not.
 *
 * `cancelled` and `irreversible` are the two that are neither ours nor the
 * model's. `cancelled` is the CUSTOMER's: somebody called
 * `POST /v1/agent/{id}/cancel` and the run settled where it stood. It is not
 * `gave-up` (the model never said anything) and not `error` (nothing of ours
 * broke), and a retry loop must be able to tell it from both — retrying a run
 * a human just stopped is the one retry that is certainly wrong.
 *
 * `irreversible` is the HARNESS refusing rather than failing. A run is
 * resumable until its first irreversible action — payment submitted, order
 * placed, message sent, file handed to a third party, account created — and
 * permanently un-resumable after it, because nothing can distinguish "the order
 * went through and the confirmation page died with the browser" from "the order
 * never went through". A resume past that point REPORTS what the run knew and
 * does not act: no browser is opened, no step is dispatched, no credit is
 * spent. Not `error` (nothing of ours broke) and not `gave-up` (the model never
 * said anything) — the two it would otherwise be collapsed into, and a caller's
 * retry loop must be able to tell "never retry this" from both.
 *
 * `account-exhausted` is the ACCOUNT's, and it is the only member that is not a
 * fact about this run at all. The other nine answer "what happened to the work";
 * this one answers "the workspace ran out of credits while the work was in
 * flight". It is deliberately not `max-budget`: that names the ceiling the
 * CALLER wrote on this request, and reporting it here would tell a customer
 * their `caps.budget` was reached when it was not — the run may have spent a
 * tenth of it. It is not `cancelled` (nobody pressed anything), not `error`
 * (nothing of ours broke), and not `gave-up` (the model never said anything).
 * A run that ends this way carries NO `cappedBy`, so `resolveStatus` reports
 * `partial` or `failed` by whether data came back rather than the caller's
 * `capped` — the run was stopped by a ceiling the caller does not own.
 *
 * The enforcement rule is the one `CapLedger` already settled for `budget`: a
 * step's cost is known only after the model returns, so a run STOPS BEFORE
 * STARTING A STEP IT CANNOT AFFORD rather than pretending to be exact. The
 * residual is one step, and `AccountAllowance` in `@outcrawl/runtime` names it.
 */
export type AgentStopReason =
  | 'schema-satisfied'
  | 'task-complete'
  | 'max-steps'
  | 'max-budget'
  | 'max-duration'
  | 'loop-detected'
  | 'gave-up'
  | 'irreversible'
  | 'account-exhausted'
  | 'cancelled'
  | 'error'
  /**
   * The run held temporary secrets (`runSecrets`) and lost its machine: a
   * worker restart or a deploy. They lived only in that machine's memory, so
   * the run is settled `failed` rather than continued without them.
   */
  | 'run-secret-unavailable'
  /**
   * The run named a card provider connection (`wallet.provider`) and the
   * provider rejected its credential when the run's card was minted or read
   * (wallet providers contract §5). The run is settled `failed`, the
   * connection becomes `revoked`, and the error names the provider and the
   * connection's handle: connect it again in Wallet.
   */
  | 'wallet-provider-revoked';

/** An action a page could take, resolved but not executed. Also the cache unit. */
export interface ObservedAction {
  ref: NodeRef;
  description: string;
  /** e.g. "click", "fill", "selectOption". */
  method: string;
  args?: readonly string[];
  /** Heal path: survives a node being genuinely recreated, which the ref cannot. */
  xpath: string;
}

/**
 * A step whose extraction read only PART of the page, and how much.
 *
 * An agent extraction may spend at most a fifth of what the run's budget has
 * left, priced at the extraction model's own input rate; a page longer than
 * that is cut before it is sent — the lines carrying the request's words
 * first, then the top of the page — and the model is told it was. This is the
 * customer's half of that telling: a partial read is never silent, so a value
 * a run did not find on the part it read can be told apart from a value the
 * page does not have. Counts are of the page text; billing is the provider's
 * stated cost of what was sent.
 */
export interface ExtractCut {
  /** Characters of page the extraction had, and how many it was sent. */
  readonly pageChars: number;
  readonly sentChars: number;
  /** Lines of page the extraction had, and how many it was sent. */
  readonly pageLines: number;
  readonly sentLines: number;
  /** The input-token ceiling the cut was sized to, an estimate at 2.5 characters a token. */
  readonly ceilingTokens: number;
  /**
   * Request words (lower-case, matched as whole words) every line of which on
   * the full page was sent, and request words on no line of the full page.
   * Absent when empty. A re-read for these words cannot find more lines.
   */
  readonly wordsAllSent?: readonly string[];
  readonly wordsAbsent?: readonly string[];
  /**
   * Request words on the page none of whose lines were sent. A final
   * extraction that asks about one of them is not taken as complete: the read
   * saw no line with that word.
   */
  readonly wordsUnsent?: readonly string[];
}

/**
 * A SITE'S SECURITY CHECK THE BROWSER WORKED, and what came of it, exactly as
 * the browser's challenge solve reported it (`Outcrawl.challengeSolved` or
 * `Outcrawl.challengeFailed`). Never inferred from the page.
 *
 * - `solved`: the browser solved the check.
 * - `failed`: the browser's solve on the page did not pass; `reason` says how.
 * - `left`: the browser reached no verdict on it: no solve was attempted
 *   (`unsupported`, e.g. nothing could be bought for it and it was left to the
 *   page to clear by itself), the page replaced the checked document before
 *   the solve ended, or the check held a navigation the browser let run on.
 */
export interface StepVerification {
  readonly outcome: 'solved' | 'failed' | 'left';
  /** The check's vendor as the browser's detector named it: `recaptcha`, `cloudflare`, `hcaptcha`, … */
  readonly vendor: string;
  /** `failed` and `left`: the browser's `challengeFailed` reason. */
  readonly reason?: 'timeout' | 'rejected' | 'exhausted' | 'unsupported';
}

export interface AgentStep {
  /** 0-based. */
  index: number;
  action: ObservedAction;
  /** The model's stated reason for the action, when the model produced one. */
  reasoning?: string;
  at: Timestamp;
  /**
   * The tab this step ran on, on a multi-tab run. Absent means single-tab.
   *
   * On the wire because two consumers outside the loop cannot do their job
   * without it. A replay player has nothing else to tell tab B's mutations from
   * tab A's — every tab's renderer claims main-frame ordinal 0, so an
   * un-namespaced recording applies one tab's changes to another's tree and
   * plays back a run that never happened. And a scorer reading these frames
   * infers which origin a step acted on from the last URL it saw; once focus can
   * move between tabs, that inference is wrong without this field, and wrong
   * quietly, which is worse than absent.
   */
  tab?: string;
  /**
   * The sub-goal this step was working, on a run that stated a plan. Absent
   * when the run has no plan, or for the steps before one was stated.
   *
   * On the wire for the reason `tab` above is: a consumer scoring a run's
   * progress cannot attribute a step to an outcome without it, and the runtime
   * recorded it on `StepTrace.goal` all along while this projection dropped it.
   */
  goal?: string;
  /**
   * TOTAL BILLABLE CREDITS AFTER THIS STEP, exact, as a decimal string.
   *
   * On the wire because a run is billed WHILE IT IS STILL RUNNING and this is
   * the only frame that arrives while it runs. `caps.budget` is the only cap
   * with a default now, so "what has this cost me so far" is the question a
   * customer watching a live job asks first — and the answer was `0` for the
   * whole of a 173-second run that settled at 39.2714 credits, because nothing
   * carried the figure out of the loop until the run was over.
   *
   * Charges plus the run's time and pages at the published rate: the same
   * quantity `caps.budget` is enforced against, so a customer can see the
   * ceiling approaching instead of learning about it afterwards.
   */
  spent: string;
  /**
   * PAGE LOADS AFTER THIS STEP, across every browser the run has held.
   *
   * Required rather than optional on `AgentResult.pages`' precedent: a page is
   * a published credit, and an absent count reads as a legal zero-page run
   * rather than as a field somebody forgot. That is not hypothetical — the
   * counter a live run reported WAS zero, for 22 real page loads.
   */
  pages: number;
  /**
   * RUN TIME AFTER THIS STEP, in milliseconds on the loop's own clock — the
   * same reading {@link spent} was priced from. Not this step's own duration.
   * `AgentRun.durationMs` is copied from here while the run is live, the way
   * its `credits` and `pages` are.
   */
  durationMs: number;
  usage: Usage;
  /** Present when this step's extraction read a cut page. See {@link ExtractCut}. */
  extractCut?: ExtractCut;
  /**
   * The site security checks the browser finished working since the step
   * before this one read the page, in the order they ended: solved, failed or
   * left without a verdict. See {@link StepVerification}. Absent when none
   * ended. A check still being worked when the run stopped is on no step.
   */
  verification?: readonly StepVerification[];
}

/**
 * A sub-goal of a run, and what became of it.
 *
 * On the wire because a five-part task is five completions and one report, and
 * `status` carries only the report: a run that did four of five errands and a
 * run that did one are both `partial`, and the difference is the thing the
 * customer is paying for.
 *
 * It is also the only way anything outside the loop can measure long-horizon
 * behaviour. The runtime held all of this on `AgentResult.goals` and
 * `StepTrace.goal` and the projection dropped both, so a plan-driven run and a
 * planless one were byte-identical on the wire — which meant the harness that
 * exists to score long-horizon runs scored them the same, and an absence read
 * off that output could not distinguish "no plan was stated" from "plans do not
 * appear here". One such absence was reported as evidence during this work.
 *
 * Optional, and absent rather than `[]` when the run never stated a plan: an
 * empty array reads as "asked and answered nothing", and absent reads as "this
 * run had no plan", which is the true statement.
 */
export interface AgentGoal {
  id: string;
  goal: string;
  /** Origin hint, when the plan named one. */
  site?: string;
  status: 'pending' | 'active' | 'done' | 'failed';
  /** What closed it: the confirmation on `done`, the reason on `failed`. */
  summary?: string;
  /** The step it closed on. Absent while still open. */
  closedAtStep?: number;
}

export interface AgentResult {
  id: string;
  /** Published success rates are 42–71%, so `partial` is normal, not an error. */
  status: AgentStatus;
  /**
   * The run's answer. Partial results are returned, never discarded.
   *
   * WITH a schema this is schema-shaped, and a partially satisfied schema still
   * comes back. WITHOUT one it is the agent's closing summary of what it found,
   * so a question asked without a schema is still answered.
   *
   * OPTIONAL, and absence is not an error: it means the run had nothing to
   * report — "click the unsubscribe link" asks no question — and such a run is
   * still `completed`. Absent rather than `null` deliberately: `null` is a
   * value a schema'd extraction can legitimately produce, and overloading it
   * would make "the answer is null" and "there was no answer" the same reading.
   *
   * This field was declared required while the API shipped responses without
   * it, because nothing populated it on a schema-less run and `JSON.stringify`
   * erases an `undefined` value.
   */
  data?: unknown;
  /**
   * A schema this run DERIVED from the task, when the caller supplied none.
   *
   * SUGGESTED, NEVER ENFORCED, and the distinction is the whole design. A
   * caller's `schema` defines success — `jobs.ts` is explicit that "when the
   * caller supplied a schema, schema satisfaction defines the outcome" — and a
   * `partial` run bills exactly what a complete one does, because credits are
   * `0.1 x seconds + 1 x pages` with no outcome term and spend accrues per
   * step. So a schema WE guessed, promoted to the success criterion, would
   * relabel a run that did the job perfectly as incomplete, at full price, over
   * a field nobody asked for. This field therefore never reaches
   * `resolveStatus`, never reaches the extractor, and cannot move `status`,
   * `outcome` or `data`.
   *
   * What it is for: the caller adopting it. A dashboard renders it as the
   * column set it would get, a client pre-fills its next request with it, and
   * an agent run that returned prose can be re-run for a table without the
   * customer hand-writing JSON Schema. Absent when the caller supplied
   * `schema` — there is nothing to suggest once the contract is given — and
   * absent when the derivation produced nothing usable, which is a normal
   * outcome rather than an error.
   *
   * The derivation reads the TASK TEXT ONLY. It never sees page content, so it
   * cannot leak one customer's page into another's suggestion, and it costs one
   * model call that runs concurrently with the run rather than ahead of it.
   */
  suggestedSchema?: JsonSchema;
  usage: Usage;
  /**
   * How long the run took, from the loop's own monotonic clock.
   *
   * **This is a billed quantity, and that is why it is on the wire.** Browser
   * time is billed at 1 credit a minute for as long as the run is open; the
   * API meters `context_seconds` from this number — or from {@link billedMs}
   * when the budget could not fund all of it — and billing a customer per
   * minute while refusing to tell them the minutes is indefensible. It is also
   * the time `AgentCaps.duration` is enforced on, less any time the run was
   * parked on a human, so a `capped` run with `stopReason: 'max-duration'` can
   * be checked against the ceiling that stopped it.
   *
   * Not optional. `SessionSummary.durationMs` is required for the same reason,
   * and this field existed on the runtime's own result all along —
   * `toWireResult` simply dropped it, which is how the published per-minute
   * price came to have no minute anywhere on the customer's side of the wire.
   */
  durationMs: number;
  /**
   * Watch exactly what the money bought. This is how a charge is disputed.
   *
   * OPTIONAL, and the absence is a statement rather than a gap: this run was
   * not recorded anywhere durable. It was required until now and it lied —
   * every agent run this product completed returned a link of the shape
   * `https://outcrawl.ai/replay/r/<id>`, and `replay_sessions` held zero rows
   * from the day the table was created, because a fleet Mac has no database
   * credential and so bound an in-memory replay store that was freed when the
   * process exited.
   *
   * A host that cannot honour a link now answers `null` from
   * `ReplayStore.replayUrl` and this field is spread away — see
   * `packages/worker/src/main.ts` `replayStore()`, whose memory branch says why
   * refusing to BOOT over a missing replay credential would be an outage caused
   * by replay. An absent field reads as "this run was not recorded"; a dead
   * link reads as "your product is broken", and a customer chasing the second
   * one opens a support ticket about our routing.
   *
   * `MonitorCheck.replayUrl` above has been optional since it was written, for
   * exactly this reason and left deliberately unpopulated. That is the shape
   * this codebase already chose once.
   *
   * PRESENT means a recording EXISTS, including one still sealing. The link is
   * gated on `sessions.replay_key`, which is written the moment the recorder
   * arms and never on `replay_sessions.state`, so a run whose bytes are still
   * being flushed carries its url — that is what makes a live follow work.
   * ABSENT therefore means no recording, and {@link recordingDeclined} is what
   * says which of the two ways it came to have none.
   */
  replayUrl?: string;
  /**
   * The CALLER declined the recording, with `AgentRequest.record: false`.
   *
   * Present and `true` only on a refusal; absent otherwise. It exists because
   * an absent {@link replayUrl} had two causes and no way to tell them apart:
   * a tenant who refused a tape, and a recorder that was asked for one and
   * could not deliver — a sink that declined, a browser that would not arm, a
   * host booted with no replay credential. Those are a satisfied request and
   * an incident, and a customer disputing a charge, an auditor checking a
   * compliance boundary and an operator reading a session with no tape all
   * need the difference. This repo has shipped that same silence before, where
   * a `replayUrl` derived from the row id alone made "recorded" and "never
   * recorded" identical on the wire.
   *
   * So the three states are: `replayUrl` present — there is a recording;
   * `replayUrl` absent with this `true` — the caller refused one and no bytes
   * were ever written; `replayUrl` absent with this field absent — one was
   * wanted and not obtained, which is ours to fix.
   *
   * TYPED `true` AND NOT `boolean`. A `recordingDeclined: false` on the wire
   * would be a claim about a decision on every result that ever returns, where
   * the absence already says everything — the argument {@link replayUrl} makes
   * for being spread rather than assigned. It also means the default cannot be
   * spelled: there is no `false` to write, so nothing can express "declined
   * unless told otherwise".
   */
  recordingDeclined?: true;
  stepsUsed: number;
  /**
   * Navigations committed over the run. REPORTED, and no longer billed: an
   * agent run is priced on model usage, browser time and bandwidth (W44,
   * 2026-09-25), not per page.
   *
   * **Required, with no `?`.** A missing page count reads as a legal zero-page
   * run rather than a missing field.
   *
   * Counted in `@outcrawl/runtime` from the browser's own committed-navigation
   * counter, so a reload and a POST that re-renders the same URL count.
   */
  pages: number;
  /**
   * What this run has cost, exact, at `@outcrawl/runtime`'s own published
   * rate — `CapLedger.billing().credits` in
   * `packages/runtime/src/caps.ts`, the SAME figure `caps.budget` stopped
   * (or did not stop) the run against, carried across the worker/API
   * boundary by `packages/runtime/src/result.ts`'s `toWireResult`.
   *
   * OPTIONAL, not because a real run ever lacks one, but because this
   * interface is also what a test double constructs directly with no
   * runtime ledger behind it — `packages/api/test/support.ts`'s
   * `fakeRuntime` among others — and those callers have no figure to be
   * honest about. Absent here reads as "no ledger reported a price for this
   * run", not as "this run was free"; `packages/api/src/handlers.ts`'s
   * `settleRun` falls back to its own token-only `meter.credits()` exactly
   * for that absent case.
   *
   * Added rather than reusing `AgentStep.spent`'s existing channel: `spent`
   * is stamped once per real step, one call-site's worth of code before
   * this run's own trailing bandwidth read ever runs — see
   * `CapLedger.billedBandwidthBytes`'s own header in
   * `packages/runtime/src/caps.ts` for why a run's last dispatched action
   * can still be landing bytes when the model says `done`, and no further
   * step follows to notice them. `AgentRunRequest.stepFailures` bounds how
   * many times a step can fail, not how fresh the LAST successful step's
   * own reading is, so `spent` from the last yielded `AgentStep` is
   * reliably one read behind whatever this field reports. Measured on
   * `run_...d31bfcd6` (2026-09-23, completed, unclamped): the session's
   * `usage_events` summed to `35.201944` credits while the run's last
   * per-step `spent` — and therefore the row `packages/persistence`'s
   * GREATEST-protected `REPORT_RUN` had settled on before this field
   * existed — was `35.063744`, short by exactly the bytes that arrived
   * between that step's own read and the loop's final one.
   */
  credits?: string;
  /**
   * The milliseconds of {@link durationMs} the run was billed for, present
   * only when that is fewer. `caps.budget` is a hard ceiling on what a run is
   * billed, and the loop can only test it BETWEEN steps, so the step in
   * progress when the budget runs out keeps spending time: that time is
   * measured, stays in `durationMs`, and is not billed. Measured 2026-09-23,
   * `run_...237e28cb`: a `2.00` budget billed `2.150300` before the ceiling
   * held for time. `context_seconds` is metered from this when present.
   */
  billedMs?: number;
  stopReason: AgentStopReason;
  /** The plan and its outcomes. Absent when the run never stated one. See {@link AgentGoal}. */
  goals?: readonly AgentGoal[];
  /** Present when status is `failed`. */
  error?: string;
}

/**
 * What a finished agent run owes for MODEL USAGE, in provider dollars.
 *
 * INTERNAL: it crosses from the worker to the API's settlement in process and
 * is metered as the `model_cost_usd` usage row. It is deliberately not on
 * {@link AgentResult}, which is a customer type — customers see credits only,
 * never tokens or dollars.
 */
export interface AgentModelCharge {
  /** The provider USD the run is billed for: {@link measuredUsd}, less any the budget could not fund. */
  readonly usd: string;
  /**
   * The provider USD the run's model calls actually cost. The provider's own figure per call,
   * except the parts named in {@link estimatedUsd} and {@link subscriptionUsd}.
   */
  readonly measuredUsd: string;
  /**
   * The part of {@link measuredUsd} that is a list-price ESTIMATE and not the provider's figure:
   * calls whose response stated no cost and whose cost the provider's own usage record could not
   * supply either. The call was served and billed rather than failed over accounting (W44
   * review, finding 3). Absent when every call's figure came from the provider.
   */
  readonly estimatedUsd?: string;
  /** The host's price tier that converts it to credits (see the runtime's `ModelPricing`). */
  readonly plan: string;
  /** The customer's own model key served the run, so model usage is not billed. Always `false` today. */
  readonly byok: boolean;
  /**
   * How many of the run's model calls drew on a flat-rate subscription
   * rather than a metered key. Absent when none. Stamped on the
   * `model_cost_usd` row as `metadata.subscriptionCalls`.
   */
  readonly subscriptionCalls?: number;
  /**
   * The part of {@link measuredUsd} that is subscription calls' WOULD-BE list price: nothing
   * billed it per call, and it is counted so the run's caps bind as on a metered key. Absent
   * when none. Stamped on the `model_cost_usd` row as `metadata.subscriptionUsd`, so a
   * reconciliation against a provider subtracts it.
   */
  readonly subscriptionUsd?: string;
}

/**
 * One kind of the run's EXPLICIT charges — the agent's own `web.*` tools — as
 * the usage row the settlement writes for it.
 *
 * INTERNAL, on {@link AgentModelCharge}'s terms. `CapLedger` counts these
 * credits into `AgentResult.credits` (the figure `agent.get` reports and
 * `caps.budget` stops on), and until this field existed no row billed them:
 * production 2026-10-01, 60 lab-arm runs, 35 reported more than they billed,
 * and on 55 the gap was exactly the run's web-tool step credits.
 *
 * `quantity` is in the kind's own unit (pages, results), priced by the rate
 * card exactly as the tool priced it, so the row's credits are the credits the
 * run counted.
 */
export interface AgentToolCharge {
  readonly kind: 'page_load' | 'search_result';
  /** The capability the row is filed under: what the tool really ran. */
  readonly capability: 'scrape' | 'search';
  /** The tool, as the run's steps name it (`web.read`, `web.search`, `web.ask`). */
  readonly tool: string;
  /** Exact decimal string, in the kind's unit. */
  readonly quantity: string;
}

/** A finished run as the worker hands it to the API's settlement: the customer's result plus what it owes. */
export interface SettledAgentResult extends AgentResult {
  readonly modelCharge: AgentModelCharge;
  /**
   * The run's explicit charges as usage rows. Absent or empty on a run that
   * made none, which is every run without web tools.
   */
  readonly toolCharges?: readonly AgentToolCharge[];
}

/* ------------------------------------------------------------------ *
 * Questions a run asks a person
 * ------------------------------------------------------------------ */

/**
 * A question with a kind (wire contract §4), shared by the two that exist:
 *
 * - `approval` (SpendGuard): a purchase within every limit and above the
 *   workspace's `wallet.approvalAbove`. Answered `{ approve: true|false }`.
 * - `secret` (CardSecret, AskCard): something the run needs for one purchase
 *   and does not hold: a stored card's security code (`want: "cvc"`), a
 *   whole card (`want: "card"`) or a billing profile (`want: "details"`).
 *   Answered ONLY by adding a run secret named `for` (an intent minted with
 *   that name and kind `card_field`, `card` or `details`, or
 *   `POST /v1/agent/{id}/secrets`); an `/answer` carrying a value is refused
 *   `secret_in_answer`.
 *
 * Money is the exact decimal string of `caps.spend`'s currency, never a number.
 */
export type AgentQuestion =
  | {
      readonly kind: 'approval';
      readonly purchase: string;
      readonly merchant: string;
      readonly amount: string;
      readonly currency: string;
    }
  | {
      readonly kind: 'secret';
      /** What the run needs: one card field, a whole card, or a billing profile. */
      readonly want: RunSecretWant;
      /**
       * The card field wanted, present exactly when `want` is `cvc` (and then
       * `"cvc"`): kept beside `want` so a client written before `want` still
       * reads the security-code ask it always did.
       */
      readonly field?: string;
      /**
       * The run secret name the answer must carry. For `card` and `details`
       * the platform chooses it (`card`, `details`, else suffixed `_2`, `_3`),
       * never colliding with a name the run was granted or holds.
       */
      readonly for: string;
      /** The open purchase, when one is open; omitted (never null) otherwise, with its record below. */
      readonly purchase?: string;
      readonly merchant?: string;
      readonly amount?: string;
      readonly currency?: string;
      /** The person-facing sentence, written by the platform. */
      readonly text: string;
    };

/** What a `secret` question asks for (see {@link AgentQuestion}). */
export type RunSecretWant = 'cvc' | 'card' | 'details';

/** The wants a run's model may ask a person for itself: a whole card, or a billing profile. */
export type RunSecretAskWant = Exclude<RunSecretWant, 'cvc'>;

export const RUN_SECRET_ASK_WANTS = ['card', 'details'] as const satisfies readonly RunSecretAskWant[];

/* ------------------------------------------------------------------ *
 * Time, injected
 * ------------------------------------------------------------------ */

/**
 * The time seam. Every wait and every deadline goes through this, so tests
 * drive a virtual clock instead of sleeping.
 *
 * `now` is a monotonic millisecond reading for measuring elapsed time. It is
 * **not** a wall-clock timestamp and must never be persisted or compared across
 * processes — use `Timestamp` for anything that outlives the process.
 *
 * This lives here rather than in the first package that needed it because
 * three now need one independently — the render pipeline, the agent loop's
 * duration cap, and the supervisor's heartbeat — and none of them should take a
 * dependency on another's package to obtain a two-method interface.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The real one. `performance.now()` rather than `Date.now()`, because a
 * deadline must not move when NTP steps the wall clock.
 */
export const systemClock: Clock = {
  now(): number {
    return performance.now();
  },
  sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/**
 * Wall time, injected. Epoch milliseconds, for values that are **stored** or
 * compared across processes: when a cache entry was resolved, when a lease was
 * taken, when a profile was last seen.
 *
 * Deliberately a separate name from {@link Clock}, and deliberately not spelled
 * `clock`. The two have the same shape and opposite contracts, so anything that
 * unifies them by pattern-matching the word is a bug that does not announce
 * itself: `new Date(performance.now())` is a valid Date somewhere in 1970, and
 * every persisted timestamp is quietly wrong while every test still passes.
 *
 * Choosing between them: does the value outlive the process? Wall. Is it the
 * distance between two moments? Monotonic — and then it must be {@link Clock},
 * because wall time steps backwards when NTP corrects it.
 */
export interface WallClock {
  /** Epoch milliseconds. Subject to NTP steps; never use it for a duration. */
  now(): number;
}

export const systemWallClock: WallClock = {
  now(): number {
    return Date.now();
  },
};

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Credits as a decimal string: "2", "2.0", "2.00". Never a float. */
const BUDGET_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Wall clock: "500ms", "30s", "5m", "2h". */
const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;

const DURATION_MULTIPLIER: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * `"5m"` -> 300000. Throws on anything {@link DURATION_PATTERN} rejects.
 *
 * Canonical here rather than in `@outcrawl/runtime`, which is where it used to
 * live, because the grammar has to be enforced at BOTH trust boundaries — the
 * edge validator and the loop's own `validateCaps` — and a second parser beside
 * a second copy of the pattern is how the two come to disagree about what
 * `"90m"` means.
 */
export function parseDuration(spec: string): number {
  const match = DURATION_PATTERN.exec(spec);
  if (match === null) {
    throw new TypeError(`duration must be <n>ms | <n>s | <n>m | <n>h, got ${JSON.stringify(spec)}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  return amount * (DURATION_MULTIPLIER[unit] ?? 1);
}

/**
 * Checks one `caps.duration` against the grammar, returning the error to report
 * or `undefined`.
 *
 * ── THERE IS NO CEILING HERE ANY MORE, AND THAT IS THE POINT ─────────────────
 *
 * This function used to refuse anything over `MAX_RUN_DURATION_MS` — 900,000,
 * spelled `15m` to customers — and the refusal was honest about its own
 * reasoning: the edge forwarded one `fetch` per REST call under an
 * `AbortSignal.timeout`, that signal bounded the whole call, and a run that
 * outlived it had its socket cut mid-stream with no terminal frame. So the
 * platform could not deliver a longer run and said so.
 *
 * A job has no held request. Nothing forwards, nothing times out, and the
 * number that used to be quoted as a product limit was never one — it was the
 * shape of the transport, wearing policy's clothes. `docs/AGENTS.md`: "the
 * refusal currently quoting it is a patch over that and is deleted when this
 * lands, not tuned." Deleted, not tuned. `caps` is the customer's dial, hours
 * are normal, and `"12h"` now means twelve hours.
 *
 * The function survives the ceiling because its OTHER reason outlives it:
 * `validateAgentRequest` here and `validateCaps` in `@outcrawl/runtime` must
 * refuse a malformed duration with the same sentence, so a caller who hits the
 * loop directly gets the same message as one who came through HTTP. Returns
 * rather than pushes, for that.
 *
 * ABSENT IS LEGAL, and is checked here rather than at each caller for the same
 * reason the grammar is: `caps.duration` is optional as of 2026-09-08 — see
 * {@link AgentCaps} — and two validators deciding separately whether absence
 * is allowed is the drift this function exists to prevent.
 */
export function capDurationError(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !DURATION_PATTERN.test(value)) {
    return 'caps.duration must be a wall-clock string such as "5m"';
  }
  return undefined;
}

/**
 * Checks one `caps.budget` against the grammar — an exact decimal credit
 * string with at most two places — returning the error to report or
 * `undefined`.
 *
 * Grammar only. The smallest ceiling that can buy anything is a fact about a
 * price list, and the price list is the host's, so a host that refuses budgets
 * under a floor applies that floor itself after this passes. The grammar stays
 * here, in one place, so every boundary refuses a malformed budget with the
 * same sentence.
 */
export function capBudgetError(value: unknown): string | undefined {
  if (typeof value !== 'string' || !BUDGET_PATTERN.test(value)) {
    return 'caps.budget must be a decimal credit string such as "2.00"';
  }
  return undefined;
}

/**
 * The one canonical object guard. This package is the contract every agent
 * package imports, so it carries no schema validator, and this guard is
 * defined here once rather than recreated at each boundary. It proves an object and nothing more; fields stay
 * `unknown` and are checked individually below.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
