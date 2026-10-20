/**
 * Resumption: the browser can die, the run cannot.
 *
 * Three things live here, and none of them is the loop — `loop.ts` reads this
 * file and never the other way around, because three agents are queued on that
 * file and the mechanism is separable from it:
 *
 * 1. {@link RunIntent}, the unit a resume carries. INTENT, never state.
 * 2. {@link classifyIrreversible}, which decides whether a dispatch may ever be
 *    replayed, and {@link IrreversibleMark}, the record that survives the crash.
 * 3. {@link isBrowserLost}, which tells a browser that died from a step that
 *    was merely wrong — the difference between re-acquiring and giving up.
 *
 * ── WHY INTENT AND NOT STATE ─────────────────────────────────────────────────
 *
 * Serialisable: {@link AgentMemory}, `StepTrace[]`, {@link CapState}, the task,
 * the schema, the profile. Not serialisable, and not attempted: the live DOM,
 * every `NodeRef` in the run — `DOMNodeIds::IdToNodeMap()` is a per-renderer
 * static and ids collide across frames, which is why they are frame-qualified —
 * scroll offsets, in-flight requests, and the freeze `PageSession` holds.
 *
 * So a resume is a FRESH browser replaying intent. It re-navigates and it
 * re-reads. `AgentRequest.profile` already persists cookies and logged-in state
 * across runs, so the fresh context lands logged in as the same person — which
 * is the seed that makes a resume cheap, and the reason the rule below is not
 * optional.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * A run is resumable until its first irreversible action and permanently
 * un-resumable after it. Past that point a resume may REPORT what the run knew
 * and MUST NOT ACT, because the run cannot distinguish "the order went through
 * and the confirmation page died with the browser" from "the order never went
 * through": that evidence lived in the DOM that died. And because the profile
 * carries the session, a blind retry does not bounce — it succeeds, and the
 * customer is charged twice.
 */

import type { AgentCaps, AgentStopReason, Clock, JsonSchema, Timestamp } from '@outcrawl/scout-core';

import type { Action } from './actions';
import { describeAction } from './actions';
import type { CapState, RunPricing } from './caps';
import { CapLedger } from './caps';
import type { AgentMemory, AgentResult, StepTrace } from './result';
import { mergeUsage, resolveStatus, subscriptionCallsField } from './result';
import type { AxNode, AxTree } from './snapshot';
import { formatNodeRef, walk } from './snapshot';

/* ------------------------------------------------------------------ *
 * The mark
 * ------------------------------------------------------------------ */

/**
 * What class of third-party state an action was about to mutate.
 *
 * `suspected` is the one that is not a claim. It is what the structural rules
 * below produce when the page context says a dispatch might be consequential
 * and no label matched a known phrase — a `Continue` that submits payment, a
 * submit rendered as an icon, a locale nobody enumerated. See
 * {@link classifyIrreversible} for why an unnamed suspicion is still a mark.
 */
export type IrreversibleKind =
  | 'payment'
  | 'order'
  | 'message'
  | 'account'
  | 'handoff'
  | 'suspected';

/**
 * One attempted irreversible action, written BEFORE it was dispatched.
 *
 * ── THE MARK SAYS ATTEMPTED, NEVER COMPLETED ─────────────────────────────────
 *
 * We cannot know whether the payment went through, only that we tried, and
 * *tried* is already sufficient to refuse. A system that claimed to know would
 * be lying at the exact moment it matters most.
 *
 * ── AND IT IS WRITTEN BEFORE THE DISPATCH, NOT AFTER ─────────────────────────
 *
 * After-dispatch marking cannot survive the crash it exists for: the browser
 * dies between the click and the record, the mark is lost, and the resume
 * replays the payment. So the sink is awaited before `perform`, and if the sink
 * throws the dispatch does not happen — an unrecorded irreversible act IS the
 * double charge this whole mechanism exists to prevent.
 */
export interface IrreversibleMark {
  /** The run this belongs to. On the record because the log outlives the process. */
  readonly runId: string;
  /** The step index the action was about to be dispatched on. */
  readonly step: number;
  readonly kind: IrreversibleKind;
  /** `describeAction` of the action itself, so a log line reads as English. */
  readonly action: string;
  /**
   * WHY this was marked: the matched phrase, or the structural fact. Never a
   * verdict without a reason — a mark a human cannot audit is a mark nobody
   * will trust enough to keep.
   */
  readonly evidence: string;
  /** Where it was about to happen. */
  readonly url: string;
  readonly at: Timestamp;
}

/** Where a mark is written. Awaited before dispatch; a throw cancels the dispatch. */
export type IrreversibleSink = (mark: IrreversibleMark) => Promise<void>;

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

/**
 * Phrases that name an irreversible act, by class.
 *
 * Verbs and verb phrases, deliberately, not nouns: `payment` alone appears in
 * "Payment methods", which is a settings link, so the money classes require a
 * verb beside the noun. What is NOT required is exhaustiveness — the structural
 * rules below are what covers the labels this list will never contain.
 */
const PHRASES: readonly (readonly [IrreversibleKind, RegExp])[] = [
  ['payment', /\bpay\b|\bpay now\b/],
  ['payment', /\b(confirm|submit|complete|make|authori[sz]e|process)\s+(the\s+|my\s+)?payment\b/],
  ['payment', /\bdonate\b|\bsend money\b|\btransfer (funds|money)\b|\bsubscribe\b/],
  ['order', /\b(place|confirm|submit|complete|finali[sz]e)\s+(the\s+|my\s+|your\s+)?order\b/],
  ['order', /\border now\b|\bbuy now\b|\bbuy\b|\bpurchase\b/],
  ['order', /\bbook now\b|\bconfirm (booking|reservation)\b|\breserve\b/],
  ['message', /\bsend\b|\bpost\b|\bpublish\b|\breply\b|\btweet\b|\bcomment\b/],
  ['account', /\bsign ?up\b|\bcreate (an? )?account\b|\bregister\b|\bjoin (now|free)\b/],
  ['account', /\b(delete|close|deactivate) (my )?account\b/],
  ['handoff', /\bupload\b|\bshare\b|\bsend file\b|\battach\b|\binvite\b/],
];

/**
 * Labels that are never marked on their own, whatever the page context.
 *
 * The list is short and every entry is a control that UNDOES or NAVIGATES
 * rather than commits. `continue` is deliberately absent: a `Continue` that
 * submits payment is the exact false negative Main asked this classifier to
 * fail toward marking, so on a consequential page it is marked. What IS here is
 * the step INTO a checkout and the named steps inside one — `Checkout`,
 * `Proceed to checkout`, `Continue to shipping` — none of which can commit: the
 * commit is the button at the end, and it is still marked. Measured 2026-09-23
 * on Honey Birdette with a "Never pay or place an order." rule: the cart's
 * `CHECKOUT` button was refused as a commit because the cart's heading reads
 * "ORDER SUMMARY", so the rule made the checkout it was written for
 * unreachable.
 */
const BENIGN =
  /^(back|go back|cancel|close|dismiss|edit|change|search|filter|sort|sign in|log ?in|previous|continue shopping|keep shopping|view (cart|details|order)|print|copy|help|home)\b|^(proceed to |go to |secure |continue to )?check ?out$|^continue to (shipping|delivery|payment|information|billing|review)( method)?$/;

/**
 * A label that DECLINES an offer. Never read against {@link PHRASES}, because
 * the offer it declines is usually priced: Honey Birdette's discount popup
 * closes on "NO, THANKS I'LL PAY FULL PRICE", which matched `\bpay\b`, and a
 * "Never pay or place an order." rule then refused the only way to close the
 * popup — 2 of 3 live checkouts ended there, 2026-09-23. The page context
 * below still applies: a decline on a checkout page is marked like any other
 * control there.
 */
const DECLINE = /^(no,? thanks|no thank you|not now|maybe later|skip)\b/;

/** A page whose whole purpose is committing something. URL half. */
const CONSEQUENTIAL_URL = /checkout|\/pay(ment)?\b|\/order|purchase|confirm|billing|subscribe|signup|sign-up|register/i;

/** The same question asked of the page's own headings, for a site with opaque URLs. */
const CONSEQUENTIAL_HEADING = /\b(checkout|payment|place your order|order summary|confirm|billing|shipping and payment|complete (your )?purchase)\b/i;

/**
 * A field whose presence makes every submit on the page consequential: a card,
 * a bank detail, or a credential.
 *
 * Structural and label-independent in the way that matters — it does not ask
 * what the BUTTON says, which is the thing a site can word however it likes.
 */
const SENSITIVE_FIELD = /card ?number|\bcvv\b|\bcvc\b|security code|expir(y|ation)|\biban\b|routing number|account number|sort code|password|passcode/i;

/**
 * Roles a CLICK can commit something through: a submit button, a link or menu
 * item wired to one. A radio, a checkbox, a tab, a combobox or a text field
 * changes what the form holds and submits nothing — implicit form submission
 * is a key press, and Enter is classified on its own terms below, whatever
 * field it lands on. Clicking a shipping option on a checkout is how a "never
 * pay" run gets to the card fields at all.
 */
const COMMITTING_ROLES: Readonly<Record<string, true>> = {
  button: true,
  link: true,
  menuitem: true,
};

/** What the classifier is asked about. */
export interface IrreversibleQuestion {
  readonly action: Action;
  /** The node the action resolved to, in the tree it was chosen from. */
  readonly node: AxNode | undefined;
  /** That tree. Read for the URL and for the page's structural signals. */
  readonly tree: AxTree;
  /**
   * The run so far. Read for one thing: whether a preceding step typed into a
   * sensitive field, which makes the next submit consequential no matter what
   * the page looks like by then.
   */
  readonly history: readonly StepTrace[];
}

function normalise(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether this page carries a field that makes its submits consequential. */
function sensitiveFieldOn(tree: AxTree): string | undefined {
  for (const node of walk(tree)) {
    const label = `${node.name ?? ''} ${node.value ?? ''}`;
    if (SENSITIVE_FIELD.test(label)) {
      return normalise(node.name) === '' ? node.role : normalise(node.name);
    }
  }
  return undefined;
}

/**
 * The first heading that names a commit AND comes before `target` in the page.
 *
 * A heading titles what follows it, never what precedes it, so a control that
 * sits above the heading is not under it. That is the whole difference between
 * a checkout's "Payment" heading over its Continue button and the payment-logo
 * strip every shop puts in its footer. Measured 2026-10-06, run_…
 * (Stealth Bench run 5, smythstoys.com): the footer's `<h4>Our payment
 * methods</h4>`, the LAST heading on every page of the site, marked all eight
 * dispatches of a browse-only task as suspected commits — header links,
 * product links, Enter in the search and postcode boxes — and the run's next
 * routine exit renewal refused to resume, with two of three goals answered.
 *
 * Document order and not landmarks, because the tree the classifier is given
 * has none: `Outcrawl.getAXTree` keeps only actionable and labelling roles, so
 * `contentinfo` and `main` are promoted away (see `IsActionableRole` and
 * `IsLabellingRole` in the fork's tenancy patch).
 *
 * `target` undefined — a key press on focus the step did not name, with no
 * focused node in the tree either — or a target this tree does not hold, is
 * judged against every heading on the page: nothing places it, so it fails
 * toward marking.
 */
function consequentialHeading(tree: AxTree, target: AxNode | undefined): string | undefined {
  const at = target === undefined ? undefined : formatNodeRef(target.ref);
  let preceding: string | undefined;
  for (const node of walk(tree)) {
    if (at !== undefined && formatNodeRef(node.ref) === at) {
      return preceding;
    }
    if (
      preceding === undefined &&
      node.role === 'heading' &&
      node.name !== undefined &&
      CONSEQUENTIAL_HEADING.test(node.name)
    ) {
      preceding = node.name;
    }
  }
  // Not placed: any consequential heading on the page counts.
  return preceding;
}

/**
 * The sensitive field an earlier step in THIS run typed into, by its label.
 *
 * THE LABEL, NEVER THE VALUE. This string becomes the mark's evidence, which is
 * written to the irreversible log and to the fleet's `agent.irreversible` line,
 * and the value typed into a sensitive field is a card number or a password.
 * Measured 2026-09-23: two `agent.irreversible` lines on the production fleet
 * carried a full card number, because this returned the whole fill description
 * — `fill the textbox "Card number" with "<the number>"`. The label is also the
 * only part the test should read: a search box someone typed "password" into
 * is not a credential field.
 */
function typedSomethingSensitive(history: readonly StepTrace[]): string | undefined {
  for (const step of history) {
    if (step.action.type !== 'fill' || step.error !== undefined) {
      continue;
    }
    const description = step.observed?.description ?? '';
    const typed = ` with ${JSON.stringify(step.action.text)}`;
    if (description.endsWith(typed)) {
      const field = description.slice(0, -typed.length);
      if (SENSITIVE_FIELD.test(field)) {
        return field;
      }
    } else if (SENSITIVE_FIELD.test(description)) {
      // A description this function cannot split cannot be quoted safely.
      return 'a sensitive field';
    }
  }
  return undefined;
}

/**
 * Where `node` links to, when it is a plain link: role `link` with an `href`
 * that loads a document (http, https or a path), read from the node's own
 * `href` or else from the `@href` its xpath names. `undefined` for anything
 * else, which is judged as a submit: a link with no destination, `#…` or
 * `javascript:` runs the page's script, which can submit anything. A link
 * whose xpath is positional and carries no `href` is not known to be plain,
 * and is judged as before.
 */
function plainLinkTo(node: AxNode | undefined): string | undefined {
  if (node?.role !== 'link') return undefined;
  const href = node.href ?? /^\/\/a\[@href="([^"]*)"\]$/.exec(node.xpath)?.[1];
  if (href === undefined || href === '' || href.startsWith('#') || /^\s*javascript:/i.test(href)) return undefined;
  return /^(https?:)?\/|^[^:]*$/i.test(href) ? href : undefined;
}

/**
 * Whether this action may ever be replayed, and if not, why.
 *
 * ── IT FAILS TOWARD IRREVERSIBLE, AND THE ASYMMETRY IS TOTAL ─────────────────
 *
 * A false positive costs a resume: the run reports instead of continuing, which
 * is annoying, recoverable, and leaves the customer every finding. A false
 * negative costs a stranger's money, on their card, in a way we cannot undo. So
 * the label rules are a floor and not the mechanism: three structural rules,
 * none of which depends on wording, mark a dispatch the phrase list would miss.
 *
 *   1. a submit on a page carrying a payment or credential field;
 *   2. a submit on a page whose URL names checkout/order/payment/confirm/
 *      billing, or under a heading that does — above the control, not in the
 *      footer below it (see `consequentialHeading`);
 *   3. a submit at any point after this run typed into a sensitive field.
 *
 * Only a dispatch that can commit is considered at all. `fill`, `select`,
 * `hover`, `scroll`, `extract` and the tab actions mutate nothing a third party
 * can see, and `navigate` is a GET and idempotent by the HTTP contract it is
 * defined by — a run that re-navigates is the entire resume strategy, so
 * marking one would make every run un-resumable and this mechanism worthless.
 *
 * KNOWN GAP, stated rather than papered over: a `press` of Enter inside a
 * payment form is caught by rules 1 and 3 but never by rule 0, because the
 * field a key press lands on is labelled `Card number`, not `Pay`. Rule 3 is
 * what covers it, and it is why rule 3 looks at the RUN and not at the page.
 * When the secrets store lands, "a field the secrets store supplied" is a
 * stronger version of the same signal and belongs here, replacing the label
 * match in {@link typedSomethingSensitive}.
 *
 * SECOND KNOWN GAP: on a page whose URL says nothing, a commit control placed
 * ABOVE the only heading that names the commit is not marked by rule 2. Rules
 * 0, 1 and 3 still apply to it, and a payment page carries the card field
 * rule 1 reads.
 */
export function classifyIrreversible(
  question: IrreversibleQuestion,
): { readonly kind: IrreversibleKind; readonly evidence: string } | undefined {
  const { action, node, tree, history } = question;

  // Only a dispatch that can commit. See the note above on `navigate`.
  //
  // SPACE ACTIVATES a focused button exactly as a click does, so it is judged
  // as one: on a committing control, or on focus the step did not name (which
  // may be one). In a text field it types a space and commits nothing. It was
  // not considered at all before, so `press(" ")` on a focused Pay button
  // passed the gate that `click` on the same button is stopped by.
  const space = action.type === 'press' && /^( |space|spacebar)$/i.test(action.key);
  const dispatches =
    action.type === 'click' ||
    space ||
    (action.type === 'press' && /^(enter|return|numpadenter)$/i.test(action.key));
  if (!dispatches) {
    return undefined;
  }
  if ((action.type === 'click' || space) && node !== undefined && COMMITTING_ROLES[node.role] !== true) {
    return undefined;
  }

  const label = normalise(node?.name);

  if (!DECLINE.test(label)) {
    for (const [kind, phrase] of PHRASES) {
      if (label !== '' && phrase.test(label)) {
        return { kind, evidence: `label ${JSON.stringify(label)} matched ${String(phrase)}` };
      }
    }
  }

  // A control that undoes or navigates is never marked on context alone.
  // Everything else on a consequential page is.
  if (label !== '' && BENIGN.test(label)) {
    return undefined;
  }

  // A PLAIN LINK IS A GET, as `navigate` is (see the note above), so no
  // context marks it: not a password typed earlier, not a card field on the
  // page, not the page's URL or heading. Only its own commit wording, read
  // above, does. Fleet 2026-10-20 06:54Z (Outcrawl Bench dev jobs-apply,
  // run_7f6332df): after a sign-in, the links "Kestrel Logistics", "Data
  // Analyst" and "Apply now" were each marked suspected, and the run the drain
  // handed back was refused its resume.
  if (action.type === 'click' && plainLinkTo(node) !== undefined) {
    return undefined;
  }

  const typed = typedSomethingSensitive(history);
  if (typed !== undefined) {
    return {
      kind: 'suspected',
      evidence: `this run already typed into a sensitive field (${typed}), so any submit after it may commit`,
    };
  }

  const field = sensitiveFieldOn(tree);
  if (field !== undefined) {
    return {
      kind: 'suspected',
      evidence: `the page carries a payment or credential field (${field}), so this submit may commit`,
    };
  }

  if (CONSEQUENTIAL_URL.test(tree.url)) {
    return {
      kind: 'suspected',
      evidence: `the page url names a commit (${tree.url})`,
    };
  }

  // Placed by the node the step names, or else by the page's focus, which is
  // where an unaimed key press lands. See `consequentialHeading`.
  const heading = consequentialHeading(tree, node ?? walk(tree).find((candidate) => candidate.state?.focused === true));
  if (heading !== undefined) {
    return {
      kind: 'suspected',
      evidence: `the page heading names a commit (${JSON.stringify(heading)})`,
    };
  }

  return undefined;
}

/** The mark for a classified action, stamped. */
export function markFor(
  question: IrreversibleQuestion,
  verdict: { readonly kind: IrreversibleKind; readonly evidence: string },
  runId: string,
  step: number,
  at: Timestamp,
): IrreversibleMark {
  return {
    runId,
    step,
    kind: verdict.kind,
    action: describeAction(question.action, question.node),
    evidence: verdict.evidence,
    url: question.tree.url,
    at,
  };
}

/* ------------------------------------------------------------------ *
 * The intent
 * ------------------------------------------------------------------ */

/**
 * Everything a resume carries. See the module header for what is deliberately
 * absent and why none of it can be carried at all.
 */
export interface RunIntent {
  readonly id: string;
  readonly task: string;
  readonly schema?: JsonSchema;
  /** The profile that holds the cookies. What makes a fresh browser land logged in. */
  readonly profile?: string;
  readonly memory: AgentMemory;
  /**
   * Every step of every attempt, in order. Seeded into the resumed run's
   * history so `compactHistory` shows the model what it already did, and NOT
   * re-emitted through `onStep` — a subscriber sees each step exactly once.
   */
  readonly steps: readonly StepTrace[];
  /** What the run has already spent. Seeded into the ledger so caps continue. */
  readonly used: CapState;
  /** What the run had collected. Never discarded by a resume. */
  readonly data?: unknown;
  /**
   * Marks written before dispatch, across every attempt. Non-empty makes the
   * run report-only, permanently.
   */
  readonly irreversible: readonly IrreversibleMark[];
  /** How many browsers this run has already lost. Bounds re-acquisition. */
  readonly reacquisitions: number;
  /**
   * Set when the attempt that left this intent ended on an {@link ExitSwitchError}:
   * the page its exit could not reach. Changes what {@link resumeNotice} says,
   * and nothing else: an exit switch is not a lost browser.
   */
  readonly exitSwitch?: ExitSwitch;
}

/**
 * The run's exit could not carry it to a page, so the host moves the run to a
 * new context on another exit. See {@link ExitSwitchError}.
 */
export interface ExitSwitch {
  /** The provider whose exit failed it. Operator-facing only: never in a model or customer sentence. */
  readonly provider: string;
  /** The page the run was navigating to. */
  readonly url: string;
  /**
   * - `'refused'`: the provider refuses `url` on every exit, so the next
   *   context comes from ANOTHER provider and the model is told to go back.
   * - `'exit-ended'`: the exit itself is gone — a tunnel CONNECT answered
   *   `410 Gone`, the vendor's sticky session ended — so the next context gets
   *   a FRESH exit from the same provider and geography, and the loop loads
   *   `url` again itself before the first step. The IP changes; the old one
   *   was already gone.
   */
  readonly reason: 'refused' | 'exit-ended';
  /**
   * The step whose NAVIGATION the exit failed (the loop's step index). Both
   * reasons are thrown only from a `navigate` whose document never reached
   * the site (its tunnel CONNECT failed, or the host was refused before it was
   * dialled), and only after the step read the page, so every step before it
   * finished and its outcome was read in this same live context. See
   * {@link mayAct}. Absent from an intent written before it existed.
   */
  readonly step?: number;
  /**
   * Whether a page COMMITTED through the old exit after the run's last
   * irreversible mark in that context (a real site document; an error page
   * does not count), set by the host. Without it the marked act's outcome is
   * unknown: the step after a click may have read nothing but the error the
   * click's own POST met on the dying exit. See {@link mayAct}.
   */
  readonly confirmed?: boolean;
  /**
   * Why an `'exit-ended'` switch renews the exit, where it is not the exit
   * itself ending: `'site-refused'` when the site's edge refused the old
   * address (Akamai's `Access Denied`, or the stream reset it answers a denied
   * client with). The renewal is the same; only what {@link resumeNotice}
   * tells the model differs, so it is not told an exit closed that did not.
   */
  readonly cause?: 'site-refused';
}

/**
 * Whether a resume of this intent may act, or may only report.
 *
 * A run that attempted something irreversible may not act again once its
 * browser is lost: nothing can tell whether the act went through or died with
 * the browser. AN EXIT SWITCH CAN BE DIFFERENT (OC-316): the browser was alive
 * and the attempt ended at a navigation that sent nothing. It resumes only when
 * the host confirms a page committed through the old exit after the last mark
 * (`confirmed`) AND every mark precedes the switching step. Anything less —
 * no step, no confirmation, a mark on the switching step — still refuses:
 * fail toward refusal. The marks stay on the intent, so a real browser loss
 * later still refuses, and the resume is told each one ({@link resumeNotice}).
 */
export function mayAct(intent: RunIntent): boolean {
  if (intent.irreversible.length === 0) return true;
  const switched = intent.exitSwitch;
  const switchedAt = switched?.step;
  return (
    switched?.confirmed === true &&
    switchedAt !== undefined &&
    intent.irreversible.every((mark) => mark.step < switchedAt)
  );
}

/** The host of a URL, or `undefined` when it does not parse. */
export function markHost(url: string): string | undefined {
  return URL.parse(url)?.hostname.toLowerCase() || undefined;
}

/**
 * The sentence an exit-switched resume carries for every irreversible mark
 * (OC-316): the new context has none of the old one's cookies or cart, and
 * history compaction drops old successful clicks, so without it the model
 * could commit the same act a second time.
 */
function marksNotice(marks: readonly IrreversibleMark[]): string {
  if (marks.length === 0) return '';
  const listed = marks
    .map((mark) => `step ${String(mark.step)} (${mark.kind}) on ${mark.url}: ${mark.action}`)
    .join('; ');
  return (
    ` ALREADY DISPATCHED, and possibly gone through: ${listed}. The new context has none of the old ` +
    "one's cookies, session or cart. Do NOT repeat any of these, and do not do the same kind of thing on the " +
    'same site again; report what you know about them instead.'
  );
}

/**
 * The intent a finished-or-died attempt leaves behind.
 *
 * The result IS most of the intent, which is not a coincidence: `AgentResult`
 * already carries the plan, the complete findings, the collected data and every
 * step, because a capped run had to be able to hand all of it back. A resume
 * needs exactly the same things a customer needed.
 *
 * @param pages Page loads this run has committed across EVERY browser it has
 * held, including the attempt that just ended.
 *
 * A required argument from the host rather than a field read off `result`, on
 * `toWireResult`'s precedent and for its reason: a re-acquired run has two tab
 * sets, the first is disposed before the second exists, and the survivor knows
 * only its own pages. The host keeps the running total. It has to arrive here
 * because pages are a priced term of `caps.budget` now — seeded at zero, a run
 * whose browser died would be handed a fresh page allowance on top of the one
 * the customer already paid for, which is the per-browser-ceiling defect the
 * `used.elapsedMs` seed exists to prevent, one column along.
 *
 * @param bandwidthBytes Bandwidth bytes this run has relayed across EVERY
 * browser it has held, both directions summed, on exactly {@link pages}'s
 * terms and for the identical reason: a re-acquired run's new browser
 * context starts its OWN `Outcrawl.getContextBytes` counter at zero, so the
 * survivor knows only what it has spent itself, and the host is the one
 * place that has watched both. Seeded at zero, a run whose browser died
 * would be handed a fresh bandwidth allowance on top of the one the
 * customer already paid for — the same defect `pages` closes, aimed at the
 * quantity `RUN_CREDITS_PER_BYTE` now prices.
 */
export function intentFrom(
  previous: RunIntent,
  result: AgentResult,
  marks: readonly IrreversibleMark[],
  lostBrowser: boolean,
  pages: number,
  bandwidthBytes: number,
): RunIntent {
  // Only the attempt that just ended says where it could not go.
  const { exitSwitch: _previousSwitch, ...carried } = previous;
  return {
    ...carried,
    ...(result.exitSwitch === undefined ? {} : { exitSwitch: result.exitSwitch }),
    memory: { goals: result.goals, findings: result.findings, ruledOut: result.ruledOut },
    steps: result.steps,
    used: {
      steps: result.stepsUsed,
      credits: result.credits,
      charged: result.charged,
      pages,
      bandwidthBytes,
      modelCostUsd: result.modelCostUsd,
      plan: result.pricing.plan,
      byok: result.pricing.byok,
      elapsedMs: result.durationMs,
      parkedMs: result.parkedMs,
      ...subscriptionCallsField(result.subscriptionCalls),
    },
    ...(result.data === undefined ? {} : { data: result.data }),
    irreversible: marks,
    reacquisitions: previous.reacquisitions + (lostBrowser ? 1 : 0),
  };
}

/**
 * What the model is told on the first step of a resumed run.
 *
 * One paragraph, once. It has to say three things or the model wastes the step
 * it is being given: the page is gone, the findings are not, and the way back
 * is a navigation.
 */
export function resumeNotice(intent: RunIntent): string {
  if (intent.exitSwitch?.reason === 'exit-ended') {
    const why =
      intent.exitSwitch.cause === 'site-refused'
        ? `the site refused the address it had at ${intent.exitSwitch.url}`
        : `the one it had closed while ${intent.exitSwitch.url} was loading`;
    return (
      `This run's network exit CHANGED at step ${String(intent.used.steps)}: ${why}, so the run continues on a ` +
      'fresh exit in the same location, from a different IP address. The page you were on and every node ' +
      'reference you held are gone. Your plan, your findings and what you had ruled out are on this prompt.' +
      marksNotice(intent.irreversible)
    );
  }
  if (intent.exitSwitch !== undefined) {
    return (
      `This run MOVED to a different network at step ${String(intent.used.steps)}: the previous one refused ` +
      `${intent.exitSwitch.url}, and this one is not known to. The page you were on and every node reference ` +
      'you held are gone. Your plan, your findings and what you had ruled out are on this prompt. Navigate to ' +
      `${intent.exitSwitch.url} again and carry on from what you already know.` +
      marksNotice(intent.irreversible)
    );
  }
  return (
    `This run RESUMED on a fresh browser after the previous one was lost at step ${String(intent.used.steps)}. ` +
    'The page you were on, every node reference you held and any form you had half-filled are gone; ' +
    'nothing about them can be recovered. What survived is on this prompt: your plan, your findings and ' +
    'what you had ruled out. Re-navigate to where the work is and carry on from what you already know — ' +
    'do not re-read a fact that is already in your findings.'
  );
}

/**
 * The report a resume gives when it may not act.
 *
 * ZERO steps, ZERO credits, ZERO browsers: nothing is opened, so there is
 * nothing to charge and nothing that could act by accident. Everything the run
 * learned is returned, because that half is what the customer already paid for.
 *
 * @param caps The run's own ceilings. The bill is re-read from a ledger seeded
 * with {@link RunIntent.used} on a stopped clock, so the report is priced by
 * the same funding order as every other result, `caps.budget` included.
 *
 * @param pricing The host's price list, as the run itself would have been
 * handed it. Its `model` is overridden by the tier the run started under.
 */
export function reportOnlyResult<T = unknown>(intent: RunIntent, caps: AgentCaps, pricing: RunPricing): AgentResult<T> {
  const mark = intent.irreversible[0];
  const detail =
    mark === undefined
      ? 'an irreversible action'
      : `${mark.kind} at step ${String(mark.step)} (${mark.action} on ${mark.url}) — ${mark.evidence}`;
  // This path opens no browser and takes no step, so it adds nothing to any
  // figure and must not invent a fresh charge for a run it refused to
  // continue. The figures come off a ledger seeded with the intent on a clock
  // that never moves, which prices exactly what the earlier attempts spent.
  // NOT the intent's own `credits` and model USD passed through: a run can be
  // capped and still unsettled here (the step that tripped the budget was
  // recorded, then the machine was lost), and then its measured model USD is
  // more than the budget funded. Passed through, `model_cost_usd` was metered
  // past the customer's ceiling.
  const stopped: Clock = { now: () => 0, sleep: () => Promise.resolve() };
  const billing = new CapLedger(caps, stopped, intent.used, pricing).billing();
  return {
    id: intent.id,
    // Not `completed` and never `capped`: the run did not finish the task and
    // no ceiling fired. `partial` when there is something to report, `failed`
    // when there is not — the same two answers any unfinished run gives.
    status: resolveStatus({ failed: true, hasData: intent.data !== undefined }),
    data: intent.data as T | undefined,
    steps: intent.steps,
    stepsUsed: intent.steps.length,
    stopReason: 'irreversible',
    // Every earlier attempt's tokens, for the reason `runAgent` seeds its own.
    usage: intent.steps.reduce((total, step) => mergeUsage(total, step.usage), {}),
    credits: billing.credits,
    charged: intent.used.charged,
    durationMs: billing.measuredMs,
    parkedMs: billing.parkedMs,
    ...(billing.billedMs < billing.measuredMs ? { billedMs: billing.billedMs } : {}),
    // Earlier attempts' model usage, billed once, here, at the plan the run
    // started under, as far as the budget funds it.
    modelCostUsd: billing.modelCostUsd,
    billedModelCostUsd: billing.billedModelCostUsd,
    ...subscriptionCallsField(intent.used.subscriptionCalls),
    pricing: { plan: intent.used.plan, byok: intent.used.byok },
    goals: intent.memory.goals,
    findings: intent.memory.findings,
    ruledOut: intent.memory.ruledOut,
    error:
      `this run attempted ${detail}, so it is permanently un-resumable: nothing can tell ` +
      'whether that action went through and its confirmation died with the browser, or never went ' +
      'through at all. Reporting what the run knew instead of acting.',
  };
}

/* ------------------------------------------------------------------ *
 * A browser that died
 * ------------------------------------------------------------------ */

/**
 * The ways a browser announces that it is gone.
 *
 * Every entry is a message from a socket or a target that no longer exists, and
 * that is the whole test: a step that was WRONG — a ref naming no node, a fill
 * on the wrong element — must not be mistaken for a browser that died, because
 * one is recovered by the next prompt and the other by a new browser.
 *
 * Deliberately NOT here: `Outcrawl.lock did not answer within 30000ms`. A held
 * command is this fork's known failure mode and the connection is still open;
 * re-acquiring on it would throw away a browser that is merely busy.
 */
const BROWSER_LOST =
  /the cdp connection closed|websocket (is not open|closed)|socket hang up|econnreset|epipe|target closed|no target with given id|session with given id not found|inspected target navigated or closed|browser (has closed|closed unexpectedly)|connection ended|not connected/i;

/**
 * Thrown by a host's `navigate` when the run's exit cannot carry it to the
 * destination and the host has another exit that can: the provider refuses the
 * destination by policy (every exit of that provider would) and another
 * provider of the same class is not known to, or the exit's own session ended
 * (`reason: 'exit-ended'`, a tunnel CONNECT answered `410 Gone`) and a fresh one
 * can be provisioned in the same geography.
 *
 * The browser pins one route per context, so a run cannot change egress inside
 * its context: the loop ends this attempt with {@link AgentResult.exitSwitch}
 * and the host opens the run's next context on the other exit and resumes
 * the intent there. Not a lost browser: no backoff, no crash breaker, no
 * reacquisition counted (W43 incident, 2026-09-25: one residential provider
 * refused amazon.in, octopart.com and ebay.com, and agent runs ranked on it
 * died instead of moving to another). A host that has no such exit throws the ordinary step
 * error instead, which the model reads and routes around.
 */
export class ExitSwitchError extends Error {
  override readonly name = 'ExitSwitchError';
  readonly exitSwitch: ExitSwitch;

  constructor(exitSwitch: ExitSwitch, message: string) {
    super(message);
    this.exitSwitch = exitSwitch;
  }
}

/**
 * Thrown by a host when the run cannot go on in this context and the host has
 * no other context to give it — so every further step would meet the same
 * failure and bill for it. The loop stops the run at once with this message as
 * its `error`, which starts with {@link RunEndedError.code} and says what the
 * customer can do. Not a lost browser and not an exit switch: nothing resumes.
 *
 * First use (ByoProxyReview, 2026-09-26): an exit whose sticky session ended
 * (tunnel CONNECT `410 Gone`) under a run that cannot be moved to a fresh one
 * — a profile's run, or an exit renewed a moment ago that ended again before
 * it carried a page. Left running, such a run spends its remaining steps on
 * tunnel failures through a session that no longer exists.
 */
export class RunEndedError extends Error {
  override readonly name = 'RunEndedError';
  readonly code: string;
  /**
   * The run's `stopReason`: `error` for a host that could not go on, or a
   * reason of its own, e.g. `wallet-provider-revoked` when the run's card
   * provider rejected its credential (wallet providers contract §5).
   */
  readonly stopReason: AgentStopReason;

  constructor(code: string, sentence: string, stopReason: AgentStopReason = 'error') {
    super(`${code}: ${sentence}`);
    this.code = code;
    this.stopReason = stopReason;
  }
}

/** Whether this throw means the browser is gone rather than the step was wrong. */
export function isBrowserLost(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isBrowserLost);
  }
  if (error instanceof Error) {
    return error.name === 'CdpClosedError' || BROWSER_LOST.test(error.message);
  }
  return typeof error === 'string' && BROWSER_LOST.test(error);
}

/**
 * The ways a HOST announces that one page's renderer will not stop long enough
 * to be frozen.
 *
 * A sibling of {@link isBrowserLost} and its exact opposite in consequence: the
 * browser is fine, the connection is open, every other target on it is
 * healthy, and this one page is executing script. `Outcrawl.lock` is answered
 * in the renderer — only it can set `VirtualTimePolicy::kPause` — so a busy
 * main thread HOLDS the command rather than refusing it, and the host's
 * `sendFreeze` bound (`FreezeNotAnsweredError`, 5 s) is what turns that into a
 * throw. See `docs/specs/2026-09-11-lock-is-held-by-a-busy-renderer.md`.
 *
 * Matched by name AND by message, on `isBrowserLost`'s own precedent: this
 * package opens no socket and cannot import the host's error class, and the
 * name alone would miss a raw CDP timeout on the same command.
 *
 * Deliberately NOT here: anything about a node, a reference or an action. A
 * step that was WRONG must never be read as a page that was BUSY, because one
 * is answered by the next prompt and the other by waiting.
 */
const RENDERER_BUSY =
  /was not answered by the renderer|was refused without being sent|cannot be frozen|outcrawl\.(lock|unlock) did not answer within/i;

/** Whether this throw means the page is busy rather than the step was wrong. */
export function isRendererBusy(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isRendererBusy);
  }
  if (error instanceof Error) {
    return error.name === 'FreezeNotAnsweredError' || RENDERER_BUSY.test(error.message);
  }
  return typeof error === 'string' && RENDERER_BUSY.test(error);
}

/**
 * The run's `error` when it ENDS on a page whose renderer would not answer a
 * freeze: {@link RunEndedError}'s shape, code first and a sentence naming what
 * to do, with the host's own sentence kept after it for whoever debugs it.
 *
 * The host's sentence alone was the customer's whole account until now:
 * `run_…` (production, 2026-10-01) ended `failed` with "Outcrawl.lock
 * was not answered by the renderer of https://ra.co/events/2311488 within
 * 5000ms. The command is handled in the renderer, ..." — a method name of
 * ours, no code, and nothing a caller can act on. Of the 7 production runs
 * that ended this way in the 7 days to 2026-10-01 11:52Z, all were internal.
 *
 * The sentence says only what was observed — the page stopped answering — and
 * not why: the host's "busy executing script" is not established. The same
 * hold was recorded on `about:blank` (3 runs, 2026-09-24), which runs none.
 */
export function pageUnresponsive(detail: string, steps: number): string {
  return (
    `page-unresponsive: the page stopped answering the browser through ${String(steps)} step(s) in a row, ` +
    'so the agent could neither read it nor act on it. Nothing in the task was wrong. Retry the run; if ' +
    'this site does it again, start the task from a different page or name another source for the same ' +
    `information. Detail: ${detail}`
  );
}

/**
 * Whether this throw is the host saying a freeze is still held behind the
 * tab's OWN navigation after its hold, and the page was left to load: the
 * worker's `StillLoadingError`. Not {@link isRendererBusy}: no renderer is
 * busy, nothing is refused on the next send, and the reply comes at the
 * commit — so the loop neither retries it inside the step (each retry would
 * be another full hold) nor charges it as a failed step, because nothing the
 * model chose went wrong. By name, on the precedent above: this package cannot
 * import the host's class.
 */
export function isStillLoading(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isStillLoading);
  }
  return error instanceof Error && error.name === 'StillLoadingError';
}


/* ------------------------------------------------------------------ *
 * Losing it again and again
 * ------------------------------------------------------------------ */

/**
 * How long a browser must survive, after a reacquisition, to count as
 * ordinary infrastructure churn rather than a page that is crashing
 * immediately again.
 *
 * Fifteen seconds is long enough to clear a navigation and a first read on
 * any real site — `NAVIGATE_COMMIT_BUDGET_MS`-class waits in
 * `@outcrawl/worker`'s `agent-deps.ts` are themselves single-digit seconds —
 * so an attempt that dies before this elapses never got far enough to have
 * done real work. It is short enough that a browser which merely takes its
 * time provisioning is not mistaken for one that is crashing: provisioning
 * happens before this clock starts, which is the next constant's whole
 * argument.
 *
 * ── WHY MEASURED FROM THE ATTEMPT AND NOT FROM THE LOSS ─────────────────────
 *
 * The question this constant answers is "did the browser get to do
 * anything", not "how long ago did the last one die" — a run idle for six
 * hours between two ordinary losses is not crashing, and a run that opens
 * three browsers in ninety seconds because the SAME page keeps dying on
 * step one is. {@link circuitShouldTrip} is therefore fed each attempt's OWN
 * elapsed time, `result.durationMs` (cumulative) minus the intent's
 * `used.elapsedMs` from before that attempt ran — the delta `supervise()`
 * already has on hand in `packages/worker/src/jobs.ts`, so nothing new has
 * to be carried on {@link RunIntent} for this to work, and a resume that
 * lands on a DIFFERENT worker starts the breaker fresh rather than carrying
 * a dead machine's bad luck onto a healthy one.
 */
export const RAPID_CRASH_THRESHOLD_MS = 15_000;

/**
 * Consecutive rapid crashes — see {@link RAPID_CRASH_THRESHOLD_MS} — before
 * {@link circuitShouldTrip} says stop.
 *
 * Three, on the same reasoning `MAX_REACQUISITIONS`' own doc gives for two: a
 * browser that dies once is disposable infrastructure; three in a row, EACH
 * within seconds of opening, is not the fleet being unlucky, it is a page (a
 * challenge wall triggering a crash, a site that kills the tab on detection,
 * a corrupt profile) that a fourth identical browser will not fix. Distinct
 * from `MAX_REACQUISITIONS`, which no longer bounds anything (a 7-day run
 * survives however many browsers it loses, deliberately) — this is the
 * mechanism that now does the job `MAX_REACQUISITIONS` used to: stopping the
 * fleet from being asked to provision an unbounded number of contexts for one
 * task that cannot use them.
 */
export const RAPID_CRASH_BREAKER_LIMIT = 3;

/**
 * Whether the last {@link RAPID_CRASH_BREAKER_LIMIT} browsers this run opened
 * ALL died within {@link RAPID_CRASH_THRESHOLD_MS} — the same page crashing
 * immediately again, not disposable infrastructure behaving as documented.
 *
 * Only the TAIL is read, deliberately: a run that crashed fast four times an
 * hour ago and has since been opening long-lived browsers has recovered
 * (a flaky exit that was swapped out, a transient site incident that
 * passed), and a breaker keyed off the whole history would refuse to let it
 * finish a task it is now doing fine on. `recentAttemptDurationsMs` is
 * expected to be exactly the reacquisition history in order — `supervise()`
 * appends one entry per browser lost — so "the last N" is "the N most recent
 * attempts", not a sample.
 *
 * Fewer than {@link RAPID_CRASH_BREAKER_LIMIT} entries never trips: a run
 * cannot be said to be crashing repeatedly on its first or second loss, and
 * those are exactly the ordinary-infrastructure case
 * {@link RAPID_CRASH_THRESHOLD_MS}'s own doc distinguishes from this.
 */
export function circuitShouldTrip(recentAttemptDurationsMs: readonly number[]): boolean {
  if (recentAttemptDurationsMs.length < RAPID_CRASH_BREAKER_LIMIT) {
    return false;
  }
  const tail = recentAttemptDurationsMs.slice(-RAPID_CRASH_BREAKER_LIMIT);
  return tail.every((ms) => ms < RAPID_CRASH_THRESHOLD_MS);
}

/**
 * How long to wait before opening the NEXT browser, given how many this run
 * has already lost (`RunIntent.reacquisitions`, 1 for the first loss).
 *
 * ── WHY A DELAY AT ALL, NOW THAT RE-ACQUISITION IS UNLIMITED ────────────────
 *
 * `supervise()` used to loop back into `attempt()` with no delay because
 * `MAX_REACQUISITIONS` bounded the damage a busy-loop could do to two extra
 * tries. Unlimited reacquisition removes that bound, so a run whose exit or
 * whose target site is having a bad minute would otherwise hammer both at
 * the fastest rate this process can open a `Target.createBrowserContext` —
 * which is also the fastest rate the fleet can be asked to hand out
 * contexts for a task that is not using any of them. The delay is what turns
 * "unlimited" into "patient" rather than "a tight loop with no exit".
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────
 *
 * Doubling from one second, capped at one minute: `1s, 2s, 4s, 8s, 16s, 32s,
 * 60s, 60s, ...`. A minute ceiling because `caps.duration` is what actually
 * bounds a stuck run now (see `MAX_REACQUISITIONS`'s own doc, which makes
 * this same argument for why two was "the sane bound rather than the real
 * one") — a longer wait would spend a customer's time ceiling on sleeping
 * instead of on the one thing that still has a chance of finishing the task,
 * another attempt. No jitter: each run's own `reacquisitions` count already
 * desynchronises it from every other run on the fleet, which do not share a
 * clock or a browser-loss instant to begin with.
 *
 * Pure and deterministic on purpose — see {@link RunIntent.reacquisitions}'s
 * own field, the only input this needs, and `packages/worker/src/jobs.ts`'s
 * `supervise()`, the only caller, which is what actually sleeps.
 */
export function reacquisitionBackoffMs(reacquisitions: number): number {
  const BASE_MS = 1_000;
  const CEILING_MS = 60_000;
  if (reacquisitions <= 0) {
    return 0;
  }
  const doubled = BASE_MS * 2 ** (reacquisitions - 1);
  return Math.min(CEILING_MS, doubled);
}
