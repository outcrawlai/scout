/**
 * The client. Satisfies `AgentDeps.model` and `PipelineDeps.extractJson`.
 *
 * ── The action cache is not here ────────────────────────────────────────────
 *
 * A repeat run's replay of a resolved action is the host's, as a decorator
 * around the whole `ModelPort` (the fleet's wraps the harness port). This client
 * always asks the model, and says so on every choice: `cache` is a MISS whose
 * reason is {@link NO_ACTION_CACHE}, which such a decorator overwrites with its
 * own verdict.
 *
 * ── Structured output, not parse-and-hope ────────────────────────────────────
 *
 * Both calls this client makes are schema-constrained at the provider. The agent
 * step is constrained to the action grammar built from `ACTION_TYPES`, so the
 * vocabulary cannot drift from `@outcrawl/runtime`'s; the extraction is
 * constrained to the caller's schema, reduced to the provider-supported subset.
 * The reply is then parsed and validated against the *original* schema, and a
 * failure at either point is an error. It is never an empty object: an extraction
 * that returns `{}` because the model wrote prose is indistinguishable from a
 * page that genuinely had nothing on it, and one of those is a bug we would never
 * find.
 *
 * ── The prompt this client sends ─────────────────────────────────────────────
 *
 * `AgentPrompt.text` is already rendered by `renderPrompt`, and its last line
 * asks for "exactly one action as JSON". The reply contract here is an object
 * with an `actions` array, because `observe()` is specified to return everything
 * the snapshot supports and one action would make it useless. The system prompt
 * reconciles the two explicitly rather than leaving the model to guess which
 * instruction wins: the chosen action is first, alternatives follow. Nothing in
 * `@outcrawl/runtime` is modified — the loop reads `choice.action`, and
 * `observe()` reads `choice.alternatives` too.
 *
 * ── What a call cost is the provider's figure ────────────────────────────────
 *
 * Every call is recorded in the {@link CostLedger} at the USD the provider
 * stated for it (`ModelResponse.costUsd`), failures included — a refusal, a
 * truncation or a reply that failed the schema was billed, and carries its
 * cost on the error. This client does not convert dollars to credits: the
 * runtime reads the session's ledger total and prices it at the run's plan
 * (`modelCredits` in `@outcrawl/core`), so every call a step made — retries,
 * corrections and failovers included — reaches `AgentCaps.budget`, not just
 * the one whose reply was used.
 */

import {
  ZERO_CREDITS,
  capDurationCeilingMs,
  compareDecimal,
  isRecord,
  systemClock,
  type Clock,
  type ExtractCut,
  type JsonSchema,
  type Usage,
} from '@outcrawl/scout-core';
import {
  ACTION_TYPES,
  parseEnvelope,
  serializeTree,
  unknownMark,
  validateAction,
  withResolvedMark,
  type Action,
  type AgentPrompt,
  type AxNode,
  type AxTree,
  type Envelope,
  type ExtractContent,
  type ExtractInput,
  type Mark,
  type ModelChoice,
  type ModelPort,
} from '@outcrawl/runtime';

import {
  CostLedger,
  callOutcomeOf,
  type CallOutcome,
  type CallPurpose,
  type CostEntry,
  type ProviderCall,
} from './ledger';
import {
  ModelCancelledError,
  ModelConfigError,
  ModelError,
  ModelProviderError,
  requestIdOf,
  ModelSchemaError,
  ModelTimeoutError,
  ModelUnusableError,
  ZERO_TOKENS,
  toCoreUsage,
  type ModelImage,
  type ModelProvider,
  type ModelResponse,
  type ModelTurn,
  type ReasoningConfig,
  type TokenUsage,
} from './provider';
import { boundPage, extractCeiling } from './extract-bound';
import { costOf, ratesIn, type RateCard } from './rates';
import { constrainSchema, validate } from './schema';

/* ------------------------------------------------------------------ *
 * The reply contract
 * ------------------------------------------------------------------ */

/** A viewport point in CSS pixels, the space `page.look` answers in. */
const POINT_SCHEMA = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;

/**
 * One action, as a schema.
 *
 * A single flat object with a `type` enum rather than a ten-branch `anyOf`, and
 * that is a cost decision as much as a style one: the provider counts
 * "parameters that use `anyOf` or type arrays" against a limit of 16 and warns
 * that they "create exponential compilation cost", while optional parameters are
 * limited to 24. Flat costs eleven optional parameters and no unions. The
 * per-type argument rules are not expressible this way, which is fine —
 * `validateAction` enforces them against the tree, which is the only place they
 * can be checked at all.
 *
 * DECLARED ONCE AND REFERENCED THREE TIMES, through `$defs`. `actions`, `then`
 * and `also` all carry this same element, and inlining it three times would
 * declare 33 optional parameters where one definition declares 11 — over the
 * cap above, for three copies of one object that must never drift apart.
 * Non-recursive: an element carries no `then` and no `also`, because those are
 * properties of the REPLY and not of an action. That keeps this inside the
 * "recursive schemas are not supported" line this package's `schema.ts` quotes
 * from the provider's own documentation.
 */
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...ACTION_TYPES] },
    /**
     * The wire form, copied from the `[frame-backendNode]` the tree prints —
     * one string, not a struct of two integers. The struct made the model
     * re-type the frame ordinal on its own, and on a long-lived browser, whose
     * ordinals are two digits, it wrote the wrong one in 15 of 24 first
     * answers. See `resolveRef` in `@outcrawl/runtime`'s `actions.ts` for the
     * measurement.
     */
    ref: {
      type: 'string',
      description: 'Copied verbatim from the [frame-backendNode] shown beside the node, without the brackets.',
    },
    text: { type: 'string' },
    value: { type: 'string' },
    key: { type: 'string' },
    url: { type: 'string' },
    dx: { type: 'integer' },
    dy: { type: 'integer' },
    /**
     * `wait`'s duration. Named here for the standing rule below: a verb in
     * `ACTION_TYPES` is unemittable until every field it needs is declared.
     */
    seconds: { type: 'integer' },
    instruction: { type: 'string' },
    /**
     * `extract`'s statement that it records the answer; see `answersTask` in
     * `@outcrawl/runtime`. Named here for the reason the `file` block below
     * gives: a field the loop's schema prompt asks for is unemittable under
     * `strict: true` until this object names it.
     */
    final: { type: 'boolean' },
    summary: { type: 'string' },
    /**
     * `done`'s list of the task's conditions it did not confirm. Declared for
     * the standing rule below: the loop's evidence rule asks for it, and under
     * `additionalProperties: false` an undeclared field is unemittable.
     */
    unconfirmed: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    /**
     * WITHOUT THIS, `focusTab` AND `closeTab` WERE UNEMITTABLE.
     *
     * Both are in `ACTION_TYPES` and both are offered to the model by the
     * loop's `TAB_GRAMMAR`, and neither could ever carry its argument: the
     * enum let the model name the action, `additionalProperties: false`
     * forbade the one field it needs, and `validateAction` then refused it as
     * "tab must be a non-empty string" — a spent step and a slice of
     * `stepFailures` for a grammar we published and did not supply. So a run
     * could open tabs and never focus or close one, which is multi-tab driving
     * not working at all rather than working badly.
     *
     * Also what makes an `also` element tab-qualified. One property, both
     * jobs: the tab an action is aimed at is the same fact whether the action
     * is the head of the reply or one of its siblings.
     */
    tab: { type: 'string' },
    /**
     * The five properties the verbs added on 2026-09-08 need, and the reason
     * this block exists at all is the comment directly above it.
     *
     * `attachFile`, `ask` and `callTool` landed in `ACTION_TYPES`, were
     * advertised to the model by the loop's grammars and dispatched by the
     * loop — and were UNEMITTABLE, because `additionalProperties: false` plus
     * `strict: true` on the provider means a property this object does not
     * name cannot appear in a reply at all. So the model could read a grammar
     * telling it to attach a file, could not produce one, and spent a step and
     * a slice of `stepFailures` being told "file must be a non-empty string".
     *
     * That is the SAME defect the `tab` comment above records, one property-set
     * later, and it cost three whole features rather than one: uploads,
     * human-in-the-loop and MCP tool calls each had a working route, a working
     * verb and a green suite, and nothing the MODEL did could reach any of
     * them. Found by reading this schema against `ACTION_TYPES` while writing
     * the runtime README, not by any test — every suite in the repo drives
     * `validateAction` with an object it built itself, so none of them can see
     * a property the wire refuses to carry.
     *
     * The standing rule this file needs and does not have: a verb added to
     * `ACTION_TYPES` is not emittable until every field of its `Action` member
     * is named here. There is no compiler check for that today — the schema is
     * a literal and the union is a type — which is why it has now regressed
     * twice.
     */
    file: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    tool: { type: 'string' },
    arguments: { type: 'object', additionalProperties: true },
    /**
     * `purchase.begin`'s checkout total and its ISO 4217 code, declared for
     * the standing rule above. These two bring this object to the provider's
     * cap of 24 optional parameters, so `purchase.end` adds none: it carries
     * its outcome in `value`, its final amount in `amount` and its order
     * reference in `text` (`PurchaseEndAction` in `@outcrawl/runtime`). There
     * is no `merchant`: the merchant is the page's top-level site, never a
     * field the model can write.
     */
    amount: { type: 'string' },
    currency: { type: 'string' },
    /**
     * `click`'s and `hover`'s viewport point and `drag`'s two ends, declared
     * for the standing rule above: without them those verbs are in the enum
     * and ungrammatical. A drag end is a ref string OR a point, and that is the one
     * union in this object — two `anyOf`s of two branches each, against the
     * provider's cap of 16. Declaring `from` and `to` as objects carrying an
     * optional `ref`, `x` and `y` instead would have avoided the union and
     * cost six more optional parameters, past the cap of 24 this object is
     * counted against. The point is written out three times rather than put in
     * `$defs`, because this object is also validated standalone (see the
     * `validate(candidate, ACTION_SCHEMA)` in `choose`), where a `$ref` into
     * the reply's `$defs` would not resolve.
     */
    at: POINT_SCHEMA,
    from: { anyOf: [{ type: 'string' }, POINT_SCHEMA] },
    to: { anyOf: [{ type: 'string' }, POINT_SCHEMA] },
  },
  required: ['type'],
  additionalProperties: false,
} as const;

/** Points `actions`, `then` and `also` at the one {@link ACTION_SCHEMA}. */
const ACTION_REF = { $ref: '#/$defs/action' } as const;

/**
 * The whole reply. `actions[0]` is the choice; the rest are alternatives.
 *
 * ── The envelope, and why it is HERE rather than on the action ─────────────
 *
 * `Envelope` — `plan`, `finding`, `ruledOut`, `goal`, `then`, `also` — was
 * declared in `@outcrawl/runtime` and emittable by nobody. Under strict
 * structured output an undeclared property is not discouraged, it is
 * ungrammatical: the sampler cannot produce it. `additionalProperties: false`
 * here and on `ACTION_SCHEMA`, plus `strict: true` in `./chat-completions`, meant
 * that for the whole life of this client:
 *
 *   - `FINDING_RULE` was on EVERY prompt of EVERY run, telling the model that a
 *     finding "is the only record that survives this page", and the model had
 *     no grammar in which to answer. `AgentResult.findings` was always empty.
 *   - `PLANNING_RULE` asked for a plan on every run over 12 steps, and
 *     `planOwed` then DECLINED the first `done` for want of one — a wasted step
 *     and a prompt block, every long run, for a field that could not exist.
 *   - `then` never arrived, so the motor program was identical to the control
 *     by construction and any measurement of it measured this schema.
 *
 * Nothing failed and nothing logged, because a model that cannot answer looks
 * exactly like a model with nothing to report.
 *
 * ON THE REPLY rather than on the action, which is also what makes it
 * affordable. The loop reads the envelope from `ModelChoice.envelope` first and
 * the raw action object second (`loop.ts`, `{ ...parseEnvelope(choice.action),
 * ...choice.envelope }`), and the explicit field wins — this is the seam that
 * comment describes and that nothing had ever taken. Per-action instead would
 * declare the six envelope properties on all three referenced positions and
 * blow the 24-parameter cap; reply-level declares 20 of 24, with 0 of the 16
 * `anyOf` budget spent. Counted, not assumed.
 */
export const AGENT_REPLY_SCHEMA = {
  type: 'object',
  $defs: { action: ACTION_SCHEMA },
  properties: {
    reasoning: { type: 'string' },
    actions: { type: 'array', minItems: 1, items: ACTION_REF },
    /** A fact worth more than the page it came from. */
    finding: { type: 'string' },
    /** An approach that did not work, so a later step does not repeat it. */
    ruledOut: { type: 'string' },
    /** Closes a sub-goal. */
    goal: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['done', 'failed'] },
        summary: { type: 'string' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    /** States the plan, or replaces it. Merged by id. */
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          site: { type: 'string' },
        },
        required: ['id', 'goal'],
        additionalProperties: false,
      },
    },
    /** The rest of a motor program: this tab, after the head action. */
    then: { type: 'array', items: ACTION_REF },
    /** Actions for OTHER tabs, in this same step. Each names its `tab`. */
    also: { type: 'array', items: ACTION_REF },
  },
  required: ['actions'],
  additionalProperties: false,
} as const;

/**
 * Exported so a measurement can send the REAL prompt. `WIDGET_SYSTEM_PROMPT` in
 * `@outcrawl/captcha` is exported for the same reason and by the same argument:
 * a benchmark that retypes the prompt measures the retype.
 */
export const AGENT_SYSTEM_PROMPT = [
  'You are the decision step of a browser agent. The page is frozen while you answer, so every',
  'node reference in the tree you are shown is still valid when your answer arrives.',
  '',
  'Answer with an object: {"reasoning": "...", "actions": [...]}.',
  'The user message asks for exactly one action. Put that action first in `actions`. After it, add',
  'any further actions the same snapshot supports, most useful first — a caller reviewing the page',
  'without executing anything reads the whole list. If only one action makes sense, send one.',
  '',
  'ONLY `actions[0]` IS PERFORMED. The rest of `actions` are alternatives — suggestions for a',
  'reader, never executed. If you want a second action actually carried out, it goes in `then`',
  '(the same tab, straight after) or in `also` (a different tab, at the same time), and only when',
  'the user message offers you that field. Putting work you need done into `actions[1]` is the one',
  'way to have it silently not happen.',
  '',
  'The other top-level fields are offered by the user message when they apply, and they cost you no',
  'extra step: `finding` for a fact you will need after this page is gone, `ruledOut` for an',
  'approach that did not work, `plan` and `goal` for a task with more than one outcome.',
  '',
  'A `ref` is copied verbatim from the [frameOrdinal-backendNodeId] shown beside a node. Never',
  'invent one, never guess an id you were not shown, and never act on a node that is not in the',
  'tree: an action naming an unknown node is rejected and the step is wasted.',
].join('\n');

/**
 * The cache verdict on every choice this client makes: it always asks the
 * model. A host's action-cache decorator around the port overwrites it with
 * its own. See the module comment.
 */
export const NO_ACTION_CACHE: NonNullable<Usage['cache']> = Object.freeze({
  status: 'MISS',
  reason: 'no action cache is attached to this client',
});

const { reasoning: _reasoningProperty, ...REPLY_PROPERTIES_WITHOUT_REASONING } = AGENT_REPLY_SCHEMA.properties;

/**
 * {@link AGENT_REPLY_SCHEMA} without `reasoning`, for a model whose
 * `ModelClientOptions.replyReasoning` is `false` (OC-285, OC-286).
 *
 * Measured 2026-10-01 on a subscription wire, the same prompt and tree each
 * time: with `reasoning` in the schema, a frontier model ended
 * `stop_reason: "refusal"`, `stop_details.category: "reasoning_extraction"`
 * ("restrictions on reverse engineering or duplicating model outputs") on 6 of
 * 6 text-JSON calls and 4 of 6 tool calls; with the property removed, 0 of 6
 * tool calls. The same refusal text ended 38 calls across 23 of 100 runs of
 * that model in a full bench run through the gateway (OC-285). So the property
 * is not asked for, on every provider, rather than renamed past the
 * classifier: the agent loop treats `reasoning` as optional and runs without
 * it.
 */
export const AGENT_REPLY_SCHEMA_WITHOUT_REASONING = {
  ...AGENT_REPLY_SCHEMA,
  properties: REPLY_PROPERTIES_WITHOUT_REASONING,
} as const;

/** {@link AGENT_SYSTEM_PROMPT} without `reasoning`. See {@link AGENT_REPLY_SCHEMA_WITHOUT_REASONING}. */
export const AGENT_SYSTEM_PROMPT_WITHOUT_REASONING = AGENT_SYSTEM_PROMPT.replace(
  'Answer with an object: {"reasoning": "...", "actions": [...]}.',
  'Answer with an object: {"actions": [...]}.',
);

/** Exported for measurement. See {@link AGENT_SYSTEM_PROMPT}. */
export const EXTRACT_SYSTEM_PROMPT = [
  'You extract structured data from one web page. The page is given to you below in whichever',
  'representation the caller had: rendered markdown, or the filtered accessibility tree the',
  'browser reports. Read whichever you are given; do not assume the other one exists.',
  '',
  'Return only data the page states. A field the page does not answer is omitted when the schema',
  'allows it and null when the schema allows null — never guessed, never inferred from the page',
  'topic, and never filled with a plausible example. A wrong value is worse than a missing one:',
  'the caller can see a missing field and cannot see a fabricated one.',
].join('\n');


/**
 * `ExtractInput.schema: null` still has to ask for something a reply can fail
 * against. This is that something: one string field, described by the caller's
 * own instruction, which {@link ModelClient.extract} unwraps before returning.
 *
 * Not `additionalProperties: true` and not a bare string reply: an unconstrained
 * object cannot be validated, so a model writing prose where data was asked for
 * would come back as a success. This way the grammar forces one field and
 * `validate` still has something to check.
 */
const FREE_TEXT_SCHEMA = {
  type: 'object',
  properties: { data: { type: 'string' } },
  required: ['data'],
  additionalProperties: false,
} as const;

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * Whose spend this is. One client per session, so attribution is structural.
 *
 * ## `sessionId` is the router's id, and nothing else is acceptable
 *
 * Required already — no `?`, no default — which is why this hop needed no
 * rewiring when the rest of the request path was correlated. What it needed was
 * this paragraph, because "required" does not say *which* string, and a
 * plausible-looking local id here would be worse than the field being absent:
 * a per-run `randomUUID` satisfies the type, prices correctly, and produces a
 * cost ledger that cannot be joined to the session that spent the money.
 *
 * On any path serving a customer it MUST be the `sess_…` the router minted
 * before the session existed. That one string already names the
 * browser-concurrency lease in the Quota Durable Object, the signed session
 * ticket, `usage_events.session_id`, the worker's `cdp.session_open` line and
 * `@outcrawl/api`'s `api.request` line. So {@link CostLedger.totalsFor} takes
 * an id a support ticket can quote, and "what did this customer's failing
 * agent run cost us in inference" is one lookup instead of a reconstruction
 * from timestamps.
 *
 * A run with no session at all — `scripts/verify-live-model.ts`, a smoke test —
 * names itself (`'verify-live'`), which is why the field is `string` and not
 * `string | null`: the ledger keys `#bySession` by it, and there is always
 * exactly one thing a client's calls belong to even when that thing is a
 * probe. `accountId: null` is how such a run says it has no customer, and
 * that field IS nullable for exactly that reason.
 *
 * There is deliberately no second id minted here. A model-call id already
 * exists and is the PROVIDER's — `CostEntry.requestId`, read off the
 * `request-id` response header — and it is for a support ticket with the provider,
 * not for correlating our own hops. Two of our own ids for one session would
 * mean an operator has to guess which one the customer is quoting.
 *
 * ## What must never be routed through this field
 *
 * This is the hop where the radioactive material lives. An `AgentPrompt`
 * carries a rendered accessibility tree: page text, form labels, input values,
 * URLs. Some of it is a customer's session tokens and passwords by the time a
 * login flow is three steps in. None of that may reach `sessionId`, and the
 * temptation is real because a cache key and a correlation id look similar
 * from a distance — `CacheKeyInput` hashes the tree ON PURPOSE, under an
 * account scope, and that is a different thing with different rules.
 *
 * So: no URL, no page text, no tree hash, no instruction, no form value, no
 * credential, and nothing derived from any of them. `sessionId` is an opaque
 * random name whose only job is to be identical to the same name at every
 * other hop. See `RequestIdentity` in `@outcrawl/api` for the boundary stated
 * once, in full.
 */
export interface SessionAttribution {
  readonly sessionId: string;
  /**
   * `null` shares action-cache entries across every account, which is only safe
   * when no resolved action can carry an argument derived from one account's
   * data — see `CacheKeyInput.accountId`. A real session passes its account.
   */
  readonly accountId: string | null;
}

export interface ModelClientOptions {
  readonly provider: ModelProvider;
  /** Names the model exactly. Must have a rate-card entry. */
  readonly model: string;
  /** A cheaper model for extraction, when a deployment wants one. */
  readonly extractModel?: string;
  /**
   * The system turn `extract` sends, for a client bound to a role whose
   * extraction is not an extraction.
   *
   * Absent means {@link EXTRACT_SYSTEM_PROMPT}, which is what every existing
   * caller gets and what every existing caller wants. The one client that sets
   * it is the `extract-program` role, which passes
   * `EXTRACT_PROGRAM_SYSTEM_PROMPT` from `@outcrawl/render`'s `site-schema.ts`:
   * same transport, same schema constraint, same accounting, opposite
   * instruction.
   *
   * THE WORDING DELIBERATELY DOES NOT LIVE IN THIS PACKAGE. It has to be the
   * same string the ground-truth check grades against, and that check is
   * `@outcrawl/render`'s. A second copy here would drift, and the first thing
   * it would break is a benchmark that measured a contract production does not
   * use. This package owns the SEAM; render owns the words.
   *
   * AN OPTION ON THE CLIENT AND NOT A FIELD ON `ExtractInput`, deliberately.
   * `ExtractInput` is `@outcrawl/runtime`'s type and is shared by every
   * extraction caller in the repo; a per-call system override there would let
   * any request rewrite the contract, and the contract is this package's, not
   * the caller's — the reason `ModelRequest.system` is documented as "Ours, not
   * the caller's". One client per role already exists, so the role's prompt
   * belongs where the role's model does.
   */
  readonly extractSystemPrompt?: string;
  /**
   * Sampling temperature for BOTH calls this client makes. Absent sends
   * nothing and takes the provider's default, which is what every caller got
   * before `ModelRequest.temperature` existed.
   *
   * SET IT TO 0 FOR ANY ROLE WHOSE ANSWER IS PERSISTED OR REPLAYED, and the
   * `extract-program` role is the one that makes this urgent rather than tidy.
   * An extraction is consumed once and thrown away, so a sampled answer costs
   * one page. A DERIVATION IS CACHED AND SERVED TO EVERY CUSTOMER HITTING THAT
   * TEMPLATE, so sampling reintroduces, at the one call that gets persisted,
   * exactly the non-determinism the selector cache exists to remove: two
   * workers deriving the same template can produce two different programs and
   * neither is detectably at fault. Ground truth refuses a BAD program, so
   * this is not a correctness hole; it is a reproducibility one, which is
   * quieter and harder to diagnose.
   *
   * Measured elsewhere on the same lever: on the vision role, the provider
   * default scored 17/20 against 20/20 at `temperature: 0` over 20 trials of
   * one unchanging image — three answers in twenty lost to sampling on a task
   * with one right answer.
   *
   * NOT DEFAULTED TO 0 HERE, deliberately, though every call this fleet makes
   * is schema-constrained and 0 is right for all of them. This option changes
   * what the actuator and the extractor send, and neither has been measured at
   * 0 on our shapes; a default would change production behaviour for two roles
   * on the strength of a result from a third. It is set per role in
   * `worker/src/model-deps.ts`, where the choice is visible, and the roles that
   * have evidence get it first.
   */
  readonly temperature?: number;
  readonly session: SessionAttribution;
  /** Shared across sessions is fine; entries carry their own attribution. */
  readonly ledger?: CostLedger;
  /**
   * The host's rate card. Read for estimates only — a withdrawn call's list
   * price and an extraction's `maxUsd` cut — never for a bill, which is the
   * provider's own figure. Absent, or a model not on it, makes no estimate.
   */
  readonly rates?: RateCard;
  /**
   * Whether the ACTION reply asks for the `reasoning` field. Default `true`.
   * `false` sends {@link AGENT_REPLY_SCHEMA_WITHOUT_REASONING} and
   * {@link AGENT_SYSTEM_PROMPT_WITHOUT_REASONING}, for a model whose provider
   * refuses a reply schema that asks for its reasoning. See the first.
   */
  readonly replyReasoning?: boolean;
  /** Per-call ceiling in ms. Default 60s, against an observed 5-15s call. */
  readonly timeoutMs?: number;
  /**
   * The ceiling on an ACTION call (`choose`) alone, when it should be shorter
   * than {@link timeoutMs}. Absent means {@link timeoutMs}.
   *
   * Separate because the two calls have different tails. An action reply is one
   * small object and its latency is the model's; an extraction reply is the
   * customer's own data, up to {@link DEFAULT_EXTRACT_TOKENS} of it, and a
   * ceiling sized to an action would refuse a large extraction that was
   * answering normally. A harness sets this per model from production latency:
   * see `PlanModel.actionDeadlineMs` in `./harness`.
   */
  readonly actionTimeoutMs?: number;
  readonly maxActionTokens?: number;
  readonly maxExtractTokens?: number;
  /**
   * How hard the model may think on the ACTION call — `choose`, once per step.
   *
   * Absent sends nothing and gets the provider's default, which is what this
   * client did before the field existed. Set, it is the largest cost lever in
   * this package: see {@link ReasoningConfig} for the measurement, and note
   * that the action call is the one that runs every step against a bounded list
   * of actionable nodes, which is not the shape that needs 2,284 reasoning
   * tokens to answer.
   *
   * SEPARATE FROM {@link extractReasoning} ON PURPOSE. The two calls are
   * different jobs and the argument runs opposite ways — see that field.
   */
  readonly actionReasoning?: ReasoningConfig;
  /**
   * How hard the model may think on the EXTRACT call.
   *
   * `extract` serves two callers with one shape: the render pipeline's JSON
   * extraction, and — through `HarnessModelPort` — a chain's PLANNER, when it
   * has one, which reasons over a `PlanDigest` to choose a multi-step strategy.
   * That second one IS a reasoning task, it runs at a fraction of the actuator's
   * call volume, and cutting it would be optimising away the thing a planner
   * exists to provide. So this defaults to absent and should stay absent unless
   * somebody measures the planner specifically.
   */
  readonly extractReasoning?: ReasoningConfig;
  /**
   * The rung to RE-ASK at when the floor's reply could not be used.
   *
   * Absent disables escalation entirely and this client behaves exactly as it
   * did before the field existed: one call per step at
   * {@link actionReasoning}.
   *
   * ── Why reactive, and why here ──────────────────────────────────────────────
   *
   * "Reasoning should only trigger when something requires reasoning,
   * automatically. And then turn off again." A reactive trigger cannot be wrong
   * about whether thinking was needed, because the cheap reply already failed:
   * `validateAction` rejected the reference, the schema did not hold, or the
   * provider truncated. A predictive trigger — count the ambiguous candidates
   * before calling — is free but can starve a step that needed thought, so it is
   * not what this field does.
   *
   * IT MUST NOT SPEND A STEP, which is why it lives in this method and not in
   * the loop. At this point `AgentDeps.perform` has not been called, the page is
   * still frozen, every `ref` in the prompt is still valid and `stepFailures`
   * has not incremented. A retry one layer up would cost a step, and making a
   * recoverable failure more expensive is the opposite of the point.
   *
   * IT NEVER LATCHES, which is the "and then turn off again" half stated in the
   * strongest available form: there is no state. Escalation is scoped to the one
   * retry, so the NEXT step starts at the floor again whatever happened on this
   * one. A policy that ratcheted up and stayed there would be
   * {@link actionReasoning} set high, with extra machinery.
   *
   * The rung MUST be one that ANSWERS. One measured hands model at its own
   * `default_effort` of `max` returns `finish_reason: "length"` with 9,379
   * characters of unparseable partial JSON on this exact call, so "the highest
   * level the slug publishes" is not automatically a valid escalation target.
   */
  readonly actionReasoningEscalated?: ReasoningConfig;
  /**
   * Called when an unusable reply is being re-asked at the escalated rung.
   *
   * Exists because the escalation RATE is the number that decides whether this
   * mechanism should exist at all — floor cost times (1 - rate) plus escalated
   * cost times rate — and a rate nobody can observe is a rate nobody can price.
   * The ledger already records both calls; this names which one was a retry.
   */
  readonly onEscalation?: (cause: unknown) => void;
  /**
   * Called when a reply that failed the schema is being re-asked WITH the
   * violations attached. `attempt` is 1 for the first correction.
   *
   * Exists for {@link onEscalation}'s reason and with more force, because
   * unlike escalation this mechanism is ON with no configuration: it is the
   * difference between a customer losing an hour-long run to one malformed
   * reference and losing one model call. A rate nobody can observe is a rate
   * nobody can price, and here it is also a rate nobody can tell is working.
   *
   * `purpose` is on the event because the two callers have different
   * consequences and an operator line that names the wrong one is worse than
   * none: an `action` correction costs no step and touches no page, while an
   * `extract` correction is a second full-page generation on a request a
   * customer is waiting on.
   */
  readonly onCorrection?: (event: {
    readonly attempt: number;
    readonly violations: readonly string[];
    readonly purpose: CallPurpose;
    /** The refused reply's STRUCTURE, its words masked (see {@link replyShape}). Present on an extract refusal. */
    readonly shape?: string;
  }) => void;
  /**
   * Called when a reply was USED after being structurally repaired, naming the
   * repair and what it produced.
   *
   * ── Why a repair is allowed to be invisible to the caller and not to the
   * operator ─────────────────────────────────────────────────────────────────
   *
   * The caller gets a valid document, so there is nothing to tell them. The
   * operator is the one who needs to know, for two opposite reasons: a repair
   * rate that climbs means the pool this model is served from stopped honouring
   * `response_format`, and a repair rate of zero means this code is dead weight
   * that can be deleted. Neither is knowable from a reply that silently
   * succeeded, and a silent repair is indistinguishable from a schema that was
   * never violated.
   *
   * NEVER called when the repair did not produce a valid document. That reply
   * still fails, with the violations the UNREPAIRED reply earned, so a real
   * shape mismatch cannot hide behind this.
   */
  readonly onRepair?: (
    event:
      | {
          readonly repair: 'wrapped-bare-array';
          /** The sole required array property the bare array was wrapped into. */
          readonly property: string;
          /** How many elements the bare array carried. */
          readonly items: number;
        }
      /**
       * The reply arrived with text before or after the JSON object — most
       * commonly a sentence of narration the schema never asked for. Repaired
       * by keeping the substring from the first `{` to the last `}`, and only
       * ever attempted after the UNTRIMMED text has already failed to parse.
       */
      | { readonly repair: 'stripped-json-wrapper'; readonly removedChars: number }
      /**
       * A free-text read (`FREE_TEXT_SCHEMA`) whose `data` came back as the
       * items themselves — an array or object — instead of a string. The
       * content is what was asked for; it is kept as its JSON text rather than
       * refused and generated again. The rank-0 hands model on amazon list reads, 5 of 45
       * reads in 7 runs (fleet, 2026-10-04, bundle 6cfedc77), each a whole
       * second full-page call.
       */
      | { readonly repair: 'stringified-free-text' }
      /**
       * The reply was a tool-call in XML — `<invoke name="act"><parameter
       * name="a">{...}</parameter></invoke>` — instead of the JSON object a
       * `json_object` request asks for: a frontier brain model on one upstream,
       * 1 in 14-25 brain replies on the laptop sims (2026-10-03). Rebuilt as
       * `{"do": <name>, <parameter>: <value>}` (a value parsed as JSON when it
       * is JSON), and the schema still decides.
       */
      | { readonly repair: 'invoke-xml'; readonly parameters: number }
      /**
       * The reply wrapped its JSON object in tool-call tags, often more than
       * once or with a second copy after a "Correction" line —
       * `<invoke>{"do":…}</invoke><invoke>{"do":…}</invoke>` — so neither the
       * whole text nor the first-`{`-to-last-`}` span parses. The first
       * complete object whose every key is a schema field is the reply; the
       * schema still decides. 13 of 166 recorded tagged brain replies
       * (2026-10-02/03 sims) took this shape and cost a correction call each.
       */
      | { readonly repair: 'tagged-json'; readonly objects: number }
      /**
       * The reply was one action's own fields at the TOP level —
       * `{"type":"click","ref":"1-2"}` — instead of that object wrapped in
       * `actions`. The fields are unambiguous: a flat object naming a legal
       * `ACTION_TYPES` member cannot mean anything else, so it is lifted into
       * a one-element `actions` array rather than refused for a bracket the
       * model left out.
       */
      | { readonly repair: 'wrapped-bare-action' }
      | { readonly repair: 'hoisted-goal-from-actions' }
      /** `finding`, `ruledOut`, `then` and the like written on `actions[0]`, moved beside it. */
      | { readonly repair: 'hoisted-envelope-from-action'; readonly fields: readonly string[] }
      /**
       * One or more entries in `actions` past index 0 failed the ACTION
       * schema itself — a missing `type`, a stray property — and were
       * dropped rather than sinking the whole reply. `actions[0]` is
       * untouched by this: an unusable CHOICE is still fatal, only an
       * unusable ALTERNATIVE is disposable, exactly as a structurally sound
       * alternative already was.
       */
      | { readonly repair: 'dropped-invalid-alternative'; readonly count: number }
      /**
       * The reply's `goal` update named a `status` outside `"done"|"failed"`
       * — most often `"active"`, which needs no update at all: the active
       * sub-goal is already implicit as the first one neither done nor
       * failed. The update is dropped; the action it arrived with is not.
       */
      | { readonly repair: 'dropped-invalid-goal-status'; readonly status: unknown },
  ) => void;
  /**
   * Called when the IDENTICAL question is being sent to the SAME model again
   * because the last attempt produced no reply there was anything to correct.
   * `attempt` is 1 for the first resend. `purpose` says which call: an agent
   * step (`action`) or an extraction (`extract`) — both resend under the one
   * policy in {@link worthResending}.
   *
   * Separate from {@link onCorrection} because the two are different facts with
   * different fixes: a correction means the model answered and the answer was
   * wrong, a resend means the provider never delivered an answer at all. Folded
   * into one line they would average into a rate that describes neither.
   */
  readonly onResend?: (event: {
    readonly attempt: number;
    readonly cause: unknown;
    readonly purpose: 'action' | 'extract';
  }) => void;
  /** Monotonic, for the per-call deadline and the elapsed figure. */
  readonly clock?: Clock;
  /**
   * One event per provider call this client makes, successful or not — the
   * same calls the ledger records, plus a schema suggestion, which the ledger
   * does not see. Never for an action-cache hit: no model was called.
   *
   * The fleet's only per-call latency. `usage.inferenceTimeMs` on a step is the
   * call that ANSWERED, so a stall that failed over, a correction and a resend
   * were invisible until this line: a timeout rate had to be inferred from
   * failover lines per step. Must not throw; it is a report.
   */
  readonly onCall?: (event: ModelCallEvent) => void;
  /**
   * One report per call this client WITHDREW after sending it — a hedge's
   * loser, the run's cancel, or a call that outlived its deadline — priced at
   * an estimate, as spend that is the HOUSE's and never the run's.
   *
   * The ledger keeps such a call at `cancelled` or `timeout`, `'0'`, and that is the
   * customer's side and stays so: the run asked for nothing it received. But
   * no call is streamed, and the gateway documents that "for non-streaming
   * requests … you will be billed for the complete response" whatever the
   * caller aborts (the gateway's streaming API reference, read
   * 2026-09-28); measured the same day, 3 of 3 rank-0 calls withdrawn at
   * ~900 ms carried a `total_cost`, and 4 of 4 withdrawn at ~400 ms had no
   * generation record. So a withdrawn call is money we most likely paid, and
   * with only the ledger row nothing we sum — the SpendGuard's
   * `model_cost_usd` total, the reconciliation against the gateway's
   * `usage_daily` — could see it. The host writes this report as internal
   * spend. Must not throw; it is a report.
   *
   * A call withdrawn before it was sent — during a resend's backoff — is not
   * reported: nothing was spent.
   */
  readonly onWithdrawn?: (call: WithdrawnCall) => void;
}

/**
 * How {@link WithdrawnCall.costUsd} was estimated. Nothing came back, so there
 * is no provider figure to read:
 *
 * - `previous-call` — what this session last paid for a call to the same model
 *   for the same purpose, as the ledger holds it. An agent's steps re-send a
 *   prompt of nearly the same size and cache state, so the step before is the
 *   closest measurement of this one there is.
 * - `prompt-list-price` — no such call yet: the system turn and prompt at
 *   {@link WITHDRAWN_CHARS_PER_TOKEN}, uncached, at list price, and no output.
 *   High on input (worst measured ratio, no cache discount), silent on output.
 */
export type WithdrawnBasis = 'previous-call' | 'prompt-list-price';

/** One withdrawn call, as {@link ModelClientOptions.onWithdrawn} reports it. */
export interface WithdrawnCall extends ProviderCall {
  /** `timeout`: the client's deadline withdrew it; `cancelled`: a hedge, the run's cancel or a drain did. */
  readonly outcome: 'cancelled' | 'timeout';
  readonly costSource: 'estimate';
  readonly purpose: CallPurpose;
  /** True for the hedge arm; false for the primary or an unhedged call. */
  readonly hedge: boolean;
  readonly basis: WithdrawnBasis;
}

/**
 * Characters per token for {@link WithdrawnBasis} `prompt-list-price`: the
 * WORST ratio measured on real agent prompts (2.52 HN front page, 2.90 an HN
 * thread, 3.57-3.68 saucedemo; `CHARS_PER_TOKEN` in `@outcrawl/runtime`), so
 * the token count errs high rather than low.
 */
const WITHDRAWN_CHARS_PER_TOKEN = 2.5;

/**
 * One provider call, as {@link ModelClientOptions.onCall} reports it.
 *
 * `latencyMs` is request to complete reply. There is no time-to-first-byte:
 * no call is streamed, and the gateway sends a non-streamed reply's headers
 * early and pads the body (see `./http`), so the moment the first byte arrives
 * says nothing about when the answer did.
 */
export interface ModelCallEvent {
  readonly provider: string;
  readonly model: string;
  readonly purpose: CallPurpose;
  /**
   * 1 for the first call of one `choose`, `extract` or `suggestSchema`; each
   * correction, escalation and resend of the same ask counts up.
   */
  readonly attempt: number;
  /** True for the call a hedge started beside a primary that had not answered. */
  readonly hedge: boolean;
  readonly outcome: CallOutcome;
  readonly latencyMs: number;
  readonly usage: TokenUsage;
  /** The USD the ledger recorded for the call; `'0'` for an unbilled one. */
  readonly costUsd: string;
  readonly requestId?: string;
  /** The failure's own message, on any outcome but `ok`. */
  readonly error?: string;
}

/**
 * Per-call options beside the prompt. Absent on every caller but a hedge.
 */
export interface ModelCallOptions {
  /** Withdraws the call; see `ModelRequest.signal`. */
  readonly signal?: AbortSignal;
  /** Marks the call as a hedge on {@link ModelCallEvent.hedge}. */
  readonly hedge?: boolean;
  /**
   * The conversation so far, sent before this ask's prompt on EVERY provider
   * call the ask makes — corrections and resends included. A correction is
   * appended to the current prompt only, so the replayed thread (and with
   * {@link cache}, its cached prefix) is untouched by it. See
   * `ModelRequest.turns`; replay user turns with {@link extractPromptText} and
   * assistant turns with {@link ExtractResult.text} so they are byte-identical
   * to what was sent and received.
   */
  readonly turns?: readonly ModelTurn[];
  /** Prompt-cache breakpoints on every provider call of this ask. See `ModelRequest.cache`. */
  readonly cache?: boolean;
  /** Never-replayed text after the prompt, outside the cached prefix. See `ModelRequest.tail`. */
  readonly tail?: string;
  /** Upstream providers to try first for this ask. See `ModelRequest.providerOrder`. */
  readonly providerOrder?: readonly string[];
  /** Keep a truncated reply's first complete JSON object. See `ModelRequest.salvageTruncated`. */
  readonly salvageTruncated?: boolean;
  /**
   * This call's reasoning, in place of the client's own (`extractReasoning`,
   * `actionReasoning`). For a caller whose effort varies by call (the
   * brain's opening calls, `PlanModel.opening`).
   */
  readonly reasoning?: ReasoningConfig;
}

/** Which call of an ask this is, for {@link ModelCallEvent}. */
interface CallTag {
  readonly attempt: number;
  readonly hedge: boolean;
}

/** What an extraction cost, alongside what it produced. `ExtractOutcome`-shaped. */
export interface ExtractResult {
  readonly data: unknown;
  readonly usage: Usage;
  /** Exact decimal USD the provider stated for the call whose reply this is. */
  readonly costUsd: string;
  /**
   * The accepted reply exactly as the provider returned it
   * (`ModelResponse.text`), before any parse or repair: what a caller replays
   * as the assistant turn of a thread, so the next call's prefix is
   * byte-identical to what the provider saw.
   */
  readonly text: string;
  /**
   * The prompt the accepted reply answered, exactly as sent: the first ask's
   * prompt, or that prompt with a correction appended when a refused reply
   * was asked again. A thread caller replays THIS as the user turn, so the
   * next call's cached prefix matches what the provider cached (a correction
   * left out of the replay re-wrote the turn on the next call: 4 of 18 runs,
   * bundle a506a744, 2026-10-04).
   */
  readonly sent?: string;
  /**
   * Set when the page was over `ExtractInput.maxUsd`'s ceiling and was cut
   * before it was sent. The cost above is of the cut request.
   */
  readonly cut?: ExtractCut;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ACTION_TOKENS = 1024;

/**
 * The extraction reply ceiling, and it is sized to the ANSWER rather than to a
 * reasoning ratio.
 *
 * An action reply is one small object no matter how big the page is, which is
 * what makes `HARNESS_ACTION_TOKENS`'s 4096 a sound number for `choose`. An
 * EXTRACTION reply is the customer's own data: its size is set by how much of
 * the page matched their schema, and there is no ratio to reason from. 4096 was
 * the same number carried over from the action path, and it refused every
 * extraction bigger than about ten items.
 *
 * MEASURED, on the page a customer filed it against — a Facebook Ad Library
 * search returning 26 unique ads, 46,404 characters of markdown, a strict
 * schema of `{ads: [{libraryId, advertiser, bodyText, startedRunningOn,
 * platforms}]}`, the rank-0 hands model (scout-1 rank 0, the model production
 * calls first):
 *
 *     max_tokens 4096  -> finish_reason 'length' x3, nothing usable
 *     max_tokens 32768 -> 26 of 26 ads, 9,149 / 9,299 / 10,689 output tokens
 *
 * So the answer needed 2.6x the ceiling it was given, and the customer's
 * `{"ads": []}` was our ceiling refusing their data rather than the page not
 * holding it. Through a harness the truncation then demotes
 * (`UNANSWERED_STOP_REASONS` includes `length`), so one page cost up to three
 * billed truncations and 74 s before answering `internal` — measured on
 * production 2026-09-12, incident `inc_7bd10cc4-982c-473c-a0b1-f46c8ee2d2c2`.
 *
 * 32768 and not 65536: 32768 is the largest ceiling VERIFIED accepted by every
 * slug in every chain — the three hands ranks and the planner model then in
 * production, one live call each on 2026-09-12 — and a
 * ceiling above a model's own output limit is a 400, which `DEAD_MODEL_STATUSES`
 * would then demote through the whole chain for a reason no rank can fix.
 * Output is billed per token EMITTED, not per token allowed, so the headroom
 * costs nothing; it is the truncation that is billed for nothing.
 */
const DEFAULT_EXTRACT_TOKENS = 32_768;

/**
 * `implements ModelPort`, and that clause is load-bearing rather than
 * decorative. Before it existed, this class was expected to satisfy a host
 * interface it had never been checked against, and it did not: the host called
 * `choose` and this class offered `model`, the host passed a tagged page and this
 * class read a bare `markdown` string. Nothing failed to compile because nothing
 * connected the two, and `test/integration.test.ts` papered over the gap with a
 * hand-written adapter — which is the tell that somebody hit it and worked around
 * it locally instead of closing it.
 */
export class ModelClient implements ModelPort {
  readonly #provider: ModelProvider;
  readonly #model: string;
  readonly #extractModel: string;
  readonly #extractSystemPrompt: string;
  readonly #temperature: number | undefined;
  readonly #session: SessionAttribution;
  readonly #ledger: CostLedger;
  readonly #rates: RateCard;
  readonly #replyReasoning: boolean;
  readonly #timeoutMs: number;
  readonly #actionTimeoutMs: number;
  readonly #maxActionTokens: number;
  readonly #maxExtractTokens: number;
  readonly #actionReasoning: ReasoningConfig | undefined;
  readonly #extractReasoning: ReasoningConfig | undefined;
  readonly #actionReasoningEscalated: ReasoningConfig | undefined;
  readonly #onEscalation: (cause: unknown) => void;
  /**
   * The three declared shapes, read off the options rather than retyped. A
   * field that restates a callback's shape is a second place the shape can
   * drift from the one the host actually passes.
   */
  readonly #onCorrection: NonNullable<ModelClientOptions['onCorrection']>;
  readonly #onRepair: NonNullable<ModelClientOptions['onRepair']>;
  readonly #onResend: NonNullable<ModelClientOptions['onResend']>;
  readonly #clock: Clock;
  readonly #onCall: (event: ModelCallEvent) => void;
  readonly #onWithdrawn: ((call: WithdrawnCall) => void) | undefined;

  constructor(options: ModelClientOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#extractModel = options.extractModel ?? options.model;
    this.#extractSystemPrompt = options.extractSystemPrompt ?? EXTRACT_SYSTEM_PROMPT;
    this.#temperature = options.temperature;
    this.#session = options.session;
    this.#ledger = options.ledger ?? new CostLedger();
    this.#rates = options.rates ?? {};
    this.#replyReasoning = options.replyReasoning ?? true;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? this.#timeoutMs;
    this.#maxActionTokens = options.maxActionTokens ?? DEFAULT_ACTION_TOKENS;
    this.#maxExtractTokens = options.maxExtractTokens ?? DEFAULT_EXTRACT_TOKENS;
    this.#actionReasoning = options.actionReasoning;
    this.#extractReasoning = options.extractReasoning;
    this.#actionReasoningEscalated = options.actionReasoningEscalated;
    this.#onEscalation = options.onEscalation ?? (() => undefined);
    this.#onCorrection = options.onCorrection ?? (() => undefined);
    this.#onRepair = options.onRepair ?? (() => undefined);
    this.#onResend = options.onResend ?? (() => undefined);
    this.#clock = options.clock ?? systemClock;
    this.#onCall = options.onCall ?? (() => undefined);
    this.#onWithdrawn = options.onWithdrawn;
  }

  /** The ledger this client writes to. The host's, when it passed one in. */
  get ledger(): CostLedger {
    return this.#ledger;
  }

  /**
   * `ModelPort.choose`, which reaches the loop as `AgentDeps.model`.
   *
   * A bound property rather than a method so a host can pass `client.choose`
   * straight into a dependency object without losing `this`. The alternative is
   * every call site remembering an arrow wrapper, and the one that forgets fails
   * at runtime, inside the lock, on a page that is frozen.
   *
   * Named `choose` and not `model`, which is what it used to be called. One call
   * with two names across a seam is how the seam came to be unchecked: the host
   * declared `choose`, this class offered `model`, and the only code that ever
   * bridged them was a wrapper in this package's own integration test.
   *
   * `call` is the hedge's seam and nobody else's: a signal that withdraws the
   * whole ask — every correction and resend in it — and the hedge mark for
   * {@link ModelCallEvent}. `ModelPort` callers pass one argument.
   */
  readonly choose = async (prompt: AgentPrompt, call: ModelCallOptions = {}): Promise<ModelChoice> => {
    /**
     * The prompt as asked. Gains a correction block after a schema failure —
     * see {@link withViolations}.
     */
    let asked = prompt;
    /** The rung. Raised at most once, by a truncation, exactly as before. */
    let reasoning = this.#actionReasoning;
    let raised = false;
    /** The previous reply's violations, joined, to catch a model repeating itself. */
    let told: string | undefined;
    let corrections = 0;
    /** Resends of an unchanged ask, bounded by {@link MAX_RESENDS}. */
    let resent = 0;
    /** Calls this ask has made, for {@link ModelCallEvent.attempt}. */
    let attempt = 0;

    for (;;) {
      try {
        attempt += 1;
        return await this.#chooseAt(asked, reasoning, { attempt, hedge: call.hedge === true }, call);
      } catch (thrown) {
        // Withdrawn: nobody is waiting for a correction or a resend.
        if (thrown instanceof ModelCancelledError) {
          throw thrown;
        }
        const escalated = this.#actionReasoningEscalated;

        if (thrown instanceof ModelSchemaError) {
          // ── WHY THIS IS NOT THE RETRY THE CAPTCHA SOLVER REFUSES ─────────
          //
          // `packages/captcha/src/agentic/solver.ts` states the rule a reader
          // arriving here will remember: "A REPEATED FAILURE AT TEMPERATURE
          // ZERO CANNOT BE RETRIED". Same picture, same prompt, same bytes —
          // so re-asking a question whose answer was malformed buys an
          // identical malformed answer, billed twice. That rule is correct and
          // it does not cover this.
          //
          // THE NEXT TURN'S INPUT IS NOT THE SAME INPUT. A schema violation is
          // one line naming precisely what was wrong — "node 1-3727 is not in
          // the snapshot the action was chosen from" — and that line goes
          // into the prompt before the ask. The model is answering a question
          // it has not been asked, so a different answer is available to it
          // even at temperature 0. The solver's rule is about re-asking
          // UNCHANGED; this changes the ask.
          //
          // WHICH IS WHY THE REPEAT CHECK BELOW IS THE SAME SHAPE AS
          // `lastUnusableReason`. Once the model has been told exactly this and
          // sent exactly the same violations back, the input is effectively
          // unchanged after all — it read the correction and did not act on
          // it — and from that point the solver's rule DOES apply. So the step
          // ends, with a reason that says both halves.
          const said = thrown.violations.join('; ');
          const stop =
            said === told
              ? 'unchanged after being told exactly this, so the step ends here rather than asking again'
              : corrections >= MAX_SCHEMA_CORRECTIONS
                ? `still unusable after ${String(MAX_SCHEMA_CORRECTIONS)} correction(s), so the ` +
                  'step ends here rather than asking again'
                : undefined;
          // ONE throw for both bounds, with the two reasons side by side where
          // a reader compares them. The reason is appended as a violation
          // rather than wrapped in a new error type because it IS what was
          // wrong with the reply, and because `ModelSchemaError` is what the
          // ledger prices as `schema` and what the loop renders into the very
          // next prompt.
          if (stop !== undefined) {
            throw new ModelSchemaError(
              [...thrown.violations, stop],
              thrown.sample,
              thrown.usage,
              thrown.costUsd,
              thrown.costSource,
            );
          }
          told = said;
          corrections += 1;
          asked = withViolations(prompt, thrown.violations);
          // The rung goes up too when the host configured one — a reply that
          // did not think about the page is exactly what
          // `actionReasoningEscalated` is for — but the CORRECTION does not
          // depend on it. Production binds no escalated rung (see
          // `modelBinderFor` in `@outcrawl/worker`), and that is the state this
          // has to work in: gating the correction on an unset option is how a
          // recovery path comes to exist only in a test.
          if (escalated !== undefined && !raised) {
            reasoning = escalated;
            raised = true;
          }
          this.#onCorrection({
            attempt: corrections,
            violations: thrown.violations,
            purpose: 'action',
          });
          continue;
        }

        // TRUNCATION, and only truncation, still reaches the original
        // escalation path: the input is IDENTICAL and the effort is the one
        // field that changes. See `worthEscalating` for why a refusal is
        // excluded and why nothing else qualifies. Once, never in a loop.
        if (escalated !== undefined && !raised && worthEscalating(thrown)) {
          // Not a second step. `AgentDeps.perform` has not been called, the page is
          // still frozen, every reference in the prompt is still valid, and
          // `stepFailures` has not moved. The run pays one extra model call and
          // keeps the step.
          this.#onEscalation(thrown);
          reasoning = escalated;
          raised = true;
          continue;
        }
        // NOTHING CAME BACK: the same closed set, the same wait and the same
        // helper as `extract`, so the two paths cannot drift. Before this, an
        // upstream 502 the gateway delivers inside a 200 was neither resent here
        // nor demoted by the chain, so it was a failed step — and three in a
        // row ended the run. One resend, then the chain's failover has its turn.
        //
        // EXCEPT AN UPSTREAM 5xx ON AN ACTION: it goes to the chain at once,
        // which demotes on it (`shouldFailOver` reads `upstreamStatus`). On
        // the fleet on 2026-10-02 (08:38–18:15Z), 8 of 14 action resends after an
        // upstream 5xx from the rank-0 model's provider failed again (6 the same 5xx, 2 a 20 s stall), each
        // having paid the 2 s backoff first, while the run's page sat frozen.
        // An extraction still resends: its reply is the customer's data, and
        // the rank-1 model reads some pages differently.
        const upstreamDown = thrown instanceof ModelProviderError && thrown.upstreamStatus >= 500;
        if (!upstreamDown && resent < MAX_RESENDS && (await this.#waitToResend(thrown, prompt.caps))) {
          // Withdrawn during the backoff — a hedge answered meanwhile. Nothing
          // will be sent again, so no resend is reported.
          if (call.signal?.aborted === true) {
            throw new ModelCancelledError(call.signal.reason);
          }
          resent += 1;
          this.#onResend({ attempt: resent, cause: thrown, purpose: 'action' });
          continue;
        }
        throw thrown;
      }
    }
  };

  /**
   * One action call at one reasoning level.
   *
   * Factored out of {@link choose} so that the retry is provably the SAME call
   * with one field changed: a hand-rolled second call site is how a retry comes
   * to differ from the thing it is retrying.
   */
  async #chooseAt(
    prompt: AgentPrompt,
    reasoning: ReasoningConfig | undefined,
    tag: CallTag,
    call: ModelCallOptions,
  ): Promise<ModelChoice> {
    const started = this.#clock.now();
    const response = await this.#complete(
      {
        model: this.#model,
        system: this.#replyReasoning ? AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT_WITHOUT_REASONING,
        prompt: prompt.text,
        schema: this.#replyReasoning ? AGENT_REPLY_SCHEMA : AGENT_REPLY_SCHEMA_WITHOUT_REASONING,
        maxTokens: this.#maxActionTokens,
        ...(this.#temperature === undefined ? {} : { temperature: this.#temperature }),
        ...(reasoning === undefined ? {} : { reasoning }),
        // The vision arm. `prompt.text` already carries the marks legend
        // instead of the serialised tree — `renderPrompt` decided that — so
        // this is the one place the PIXELS enter the request, and a prompt with
        // no view sends the bare string exactly as before. See
        // `ModelRequest.images` on why the order is text-then-image.
        ...(prompt.view === undefined ? {} : { images: [prompt.view.image] }),
        ...callFields(call),
      },
      'action',
      prompt.caps,
      tag,
    );
    const elapsedMs = this.#clock.now() - started;

    // Parsed before accounting, and accounted whichever way it goes: a reply that
    // fails the schema was still billed. `#complete` has already recorded the
    // failures it raises itself.
    let reply: AgentReply;
    try {
      reply = parseAgentReply(response, prompt.tree, this.#onRepair, prompt.view?.marks);
    } catch (thrown) {
      this.#recordFailure(thrown, 'action', this.#model, elapsedMs, tag, response.requestId);
      throw thrown;
    }

    const usage = this.#account({
      response,
      elapsedMs,
      purpose: 'action',
      outcome: 'ok',
      model: this.#model,
      tag,
    });

    return {
      action: reply.actions[0],
      ...(reply.actions.length > 1 ? { alternatives: reply.actions.slice(1) } : {}),
      ...(reply.reasoning === undefined ? {} : { reasoning: reply.reasoning }),
      // The seam `ModelChoice.envelope` was declared for and that nothing had
      // ever taken. It is set here and not left to the loop's
      // `parseEnvelope(choice.action)` fallback because `action` above is a
      // `validateAction` rebuild: the envelope is provably not on it, and the
      // fallback would read an object that cannot carry one.
      ...(reply.envelope === undefined ? {} : { envelope: reply.envelope }),
      usage: { ...usage, cache: NO_ACTION_CACHE },
      cache: NO_ACTION_CACHE,
    };
  }

  /**
   * `PipelineDeps.extractJson`. Bound, for the same reason as `choose`.
   *
   * Not action-cached by any host, and that is not an omission. The action cache's unit is an
   * `ObservedAction` list keyed on an AX-tree hash; an extracted JSON document is
   * neither, and a second cache with its own key discipline is how two caches
   * come to disagree about what is stale. Reuse of a previous extraction belongs
   * to the render pipeline's own previous-render store, which is what
   * `trackChange` already reads.
   */
  readonly extractJson = async (opts: { markdown: string; schema: JsonSchema }): Promise<unknown> => {
    const result = await this.extract({
      instruction: null,
      schema: opts.schema,
      content: { kind: 'markdown', markdown: opts.markdown },
    });
    return result.data;
  };

  /**
   * `ModelPort.extract`, with its cost. `extractJson` is this without the
   * accounting, because `PipelineDeps` asks for a bare value.
   *
   * The page arrives tagged — see `ExtractContent` — so this method knows which
   * representation it is holding and says so in the prompt. It used to take a
   * bare `markdown: string` and label it "Page, as markdown", while its only
   * agent-path caller passed a tree and no markdown at all: the prompt then read
   * `Page, as markdown:\n\nundefined` and the model answered about a page it had
   * never seen. Nothing threw, nothing logged, and the extraction was billed.
   *
   * `schema: null` is accepted and is not a free pass. It is answered against
   * {@link FREE_TEXT_SCHEMA} and unwrapped to that one string, so there is still
   * a grammar the reply can violate and still something for `validate` to check.
   * An input with neither a schema nor an instruction is refused: there is
   * literally nothing being asked for, and the honest failure is at the call
   * rather than a confidently empty answer afterwards.
   */
  async extract(input: ExtractInput, call: ModelCallOptions = {}): Promise<ExtractResult> {
    if (input.schema === null && input.instruction === null) {
      throw new ModelConfigError(
        'extract was given neither a schema nor an instruction, so nothing was asked for. ' +
          'Pass a schema (the shape is the request), an instruction (the words are the request), ' +
          'or both. Refusing rather than returning an empty result that would be billed.',
      );
    }

    const schema: JsonSchema = input.schema ?? FREE_TEXT_SCHEMA;
    const constrained = constrainSchema(schema);
    const instruction = instructionLine(input);
    const { preamble, body } = renderPage(input.content);
    /**
     * THE BOUND (OC-284). With an allowance and a price for this client's
     * extraction model, the page body is cut to what the allowance buys at
     * that price, less everything else the request carries; a page that fits
     * is sent byte-identical. A model with no rate-card row is sent whole —
     * every slug a harness can reach has one, enforced by the cost gate, so
     * that is only a single-model client outside the agent path.
     */
    const rates = input.maxUsd === undefined ? undefined : this.#rates[this.#extractModel];
    // A replayed thread is input this request pays for as surely as the page.
    const overheadBytes = rates === undefined ? 0 :
      Buffer.byteLength(this.#extractSystemPrompt) + Buffer.byteLength(instruction) +
      Buffer.byteLength(preamble) + Buffer.byteLength(JSON.stringify(constrained.schema)) +
      (call.turns ?? []).reduce((bytes, turn) => bytes + Buffer.byteLength(turn.content), 0);
    const selection = input.selection;
    const ask = rates === undefined ? '' : selection === undefined
      ? `${input.instruction ?? ''} ${JSON.stringify(schema)}`
      : `${selection.task} ${selection.instruction ?? ''} ${JSON.stringify(selection.schema ?? {})}`;
    let correction = '';
    /** The previous reply's violations, joined, to catch a model repeating itself. */
    let told: string | undefined;
    /**
     * ONE BUDGET FOR BOTH MECHANISMS, and it is a LATENCY budget rather than a
     * correctness one — see {@link MAX_EXTRACT_RETRIES}. A customer's clock does
     * not care whether the second generation was a correction or a resend.
     */
    let spent = 0;

    for (;;) {
      let page = body;
      let cut: ExtractCut | undefined;
      if (input.maxUsd !== undefined && rates !== undefined) {
        const overhead = overheadBytes + Buffer.byteLength(correction);
        const ceiling = extractCeiling(input.maxUsd, rates.input, overhead);
        if (overhead > ceiling.tokens) {
          throw new ModelConfigError('The extraction instructions and schema exceed its input allowance before any page text. Narrow the request.');
        }
        const bounded = boundPage(body, {
          maxBytes: ceiling.pageBytes,
          ask,
          ...(selection === undefined ? {} : { task: selection.task }),
          kind: input.content.kind,
        });
        page = bounded.text;
        cut = bounded.cut === undefined ? undefined : { ...bounded.cut, ceilingTokens: ceiling.tokens };
      }
      // A correction is part of this request's input too. Re-select from the
      // original page with its bytes reserved, not by clipping a previous cut.
      const prompt = `${instruction}${preamble}${page}${correction}`;
      try {
        const result = await this.#extractAt(input, schema, constrained.schema, prompt, { attempt: spent + 1, hedge: call.hedge === true }, call);
        return cut === undefined ? result : { ...result, cut };
      } catch (thrown) {
        // Withdrawn: nobody is waiting for a correction or a resend.
        if (thrown instanceof ModelCancelledError) {
          throw thrown;
        }
        // The SAME correction `choose` has had since
        // `run_58b17565-02be-4973-9552-f07fab6331d8`, which extract never got.
        // Until this loop existed a `json` format was a single-shot call whose
        // only failure mode was an exception out of `extractJson` and an HTTP
        // 500 for the whole scrape: measured on the Facebook Ad Library page,
        // 3 of 20 replays of ONE fixed 47,401-character render (15%, n=20,
        // 2026-09-12) — two bare arrays and one mid-generation provider error —
        // on top of AdCountStable's 7 of 37 (19%, n=37, same page, same day).
        if (thrown instanceof ModelSchemaError) {
          const said = thrown.violations.join('; ');
          const stop =
            said === told
              ? 'unchanged after being told exactly this, so the extraction ends here rather than asking again'
              : spent >= MAX_EXTRACT_RETRIES
                ? `still unusable after ${String(MAX_EXTRACT_RETRIES)} further attempt(s), so the ` +
                  'extraction ends here rather than asking again'
                : undefined;
          if (stop !== undefined) {
            throw new ModelSchemaError(
              [...thrown.violations, stop],
              thrown.sample,
              thrown.usage,
              thrown.costUsd,
              thrown.costSource,
            );
          }
          told = said;
          spent += 1;
          correction = withExtractViolations('', thrown.violations);
          this.#onCorrection({
            attempt: spent,
            violations: thrown.violations,
            purpose: 'extract',
            shape: replyShape(thrown.sample),
          });
          continue;
        }

        // A REPLY CUT AT THE CAP BEFORE ANY JSON, on a call that asked for
        // salvage (the brain): there is no decision to keep, and the cut is
        // not the model's thinking running long but a degenerate tail. Every
        // one captured (2026-10-03 03:47Z, 2 of 134 brain calls, both served
        // by one upstream, 0 reasoning tokens) was a sentence of prose, then
        // an empty tool-call tag ("<invoke>" / "<invoke name=\"x\">") repeated
        // to 1,000 tokens with no JSON anywhere, so salvage had nothing to
        // keep and the step fell to the hands alone (BrainMeasure N3). Asked
        // once more with what went wrong, on the same thread: the correction
        // rides on the current prompt only, so the cached prefix still hits.
        if (
          call.salvageTruncated === true &&
          thrown instanceof ModelUnusableError &&
          TRUNCATION_REASONS[thrown.stopReason] === true &&
          spent < MAX_EXTRACT_RETRIES
        ) {
          spent += 1;
          const violations = [
            'your reply ran to the output token cap without a JSON object: it repeated empty tool-call tags. Reply with the one JSON object only, no other text and no tags',
          ];
          correction = withExtractViolations('', violations);
          this.#onCorrection({ attempt: spent, violations, purpose: 'extract' });
          continue;
        }

        // THE OTHER HALF, and it is a different question: there is no reply to
        // correct, so the ask is resent unchanged. See {@link worthResending}
        // for the closed set and why a timeout and a truncation are not in it;
        // `choose` resends under the same helper.
        if (spent < MAX_EXTRACT_RETRIES && (await this.#waitToResend(thrown, undefined))) {
          if (call.signal?.aborted === true) {
            throw new ModelCancelledError(call.signal.reason);
          }
          spent += 1;
          this.#onResend({ attempt: spent, cause: thrown, purpose: 'extract' });
          continue;
        }
        throw thrown;
      }
    }
  }

  /**
   * Derive a schema from the task text, for a run the caller gave none.
   *
   * The ENVELOPE is the mechanism. A model asked for "a JSON Schema" free-hand
   * answers with prose, a fenced block, or a schema wrapped in commentary, and
   * all three are indistinguishable from a bad schema downstream. Asking for
   * `{ "schema": { … } }` and validating that shape means the reply either
   * parses into one object or it does not, and the failure lands here rather
   * than on the wire.
   *
   * NEVER THROWS. Every failure — timeout, refusal, unparseable reply, a
   * `schema` field that is not an object — returns `null`, because the caller
   * treats null as "no suggestion" and a run must not fail over a convenience
   * it never asked for. This is the same rule the loop states at its join and
   * the worker states at its binding; it is enforced at all three because the
   * cost of getting it wrong is a working run reported as broken.
   *
   * `'extract'` as the call purpose, sharing the extractor role's model: this
   * IS an extraction — of a shape rather than of data — and giving it a role
   * of its own would mean a new slug to configure for no behavioural gain.
   */
  async suggestSchema(task: string): Promise<JsonSchema | null> {
    const envelope: Readonly<Record<string, unknown>> = {
      type: 'object',
      properties: {
        schema: {
          type: 'object',
          description: 'A JSON Schema describing the records this task should produce.',
        },
      },
      required: ['schema'],
      additionalProperties: false,
    };
    const tag: CallTag = { attempt: 1, hedge: false };
    const started = this.#clock.now();
    let response: ModelResponse;
    try {
      response = await this.#complete(
        {
          model: this.#extractModel,
          system:
            'You turn a web-automation task into a JSON Schema for the records it should ' +
            'produce. Reply with {"schema": <json schema>} and nothing else. Prefer a top-level ' +
            'array of objects when the task collects several things, and a flat object when it ' +
            'answers one question. Name fields as the task names them. Include only fields the ' +
            'task actually asks for: a field nobody requested is a column the caller has to ' +
            'explain away. Do not invent identifiers, timestamps or metadata.',
          prompt: `Task: ${task}`,
          maxTokens: this.#maxExtractTokens,
          schema: envelope,
        },
        'extract',
        undefined,
        tag,
      );
    } catch {
      return null;
    }
    let suggested: unknown;
    let failure: unknown;
    try {
      const parsed = parseJsonReply(response, envelope as JsonSchema, this.#onRepair);
      suggested = isRecord(parsed) ? parsed['schema'] : undefined;
    } catch (thrown) {
      failure = thrown;
    }
    // A line and NO LEDGER ROW: this answered call has never been written to
    // the ledger, so it is not on the run's bill (a pre-existing gap, reported
    // with the hedge work rather than changed under it). The line is how the
    // call becomes visible at all.
    this.#onCall({
      provider: this.#provider.name,
      model: this.#extractModel,
      purpose: 'extract',
      attempt: tag.attempt,
      hedge: false,
      outcome: failure === undefined ? 'ok' : callOutcomeOf(failure),
      latencyMs: this.#clock.now() - started,
      usage: response.usage,
      costUsd: response.costUsd,
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      ...(failure instanceof Error ? { error: failure.message } : {}),
    });
    return isRecord(suggested) ? (suggested as JsonSchema) : null;
  }

  /**
   * One extraction call against one prompt.
   *
   * Factored out of {@link extract} for {@link #chooseAt}'s reason: the retry
   * has to be provably the SAME call with one field changed, and a hand-rolled
   * second call site is how a retry comes to differ from the thing it retries.
   */
  async #extractAt(
    input: ExtractInput,
    schema: JsonSchema,
    constrained: Readonly<Record<string, unknown>>,
    prompt: string,
    tag: CallTag,
    call: ModelCallOptions,
  ): Promise<ExtractResult> {
    const started = this.#clock.now();
    const response = await this.#complete(
      {
        model: this.#extractModel,
        system: this.#extractSystemPrompt,
        prompt,
        schema: constrained,
        maxTokens: this.#maxExtractTokens,
        ...(this.#temperature === undefined ? {} : { temperature: this.#temperature }),
        ...(this.#extractReasoning === undefined ? {} : { reasoning: this.#extractReasoning }),
        ...callFields(call),
      },
      'extract',
      undefined,
      tag,
    );
    const elapsedMs = this.#clock.now() - started;

    let data: unknown;
    try {
      const parsed = parseJsonReply(response, schema, this.#onRepair);
      if (input.schema === null) {
        // The envelope is this method's, not the caller's, so it is unwrapped
        // here. `parseJsonReply` has already validated it against
        // FREE_TEXT_SCHEMA, which requires `data` and declares it a string — but
        // a guarantee the compiler cannot see is not a guarantee, and this is the
        // boundary where a schema-validator bug would become a `.data` on
        // `undefined` two frames away from its cause.
        if (!isRecord(parsed) || typeof parsed['data'] !== 'string') {
          throw new ModelSchemaError(
            ['the free-text envelope carried no string `data` field'],
            response.text,
            response.usage,
            response.costUsd,
            response.costSource,
          );
        }
        data = parsed['data'];
      } else {
        data = parsed;
      }
    } catch (thrown) {
      this.#recordFailure(thrown, 'extract', this.#extractModel, elapsedMs, tag, response.requestId);
      throw thrown;
    }

    const usage = this.#account({
      response,
      elapsedMs,
      purpose: 'extract',
      outcome: 'ok',
      model: this.#extractModel,
      tag,
    });

    return { data, usage, costUsd: response.costUsd, text: response.text, sent: prompt };
  }

  /* ---------------------------------------------------------------- *
   * The provider call
   * ---------------------------------------------------------------- */

  /**
   * One provider call, deadlined, with every failure recorded before it is
   * rethrown.
   *
   * The deadline is enforced here and not only in the transport, because a
   * provider is an injected interface and a hanging one must not hang a run that
   * is holding the action-lock — a frozen page with nobody thinking about it is
   * the worst state this system has. The abandoned promise is left to settle on
   * its own; the real transport carries its own `AbortSignal`, so it does not
   * outlive its budget either way.
   */
  async #complete(
    request: {
      model: string;
      system: string;
      prompt: string;
      schema: Readonly<Record<string, unknown>>;
      maxTokens: number;
      /** The vision arm's screenshot. Absent on every text call. */
      images?: readonly ModelImage[];
      /** Withdraws the call. See {@link ModelCallOptions.signal}. */
      signal?: AbortSignal;
      /** The thread and its cache hint. See {@link ModelCallOptions.turns}. */
      turns?: readonly ModelTurn[];
      cache?: boolean;
      tail?: string;
      providerOrder?: readonly string[];
      salvageTruncated?: boolean;
    },
    purpose: CallPurpose,
    caps: AgentPrompt['caps'],
    tag: CallTag,
  ): Promise<ModelResponse> {
    const { signal } = request;
    if (signal?.aborted === true) {
      // Withdrawn before it was sent — during a resend's backoff. Nothing was
      // called, so nothing is recorded.
      throw new ModelCancelledError(signal.reason);
    }
    const timeoutMs = this.#deadline(caps, purpose === 'action' ? this.#actionTimeoutMs : this.#timeoutMs);
    if (timeoutMs <= 0) {
      // A request that cannot finish must not start: it would spend tokens on an
      // answer the run has no time left to use.
      const expired = new ModelTimeoutError(0);
      this.#recordFailure(expired, purpose, request.model, 0, tag);
      throw expired;
    }

    // The withdrawal is raced here as well as passed down, for the deadline's
    // reason above: a provider that ignores the signal must not keep the
    // caller waiting for an answer it has already given up on.
    const withdrawal = Promise.withResolvers<never>();
    const onAbort = (): void => withdrawal.reject(new ModelCancelledError(signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = this.#clock.now();
    try {
      return await Promise.race([
        this.#provider.complete({ ...request, timeoutMs }),
        this.#clock.sleep(timeoutMs).then((): never => {
          throw new ModelTimeoutError(timeoutMs);
        }),
        ...(signal === undefined ? [] : [withdrawal.promise]),
      ]);
    } catch (thrown) {
      const elapsedMs = this.#clock.now() - started;
      this.#recordFailure(thrown, purpose, request.model, elapsedMs, tag);
      // A deadline aborts a sent request exactly as a withdrawal does, and
      // the gateway bills it the same way: both are the house's.
      if (thrown instanceof ModelCancelledError || thrown instanceof ModelTimeoutError) {
        this.#reportWithdrawn(
          request,
          purpose,
          elapsedMs,
          tag,
          thrown instanceof ModelTimeoutError ? 'timeout' : 'cancelled',
        );
      }
      throw thrown;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The per-call budget — `ceilingMs`, which is the action or the general
   * ceiling by purpose — narrowed by the run's own duration cap when there is
   * one. A step given 60 seconds inside a run with 4 seconds left would
   * otherwise blow through the cap and report it as a model timeout.
   *
   * "When there is one" is now literal in both directions: `caps.duration` is
   * optional as of 2026-09-08 and `capDurationCeilingMs` reads an unset
   * ceiling as `Infinity`, so a run bounded only by money narrows nothing here
   * and keeps this client's own timeout.
   */
  #deadline(caps: AgentPrompt['caps'], ceilingMs: number = this.#timeoutMs): number {
    if (caps === undefined) {
      return ceilingMs;
    }
    return Math.min(ceilingMs, capDurationCeilingMs(caps.limits) - caps.used.elapsedMs);
  }

  /**
   * Whether an unanswered call is resent to this model, and if so the wait
   * before it. The ONE resend policy, read by both `choose` and `extract`; the
   * callers own only their bound.
   *
   * Refused when {@link worthResending} refuses, and when the run's remaining
   * deadline would not outlast {@link RESEND_BACKOFF_MS}: a resend that cannot
   * finish inside the run's own duration cap only moves the failure later. The
   * remaining figure is the one `#complete` deadlines each call by, taken at
   * the step's start, which is the same horizon every other retry in this class
   * (corrections, the escalation rung) already works to.
   */
  async #waitToResend(thrown: unknown, caps: AgentPrompt['caps']): Promise<boolean> {
    if (!worthResending(thrown) || this.#deadline(caps) <= RESEND_BACKOFF_MS) {
      return false;
    }
    await this.#clock.sleep(RESEND_BACKOFF_MS);
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Accounting
   * ---------------------------------------------------------------- */

  /** Records a successful call at the provider's own price, and reports its usage. */
  #account(entry: {
    response: ModelResponse;
    elapsedMs: number;
    purpose: CallPurpose;
    outcome: CallOutcome;
    model: string;
    tag: CallTag;
  }): Usage {
    const stored = this.#ledger.record({
      sessionId: this.#session.sessionId,
      accountId: this.#session.accountId,
      provider: this.#provider.name,
      model: entry.model,
      purpose: entry.purpose,
      outcome: entry.outcome,
      usage: entry.response.usage,
      costUsd: entry.response.costUsd,
      costSource: entry.response.costSource,
      elapsedMs: entry.elapsedMs,
      ...(entry.response.requestId === undefined ? {} : { requestId: entry.response.requestId }),
    });
    this.#report(stored, entry.tag, undefined);
    return toCoreUsage(entry.response.usage, entry.elapsedMs);
  }

  /**
   * Record a failed call.
   *
   * A refusal and a truncated reply were billed — the provider documents a
   * refusal as a 200 that "You'll be billed for" — so they are recorded at the
   * cost the provider stated, carried on the error (`ModelError.costUsd`),
   * exactly like a success. A timeout and a transport failure were not billed
   * and record `'0'`. Leaving either out would understate spend on precisely
   * the runs someone is investigating — and, since the runtime charges a run
   * from this ledger, would under-bill them too.
   */
  #recordFailure(thrown: unknown, purpose: CallPurpose, model: string, elapsedMs: number, tag: CallTag, answeredId?: string): void {
    const failed = thrown instanceof ModelError ? thrown : undefined;
    const stored = this.#ledger.record({
      sessionId: this.#session.sessionId,
      accountId: this.#session.accountId,
      provider: this.#provider.name,
      model,
      purpose,
      outcome: callOutcomeOf(thrown),
      usage: failed?.usage ?? ZERO_TOKENS,
      costUsd: failed?.costUsd ?? ZERO_CREDITS,
      costSource: failed?.costSource ?? 'provider',
      elapsedMs,
      // A reply that answered but failed the schema has its id on the response, not the error.
      ...(answeredId === undefined ? requestIdOf(thrown) : { requestId: answeredId }),
    });
    this.#report(stored, tag, thrown);
  }

  /**
   * A call withdrawn after it was sent, as HOUSE spend at an estimate: see
   * {@link ModelClientOptions.onWithdrawn} for why, {@link WithdrawnBasis} for
   * how. Nothing is written to the ledger here — {@link #recordFailure} has
   * already put the customer's side there, at `'0'`.
   */
  #reportWithdrawn(
    request: {
      readonly model: string;
      readonly system: string;
      readonly prompt: string;
      readonly schema: unknown;
      readonly turns?: readonly ModelTurn[];
    },
    purpose: CallPurpose,
    elapsedMs: number,
    tag: CallTag,
    outcome: WithdrawnCall['outcome'],
  ): void {
    const report = this.#onWithdrawn;
    if (report === undefined) {
      return;
    }
    const sessionId = this.#session.sessionId;
    const entries = this.#ledger.entries();
    let priced: { readonly usage: TokenUsage; readonly costUsd: string; readonly basis: WithdrawnBasis } | undefined;
    for (let index = entries.length - 1; index >= 0 && priced === undefined; index -= 1) {
      const entry = entries[index];
      if (
        entry !== undefined &&
        entry.sessionId === sessionId &&
        entry.model === request.model &&
        entry.purpose === purpose &&
        compareDecimal(entry.costUsd, ZERO_CREDITS) > 0
      ) {
        priced = { usage: entry.usage, costUsd: entry.costUsd, basis: 'previous-call' };
      }
    }
    if (priced === undefined) {
      const chars =
        request.system.length + request.prompt.length + JSON.stringify(request.schema).length +
        (request.turns ?? []).reduce((sum, turn) => sum + turn.content.length, 0);
      const usage: TokenUsage = { ...ZERO_TOKENS, inputTokens: Math.ceil(chars / WITHDRAWN_CHARS_PER_TOKEN) };
      // A model with no list price cannot be estimated this way: `'0'`, which
      // the host writes nothing for, rather than a throw on a report's path.
      let costUsd = ZERO_CREDITS;
      try {
        costUsd = costOf(usage, ratesIn(this.#rates, request.model)).total;
      } catch (error) {
        if (!(error instanceof ModelConfigError)) {
          throw error;
        }
      }
      priced = { usage, costUsd, basis: 'prompt-list-price' };
    }
    report({
      provider: this.#provider.name,
      model: request.model,
      purpose,
      hedge: tag.hedge,
      outcome,
      usage: priced.usage,
      costUsd: priced.costUsd,
      costSource: 'estimate',
      basis: priced.basis,
      elapsedMs,
    });
  }

  /** The ledger row just written, as the {@link ModelClientOptions.onCall} line. */
  #report(stored: CostEntry, tag: CallTag, thrown: unknown): void {
    this.#onCall({
      provider: stored.provider,
      model: stored.model,
      purpose: stored.purpose,
      attempt: tag.attempt,
      hedge: tag.hedge,
      outcome: stored.outcome,
      latencyMs: stored.elapsedMs,
      usage: stored.usage,
      costUsd: stored.costUsd,
      ...(stored.requestId === undefined ? {} : { requestId: stored.requestId }),
      ...(thrown === undefined ? {} : { error: thrown instanceof Error ? thrown.message : String(thrown) }),
    });
  }
}

/**
 * The request fields a {@link ModelCallOptions} contributes. Each is present
 * only when the caller set it, so a call without a thread builds the same
 * request object, and the same body, as before `turns` and `cache` existed.
 */
function callFields(call: ModelCallOptions): {
  signal?: AbortSignal;
  turns?: readonly ModelTurn[];
  cache?: boolean;
  tail?: string;
  providerOrder?: readonly string[];
  salvageTruncated?: boolean;
  reasoning?: ReasoningConfig;
} {
  return {
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.turns === undefined ? {} : { turns: call.turns }),
    ...(call.cache === undefined ? {} : { cache: call.cache }),
    ...(call.tail === undefined ? {} : { tail: call.tail }),
    ...(call.providerOrder === undefined ? {} : { providerOrder: call.providerOrder }),
    ...(call.salvageTruncated === undefined ? {} : { salvageTruncated: call.salvageTruncated }),
    ...(call.reasoning === undefined ? {} : { reasoning: call.reasoning }),
  };
}

/** The extraction's instruction line, or `''` when the schema is the whole ask. */
function instructionLine(input: ExtractInput): string {
  return input.instruction === null ? '' : `What to extract: ${input.instruction}\n\n`;
}

/**
 * The user text {@link ModelClient.extract} sends on its FIRST attempt for
 * `input`: instruction line, page preamble, page body, byte for byte.
 *
 * For a caller that keeps a conversation (`ModelCallOptions.turns`): replaying
 * an earlier ask as its user turn with exactly this text keeps the thread's
 * prefix byte-identical to what the provider saw and cached. It does not
 * reproduce a correction (appended only to a retry) or an `ExtractInput.maxUsd`
 * cut (which shortens the body); a caller that sets `maxUsd` and gets
 * `ExtractResult.cut` back sent something shorter than this.
 */
export function extractPromptText(input: ExtractInput): string {
  const { preamble, body } = renderPage(input.content);
  return `${instructionLine(input)}${preamble}${body}`;
}

/**
 * The page, labelled with what it actually is.
 *
 * A `switch` over the tag rather than a chain of `!== undefined` checks, so a
 * third representation is a compile error here instead of an unlabelled blob in
 * a prompt. The tree form carries its URL, which markdown does not: an
 * extraction whose answer depends on the origin — a price in the wrong currency,
 * a date in the wrong locale — has no other way to know it.
 *
 * Split in two so the bound (OC-284, `./extract-bound.ts`) can cut the BODY
 * without touching the label: `preamble` says what the page is, `body` is the
 * page, and the prompt is the two concatenated.
 */
function renderPage(content: ExtractContent): { readonly preamble: string; readonly body: string } {
  switch (content.kind) {
    case 'markdown':
      return { preamble: 'Page, as markdown:\n\n', body: content.markdown };
    case 'tree':
      return {
        preamble:
          `Page: ${content.tree.url}\n\n` +
          'Page, as the filtered accessibility tree. Each line is ' +
          '`depth role "name" (state) [frame-backendNode]`. When this extraction asked where things go, a ' +
          'line for an element that links somewhere ends `->` and the quoted absolute URL it goes to; a line ' +
          'without one has no destination that was read, so never make one up. A line marked (inside iframe) starts the ' +
          'content of an embedded frame, and the lines nested under it are inside that frame too:\n\n',
        body:
        // NO PER-NODE CLIP. `serializeTree` defaults `maxNameLength` to 120, and
        // on this path that default was deleting the customer's answer.
        //
        // Measured 2026-09-08 over 20 real benchmark pages: the clip amputated
        // 5.6% of all node names and 98,192 characters of page text, and the
        // judge literals a run could find went 15 at clip 120 -> 18 at clip 300
        // -> 18 unclipped. One failing row's whole wrong answer was two clipped
        // names concatenated — 119 characters and an ellipsis, twice, with the
        // literal it needed sitting seven characters past the cut.
        //
        // A per-node bound is only load-bearing where a TOTAL bound exists for a
        // long name to displace something out of. The action prompt has one
        // (`TREE_CHAR_BUDGET`) and keeps its clip at 120 — raising it there
        // measurably LOSES answers, because longer names push other nodes out of
        // the fixed window. This path has no FIXED total bound, because it is
        // where the customer's answer comes from, so here the clip protects
        // nothing and only deletes text. Cost of removing it: +31% characters,
        // +3.4% mean tokens. Its one total bound is money — the run's budget
        // share (OC-284) — and that drops whole lines and says so, never
        // clipping a name.
        serializeTree(content.tree, { maxNameLength: Number.POSITIVE_INFINITY }),
      };
  }
}

/**
 * Whether this failure is one MORE THINKING could plausibly fix, on an
 * UNCHANGED prompt.
 *
 * The whole escalation design rests on this predicate being narrow, and it got
 * narrower: one family qualifies and nothing else does.
 *
 * `ModelUnusableError` with a TRUNCATION reason — the answer was cut off at
 * `max_tokens`, so any JSON in it is a fragment. Re-asking is the right move
 * and it is also the one case where escalating is counter-intuitive: MORE
 * reasoning makes truncation MORE likely, so a host whose floor truncates
 * should raise `maxActionTokens`, not the effort. It is included because the
 * reverse — the floor being so cheap it answered nothing useful — is the case
 * this exists for, and `#complete` cannot tell the two apart from here.
 *
 * `ModelSchemaError` USED TO QUALIFY AND NO LONGER REACHES THIS. It is handled
 * before this is consulted, by {@link MAX_SCHEMA_CORRECTIONS} and
 * {@link withViolations}, and the difference is the whole point: a schema
 * failure can be TOLD WHAT WAS WRONG, so re-asking it is a different question
 * rather than the same one at a higher price. Escalation could only ever hope
 * the model thought harder about a prompt that had not changed — and in
 * production it could not even do that, because no host binds
 * {@link ModelClientOptions.actionReasoningEscalated} and the whole arm was
 * dead. Measured on one cheap hands candidate before the correction
 * existed: a `click` with NO `ref` at all, in five arms of seven, including its
 * own default.
 *
 * `refusal` is deliberately EXCLUDED. A refusal is a verdict, not a failure to
 * think: the model understood and declined, and re-asking it harder is asking
 * the same question twice at a higher price. `ModelIdentity` split truncation
 * from refusal in `shouldFailOver` for the same reason.
 *
 * A provider error, a timeout and a config error are all excluded: none of them
 * is a reply, so there is nothing about the reply to improve.
 */
function worthEscalating(thrown: unknown): boolean {
  return thrown instanceof ModelUnusableError && TRUNCATION_REASONS[thrown.stopReason] === true;
}

/**
 * How many times one step may be told what was wrong and asked again.
 *
 * ── Why a bound at all ──────────────────────────────────────────────────────
 *
 * Because a model that cannot satisfy this schema must still terminate, and
 * because every ask is billed. Three action calls is the worst case for one
 * step, and it is only reached by a model that produced a DIFFERENT violation
 * each time: an identical repeat stops at two, because being told and not
 * changing the answer is the non-retryable case.
 *
 * ── Why two and not one, measured ───────────────────────────────────────────
 *
 * Run `run_58b17565-02be-4973-9552-f07fab6331d8` (2026-09-11, scout-1, the
 * customer's Nordstrom task) failed 6 of its 11 steps on the schema and the
 * violations were NOT all the same: a bare action object with no `actions`
 * array, a zero `backendNodeId` twice, an unterminated string, and two refs
 * naming nodes from a previous snapshot. A single correction covers one
 * mistake; a reply that fixes the ref and then truncates has a second, real
 * thing to be told. Beyond two, a model is not reading the correction, and
 * `stepFailures` is the right instrument for that rather than more calls.
 */
export const MAX_SCHEMA_CORRECTIONS = 2;

/**
 * The same prompt, plus what was wrong with the last reply to it.
 *
 * Appended to `text` rather than folded into {@link AGENT_SYSTEM_PROMPT},
 * because the system turn is identical on every call and is the half a provider
 * caches; a correction belongs to ONE ask. Appended at the END rather than
 * anywhere else for the same reason the tree is where it is: the last thing in
 * the prompt is the thing being answered.
 *
 * The violations are quoted VERBATIM and nothing is added about how to fix
 * them. They are already written for this reader — `resolveRef` names the
 * form a reference takes and the offending value, or the node that is not in
 * the tree — and a
 * second, looser paraphrase beside them is how two descriptions of one rule
 * come to disagree.
 */
function withViolations(prompt: AgentPrompt, violations: readonly string[]): AgentPrompt {
  const told = violations.map((violation) => `- ${violation}`).join('\n');
  return {
    ...prompt,
    text:
      `${prompt.text}\n\n` +
      'YOUR PREVIOUS ANSWER TO THIS EXACT PAGE WAS REFUSED. Nothing was done to the page, nothing\n' +
      'has changed, and every reference above is still the one to use.\n\n' +
      `What was wrong with it:\n${told}\n\n` +
      'Answer again in the same schema and fix exactly that. This is the same step, not the next\n' +
      'one: do not account for an action that did not happen.',
  };
}

/**
 * How many EXTRA generations one extraction may spend — corrections and
 * resends together, because the customer's clock does not distinguish them.
 *
 * ── Why the same rank and not the next one ──────────────────────────────────
 *
 * Because a demotion trades a 500 for a quietly shorter answer, which is a
 * worse outcome wearing a better status code. Measured by AdCountStable on the
 * Facebook Ad Library page, 2026-09-12: the rank-1 failover hands model
 * returned 11 of the page's 26 ads in 4 of 6
 * replays of one fixed render, because it DEDUPLICATES the 8 byte-identical ad
 * creatives — and it did so with `stopReason: 'stop'`, no warning, and nothing
 * on the wire to distinguish it from a complete answer. Resending to the same
 * model keeps the completeness distribution the customer already has (17-26 of
 * 26 on that page) instead of silently swapping it for a narrower one.
 *
 * ── Why ONE, and it is the shipped Python client that decides it ────────────
 *
 * `packages/sdk-python/src/outcrawl/transport.py` defaults `timeout` to 60.0
 * and hands it straight to `httpx`, so a Python caller who passes no timeout
 * gets a read timeout at 60 s — no code, no sentence, no incident id, which is
 * the exact failure shape this whole change exists to remove. Measured by
 * Empty520 tonight on `acct_mit`'s key, n=44 slow `/v1/scrape` requests: 36-51
 * s wall, longest 50.756 s, nothing above 51 s observed. A second extract
 * attempt on this page costs ~8-10 s, which lands inside that window; a THIRD
 * puts a slow page in the 55-70 s band, straddling the client default. Trading
 * a coded 503 for an `httpx` timeout would be a regression dressed as a fix.
 *
 * And one is what the measurement asks for anyway: in the 20-replay after-arm,
 * the recoveries were 2 repairs (which cost NO extra generation at all) and 1
 * correction that answered on its first retry. Zero runs needed a second extra
 * ask, so the second one was buying a case nothing in n=20 exhibited, at the
 * price of the one deadline we know a customer is running.
 *
 * The remaining cost is knowable: the replay mean is 16.6 s and $0.0018 per
 * answered call (n=17 answered of 20, 2026-09-12), so this adds at most ~17 s
 * and ~$0.002 to a request that would otherwise have FAILED, and nothing at
 * all to one that succeeds. NOT MEASURED: how long a mid-generation provider
 * error takes to surface, so that worst case assumes a full generation.
 */
const MAX_EXTRACT_RETRIES = 1;

/**
 * Resends of an unchanged agent-step ask before the failure goes to the chain.
 * One, because the second failure is better answered by another rank than by
 * a third ask of an upstream that has now failed twice.
 */
const MAX_RESENDS = 1;

/**
 * How long an unanswered call waits before it is resent.
 *
 * MEASURED, not chosen: production agent steps after 12Z on 2026-09-24 (n=3,934
 * steps, 397 runs) whose model call came back as the gateway's inline
 * `<gateway>_502: Upstream error from <upstream>`, bucketed by the gap until the
 * same run's next step, and whether that next call failed the same way: under
 * 0.5 s, 39 of 39 did; 0.5-1 s, 7/10; 1-2 s, 9/20; 2-5 s, 1/12; 5 s and over,
 * 5/17. An immediate resend is therefore a wasted call, and two seconds is the
 * first bucket where the upstream had usually recovered. Small n in the 2-5 s
 * bucket; the chain's failover is the backstop when it has not. The failure
 * itself surfaced in a median 628 ms (same sample), so the step spends about
 * 2.6 s before its second ask instead of being recorded as a failed step.
 */
const RESEND_BACKOFF_MS = 2_000;

/**
 * Whether the same question is worth asking the same model again.
 *
 * A CLOSED set over failures where NOTHING CAME BACK TO CORRECT, which is what
 * separates this from {@link MAX_SCHEMA_CORRECTIONS}: there is no violation to
 * put in the prompt, so the only lever left is the call itself.
 *
 * `ModelProviderError` qualifies when the provider marked it retryable AND the
 * status is below 400 — exactly the four cases `./chat-completions` raises that way:
 * a transport failure that never reached HTTP (status 0), a 2xx whose body was
 * not JSON, a 2xx carrying an inline `error`, and a 2xx carrying no choices.
 * Every non-2xx retryable status is 429 or 5xx, and those are deliberately left
 * alone: `shouldFailOver` already demotes them, because a rate limit or a dead
 * upstream is the one failure another model genuinely fixes. The `retryable`
 * flag has existed on that error since it was written and nothing in the
 * workspace read it — `harness.test.ts` says why in the mutation it guards:
 * "that flag is right for a RETRY of the same model and wrong for a CHAIN".
 * This is the retry it was right for.
 *
 * A 2xx carrying an inline upstream 5xx is BOTH: resent once here first, and
 * if the resend fails too, demoted by `shouldFailOver`, which reads
 * `upstreamStatus`. The resend comes first because the upstream fault is
 * usually brief (see {@link RESEND_BACKOFF_MS}) and rank 1 is ~17x the per-
 * minute cost of rank 0 for at least the chain's cooldown once it demotes.
 *
 * `ModelUnusableError` qualifies on `error` and on nothing else. That stop
 * reason is the gateway's "the upstream provider reported an error
 * mid-generation" — measured once in 20 replays of the Ad Library page
 * (2026-09-12) — and it means the generation died, not that the model declined.
 * `refusal` and `content_filter` are excluded because the model DID answer and
 * a resend buys the identical decline at the identical price. `length` and
 * `max_tokens` are excluded because the reply exists and is cut off: the
 * ceiling is the fix (see {@link DEFAULT_EXTRACT_TOKENS}) and the chain already
 * demotes on them.
 *
 * `ModelTimeoutError` is excluded: `shouldFailOver` demotes on it, and a
 * resend would spend another whole `timeoutMs` before the chain got its turn.
 */
function worthResending(thrown: unknown): boolean {
  if (thrown instanceof ModelProviderError) {
    return thrown.retryable && thrown.status < 400;
  }
  if (thrown instanceof ModelUnusableError) {
    return thrown.stopReason === 'error';
  }
  return false;
}

/**
 * The extraction ask, plus what was wrong with the last reply to it.
 *
 * {@link withViolations} for the extract path, and deliberately a second
 * function rather than a generalisation of it: the two say different true
 * things. There is no page to leave untouched here, no reference to reuse and
 * no step to account for — the sentences that make the action correction
 * correct are all false of an extraction, and a shared paraphrase vague enough
 * to cover both would tell the model less than either.
 *
 * Appended at the END for its reason: the last thing in the prompt is the thing
 * being answered, and the page prefix stays byte-identical so a provider prompt
 * cache still hits.
 */
function withExtractViolations(asked: string, violations: readonly string[]): string {
  const told = violations.map((violation) => `- ${violation}`).join('\n');
  return (
    `${asked}\n\n` +
    'YOUR PREVIOUS ANSWER ABOUT THIS EXACT PAGE WAS REFUSED. The page above is unchanged and is\n' +
    'the same one to answer about.\n\n' +
    `What was wrong with it:\n${told}\n\n` +
    'Answer again in the requested schema and fix exactly that. Return the whole document, not a\n' +
    'patch: this replaces the refused answer.'
  );
}

/**
 * Provider-native stop reasons that mean "cut off", as opposed to "declined".
 *
 * The gateway says `length`; a messages-style provider says `max_tokens`. Both are the same
 * event and both are carried verbatim on {@link ModelUnusableError.reason},
 * because a provider's own word is what an operator can look up.
 */
const TRUNCATION_REASONS: Readonly<Record<string, true>> = { length: true, max_tokens: true };

/* ------------------------------------------------------------------ *
 * Reading the reply
 * ------------------------------------------------------------------ */

interface AgentReply {
  readonly actions: readonly [Action, ...Action[]];
  readonly reasoning?: string;
  /**
   * The non-action half of the reply, parsed rather than discarded.
   *
   * It has to be carried separately because `validateAction` REBUILDS each
   * action from scratch — `{ type, ref }`, `{ type: 'fill', ref, text }` — so
   * every sibling field the model sent is gone by the time an `Action` exists.
   * That is correct of `validateAction`, which exists to hand back only what it
   * has checked against a tree, and it is why this is read off the raw reply
   * before the loop over `actions` rather than recovered from `actions[0]`
   * afterwards. Recovering it afterwards is impossible, and for months nothing
   * tried.
   */
  readonly envelope?: Envelope;
}

/** Reply-envelope-only property names — legal beside `actions`, never inside one. */
const ENVELOPE_ONLY_KEYS = ['reasoning', 'finding', 'ruledOut', 'goal', 'plan', 'then', 'also'] as const;

/**
 * Trivial, deterministic repairs tried on a reply that failed
 * {@link AGENT_REPLY_SCHEMA}, before it is refused.
 *
 * Every one of these is a shape a person reading the reply would recognise
 * immediately as "obviously this", which is the same bar {@link wrapBareArray}
 * sets for the extraction path: nothing here GUESSES at an action the model
 * did not name, it only untangles HOW the model named it. Measured in
 * production, 2026-09-23/24:
 *
 * - `$.actions: required property is missing` alongside `$.type`/`$.ref`/
 *   `$.text` as unexpected properties, 7 occurrences / 6 runs — the whole
 *   reply WAS the action, unwrapped.
 * - `$.actions[0].type: "goal" is not one of [...]` and
 *   `$.goal.status: "active" is not one of ["done","failed"]`, 6 occurrences /
 *   4 runs combined — a goal update misplaced as an action, or carrying a
 *   status this schema was never asked to accept.
 * - `$.actions[1].type: required property is missing` — a malformed
 *   ALTERNATIVE failing the whole reply, which is not what "an unusable
 *   alternative is dropped" (see `parseAgentReply` below) was supposed to let
 *   happen; it could not, because the whole-object schema check ran before
 *   that per-item tolerance ever got a turn.
 *
 * Returns the input unchanged, structurally, when no heuristic applies —
 * `parseAgentReply` then throws with the violations the untouched reply
 * earned, on `wrapBareArray`'s own precedent: a repair that does not produce a
 * valid document is invisible, so a genuine shape mismatch cannot hide behind
 * an attempted one.
 */
function repairAgentReply(parsed: unknown): {
  readonly value: unknown;
  readonly events: readonly NonNullable<Parameters<NonNullable<ModelClientOptions['onRepair']>>[0]>[];
} {
  if (!isRecord(parsed)) {
    return { value: parsed, events: [] };
  }
  type RepairEvent = NonNullable<Parameters<NonNullable<ModelClientOptions['onRepair']>>[0]>;
  const events: RepairEvent[] = [];
  let value: Record<string, unknown> = parsed;

  // A flat action — `{"type":"click","ref":"1-2"}` — where `actions` was
  // asked for. `type` naming a real `ACTION_TYPES` member is what makes this
  // safe: nothing else in the reply schema uses that property name, so a flat
  // object carrying it cannot mean anything but an unwrapped action.
  if (!('actions' in value) && (ACTION_TYPES as readonly string[]).includes(value['type'] as string)) {
    const action: Record<string, unknown> = {};
    const envelope: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      ((ENVELOPE_ONLY_KEYS as readonly string[]).includes(key) ? envelope : action)[key] = val;
    }
    value = { ...envelope, actions: [action] };
    events.push({ repair: 'wrapped-bare-action' });
  }

  // A goal update placed INSIDE `actions` instead of beside it, in either of
  // the two shapes measured on production `run_c251827d` (2026-10-01 12:26Z,
  // default agent): `{"type":"done",...,"goal":{...}}` — a real action with
  // the envelope field nested on it — and `{"type":"goal","id":"g1",
  // "status":"done"}` — the update written AS an action. Both came right after
  // the loop asked the model to close an open sub-goal, and both failed the
  // reply, alternating with refused finishes until the step ceiling ended the
  // run. The update moves to the reply level, where the loop reads it; a
  // reply-level `goal` already present wins. A reply that carried ONLY the
  // update keeps the run moving with a one-second `wait`, the smallest action
  // that leaves the page as it is: the loop applies the update with the step,
  // and the model's next finish is no longer held for that goal.
  if (Array.isArray(value['actions'])) {
    let hoisted: Record<string, unknown> | undefined;
    const kept: unknown[] = [];
    let moved = false;
    for (const element of value['actions'] as unknown[]) {
      if (!isRecord(element)) {
        kept.push(element);
        continue;
      }
      if (element['type'] === 'goal') {
        const inner = isRecord(element['goal']) ? element['goal'] : element;
        const update = Object.fromEntries(
          Object.entries(inner).filter(([key]) => key === 'id' || key === 'status' || key === 'summary'),
        );
        hoisted ??= update;
        moved = true;
        continue;
      }
      if (isRecord(element['goal'])) {
        hoisted ??= element['goal'];
        const rest = { ...element };
        delete rest['goal'];
        kept.push(rest);
        moved = true;
        continue;
      }
      kept.push(element);
    }
    if (moved) {
      value = {
        ...value,
        ...(value['goal'] === undefined && hoisted !== undefined ? { goal: hoisted } : {}),
        actions: kept.length > 0 ? kept : [{ type: 'wait', seconds: 1 }],
      };
      events.push({ repair: 'hoisted-goal-from-actions' });
    }
  }

  // An envelope field written ON the chosen action rather than beside it:
  // `{"actions":[{"type":"click","ref":"1-2","finding":"..."}]}`. The user
  // message's own rules say "Any action may also carry "finding"" (and
  // `then`), which reads as a property of the action, and a reply that took it
  // that way was refused whole. Measured 2026-10-13 (Scout login example,
  // local stock Chromium, a small hands model under `tool_choice`): 5 replies
  // in 4 of 7 runs carried the finding on the action. Before this repair the refusal
  // cost a second call and the answer that replaced it dropped the finding,
  // the signed-in page's heading and message. The recorded bench results hold
  // 5 more (`$.actions[0].finding: unexpected property`), one of which ended
  // its run.
  // Only `actions[0]` is untangled, because only it is performed; a field the
  // reply already carries at its own level wins and the nested copy goes.
  const chosen = Array.isArray(value['actions']) ? (value['actions'] as unknown[])[0] : undefined;
  if (isRecord(chosen)) {
    const nested = ENVELOPE_ONLY_KEYS.filter((key) => key !== 'goal' && key in chosen);
    if (nested.length > 0) {
      const action = { ...chosen };
      const lifted: Record<string, unknown> = {};
      for (const key of nested) {
        if (value[key] === undefined) lifted[key] = action[key];
        delete action[key];
      }
      value = { ...value, ...lifted, actions: [action, ...(value['actions'] as unknown[]).slice(1)] };
      events.push({ repair: 'hoisted-envelope-from-action', fields: nested });
    }
  }

  // Alternatives past the choice that fail the ACTION schema on their own
  // structure. Dropped before the whole-reply validator sees them: it checks
  // every `actions` element against the SAME item schema, so one malformed
  // alternative would otherwise refuse a reply whose actual choice,
  // `actions[0]`, was never in question. `actions[0]` itself is never
  // filtered here — an unusable CHOICE stays fatal.
  const actions = value['actions'];
  if (Array.isArray(actions) && actions.length > 1) {
    const kept = [actions[0]];
    let dropped = 0;
    for (const candidate of actions.slice(1)) {
      if (validate(candidate, ACTION_SCHEMA).length === 0) {
        kept.push(candidate);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      value = { ...value, actions: kept };
      events.push({ repair: 'dropped-invalid-alternative', count: dropped });
    }
  }

  // A goal update naming a status outside the two this schema accepts.
  // Measured shape: `"active"`, which needs no update at all — `PLAN_RULES`
  // already treats the first sub-goal that is neither `done` nor `failed` as
  // active. Dropped alone: the action the reply arrived with, and any plan or
  // finding beside it, are untouched.
  const goal = value['goal'];
  if (isRecord(goal) && goal['status'] !== 'done' && goal['status'] !== 'failed') {
    const withoutGoal = { ...value };
    delete withoutGoal['goal'];
    value = withoutGoal;
    events.push({ repair: 'dropped-invalid-goal-status', status: goal['status'] });
  }

  return { value, events };
}

/**
 * Parse the reply, or fail.
 *
 * Three ways to fail and all three are errors: text that is not JSON, JSON that
 * is not the agreed shape, and a chosen action that names a node the model was
 * not shown. The last is `validateAction`'s job and it is called here rather than
 * reimplemented — it is the sanctioned validator, it returns a typed `Action`,
 * and a second copy of its rules is how two validators come to disagree.
 */
function parseAgentReply(
  response: ModelResponse,
  tree: AxTree,
  onRepair: NonNullable<ModelClientOptions['onRepair']>,
  marks?: readonly Mark[],
): AgentReply {
  const parsed = parseJson(response, 'the agent reply', onRepair);
  const violations = validate(parsed, AGENT_REPLY_SCHEMA);
  let document = parsed;
  if (violations.length > 0) {
    const { value, events } = repairAgentReply(parsed);
    if (validate(value, AGENT_REPLY_SCHEMA).length === 0) {
      document = value;
      for (const event of events) {
        onRepair(event);
      }
    } else {
      throw new ModelSchemaError(violations, response.text, response.usage, response.costUsd, response.costSource);
    }
  }
  // The shape is established above; this narrows it for the compiler.
  if (!isRecord(document) || !Array.isArray(document['actions'])) {
    throw new ModelSchemaError(
      ['the reply is not an object with an actions array'],
      response.text,
      response.usage,
      response.costUsd,
      response.costSource,
    );
  }

  const actions: Action[] = [];
  const errors: string[] = [];
  for (const [index, candidate] of document['actions'].entries()) {
    // A mark number no badge on this screenshot carries is refused in the
    // marks vocabulary the vision prompt taught, not with `validateAction`'s
    // "frame-backendNode" sentence, which that prompt never shows. See
    // `unknownMark` for the runs this cost.
    const unknown = marks === undefined ? undefined : unknownMark(candidate, marks);
    if (unknown !== undefined) {
      if (index === 0) {
        errors.push(unknown);
      }
      continue;
    }
    // The mark number becomes a real reference BEFORE validation, and
    // `validateAction` is unchanged: one validator, one vocabulary, one error
    // message for "that element is not on this page". A mark that resolves to
    // nothing is left alone and fails there, which is exactly what an unusable
    // `ref` does today.
    const resolved = marks === undefined ? candidate : withResolvedMark(candidate, marks);
    const validated = validateAction(resolved, tree);
    if (validated.ok) {
      actions.push(validated.value);
      continue;
    }
    // An unusable *alternative* is dropped; an unusable *choice* is fatal. The
    // first action is the one about to be performed, and performing an action
    // resolved against a node that is not in the tree is exactly the race the
    // action-lock removes. A later one is a suggestion nobody has to take.
    if (index === 0) {
      errors.push(...validated.errors);
    }
  }

  const first = actions[0];
  if (first === undefined) {
    throw new ModelSchemaError(
      errors.length > 0 ? errors : ['no action in the reply resolved against the snapshot'],
      response.text,
      response.usage,
      response.costUsd,
      response.costSource,
    );
  }

  const reasoning = typeof document['reasoning'] === 'string' ? document['reasoning'] : undefined;
  /**
   * THE RAW REPLY, not `document['actions'][0]`, and that is the whole fix.
   *
   * `parseEnvelope` is `@outcrawl/runtime`'s, so the tolerance rules are the
   * loop's own: a malformed plan entry is skipped, an empty-string finding is
   * dropped, and a bad envelope never costs the caller the good action it
   * arrived with. `then` and `also` come through as raw arrays on purpose —
   * every element is validated against a tree at the moment it is dispatched,
   * and an element parsed into a trusted `Action` here would be a reference
   * this client had accepted against no page at all.
   *
   * Omitted when empty so a single-action reply produces a `ModelChoice`
   * byte-identical to the one it produced before this existed.
   */
  const envelope = parseEnvelope(document);
  return {
    actions: [first, ...actions.slice(1)],
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(Object.keys(envelope).length > 0 ? { envelope } : {}),
  };
}

/**
 * The extraction reply, validated against the caller's original schema.
 *
 * One reply shape is REPAIRED rather than refused — see {@link wrapBareArray} —
 * and the order here is what keeps that safe: the reply is validated as it
 * arrived FIRST, so the repair is only ever consulted for a document that has
 * already failed, and it is only ever accepted when the repaired document
 * satisfies the whole schema. A reply that fails for any other reason fails
 * with the violations it earned, unrepaired and unrephrased.
 */
function parseJsonReply(
  response: ModelResponse,
  schema: JsonSchema,
  onRepair: NonNullable<ModelClientOptions['onRepair']>,
): unknown {
  const parsed = parseJson(response, 'the extraction', onRepair, schemaFields(schema));
  const violations = validate(parsed, schema);
  if (violations.length === 0) {
    return parsed;
  }

  if (schema === FREE_TEXT_SCHEMA && isRecord(parsed) && parsed['data'] !== null && typeof parsed['data'] === 'object') {
    const stringified = { ...parsed, data: JSON.stringify(parsed['data']) };
    if (validate(stringified, schema).length === 0) {
      onRepair({ repair: 'stringified-free-text' });
      return stringified;
    }
  }

  const wrapped = wrapBareArray(parsed, schema);
  if (wrapped !== undefined && validate(wrapped.value, schema).length === 0) {
    onRepair({ repair: 'wrapped-bare-array', property: wrapped.property, items: wrapped.items });
    return wrapped.value;
  }
  throw new ModelSchemaError(violations, response.text, response.usage, response.costUsd, response.costSource);
}

/**
 * A bare JSON array, wrapped into the one object property the schema requires.
 *
 * ── The failure this repairs, measured ─────────────────────────────────────
 *
 * `./chat-completions` sends `response_format: { type: 'json_schema', strict: true }`
 * and documents, with its own measurement, that a POOLED provider may take the
 * request without enforcing it. What arrives then is a well-formed HTTP 200
 * carrying valid JSON of the wrong shape. On the Facebook Ad Library page the
 * shape was always the SAME wrong shape: the bare array of items, with the
 * object envelope omitted. Measured 2026-09-12 across the same fixed 47,401-
 * character render: 2 of 20 replays (this run), and 2 of AdCountStable's 5
 * `ModelSchemaError`s in 37 calls, every one of them `$: expected object, got
 * array` with the array's elements otherwise satisfying the item schema.
 *
 * ── Why this cannot mask a real mismatch ───────────────────────────────────
 *
 * FOUR conditions, all required, and they leave exactly one possible
 * destination for the array:
 *
 * 1. the reply parses as an array,
 * 2. the root schema is an object,
 * 3. its `required` names EXACTLY ONE property, and
 * 4. that property is declared an array.
 *
 * With one required array property there is no second field the model might
 * have meant, nothing to guess about ordering, and no optional sibling that
 * could have carried it — an object schema requiring two properties, or one
 * whose single required property is a string, does not qualify and still fails.
 * The caller's validator then has the final say either way: the wrapped
 * document is returned only if it satisfies the whole schema, so a bare array
 * of the WRONG items is refused with the same violations it would have been
 * refused with before this existed.
 *
 * And it is never silent: {@link ModelClientOptions.onRepair} fires on every
 * accepted repair, because a repair nobody can count is a repair nobody can
 * tell has started masking something.
 */
function wrapBareArray(
  parsed: unknown,
  schema: JsonSchema,
):
  | {
      readonly value: Record<string, readonly unknown[]>;
      readonly property: string;
      readonly items: number;
    }
  | undefined {
  if (!Array.isArray(parsed) || schema['type'] !== 'object') {
    return undefined;
  }
  const required: unknown = schema['required'];
  if (!Array.isArray(required) || required.length !== 1) {
    return undefined;
  }
  const property: unknown = required[0];
  const properties: unknown = schema['properties'];
  if (typeof property !== 'string' || !isRecord(properties)) {
    return undefined;
  }
  const declared: unknown = properties[property];
  if (!isRecord(declared) || declared['type'] !== 'array') {
    return undefined;
  }
  return { value: { [property]: parsed }, property, items: parsed.length };
}

/**
 * `JSON.parse`, as an error rather than a crash — with ONE repair attempted
 * first: text the model wrote OUTSIDE the JSON object despite structured
 * output being requested. Measured production shape, 2026-09-23/24: 7 of 38
 * "not valid JSON" failures parsed as `Unexpected identifier "The"` (or "I",
 * or the two concatenated across a correction — "IThe", "TheThe"), which is
 * JSON's parser reading the first word of a sentence where a value was
 * expected — narration instead of, or beside, the object.
 *
 * Repaired by keeping only the substring from the first `{` to the last `}`
 * and re-parsing THAT — nothing inside the range is touched, so a reply that
 * is genuinely malformed once the wrapper is gone still fails, with that
 * attempt's own message rather than a fabricated one. Never attempted when it
 * would re-parse the identical string: a reply that already starts at `{` and
 * ends at the final `}` already failed above, and asking the same parser the
 * same question twice is not a repair.
 *
 * The empty reply is called out separately because it has a different cause: a
 * grammar-constrained call that produced nothing at all is a provider problem,
 * while a parse failure means the model wrote prose where JSON was promised. Both
 * are failures; someone reading the message should not have to guess which.
 */
function parseJson(
  response: ModelResponse,
  what: string,
  onRepair: NonNullable<ModelClientOptions['onRepair']>,
  /** The schema's top-level fields: tagged replies are mapped only onto these, one to one. Absent: the old invoke rule. */
  fields?: SchemaFields,
): unknown {
  if (response.text.trim() === '') {
    throw new ModelSchemaError(
      [`${what} was empty`],
      response.text,
      response.usage,
      response.costUsd,
      response.costSource,
    );
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch (cause) {
    // Before the wrapper strip: an XML tool call's parameter value is itself
    // a `{…}`, which the strip would take for the whole reply.
    const invoked = fromInvokeXml(response.text, fields);
    if (invoked !== undefined) {
      onRepair({ repair: 'invoke-xml', parameters: Object.keys(invoked).length - 1 });
      return invoked;
    }
    const tagged = fields !== undefined && TOOL_TAG.test(response.text);
    // Any wrapper, not only tool-call tags: a ```json fence, other markup.
    // The first-`{`-to-last-`}` strip below fails as soon as the wrapper holds
    // a second copy or a brace of its own, and live10 on ea609076 (2026-10-03
    // 10:36-10:38Z) re-asked 3 of 52 brain calls that began with '`' or '<'
    // and carried no tool-call tag (their text was not recorded, so the exact
    // shape is inferred from the parse error).
    if (tagged || (fields !== undefined && WRAPPER.test(response.text))) {
      const objects = [...jsonObjectsIn(response.text)];
      const reply = objects.find((object) => mapsOnto(Object.keys(object), fields));
      if (reply !== undefined) {
        onRepair({ repair: 'tagged-json', objects: objects.length });
        return reply;
      }
    }
    const start = response.text.indexOf('{');
    const end = response.text.lastIndexOf('}');
    const shrinks = start !== -1 && end > start && (start > 0 || end < response.text.length - 1);
    if (shrinks) {
      try {
        const stripped = JSON.parse(response.text.slice(start, end + 1)) as unknown;
        onRepair({ repair: 'stripped-json-wrapper', removedChars: response.text.length - (end + 1 - start) });
        return stripped;
      } catch {
        // The wrapper theory was wrong. Falls through to the ORIGINAL parse
        // failure below, which is still the honest report of what happened.
      }
    }
    // A TAGGED REPLY THAT MAPS ONTO NOTHING: asked again (once, by the
    // caller's correction loop) with what the tags said, so the model can
    // restate the same decision as JSON. The generic "Unexpected identifier"
    // told it only that its first word was wrong, and on BrainMeasure H1
    // (2026-10-03 07:55Z) the re-asked brain dropped the navigate it had
    // tagged and answered with a read of the page it meant to leave.
    if (tagged) {
      throw new ModelSchemaError(
        [
          `${what} carried its decision in tool-call tags that do not map onto the schema's fields` +
            `${tagContents(response.text)}. Reply with that same decision as one JSON object, no tags`,
        ],
        response.text,
        response.usage,
        response.costUsd,
        response.costSource,
      );
    }
    throw new ModelSchemaError(
      [`${what} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
      response.text,
      response.usage,
      response.costUsd,
      response.costSource,
    );
  }
}

/** Words a refused reply's shape keeps: the brain schema's keys, action types and the markup words seen in refusals. */
const SHAPE_WORDS = new Set([
  'do', 'a', 'act', 'say', 'read', 'final', 'done', 'fail', 'hands', 'until', 'answer', 'why', 'need', 'no', 'note', 'goal', 'then', 'expect', 'plan',
  'type', 'ref', 'url', 'text', 'key', 'value', 'tab', 'click', 'fill', 'select', 'press', 'scroll', 'navigate', 'wait', 'focusTab', 'openTab', 'callTool',
  'invoke', 'parameter', 'name', 'function_calls', 'json', 'true', 'false', 'null', 'Correction',
]);

/**
 * A refused reply's STRUCTURE with its content masked, for the operator log:
 * markup, fences, JSON punctuation and {@link SHAPE_WORDS} are kept; every
 * other run of letters becomes `w` and every run of digits `9`, so the page
 * data a reply quotes never reaches a log. A brain call's generation id
 * cannot recover its text (the gateway's generation-content lookup: 404 "Content not
 * available", 2026-10-03), and the parser can only be fixed for shapes it can
 * see. At most 300 characters.
 */
export function replyShape(sample: string): string {
  const masked = sample
    .replace(/[\p{L}_][\p{L}\p{N}_:-]*/gu, (word) => (SHAPE_WORDS.has(word) || /^[\w-]+:(?:invoke|parameter|function_calls)$/.test(word) ? word : 'w'))
    .replace(/\p{N}+/gu, '9')
    .replace(/\bw(?:[ \t]+w\b)+/g, 'w…');
  return masked.length > 300 ? `${masked.slice(0, 299)}…` : masked;
}

/** Tool-call markup in a reply: `<invoke…>`, `</invoke>`, `<parameter…>`, with or without a namespace prefix. */
const TOOL_TAG = /<\/?(?:[\w-]+:)?(?:invoke|parameter)\b/;

/** A reply wrapped in something other than bare JSON: a code fence or any markup tag. */
const WRAPPER = /```|<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?>/;

/** A schema's top-level fields, as tagged replies are mapped onto them. */
interface SchemaFields {
  readonly names: ReadonlySet<string>;
  /** `additionalProperties: false`: a key that is not a field cannot map. */
  readonly closed: boolean;
}

/** A JSON schema's top-level fields, or `undefined` for a schema that names none. */
function schemaFields(schema: JsonSchema): SchemaFields | undefined {
  const record = schema as { readonly properties?: unknown; readonly additionalProperties?: unknown };
  return isRecord(record.properties)
    ? { names: new Set(Object.keys(record.properties)), closed: record.additionalProperties === false }
    : undefined;
}

/**
 * Whether keys map one to one onto the schema: at least one, the `do` a
 * schema with `do` needs, and, for a closed schema, nothing else. An open
 * schema (the brain's) takes other keys as the schema itself does: its
 * reader decides what they mean (`readDecision` reads `action` as `a`).
 */
function mapsOnto(keys: readonly string[], fields: SchemaFields): boolean {
  return (
    keys.length > 0 &&
    (!fields.names.has('do') || keys.includes('do')) &&
    (!fields.closed || keys.every((key) => fields.names.has(key)))
  );
}

/** What a reply's tags said, for the correction: `: "navigate | url | …"`, or `''` when they said nothing. */
function tagContents(text: string): string {
  const said = [...text.matchAll(/<(?:[\w-]+:)?(invoke|parameter)\b([^>]*)>([\s\S]*?)(?=<\/?(?:[\w-]+:)?(?:invoke|parameter)\b|$)/g)]
    .map((match) => `${/name="([^"]*)"/.exec(match[2] ?? '')?.[1] ?? ''} ${(match[3] ?? '').trim()}`.trim())
    .filter((part) => part !== '');
  const joined = said.join(' | ');
  return joined === '' ? '' : ` (they said: ${joined.length > 300 ? `${joined.slice(0, 299)}…` : joined})`;
}

/** Each complete, parseable JSON object in `text`, outermost first, in order. */
function* jsonObjectsIn(text: string): Generator<Record<string, unknown>> {
  for (let start = text.indexOf('{'); start !== -1; ) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) return;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(parsed)) yield parsed;
    } catch {
      // Not JSON after all: look at the next object.
    }
    start = text.indexOf('{', end + 1);
  }
}

/**
 * A tool-call reply rebuilt as the JSON object it stands for, or `undefined`:
 * - `<invoke name="act"><parameter name="a">{…}</parameter></invoke>`
 *   → `{"do":"act","a":{…}}` (the first invoke block);
 * - with `fields` (the schema's own field names) also the two shapes recorded
 *   without a named invoke: bare `<parameter name="do">…</parameter>` blocks,
 *   and `<invoke>read</invoke>` followed by parameter blocks (do = read).
 * With `fields`, each parameter becomes exactly one key (empty ones carry
 * nothing and are dropped) and the result must map onto the schema (see
 * {@link mapsOnto}), else `undefined` so the reply is asked again rather than
 * guessed at. Without `fields`: the first named invoke, any parameters.
 */
function fromInvokeXml(text: string, fields?: SchemaFields): Record<string, unknown> | undefined {
  const parameters = (body: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const match of body.matchAll(/<(?:[\w-]+:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:[\w-]+:)?parameter>/g)) {
      const raw = (match[2] ?? '').trim();
      if (fields !== undefined && raw === '') continue;
      try {
        out[match[1] ?? ''] = JSON.parse(raw) as unknown;
      } catch {
        out[match[1] ?? ''] = raw;
      }
    }
    return out;
  };
  // The closing tag may be missing: a reply cut at the token cap ends where
  // the tag would have been.
  const named = /<(?:[\w-]+:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/(?:[\w-]+:)?invoke>|$)/.exec(text);
  let out: Record<string, unknown> | undefined;
  if (named !== null) {
    out = { do: named[1], ...parameters(named[2] ?? '') };
  } else if (fields !== undefined) {
    const bare = /<(?:[\w-]+:)?invoke>\s*([A-Za-z]+)\s*<\/(?:[\w-]+:)?invoke>\s*(?=<(?:[\w-]+:)?parameter\b)/.exec(text);
    const params = parameters(bare === null ? text : text.slice(bare.index));
    out = bare === null ? params : { do: bare[1], ...params };
  }
  if (out === undefined || Object.keys(out).length <= 1) {
    return undefined;
  }
  return fields === undefined || mapsOnto(Object.keys(out), fields) ? out : undefined;
}
