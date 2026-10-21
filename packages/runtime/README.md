# @outcrawl/runtime

The agent loop: take an accessibility snapshot, ask a model for an action, freeze the page,
act on a frame-qualified node id, repeat until a cap or a terminal action stops it. One head
action a step by default — `then` chains up to `MAX_PROGRAM` = 2 more on the same tab and `also`
drives up to `MAX_FAN` = 4 other tabs, and both are off unless the request asks. Opens no
socket, speaks no CDP, spawns no process — the browser is injected as `AgentDeps`, so anything
satisfying it is a complete test bed. Without this package `POST /v1/agent` and
`Outcrawl.observe` have no loop.

## Surface

- `runAgent(deps, request)` — the loop. Reports steps through a callback, returns an
  `AgentResult` once; `@outcrawl/worker`'s `jobScopedRuntime` bridges it to the
  `AsyncGenerator` the API `stream` wants. Hands the session out via `AgentRunRequest.onSession`.
- `observe(deps, request)` — resolves an instruction to candidate actions and executes none;
  the lock is held across snapshot and model call here too. Answers `Outcrawl.observe`.
- `actions.ts` — `ACTION_TYPES`, a closed TWENTY-ONE-action union: `click`, `fill`, `select`,
  `press`, `hover`, `scroll`, `drag`, `navigate`, `extract`, `openTab`, `focusTab`, `closeTab`,
  `wait`, `attachFile`, `createFile`, `ask`, `callTool`, `purchase.begin`, `purchase.end`, `done`,
  `fail`. Every action is data — no closures, no
  handles, nothing that expires. `purchase.begin { amount, currency }` and `purchase.end` (outcome
  in `value`, final amount in `amount`, order reference in `text`) go to `AgentRunRequest.purchases`
  outside the freeze; the merchant is the tab's top-level origin, never a model field, and an
  approval parks the run with `pause.ask.kind: 'approval'`. `wait` leaves the page live for 1-10 s and does nothing else:
  the page is frozen between steps, so without it a page's own timers never ran while the model
  waited. A scroll whose `ref` names the document (`0`, `doc`, `0-doc`) scrolls the page.
  `click` takes a `ref` OR `at: {x, y}`, a viewport point in CSS pixels (what `page.look`
  answers with), for what the tree cannot name: a spot on a canvas. `drag` takes `from` and `to`,
  each a `"F-N"` ref or a point, and is one press, held path and release; point-to-point drags
  are bounded here (`MIN_DRAG_PX`, `MAX_DRAG_PX`) and the host checks every end against the live
  viewport. A point click names no node, so the action cache withholds it and the outcome check
  is "the page changed" with no target.
  `validateAction` refuses a reference naming no node in the tree
  the model was shown. The three tab actions are served by the optional `AgentDeps.tabs`: absent
  means single-tab and they refuse at the point of use rather than at construction, same as
  `solveChallenge` and `AgentDeps.tools`.
- These non-terminal verbs leave `done` and `fail` as the terminal actions:
  - `AttachFileAction` — `file` is the HANDLE `POST /v1/agent/{id}/files` minted, never a path
    and never bytes. The body is fetched at the instant the action runs and pushed with
    `DOM.setFileInputFiles` BELOW the model, so the model addresses a handle and never sees the
    bytes. A model that could name a path could name `/etc/passwd`; a model that could carry
    bytes would put a customer's document into a prompt, which is the one place in this system
    whose retention we do not control.
  - `CreateFileAction` — the agent writes a small file of its own (`file` is the new file's
    name, `text` its content) into the run's own upload space, for a form that demands an
    upload the task did not provide. The extension picks the renderer (`CREATABLE_FILE_TYPES`:
    text types verbatim, `.pdf` a one-page placeholder printing the text, `.png` a plain
    placeholder image). Executed by `AgentDeps.files.create` above `page.perform`; the new
    handle (`file_made_…`) is put in the manifest at once and attached with `attachFile`. Offered
    only when the host binds `create`. The machine caps it (5 files, 1 MiB each per run) and the
    edge's per-plan upload count skips it, so it never uses up the customer's own quota; it is
    destroyed with the run like every upload.
  - `AskAction` — parks the run on a question a human answers through
    `POST /v1/agent/{id}/answer`. It neither touches the page nor ends the run. `parkForAnswer`
    appends the question BEFORE it waits on anything — a question recorded after its answer is a
    question nobody could have answered — stops the duration clock through `CapLedger.park`,
    because the customer's ceiling is protection against OUR loop running away and not against
    their own reply time, and pushes the answer, or the fact that none came, into `findings`,
    which are exempt from compaction. Bounded rather than open-ended:
    `AgentRunRequest.askWaitMs`, defaulted by `DEFAULT_ASK_WAIT_MS` (30 minutes),
    ceilinged by `MAX_ASK_WAIT_MS` (one hour) and the remaining browser-time budget. A question on a
    run nobody is known to watch (`AgentRunRequest.answerable` false: no `notify.level` step/debug,
    no take-control, no earlier answer) parks at most `UNATTENDED_ASK_WAIT_MS` (two minutes);
    purchase approvals always get the full wait. An unanswered question tells the model to proceed
    on its own judgment (`unansweredProceed`), naming createFile + attachFile when the run can create files.
    The answer finding is acknowledged before the loop acts again. An absent or
    failed channel is named explicitly, never reported as a fictitious elapsed wait.
    Its second form, `{"type":"ask","value":"card"}` (or `"details"`, validated to
    `SecretAskAction.want`), asks a person for a whole card or billing profile the run does not hold,
    through `AgentRunRequest.secretAsks` (the host's run secret channel, the security-code question's
    own pause and wait), never through `/answer`. Offered only to a run with `caps.spend`, a person to
    ask and no card (or details) held; the question names the purchase the loop holds open. An
    arrival's placeholders ride the next prompt, and `AgentDeps.secretGrammar` is re-read every
    prompt; nothing arriving fails the step with the instruction to abandon the purchase and end
    partial. On such a run a free-text question asking for card or billing details is refused.
  - `CallToolAction` — the only verb that leaves the browser entirely. It calls a tool on an MCP
    server the workspace connected and the submit named: `tool` is `<connector>.<tool>`, resolved
    through the optional `AgentDeps.tools` (`ToolPort.list` once per run, `ToolPort.call` per
    action). Absent means this run reaches nothing outside the browser, and that is the default
    rather than a degraded mode — deny by default is the containment story, so a page that talks
    a model into mailing a table to an attacker is talking to a run with no mail connector.
    `arguments` are passed through unvalidated on purpose: the shape is the REMOTE server's
    schema, and one authority on it beats two that can disagree. Dispatched by its own `case`
    ABOVE `default: page.perform`, because `perform` tolerates a `void` return and a `callTool`
    that fell through it would tell a model it had read a mailbox it never opened. A reply
    reporting `isError` is a FAILED step, so `stepFailures` bounds a model calling a broken tool
    forever; the replies themselves ride `AgentPrompt.toolResults`, bounded to `TOOL_ECHO_WINDOW`
    = 3, and never reach the durable trace, because a trace goes to a webhook and that text is
    somebody's inbox.
- `snapshot.ts` — `NodeRef` (branded, minted only by `nodeRef()`), `filterTree`,
  `serializeTree`, `findNode`, `hashSnapshot`. `caps.ts` — `validateCaps`, `CapLedger`,
  `parseDuration`, `capStopReason`, `GoalLedger`, `GoalCapPolicy`.
- `result.ts` — `AgentResult` (carrying `goals`, `findings` and `ruledOut` — the complete record,
  including what the prompt's ceiling compacted away), `StepTrace`, `evaluateSchema`, `mergeData`
  (records merge field by field at every depth; a later `null` or blank keeps the held value),
  `nullableReadSchema` (the run's schema with every record field allowed `null`, which every agent
  read is held to), `mergeUsage`, `resolveStatus`, `aggregateCache`, `toWireResult`/`toWireStep`, `GoalState`,
  `GoalStatus`, `AgentMemory`, `Finding`, `RuledOut`, `boundMemory`, `MEMORY_CHAR_BUDGET`,
  `FINDINGS_CHAR_BUDGET`.
  `loop.ts` — `AgentDeps` (`snapshot`, `lock`, `unlock`, `perform`, `extract`, `model`, plus
  optional `capture`, `document`, `solveChallenge`, `tabs`, `tools`, `clock`, `wallClock`),
  `ModelPort` (implemented by `@outcrawl/model`, consumed by `@outcrawl/worker`), and
  `PageSession` (`withSolve`, `capture`, `noteLockReleased`, `interrupt`, `release`).
- `settle.ts` — `settleTree`, `DEFAULT_SETTLE_POLICY`, `SettleReport`, `unrenderedNotice`,
  `challengeNotice`, `DocumentProbe`. See "A challenge is not a page" below.

## The reply envelope

- **The envelope is grammatical.** `plan`, `finding`, `ruledOut`, `goal`, `then` and `also` are
  declared properties of `AGENT_REPLY_SCHEMA` in `@outcrawl/model`'s `client.ts`, and
  `ACTION_SCHEMA` is declared once under `$defs` and referenced from `actions`, `then` and `also`
  through `ACTION_REF`, so the three positions cannot drift apart. Any README or comment that
  still says the envelope cannot be emitted is stale.
- **What the previous state cost is the most important sentence in this file.** Under strict
  structured output with `additionalProperties: false` an undeclared property is not discouraged,
  it is UNGRAMMATICAL — the sampler cannot produce it. So `FINDING_RULE` asked every run for a
  finding the sampler could not emit and `AgentResult.findings` was always empty; `planOwed`
  declined the first `done` for want of a plan that could not exist; and `then` never arrived,
  which made the motor program identical to its own control BY CONSTRUCTION. Nothing failed and
  nothing logged, because a model that cannot answer looks exactly like a model with nothing to
  report.
- The consequence for a reader: **any measurement of findings, planning or motor programs taken
  before this landed measured the schema, not the harness.**
- The loop reads the envelope from `ModelChoice.envelope` first and off the raw action object
  second (`parseEnvelope`), and the explicit field wins, so neither kind of client can silently
  drop a plan. `applyEnvelope` applies it and it costs the model no step.

## Lock, interrupts and node references

- The lock is held across think **and** act. Touching the page without it throws; it is
  released on every path including a throw. This removes TOCTOU: a page that changes while the
  model thinks for 5–15 s would land the action on something else. Chromium supplies both
  halves from outside this package: `VirtualTimePolicy::kPause` and `ScopedIgnoreInputEvents`.
  Filtering the AX tree to interactive roles is not tidying: it is most of what a run costs.
- **A DOM mutation under the lock makes every subsequent screenshot of that page HANG.** Measured
  2026-09-07 against the shipped binary, headful. Under `Outcrawl.lock` a `Runtime.evaluate`
  resolves in ~82 ms, the mutation really happens, `requestAnimationFrame` even reports that it
  fired — and then `Page.captureScreenshot` never answers again until unlock. Not an error: no
  reply. A caller with no timeout waits forever, and a caller with one blames the network. The
  cause is that the capture waits for a compositor frame `VirtualTimePolicy::kPause` will never
  produce. Capturing an ALREADY-PAINTED page under the lock is fine — 118 ms, and it returns the
  current frame rather than a stale one. So anything that paints in order to photograph
  (`AgentDeps.capture` and its set-of-marks overlay) MUST do so at lock depth 0, which is what
  `PageSession.capture` enforces, and any capture taken under the freeze needs a timeout.
  Reachable by a customer, and worth knowing before one finds it: `Outcrawl.lock` is a
  PAGE-session command and the page-session form takes no control key, and the tenant CDP path has
  no command allowlist, so a `/connect` tenant can lock their own page, mutate it, and hang their
  own `Page.captureScreenshot`. Self-inflicted and confined to that session — the tenancy patch
  scopes targets, so there is no cross-tenant reach. The fix, whenever it is made, should convert
  the hang into an error: a CDP command that never answers is worse than one that fails.
- `PageSession.withSolve` releases the lock around an in-page captcha solve (a frozen page runs
  no vendor challenge script) and re-takes it after; a solve on a frozen page is refused.
  `PageSession.noteLockReleased` is the intake for the browser releasing a lock on its own
  (`timeout`, `navigated`, `rendererGone`, `sessionEnded`); a page touched afterwards fails
  loudly. **The caller must bind that event** — this package cannot.
- `PageSession.interrupt(who)` takes the freeze down for a viewer. Exclusivity is checked here
  as well as at whatever granted the handle, a second driver is refused and the first keeps the
  page, `release()` is idempotent, and the run resumes with a fresh freeze over a fresh
  snapshot. `controlTaken` is the one `LockLossReason` that is a decision and the only one not
  charged to `stepFailures`; the step is still recorded and still costs a step. An interrupt
  does not interrupt a gesture already dispatching: that took the freeze down itself and owes
  `Outcrawl.lock` in its `finally`.
- Node references are frame-qualified, because `DOMNodeIds::IdToNodeMap()` is a
  per-renderer-process static and cross-origin iframes run in separate processes, so two nodes
  in two frames can share an id. `backendNodeId` may be **negative** — Blink numbers AX objects
  with no DOM node behind them from near `INT_MIN/2` downward. Zero is refused:
  `ui::kInvalidAXNodeID` is a resolution failure that has been allowed to travel.

## Caps and terminals

- All three caps are required and enforced: `{ steps, budget, duration }`, budget a decimal
  string end to end. A cap firing ends the run `capped` and returns what it collected. Data
  collected before the end comes back on every status; `capped` is distinct from `partial`.
- A run ends on the model's `done` or on its schema being satisfied; both refuse while a
  sub-goal is open. Schema satisfaction is tested only on the step that recorded an extraction
  that **answers** (`answersTask`: `"final":true`, or the schema filled with no instruction). An
  extraction without it is a look at the page: collected and recorded, read back to the model on
  the next prompt, and never the thing that ends the run — nor is any later click or navigation.
  `fail` is checked before the schema and gated by none of this: an honest refusal ends
  `failed` / `error` on the step it is made, and a run that never satisfies its schema caps as
  before.
- A run that ends with an answer first scrolls the element holding it into view (the host's
  human-modelled wheel, `scroll` with `reveal: true`), found by the answer's own text in the last
  tree read. Not a step, no extra page read, and nothing at all when no visible node holds it.
- The schema hold is bounded on **closure**, not steps (`SCHEMA_HOLD_TOLERANCE`): any sub-goal
  closing resets the allowance, and after three consecutive held steps with no closure the loop
  closes the remainder `failed`, says so in the summary, and ends the run — never closing one
  `done` on the model's behalf. A run whose sub-goals it closed is `partial`, never `completed`.
- **A run that stops moving the page stops** (`NO_PROGRESS_TOLERANCE` = 25, `loop-detected`).
  A step counts as standing still only if the tree it was chosen against is the one the last
  step saw AND the run recorded no finding or ruled-out entry AND the plan did not move; `ask`
  and `callTool` reset it outright, because the page is frozen across both by design. Bounded on
  CHANGE and never on depth, which is what leaves a deep run that is working untouched. The stop
  is not a cap: `cappedBy` stays unset, the run is `failed` or `partial`, and it carries a
  `stopReason` no other exit uses, so a killed wander can never read as `completed`. Measured:
  the three capped runs in the only 282-read per-step record held one identical tree for 55, 55
  and 33 consecutive reads, against 17 for the deepest run that finished — `loop.ts`'s constant
  carries the derivation and `test/measure-no-progress.ts` re-derives it.
- A run whose caps could fund a plan (`PLANNING_STEP_THRESHOLD`) and that has never stated one
  has its first finish declined **once**, with the exact shape to answer it; the decline is not
  routed through `stepFailures`. A shorter run is never asked, its prompt unchanged byte for
  byte. The loop never guesses task structure from task text or schema.
- **A step trace is emitted whether the step succeeded or threw** — a step missing because it
  failed is the one a dispute is about.

## Rules gate the dispatch

- `rules.ts` evaluates one compiled customer rule against the action about to be dispatched.
  `checkRules` answers a `RuleRefusal` or nothing; `enforceRules` THROWS `RuleBlockedError`, and
  it is called BEFORE `page.perform`, so a blocked action never touches the page. That ordering
  is the whole difference between a gate and a warning. A `RuleRefusal` carries the customer's
  own sentence verbatim plus the evidence that tripped it — never a verdict without evidence.
- `checkNavigationRules` is the arm for the one dispatch site that has a url and no tree: a
  fanned `openTab`, which opens a page that does not exist yet. Only the domain gates are
  consulted, because only they are answerable without a page — and a run whose rules forbid a
  host must not be able to reach it by opening it in another tab. Every other site has a tree and
  calls `checkRules`, which subsumes this.
- A chained element of a motor program is checked with `checkRules` and not `enforceRules`. The
  head action's refusal IS the step and therefore throws; a chain has already bought a successful
  step and is stopped rather than failed.
- `renderRules` splits the set the way the customer was shown it: a rule with a gate is enforced,
  a rule whose `gate` is `null` is guidance and is rendered into the prompt. Both halves reach
  the model through `AgentPrompt.rules`.

## Resume may report and may not act

- `RunIntent` is what a resumed run is handed. `intentFrom(previous, result, marks)` folds a lost
  attempt into the next one's intent, and `resumeNotice` is the paragraph its first prompt opens
  with: the page it was on, every node reference it held and any form it had half-filled are gone.
- `mayAct(intent)` is `intent.irreversible.length === 0`, or (OC-316) an exit switch whose step
  comes after every mark AND that the host `confirmed` (a real page committed through the old exit
  after the last mark). Such a resume is told every mark, and a new mark of the same kind on the
  same host (for `suspected`, also the same control) is refused before it is written or sent. A resume that may not act returns
  `reportOnlyResult` before a lock is taken, a model is called or a page is read — nothing is
  provisioned, because "may not act" has to mean nothing could have acted.
- `IrreversibleSink` (`AgentRunRequest.onIrreversible`) is AWAITED before dispatch, in the order
  classify (`classifyIrreversible`), commit (`markFor`), dispatch. Not caught, so a sink that
  cannot commit takes the dispatch down with it: an irreversible act nobody recorded IS the
  double charge. The mark says ATTEMPTED and never COMPLETED — we cannot know whether the payment
  went through, only that we tried, and *tried* is already enough to refuse a resume.
- A chained action may not be irreversible at all. The classifier runs over each element and the
  program aborts with a reason rather than committing a mark mid-sequence.

## Verification

- ON by default. `OUTCRAWL_VERIFY=off` (`VERIFY_ENV`, read at `@outcrawl/worker`'s composition
  root) is the operator's only kill switch: no HTTP body, MCP tool call or CLI flag reaches it,
  and there is no `verify` field on `AgentRequest`. `AgentRunRequest.verify` defaults to off in
  this package's own signature so that a caller which states nothing — `packages/bench`'s
  baseline arm — keeps the behaviour it measured.
- `expectationFor(action, chosenFrom, hash)` derives what one page read could falsify.
  `Expectation.kind === 'none'` short-circuits, so an unchecked action costs nothing at all.
  `checkAction` takes the read inside the freeze the step already holds and filters it exactly as
  the step's own read was filtered — a filtered before against a raw after would report every
  dropped node as a change.
- `checkReportedUrl` judges a `navigate` on `outcome.url` at ZERO page cost, and it is preferred
  rather than merely cheaper: a page that has just committed under the freeze cannot produce an
  accessibility tree at all, so the read path can only ever answer `unchecked` there. The read
  stays the fallback for a binding that reports no url, which is every test bed in this package.
- A `contradicted` verdict writes a `ruledOut` entry through `contradictionNote`. That array is
  permanent, exempt from compaction and printed on every later prompt, and until this existed it
  had no producer the model could not veto. `contradictionKey` is the identity a repeat is judged
  on: the same action at the same reference.

## The input ceiling

- **The action page has a character ceiling.** `TREE_TOKEN_BUDGET` is a 5,000-token
  estimate, spent as `TREE_CHAR_BUDGET` = 12,500 characters at `CHARS_PER_TOKEN` = 2.5.
  The character bound keeps cached choices deterministic without a per-vendor tokenizer.
  The measured ratios motivating it were 2.52 on HN front, 2.90 on an HN comment thread,
  and 3.57–3.68 on saucedemo; these samples do not guarantee a token ceiling on other pages.
- Why it exists, in one measurement: a late step on a 573-comment Hacker News thread rendered
  **67,246 tokens, of which the serialized tree was 66,539 — 98.9%.** Everything else in the
  prompt combined is 659. Bounded, the same step is 5,331. Nothing bounded the total before:
  `maxNameLength` caps one node's name, and prompt size was O(nodes on the customer's page).
- **It never binds on an app-shaped page and buys nothing there.** All six saucedemo checkout
  pages serialize byte-identically with and without the budget; that shape was measured at 1,241
  input tokens a step and was never the expensive one.
- What gets dropped, and it is not ranked by actionability: a **document-order prefix** for all
  but a reserve, then the **reserve walked backward from the end of the page keeping actionable
  nodes only**. Document order because on that thread 2,918 of 5,704 nodes are actionable —
  every comment carries reply/parent/context/user links — so ranking by actionability keeps 485
  naked links and zero labelling text. Backward because the controls a step needs from a page
  too long to show are terminal: a form's submit, a thread's "More", a list's "Next".
- **Truncation is announced, never silent**, and the notice is paid for out of the budget rather
  than added to it. It states the counts and the one thing a model would otherwise get wrong:
  scrolling cannot reveal the rest, because `AxNode` carries no geometry and a scroll returns a
  byte-identical tree. `extract` can target relevant rows outside the action prompt.
- **Agent extractions carry a money-derived input allowance.** The model client starts from
  the full serialized page, then ranks requested words and retains surrounding rows within a
  conservative UTF-8 byte bound. System/instruction/schema text, gap notices and schema
  corrections count against each request's allowance. The intentional 5,000-token allowance
  floor remains; supplied-text accounting does not measure provider-added framing or cap the
  total cost of multiple correction attempts. Actual provider usage is still billed unchanged.
- **A cut read cannot be bought again unchanged in the same running attempt.** The loop
  remembers the exact trimmed instruction and ordered full page after a cut extraction. An
  identical repeat is refused before another extraction call; changing only `final` cannot
  bypass this. Different targeted questions and changed page content/order remain allowed.
  Cut metadata stays on the step, and the prompt tells the agent not to claim omitted coverage.
- **Only an extraction that asks says where links go.** `Outcrawl.getAXTree` carries no URL, so
  the worker reads `href`s for an `extract` whose instruction or schema asks for a link, URL or
  download (`worker/src/link-hrefs.ts`: one inert `DOM.describeNode` per renderer, a 2.5 s
  deadline, http/https/ftp/mailto/tel only, at most 30,000 characters of destinations with the
  rest counted). `serializeTree` ends such a line `->"https://..."`, JSON-quoted and never
  clipped, and states on `AxTree.hrefs` what was omitted or unread. The action prompt never
  carries one: on the pages 199 recorded runs stood on, hrefs beside every link line would cost
  a median 938 tokens a step on a prompt that is capped. `AxNode.href` is not in `hashSnapshot`.
- **The page is not the only ceiling, and the other three have names.**
  `FAN_TREE_CHAR_BUDGET` = 12,500 (`fan.ts`) bounds a fanned step's OTHER tabs as a group and not
  per tab, on top of the focused tab's own `TREE_CHAR_BUDGET`, so a fanned step shows at most 2x
  a serial step's page however many tabs are open, and each tab that did not fit states its own
  elision rather than looking like a short page. `MEMORY_CHAR_BUDGET` = 2,500 is spent SEPARATELY
  against the `goals` and `ruledOut` blocks, and `FINDINGS_CHAR_BUDGET` = 10,000 against
  `findings`, which a research run composes its answer from (median finding 185 characters on
  BU Bench V1, n=100, 2026-10-01; at 2,500 a run lost found items from its answer) — all through
  `boundMemory`, in characters for the reason `TREE_CHAR_BUDGET` is. The window moves only when
  the ceiling is CROSSED, and then all the way down to half the
  budget. That hysteresis is the design, not an optimisation: these blocks sit where they do
  because they are append-only, and one that evicted its oldest entry on every append would be
  rewritten from its first line every step and would cost more prefix cache than the bound saves.
  Open sub-goals are pinned and can never be dropped — a bound on the prompt bought with the
  run's objective is not a bound. `HISTORY_WINDOW` = 8 steps survive compaction verbatim, and
  every DISTINCT failure from the compacted region survives deduped.
- What a ceiling dropped is still on `AgentResult`. The prompt is bounded; the record is not.
- `renderPrompt` emits blocks **by mutability**: grammar and rules (immutable) first, then task
  and schema, then plan/findings/ruledOut (append-only), then history, then the small volatile
  counters, then the page, then a one-line reply demand. A provider prefix cache matches from the
  first byte and stops at the first difference, and the old order put a monotonically changing
  step counter on line 2. Be honest about the size of the win: on the worst case the stable
  prefix is 438 tokens, ~8% of the bounded prompt and 0.98% of the unbounded one. The ceiling is
  the lever; the order is free and compounds with it.
- The grammar table moved to the front and a 12-token pointer stays last, so recency of the
  demand to reply is preserved without paying for the table twice.
- Numbers reproduce with `scripts/measure-prompt-cost.ts`; the live before/after on two real
  tasks is `packages/worker/scripts/prove-prompt-cost.ts`.

## `hashSnapshot`

- Identical trees hash identically in any process; `sha256` from `node:crypto`, because the
  value is persisted and compared across processes.
- A sibling reordering that offers the model the same moves does not change the hash (child
  digests are sorted; the model addresses nodes by reference, never by position).
- An actionable element appearing or disappearing **does** change it.
- Node references are deliberately not hashed — backend node ids are per renderer process, so
  hashing them would mean no cache hit on the repeat runs (crawl, monitors) it exists for. So a
  cached action's `ref` is dead in a later session and must be re-resolved through its XPath.
- **The cache itself lives outside this package.** The loop emits `snapshotHash` on every
  `AgentPrompt` and records the returned `CacheInfo` without interpreting it; with nothing bound
  a step reports `MISS  no action cache attached`, and `AgentRunRequest.cache: false` reports
  `DISABLED` instead. The wrapper is `withActionCache` from `@outcrawl/cache`, bound at the
  host's composition root (`packages/worker/src/cache-deps.ts`) and applied per job in
  `packages/worker/src/jobs.ts` with `identity.accountId` in the key — a `null` account neither
  reads nor writes, rather than landing in a scope shared with every other customer.

## A challenge is not a page

- **The settle answers "has this rendered"; the gate answers "is this a page at all".** A vendor
  bot-check interstitial is a complete, settled document served at the site's own address, and
  every render rule this package has is satisfied by one. The detector is `interstitialOf` in
  `@outcrawl/scout-core` — the SAME one the scrape path (`runPipeline` in `@outcrawl/render`) has run
  since 2026-09-10, not a sibling of it — keyed on the document's own BODY, because a
  behavioural vendor rewrites the page in place and loads no vendor URL for a URL table or a
  browser event to match.
- **The bytes are injected, like everything else.** `AgentDeps.document` is a `DocumentProbe`:
  the read plus the text floor below which a document is not evidence of a page. Absent means
  "this host cannot read the document" and the settle behaves exactly as it did before the gate
  existed. `packages/worker/src/agent-deps.ts` binds it to `readDocument` — the same
  `Runtime.evaluate` the scrape path uses — with `DEFAULT_MIN_TEXT_LENGTH` as the floor, so the
  two paths cannot disagree about what an interstitial is.
- **What it costs is bounded by the tree.** The probe is consulted only on the way out of a
  verdict and only when the settled tree's content mass is under that floor, so a page with
  content never pays a byte. An `about:` url short-circuits it entirely; an EMPTY url does not,
  because a tree that did not report where it is, is not evidence that the document is empty.
- **Self-clearing waits; the rest is told.** `INTERSTITIAL_SELF_CLEARS` decides: a vendor
  measured to replace itself with the real page (Imperva at t+1,696 ms, `awswaf` at t+1,330 ms,
  DataDome at 5.3-5.9 s) keeps the settle polling to its budget, because spending a step and a
  model call describing a document that is about to be replaced is pure waste — `run_daaf33c2`
  spent three. One measured never to relent (Kasada: 429 three consecutive loads) reports
  `verdict: 'challenge'` at once, and so does a self-clearing one that outlasted the budget.
- **The model gets the word.** `challengeNotice` names the vendor, says what waiting is worth
  against it, and states that the tree is not evidence about the task. It replaces
  `unrenderedNotice`'s "it may still be loading", which is true of a challenge and useless about
  one: told that, the model described the wall and filed the run's headline finding as an
  absence. A `fail` chosen against a NAMED challenge is honoured — the honest stop — where one
  chosen against a page that never rendered is not. **Nothing here solves a challenge**: the
  solve path is the browser's `Outcrawl.challengeSolving` hold, which a body-signature
  interstitial never raises. The one gate the notice gives an action for is a gate a person
  clears with one press (`INTERSTITIAL_CONTROLS`, today Amazon's "Continue shopping"): the
  model is told the button's name and that two clicks without the page mean the site is
  refusing us — the same cap the scrape path presses to.
- **A challenge is never quiescent.** `quiescentAt` in `loop.ts` skips the settle for a document
  whose tree has not moved since one answered it; on an interstitial an unmoving tree means the
  page has not arrived, so a `challenge` verdict records nothing and the next step settles again.
  Without that, one reading answers every step after it — which is exactly what `run_daaf33c2`
  did for three.
- **A challenge in progress IS a renderer that will not answer a freeze, and the loop locks
  before it reads.** So the gate was unreachable on the page class it exists for until
  `passUnderLock` in `loop.ts`: `Outcrawl.lock` is answered in the renderer, an Imperva
  interstitial is a CPU-bound proof of work, and the host's 5-second bound therefore failed the
  step before any tree was read — `run_9d9c7471`, 2026-09-11, failed, 8 steps, 4.55 credits, "The
  page is executing script and cannot be frozen." A throw from ACQUIRING the freeze that
  `isRendererBusy` recognises is now waited out and retried, bounded by `settlePolicy.budgetMs`
  and by what `duration` and `budget` have left — the same three-way clamp the settle's own wait
  uses, because this is the same wait moved earlier. Once the renderer answers, the read, the
  settle and the gate all run normally; a page busy for some other reason still ends the run,
  after a bounded wait instead of at the first bound, with `error` coded
  `page-unresponsive: ...` (`pageUnresponsive` in `resume.ts`): what happened and what to do,
  then the host's own sentence. Each failed step keeps the host's sentence alone.
- **A finish survives a freeze that will not come down after it.** `done` and `fail` are the
  model's verdict on a page it has already read, so when only the RELEASE of the step's freeze
  fails, `passUnderLock` returns the decision instead of the throw. `run_c71f3901` (2026-10-01,
  BU Bench V1 task 66) finished `done` with a complete answer, `Outcrawl.unlock` went unanswered,
  and the run ended `failed` with no data three refused steps later.
- **Reading the document before the lock instead does not work, and that is measured.** The read
  is a `Runtime.evaluate`, which runs on the same main thread as the freeze. Shipped binary
  against a page pegging its thread for 12 s, 2026-09-11: healthy, document read 6 ms and
  `Outcrawl.lock` 0 ms; pegged, document read HELD 5,001 ms and freeze HELD 5,002 ms, both
  replies arriving together when the thread freed, with only browser-process commands
  (`Target.getTargetInfo`, 0 ms) answering meanwhile — and none of those can see a body.
- **The retry gap is capped at `BUSY_RETRY_CEILING_MS` = 250 ms, not at the settle's 800.** The
  rungs are 50, 100, 200, 250, 250 … so the first retry is immediate on the scale that matters
  and the worst-case overshoot past a measured clearance is 154 ms for Imperva (1,696 ms),
  20 ms for `awswaf` (1,330 ms) and 128 ms for DataDome's fastest (5,322 ms). A settle poll buys
  a fresh tree each time; a retry during a hold buys nothing and sends nothing — the host refuses
  locally while a freeze command is outstanding — so the gap is pure latency on the recovery.
  The budget is REAL ELAPSED TIME rather than the sum of the sleeps, because the first refused
  attempt was sent and held and therefore cost the host's whole 5-second reply bound before it
  threw; counting only the naps would spend a 10-second page-read budget on top of that and call
  it ten.

## Testing

```sh
cd packages/runtime && bun test ./test
```

Entirely against a fake browser — no CDP, no network, no model provider. `test/loop.test.ts`
asserts the event order `['lock', 'snapshot', 'model', 'perform', 'unlock']`;
`test/lock.test.ts` the release/solve/retake discipline and each unilateral browser release;
`test/long-horizon.test.ts` that neither terminal accepts an unearned finish;
`test/interrupt.test.ts` that an interrupt takes the freeze down and costs one recorded step.
The organs above have their own files: `test/rules.test.ts`, `test/resume.test.ts`,
`test/verify.test.ts` and `test/verify-loop.test.ts`, `test/park.test.ts`,
`test/memory-bound.test.ts`, `test/fan.test.ts`, `test/settle.test.ts`,
`test/challenge.test.ts`.

## Gaps

- **The three verbs added on 2026-09-08 took three fixes to become reachable, and the sequence is
  the lesson.** First `attachFile`, `ask` and `callTool` were in `ACTION_TYPES`, advertised by
  `ASK_GRAMMAR` and `TOOL_GRAMMAR`, dispatched by this file, and refused by `validateAction`,
  because `ACTION_SCHEMA` in `@outcrawl/model`'s `client.ts` declared none of
  `AttachFileAction.file`, `AskAction.question`, `AskAction.options`, `CallToolAction.tool` or
  `CallToolAction.arguments` — under `additionalProperties: false` plus `strict: true` an
  undeclared property is ungrammatical rather than discouraged, which is the SAME defect the `tab`
  property's own comment records three lines above it, one property-set later. All five properties
  are declared now and the schema was measured compiling on the wire (HTTP 200 on all three
  actuator-chain models, 2026-09-08, n=3). Then two of the three were still unreachable for
  unrelated wiring reasons, both since closed: `AgentDeps.tools` had no binder until
  `packages/worker/src/tool-port.ts` (`toolProxy` per host, `runToolPort` per run), and the model
  was never told a file existed until `AgentPrompt.files`, `FILE_GRAMMAR` and `FILE_RULE` here, fed
  by `UploadStore.listMeta` through `FilePort.list`. **Read `packages/model/README.md` before
  adding a verb**: the schema is a literal and the action union is a type, so nothing checks that a
  new verb's fields are declared, and nothing checks that the prompt mentions it.
- **Both new grammars are gated on having something to offer, and that is load-bearing.**
  `FILE_GRAMMAR` renders only for a run with files and `TOOL_GRAMMAR` only for a run with a
  catalogue, because a grammar line with no legal instance is the cost `TAB_GRAMMAR` and
  `ASK_GRAMMAR` are both gated to avoid. A run with neither renders a prompt byte-identical to the
  pre-feature one, and the test asserts that rather than assuming it.
- **Rectification is partial, and it is a gap and not a design.** A contradicted action becomes a
  `ruledOut` entry the model reads on every later prompt, and a repeat at the same
  `contradictionKey` is charged to `stepFailures` and stops the run `error` once the tolerance is
  spent. Nothing in this package re-plans around a repeated failure on its own: there is no
  alternative route, no retry against a different reference, no reordering of the plan. The model
  is told what did not work, and the model decides.
- **The dropped first keystroke is fixed outside this package.** Chromium's
  `kDropInputEventsWhilePaintHolding` (`ENABLED_BY_DEFAULT`, crbug.com/40057499) drops non-move
  input during paint holding after a navigation commit and acks it `(kMainThread, kNotConsumed)`,
  so `Input.dispatchKeyEvent` reported success for a keystroke the page never saw. Fixed by
  `--allow-pre-commit-input` on every fleet browser plus
  `packages/browser/patches/brave-core/0013-input-refusal.patch`, whose
  `KeyboardEventDisposition` return turns unconditional early returns and a
  `kBrowser`/`kNoConsumerExists` ack into refusals rather than lies; `sendUntilForwarded` in
  `packages/worker/src/agent-deps.ts` resends until the browser takes it. A fixed idle before
  the first keystroke was rejected as a fix: the window is a property of page and hardware.
