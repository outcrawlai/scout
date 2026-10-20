/**
 * The action vocabulary.
 *
 * Every action is data: no closures, no element handles, nothing that expires.
 * That is what lets `observe()` return a reviewable list which executes
 * nothing, and lets the action cache store the same value verbatim.
 */

import {
  ACTION_NOT_A_TOOL,
  containsCardNumber,
  isCurrencyCode,
  isPurchaseOutcome,
  type ObservedAction,
  PURCHASE_BEGIN_ACTION,
  PURCHASE_END_ACTION,
  type PurchaseOutcome,
  type RunSecretAskWant,
  type ValidationResult,
} from '@outcrawl/scout-core';

import type { ViewportPoint } from './look';
import type { AxNode, AxTree, NodeRef } from './snapshot';
import { formatNodeRef, indexTree, isNodeRef, parseNodeRef } from './snapshot';

export const ACTION_TYPES = [
  'click',
  'fill',
  'select',
  'press',
  'hover',
  'scroll',
  'drag',
  'navigate',
  'extract',
  'openTab',
  'focusTab',
  'closeTab',
  'wait',
  'attachFile',
  'createFile',
  'ask',
  'callTool',
  'purchase.begin',
  'purchase.end',
  'done',
  'fail',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A tab handle, opaque and browser-minted.
 *
 * A string and not an index, and that is load-bearing rather than stylistic:
 * indices renumber the moment a tab closes, so an index captured before a close
 * addresses a different tab afterwards. That is the same failure
 * frame-qualification removes from {@link NodeRef} — a small integer that means
 * different things at different times — and it is not worth reintroducing one
 * layer up.
 */
export type TabId = string;

/**
 * The host declined to perform an action: the press, hover or drag it asked
 * for was never sent, because the target cannot be reached the way the page
 * stands — it is off screen in a way no scroll fixes, drawn over, not laid
 * out, disabled, or a point outside the viewport. The host's sentence says
 * which, and what to do instead.
 *
 * Thrown by a binding's `perform`, and NOT a page failing to answer. The loop
 * records the step as failed, so the model reads the refusal on the next
 * prompt, but does not charge it to `stepFailures`: that count is for a page
 * that ignores what is sent, and nothing was sent. MEASURED in production, 7
 * days to 2026-10-14: of 580 runs of consecutive refusals, the step after
 * one refusal worked 464 times in 496, after two 55 in 58, after three 16 in
 * 18, and all 8 runs of four ended there, on the stop this charge tripped.
 *
 * `target` names what was refused, so the loop can tell a model trying
 * something different from one repeating a refusal it has already read: a
 * repeat is charged like any other failure.
 */
export class RefusedActionError extends Error {
  readonly target: string;

  constructor(message: string, target: string) {
    super(message);
    this.name = 'RefusedActionError';
    this.target = target;
  }
}

/**
 * A click on a node, or on a POINT of the viewport.
 *
 * `at` exists for what the tree cannot name: a spot on a `<canvas>` (IW6,
 * excalidraw), a pin on a map, a cell in a painted grid. `page.look` answers
 * "where is X" with a viewport point, and until this form the only thing the
 * model could do with that point was click the canvas's ref — which lands
 * wherever the hands planner picks inside a box the size of the whole canvas.
 *
 * Exactly one of the two. `at` is viewport CSS pixels, the space `page.look`
 * answers in and the space `Outcrawl.dispatchPointerPath` takes; the host
 * refuses a point outside the viewport rather than clamping it onto an edge
 * element the model never pointed at.
 */
export type ClickAction =
  | { readonly type: 'click'; readonly ref: NodeRef; readonly at?: undefined }
  | { readonly type: 'click'; readonly at: ViewportPoint; readonly ref?: undefined };

export interface FillAction {
  readonly type: 'fill';
  readonly ref: NodeRef;
  readonly text: string;
}

export interface SelectAction {
  readonly type: 'select';
  readonly ref: NodeRef;
  readonly value: string;
}

/** A key press. `ref` focuses first; without it the press goes to the page. */
export interface PressAction {
  readonly type: 'press';
  readonly key: string;
  readonly ref?: NodeRef;
}

/**
 * Whether a pressed key is a browser's RELOAD accelerator: F5, Ctrl/Cmd+R,
 * with or without Shift.
 *
 * A key event sent to the page never reaches the browser's accelerators.
 * MEASURED through production 2026-10-03 05:02Z on both Macs (.56, n=2 per
 * arm each): F5, Meta+R and Control+R as `Input.dispatchKeyEvent` reached the
 * page's own `keydown` listener and reloaded nothing; `Page.reload` reloaded
 * 4 of 4. So the page binding performs these as a GET navigate to the
 * document's url (never `Page.reload`, which re-sends a POST), and the outcome
 * check judges them as one.
 */
export function isReloadKey(key: string): boolean {
  return /^((Shift\+)?F5|(Control|Ctrl|Meta|Cmd|Command)\+(Shift\+)?[rR])$/.test(key.trim());
}

/**
 * The pointer brought to rest over a node, or over a POINT of the viewport,
 * with no press.
 *
 * `at` for the same reason {@link ClickAction} has it, and for one case a
 * click cannot serve: a chart that shows a value only in the tooltip under the
 * pointer. A line or bar chart drawn as one `<svg>` path or one `<canvas>` has
 * no element per data point, so a ref can only aim the whole plot, and a click
 * at the point presses a chart that may answer a press by selecting, zooming,
 * pinning or navigating. Measured on production 2026-10-14 (`run_ad7ab3fa`,
 * a public life-expectancy line chart, n=1): with hover taking a ref only,
 * the run clicked at chart points four times to make the tooltip appear.
 *
 * Exactly one of the two, in the same space and under the same refusals as
 * a click's point.
 */
export type HoverAction =
  | { readonly type: 'hover'; readonly ref: NodeRef; readonly at?: undefined }
  | { readonly type: 'hover'; readonly at: ViewportPoint; readonly ref?: undefined };

/** Scrolls a container, or the page when no node is named. */
export interface ScrollAction {
  readonly type: 'scroll';
  readonly ref?: NodeRef;
  readonly dx?: number;
  readonly dy?: number;
  /**
   * Bring `ref` into the viewport instead of scrolling by a delta: the host
   * scrolls with the same human-modelled wheel gesture it uses to reach a node
   * before clicking it. Set by the loop only — `validateAction` never reads it
   * off a model reply — to put a run's recorded evidence on screen before the
   * run ends. A host that does not understand it scrolls by nothing, which is
   * the no-op a missing delta already was.
   */
  readonly reveal?: true;
}

/**
 * One end of a drag: a node, or a viewport point.
 *
 * The two shapes are the wire shapes, so a validated drag re-validates to
 * itself: a {@link NodeRef} struct (`frameOrdinal`, `backendNodeId`) or a
 * {@link ViewportPoint} (`x`, `y`). A model writes the ref as its `"F-N"`
 * string, which `validateAction` turns into the struct.
 */
export type DragEnd = NodeRef | ViewportPoint;

/**
 * Press at `from`, move to `to` with the button held, release.
 *
 * The gesture canvas UIs, sliders, sortable lists and HTML5 drag-and-drop are
 * built on, and the one the model kept asking for: IW6 excalidraw runs emitted
 * `{"type":"drag"}` and had it refused as an unknown verb. The host performs it
 * as ONE human-modelled press, held path and release through the fork's
 * pointer path; see `AgentHandsPort.drag` in `@outcrawl/worker`.
 */
export interface DragAction {
  readonly type: 'drag';
  readonly from: DragEnd;
  readonly to: DragEnd;
}

/**
 * The longest drag, in CSS pixels, end to end.
 *
 * Both ends are inside the viewport by the time the host dispatches, so this is
 * not what keeps the pointer on screen — the viewport check is. It bounds ONE
 * gesture: `agenthands`' stroke duration grows with distance, and the whole
 * path goes out as one `dispatchPointerPath` with the button held, so a longer
 * drag is a longer stretch with the page live under a held button. 1600 is
 * past the diagonal of a 1280x800 viewport (1509) and short of 1920x1080's
 * (2203); a drag longer than that is a point copied off a picture at the wrong
 * scale far more often than it is a gesture a person makes in one sweep.
 */
export const MAX_DRAG_PX = 1600;

/**
 * The shortest drag. Under it the press and release are a few pixels apart
 * and a page reads the gesture as a click — which is what `click` is for, and
 * a model that meant a click should be told so rather than have its drag
 * silently become one.
 */
export const MIN_DRAG_PX = 8;

export interface NavigateAction {
  readonly type: 'navigate';
  readonly url: string;
}

/**
 * LETS THE PAGE RUN, and does nothing else.
 *
 * The page is frozen between steps (`Outcrawl.lock`, which is
 * `VirtualTimePolicy::kPause` in the renderer), so a page's own timers only
 * advance while an action or a settle has it live — a few hundred
 * milliseconds a step. A page that says "wait for it" therefore never
 * finished while the model waited: measured on the-internet's
 * dynamic_controls (TERM1-staleref, fleet 54476fe6, `run_…`), whose
 * Remove button schedules the removal on a 3,000 ms `setTimeout`; the model
 * clicked Remove, was shown the disabled button and "Wait for it...", clicked
 * the disabled button again, and reported the checkbox "present". It had no
 * way to let three seconds pass on the page.
 *
 * What a person does, and all the page can observe: nothing, for a while. No
 * input, no script, no request. `seconds` is clamped to
 * {@link MIN_WAIT_SECONDS}..{@link MAX_WAIT_SECONDS}; it costs its own
 * duration and one step, never a model call of its own.
 */
export interface WaitAction {
  readonly type: 'wait';
  readonly seconds: number;
}

/** The shortest wait: shorter is what the settle already gives every step. */
export const MIN_WAIT_SECONDS = 1;
/**
 * The longest single wait: one minute.
 *
 * It used to be ten seconds — the settle's own `budgetMs` — so that a wait
 * could never spend more of a customer's `duration` in one step than a settle
 * could, and a longer one was several steps each of which the caps could
 * stop. That made a wait the page genuinely needs cost a model call per ten
 * seconds: a ten-minute wait was ~60 calls, and on production 2026-09-28 the
 * model asked for 60 s and 300 s, was given 10, and 3 of 7 runs told to wait
 * N minutes ended early (n=7, 15:47-17:55Z).
 *
 * The ceiling is no longer what bounds the caps. The loop's `performWait`
 * clamps every wait to what `duration` and `budget` have left, and ends it
 * the moment the owner cancels, a drain takes the run, a human takes the page
 * or `agent.control` asks for a hold — each proved by a test. So the number is
 * a model-cost dial: sixty seconds makes a ten-minute wait ten calls, and a
 * page that changes while the agent waits is still looked at once a minute.
 */
export const MAX_WAIT_SECONDS = 60;

/**
 * Opens a tab and leaves it focused.
 *
 * Focused, not merely opened. A five-site task opens four tabs, and if opening
 * did not focus, the model would spend a second step focusing what it just
 * opened every single time — four wasted steps and four wasted model calls per
 * task, for a state transition it already expressed.
 */
export interface OpenTabAction {
  readonly type: 'openTab';
  readonly url: string;
}

export interface FocusTabAction {
  readonly type: 'focusTab';
  readonly tab: TabId;
}

export interface CloseTabAction {
  readonly type: 'closeTab';
  readonly tab: TabId;
}

/**
 * Attaches a file the customer already uploaded to a file input on the page.
 *
 * `file` is the HANDLE `POST /v1/agent/{id}/files` minted, never a path and
 * never bytes. The body is fetched from the run's upload prefix and pushed
 * with `DOM.setFileInputFiles` BELOW the model.
 *
 * **The model addresses a handle and never a payload.** That is one rule with
 * three enforcement points, not three local conventions: a secret value at
 * fill time, a connector bearer at tools/call time, and a file body here. A
 * model that could name a path could name `/etc/passwd`; a model that could
 * carry bytes would put a customer's document into a prompt, and a prompt is
 * the one place in this system we do not control the retention of.
 */
export interface AttachFileAction {
  readonly type: 'attachFile';
  readonly ref: NodeRef;
  readonly file: string;
}

/**
 * The extensions a run may CREATE a file with, and the content type each one
 * is stored under. A closed list rather than "any name": the executor renders
 * the bytes from the extension, so a name it has no renderer for is a file it
 * cannot make, and the model is told so on the next prompt.
 *
 * Text types carry `text` verbatim as UTF-8. `.png` and `.pdf` are PLACEHOLDER
 * documents — a plain image, a one-page PDF printing `text` — for a form that
 * demands an attachment ("upload your CV", "attach a receipt") when the task
 * supplied none. The browser-use reference agent answers the same task with
 * `write_file` then `upload_file` (browser-use 0.11.5 `tools/service.py`
 * `upload_file`, which accepts a file from the agent's own FileSystem), and
 * BU Bench V1's InteractionTests forms say "If needed, create a file."
 */
export const CREATABLE_FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  pdf: 'application/pdf',
});

/**
 * The lower-cased extension of `name` when this run can create a file with
 * it, else `undefined`. Exported: the validator and the executor both decide
 * on it, and they must agree.
 */
export function creatableExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return undefined;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CREATABLE_FILE_TYPES, extension) ? extension : undefined;
}

/**
 * WRITES A SMALL FILE INTO THE RUN'S OWN FILE SPACE, for a page that asks for
 * an upload the task did not provide.
 *
 * `file` is the NAME the new file gets (and the name the page sees); `text` is
 * its content — verbatim for a text type, the printed line of a placeholder
 * PDF, unused by a placeholder PNG. Both reuse properties the reply schema
 * already declares, so the schema's property count does not move.
 *
 * The file lands exactly where a customer's upload does — the run's own
 * upload prefix, behind a freshly minted `file_…` handle — so it is listed in
 * the next prompt, attached with {@link AttachFileAction}, and destroyed with
 * the run on every ending. It never reaches another run: the executor's port
 * is bound to this run's id and the model never names one.
 *
 * The handle rule holds: the model WRITES content it authored itself and then
 * addresses the result by handle. No customer bytes enter a prompt here,
 * because the only bytes involved came out of the model in the first place.
 */
export interface CreateFileAction {
  readonly type: 'createFile';
  readonly file: string;
  readonly text: string;
}

/** Pulls schema-shaped data off the current page. The only way data is collected. */
export interface ExtractAction {
  readonly type: 'extract';
  readonly instruction?: string;
  /**
   * The model's statement that THIS extraction records the task's answer, so
   * the run may end on it: a schema run once its schema is satisfied, a
   * schema-less run as it stands (each through the same open-goal and plan
   * holds a `done` passes). Without it an extraction is a look at the page: it
   * is still collected and recorded, and its result is shown back to the
   * model, but it never ends the run by itself. See {@link answersTask}.
   */
  readonly final?: true;
}

/**
 * Whether an extraction is the run's answer rather than a look at the page.
 *
 * `final: true` is the model saying so. An extraction with NO instruction is
 * the schema itself being filled — "extract the schema" — so there is nothing
 * it could be exploring, and it answers exactly as a final one does. That is
 * also the only shape the action cache stores, so a replayed answer still ends
 * the run it ended before.
 *
 * Measured on the WebVoyager A/B, pre-fix builds, 2026-09-24 (46 runs that
 * stopped `schema-satisfied`): every exploratory extraction that ended a run —
 * "Extract all visible text and interactive elements", "Find any links
 * mentioning 'store'" — carried an instruction and no way to say it was not the
 * answer.
 */
export function answersTask(action: ExtractAction): boolean {
  return action.final === true || action.instruction === undefined;
}

/**
 * PARKS THE RUN WITH A QUESTION FOR A HUMAN.
 *
 * The one verb in this list that neither touches the page nor ends the run.
 * `done` and `fail` are terminal and everything else is a gesture; this
 * suspends the run where it stands, publishes the question through the
 * channels the run already has — a durable `question` record, so it reaches
 * `GET /v1/agent/{id}/events` and the webhook — and resumes on
 * `POST /v1/agent/{id}/answer` with the reply in the step trace.
 *
 * Deliberately NOT terminal, and that is the distinction worth reading
 * {@link isTerminal} for: a model that cannot ask has exactly two moves when
 * it meets a decision only the customer can make — guess, or `fail` — and both
 * throw away a run that was one sentence from finishing. Asking costs the run
 * a step and the wall clock of a human, and the wall clock is not charged
 * against `caps.duration` because the customer's ceiling is protection against
 * OUR loop running away, not against their own reply time.
 *
 * A park is bounded rather than open-ended: nobody answering is answered, with
 * "no answer within …" delivered as the result of this action, and the model
 * decides what that means. So there is no state a run can enter here that it
 * cannot leave.
 */
export type AskAction = QuestionAskAction | SecretAskAction;

/** A free-text question, answered on `POST /v1/agent/{id}/answer`. */
export interface QuestionAskAction {
  readonly type: 'ask';
  /** What the human is being asked. Required and non-empty: a park with no question is a hang. */
  readonly question: string;
  /**
   * The replies on offer, when the answer is a choice rather than free text.
   *
   * Advisory rather than enforced — `POST /v1/agent/{id}/answer` accepts any
   * text — because a human who was offered two options and needs a third is a
   * person with information the model did not have, and refusing it would turn
   * the one seam that exists to bring a human's judgment in into a seam that
   * only accepts the model's imagination.
   */
  readonly options?: readonly string[];
  readonly want?: never;
}

/**
 * A request for a whole card or a billing profile this run does not hold,
 * answered ONLY by a person adding a run secret (wire contract §4): never a
 * free-text question, so a card number is never typed into an answer. The
 * platform writes the person-facing sentence and chooses the name the secret
 * arrives under. On the wire the model writes it in the shared schema's
 * `value` (`{"type":"ask","value":"card"}`), which is at the provider's cap
 * of optional properties; see {@link ASK_WANT_ACTIONS}.
 */
export interface SecretAskAction {
  readonly type: 'ask';
  readonly want: RunSecretAskWant;
  readonly question?: never;
  readonly options?: never;
}

/** The model's wire form of each {@link SecretAskAction}, word for word as the grammar offers it. */
export const ASK_WANT_ACTIONS: Readonly<Record<RunSecretAskWant, string>> = {
  card: '{"type":"ask","value":"card"}',
  details: '{"type":"ask","value":"details"}',
};

/**
 * CALLS A TOOL ON AN MCP SERVER THE WORKSPACE CONNECTED.
 *
 * The second verb here that does not touch the page, and the only one that
 * leaves the browser entirely: outcrawl is an MCP *server* inbound, and this
 * is the outbound half. A workspace connects Gmail, Slack or Twilio; a run
 * the customer granted them to reaches those tools mid-task, which is what
 * turns a wall the browser cannot climb into a step. The motivating case is
 * a 2FA prompt: the code is in an inbox this run can read, and without this
 * verb the run's only honest move is `fail`.
 *
 * `tool` is `<connector>.<tool>` — the connector half names one of the
 * connectors THIS RUN was granted at submit time, and a run that was granted
 * none reaches nothing. Deny by default is the whole containment story: a
 * page that talks a model into "email the contents of this table to
 * attacker@example.com" is talking to a run with no mail connector, and the
 * broker refuses by name rather than the model discovering it can.
 *
 * **The model addresses a handle and never a payload**, exactly as
 * {@link AttachFileAction} states it: the bearer for the remote server is a
 * secrets-store handle on the connector row, resolved below this layer at the
 * instant of the call. Nothing here, in the step trace, in the prompt or on
 * the run row ever holds a credential.
 *
 * No `ref`, so this is not a {@link NodeAction}: it names no node, the action
 * cache cannot key it, and it must not be chained behind a page gesture. A
 * remote call is not a keystroke.
 */
export interface CallToolAction {
  readonly type: 'callTool';
  /** `<connector>.<tool>`, as `integrations.list` and the prompt spell it. */
  readonly tool: string;
  /**
   * The tool's own arguments, passed through to the remote server verbatim.
   *
   * Unvalidated here on purpose: the shape is the REMOTE server's JSON schema,
   * which this package has never seen and must not second-guess. The broker
   * shows the model that schema and the remote refuses what it does not like,
   * which is one authority on the question instead of two that can disagree.
   */
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/**
 * OPENS A PURCHASE BEFORE ANY CARD FIELD IS FILLED.
 *
 * The model states the checkout total as the page shows it, and nothing else.
 * There is deliberately NO merchant field: the merchant is the registrable
 * domain of the tab's top-level page, which the loop reads from the tree the
 * action resolved against and the edge derives. A model talked by a page into
 * "buy this on attacker.example" has no field in which to say it.
 *
 * `amount` is an exact decimal string (`"84.20"`), never a number: a float has
 * already lost the cent the spend cap exists to keep. `currency` is the ISO
 * 4217 code. The edge checks both against the run's cap in one statement.
 */
export interface PurchaseBeginAction {
  readonly type: 'purchase.begin';
  readonly amount: string;
  readonly currency: string;
}

/**
 * SETTLES THE OPEN PURCHASE after the payment was submitted.
 *
 * On the model's wire this REUSES properties the reply schema already
 * declares, because the action object sits at the provider's cap of 24
 * optional parameters: `value` carries `outcome`, `amount` carries
 * `amountFinal` and `text` carries `orderRef`. `validateAction` does the
 * mapping, and reads this form back unchanged (the loop re-validates what a
 * port already validated); nothing past it sees the wire names.
 */
export interface PurchaseEndAction {
  readonly type: 'purchase.end';
  readonly outcome: PurchaseOutcome;
  /** The charged total, when it differs from the amount the purchase opened with. */
  readonly amountFinal?: string;
  /** The order or confirmation number the page showed, when it showed one. */
  readonly orderRef?: string;
}

export interface DoneAction {
  readonly type: 'done';
  readonly summary?: string;
  /**
   * Conditions the task states that this finish has NOT confirmed, in the
   * model's own words. Absent or empty claims every condition was confirmed.
   * The loop declines a finish that lists any while most of the run's
   * budget is unspent, once; see `unconfirmedNotice` in `./loop`.
   */
  readonly unconfirmed?: readonly string[];
  /**
   * What this run read for each condition the task states, one line each:
   * the fact and where it was read, or that it was not confirmed. A
   * schema-less run returns them under the summary (`answerWithEvidence` in
   * `./loop`); a schema run's data is its schema object and carries none.
   */
  readonly evidence?: readonly string[];
}

export interface FailAction {
  readonly type: 'fail';
  readonly reason: string;
}

export type Action =
  | ClickAction
  | FillAction
  | SelectAction
  | PressAction
  | HoverAction
  | ScrollAction
  | DragAction
  | NavigateAction
  | ExtractAction
  | OpenTabAction
  | FocusTabAction
  | CloseTabAction
  | AttachFileAction
  | CreateFileAction
  | AskAction
  | CallToolAction
  | PurchaseBeginAction
  | PurchaseEndAction
  | DoneAction
  | FailAction
  | WaitAction;

/** An action that names a node. The only kind the action cache can store. */
export type NodeAction = Action & { readonly ref: NodeRef };

export function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value);
}

/** `done` and `fail` end the run; nothing is performed for them. */
export function isTerminal(action: Action): action is DoneAction | FailAction {
  return action.type === 'done' || action.type === 'fail';
}

export function hasRef(action: Action): action is NodeAction {
  return 'ref' in action && action.ref !== undefined;
}

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

/**
 * A sub-goal, as the model states it.
 *
 * `id` is model-chosen and must be stable across revisions, because it is the
 * only thing tying a completion back to the goal it completes. Short is better:
 * it is reprinted on every step for the rest of the run.
 */
export interface PlanStep {
  readonly id: string;
  readonly goal: string;
  /** Origin hint. Rendered in the plan so the model can see where it is going. */
  readonly site?: string;
}

/** Closes one sub-goal. `summary` is the reason when the status is `failed`. */
export interface GoalUpdate {
  readonly id: string;
  readonly status: 'done' | 'failed';
  readonly summary: string;
}

/**
 * What a model reply carries BESIDES its action.
 *
 * These are fields on the action object rather than actions of their own, and
 * the reason is arithmetic rather than taste. A step costs a snapshot, a lock
 * cycle and a model call — measured at 5 to 15 seconds and the dominant cost of
 * a run — so spending one to record a one-line note would make memory the most
 * expensive thing in the system, and a model that is charged a step to remember
 * a price will simply not remember it. As sibling fields they cost the tokens
 * of the text and nothing else, which is what makes it rational for the model
 * to use them every time it learns something.
 *
 * Every field is optional and every combination is legal: a single reply may
 * click a button, record what the page said, close the sub-goal that button
 * finished, and revise the plan for the next one.
 */
export interface Envelope {
  /** States the plan, or replaces it. Merged by id — see `applyPlan` in the loop. */
  readonly plan?: readonly PlanStep[];
  /** A fact worth more than the page it came from. Survives compaction. */
  readonly finding?: string;
  /** An approach that did not work, so a later step does not spend itself repeating it. */
  readonly ruledOut?: string;
  /** Closes a sub-goal. */
  readonly goal?: GoalUpdate;
  /**
   * Closes several sub-goals at once, applied after {@link goal}. Brain mode's
   * finish carries one closure per goal still open (`HarnessModelPort` in
   * `@outcrawl/model`): a brain decides the whole run on one `done`, and a
   * finish that could close one goal per reply was refused three times and
   * reported `partial` on runs whose answer was complete (live10, main
   * 600e4e28, 4 of 10, 2026-10-02).
   */
  readonly goals?: readonly GoalUpdate[];
  /**
   * The rest of a motor program: further actions to perform after this one,
   * without another model call.
   *
   * `unknown[]` rather than `Action[]`, and that is the point. Every element is
   * validated against a tree by `validateAction` at the moment it is about to
   * be dispatched, exactly like the head action is — so a parsed-and-trusted
   * `Action` here would be a reference the loop had accepted without checking
   * it against a page, which is the whole failure the action lock exists to
   * prevent. Kept raw, the type makes that impossible to skip.
   *
   * Empty and absent are the same thing and both mean "one action". The loop's
   * own ceiling bounds the length; a longer array is truncated rather than
   * refused, because the useful prefix of an over-long sequence is still
   * exactly what the model meant by it.
   */
  readonly then?: readonly unknown[];
  /**
   * Actions for OTHER TABS, performed in the same step as the head action.
   *
   * `then` is the same reply across TIME — one tab, one action after another.
   * This is the same reply across SPACE: the head action drives the focused
   * tab, and each element here names a tab of its own and is dispatched
   * concurrently with it. A five-site comparison is five reads that do not
   * depend on one another, and spending five model calls on them is spending
   * the only expensive part of a step five times for no decision.
   *
   * `unknown[]` for exactly `then`'s reason, and one more of its own. Every
   * element is validated by `validateAction` against the tree of the tab it
   * names, at the moment it is about to be dispatched — so a parsed `Action`
   * here would be a reference accepted against no page at all. The extra
   * reason is `tab`: it is not a field of any `Action`, so an element is a
   * tab-qualified action rather than an action, and `Action` could not hold
   * one without putting a routing field on every click in the system.
   *
   * Empty and absent are the same thing and both mean "the focused tab only".
   * The loop's own ceiling bounds the width — see `MAX_FAN` in `./fan.ts`, and
   * read the arithmetic there before raising it.
   */
  readonly also?: readonly unknown[];
}

function envelopeString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parsePlan(value: unknown): readonly PlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: PlanStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = envelopeString(entry, 'id');
    const goal = envelopeString(entry, 'goal');
    if (id === undefined || goal === undefined) {
      continue;
    }
    const site = envelopeString(entry, 'site');
    steps.push({ id, goal, ...(site !== undefined ? { site } : {}) });
  }
  return steps.length > 0 ? steps : undefined;
}

function parseGoalUpdate(value: unknown): GoalUpdate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = envelopeString(value, 'id');
  const status = value['status'];
  if (id === undefined || (status !== 'done' && status !== 'failed')) {
    return undefined;
  }
  return { id, status, summary: envelopeString(value, 'summary') ?? '' };
}

/**
 * Pulls the envelope off a raw model reply.
 *
 * Tolerant on purpose, and it is the one place in this file that is. Everything
 * `validateAction` touches decides whether the page is touched, so a malformed
 * value there must be refused rather than guessed through. Nothing here touches
 * the page: a malformed plan entry is a note the model failed to write, and
 * discarding the whole reply over it would throw away a perfectly good action
 * and charge the customer for the step. So a bad entry is skipped, a bad plan is
 * absent, and the action still runs.
 *
 * The exception is the empty string, which is dropped everywhere rather than
 * stored. A `"finding":""` is a model emitting the field because the grammar
 * showed it, not a finding, and storing it would put a blank line in every
 * subsequent prompt for the rest of the run.
 */
export function parseEnvelope(raw: unknown): Envelope {
  if (!isRecord(raw)) {
    return {};
  }
  const plan = parsePlan(raw['plan']);
  const finding = envelopeString(raw, 'finding');
  const ruledOut = envelopeString(raw, 'ruledOut');
  const goal = parseGoalUpdate(raw['goal']);
  // Elements are NOT inspected here. Non-records survive to `validateAction`,
  // which refuses them with a message naming what was wrong — a filter here
  // would silently shorten a sequence and leave nothing able to say why.
  const then = raw['then'];
  // Same treatment, same reason: `planFan` in `./fan.ts` names what was wrong
  // with each element, and a filter here would drop an element and leave
  // nothing able to say which one or why.
  const also = raw['also'];
  return {
    ...(plan !== undefined ? { plan } : {}),
    ...(finding !== undefined ? { finding } : {}),
    ...(ruledOut !== undefined ? { ruledOut } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(Array.isArray(then) && then.length > 0 ? { then: then as readonly unknown[] } : {}),
    ...(Array.isArray(also) && also.length > 0 ? { also: also as readonly unknown[] } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `done.unconfirmed` and `done.evidence`, read leniently: the non-empty
 * strings of a list, or a lone string as a one-entry list, and nothing for
 * any other shape. Lenient because refusing a finish over an advisory field
 * would spend a correction call on the step the model is trying to end, and
 * because what it says is already in the summary in words.
 */
function textList(value: unknown): readonly string[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
}

/**
 * An action type sent as a tool's name, as the refusal that spells the action
 * out, or `undefined` for any other tool. Never aliased into the action: the
 * schema stays one vocabulary, and the model reads the correction on its next
 * reply. A built-in tool (`web.search`, `page.look`) is never an action type;
 * the one collision is a connector a customer names `purchase` with a tool
 * `begin` or `end`, which is refused here. run_… (a fleet Mac, 2026-10-08
 * 20:40Z): told to "Open one with purchase.begin", scout-1's brain sent
 * `callTool` with tool `purchase.begin` and failed on a tool that was not
 * connected.
 */
export function actionNamedAsTool(tool: string): string | undefined {
  if (!(ACTION_TYPES as readonly string[]).includes(tool)) {
    return undefined;
  }
  const spelled =
    tool === 'purchase.begin' ? PURCHASE_BEGIN_ACTION : tool === 'purchase.end' ? PURCHASE_END_ACTION : `{"type":"${tool}", ...}`;
  return `tool ${JSON.stringify(tool)} is ${ACTION_NOT_A_TOOL}: emit ${spelled} as the action itself`;
}

function requireString(input: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = input[key];
  if (typeof value !== 'string' || value === '') {
    errors.push(`${key} must be a non-empty string`);
    return undefined;
  }
  return value;
}

/**
 * The file an `attachFile` named in `value` or `text` instead of `file`: the
 * handle it contains, else the string itself (a name, which the loop resolves
 * against the run's own files). `undefined` when neither holds one.
 *
 * Measured 2026-10-20 (DevMiss probe, n=6): the hands' fallback model, under
 * the production reply schema and shown a manifest holding the file, put the
 * handle in `value` 5 of 6 times and the name in `text`/`value` once, and
 * never wrote `file`. Fleet 2026-10-20
 * (Outcrawl Bench dev jobs-apply, run_a12880c6): with the primary
 * rate-limited, every attach after the CV was stored failed "file must be a
 * non-empty string" and the application went without it.
 */
function misplacedFile(input: Record<string, unknown>): string | undefined {
  for (const key of ['value', 'text'] as const) {
    const said = input[key];
    if (typeof said !== 'string' || said.trim() === '') continue;
    return /\bfile_[A-Za-z0-9_-]+/.exec(said)?.[0] ?? said.trim();
  }
  return undefined;
}

/** An exact decimal amount: up to 13 whole digits and an optional fraction. The edge's own bound. */
const PURCHASE_AMOUNT = /^\d{1,13}(\.\d{1,18})?$/u;

/** An order reference is a label, not a document. */
const MAX_ORDER_REF_CHARS = 200;

/**
 * A purchase amount as a decimal STRING. A JSON number is refused rather than
 * converted: `84.2` as a float is already not the cent-exact figure the cap
 * is checked against, and the sentence tells the model the one form it takes.
 */
function purchaseAmount(value: unknown, key: string, errors: string[]): string | undefined {
  if (typeof value === 'string' && PURCHASE_AMOUNT.test(value)) {
    return value;
  }
  errors.push(
    `${key} must be the total as a decimal string of digits with an optional point, such as "84.20" (no currency sign, no thousands separator, not a number)${gotUnlessCard(value)}`,
  );
  return undefined;
}

/**
 * `, got <value>` so the model sees its own mistake in a purchase field,
 * or nothing when the value carries a card number: no card digit reaches an
 * error, a step trace or a prompt.
 */
function gotUnlessCard(value: unknown): string {
  const shown = JSON.stringify(value) ?? String(value);
  return containsCardNumber(shown) ? '' : `, got ${shown}`;
}

/** Whether `value` names a {@link SecretAskAction}'s want. */
function isAskWant(value: unknown): value is RunSecretAskWant {
  return value === 'card' || value === 'details';
}

function optionalNumber(input: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key} must be a finite number`);
    return undefined;
  }
  return value;
}

/**
 * Resolves a reference against the tree the action was chosen from.
 *
 * Two forms arrive here and both are the same reference. A MODEL writes the
 * wire form, `"<frameOrdinal>-<backendNodeId>"`, copied from the
 * `[frame-backendNode]` the tree prints beside the node; the brackets are
 * tolerated, because "copy what is in the brackets" and "copy the brackets" are
 * one instruction to that reader. So is the grammar's own `F-` in front of a
 * printed reference (`"F-366-347"` for `[366-347]`): the hands copy the
 * template's letter with the reference, and that one prefix cost demoqa run
 * sess_… (a fleet Mac, 2026-10-04 16:22-16:25Z) 15 of its 17 action
 * corrections and the brain re-grounds that followed; the reference after it
 * is still looked up in the tree, so nothing is guessed. Loop-internal callers re-validating an action
 * they already hold pass the {@link NodeRef} struct.
 *
 * THE MODEL WRITES THE STRING, NOT THE STRUCT, because the struct made it
 * re-type the frame ordinal as an integer of its own and it got that wrong.
 * Measured 2026-09-23 on the Honey Birdette checkout form with scout-1's
 * actuator, main frame ordinal 14 as the fleet mints it, 24 first answers per
 * arm, interleaved: asked for `{"frameOrdinal":F,"backendNodeId":N}`, 6 named a
 * node in the snapshot and 15 put a wrong frame in front of a correct node id;
 * asked for `"F-N"`, 21 did and none wrote a wrong frame. At main frame 2, what
 * a fresh browser mints and so what every bench run saw, the struct was wrong 1
 * time in 24 — which is why no benchmark ever showed it.
 *
 * Two rejections, and they are the same failure seen from two sides: a value
 * that is not a frame-qualified reference at all, and a well-formed reference
 * naming a node that is not in the tree. Neither is guessed through. Guessing
 * is what self-heal does, and self-heal is the cost the action-lock exists to
 * remove.
 */
function resolveRef(
  value: unknown,
  index: ReadonlyMap<string, AxNode>,
  errors: string[],
): NodeRef | undefined {
  const ref =
    typeof value === 'string'
      ? parseNodeRef(value.trim().replace(/^\[(.*)\]$/, '$1').replace(/^F-(?=\d+-\d+$)/, ''))
      : isNodeRef(value)
        ? value
        : undefined;
  if (ref === undefined) {
    errors.push(
      'ref must be the reference printed in brackets beside a node, written as a "frame-backendNode" ' +
        `string, got ${JSON.stringify(value)}`,
    );
    return undefined;
  }
  const wire = formatNodeRef(ref);
  if (!index.has(wire)) {
    errors.push(`node ${wire} is not in the snapshot the action was chosen from`);
    return undefined;
  }
  return ref;
}

/** Whether `value` is a {@link ViewportPoint}: two finite numbers, `x` and `y`. */
export function isViewportPoint(value: unknown): value is ViewportPoint {
  return (
    isRecord(value) &&
    typeof value['x'] === 'number' &&
    Number.isFinite(value['x']) &&
    typeof value['y'] === 'number' &&
    Number.isFinite(value['y'])
  );
}

/**
 * A viewport point off model output, or `undefined` with the reason pushed.
 *
 * Only the half of "inside the viewport" this package can check: a negative
 * coordinate is outside every viewport. The far edges are the host's to
 * check, because the viewport's size is a fact about the live page and this
 * function sees only the tree — the host refuses a point past them with the
 * size it measured, before any input is sent.
 */
function resolvePoint(value: unknown, key: string, errors: string[]): ViewportPoint | undefined {
  if (!isViewportPoint(value)) {
    errors.push(`${key} must be a viewport point {"x":N,"y":N} in CSS pixels, got ${JSON.stringify(value)}`);
    return undefined;
  }
  if (value.x < 0 || value.y < 0) {
    errors.push(`${key} (${String(value.x)}, ${String(value.y)}) is outside the viewport: coordinates start at 0`);
    return undefined;
  }
  return { x: value.x, y: value.y };
}

/** One end of a drag: a `"F-N"` reference (or its struct), or a viewport point. */
function resolveEnd(
  value: unknown,
  key: 'from' | 'to',
  index: ReadonlyMap<string, AxNode>,
  errors: string[],
): DragEnd | undefined {
  if (typeof value === 'string' || isNodeRef(value)) {
    return resolveRef(value, index, errors);
  }
  if (value === undefined) {
    errors.push(`${key} is required: a node reference "F-N" or a viewport point {"x":N,"y":N}`);
    return undefined;
  }
  return resolvePoint(value, key, errors);
}

/**
 * Whether a scroll's `ref` names the DOCUMENT — the tree's depth-0 line,
 * which `serializeTree` prints as `0 doc "<title>"` with no reference — rather
 * than a node.
 *
 * A scroll with no `ref` already means "scroll the page", so a model naming
 * the page itself has asked for exactly that and is answered with it. Before
 * this, `resolveRef` refused the value, the loop spent two correction calls on
 * it, and the step ended with nothing done. MEASURED in production, 7 days to
 * 2026-09-24: 46 step errors were "ref must be the reference printed in
 * brackets", and 43 of them (12 runs) refused the root line's own tokens —
 * `"0"` 20, `"0-0"` 18, `"doc"` 2, `"0-doc"` 2, `"0doc"` 1. 29 of the 43 are
 * the five IW12-scroll runs on an infinite-scroll page where every step was a
 * page scroll; `run_…` (fleet 54476fe6) lost 7 of its 46 steps to
 * `"0"`. The loop's own grammar line is `{"type":"scroll","ref":"F-N",...}`,
 * which is why a model with no node in mind still writes something there.
 *
 * Only the depth and role code of the root line, in any order and joining, and
 * only for `scroll`: every other verb acts ON a node, and "the document" is
 * not something to click. A well-formed reference that is not in the tree is
 * still refused — that is a node the model misremembered, not the page.
 */
const DOCUMENT_TOKEN = '(?:0|doc)';
const NAMES_THE_DOCUMENT = new RegExp(`^${DOCUMENT_TOKEN}(?:[-\\s]?${DOCUMENT_TOKEN})?$`, 'i');

function namesTheDocument(value: unknown): boolean {
  return (
    value === 0 ||
    (typeof value === 'string' && NAMES_THE_DOCUMENT.test(value.trim().replace(/^\[(.*)\]$/, '$1')))
  );
}

/**
 * The one rule for "a URL this product will send a browser to", shared by
 * `navigate` and `openTab`.
 *
 * Shared rather than duplicated because a scheme accepted in one and refused in
 * the other is a hole rather than an inconsistency: `openTab` reaches the same
 * network stack as `navigate`, so a `file:` or `javascript:` URL refused at one
 * door and admitted at the other is refused nowhere that matters.
 */
function navigableUrl(value: unknown, errors: string[]): string | undefined {
  if (typeof value !== 'string' || value === '') {
    errors.push('url must be a non-empty string');
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`url must be absolute, got ${JSON.stringify(value)}`);
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push(`url must be http or https, got ${parsed.protocol}`);
    return undefined;
  }
  return value;
}

/** How much of a refused action is quoted back: enough for the fields a fill carries. */
const QUOTED_ACTION_CHARS = 300;

/**
 * The refusal for a `fill` without a string `text`, written so the model can
 * act on it and so the step's error records what actually arrived.
 *
 * MEASURED, HarnessAB 2026-09-26 (fleet 8eaa6ade), a lab arm on
 * a fast preview model: 62 of its 63 schema refusals, in 12 of 39 runs,
 * were the bare "text must be a string" this replaced, and 45 of the 62 came
 * straight after a fill had already set that field. The reply had passed the
 * reply schema, which types `text` as a string when present — so `text` was
 * ABSENT, and "must be a string" described a type error the model had not
 * made. Told it twice per step, the model answered unchanged every time;
 * run_… lost steps 9-12 to it and ended `stop=error`. What it sent
 * instead was never recorded, because nothing kept a refused reply: quoting
 * the action here puts it on the step's error, where the next measurement
 * can read it.
 *
 * The press alternative is offered, not chosen: submitting is what a second
 * fill of a field that is already filled most plausibly means, and guessing
 * it on the model's behalf is exactly what this validator exists not to do.
 */
function fillTextRefusal(action: Record<string, unknown>, text: unknown, ref: NodeRef | undefined): string {
  if (text !== undefined) {
    return `fill's "text" must be a string, got ${String(JSON.stringify(text)).slice(0, QUOTED_ACTION_CHARS)}`;
  }
  const quoted = String(JSON.stringify(action));
  const target = ref === undefined ? 'F-N' : formatNodeRef(ref);
  return (
    `fill has no "text": the action arrived as ${quoted.length > QUOTED_ACTION_CHARS ? `${quoted.slice(0, QUOTED_ACTION_CHARS)}...` : quoted}. ` +
    `"text" is the exact string to type into the field: {"type":"fill","ref":"${target}","text":"..."}. ` +
    `To submit what the field already holds, press Enter on it instead: {"type":"press","key":"Enter","ref":"${target}"}`
  );
}

/**
 * Validates model output against the tree it was shown.
 *
 * Takes `unknown` on purpose: this is a trust boundary. What arrives is JSON a
 * model produced, so the compiler has nothing useful to say about it and every
 * field is checked here.
 */
export function validateAction(action: unknown, tree: AxTree): ValidationResult<Action> {
  const errors: string[] = [];

  if (!isRecord(action)) {
    return { ok: false, errors: ['action must be an object'] };
  }
  const type = action['type'];
  if (!isActionType(type)) {
    return {
      ok: false,
      errors: [`action.type must be one of ${ACTION_TYPES.join(', ')}, got ${JSON.stringify(type)}`],
    };
  }

  const index = indexTree(tree);

  switch (type) {
    case 'click':
    case 'hover': {
      // `at` OR `ref`, never both: a model that sent both has not said which
      // one it meant, and guessing is how the pointer lands on the wrong thing.
      if (action['at'] !== undefined) {
        if (action['ref'] !== undefined) {
          return { ok: false, errors: [`${type} takes ref OR at, not both`] };
        }
        const at = resolvePoint(action['at'], 'at', errors);
        return at === undefined ? { ok: false, errors } : { ok: true, value: { type, at } };
      }
      const ref = resolveRef(action['ref'], index, errors);
      if (ref === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type, ref } };
    }
    case 'drag': {
      const from = resolveEnd(action['from'], 'from', index, errors);
      const to = resolveEnd(action['to'], 'to', index, errors);
      if (from === undefined || to === undefined) {
        return { ok: false, errors };
      }
      // Checked here only when both ends are points: a node end has no
      // position until the host measures it, and the host applies the same
      // two bounds to the points it lands on.
      if (isViewportPoint(from) && isViewportPoint(to)) {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        if (length < MIN_DRAG_PX) {
          return {
            ok: false,
            errors: [`a drag of ${length.toFixed(1)} px is a click: drag at least ${String(MIN_DRAG_PX)} px, or click`],
          };
        }
        if (length > MAX_DRAG_PX) {
          return {
            ok: false,
            errors: [`a drag of ${length.toFixed(0)} px is longer than the ${String(MAX_DRAG_PX)} px one gesture may cover`],
          };
        }
      }
      return { ok: true, value: { type: 'drag', from, to } };
    }
    case 'fill': {
      const ref = resolveRef(action['ref'], index, errors);
      const text = action['text'];
      if (typeof text !== 'string') {
        errors.push(fillTextRefusal(action, text, ref));
      }
      if (ref === undefined || typeof text !== 'string') {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'fill', ref, text } };
    }
    case 'select': {
      const ref = resolveRef(action['ref'], index, errors);
      const value = requireString(action, 'value', errors);
      if (ref === undefined || value === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'select', ref, value } };
    }
    case 'press': {
      const key = requireString(action, 'key', errors);
      let ref: NodeRef | undefined;
      if (action['ref'] !== undefined) {
        ref = resolveRef(action['ref'], index, errors);
        if (ref === undefined) {
          return { ok: false, errors };
        }
      }
      if (key === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'press', key, ...(ref !== undefined ? { ref } : {}) } };
    }
    case 'scroll': {
      let ref: NodeRef | undefined;
      if (action['ref'] !== undefined && !namesTheDocument(action['ref'])) {
        ref = resolveRef(action['ref'], index, errors);
        if (ref === undefined) {
          return { ok: false, errors };
        }
      }
      const dx = optionalNumber(action, 'dx', errors);
      const dy = optionalNumber(action, 'dy', errors);
      if (errors.length > 0) {
        return { ok: false, errors };
      }
      return {
        ok: true,
        value: {
          type: 'scroll',
          ...(ref !== undefined ? { ref } : {}),
          ...(dx !== undefined ? { dx } : {}),
          ...(dy !== undefined ? { dy } : {}),
        },
      };
    }
    case 'navigate': {
      const url = navigableUrl(action['url'], errors);
      if (url === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'navigate', url } };
    }
    case 'openTab': {
      const url = navigableUrl(action['url'], errors);
      if (url === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'openTab', url } };
    }
    case 'focusTab':
    case 'closeTab': {
      const tab = requireString(action, 'tab', errors);
      if (tab === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type, tab } };
    }
    case 'attachFile': {
      const ref = resolveRef(action['ref'], index, errors);
      // A handle, checked as a string and nothing more. What it NAMES is
      // resolved against the run's own upload prefix by the executor, so a
      // model inventing one gets a refusal about that file rather than a
      // validation error about a shape it cannot see.
      const file = typeof action['file'] === 'string' && action['file'] !== '' ? action['file'] : (misplacedFile(action) ?? requireString(action, 'file', errors));
      if (ref === undefined || file === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'attachFile', ref, file } };
    }
    case 'createFile': {
      const file = requireString(action, 'file', errors);
      // Empty content passes here: a placeholder PNG or PDF needs none. The
      // renderer refuses an empty TEXT file, in words the model can act on.
      const text = action['text'];
      if (typeof text !== 'string') {
        errors.push('text must be a string (the file content; "" is allowed)');
      }
      if (file !== undefined && creatableExtension(file) === undefined) {
        errors.push(
          `file must be a name ending in one of .${Object.keys(CREATABLE_FILE_TYPES).join(', .')}, got ${JSON.stringify(file)}`,
        );
      }
      if (file === undefined || typeof text !== 'string' || errors.length > 0) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'createFile', file, text } };
    }
    case 'extract': {
      const instruction = action['instruction'];
      if (instruction !== undefined && typeof instruction !== 'string') {
        return { ok: false, errors: ['instruction must be a string when present'] };
      }
      const final = action['final'];
      if (final !== undefined && typeof final !== 'boolean') {
        return { ok: false, errors: ['final must be true or false when present'] };
      }
      return {
        ok: true,
        value: {
          type: 'extract',
          ...(instruction !== undefined ? { instruction } : {}),
          ...(final === true ? { final } : {}),
        },
      };
    }
    case 'ask': {
      // A CARD OR A BILLING PROFILE, asked of a person. The model writes it in
      // the shared schema's `value` (`ASK_WANT_ACTIONS`); this function's own
      // output names it `want`, and that form is read too, because both model
      // ports hand the loop an already-validated action and the loop validates
      // it again (purchase.end's lesson, run_…, 2026-10-08). The
      // platform writes the person's sentence, so a `question` beside it is
      // dropped rather than shown.
      const named = action['want'] ?? action['value'];
      if (isAskWant(named)) {
        return { ok: true, value: { type: 'ask', want: named } };
      }
      if (action['want'] !== undefined) {
        errors.push(`want must be card or details${gotUnlessCard(action['want'])}`);
        return { ok: false, errors };
      }
      const question = requireString(action, 'question', errors);
      if (question === undefined && typeof named === 'string' && named.trim() !== '') {
        errors.push(`value on an ask names what to ask a person for, card or details: send ${ASK_WANT_ACTIONS.card}`);
      }
      // Checked as a whole rather than element by element being coerced: a
      // reply list with a blank in it would render an empty button to a human,
      // and this is model output, so the array is either the offer it claims
      // to be or it is not one.
      const offered = action['options'];
      let options: readonly string[] | undefined;
      if (offered !== undefined) {
        if (
          !Array.isArray(offered) ||
          offered.some((option) => typeof option !== 'string' || option.trim() === '')
        ) {
          errors.push('options must be an array of non-empty strings when present');
        } else {
          options = offered as readonly string[];
        }
      }
      if (question === undefined || errors.length > 0) {
        return { ok: false, errors };
      }
      return {
        ok: true,
        value: { type: 'ask', question, ...(options !== undefined ? { options } : {}) },
      };
    }
    case 'callTool': {
      const tool = requireString(action, 'tool', errors);
      const named = tool === undefined ? undefined : actionNamedAsTool(tool);
      if (named !== undefined) {
        errors.push(named);
      }
      // The ARGUMENTS are not validated past "it is an object". Their shape is
      // the remote server's JSON schema, which this package has never read;
      // the broker puts that schema in front of the model and the remote is
      // the authority on whether the call is well formed. Two validators for
      // one schema is two validators that can disagree, and the one that is
      // wrong here would be ours.
      const args = action['arguments'];
      if (args !== undefined && !isRecord(args)) {
        errors.push('arguments must be an object when present');
      }
      if (tool === undefined || errors.length > 0) {
        return { ok: false, errors };
      }
      return {
        ok: true,
        value: {
          type: 'callTool',
          tool,
          ...(isRecord(args) ? { arguments: args as Readonly<Record<string, unknown>> } : {}),
        },
      };
    }
    // No merchant is read here, whatever the model sent: the merchant is the
    // tab's top-level site, which the loop takes from the page.
    case 'purchase.begin': {
      const amount = purchaseAmount(action['amount'], 'amount', errors);
      // The edge refuses a purchase at nothing (spend-store `begin`); said
      // here too, so the model reads the total instead of spending a step on
      // the round trip.
      if (amount !== undefined && !/[1-9]/u.test(amount)) {
        errors.push(
          'amount must be the total the checkout will charge, more than 0: read the total on the page first. A checkout that shows no total, or charges nothing now, cannot be paid by this run',
        );
      }
      const currency = action['currency'];
      if (!isCurrencyCode(currency)) {
        errors.push(
          `currency must be the three-letter ISO 4217 code in capitals, such as "USD" or "EUR"${gotUnlessCard(currency)}`,
        );
      }
      if (amount === undefined || !isCurrencyCode(currency) || errors.length > 0) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'purchase.begin', amount, currency } };
    }
    case 'purchase.end': {
      // Wire names: `value` is the outcome, `amount` the final amount, `text`
      // the order reference (see PurchaseEndAction). An empty string for an
      // optional one is read as absent, which is what a model filling every
      // property of the shared schema means by it.
      //
      // THIS FUNCTION'S OWN OUTPUT IS READ TOO, and must be: `ModelChoice.action`
      // is an `Action`, and both model ports (the hands client and the brain's
      // `directAction`) validate a reply and hand the loop the result, which
      // the loop validates again against its tree. purchase.end is the one
      // verb whose validated form renames its fields, so the second pass found
      // no `value` and refused every purchase.end that had passed the first
      // (run_…, 2026-10-08: three correct `"value":"abandoned"` replies,
      // each refused "got undefined", and the run ended `error`). An object
      // with `outcome` and no `value` is that form, read under its own names.
      const validated = action['value'] === undefined && action['outcome'] !== undefined;
      const outcome = validated ? action['outcome'] : action['value'];
      if (!isPurchaseOutcome(outcome)) {
        errors.push(
          `value must be the purchase outcome, one of completed, declined, abandoned or unknown${gotUnlessCard(outcome)}: send ${PURCHASE_END_ACTION}, leaving out amount and text when the page showed neither`,
        );
      }
      const final = validated ? action['amountFinal'] : action['amount'];
      const amountFinal = final === undefined || final === '' ? undefined : purchaseAmount(final, 'amount', errors);
      const text = validated ? action['orderRef'] : action['text'];
      const orderRef = typeof text === 'string' ? text.trim() : text;
      if (orderRef !== undefined && orderRef !== '') {
        if (typeof orderRef !== 'string' || orderRef.length > MAX_ORDER_REF_CHARS) {
          errors.push(
            `text must be the order reference the page showed, at most ${String(MAX_ORDER_REF_CHARS)} characters, when present`,
          );
        } else if (containsCardNumber(orderRef)) {
          // Never echoed: the digits may be a card's.
          errors.push('text must be the order reference, and it looks like a card number; leave it out');
        }
      }
      if (!isPurchaseOutcome(outcome) || errors.length > 0) {
        return { ok: false, errors };
      }
      return {
        ok: true,
        value: {
          type: 'purchase.end',
          outcome,
          ...(amountFinal !== undefined ? { amountFinal } : {}),
          ...(typeof orderRef === 'string' && orderRef !== '' ? { orderRef } : {}),
        },
      };
    }
    case 'done': {
      const summary = action['summary'];
      if (summary !== undefined && typeof summary !== 'string') {
        return { ok: false, errors: ['summary must be a string when present'] };
      }
      const unconfirmed = textList(action['unconfirmed']);
      const evidence = textList(action['evidence']);
      return {
        ok: true,
        value: {
          type: 'done',
          ...(summary !== undefined ? { summary } : {}),
          ...(unconfirmed.length > 0 ? { unconfirmed } : {}),
          ...(evidence.length > 0 ? { evidence } : {}),
        },
      };
    }
    case 'fail': {
      const reason = requireString(action, 'reason', errors);
      if (reason === undefined) {
        return { ok: false, errors };
      }
      return { ok: true, value: { type: 'fail', reason } };
    }
    case 'wait': {
      // Clamped rather than refused: "wait 300" means "wait as long as you
      // will", and a refusal would spend a correction call to say so. The
      // clamped figure is what the trace and the next prompt's history show.
      const seconds = action['seconds'];
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return { ok: false, errors: [`seconds must be a number of seconds to wait, got ${JSON.stringify(seconds)}`] };
      }
      return {
        ok: true,
        value: { type: 'wait', seconds: Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, seconds)) },
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Description and the wire form
 * ------------------------------------------------------------------ */

function nodeLabel(node: AxNode | undefined): string {
  if (node === undefined) {
    return 'the node';
  }
  return node.name === undefined ? `the ${node.role}` : `the ${node.role} ${JSON.stringify(node.name)}`;
}

/**
 * A point as `(x, y)` or a drag end's node by its reference. A drag carries no
 * `ref`, so the loop hands `describeAction` no node for it and the reference
 * is the one name both ends have.
 */
function aimLabel(aim: DragEnd): string {
  return isViewportPoint(aim) ? `(${String(aim.x)}, ${String(aim.y)})` : `node ${formatNodeRef(aim)}`;
}

/** One line for the step trace and for `ObservedAction.description`. */
export function describeAction(action: Action, node?: AxNode): string {
  switch (action.type) {
    case 'click':
      return action.at === undefined ? `click ${nodeLabel(node)}` : `click at ${aimLabel(action.at)}`;
    case 'fill':
      return `fill ${nodeLabel(node)} with ${JSON.stringify(action.text)}`;
    case 'select':
      return `select ${JSON.stringify(action.value)} in ${nodeLabel(node)}`;
    case 'press':
      return action.ref === undefined ? `press ${action.key}` : `press ${action.key} on ${nodeLabel(node)}`;
    case 'hover':
      return action.at === undefined ? `hover ${nodeLabel(node)}` : `hover at ${aimLabel(action.at)}`;
    case 'scroll': {
      const by = `${String(action.dx ?? 0)},${String(action.dy ?? 0)}`;
      return action.ref === undefined ? `scroll the page by ${by}` : `scroll ${nodeLabel(node)} by ${by}`;
    }
    case 'drag':
      return `drag from ${aimLabel(action.from)} to ${aimLabel(action.to)}`;
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'openTab':
      return `open a tab at ${action.url}`;
    case 'focusTab':
      return `focus tab ${action.tab}`;
    case 'closeTab':
      return `close tab ${action.tab}`;
    case 'attachFile':
      return `attach file ${action.file} to ${nodeLabel(node)}`;
    case 'createFile':
      return `create file ${JSON.stringify(action.file)} (${String(new TextEncoder().encode(action.text).length)} bytes of content)`;
    case 'ask':
      if (action.want !== undefined) {
        return `ask the person for ${action.want === 'card' ? 'a card' : 'a billing profile'}`;
      }
      return action.options === undefined
        ? `ask: ${action.question}`
        : `ask: ${action.question} (${action.options.join(' / ')})`;
    case 'callTool':
      return `call ${action.tool}`;
    case 'purchase.begin':
      return `open a purchase of ${action.amount} ${action.currency}`;
    case 'purchase.end':
      return `close the purchase as ${action.outcome}${action.amountFinal === undefined ? '' : ` at ${action.amountFinal}`}${action.orderRef === undefined ? '' : ` (order ${action.orderRef})`}`;
    case 'extract':
      return action.instruction === undefined
        ? 'extract the schema'
        : `extract ${action.instruction}${action.final === true ? ' (final)' : ''}`;
    case 'done':
      return action.summary === undefined ? 'done' : `done: ${action.summary}`;
    case 'fail':
      return `fail: ${action.reason}`;
    case 'wait':
      return `wait ${String(action.seconds)} s for the page`;
  }
}

/** Arguments in the order the wire form records them. */
function wireArgs(action: Action): readonly string[] {
  switch (action.type) {
    case 'fill':
      return [action.text];
    case 'select':
      return [action.value];
    case 'press':
      return [action.key];
    case 'scroll':
      return [String(action.dx ?? 0), String(action.dy ?? 0)];
    case 'navigate':
      return [action.url];
    case 'attachFile':
    case 'createFile':
      return [action.file];
    case 'ask':
      return [action.want ?? action.question];
    case 'callTool':
      return [action.tool];
    case 'wait':
      return [String(action.seconds)];
    default:
      return [];
  }
}

/**
 * The cache unit: `@outcrawl/scout-core`'s `ObservedAction`, which is what
 * `observe()` hands back and what `@outcrawl/cache` stores.
 *
 * `xpath` comes from the node rather than the action because it is the heal
 * path. On a replay in a later session the stored `ref` is dead — backend node
 * ids are minted per renderer process — and the XPath is the only thing left
 * to resolve against.
 */
export function toObservedAction(action: NodeAction, node: AxNode): ObservedAction {
  const args = wireArgs(action);
  return {
    ref: formatNodeRef(action.ref),
    description: describeAction(action, node),
    method: action.type,
    ...(args.length > 0 ? { args } : {}),
    xpath: node.xpath,
  };
}
