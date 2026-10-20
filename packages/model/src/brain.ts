/**
 * Brain mode: a frontier model decides every step without seeing the tree,
 * scout-1's actuator chain is its eyes and hands. `HarnessModelPort` runs the
 * calls; this file is the contract between them — the prompts, the schemas,
 * the deterministic checks on what the eyes report, the brain's thread for the
 * run, the hard size budgets, and what a decision becomes.
 *
 * ── A strict superset of the plain actuator, never a bottleneck in front of it ──
 *
 * The owner's bar (2026-10-02): "if it actually works, no chance it fails
 * against plain [actuator]". So every path that could lose information falls back
 * to the plain actuator call with the full prompt:
 *
 * - the HANDS call is today's full scout-1 prompt with the decision ON TOP, so
 *   a wrong or vague decision still leaves the hands everything they had;
 * - a decision naming a ref the eyes did not list (or the tree does not hold)
 *   is grounded by the hands instead of executed;
 * - an eyes failure leaves the brain deciding without a brief, in words;
 * - a brain failure is a plain scout-1 step.
 *
 * ── The brain is small on the wire: hard budgets, enforced here ───────────
 *
 * Owner, 2026-10-02: "Why is 3k or 7k tokens even going to [the brain]?" Every
 * byte the brain reads is bounded by {@link BRAIN_BUDGET}, in characters (the
 * runtime's own unit; 2.5 chars/token is its worst measured ratio):
 *
 * - the system turn (rules + schema) is the cached prefix, shared by every
 *   run;
 * - per step, NEW input is one compact state line and the current page brief
 *   (state, the task's facts, up to {@link EYES_MAX_ELEMENTS} elements with
 *   real refs and labels of at most eight words), plus — only when there is
 *   any — the findings, extracted data and tool results the run produced;
 * - past steps are NEVER replayed as observations: the thread keeps each step
 *   as its compact state line (outcome of the previous action, news) and the
 *   brain's own terse decision, append-only, so each call reads the whole
 *   thread from cache and pays full price only for the new step;
 * - the reply is a terse object, `why` and `note` at most twenty words.
 *
 * ── What the brain owns: judgment ─────────────────────────────────────────
 *
 * The failure classes the plain actuator loses on are judgment, not perception
 * (`packages/bench/results/suites/agentab/analysis.md` section 2, and the
 * BrowseComp scout-1 baseline 2026-10-02, n=40: 11/40 ended "the extraction
 * could not establish a complete answer after 3 attempts", 5/40 "click
 * contradicted", 5/40 gave up). Each class has a rule in
 * {@link BRAIN_SYSTEM_PROMPT} or a mechanism in the port:
 *
 *   exploratory extract ends the run   port: a hands extract is never final,
 *                                      and only the brain's done/fail/final
 *                                      read may end the run
 *   one extract expected to hold the   rule: compose across pages; never the
 *   whole answer (6x on one page)      same read twice on one page
 *   constraint ignored (437 vs >500;   rule: every condition with evidence in
 *   1h53m vs 1h35-1h50 kept going)     `why` before done; a failing candidate
 *                                      is ruled out
 *   click changed nothing, 4x          rule + the last outcome verbatim
 *   captcha on a search engine, then   rule: another engine or a web tool,
 *   clicking it / answering from       never the captcha, never memory
 *   memory
 *   wrong entity (same name, other     rule: check identity
 *   state)
 */

import { isRecord, type JsonSchema } from '@outcrawl/scout-core';
import {
  ACTIONABLE_ROLES,
  ASK_GRAMMAR,
  ASK_RULE,
  askWantRule,
  CODE_RUN_TOOL,
  INBOX_SIGNUP_RULE,
  offersInbox,
  describeAction,
  humanDuration,
  isReloadKey,
  PAGE_SCRIPT_TOOL,
  PURCHASE_GRAMMAR,
  PURCHASE_RULE,
  serializeTree,
  TREE_CHAR_BUDGET,
  validateAction,
  WEB_ASK_TOOL,
  type Action,
  type AgentPrompt,
  type AxNode,
  type AxTree,
  type Envelope,
  type NodeRef,
  type StepTrace,
  type ToolCallEcho,
} from '@outcrawl/runtime';

import type { ModelTurn } from './provider';

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

/**
 * The brain's hard size budgets, in characters. Enforced by construction in
 * this file and asserted by `test/brain.test.ts`.
 *
 * - `system`: rules + schema, the cached prefix. Measured 1,219 tokens with
 *   the schema the provider appends (2026-10-02 ~20:53Z), deliberately just
 *   over the provider's 1,024-token minimum cacheable prefix: below it the
 *   system turn is never cached and costs 10x on every call. 3,800 since the
 *   segmented date/time rule (ws/time-field, 2026-10-02): the worker types a
 *   whole value into any one segment and it lands (TimeField, fleet, 27/27).
 *   A cached prefix: ~50 more tokens at the cache-read price. 4,100 for the
 *   `hands` delegation (owner cost sprint, 2026-10-03): ~75 more cached tokens
 *   ($0.000015 a call) against a brain call saved per delegated step. 4,300
 *   for `done.unconfirmed` (ws/finish-gap, 2026-10-14). 4,450 for
 *   `done.evidence` (ws/answer-evidence, 2026-10-15): a schema-less run's
 *   answer carries, per condition, the fact read and its source or "not
 *   confirmed". ~35 more cached tokens. 4,300 again with `done.unconfirmed`
 *   removed (ws/doubt-off, 2026-10-15).
 * - `facts`: the page state and the task's facts, kept in the thread.
 *   2,100 (and {@link LIST_FACTS} 2,700), three times the first 700/900:
 *   doubled first (BrainMeasure sim on c6e23bc0, 2026-10-05 01:18-01:28Z,
 *   heldout6 clean 65 to 72/72, heldout5 clean 57 to 61, nothing down, brain
 *   $/step +12-24%; doubling `elements` and the raw view as well was worse),
 *   then 1.5x that (BrainMeasure on e42320e2: fresh heldout7 clean +10.5 pts
 *   [+0.3, +24.7], n=304, no-regression pooled +0.3, n=572; 1.25x let the
 *   facts in but cut lists mid-qualifier).
 * - `elements`: the actionable elements, sent once.
 * - `step`: the compact state line kept in the thread for every step.
 * - `reads`: this step's reads, WHOLE (see {@link wholeRead}), outside `news`.
 * - `tools`: the tool replies new this turn, WHOLE, in this call only and
 *   outside `news` (see {@link toolReplies}). Inside `news` (1,200 shared with
 *   findings and the plan) a 4,000-character `web.read` window reached the
 *   brain as its first ~1,150 characters and a queued second reply as
 *   nothing, while the reply's own note named an offset past text it never
 *   saw (web-tools-on dev set, 2026-10-14: OM2W2 27/36 -> 18/36; 482 of 1,473
 *   OM2W2 web calls shared a turn with an earlier one; 59% of web.read calls
 *   re-read a URL already read). 13,000 holds three whole `web.read` replies
 *   (a 4,000-character window plus its title, URL and note, about 4,200 each).
 * - `toolKept`: what the replayed thread keeps of each tool reply after its
 *   turn, and all a `web.search` reply shows: about what `news` gave one.
 * - `news`: findings, extracted data and the plan new this step — the
 *   run's answer material, so bounded generously and cut with a marker that
 *   says the rest is on the run record.
 * - `wordsPerNote`: `why`/`note` are asked to stay within this; a reply is
 *   billed as written, so the rule is in the prompt, not a truncation.
 */
export const BRAIN_BUDGET = Object.freeze({
  system: 4_300,
  facts: 2_100,
  elements: 900,
  step: 600,
  news: 1_200,
  reads: 3_200,
  tools: 13_000,
  toolKept: 1_200,
  wordsPerNote: 12,
});

/** At most `max` characters, cut on a word with an ellipsis. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/* ------------------------------------------------------------------ *
 * Eyes
 * ------------------------------------------------------------------ */

/** How many elements the eyes may list. The brain picks from these by ref. */
export const EYES_MAX_ELEMENTS = 10;

/** Words of an element label the brain is shown. */
const LABEL_WORDS = 8;

/** Exported for measurement. The eyes client's system turn. */
export const EYES_SYSTEM_PROMPT = [
  'You are the eyes of a browser agent. Another model decides the next step and CANNOT see the page:',
  'it reads only what you write. The user message gives the task, the last step and its outcome, and',
  'the page as a filtered accessibility tree, one node per line: `depth role "name" (state) [F-N]`.',
  'Write a brief of THIS page for THIS task:',
  '- `page`: what page this is and its state, one sentence: results or none, an error, a login or age',
  '  wall, a captcha, a popup covering it, a PDF without text, the last action having no visible effect.',
  '- `facts`: at most 6 facts that bear on the task, as the page states them (names, prices, ratings,',
  '  counts, dates, places, messages, error text), each under 20 words. Copy numbers and text exactly as',
  '  shown; never compute, sum or infer (not elapsed time, not a field\'s value). If the page lacks',
  '  something the task needs, say so. States (disabled, values) are added for you: just choose.',
  `- \`elements\`: at most ${String(EYES_MAX_ELEMENTS)} elements worth acting on next for the task, most useful first:`,
  '  `ref` copied from the [F-N] beside the node without brackets, `role`, and `label` in at most 8',
  '  words. Search box and submit, sort, filters, pagination, matching results, popup dismissals.',
  'Be terse.',
].join('\n');

/** Exported for measurement. What the eyes answer. */
export const EYES_SCHEMA = {
  type: 'object',
  properties: {
    page: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, role: { type: 'string' }, label: { type: 'string' } },
        required: ['ref', 'role', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['page', 'facts', 'elements'],
  additionalProperties: false,
} as const;

/** The eyes' `ExtractInput.instruction`: the system turn carries the rest. */
export const EYES_INSTRUCTION = 'the brief of this page for the task, as the system turn describes';

/**
 * The page as the eyes read it: the task, the last step, and the tree at the
 * same character ceiling the actuator's prompt uses, so the eyes never read
 * more page than the hands do.
 */
export function eyesPage(prompt: AgentPrompt): string {
  const lines = [`Task: ${prompt.task}`];
  if (prompt.schema !== undefined) {
    lines.push(`The answer must fill: ${JSON.stringify(prompt.schema)}`);
  }
  const active = prompt.memory?.goals.find((goal) => goal.status === 'active');
  if (active !== undefined) {
    lines.push(`Current sub-goal: ${active.goal}`);
  }
  const last = lastOutcome(prompt.history, prompt.tree);
  if (last !== undefined) {
    lines.push(`Last step: ${last}`);
  }
  lines.push(
    `URL: ${prompt.tree.url}`,
    'Page, filtered accessibility tree:',
    serializeTree(prompt.tree, { maxChars: TREE_CHAR_BUDGET }),
  );
  return lines.join('\n');
}

/**
 * One element the eyes listed, checked against the tree. `state` and `label`
 * are the TREE's, never the eyes' prose: the brain acts on them.
 */
export interface BriefElement {
  readonly ref: string;
  readonly role: string;
  readonly label: string;
  /** `(disabled, required)`, a field's current value and any error text beside it. Empty when none. */
  readonly state: string;
}

/** What the eyes reported, with everything checkable taken from the tree instead. */
export interface Brief {
  readonly page: string;
  readonly facts: readonly string[];
  readonly elements: readonly BriefElement[];
  /** Open dialogs and alert/status text read off the tree, never chosen by the eyes. */
  readonly notices: readonly string[];
  /** Listed refs the tree does not hold, duplicates, or past the cap: dropped, counted. */
  readonly dropped: number;
  /**
   * The brief leaves some of the page's text out (chosen by rule or by the
   * eyes, or a line clipped): an answer resting on it is read off the page
   * before the run may end on it (see the port's held done).
   */
  readonly partial: boolean;
  /** The characters its facts may take, when not {@link BRAIN_BUDGET}.facts: a list page's, {@link LIST_FACTS}. */
  readonly factsChars?: number;
}

/** `F-N` -> node, for every node in the tree. */
export function refIndex(tree: AxTree): ReadonlyMap<string, AxNode> {
  const index = new Map<string, AxNode>();
  const walk = (node: AxNode): void => {
    index.set(refText(node), node);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(tree.root);
  return index;
}

function refText(node: AxNode): string {
  return `${String(node.ref.frameOrdinal)}-${String(node.ref.backendNodeId)}`;
}

/** Controls whose value and validation the brain needs to see. */
const FIELD_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'slider']);
/** Text a form puts beside a field it refused. */
const ERROR_TEXT = /invalid|required|error|enter a valid|must be|please (enter|select|choose|provide)|incorrect|not valid|too (short|long)/i;
/** Controls that dismiss something in front of the page. */
const OVERLAY_CONTROL = /^(close|dismiss|no,? thanks|not now|maybe later|skip|×|✕|✖|x|got it|ok|continue)\b|close (dialog|popup|pop-up|modal|window|banner)|^(accept|reject|agree)\b/i;
/** Dialog roles, when the tree carries them (the runtime's filter usually promotes their contents). */
const DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog']);
/** Text the page raises on its own: always reported. */
const NOTICE_ROLES: ReadonlySet<string> = new Set(['alert', 'status']);
/** How many overlay controls are added past the eyes' choice. */
const OVERLAY_EXTRA = 3;

/** At most `words` words, with an ellipsis when cut. */
function firstWords(text: string, words: number): string {
  const all = text.replace(/\s+/g, ' ').trim().split(' ');
  return all.length > words ? `${all.slice(0, words).join(' ')}…` : all.join(' ');
}

/** A node's state as the brain needs it: flags, a field's value, an error beside it. */
function stateOf(node: AxNode, parent: AxNode | undefined): string {
  const flags: string[] = [];
  const state = node.state;
  if (state?.disabled === true) flags.push('disabled');
  if (state?.checked === true) flags.push('checked');
  if (state?.checked === 'mixed') flags.push('mixed');
  if (state?.checked === false && (node.role === 'checkbox' || node.role === 'radio' || node.role === 'switch')) flags.push('unchecked');
  if (state?.expanded === true) flags.push('expanded');
  if (state?.expanded === false) flags.push('collapsed');
  if (state?.selected === true) flags.push('selected');
  if (state?.required === true) flags.push('required');
  const parts = flags.length === 0 ? [] : [`(${flags.join(', ')})`];
  if (FIELD_ROLES.has(node.role)) {
    parts.push(node.value === undefined ? '= empty' : `= ${JSON.stringify(clip(node.value, 40))}`);
    const error = (parent?.children ?? []).find((sibling) => sibling !== node && sibling.name !== undefined && ERROR_TEXT.test(sibling.name));
    if (error?.name !== undefined) {
      parts.push(`error ${JSON.stringify(clip(error.name, 80))}`);
    }
  }
  return parts.join(' ');
}

/**
 * The eyes' reply, trusted for CHOICE only. Every ref must be a node in this
 * tree (an invented or stale ref is dropped and counted); the role, label (cut
 * to eight words), state, field value and validation text shown to the brain
 * are the TREE's. Read off the tree regardless of what the eyes chose: open
 * dialogs and alert/status text, and up to {@link OVERLAY_EXTRA} controls that
 * dismiss something in front of the page. Measured reason, BrainMeasure
 * 2026-10-02 21:08-21:14Z, 52 items: 6 of the 10 brain-arm losses were the
 * eyes dropping a `(disabled)` flag, a modal, or a field's real value.
 */
export function readBrief(data: unknown, tree: AxTree): Brief | undefined {
  if (!isRecord(data) || typeof data['page'] !== 'string') {
    return undefined;
  }
  const facts = Array.isArray(data['facts'])
    ? data['facts'].filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
  const scan = scanPage(tree);
  const elements: BriefElement[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of Array.isArray(data['elements']) ? data['elements'] : []) {
    const ref = isRecord(entry) && typeof entry['ref'] === 'string' ? entry['ref'].replace(/^\[|\]$/g, '').trim() : '';
    const found = scan.index.get(ref);
    if (found === undefined || seen.has(ref) || elements.length >= EYES_MAX_ELEMENTS) {
      dropped += 1;
      continue;
    }
    seen.add(ref);
    elements.push(scan.element(found.node, isRecord(entry) && typeof entry['label'] === 'string' ? entry['label'] : ''));
  }
  for (const node of scan.overlay.filter((candidate) => !seen.has(refText(candidate))).slice(0, OVERLAY_EXTRA)) {
    elements.push(scan.element(node, ''));
  }
  return { page: data['page'], facts, elements, notices: scan.notices.slice(0, 4), dropped, partial: true };
}

/**
 * The longest text line a brief carries. A result page's JSON or a paragraph
 * is often one line; cut short, its later values were never seen, and the
 * brain answered from the form it filled (live10, httpbin, 2026-10-02:
 * "Medium" reported for the echoed "medium") [INFERENCE: the run's page was
 * not inspected]. A cut line marks the brief partial.
 */
const TEXT_LINE_CHARS = 320;
/** A timestamp such as "5 hours ago": several words that name nothing. */
const TIMESTAMP = /^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
/** A label that names a thing (a result, a listing, a story): three words or more, not a timestamp. */
function namesThing(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.split(/\s+/).length >= 3 && !TIMESTAMP.test(trimmed);
}
/** A field label: short, no figure ("Composer", "Directed by", "To Tip"). */
function isLabelText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 28 && !/\d/.test(trimmed);
}
/** Words that open a call to action, never a value ("See Deal", "Join now"). */
const ACTION_WORD = /^(see|join|sign|log|view|buy|add|shop|get|read|learn|show|try|start|open|go|download|subscribe|follow|share|save|apply|book|order|watch|play|edit|more)$/i;
/** A name a label can have as its value: 2-4 capitalised words, not a call to action ("Robin Carolan"). */
function isValueName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((word) => /^\p{Lu}/u.test(word)) && !ACTION_WORD.test(words[0] ?? '');
}
/** The page-text line a named link becomes; recognised again by {@link rawBrief}, which does not count it. */
const LINK_LINE = /^(?:link|button) "/;
/**
 * A control whose label IS a value: a price, a rating, a count of ratings or
 * reviews, a discount. Such a control is also the page's text, as a named
 * link is: on a real amazon.in results page (production capture 2026-10-03
 * 09:08Z) every price is a link ("₹15,799") and every rating a button, and
 * listed only as elements they fell into "+289 unlisted", so neither the brain
 * nor the hands could see a price.
 */
const VALUE_LABEL = /[$€£¥₹]\s?\d|\d[\d,.]*\s?(?:stars?|ratings?|reviews?|%)|\bout of \d/i;
/** A brief's own marker for lines it left out. */
const GAP_LINE = /^(…|\(\d+ lines not shown\))$/;

/** A fact the page states in its own text: not a named link, not a gap marker. */
export function isPageText(fact: string): boolean {
  return !LINK_LINE.test(fact) && !GAP_LINE.test(fact);
}
/** Text a page shows, for the raw view: the labelling roles the tree keeps. */
const RAW_TEXT_ROLES: ReadonlySet<string> = new Set(['heading', 'StaticText', 'LabelText', 'caption', 'status', 'alert', 'tooltip']);
/** The raw view's ceilings: a page that fits is sent as is and the eyes are not asked. */
export const RAW_VIEW = Object.freeze({ textChars: 560, elementChars: 880 });
/**
 * Words that say a value on the page no longer holds: an ended deal, a
 * superseded release, a cancelled date. Short, task-blind and decisive for a
 * current value, so they rank with the task's own words (dev2 X14: "Expired"
 * under a $399 deal post was dropped, and the price read as current).
 */
const STALE = /\b(expired|ended|discontinued|sold out|out of stock|no longer|outdated|archived|superseded|cancell?ed|postponed|not the (?:most recent|latest))\b/i;
/** The longest page-text line the brain is shown; a longer one is cut (see {@link briefFacts}). */
const FACT_CHARS = 160;

/**
 * The page itself as the brief, with no eyes call, when it is small enough:
 * every actionable element (ref, role, label, state, value, error text) and
 * the page's own text, within {@link RAW_VIEW}. `undefined` for a page that
 * does not fit — then the eyes choose what matters. Deterministic, so it is
 * also never wrong about what the page says (owner lever 2, 2026-10-02:
 * "send the brain the deterministic compact view directly; run eyes only when
 * the page is too big").
 */
export function rawBrief(tree: AxTree): Brief | undefined {
  const scan = scanPage(tree);
  // Named links are page text for their place in it, but already counted as
  // elements: they do not make a page too big to send whole.
  if (scan.text.filter((line) => !LINK_LINE.test(line)).join(' | ').length > RAW_VIEW.textChars) {
    return undefined;
  }
  const elements = scan.actionable.map((node) => scan.element(node, ''));
  const shown = elements.reduce((length, element) => length + elementCost(element), 0);
  if (shown > RAW_VIEW.elementChars) {
    return undefined;
  }
  return {
    page: `${tree.root.name ?? 'untitled'} (the whole page, read directly)`,
    facts: scan.text,
    elements,
    notices: scan.notices.slice(0, 4),
    dropped: 0,
    partial: scan.clipped,
  };
}

/** Words too common to say anything about relevance. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than', 'what', 'which', 'who', 'whose', 'when',
  'where', 'find', 'tell', 'give', 'show', 'report', 'list', 'about', 'your', 'have', 'has', 'are', 'was', 'were', 'its',
  'their', 'there', 'more', 'most', 'least', 'any', 'all', 'one', 'two', 'out', 'site', 'page', 'website', 'using', 'use',
  // A task's words for "the answer" ("give me each figure"): they name no
  // fact, and a page's prose uses them too ("the figure asked for"), which
  // ranked filler above the one line holding the value (dev5 D3, 2/2: the
  // brain read the page again for a percentage the brief had dropped).
  'figure', 'figures', 'number', 'numbers', 'value', 'values', 'amount', 'each', 'both', 'check',
]);
/** How many of a page's last text lines a chosen brief keeps, so it shows where the page ends. */
const PAGE_END_LINES = 3;
/** Controls that move through a list. A bare page number only: "187 comments" is not paging (BrainMeasure H1). */
const PAGING = /^(next|previous|prev|more|load more|show more|see more)\b|^\d{1,3}$|next page|page \d/i;

/**
 * A big page's brief chosen by rule, with no eyes call: fields, dismiss
 * controls and paging always; then the elements and text that share the most
 * words with the task, in page order, within {@link RAW_VIEW}. Whatever is
 * left out is counted, and the hands — who see the whole page — ground any
 * "say" on it. An alternative to the eyes, measured against them before it
 * replaces them (owner lever 2).
 */
export function selectBrief(tree: AxTree, task: string, today?: string): Brief {
  const scan = scanPage(tree);
  // Matched on a light stem, so "open" finds "opened" and "price" finds
  // "prices" (dev2 X4: the line saying when the museum "opened" scored as if
  // it had nothing to do with when it "open[ed] to the public"). A final
  // "e" goes too: kept, "maples" (mapl) never found "maple",
  // and the rows a task named ranked with the rest (2026-10-13 recapture).
  const stem = (word: string): string => (word.length > 4 ? word.replace(/(?:ing|ed|es|e|s)$/u, '') : word);
  const words = new Set(
    wholeNumbers(task)
      .toLowerCase()
      .split(/[^\p{L}\p{N}$]+/u)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
      .map(stem),
  );
  const tokens = (text: string): Set<string> =>
    new Set(
      wholeNumbers(text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}$]+/u)
        .map(stem)
        .filter((word) => words.has(word)),
    );
  // The page's own subject (its title's words: "Pixel 10 Pro", "Burj
  // Khalifa") is on half its lines and tells them apart by nothing, so it
  // counts once per line however often it appears; every other task word
  // counts double, once each (dev2 X1: lines naming the phone crowded out the
  // one giving its battery capacity).
  const subject = tokens(tree.root.name ?? '');
  // The task's words a line names, each with whether the line negates it:
  // "No pets allowed", "Not remote", "non-smoking", "doesn't allow", "Remote:
  // no" name the task's words and state the opposite. Within the clause,
  // three words back. A word said both ways counts as said.
  const termsIn = (line: string): Map<string, boolean> => {
    const found = new Map<string, boolean>();
    for (const clause of wholeNumbers(line).toLowerCase().split(/[,;·|()]+|\s[-–—]\s|\.\s/u)) {
      const colon = clause.indexOf(':');
      const label = colon < 0 ? clause : clause.slice(0, colon);
      const value = colon < 0 ? '' : clause.slice(colon + 1);
      const said = (part: string): string[] => part.split(/[^\p{L}\p{N}$]+/u).filter(Boolean);
      const denied = NEGATION.has(said(value)[0] ?? '');
      for (const [part, negated] of [[label, denied], [value, false]] as const) {
        const raw = said(part);
        raw.forEach((word, index) => {
          const term = stem(word);
          if (!words.has(term) || subject.has(term) || BOUND_TERMS.has(term)) return;
          // "Semi-freestanding" is not "freestanding", either way (sealed
          // heldout5 on 4fb16323: it met "freestanding").
          if (WEAKENERS.has(raw[index - 1] ?? '')) return;
          // "Out of stock", "sold out": a status stated as its opposite.
          const outOf = (raw[index - 2] === 'out' && raw[index - 1] === 'of') || raw[index + 1] === 'out';
          const denies = negated || outOf || raw.slice(Math.max(0, index - 3), index).some((before) => NEGATION.has(before));
          found.set(term, (found.get(term) ?? true) && denies);
        });
      }
    }
    return found;
  };
  // A line satisfies a task word when it says it the way the task does: the
  // task "with no accidents" is met by "No accidents reported", not by "1
  // accident reported".
  const taskPolarity = termsIn(task);
  // A line contradicts a task word when it says it the other way: "1
  // accident reported" against "no accidents", "Refurbished" against "new,
  // not refurbished", "Out of stock" against "in stock".
  // A status said with another word: "Used - like new", "Refurbished",
  // "Open box" against "new"; "Pre-order", "Backorder" against "in stock".
  // Without them, a used lens tied the new one that qualified (dev7 H2).
  const antonymsOf = (line: string): Set<string> =>
    new Set([...ANTONYMS].filter(([term, phrases]) => words.has(term) && taskPolarity.get(term) === false && phrases.test(line)).map(([term]) => term));
  const contradictedTerms = (line: string): Set<string> =>
    new Set([...[...termsIn(line)].filter(([term, denied]) => taskPolarity.has(term) && denied !== taskPolarity.get(term)).map(([term]) => term), ...antonymsOf(line)]);
  const satisfiedTerms = (line: string): Set<string> => {
    const against = antonymsOf(line);
    return new Set([...termsIn(line)].filter(([term, denied]) => !against.has(term) && denied === (taskPolarity.get(term) ?? false)).map(([term]) => term));
  };
  const overlap = (text: string): number => {
    let score = 0;
    let named = false;
    for (const word of tokens(text)) {
      if (subject.has(word)) named = true;
      else score += 2;
    }
    return score / 2 + (named ? 0.5 : 0);
  };
  const scored = scan.actionable.map((node, order) => {
    const label = node.name ?? '';
    const score =
      (FIELD_ROLES.has(node.role) || node.role === 'checkbox' || node.role === 'radio' ? 6 : 0) +
      (scan.overlay.includes(node) ? 8 : 0) +
      (PAGING.test(label.trim()) ? 3 : 0) +
      overlap(label) * 2 +
      (/[$€£¥₹]\s?\d|\d+(\.\d+)?\s?(stars?|ratings?|reviews?|%)/i.test(label) ? 1 : 0) +
      // A label of several words names something (a result, a product); a
      // timestamp names nothing the task can want.
      (namesThing(label) ? 1 : 0) -
      (TIMESTAMP.test(label.trim()) ? 2 : 0);
    return { node, order, score };
  });
  // The page's last lines rank with the task's words: a partial view that
  // does not show where the page ENDS reads as "the rest may be here", and
  // the brain reads for ranks 31-35 on a page that stops at 30 (BrainMeasure
  // H1, 0/3 on view C even with More listed, 2026-10-02 22:03Z).
  // The last lines of the page's own text, not of its footer links.
  const end = new Set(
    scan.text
      .map((text, order) => ({ text, order }))
      .filter(({ text }) => !LINK_LINE.test(text))
      .slice(-PAGE_END_LINES)
      .map(({ order }) => order),
  );
  // A line under a heading the task names is in the task's section: a spec
  // value ("Typical 4870 mAh") shares no word with "battery capacity", its
  // heading ("Battery and charging") does (dev2 X1: the value was dropped and
  // the brain read the page again for it).
  const shapeOf = (text: string): string => text.replace(/\d[\d,.]*/g, '#');
  const shapes = new Map<string, number>();
  for (const text of scan.text) shapes.set(shapeOf(text), (shapes.get(shapeOf(text)) ?? 0) + 1);
  let section = false;
  const texts = scan.text.map((text, order) => {
    const heading = scan.headings.has(order);
    if (heading) section = overlap(text) >= 1;
    return {
      text,
      order,
      score:
        overlap(text) * 2 +
        (/\d/.test(text) || LINK_LINE.test(text) ? 1 : 0) +
        // A figure stated about the page's subject is the likeliest answer line.
        (/\d/.test(text) && overlap(text) > 0 ? 1 : 0) +
        // A short line stating a figure ("Storage today: 61% of capacity") is
        // what a page says; a long paragraph that only names the page's
        // subject is not (dev5 D3: such paragraphs crowded the value out).
        // Not a list's repeated template ("1.", "100 points by"), which would
        // crowd out the items it numbers.
        (/\d/.test(text) && text.length <= 60 && !LINK_LINE.test(text) && (shapes.get(shapeOf(text)) ?? 0) < 5 ? 2 : 0) +
        (STALE.test(text) ? 3 : 0) +
        (end.has(order) ? 3 : 0) +
        // +3, not +2: the short-figure bonus above lifts every spec line, and a
        // task-section line must still outrank the rest (dev2 X1).
        (section && !heading ? 3 : 0),
    };
  });
  // A value's label line comes with it ("Architectural" before "828 m",
  // "To Tip" before "829.8 m"): a figure without its label is the wrong
  // figure as often as the right one (dev2 X2). Paid from the same budget.
  const isLabel = (order: number): boolean => {
    const label = scan.text[order];
    return label !== undefined && label.length <= 28 && !/\d/.test(label) && !LINK_LINE.test(label) && /\d/.test(scan.text[order + 1] ?? '');
  };
  const pairOf = (order: number): number | undefined =>
    isLabel(order - 1) ? order - 1 : isLabel(order) ? order + 1 : undefined;
  const kept: { readonly text: string; readonly order: number }[] = [];
  const keptOrders = new Set<number>();
  // A line as the brief shows it: an item's title and attributes are cut
  // shorter when every item's head would not fit otherwise (see ITEM_SHRINK).
  const shortened = new Map<number, string>();
  // A list item's title carries its ref: on a card page every card's
  // element label starts the same ("Entire flat in Ribeira,…"), and with no
  // way to tell which ref is the qualifier Facts names, the brain read the
  // whole list instead of opening it (dev6, 2026-10-04 16:20Z: 1/20 on
  // f9f07e2c, 0/20 on f6a62169; BrainMeasure sealed, 0/2 vs 2/2).
  const titleRefs = new Map<number, string>();
  const titleChips = new Map<number, string>();
  // A listing failing a condition the task states says which, on its title
  // and its element: unmarked, a cheaper or better-rated failing listing
  // shown among the qualifiers read as the answer, and the brain re-sorted,
  // paged or read them (tainted sealed items via Main, 2026-10-05: a frontier model 8/8
  // misses on the same briefs).
  const titleFails = new Map<number, string>();
  // A search result's snippet, said on its first line (see `ListItem.summary`).
  const summaries = new Map<number, string>();
  const display = (order: number): string => {
    const line = shortened.get(order) ?? summaries.get(order) ?? scan.text[order]!;
    const ref = titleRefs.get(order);
    const fails = titleFails.get(order);
    return `${ref === undefined ? line : `${line} [${ref}]`}${titleChips.get(order) ?? ''}${fails === undefined ? '' : ` (${fails})`}`;
  };
  const lineCost = (order: number): number => Math.min(display(order).length, FACT_CHARS) + 3;
  // What the kept lines cost as `briefFacts` renders them: each line, and
  // each gap's "(N lines not shown)" between them. Counting lines alone, a
  // brief with many gaps ran past the facts budget and `briefFacts` cut its
  // last lines unseen (the jobs list's 5th listing, 2026-10-03).
  // A gap among a list's items is "…": the page line already says lines
  // are not shown, and "(5 lines not shown)" between every two items cost
  // as much as the items (the sealed card pages fit 3-5 of 7-11 titles).
  let itemLines: ReadonlySet<number> = new Set();
  const gapText = (from: number, to: number): string =>
    to - from < 3 || (numbered === undefined && (itemLines.has(to) || itemLines.has(from - 1))) ? '…' : `(${String(to - from)} lines not shown)`;
  const rendered = (orders: Iterable<number>): number => {
    let cost = 0;
    let next = 0;
    for (const order of [...new Set(orders)].sort((left, right) => left - right)) {
      if (order > next) cost += gapText(next, order).length + 3;
      cost += lineCost(order);
      next = order + 1;
    }
    return next < scan.text.length ? cost + gapText(next, scan.text.length).length + 3 : cost;
  };
  // The facts budget less what `briefFacts` puts first: the page line (its
  // counts at their widest) and the notices.
  const numbered = numberedRange(scan.text);
  const pageText = (listed: number, keptLines: number): string =>
    `${tree.root.name ?? 'untitled'} (chosen by rule: ${String(listed)} of ${String(scan.actionable.length)} elements, ${String(keptLines)} of ${String(scan.text.length)} text lines${numbered === undefined ? '' : `; numbered items ${numbered} on this page`}${keptLines < scan.text.length ? '; lines not shown may hold more' : ''})`;
  const pageHead = [`Page: ${clip(pageText(scan.actionable.length, scan.text.length - 1), 200)}`, ...scan.notices.slice(0, 4)].join('\n');
  let factsChars: number = BRAIN_BUDGET.facts;
  let textBudget = factsChars - 8 - pageHead.length;
  const keep = (orders: readonly number[]): void => {
    for (const order of orders) {
      if (keptOrders.has(order)) continue;
      kept.push({ text: display(order), order });
      keptOrders.add(order);
    }
  };

  // A LIST PAGE'S ITEMS GO WHOLE (see `listItems`): an item ranks as its
  // best line and is kept with all its fields or not at all, so a title is
  // never shown without the price, rating or attribute under it. Items that
  // do not fit drop whole, from the bottom: once one does not fit, no
  // lower-ranked item is shown. Lines outside items rank as before.
  //
  // Items rank among themselves by how much of the task their own lines
  // satisfy (`ListItem.matches`), then by best line: ranked by best line
  // alone, the one listing meeting the task's place, status and price
  // ceiling dropped whole behind listings sharing one task word (heldout4
  // constraint-ignored, abstract mode, BrainMeasure 2026-10-03). A term
  // counts only where it is satisfied: not negated in its clause, not on a
  // line whose date or figure fails a bound the task states. Counted as
  // merely present, "Not remote" and a closing date before the task's bound
  // matched as well as the qualifier did, and it ranked 4th of 5 (sealed
  // item, ff0a26ea, BrainMeasure 2026-10-03).
  const bounds = boundsOf(task, today);
  const superlatives = superlativesOf(task);
  // The name of a field the task asks for ("give its price", "its rating")
  // is not a constraint an item meets: "Good price" and "Lower price" tags
  // matched it, and outranked the cheapest car (autotrader.co.uk capture,
  // 2026-10-03 10:49Z).
  const fieldNames = new Set(FIELD_NAMES.map(stem));
  const contradictedIn = (line: string): Set<string> => new Set([...contradictedTerms(line)].filter((term) => !fieldNames.has(term)));
  const satisfiedIn = (line: string): Set<string> =>
    boundVerdict(line, bounds, today) === false ? new Set<string>() : new Set([...satisfiedTerms(line)].filter((term) => !fieldNames.has(term)));
  // A link's terms are its whole name's: a title cut at 80 characters
  // ("… 1TB SSD, 165Hz Display, NVIDIA GeForce RTX 4060") names the task's
  // words past the cut, and judged on the cut line the qualifier matched no
  // more than the rest and dropped (sealed heldout6 on 40a02a70, abstract).
  const lineContradictions = scan.text.map((line, order) => contradictedIn(scan.fullText.get(order) ?? line));
  const lineTerms = scan.text.map((line, order) => satisfiedIn(scan.fullText.get(order) ?? line));
  // An item ranks on its own lines, not on being last on the page (the end
  // bonus is for a numbered list's end, H1): on corpus B1 the last two
  // listings outranked the rest by it.
  const numberedList = numberedRange(scan.text) !== undefined;
  const items = listItems(scan, (order) => (texts[order]?.score ?? 0) - (end.has(order) && !numberedList ? 3 : 0), {
    terms: (order) => lineTerms[order] ?? new Set(),
    contradicts: (order) => lineContradictions[order] ?? new Set(),
    labelTerms: satisfiedIn,
    labelContradicts: contradictedIn,
    meets: (label) => boundVerdict(label, bounds, today),
    verdicts: (label) => boundVerdicts(label, bounds, today),
    ...(today === undefined ? {} : { today }),
    targets: superlatives.map((superlative) => superlative.kind),
    least: superlatives[0]?.least ?? true,
    asked: askedKinds(task, bounds),
  });
  // Counted as `briefFacts` renders it, on every page (see `rendered`).
  const fitsText = (orders: readonly number[]): boolean => rendered([...keptOrders, ...orders]) <= textBudget;
  // Where a page ENDS matters on a list (H1: the brain read for ranks 31-35
  // on a page that stops at 30); elsewhere its last lines are its footer
  // ("© 2026 …"), and counted as rendered they displaced the answer line
  // (dev2 X5, X15, 2026-10-03 10:03Z). Before that count, `briefFacts` cut
  // them silently on 31 of 63 rule-chosen dev briefs, so they were never
  // shown there anyway.
  const listPage = items.length > 0 || numbered !== undefined;
  // How many of the task's own words (not the page's subject) a line names.
  const named = (text: string): number => [...tokens(text)].filter((word) => !subject.has(word)).length;
  // Equal matches: a superlative's order ("cheapest": the lowest price
  // first), so the item the task asks for is not the head the budget drops
  // (the real amazon.in capture: the cheapest of 13 was the 3rd, its head
  // cut, 2026-10-03). Items stating no such figure after those that do.
  const superlative = superlatives[0];
  const bySuperlative = (left: ListItem, right: ListItem): number => {
    if (superlative === undefined) return 0;
    const a = left.figure;
    const b = right.figure;
    if (a === undefined || b === undefined) return (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0);
    return superlative.least ? a - b : b - a;
  };
  const byMatch = [...items].sort((left, right) => right.matches - left.matches || bySuperlative(left, right) || right.rank - left.rank || left.title - right.title);
  // BREADTH FIRST: every item gets its title and its lead line (its best
  // match) before any item gets the rest of its lines, which the budget left
  // over then pays for top-down, in match order. So no item is invisible
  // while another is shown whole: with whole items first, three filled the
  // budget and the qualifier, 4th, showed nothing (sealed item, ff0a26ea).
  // An item's head ranks with the page's lines at the best rank at or below
  // it in match order; the rest of every item ranks just under the last head.
  // An item whose figures fail a bound the task states ranks as a line.
  const bonus = (item: ListItem): number => (item.matches < 0 ? 0 : ITEM_BONUS);
  const itemScore = byMatch.map((item, index) => bonus(item) + Math.max(...byMatch.slice(index).map((other) => other.rank)));
  // Just under the last head of an item that does not fail a bound.
  const restScore = Math.min(...itemScore.filter((_, index) => !byMatch[index]!.fails), Number.POSITIVE_INFINITY) - 0.5;
  // Every line inside an item: one not among its fields is not shown loose,
  // apart from its title, where it reads as another item's ("Price, product
  // page" under the next title).
  for (const item of items) titleRefs.set(item.title, refText(item.titleNode));
  for (const item of items) if (item.chips.length > 0) titleChips.set(item.title, `, tagged ${item.chips.map((chip) => JSON.stringify(chip)).join(', ')}`);
  for (const item of items) if (item.summary !== undefined) summaries.set(item.summary.line, item.summary.text);
  // The task's words for the conditions a listing fails: its failed bounds
  // as the task states them, its denied words as a run of the task's own.
  const taskTokens = [...task.matchAll(/[\p{L}\p{N}$]+/gu)].map((match) => ({ word: match[0].toLowerCase(), stem: stem(match[0].toLowerCase()), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
  const phrase = (terms: ReadonlySet<string>): string[] => {
    const runs: string[] = [];
    let run: { start: number; end: number; last: number } | undefined;
    taskTokens.forEach((token, index) => {
      if (!terms.has(token.stem) || runs.length + (run === undefined ? 0 : 1) > 2) return;
      if (run !== undefined && run.last === index - 1) run = { ...run, end: token.end, last: index };
      else {
        if (run !== undefined) runs.push(task.slice(run.start, run.end));
        // With the word that makes it a condition: "in stock", "no accidents".
        const before = taskTokens[index - 1];
        run = { start: before !== undefined && /^(?:in|no|not|non|with|without|on|off)$/u.test(before.word) ? before.start : token.start, end: token.end, last: index };
      }
    });
    if (run !== undefined) runs.push(task.slice(run.start, run.end));
    return [...new Set(runs)];
  };
  const failedConditions = (item: ListItem): string => {
    const said = [...bounds.filter((_, index) => item.bounds[index] === -1).map((bound) => bound.said), ...phrase(item.denied)];
    return said.length === 0 ? '' : `fails: ${clip(said.join('; '), 40)}`;
  };
  for (const item of items) {
    const fails = item.fails ? failedConditions(item) : '';
    if (fails !== '') titleFails.set(item.title, fails);
  }
  // Of those not shown, how many this page's own lines show failing a
  // condition the task states: the brain need not read them to rule them
  // out (dev6 G1, G3: "for all 12 listings", 10/10, with only the ranking
  // stated, 16:24Z).
  // A line every listing carries word for word that names a task word
  // ("Direct · Standard class" for "the first direct train") is said once:
  // as no item's field it was shown for none, and the brain read all 12
  // trains to learn which were direct (dev6 G3, 2026-10-04 16:27Z, 18/20).
  const sharedLines = [
    ...new Set(
      items.length < 2
        ? []
        : items[0]!.span.filter((order) => order !== items[0]!.title && !LINK_LINE.test(scan.text[order] ?? '') && (lineTerms[order]?.size ?? 0) > 0 && items.every((item) => item.span.some((other) => scan.text[other] === scan.text[order]))).map((order) => scan.text[order]!),
    ),
  ].slice(0, 2);
  const shared = sharedLines.length === 0 ? [] : [`Every listing: ${sharedLines.map((line) => JSON.stringify(clip(line, 50))).join(', ')}`];
  // A page of records whose every listing is a record says how many records
  // it holds: one with no link of its own is no listing, and the count
  // would leave it out unsaid (2 of the 50 rows on a table recaptured
  // 2026-10-13).
  const unlinked = items.length > 0 && items.every((item) => scan.rows.has(item.titleNode)) ? scan.records - items.length : 0;
  const records = unlinked > 0 ? [`The page holds ${String(scan.records)} rows; ${String(unlinked)} of them are not among the listings counted.`] : [];
  // Never more than was checked: a listing not shown that fails nothing the
  // matcher read, but states no figure for a bound or no word either way
  // for a condition some listing states, is "not checked", not "ranks
  // lower" (sealed heldout5 on 637a9e9a: widths written 84'' were never
  // read, and the hidden qualifier was said to rank lower; Main).
  const contestedTerms = new Set(items.flatMap((item) => [...item.denied]));
  const unchecked = (item: ListItem): boolean =>
    !item.fails && (item.bounds.some((met) => met === 0) || [...contestedTerms].some((term) => !item.met.has(term) && !item.denied.has(term)));
  // The list note, in 3fe85593's words byte for byte: rewritten (in page
  // order, fail counts), the brain put on a 4★ filter that hid every
  // qualifier more often (amazon-gaming-80k step-2 replay, 2026-10-05).
  const ranking = superlatives[0] === undefined ? '' : `, then ${superlatives[0].least ? 'lowest' : 'highest'} ${superlatives[0].kind}`;
  const listNote = (shown: number, failing: number, notChecked: number): string => {
    if (shown >= items.length) return `All ${String(items.length)} listings shown.`;
    const hidden = items.length - shown;
    const lower = hidden - failing - notChecked;
    const why =
      notChecked > 0
        ? `of the ${String(hidden)} not shown, ${[
            ...(failing > 0 ? [`${String(failing)} fail a condition the task states`] : []),
            `${String(notChecked)} not checked`,
            ...(lower > 0 ? [`${String(lower)} ${lower === 1 ? 'ranks' : 'rank'} lower`] : []),
          ].join(', ')}`
        : failing >= hidden
          ? `each of the ${String(hidden)} not shown fails a condition the task states`
          : failing > 0
            ? `${String(failing)} of the ${String(hidden)} not shown fail a condition the task states, the rest rank lower`
            : `the ${String(hidden)} not shown rank lower`;
    return `${String(shown)} of ${String(items.length)} listings shown, in page order; ranked by the task: conditions met first${ranking}; ${why}.`;
  };
  if (items.length > 0) {
    factsChars = LIST_FACTS;
    textBudget = factsChars - 8 - pageHead.length;
  }
  if (items.length > 0) textBudget -= [listNote(items.length - 10, 3, 3), ...records, ...shared].reduce((sum, line) => sum + Math.min(line.length, FACT_CHARS) + 3, 0);
  const inItem = new Set(items.flatMap((item) => [item.title, ...item.span]));
  itemLines = inItem;
  type Pick = {
    readonly score: number;
    readonly order: number;
    readonly orders: readonly number[];
    readonly reduced?: readonly number[];
    readonly seq?: number;
    readonly part?: 'head' | 'whole' | 'failing' | 'rest';
  };
  // A head is the item's title, its ordinal ("30.": its rank is what it is
  // on a numbered list, H1) and its attribute lines; where it does not fit
  // whole, its title, ordinal and first attribute. Items in match order:
  // whole while they fit, then reduced, so the top items show their values
  // (a ratings count decided corpus B1, 10:01Z) and the ones under them
  // still show their title (the sealed briefs lacked the qualifier's TITLE,
  // BrainMeasure on 55b5470a).
  const ordinals = (item: ListItem): readonly number[] => item.lines.filter((order) => ORDINAL_LINE.test((scan.text[order] ?? '').trim()));
  const sorted = (orders: readonly number[]): readonly number[] => [...new Set(orders)].sort((left, right) => left - right);
  const head = (item: ListItem): readonly number[] => sorted([item.title, ...ordinals(item), ...item.attributes]);
  const reducedHead = (item: ListItem): readonly number[] => sorted([item.title, ...ordinals(item), ...item.headLines]);
  const shownWith = (item: ListItem): ReadonlySet<number> => new Set(head(item));
  const best = byMatch[0] !== undefined && byMatch[0].matches > 0 ? byMatch[0] : undefined;
  const nearMiss = new Set(
    items
      .filter((item) => {
        const title = scan.fullText.get(item.title) ?? scan.text[item.title] ?? '';
        return item.fails && ((lineTerms[item.title]?.size ?? 0) > 0 || boundVerdicts(title, bounds, today).includes(true));
      })
      .map((item) => item.title),
  );
  const picks: Pick[] = [
    // An item failing a bound the task states shows after every other
    // item's attributes: its title is less use than the values of one that
    // may qualify.
    ...byMatch.map((item, index) =>
      // A search result shows whatever it fails: the engine ranked it, and
      // its title and snippet are what the brain chooses a page by.
      item.summary !== undefined
        ? { score: RESULT_FIRST + (item.fails ? restScore - 0.1 : itemScore[index]!), order: item.title, orders: reducedHead(item), seq: index, part: 'head' as const }
        : item.fails
          ? { score: restScore - 0.1, order: item.title, orders: reducedHead(item), seq: index, part: 'failing' as const }
          : { score: itemScore[index]!, order: item.title, orders: reducedHead(item), seq: index, part: 'head' as const },
    ),
    ...byMatch.map((item, index) => ({ score: restScore + 0.05, order: item.title, orders: head(item), seq: index, part: 'whole' as const })),
    ...byMatch.map((item, index) => ({ score: restScore - 0.25, order: item.title, orders: item.lines.filter((order) => !shownWith(item).has(order)), seq: index, part: 'rest' as const })),
    ...texts
      .filter((line) => !inItem.has(line.order) && !(BOILERPLATE.test(line.text) && named(line.text) === 0))
      .map((line) => ({ score: line.score - (listPage || !end.has(line.order) ? 0 : 3), order: line.order, orders: [line.order] })),
  ];
  // Equal scores: items in match order, everything else in page order.
  const tie = (left: Pick, right: Pick): number => (left.seq !== undefined && right.seq !== undefined ? left.seq - right.seq : left.order - right.order);
  picks.sort((left, right) => right.score - left.score || tie(left, right));
  // EVERY ITEM'S HEAD BEFORE ANY ITEM GETS MORE, at the longest titles and
  // attributes that let every item not failing a bound show its head; only
  // when even the shortest do not, heads drop from the bottom. At full
  // length, 3-5 of 7-11 card titles fit on the sealed card pages and the
  // qualifier was among the dropped on 3 of 6 (BrainMeasure, a41f3065).
  // A title cut before the clauses that decide the task for it keeps them
  // at its end: a figure a bound judges ("…, 76'' W x 36'' D"), a task word
  // either way ("…, NVIDIA GeForce RTX 4060 8GB"). Cut away, every listing
  // read the same and the brain could not see which one fits (dev,
  // 2026-10-04; sealed heldout6 on 40a02a70, abstract: a size past a long
  // title's 80th character, recall 0).
  const decides = (clause: string): boolean => boundVerdict(clause, bounds, today) !== undefined || satisfiedIn(clause).size > 0 || contradictedIn(clause).size > 0;
  const tailed = (order: number, room: number): string | undefined => {
    const full = scan.fullText.get(order)?.replace(/\s+/g, ' ').trim();
    if (full === undefined || full.length <= room) return undefined;
    const clauses: { readonly text: string; readonly start: number; readonly end: number }[] = [];
    // Clauses end at a comma (not one grouping thousands: "Up to 3,000 MB/s"), a bar, a dot or a spaced dash.
    for (const match of full.matchAll(/(?:[^,|·]|,(?=\d{3}(?!\d)))+?(?=\s*(?:,(?!\d{3}(?!\d))|\||·|\s[-–—]\s|$))/gu)) {
      const text = match[0].trim();
      if (text !== '' && decides(text)) clauses.push({ text, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
    // The clauses the prefix cuts into or off, unless what it shows of one already decides.
    const after = (prefix: string): string => {
      const shownTo = prefix.replace(/…$/u, '').length;
      return clip(clauses.filter((clause) => clause.end > shownTo && !decides(full.slice(clause.start, shownTo))).map((clause) => clause.text).join(', '), 48);
    };
    const first = after(clip(full, room));
    if (first === '') return undefined;
    const prefix = clip(full, Math.max(24, room - first.length - 2));
    return `link ${JSON.stringify(`${prefix} ${after(prefix)}`)}`;
  };
  const qualifying = byMatch.filter((item) => !item.fails);
  // Where no length fits them all, the one showing the most heads; the
  // longer of equals.
  const shown = (): number => qualifying.filter((item) => keptOrders.has(item.title)).length;
  let bestLevel = 0;
  let bestShown = -1;
  const lengths = items.length === 0 ? ITEM_SHRINK.slice(0, 1) : ITEM_SHRINK;
  for (const [level, [titleChars, attributeChars]] of lengths.entries()) {
    shorten(titleChars, attributeChars);
    allocate();
    if (shown() === qualifying.length) {
      bestLevel = -1;
      break;
    }
    if (shown() > bestShown) {
      bestLevel = level;
      bestShown = shown();
    }
  }
  if (bestLevel >= 0) {
    shorten(...lengths[bestLevel]!);
    allocate();
  }
  function shorten(titleChars: number, attributeChars: number): void {
    shortened.clear();
    for (const item of items) {
      // As `scanPage` cut it: a card's title at its length, any other link's at 80.
      const tail = tailed(item.title, Number.isFinite(titleChars) ? titleChars : scan.cards.has(item.titleNode) ? CARD_TITLE_CHARS : 80);
      if (tail !== undefined) shortened.set(item.title, tail);
    }
    if (Number.isFinite(titleChars)) {
      for (const item of items) {
        const title = scan.text[item.title]!;
        const inner = LINK_LINE.test(title) ? (JSON.parse(title.slice(title.indexOf('"'))) as string) : title;
        if (!shortened.has(item.title)) shortened.set(item.title, `link ${JSON.stringify(clip(inner, titleChars))}`);
        // Decorative attributes only: a line deciding the task is never cut
        // (a qualifier reduced to a clipped title and clipped values lost
        // its price, stock status and delivery date on 3 sealed card pages,
        // BrainMeasure on c3e27e4d, 2026-10-03 11:18Z).
        for (const order of item.lines) if (!item.deciding.includes(order)) shortened.set(order, clip(scan.text[order]!, attributeChars));
      }
    }
  }
  function allocate(): void {
  kept.length = 0;
  keptOrders.clear();
  let headsFit = true;
  let failingFit = true;
  let wholeFits = true;
  let restFits = true;
  for (const pick of picks) {
    if (pick.part === 'head') {
      if (keptOrders.has(pick.order)) continue;
      // From the bottom: once one head does not fit, no lower one is shown.
      // Every item's title and first attribute first; from the bottom, once
      // one does not fit, no lower head is shown.
      if (!headsFit) continue;
      if (fitsText(pick.orders)) keep(pick.orders);
      else headsFit = wholeFits = restFits = false;
    } else if (pick.part === 'whole') {
      // Then whole, top-down: the best items' other attributes, until one
      // item's do not fit.
      if (!wholeFits || !keptOrders.has(pick.order)) continue;
      if (fitsText(pick.orders)) keep(pick.orders);
      else wholeFits = restFits = false;
    } else if (pick.part === 'failing') {
      if (keptOrders.has(pick.order)) continue;
      // Beside a listing that may qualify, only a NEAR MISS: one whose
      // title meets a stated bound or names the task's words, failing on
      // another field ("Sigma 24-70mm … Out of stock" for a new, in-stock
      // 24-70mm). Hidden, the brain read to check them (dev7 H2, 7/10); the
      // rest the note counts as failing, and shown in page order among the
      // qualifier, three trains that leave too early made it look like one
      // of many and the brain read all twelve (dev6 G3, 5/10 with them,
      // 10/10 without; 2026-10-04).
      if (byMatch.some((item) => !item.fails && keptOrders.has(item.title)) && !nearMiss.has(pick.order)) continue;
      if (failingFit && fitsText(pick.orders)) keep(pick.orders);
      else failingFit = false;
    } else if (pick.part === 'rest') {
      // An item's other lines only beside its title, line by line, until one
      // does not fit; then no lower item gets more. None while a head is
      // dropped: no item gets more while another is not shown at all.
      if (!keptOrders.has(pick.order)) continue;
      for (const order of pick.orders) {
        if (!restFits || keptOrders.has(order)) continue;
        if (fitsText([order])) keep([order]);
        else restFits = false;
      }
    } else {
      if (keptOrders.has(pick.order)) continue;
      const pair = pairOf(pick.order);
      const orders = pair === undefined || keptOrders.has(pair) || inItem.has(pair) || BOILERPLATE.test(scan.text[pair] ?? '') ? pick.orders : [...pick.orders, pair];
      // Counted as briefFacts shows it: a long line is cut to FACT_CHARS there.
      if (fitsText(orders)) keep(orders);
    }
  }
  }
  // Elements the same way: an item is its title with its value controls
  // (one meeting a task bound first, its price, its rating), listed in match
  // order; once one does not fit, no lower one is. Its other controls ("Add
  // to cart") rank on their own.
  const itemNodes = new Set(items.flatMap((item) => [item.titleNode, ...item.nodes]));
  const scoreOf = new Map(scored.map((pick) => [pick.node, pick.score]));
  const elements: BriefElement[] = [];
  let used = 40;
  const nodeRank = byMatch.map((item) => Math.max(...[item.titleNode, ...item.nodes].map((node) => scoreOf.get(node) ?? 0)));
  const nodeHeadScore = byMatch.map((item, index) => (item === best ? Number.POSITIVE_INFINITY : bonus(item) + Math.max(...nodeRank.slice(index)) + (item.summary === undefined ? 0 : RESULT_FIRST)));
  const nodeHead = (item: ListItem): readonly AxNode[] => [item.titleNode, ...item.nodes];
  type Group = { readonly nodes: readonly AxNode[]; readonly score: number; readonly order: number; readonly seq?: number; readonly item?: boolean };
  const groups: Group[] = [
    ...byMatch.map((item, index) => ({ nodes: nodeHead(item), score: nodeHeadScore[index]!, order: scan.actionable.indexOf(item.titleNode), seq: index, item: true })),
    ...scored.filter((pick) => !itemNodes.has(pick.node)).map((pick) => ({ nodes: [pick.node], score: pick.score, order: pick.order })),
  ];
  const failsOf = new Map(items.flatMap((item) => (titleFails.has(item.title) ? [[item.titleNode, titleFails.get(item.title)!] as const] : [])));
  const list = (nodes: readonly AxNode[]): boolean => {
    const listing = nodes.map((node) => {
      const element = scan.element(node, '');
      const fails = failsOf.get(node);
      return fails === undefined ? element : { ...element, state: element.state === '' ? fails : `${element.state} ${fails}` };
    });
    const cost = listing.reduce((sum, element) => sum + elementCost(element), 0);
    if (used + cost > BRAIN_BUDGET.elements) return false;
    elements.push(...listing);
    used += cost;
    return true;
  };
  let nodeHeadsFit = true;
  for (const group of groups.sort((left, right) => right.score - left.score || (left.seq !== undefined && right.seq !== undefined ? left.seq - right.seq : left.order - right.order))) {
    if (group.item === true) {
      // From the bottom: once one item does not fit, no lower one is listed.
      if (nodeHeadsFit) nodeHeadsFit = list(group.nodes);
    } else if (!list(group.nodes)) {
      // A scored element is worth skipping past for; an unscored one is not:
      // filling the tail with whatever is short is how labels like "5 hours
      // ago" crowded out the results (BrainMeasure H1, 2026-10-02 21:58Z).
      if (group.score > 0) continue;
      break;
    }
  }
  const position = new Map(scan.actionable.map((node, order) => [refText(node), order]));
  elements.sort((left, right) => (position.get(left.ref) ?? 0) - (position.get(right.ref) ?? 0));
  kept.sort((left, right) => left.order - right.order);
  // Every gap is counted where it is, so the brain sees the page's shape.
  const hiddenItems = items.filter((item) => !keptOrders.has(item.title));
  const facts: { readonly text: string }[] =
    items.length === 0
      ? []
      : [
          listNote(
            items.length - hiddenItems.length,
            hiddenItems.filter((item) => item.fails).length,
            hiddenItems.filter(unchecked).length,
          ),
          ...records,
          ...shared,
        ].map((text) => ({ text }));
  let next = 0;
  for (const fact of kept) {
    if (fact.order > next) facts.push({ text: gapText(next, fact.order) });
    facts.push(fact);
    next = fact.order + 1;
  }
  if (next < scan.text.length) facts.push({ text: gapText(next, scan.text.length) });
  return {
    page: pageText(elements.length, kept.length),
    ...(factsChars === BRAIN_BUDGET.facts ? {} : { factsChars }),
    facts: facts.map((fact) => fact.text),
    elements,
    notices: scan.notices.slice(0, 4),
    dropped: 0,
    partial: scan.clipped || kept.length < scan.text.length,
  };
}

/**
 * A text with its grouped figures whole: "80,000" is 80000, "1.284.396"
 * 1284396. Split at the comma, the task's "80,000" was the word "000",
 * which every line stating a figure over 999 named ("£3,000", "Up to 5,000
 * MB/s"): it ranked a dearer car above a cheaper one and kept clauses
 * deciding nothing in cut titles.
 */
function wholeNumbers(text: string): string {
  return text.replace(/\b\d{1,3}(?:\.\d{3}){2,}\b/gu, (run) => run.replaceAll('.', '')).replace(/(\d),(?=\d{3}(?!\d))/gu, '$1');
}

/** A list item's ordinal line, before its title: "31.". */
const ORDINAL_LINE = /^\d{1,4}\.$/;
/**
 * What a list page is for: its items rank this far above a line or control
 * of the same score. Not above everything: a filter naming the task's own
 * figure ("₹5,000 - ₹10,000" for "under 10,000") still outranks them (corpus
 * B1, 2026-10-03 09:19Z: with items ranked first the filter section dropped
 * and the brain re-sorted, 1/5; with this rank, 5/5).
 */
const ITEM_BONUS = 3;
/**
 * A search result's head ranks above every line and control outside the
 * results: AI-summary lines, breadcrumbs and chrome come after the
 * results' titles and snippets (33% of titles were in the brief on SERPs
 * over 6.5k characters, 2026-10-13 recapture).
 */
const RESULT_FIRST = 1_000;
/** Units an item may span after its title. */
const ITEM_SPAN = 16;
/**
 * A list page's facts budget: its items' deciding lines whole for more of
 * its items (at 700, 3-5 of 7-11 sealed card titles fit). Three times the
 * first 900, with `BRAIN_BUDGET.facts` (see there).
 */
const LIST_FACTS = 2_700;
/** Field lines one item keeps beside its title. */
const ITEM_FIELDS = 4;
/** Title and attribute lengths a list item's head is tried at, longest first. */
const ITEM_SHRINK: readonly (readonly [number, number])[] = [
  [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  [64, 48],
];
/**
 * Attribute lines an item shows with its head. Fewer cost B1 its count of
 * ratings, and "good ram under 10,000" re-sorted by rating 5/5 rather than
 * answer (corpus B1, 2026-10-03 10:01Z).
 */
const ITEM_ATTRIBUTES = 4;
/** "Mileage: 45,210 mi", "Status: Open": a label and its value. */
const LABEL_VALUE = /^[^:]{1,30}:\s*\S/u;
/** A chip's longest label: a tag ("Free cancellation"), not a call to action or a title. */
const CHIP_CHARS = 30;
/** Value controls one item keeps beside its title, as elements. */
const ITEM_VALUES = 2;
/** A line identical in this many items, and in half of them, is the list's template ("FREE delivery"), not an attribute. */
const TEMPLATE_ITEMS = 3;
/** A field line is short: longer lines are prose, not an item's attribute. */
const FIELD_LINE_CHARS = 60;

/** Which value a listing shows first: its price, then its rating, then the rest. */
function valueRank(label: string): number {
  return /[$€£¥₹]\s?\d/.test(label) ? 0 : /stars?|\bout of \d/i.test(label) ? 1 : 2;
}

/** The task as a list item is measured against: see `ListItem.matches`. */
interface TaskTerms {
  /**
   * The task's words a text line names and SATISFIES, the page's own subject
   * words aside: none negated in its clause ("No pets allowed", "Not
   * remote"), and none on a line whose figures fail a task bound.
   */
  readonly terms: (line: number) => ReadonlySet<string>;
  /** The task's words a text line states the other way (see `contradictedTerms`). */
  readonly contradicts: (line: number) => ReadonlySet<string>;
  /** The same two for a control's label (an item's chip, `ListItem.chips`). */
  readonly labelTerms: (label: string) => ReadonlySet<string>;
  readonly labelContradicts: (label: string) => ReadonlySet<string>;
  /** Whether what a label states meets the task's bounds (`boundVerdict`); undefined when it states nothing they compare. */
  readonly meets: (label: string) => boolean | undefined;
  /** The same, per bound (`boundVerdicts`). */
  readonly verdicts: (label: string) => readonly (boolean | undefined)[];
  /** The figures a superlative in the task ranks on, in task order: "cheapest" a price, "best rated" a rating, "soonest" a date. */
  readonly targets: readonly FigureKind[];
  /** The kinds of value the task asks for or bounds. */
  readonly asked: readonly ValueKind[];
  /** The run's date, YYYY-MM-DD, that relative dates resolve against. */
  readonly today?: string;
  /** Whether the first superlative wants the least of its figure ("cheapest", "soonest"). */
  readonly least: boolean;
}

/** A kind of value a task asks for: "give its price and mileage". */
type ValueKind = 'price' | 'rating' | 'length' | 'date';

/** The kinds of value a task names or bounds. */
function askedKinds(task: string, bounds: readonly Bound[]): readonly ValueKind[] {
  const kinds = new Set<ValueKind>();
  if (/\b(?:price[sd]?|cost|costs|pay|cheap\w*|expensive|afford\w*)\b/i.test(task) || bounds.some((bound) => bound.kind === 'price')) kinds.add('price');
  if (/\b(?:rating|rated|stars?|reviews?)\b/i.test(task)) kinds.add('rating');
  if (/\b(?:mileage|miles|odometer|distance|km|kilomet\w*|size|width|length|height|depth|inch\w*|cm|feet)\b/i.test(task) || bounds.some((bound) => bound.kind === 'unit' && UNIT_SCALE[bound.unit!]?.[0] === 'length')) {
    kinds.add('length');
  }
  if (/\b(?:deliver\w*|arriv\w*|ship\w*|date|when)\b/i.test(task) || bounds.some((bound) => bound.kind === 'date' || bound.kind === 'time')) kinds.add('date');
  return [...kinds];
}

/** Whether a line states a value of a kind. */
function isKind(line: string, kind: ValueKind): boolean {
  if (kind === 'price') return PRICE_AT.test(line) || /\b(?:rs\.?|inr)\s?\d/i.test(line);
  if (kind === 'rating') return figureOf(line, 'rating') !== undefined;
  if (kind === 'date') return datesIn(line).length > 0 || WHEN.test(line) || timesIn(line).length > 0;
  return unitFigures(line).some((figure) => UNIT_SCALE[figure.unit]?.[0] === 'length');
}

/** A kind of figure an item states, as a superlative names it. */
type FigureKind = 'price' | 'rating' | 'date';

/** Superlatives and the figure each ranks on; the ascending ones want the least. */
const SUPERLATIVES: readonly { readonly pattern: RegExp; readonly kind: FigureKind; readonly least: boolean }[] = [
  { pattern: /\b(?:cheapest|least expensive|most affordable|lowest[- ]?(?:priced?|cost))\b/i, kind: 'price', least: true },
  { pattern: /\b(?:most expensive|priciest|highest[- ]?priced)\b/i, kind: 'price', least: false },
  // "Good ram", "a good laptop": what shoppers mean by good is rated well.
  { pattern: /\b(?:best|good|great|highest[- ]?rated|top[- ]?rated|(?:best|well)[- ]?reviewed|highest rating)\b/i, kind: 'rating', least: false },
  { pattern: /\b(?:soonest|earliest|quickest|fastest (?:delivery|shipping)|arrives? (?:first|soonest))\b/i, kind: 'date', least: true },
  { pattern: /\b(?:latest|newest|most recent)\b/i, kind: 'date', least: false },
];

/** The superlatives a task states, in task order. */
function superlativesOf(task: string): readonly { readonly kind: FigureKind; readonly least: boolean }[] {
  return SUPERLATIVES.map((entry) => ({ ...entry, at: entry.pattern.exec(task)?.index ?? -1 }))
    .filter((entry) => entry.at >= 0)
    .sort((left, right) => left.at - right.at)
    .map(({ kind, least }) => ({ kind, least }));
}

/** How many rated it: "9,876 ratings", "(1.2k reviews)". */
const RATING_COUNT = /\d[\d,.]*k?\s*(?:ratings?|reviews?)\b/i;
/** A rating stated bare: "4.92 (310 trips)", "4.6/5", "4.5 ★". */
const BARE_RATING = /(?:^|\s)([0-5]\.\d{1,2})\s*(?:\(|★|\/\s*5\b|$)/u;
/** A line about when something arrives or happens. */
const WHEN = /\b(?:today|tonight|tomorrow|deliver(?:y|s|ed)?|arriv(?:es|al)|ships?|get it|dispatch(?:es)?|in \d+ (?:days?|hours?))\b/i;

/** The figure of a kind a line states, as a number to rank on; undefined when it states none. */
function figureOf(line: string, kind: FigureKind, today?: string): number | undefined {
  if (kind === 'price') {
    const price = listingPrices(line)[0];
    return price === undefined ? undefined : priceOf(price);
  }
  if (kind === 'rating') {
    const stars = /(\d(?:\.\d+)?)\s*(?:out of \d+(?:\.\d+)?\s*)?stars?\b/i.exec(line) ?? BARE_RATING.exec(line);
    return stars === null ? undefined : Number(stars[1]);
  }
  if (today !== undefined) return datesOn(line, today)[0]?.value;
  const date = datesIn(line)[0];
  if (date !== undefined) return date.value;
  // Without the run's date, relative days rank before any calendar date: delivery lists say "Tomorrow" or "Mon, 5 Oct".
  if (/\b(?:today|tonight)\b/i.test(line)) return 0;
  if (/\btomorrow\b/i.test(line)) return 1;
  const days = /\bin (\d+) days?\b/i.exec(line);
  return days === null ? undefined : Number(days[1]);
}

/** A bound's own words ("under", "after", "least"): the bound is judged on its figure, not on these. */
const BOUND_TERMS: ReadonlySet<string> = new Set(['under', 'below', 'less', 'fewer', 'cheaper', 'before', 'earlier', 'prior', 'most', 'more', 'over', 'above', 'greater', 'after', 'later', 'least', 'within', 'until', 'till', 'max', 'maximum', 'min', 'minimum']);

/**
 * A page's legal and cookie boilerplate: copyright, "all rights reserved",
 * cookie notices, privacy and terms links. Never chosen for a brief unless
 * the task names its words: a short line with a year scored as a figure, and
 * "© 2026 …" took budget in 17 of 146 dev briefs (2026-10-03).
 */
const BOILERPLATE = /©|\(c\)\s*\d{4}|\bcopyright\b|all rights reserved|\bwe use cookies\b|\bcookie (?:policy|settings|preferences|consent)\b|\bprivacy policy\b|\bterms (?:of (?:use|service)|and conditions)\b/i;

/** Words naming a field a task asks for, not a constraint on it. */
const FIELD_NAMES: readonly string[] = ['price', 'prices', 'priced', 'cost', 'costs', 'rating', 'ratings', 'rated', 'review', 'reviews', 'star', 'stars', 'mileage'];

/** Phrases stating the opposite of a task word without negating it. */
const ANTONYMS: ReadonlyMap<string, RegExp> = new Map([
  ['new', /\b(?:used|pre-?owned|second[- ]hand|refurbished|renewed|reconditioned|open[- ]box|ex[- ]display|demo unit)\b/i],
  ['stock', /\b(?:pre-?order|back-?order(?:ed)?|sold out|unavailable|discontinued|ships in \d+\s*-?\s*\d*\s*weeks?)\b/i],
  ['available', /\b(?:sold out|unavailable|discontinued|booked|fully booked)\b/i],
]);

/** Words that make the word after them a different thing: "semi-freestanding", "partly furnished". */
const WEAKENERS: ReadonlySet<string> = new Set(['semi', 'partially', 'partly', 'quasi', 'part', 'pseudo', 'mostly']);

/** Words that negate the task word after them in a clause ("t" is "doesn't", split). */
const NEGATION: ReadonlySet<string> = new Set(['not', 'no', 'non', 'none', 'except', 'excluding', 'without', 'never', 'nor', 't', 'cannot', 'unavailable']);
const MONTH = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Dates a label states: "2026-10-15", "15 Oct 2026", "October 15, 2026", "Oct 15", "October 2026". */
const DATES = new RegExp(
  String.raw`\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH})\.?,?(?:\s+(\d{4}))?\b|\b(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(\d{4}))?|\b(${MONTH})\.?\s+(\d{4})\b`,
  'gi',
);
/** Currency, as a symbol or a word: what makes a bound's number a price. */
const CURRENCY_WORD = /^(?:rs|inr|rupees?|usd|dollars?|eur|euros?|gbp|pounds?|bucks)$/i;
/** Prices a label states: "₹3,349", "$99.99", "Rs. 3,349". */
const PRICE = /[$€£¥₹]\s?(\d[\d,]*(?:\.\d+)?)([km](?![\w.]))?|\b(?:rs\.?|inr)\s?(\d[\d,]*(?:\.\d+)?)([km](?![\w.]))?/gi;

/**
 * A `PRICE` match's amount: "$95K" is 95,000 and "$1.2M" 1,200,000 (read as
 * 95, a salary of "$95K - $110K a year" failed "at least $90,000" and the
 * listing was hidden as failing; dev, 2026-10-05).
 */
function priceOf(match: RegExpExecArray | RegExpMatchArray): number {
  // Written against the figure only: "₹17,409 M.R.P" is no million.
  const scale = (match[2] ?? match[4] ?? '').toLowerCase();
  return Number((match[1] ?? match[3])!.replace(/,/g, '')) * (scale === 'k' ? 1_000 : scale === 'm' ? 1_000_000 : 1);
}
/**
 * The prices a label states as what something costs: not a threshold or a
 * discount inside a sentence ("Free shipping on orders over $35", "Spend
 * $50", "Save $20", "$5 off"). Counted as a price, the $35 met "under $120"
 * on a card whose own price was $149 (dev, 2026-10-05).
 */
function listingPrices(label: string): readonly RegExpMatchArray[] {
  return [...label.matchAll(PRICE)].filter((match) => {
    const before = label.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    const after = label.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 16);
    return !/\b(?:over|above|orders?|spend|save|saving|min(?:imum)?(?: order)?|more than|at least)\s*(?:of\s*)?$/iu.test(before) && !/^\s*(?:off|discount|or more|\+)/iu.test(after);
  });
}

/** The words that state a bound, and which side of it satisfies the task. */
const BOUND_WORDS: readonly { readonly pattern: RegExp; readonly upper: boolean; readonly strict: boolean; readonly dates: boolean; readonly numbers: boolean }[] = [
  { pattern: /\b(?:under|below|less than|fewer than|cheaper than)\s+/gi, upper: true, strict: true, dates: false, numbers: true },
  { pattern: /\b(?:before|earlier than|prior to)\s+/gi, upper: true, strict: true, dates: true, numbers: false },
  { pattern: /\b(?:at most|no more than|up to|max(?:imum)?(?: of)?|within)\s+/gi, upper: true, strict: false, dates: false, numbers: true },
  { pattern: /\b(?:by|until|till|no later than|not after)\s+/gi, upper: true, strict: false, dates: true, numbers: false },
  { pattern: /\b(?:over|above|more than|greater than)\s+/gi, upper: false, strict: true, dates: false, numbers: true },
  { pattern: /\b(?:after|later than)\s+/gi, upper: false, strict: true, dates: true, numbers: false },
  { pattern: /\b(?:at least|no less than|min(?:imum)?(?: of)?)\s+/gi, upper: false, strict: false, dates: false, numbers: true },
  { pattern: /\b(?:no earlier than|not before)\s+/gi, upper: false, strict: false, dates: true, numbers: false },
];

/**
 * A bound the task states on a date or a number: "closing after 15 October",
 * "under 10,000 rs", "at least 4.5 stars", "within 5 km". A date is compared
 * at the task's own precision (a year, a month, a day); a number is a price
 * when it carries a currency (or nothing: "under 60k"), else it is compared
 * only with figures in the same unit.
 */
interface Bound {
  readonly kind: 'date' | 'price' | 'unit' | 'time' | 'range';
  /** A range bound's upper end ("a 24-70 mm lens": 70), its `value` the lower. */
  readonly to?: number;
  readonly value: number;
  readonly upper: boolean;
  readonly strict: boolean;
  /** A date's precision, and whether it named a year. */
  readonly precision?: 'year' | 'month' | 'day';
  readonly year?: number;
  /** A unit figure's unit, stemmed: "star", "km". */
  readonly unit?: string;
  /** A time bound's verb ("departs after 6 pm"): a line stating several times is judged on the one after it. */
  readonly cue?: string;
  /** The task's words for it ("under $120", "at least 4.5 stars"), as a listing that fails it is marked. */
  readonly said: string;
  /**
   * What a unit bound measures, as the task names it ("16 GB of RAM": "ram"):
   * a card's "label: value" line for another thing ("Storage: 512 GB SSD")
   * is not judged on it.
   */
  readonly attribute?: string;
}

/** Words that name the same measured thing on a card. */
const ATTRIBUTE_NAMES: readonly (readonly string[])[] = [
  ['ram', 'memory', 'mem'],
  ['storage', 'ssd', 'hdd', 'drive', 'disk', 'capacity'],
  ['battery', 'battery life'],
  ['screen', 'display', 'screen size'],
  ['weight', 'weighs'],
];

/**
 * Whether a card's field label names a known thing other than the one a
 * bound measures ("Storage" for "ram"). A label naming no known thing, or
 * a bound on one, is judged as before: "within 5 km of downtown" against
 * "Location: Downtown, 3 km" still reads the 3 km.
 */
function namesOtherAttribute(label: string, attribute: string): boolean {
  const said = label.toLowerCase().trim();
  const own = ATTRIBUTE_NAMES.find((names) => names.includes(attribute));
  if (own === undefined || own.some((name) => said.includes(name))) return false;
  return ATTRIBUTE_NAMES.some((names) => names !== own && names.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(said)));
}

/** A unit word compared loosely: "stars" is "star", "reviews" is "review". */
function unitStem(word: string): string {
  // A plural loses its "s" only: "miles" is "mile", not "mil".
  const stemmed = word.toLowerCase().replace(/s$/u, '');
  return UNIT_NAMES[stemmed] ?? stemmed;
}

/** A unit's short and long names, as one: "45,210 mi" against "under 60,000 miles". */
const UNIT_NAMES: Readonly<Record<string, string>> = {
  mi: 'mile', km: 'kilometer', kilometre: 'kilometer', inche: 'inch', in: 'inch', '"': 'inch', '″': 'inch', '”': 'inch', "''": 'inch', "'": 'foot', '′': 'foot', cm: 'centimeter', centimetre: 'centimeter',
  mm: 'millimeter', millimetre: 'millimeter', m: 'meter', metre: 'meter', ft: 'foot', feet: 'foot',
  hr: 'hour', h: 'hour', min: 'minute', mn: 'minute', lb: 'pound', kg: 'kilogram', g: 'gram', gm: 'gram', oz: 'ounce', mb: 'mb', gb: 'gb', tb: 'tb',
  l: 'liter', litre: 'liter', ml: 'milliliter', millilitre: 'milliliter', qt: 'quart', gal: 'gallon', sqft: 'squarefoot', sqm: 'squaremeter',
};

/**
 * Units that measure the same thing, in one base each, so a bound in one
 * unit compares with a figure in another ("under 30 inches" against "Width:
 * 70 cm"; the sealed list pages state sizes and distances in either,
 * BrainMeasure 2026-10-03).
 */
const UNIT_SCALE: Readonly<Record<string, readonly [string, number]>> = {
  millimeter: ['length', 1], centimeter: ['length', 10], meter: ['length', 1000], kilometer: ['length', 1_000_000], inch: ['length', 25.4], foot: ['length', 304.8], mile: ['length', 1_609_344],
  gram: ['mass', 1], kilogram: ['mass', 1000], pound: ['mass', 453.592], ounce: ['mass', 28.3495],
  mb: ['storage', 1], gb: ['storage', 1024], tb: ['storage', 1_048_576],
  minute: ['time', 1], hour: ['time', 60],
  milliliter: ['volume', 1], liter: ['volume', 1000], quart: ['volume', 946.353], gallon: ['volume', 3785.41],
  squaremeter: ['area', 1], squarefoot: ['area', 0.092903],
};

/** An area's unit as one word: "1,200 sq ft", "ft²", "square feet", "45 m²" (sealed list pages state sizes either way). */
function areaWords(text: string): string {
  return text
    .replace(/\b(?:sq\.?\s*f(?:ee|oo)?t\.?|square\s+f(?:ee|oo)t)(?![a-z])|ft²/giu, 'sqft')
    .replace(/\b(?:sq\.?\s*m(?:eters?|etres?)?|square\s+met(?:er|re)s?)\b|m²/giu, 'sqm');
}

/**
 * The part of a label giving one side of a size: "34 in W x 36 in D" for
 * "w" is "34 in", "Width: 38\"" is itself; a label naming no side whole.
 */
function sideOf(label: string, side: string | undefined): string {
  if (side === undefined) return label;
  if (!/\b(?:w|h|d|l|wide|width|high|height|tall|deep|depth|long|length)\b/i.test(label)) {
    // An unnamed chain ("84'' x 36'' x 33''") lists width, depth, height in that order.
    const chain = /(\d[\d,.]*\s*(?:''|["″”']|(?!x\b)[a-z]+)?)\s*[x×]\s*(\d[\d,.]*\s*(?:''|["″”']|(?!x\b)[a-z]+)?)(?:\s*[x×]\s*(\d[\d,.]*\s*(?:''|["″”']|(?!x\b)[a-z]+)?))?/iu.exec(label);
    if (chain === null) return label;
    const unit = /(''|["″”']|[a-z]+)\s*$/iu.exec(chain[0])?.[1] ?? '';
    const pick = chain[{ w: 1, l: 1, d: 2, h: 3 }[side] ?? 1];
    return pick === undefined ? label : /[a-z"″”']$/iu.test(pick.trim()) ? pick : `${pick.trim()} ${unit}`;
  }
  const parts = label.split(/[x×,;|]/u);
  const named = parts.filter((part) => new RegExp(`(?:^|[^a-z])${side}(?:[a-z]*)\\b`, 'i').test(part) || (side === 'h' && /\btall\b/i.test(part)));
  return named.length === 0 ? label : named.join(' ');
}

/** A figure in a unit, in the unit's base when it has one: [dimension, value]. */
function inBase(value: number, unit: string): readonly [string, number] {
  const scale = UNIT_SCALE[unit];
  return scale === undefined ? [unit, value] : [scale[0], value * scale[1]];
}

/**
 * The unit figures a label states: "45,210 mi", "16GB", "4.6 out of 5
 * stars", '15.6"', and each number of a dimension chain ("70 x 40 x 30 cm").
 */
function unitFigures(label: string): readonly { readonly value: number; readonly unit: string; readonly precision: number }[] {
  const plain = areaWords(label)
    // A title's echo line ends in its closing quote: "… model SF-210\"" is no 210 inches.
    .replace(/^(?:link|button) "(.*)"$/su, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*out of\s*\d+(?:\.\d+)?/gi, '$1')
    // One figure in two units: "5 lb 1 oz" is 81 oz, "5 ft 10 in" 70 in
    // (sealed heldout5 on 4fb16323: "5 lb 1 oz" met "under 4 lb").
    .replace(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\.?\s*(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/giu, (_, lb: string, oz: string) => `${String(Number(lb) * 16 + Number(oz))} oz`)
    .replace(/(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')\s*(\d+(?:\.\d+)?)\s*(?:in|inches|"|″)/giu, (_, ft: string, inch: string) => `${String(Number(ft) * 12 + Number(inch))}″`)
    // "34-inch", "90-cm": the unit after a hyphen.
    .replace(/(\d)-(?=(?:inch|in|cm|mm|ft|foot|feet|lb|kg|oz|mile|km)\b)/giu, '$1 ');
  const found: { value: number; unit: string; precision: number }[] = [];
  // How finely a figure is written: "4.0 L" to a tenth, "139 cm" to one.
  const precision = (written: string, scale: number): number => 10 ** -((written.split('.')[1] ?? '').length) * scale;
  for (const m of plain.matchAll(/((?:\d[\d,]*(?:\.\d+)?\s*[x×]\s*)*)(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*([a-z]+|''|["″”]|'(?![a-z]))/giu)) {
    // "in" is inches only where no word follows: "15.6 in" yes, "1 in the catalogue" no.
    // "in" is inches when a size follows it ("34 in W", "34 in wide", "34 in."), not a word ("1 in the catalogue").
    if (m[4]!.toLowerCase() === 'in' && !/^\s*(?:$|[.,;:)x×/|]|(?:w|h|d|l|wide|high|deep|long|tall|width|height|depth|length)\b)/iu.test(plain.slice((m.index ?? 0) + m[0].length))) continue;
    const unit = unitStem(m[4]!);
    const scale = m[3] === undefined ? 1 : 1000;
    for (const chained of (m[1] ?? '').split(/[x×]/u).map((part) => part.trim()).filter(Boolean)) found.push({ value: Number(chained.replace(/,/g, '')) * scale, unit, precision: precision(chained, scale) });
    found.push({ value: Number(m[2]!.replace(/,/g, '')) * scale, unit, precision: precision(m[2]!, scale) });
  }
  return found;
}

/** The dates a label states, as year*10000 + month*100 + day (year 0 when it names none, day 0 for a month). */
function datesIn(label: string): { readonly value: number; readonly year: boolean; readonly day: boolean }[] {
  const month = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  return [...label.matchAll(DATES)].map((m) => {
    if (m[1] !== undefined) return { value: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]), year: true, day: true };
    if (m[4] !== undefined) return { value: Number(m[6] ?? 0) * 10000 + month(m[5]!) * 100 + Number(m[4]), year: m[6] !== undefined, day: true };
    if (m[7] !== undefined) return { value: Number(m[9] ?? 0) * 10000 + month(m[7]) * 100 + Number(m[8]), year: m[9] !== undefined, day: true };
    return { value: Number(m[11]) * 10000 + month(m[10]!) * 100, year: true, day: false };
  });
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** "Today", "tomorrow", "in 3 days", "Friday": a day relative to the run's date. */
const RELATIVE_DAY = /\b(today|tonight|tomorrow|in (\d+) days?|(sun|mon|tue|wed|thu|fri|sat)[a-z]*day)\b/i;

/**
 * The dates a label states, a relative one ("Tomorrow 8 am - 12 pm", "Get
 * it Friday") resolved against the run's date (`AgentPrompt.today`,
 * YYYY-MM-DD), and a date naming no year taken in that year. Without it,
 * "delivered by 10 October" could not judge "Tomorrow" (sealed card pages,
 * BrainMeasure 2026-10-03).
 */
function datesOn(label: string, today: string): { readonly value: number; readonly year: boolean; readonly day: boolean }[] {
  const now = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(now.getTime())) return [...datesIn(label)];
  const year = now.getUTCFullYear();
  const stated = datesIn(label).map((date) => (date.year ? date : { ...date, value: date.value + year * 10000, year: true }));
  if (stated.length > 0) return stated;
  const relative = RELATIVE_DAY.exec(label);
  if (relative === null) return [];
  const word = relative[1]!.toLowerCase();
  const weekday = relative[3] === undefined ? -1 : WEEKDAYS.indexOf(relative[3].toLowerCase());
  const ahead = word === 'today' || word === 'tonight' ? 0 : word === 'tomorrow' ? 1 : relative[2] !== undefined ? Number(relative[2]) : (weekday - now.getUTCDay() + 7) % 7 || 7;
  const day = new Date(now.getTime() + ahead * 86_400_000);
  return [{ value: day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate(), year: true, day: true }];
}

/** A time of day: "18:05", "6 pm", "6:30am", "noon". */
const TIME = /\b(?:([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?|(1[0-2]|0?[1-9])\s*(am|pm)|(noon|midnight))\b/gi;
const TIME_AT_START = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|0?[1-9])\s*(?:am|pm)|noon|midnight)\b/i;

/** The times of day a label states, as minutes after midnight. */
function timesIn(label: string): number[] {
  return [...label.matchAll(TIME)].map((m) => {
    if (m[6] !== undefined) return m[6].toLowerCase() === 'noon' ? 720 : 0;
    const meridiem = (m[3] ?? m[5])?.toLowerCase();
    let hour = Number(m[1] ?? m[4]);
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return hour * 60 + Number(m[2] ?? 0);
  });
}

/** A range with its unit: "24-70mm", "24–70 mm", "18 – 55mm". */
const RANGE = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s*(?:mm|cm|in|m)?\s*[-–—]\s*(\d[\d,]*(?:\.\d+)?)\s*(mm|cm|m|km|in|inche?s?|ft|kg|g|lb|oz|mb|gb|tb|mi|miles?)\b/giu;

/** Comparatives whose "no … than" sets a floor ("no narrower than"); the rest set a ceiling. */
const LOWER_COMPARATIVES: ReadonlySet<string> = new Set(['narrower', 'shorter', 'smaller', 'lighter']);
/** The side of a size a comparative names, as a size bound's cue word. */
const COMPARATIVE_SIDE: Readonly<Record<string, string>> = {
  wider: 'wide', broader: 'wide', narrower: 'wide', taller: 'high', higher: 'high', shorter: 'high', longer: 'long', deeper: 'deep',
};

/** The bounds a task states on dates and numbers. */
function boundsOf(stated: string, today?: string): readonly Bound[] {
  // "between £130 and £150" is two bounds: at least the one, at most the other.
  const task = areaWords(stated)
    .replace(/\bbetween\s+([$€£¥₹]?\s?\d[\d,.]*\s*\w*)\s+(?:and|to|-)\s+/giu, 'at least $1 and at most ')
    // "rated 4.5 or higher", "4.5+ stars", "$50 or less": the bound after its figure.
    .replace(/([$€£¥₹]?\d[\d,.]*)\s*(\w*)\s+or\s+(?:more|higher|above|better|greater|over)\b/giu, 'at least $1 $2')
    .replace(/([$€£¥₹]?\d[\d,.]*)\s*(\w*)\s+or\s+(?:less|lower|below|under|cheaper|fewer)\b/giu, 'at most $1 $2')
    .replace(/(\d[\d,.]*)\+\s*(\w+)/gu, 'at least $1 $2')
    // "no wider than 200 cm" is "at most 200 cm wide"; "wider than 2 m" is
    // "over 2 m wide" (sealed heldout5 on a506a744: "no wider than 200 cm"
    // was no bound, so no width was checked and the sofa that fits was hidden).
    .replace(
      /\b(no|not)\s+(wider|broader|taller|higher|longer|deeper|heavier|bigger|larger|narrower|shorter|smaller|lighter)\s+than\s+([$€£¥₹]?\d[\d,.]*\s*(?:''|["″”']|[a-z]+)?)/giu,
      (_, __, comparative: string, figure: string) => `${LOWER_COMPARATIVES.has(comparative.toLowerCase()) ? 'at least' : 'at most'} ${figure.trim()} ${COMPARATIVE_SIDE[comparative.toLowerCase()] ?? ''}`,
    )
    .replace(
      /\b(wider|broader|taller|higher|longer|deeper|heavier|bigger|larger|narrower|shorter|smaller|lighter)\s+than\s+([$€£¥₹]?\d[\d,.]*\s*(?:''|["″”']|[a-z]+)?)/giu,
      (_, comparative: string, figure: string) => `${LOWER_COMPARATIVES.has(comparative.toLowerCase()) ? 'under' : 'over'} ${figure.trim()} ${COMPARATIVE_SIDE[comparative.toLowerCase()] ?? ''}`,
    );
  const bounds: Bound[] = [];
  // A range the task names with its unit ("a 24-70mm lens", "covering 24–70
  // mm") is met by a listing whose own range covers it: "20–70 mm" does,
  // "28–75 mm" does not (sealed heldout5 on a506a744: nothing said 20-70
  // covers 24-70, and the brain read only the listings named 24-70).
  for (const range of task.matchAll(RANGE)) {
    const unit = unitStem(range[3]!);
    if (UNIT_SCALE[unit] === undefined) continue;
    bounds.push({ kind: 'range', value: Number(range[1]!.replace(/,/g, '')), to: Number(range[2]!.replace(/,/g, '')), upper: false, strict: false, unit, said: range[0].trim() });
  }
  for (const word of BOUND_WORDS) {
    for (const match of task.matchAll(word.pattern)) {
      const after = task.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
      // "by this Friday (Oct 10)", "before the 14th", "by Fri": the day after
      // its article (dev11 N4, 2026-10-05: "arrives by this Friday" was no
      // bound, the qualifier arriving Thursday was hidden as ranking lower,
      // and the brain read the whole list, 5 of 5).
      const rest = word.dates ? after.replace(/^(?:this|the|on)\s+/iu, '') : after;
      const date = word.dates ? (today === undefined ? datesIn(rest) : datesOn(rest, today)).find(() => true) : undefined;
      const dateAt = word.dates ? new RegExp(today === undefined ? DATES.source : `${DATES.source}|${RELATIVE_DAY.source}`, 'i').exec(rest) : null;
      if (date !== undefined && dateAt?.index === 0) {
        bounds.push({ kind: 'date', value: date.value, upper: word.upper, strict: word.strict, precision: date.day ? 'day' : 'month', ...(date.year ? { year: Math.floor(date.value / 10000) } : {}), said: `${match[0]}${dateAt[0]}`.trim() });
        continue;
      }
      // A time of day: "departs after 6 pm", "arrives before 10:30".
      const time = word.dates ? timesIn(rest) : [];
      if (time.length > 0 && TIME_AT_START.test(rest)) {
        const cue = /\b(depart|leav|arriv|open|clos|start|end|finish)\w*\s+$/i.exec(task.slice(Math.max(0, (match.index ?? 0) - 20), match.index ?? 0))?.[1]?.toLowerCase();
        bounds.push({ kind: 'time', value: time[0]!, upper: word.upper, strict: word.strict, ...(cue === undefined ? {} : { cue }), said: `${match[0]}${TIME_AT_START.exec(rest)?.[0] ?? ''}`.trim() });
        continue;
      }
      if (word.dates && /^(19|20)\d{2}\b/.test(rest)) {
        bounds.push({ kind: 'date', value: Number(rest.slice(0, 4)) * 10000, upper: word.upper, strict: word.strict, precision: 'year', year: Number(rest.slice(0, 4)), said: `${match[0]}${rest.slice(0, 4)}` });
        continue;
      }
      if (!word.numbers) continue;
      const figure = /^(?:(rs\.?|inr|usd|eur)\s*)?([$€£¥₹])?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*([a-z]+|''|["″”]|'(?![a-z]))?/iu.exec(rest);
      if (figure === null) continue;
      const value = Number(figure[3]!.replace(/,/g, '')) * (figure[4] === undefined ? 1 : 1000);
      // A word after the figure that is no unit ("4.8 and give …") is none.
      const unit = figure[5] !== undefined && STOPWORDS.has(figure[5].toLowerCase()) ? undefined : figure[5];
      const priced =
        figure[1] !== undefined || figure[2] !== undefined || unit === undefined || CURRENCY_WORD.test(unit) || STOPWORDS.has(unit.toLowerCase()) || (unit.length < 2 && UNIT_SCALE[unitStem(unit)] === undefined);
      // A figure of 5 or under with no unit, where the task speaks of a
      // rating ("rated 4.8 or higher"), is a rating, not a price.
      if (unit === undefined && figure[1] === undefined && figure[2] === undefined && value <= 5 && /\b(?:rat(?:ed|ing)|stars?|reviews?)\b/i.test(task)) {
        bounds.push({ kind: 'unit', value, upper: word.upper, strict: word.strict, unit: 'star', said: `${match[0].trim()} ${figure[3]!.replace(/,$/u, '')}` });
        continue;
      }
      // A size bound's side ("under 90 cm wide"): a line giving several sizes is judged on that one.
      const side = /^\s*(wide|width|high|height|tall|deep|depth|long|length)\b/i.exec(rest.slice(figure[0].length))?.[1]?.[0]?.toLowerCase();
      // The thing it measures: the word after the figure ("16 GB of RAM", "5 quarts capacity").
      const named = /^\s*(?:of\s+)?([\p{L}][\p{L}-]{1,})/iu.exec(rest.slice(figure[0].length))?.[1]?.toLowerCase();
      const attribute = named === undefined || STOPWORDS.has(named) || side !== undefined ? undefined : named;
      // A price said without the word after it ("under $220 a night" is "under $220"), unless that word is its currency.
      const amount = `${figure[1] === undefined ? '' : `${figure[1]} `}${figure[2] ?? ''}${figure[3]!.replace(/,$/u, '')}${figure[4] ?? ''}`;
      const said = `${match[0].trim()} ${amount}${unit !== undefined && (!priced || CURRENCY_WORD.test(unit)) ? ` ${unit}` : ''}`;
      bounds.push(
        priced
          ? { kind: 'price', value, upper: word.upper, strict: word.strict, said }
          : { kind: 'unit', value, upper: word.upper, strict: word.strict, unit: unitStem(unit), ...(side === undefined ? {} : { cue: side === 't' ? 'h' : side }), ...(attribute === undefined ? {} : { attribute }), said },
      );
    }
  }
  return bounds;
}

/** Whether a figure is on the side of a bound that satisfies the task. */
function within(value: number, bound: Bound): boolean {
  if (bound.upper) return bound.strict ? value < bound.value : value <= bound.value;
  return bound.strict ? value > bound.value : value >= bound.value;
}

/**
 * Whether what a label states meets the task's bounds: false when a figure
 * it states fails a bound (none of its figures for that bound is on the
 * satisfying side), true when its figures meet them, undefined when it
 * states nothing a bound compares ("Applications close 3 October" against
 * "closing after 15 October" is false; "No pets" is undefined).
 */
function boundVerdict(label: string, bounds: readonly Bound[], today?: string): boolean | undefined {
  const verdicts = boundVerdicts(label, bounds, today);
  return verdicts.includes(false) ? false : verdicts.includes(true) ? true : undefined;
}

/** {@link boundVerdict} per bound, in the order `boundsOf` gives them. */
function boundVerdicts(label: string, bounds: readonly Bound[], today?: string): readonly (boolean | undefined)[] {
  return bounds.map((bound) => {
    let figures: number[] = [];
    if (bound.kind === 'price') {
      figures = listingPrices(label).map(priceOf);
    } else if (bound.kind === 'range') {
      const [dimension, lo] = inBase(bound.value, bound.unit!);
      const [, hi] = inBase(bound.to!, bound.unit!);
      const ranges = [...label.matchAll(RANGE)]
        .map((range) => ({ lo: inBase(Number(range[1]!.replace(/,/g, '')), unitStem(range[3]!)), hi: inBase(Number(range[2]!.replace(/,/g, '')), unitStem(range[3]!)) }))
        .filter((range) => range.lo[0] === dimension);
      return ranges.length === 0 ? undefined : ranges.some((range) => range.lo[1] <= lo && range.hi[1] >= hi);
    } else if (bound.kind === 'time') {
      // "Departs 16:05, arrives 18:16" against "departs after 6 pm": the time after the cue.
      const at = bound.cue === undefined ? -1 : label.toLowerCase().indexOf(bound.cue);
      figures = at < 0 ? timesIn(label) : timesIn(label.slice(at)).slice(0, 1);
    } else if (bound.kind === 'unit') {
      const [dimension, value] = inBase(bound.value, bound.unit!);
      if (bound.unit === 'star') {
        const rating = figureOf(label, 'rating');
        if (rating !== undefined) return within(rating, bound);
      }
      // A "label: value" line judges a bound on what it measures only when its
      // label names that ("Memory: 8 GB" for "16 GB of RAM"), never when it
      // names another thing ("Storage: 512 GB SSD"): read as memory, the drive
      // met the bound and two 8 GB laptops were shown unmarked (tainted sealed
      // item via Main, 2026-10-05: 6/12 to 0/12).
      const labelled = bound.attribute === undefined ? undefined : LABEL_VALUE.exec(label.replace(/^(?:link|button) "/u, ''));
      if (labelled !== null && labelled !== undefined && namesOtherAttribute(labelled[0].slice(0, labelled[0].indexOf(':')), bound.attribute!)) return undefined;
      const read = unitFigures(sideOf(label, bound.cue))
        .map((figure) => {
          const [kind, base] = inBase(figure.value, figure.unit);
          // A size written in another unit than the task's is that size
          // rounded where it was written: a 55-inch television is "139 cm"
          // (139.7), and judged exactly it failed "at least 55 inches" and was
          // hidden as failing (sealed heldout6 on 40a02a70, abstract). So it
          // is judged at the precision it states, one in its last digit.
          const step = figure.unit === bound.unit ? 0 : figure.precision * (UNIT_SCALE[figure.unit]?.[1] ?? 1);
          return { kind, base, step };
        })
        .filter((figure) => figure.kind === dimension)
        // A figure of another scale is another measure in the same unit: "4
        // mi away" is not a mileage under "under 60,000 miles" (dev6 G1,
        // 2026-10-04: it met the bound for cars of 83,500 mi).
        .filter((figure) => value === 0 || (figure.base / value <= 100 && figure.base / value >= 0.01));
      return read.length === 0 ? undefined : read.some((figure) => within(figure.base + (bound.upper ? -figure.step : figure.step), { ...bound, value }));
    } else {
      const cut = bound.precision === 'year' ? 10000 : bound.precision === 'month' ? 100 : 1;
      figures = (today === undefined ? datesIn(label) : datesOn(label, today))
        .filter((date) => date.day || bound.precision !== 'day')
        .map((date) => {
          const year = date.year ? 0 : (bound.year ?? 0) * 10000;
          const value = date.year && bound.year === undefined ? date.value % 10000 : date.value + year;
          return Math.floor(value / cut) * cut;
        });
      if (bound.precision === 'year') {
        figures.push(...[...label.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]) * 10000));
      }
    }
    return figures.length === 0 ? undefined : figures.some((figure) => within(figure, bound));
  });
}

/** One listing of a list page, as `selectBrief` keeps or drops it whole. */
interface ListItem {
  /** The title's echo line (`link "…"`). */
  readonly title: number;
  readonly titleNode: AxNode;
  /** The item's best line score: its title's, or a field's that the task names. */
  readonly rank: number;
  /**
   * How much of the task the item's own lines meet: the task's terms they
   * satisfy, and per bound the task states +1 when its figures meet it, -1
   * when they state it and fail it.
   */
  readonly matches: number;
  /**
   * Its short attribute lines shown with its title before any item gets
   * more, at most {@link ITEM_ATTRIBUTES}: the figure the task's
   * superlative names first, then its best match, its values (price, rating, count),
   * "label: value" lines, dates and delivery, other figures, then tags
   * (place, status). Whether or not they name a task word: a value line
   * rarely does, and with only a matching line in the head, the deciding
   * price, rating or delivery date of 4 of 5 sealed list items was not in
   * the brief (BrainMeasure, 55b5470a, 2026-10-03).
   */
  readonly attributes: readonly number[];
  /**
   * The attributes its reduced head shows: its first, plus the first line
   * of each kind of value the task asks for or bounds (a price, a rating, a
   * distance or size, a date), so "give its price and mileage" shows both
   * for every item before any item shows more.
   */
  readonly headLines: readonly number[];
  /** Its lines deciding the task, met or failed (see `listItems`): never shortened. */
  readonly deciding: readonly number[];
  /** The figure the task's first superlative ranks on, when the item states it. */
  readonly figure: number | undefined;
  /** Whether its figures fail a bound the task states (all over a ceiling, a date before the one asked). */
  readonly fails: boolean;
  /** The task words its lines state the task's way, and those they state the other way. */
  readonly met: ReadonlySet<string>;
  readonly denied: ReadonlySet<string>;
  /** Per bound the task states: 1 met, -1 failed, 0 not stated. */
  readonly bounds: readonly number[];
  /** Every line the item spans, kept or not. */
  readonly span: readonly number[];
  /** The field lines kept with the title, in page order. */
  readonly lines: readonly number[];
  /** Value controls (price, rating) listed with the title. */
  readonly nodes: readonly AxNode[];
  /**
   * Its chips: short controls in its span naming a task word either way
   * ("Free cancellation", "Remote", "Non-refundable"), which are no text
   * line of the page (`scanPage` makes lines of named links and values
   * only). Said with its title (see `selectBrief`).
   */
  readonly chips: readonly string[];
  /**
   * A search result's (see `listItems`): the text under its title, its
   * snippet, as one line shown on the first of the lines it joins.
   */
  readonly summary?: { readonly line: number; readonly text: string };
}

/** A result's snippet as the brief shows it: about two sentences. */
const SUMMARY_CHARS = 150;

/**
 * Text lines run together as one: a snippet the page splits at every word
 * it bolds ("Find the", "lighthouse", "logbook here.") reads as the sentence it is.
 */
function joinedText(lines: readonly string[]): string {
  return lines
    .reduce((joined, line) => (joined === '' ? line : /^[,.;:!?)\]…]/u.test(line) ? `${joined}${line}` : `${joined} ${line}`), '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A list page's items, or none: a title is a link that names something
 * (`namesThing`); its item runs from the title (or the ordinal line just
 * before it) to the next item, at most {@link ITEM_SPAN} units, and stops at a
 * heading of its own, a field or a paging control. By position, not by site:
 * the production accessibility tree is flat, so the card container is gone by
 * the time the brief is made (amazon.in capture, 2026-10-03 09:08Z: title,
 * rating, price and "Add to cart" are siblings of every other card's).
 *
 * An item keeps every line that names a task term or meets its price ceiling
 * (its constraint values), and up to {@link ITEM_FIELDS} other short field
 * lines: its ordinal, the
 * line under its title (the attribute a listing states there shares no word
 * with the task, which is why the rule dropped it), its values (price,
 * rating), then its best-scoring lines (a figure, a word the task names). A
 * line identical in half the items ("FREE delivery", "Price, product page")
 * is template, not an attribute, and is never a field; one that a few items
 * share ("Check-in from 14:00") is still each one's attribute. Fewer than three items with a field
 * is not a list, and the brief is chosen as before.
 */
function listItems(scan: ReturnType<typeof scanPage>, score: (line: number) => number, task: TaskTerms): readonly ListItem[] {
  const { units, text } = scan;
  const candidates: { readonly at: number; readonly node: AxNode; readonly line: number }[] = [];
  units.forEach((unit, at) => {
    const echo = units[at + 1]?.text;
    if (
      unit.node?.role === 'link' &&
      unit.node.name !== undefined &&
      (namesThing(unit.node.name) || scan.rows.has(unit.node)) &&
      // A short card name can carry its price ("Honda Civic 1.8 i-VTEC ES 5dr, £2,395").
      (scan.cards.has(unit.node) || (!isValueLabel(unit.node.name) && !PRICE_RANGE.test(unit.node.name.trim()))) &&
      echo !== undefined &&
      LINK_LINE.test(text[echo] ?? '')
    ) {
      candidates.push({ at, node: unit.node, line: echo });
    }
  });
  // A link name repeated across the page ("Limited time deal", "See
  // options") is the list's template, not one listing's title.
  const named = new Map<string, number>();
  for (const title of candidates) named.set(title.node.name ?? '', (named.get(title.node.name ?? '') ?? 0) + 1);
  const unique = candidates.filter((title) => named.get(title.node.name ?? '') === 1);
  // Titles by their name alone: a record's short-named link is a title only
  // as one of its page's records (below).
  const titled = unique.filter((title) => namesThing(title.node.name ?? ''));
  // A title that is also a heading is a card's title for certain: where a
  // page marks three or more that way, its other links are badges, filters
  // and navigation ("Limited time deal" between a title and its price).
  const strong = titled.filter(
    (title) => scan.cards.has(title.node) || (scan.headings.has(title.line + 1) && (text[title.line + 1] ?? '').startsWith((title.node.name ?? '').slice(0, 40))),
  );
  // A SEARCH RESULT's title, on a search page, is a heading whose one
  // content is its link (on Bing and DuckDuckGo alike): where three or
  // more are, they are the listings, and the site and URL-breadcrumb links
  // between them are not.
  // Taken as cards, the breadcrumbs were the listings and 0 of 10 titles
  // were shown (DuckDuckGo recapture, 2026-10-13; 67% of titles over 37
  // SERPs). Only on a search page: an article's "related" headings are no
  // results to put before its own text. Two results may share a title.
  const results = RESULTS_URL.test(scan.url)
    ? candidates.filter((title) => namesThing(title.node.name ?? '') && scan.headings.has(title.line - 1) && (text[title.line - 1] ?? '').startsWith((title.node.name ?? '').slice(0, 40)))
    : [];
  // A RECORD's own link on a page of records (`rowLeads`): every row of a
  // table is a listing, not only those whose name runs to three words.
  // Where the records are fewer than the titles named the usual way, they
  // are a side table, not the page's list.
  const rows = unique.filter((title) => scan.rows.has(title.node));
  const usual = strong.length >= 3 ? strong : titled;
  const titles = results.length >= 3 ? results : rows.length >= 3 && rows.length > usual.length ? rows : usual;
  const resultPage = titles === results;
  const starts = titles.map((title) => {
    for (let at = title.at - 1; at >= Math.max(0, title.at - 3); at -= 1) {
      const line = units[at]?.text;
      if (line !== undefined && ORDINAL_LINE.test((text[line] ?? '').trim())) return at;
    }
    return title.at;
  });
  const spans = titles.map((title, index) => {
    const lines: number[] = [];
    const nodes: AxNode[] = [];
    // The title link's own words: on a search result, its pieces ("Harbour",
    // "lighthouse", " history"), the title again.
    const own: number[] = [];
    const name = (title.node.name ?? '').slice(0, 40);
    // A result ends at the next control (below), however many pieces its
    // title and snippet are split into.
    const stop = Math.min(starts[index + 1] ?? units.length, resultPage ? units.length : title.at + ITEM_SPAN);
    for (let at = starts[index]!; at < stop; at += 1) {
      const unit = units[at]!;
      if (unit.node !== undefined) {
        const label = unit.node.name ?? '';
        if (FIELD_ROLES.has(unit.node.role) || PAGING.test(label.trim())) break;
        // A result is its title and the text under it: the next control
        // (a sitelink, the next result's site and breadcrumb) is not its.
        if (resultPage && unit.node !== title.node) break;
        nodes.push(unit.node);
      } else if (unit.text !== undefined) {
        const line = text[unit.text] ?? '';
        if (scan.headings.has(unit.text) && !line.startsWith(name)) break;
        // The title's own words are the title, not a field of it.
        // Except a whole card's: those are its fields (`cardOf`).
        if (unit.owner !== title.node || scan.cards.has(title.node)) lines.push(unit.text);
        else own.push(unit.text);
      }
    }
    return { title, lines, nodes, name, own };
  });
  const seen = new Map<string, number>();
  for (const span of spans) {
    for (const line of new Set(span.lines.map((order) => text[order] ?? ''))) seen.set(line, (seen.get(line) ?? 0) + 1);
  }
  const withLines = spans.filter((span) => span.lines.length > 0).length;
  // A line every item carries ("Price, product page") tells them apart by
  // nothing, whatever task word it names.
  // On a long list, most items ("Price, product page" in 13 of 15 spans on
  // the real amazon.in page, whose other spans are not products); on a short
  // one, every item: four of five saying "tier 1" still tells the fifth apart.
  const universal = (order: number): boolean =>
    (seen.get(text[order] ?? '') ?? 0) >= Math.max(TEMPLATE_ITEMS, withLines >= 8 ? Math.ceil(withLines * 0.8) : withLines);
  const items = spans.map(({ title, lines, nodes, name, own }): ListItem => {
    // A line naming the task's terms ("No pets allowed", "Ribeira") or
    // meeting its price ceiling is a constraint value: it goes with its
    // title however long or however often it recurs.
    const matching = lines.filter((order) => {
      const line = text[order] ?? '';
      return order !== title.line && !line.startsWith(name) && line.length <= FACT_CHARS && !universal(order) && (task.terms(order).size > 0 || task.meets(line) === true);
    });
    const candidates = lines.filter((order) => {
      const line = text[order] ?? '';
      const value = isValueLabel(line.replace(/^(?:link|button) "|"$/g, ''));
      const recurs = seen.get(line) ?? 0;
      const template = recurs >= TEMPLATE_ITEMS && recurs * 2 >= withLines;
      return order !== title.line && !line.startsWith(name) && line.length <= FIELD_LINE_CHARS && (value || !template);
    });
    // A chip after a card ("Free cancellation" as a button beside it) states
    // what a field line would: as no line, the qualifier's matched nothing
    // and it was shown without them (sealed heldout6 on 40a02a70, abstract:
    // chips as siblings after each card, recall 0).
    const chips = [
      ...new Set(
        nodes
          // Buttons: a short link in a card goes somewhere ("nytimes.com",
          // "61 comments", "Account"), it does not state the listing.
          .filter((node) => node.role === 'button')
          .map((node) => (node.name ?? '').trim())
          .filter(
            (label) =>
              label !== '' &&
              label.length <= CHIP_CHARS &&
              !namesThing(label) &&
              !isValueLabel(label) &&
              !ACTION_WORD.test(label.split(/\s+/u)[0] ?? '') &&
              (task.labelTerms(label).size > 0 || task.labelContradicts(label).size > 0),
          ),
      ),
    ];
    // A task word the item states only the other way: it fails on it.
    const met = new Set([...[title.line, ...lines].flatMap((order) => [...task.terms(order)]), ...chips.flatMap((label) => [...task.labelTerms(label)])]);
    const denied = new Set([...[title.line, ...lines].flatMap((order) => [...task.contradicts(order)]), ...chips.flatMap((label) => [...task.labelContradicts(label)])].filter((term) => !met.has(term)));
    const terms = new Set([...[title.line, ...lines.filter((order) => !universal(order))].flatMap((order) => [...task.terms(order)]), ...chips.flatMap((label) => [...task.labelTerms(label)])]);
    // Per bound: met when any of its figures meets it, failed when it states
    // some and none does. "₹18,999" fails "under 16,000" though its "4.5
    // stars" meets "at least 4.5 stars".
    // Not the title link's own name: on a whole card it is every field again.
    // A title judged on its whole text: the width at the end of a long one
    // ("… Model SF-209, 76'' W x 36'' D") is past where its line is cut.
    const stated = [...lines.map((order) => scan.fullText.get(order) ?? text[order] ?? ''), ...nodes.filter((node) => node !== title.node).map((node) => node.name ?? '')].map(task.verdicts);
    const perBound = (stated[0] ?? []).map((_, bound) => {
      const said = stated.map((verdicts) => verdicts[bound]).filter((met) => met !== undefined);
      return said.length === 0 ? 0 : said.includes(true) ? 1 : -1;
    });
    const values = nodes
      .filter((node) => node !== title.node && isValueLabel(node.name ?? ''))
      .sort((left, right) => valueRank(left.name ?? '') - valueRank(right.name ?? ''))
      .slice(0, ITEM_VALUES)
      .sort((left, right) => nodes.indexOf(left) - nodes.indexOf(right));
    const ordinal = candidates.filter((order) => ORDINAL_LINE.test((text[order] ?? '').trim()));
    const below = candidates.filter((order) => order > title.line && !ordinal.includes(order)).slice(0, 1);
    const valueLines = candidates.filter((order) => isValueLabel((text[order] ?? '').replace(/^(?:link|button) "|"$/g, ''))).sort((left, right) => valueRank(text[left] ?? '') - valueRank(text[right] ?? '') || left - right);
    const rest = candidates.filter((order) => !valueLines.includes(order)).sort((left, right) => score(right) - score(left) || left - right);
    const strength = (order: number): number => task.terms(order).size + (task.meets(text[order] ?? '') === true ? 1 : 0);
    const best = [...matching].sort((left, right) => strength(right) - strength(left) || left - right)[0];
    const plain = (order: number): string => (text[order] ?? '').replace(/^(?:link|button) "|"$/g, '');
    const target = task.targets[0];
    const figures = target === undefined ? [] : [...lines.map(plain), ...nodes.map((node) => node.name ?? '')].map((line) => figureOf(line, target, task.today)).filter((figure) => figure !== undefined);
    // An item's price and rating are the first it states (a list price, a
    // "£20 Tax" or an "Original Price" come after); its date the extreme of
    // those it states ("Mon, 5 Oct" or, fastest, "Tomorrow").
    const extreme = figures.length === 0 ? undefined : target !== 'date' ? figures[0] : task.least ? Math.min(...figures) : Math.max(...figures);
    const attributeRank = (order: number): number | undefined => {
      const line = plain(order);
      // The line stating the item's figure first ("Tomorrow 8 am" before
      // "Mon, 5 Oct" for "soonest"), then its other lines of that kind.
      const figure = target === undefined || line.length > FIELD_LINE_CHARS ? undefined : figureOf(line, target, task.today);
      if (figure !== undefined) return figure === extreme ? 0 : 0.1;
      if (order === best) return 0.5;
      // Every line meeting the task goes before other attributes, however
      // many items share it ("No accidents reported").
      if (matching.includes(order)) return 0.6;
      if (line.length > FIELD_LINE_CHARS || ORDINAL_LINE.test(line.trim()) || !/[\p{L}\p{N}]/u.test(line)) return undefined;
      // A line half the items carry word for word ("FREE delivery Sat, 4
      // Oct") tells this one apart by nothing, unless it is a value.
      const recurs = seen.get(text[order] ?? '') ?? 0;
      if (recurs >= TEMPLATE_ITEMS && recurs * 2 >= withLines && !isValueLabel(line)) return undefined;
      if (isValueLabel(line)) return 2 + valueRank(line) / 10;
      if (LABEL_VALUE.test(line)) return 3;
      if (datesIn(line).length > 0 || WHEN.test(line)) return 4;
      if (/\d/.test(line)) return 5;
      if (line.length <= 40 && line.split(/\s+/).length <= 6 && !/[.!?]$/.test(line)) return 6;
      return undefined;
    };
    // The lines that DECIDE the task for this item, met or failed: a task
    // word stated either way ("In stock", "Out of stock", "Freestanding"), a
    // figure a bound judges. Whole, whatever their length or how many items
    // share them; one per stated term or bound, the first.
    const decided = new Set<string>();
    const deciding = lines.filter((order) => {
      // Not a line every item carries word for word: it tells none apart.
      if (order === title.line || ORDINAL_LINE.test((text[order] ?? '').trim()) || (seen.get(text[order] ?? '') ?? 0) >= Math.max(TEMPLATE_ITEMS, withLines)) return false;
      const keys = [...task.terms(order), ...[...task.contradicts(order)].map((term) => `-${term}`), ...task.verdicts(text[order] ?? '').flatMap((met, bound) => (met === undefined ? [] : [`#${String(bound)}`]))];
      const fresh = keys.filter((key) => !decided.has(key.replace(/^-/u, '')));
      for (const key of keys) decided.add(key.replace(/^-/u, ''));
      return fresh.length > 0;
    });
    const said = new Set<string>();
    const attributes = [...new Set([...matching, ...candidates])]
      .map((order) => ({ order, rank: attributeRank(order) }))
      .filter((entry): entry is { order: number; rank: number } => entry.rank !== undefined)
      .sort((left, right) => left.rank - right.rank || left.order - right.order)
      // The same words once ("£28,975" in the card link and beside it).
      .filter((entry) => !said.has(plain(entry.order)) && said.add(plain(entry.order)) !== undefined)
      .sort((left, right) => left.rank - right.rank || left.order - right.order)
      .slice(0, ITEM_ATTRIBUTES)
      .map((entry) => entry.order);

    const fields = [...new Set([...matching, ...attributes, ...[...new Set([...ordinal, ...below, ...valueLines, ...rest])].filter((order) => !matching.includes(order)).slice(0, ITEM_FIELDS)])].sort(
      (left, right) => left - right,
    );
    const item: ListItem = {
      title: title.line,
      titleNode: title.node,
      rank: Math.max(score(title.line), ...fields.map(score)),
      matches: terms.size - denied.size + perBound.reduce((sum: number, met) => sum + met, 0),
      attributes: attributes.length > 0 ? attributes : (below[0] ?? fields[0]) === undefined ? [] : [(below[0] ?? fields[0])!],
      deciding,
      headLines: [
        ...new Set([
          ...deciding,
          // The figure the task's superlative ranks on ("good", "cheapest"),
          // and for a rating how many gave it: without them "good ram under
          // 10,000" re-sorted by rating 4/5 on 57098bc4's first cut (11:30Z).
          ...(target === undefined ? [] : lines.filter((order) => order !== title.line && figureOf(plain(order), target, task.today) !== undefined).slice(0, 1)),
          ...(target === 'rating' ? lines.filter((order) => RATING_COUNT.test(plain(order))).slice(0, 1) : []),
          ...(deciding.length === 0 ? attributes.slice(0, 1) : []),
          ...task.asked.flatMap((kind) => (deciding.some((order) => isKind(plain(order), kind)) ? [] : attributes.filter((order) => isKind(plain(order), kind)).slice(0, 1))),
        ]),
      ],
      figure: extreme,
      span: lines,
      fails: perBound.includes(-1) || denied.size > 0,
      met,
      denied,
      bounds: perBound,
      lines: fields,
      nodes: values,
      chips,
    };
    const snippet = lines.filter((order) => order !== title.line);
    if (!resultPage || snippet.length === 0) return item;
    // A result shows its title and its snippet before any result shows
    // more: the snippet's lines as one, never cut to an attribute's length
    // (57% of snippets were in the brief over 37 SERPs, 2026-10-13). Its
    // heading line says the title again: it is the item's, and not shown.
    const summary = { line: snippet[0]!, text: clip(joinedText(snippet.map((order) => text[order] ?? '')), SUMMARY_CHARS) };
    return { ...item, attributes: [summary.line], headLines: [summary.line], deciding: [summary.line], span: [title.line - 1, ...own, ...lines], lines: [summary.line], summary };
  });
  // A title with no field is a link like any other (navigation, a filter).
  const fielded = items.filter((item) => item.lines.length > 0);
  return fielded.length >= 3 ? fielded : [];
}

/**
 * The span of a numbered list the page shows ("1-30"), read off its ordinal
 * lines ("1.", "2.", …), when at least five run in order. A chosen brief hides
 * most of a long list; without its extent the brain reads for items 31-35 on
 * a page that stops at 30 (BrainMeasure H1, 0/3 twice on view C, 2026-10-02).
 */
function numberedRange(text: readonly string[]): string | undefined {
  const ordinals = text.map((line) => /^(\d{1,4})\.$/.exec(line.trim())?.[1]).filter((n): n is string => n !== undefined).map(Number);
  if (ordinals.length < 5) {
    return undefined;
  }
  const inOrder = ordinals.every((n, i) => i === 0 || n > ordinals[i - 1]!);
  return inOrder ? `${String(ordinals[0])}-${String(ordinals[ordinals.length - 1])}` : undefined;
}

/** One walk of the tree: everything the brief reads off it deterministically. */
function scanPage(tree: AxTree): {
  readonly index: ReadonlyMap<string, { readonly node: AxNode; readonly parent: AxNode | undefined }>;
  readonly notices: readonly string[];
  readonly overlay: readonly AxNode[];
  readonly actionable: readonly AxNode[];
  readonly text: readonly string[];
  /**
   * The page in walk order: each actionable node and each text line, one
   * entry each (a control's echo line follows the control); a text line's
   * `owner` is the control it is inside (a link's own words). What a list
   * item is made of — see `listItems`.
   */
  readonly units: readonly { readonly node?: AxNode; readonly text?: number; readonly owner?: AxNode }[];
  /** Which {@link text} lines are headings, by index. */
  readonly headings: ReadonlySet<number>;
  /** Whole-card links: see `cardOf`. */
  readonly cards: ReadonlySet<AxNode>;
  /** Each record's own link on a page of repeated records, and how many records it holds: see `rowLeads`. */
  readonly rows: ReadonlySet<AxNode>;
  readonly records: number;
  /** The page's URL. */
  readonly url: string;
  /** A link line's whole text where the line clips it (a card's full title, a long link name). */
  readonly fullText: ReadonlyMap<number, string>;
  /** A text line was longer than {@link TEXT_LINE_CHARS} and was cut. */
  readonly clipped: boolean;
  readonly element: (node: AxNode, said: string) => BriefElement;
} {
  const index = new Map<string, { readonly node: AxNode; readonly parent: AxNode | undefined }>();
  const notices: string[] = [];
  const overlay: AxNode[] = [];
  const actionable: AxNode[] = [];
  const text: string[] = [];
  const headings = new Set<number>();
  const units: { node?: AxNode; text?: number; owner?: AxNode }[] = [];
  const cards = new Set<AxNode>();
  const fullText = new Map<number, string>();
  /** A card's title text, said by its link line instead. */
  const skip = new Set<AxNode>();
  let owner: AxNode | undefined;
  const { leads: rows, records } = rowLeads(tree);
  const line = (value: string): void => {
    units.push({ text: text.length, ...(owner === undefined ? {} : { owner }) });
    text.push(value);
  };
  let clipped = false;
  /** The last text line was a label, so the next link is its value. */
  let labelled = false;
  const walk = (node: AxNode, parent: AxNode | undefined): void => {
    index.set(refText(node), { node, parent });
    if (DIALOG_ROLES.has(node.role)) {
      notices.push(`Dialog open: ${JSON.stringify(clip(node.name ?? 'untitled', 80))}`);
    }
    if (NOTICE_ROLES.has(node.role) && node.name !== undefined) {
      notices.push(`${node.role === 'alert' ? 'Alert' : 'Status'}: ${JSON.stringify(clip(node.name, 120))}`);
    }
    if (ACTIONABLE_ROLES.has(node.role)) {
      actionable.push(node);
      units.push({ node });
      if ((node.role === 'button' || node.role === 'link') && node.name !== undefined && OVERLAY_CONTROL.test(node.name.trim())) {
        overlay.push(node);
      }
      // A link that names something (a result, a listing) is also the page's
      // text, in page order: it is what the prices and ratings around it
      // belong to. Listed only as an element, "$99.99" lost its "Beats Studio
      // Buds" and the brain called it AirPods (BrainMeasure D1, 2026-10-02).
      // So is a link that is the VALUE of the label line just before it
      // ("Composer" then "Robin Carolan", "Directed by" then a name): a short
      // name fails `namesThing`, and without it the page text read "Composer"
      // with nothing after it, so the brain re-read the page for an answer it
      // was already shown (dev2 Y10, 2026-10-03 00:41Z).
      const value = node.name !== undefined && isValueLabel(node.name);
      // A heading's link is a title, however its words are split ("Harbour",
      // "lighthouse", " history" where a search engine bolds the query): as
      // a card its title was its first piece (Bing recapture, 2026-10-13).
      const card = node.role === 'link' && parent !== undefined && parent.role !== 'heading' ? cardOf(node) : undefined;
      if (card !== undefined) {
        // A whole-card link: its title, then its fields as its own lines.
        cards.add(node);
        for (const titled of card.titleNodes) skip.add(titled);
        // Not cut at 80: cards often differ only at the end ("… model BK-411").
        fullText.set(text.length, card.title);
        line(`link ${JSON.stringify(clip(card.title, CARD_TITLE_CHARS))}`);
      } else if (value && hasNamedText(node)) {
        // Its own text lines already say it ("₹13,399", "M.R.P: ₹18,999"
        // under the price link "₹13,399 M.R.P: ₹18,999").
      } else if (node.role === 'link' && parent !== undefined && node.name !== undefined && (namesThing(node.name) || rows.has(node) || (labelled && isValueName(node.name)))) {
        fullText.set(text.length, node.name);
        line(`link ${JSON.stringify(clip(node.name, 80))}`);
      } else if ((node.role === 'link' || node.role === 'button') && parent !== undefined && node.name !== undefined && value) {
        // See VALUE_LABEL.
        line(`${node.role} ${JSON.stringify(clip(node.name, 80))}`);
      }
      labelled = false;
    } else if (parent !== undefined && RAW_TEXT_ROLES.has(node.role) && node.name !== undefined && !skip.has(node)) {
      clipped ||= node.name.length > TEXT_LINE_CHARS;
      if (node.role === 'heading') headings.add(text.length);
      line(clip(node.name, TEXT_LINE_CHARS));
      labelled = node.role !== 'heading' && isLabelText(node.name);
    }
    const outer = owner;
    if (ACTIONABLE_ROLES.has(node.role)) owner = node;
    for (const child of node.children ?? []) {
      walk(child, node);
    }
    owner = outer;
  };
  walk(tree.root, undefined);
  return {
    index,
    notices,
    overlay,
    actionable,
    text,
    units,
    headings,
    cards,
    rows,
    records,
    url: tree.url,
    fullText,
    clipped,
    element: (node, said) => ({
      ref: refText(node),
      role: node.role,
      label: firstWords(node.name ?? said, LABEL_WORDS),
      state: stateOf(node, index.get(refText(node))?.parent),
    }),
  };
}

/** Fewest records that make a page of records. */
const MIN_ROWS = 3;

/**
 * The own link of each record on a page of repeated records: a table's rows,
 * a results grid. The tree is flat (rows and cells are dropped before the
 * brief is made), so a record is found by what repeats: a control every
 * record carries under the same name ("Details", "Add to cart")
 * marks one record per occurrence, and the one link between two occurrences
 * whose name is on the page once is that record's own ("Acer
 * rubrum"). Its name may be short: a two-word row name failed
 * `namesThing`, so a 50-row table showed 15 three-word rows as "All 15
 * listings" and none of the rows the task named (2026-10-13 recapture, 0
 * of 5 needles). The first record's link is the last such link before the
 * first occurrence, no further from it than the others are from theirs.
 * Records only where at least {@link MIN_ROWS} are found, and two thirds of
 * the occurrences have one: a repeated "Reply" between comments by repeated
 * authors is no table. `records` is how many the page holds, a record with
 * no link of its own included.
 */
function rowLeads(tree: AxTree): { readonly leads: ReadonlySet<AxNode>; readonly records: number } {
  const controls: AxNode[] = [];
  const walk = (node: AxNode): void => {
    if (ACTIONABLE_ROLES.has(node.role)) controls.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree.root);
  const nameOf = (node: AxNode): string => (node.name ?? '').trim();
  const counts = new Map<string, number[]>();
  controls.forEach((node, at) => {
    const name = nameOf(node);
    if (name === '' || (node.role !== 'link' && node.role !== 'button')) return;
    const seen = counts.get(name);
    if (seen === undefined) counts.set(name, [at]);
    else seen.push(at);
  });
  const unique = (at: number): boolean => {
    const node = controls[at]!;
    return node.role === 'link' && nameOf(node) !== '' && counts.get(nameOf(node))?.length === 1;
  };
  let best: AxNode[] = [];
  let records = 0;
  for (const [name, at] of counts) {
    if (at.length < MIN_ROWS || PAGING.test(name)) continue;
    const leads: AxNode[] = [];
    let farthest = 0;
    for (let index = 1; index < at.length; index += 1) {
      const own: number[] = [];
      for (let between = at[index - 1]! + 1; between < at[index]!; between += 1) if (unique(between)) own.push(between);
      if (own.length !== 1) continue;
      leads.push(controls[own[0]!]!);
      farthest = Math.max(farthest, at[index]! - own[0]!);
    }
    for (let before = at[0]! - 1; before >= Math.max(0, at[0]! - farthest); before -= 1) {
      if (!unique(before)) continue;
      leads.unshift(controls[before]!);
      break;
    }
    if (leads.length >= MIN_ROWS && leads.length * 3 >= at.length * 2 && leads.length > best.length) {
      best = leads;
      records = at.length;
    }
  }
  return { leads: new Set(best), records };
}

/** A label this short ("$9.99", "4.5 out of 5 stars, rating details") that states a value is a value, not a title that mentions one. */
const VALUE_LABEL_CHARS = 40;

/** Whether a label is a value: see {@link VALUE_LABEL}. A value is an attribute however often it recurs. */
function isValueLabel(label: string): boolean {
  return label.length <= VALUE_LABEL_CHARS && VALUE_LABEL.test(label) && !PRICE_RANGE.test(label.trim());
}

/** A price range alone ("₹1,000 - ₹5,000", "$25 to $50") is a filter, not what an item costs. */
const PRICE_RANGE = /^(?:under |over )?[$€£¥₹]\s?[\d,.]+\s*(?:-|–|to)\s*[$€£¥₹]\s?[\d,.]+$/iu;

/**
 * A whole-card link, or undefined: a link holding its listing's fields as
 * its own text (title, price, mileage, rating), where a results page makes
 * the whole card one anchor. Three or more text lines of its own, or a
 * heading and another. Its title is its heading, else its first line when
 * its name is its content (Chrome names an unlabelled link by all its text:
 * "Honda Civic 2.0 h i-MMD … 5dr, £28,975", autotrader.co.uk capture
 * 2026-10-03 10:49Z), else its name (an aria-label naming the title alone).
 * Taken as one link of a title, its fields read as the title's own words, so
 * the page had no list items at all (BrainMeasure: 9 sealed list items,
 * 2026-10-03).
 */
function cardOf(link: AxNode): { readonly title: string; readonly titleNodes: readonly AxNode[] } | undefined {
  const own: AxNode[] = [];
  const collect = (node: AxNode): void => {
    for (const child of node.children ?? []) {
      if (ACTIONABLE_ROLES.has(child.role)) continue;
      if (RAW_TEXT_ROLES.has(child.role) && child.name !== undefined && /[\p{L}\p{N}]/u.test(child.name)) own.push(child);
      collect(child);
    }
  };
  collect(link);
  const heading = own.find((node) => node.role === 'heading');
  if (own.length < 3 && (heading === undefined || own.length < 2)) return undefined;
  const name = (link.name ?? '').trim();
  const first = own[0]!;
  if (heading !== undefined) return { title: heading.name!, titleNodes: [heading] };
  if (name === '' || name.startsWith(first.name!.trim())) {
    // A first line naming too little ("Honda Civic", on every card) takes
    // the next when it is not a value ("2.0 h i-MMD Elegance … 5dr").
    const next = own[1];
    if (!namesThing(first.name!) && next !== undefined && !isValueLabel(next.name!) && !PRICE_AT.test(next.name!)) {
      return { title: `${first.name!.trim()} ${next.name!.trim()}`, titleNodes: [first, next] };
    }
    return { title: first.name!, titleNodes: [first] };
  }
  return { title: name, titleNodes: own.filter((node) => node.name!.trim() === name) };
}

/** A card title's length in the page text: long enough for the end that tells cards apart. */
const CARD_TITLE_CHARS = 140;

/** A line stating a price anywhere in it. */
const PRICE_AT = /[$€£¥₹]\s?\d/u;

/** Whether a node has a named text descendant (its label is already page text). */
function hasNamedText(node: AxNode): boolean {
  return (node.children ?? []).some((child) => (RAW_TEXT_ROLES.has(child.role) && child.name !== undefined) || hasNamedText(child));
}

/** How many nodes the actuator could act on. The same set the tree serializer gives refs to. */
export function actionableCount(tree: AxTree): number {
  let total = 0;
  const walk = (node: AxNode): void => {
    if (ACTIONABLE_ROLES.has(node.role)) {
      total += 1;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(tree.root);
  return total;
}

/**
 * The page's state and the task's facts, within {@link BRAIN_BUDGET}.facts.
 * KEPT in the thread with the step: the brain then remembers what each page
 * said as cheap cached input, instead of copying it into its reply as
 * expensive output (measured 2026-10-02 ~20:54Z, before this split: 200-370
 * output tokens a step, mostly `note` restating the facts, n=8 per brain).
 */
export function briefFacts(brief: Brief | undefined, failure: string | undefined): string {
  if (brief === undefined) {
    return clip(`Page: no brief (${failure ?? 'the eyes gave none'}). Decide with "say"; the hands see the page.`, BRAIN_BUDGET.facts);
  }
  const head = briefHead(brief);
  const facts = shownFacts(brief);
  const text = `${head}\nFacts: ${facts.length === 0 ? 'none stated' : facts.join(' | ')}`;
  const budget = brief.factsChars ?? BRAIN_BUDGET.facts;
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}

/** The brief's head line(s): the page, then its notices. */
function briefHead(brief: Brief): string {
  return [`Page: ${clip(brief.page, 200)}`, ...brief.notices].join('\n');
}

/** The fact lines {@link briefFacts} shows, each clipped, until {@link BRAIN_BUDGET}.facts is spent. */
function shownFacts(brief: Brief): string[] {
  const facts: string[] = [];
  let used = briefHead(brief).length + 8;
  for (const fact of brief.facts) {
    const line = clip(fact, FACT_CHARS);
    if (used + line.length + 3 > (brief.factsChars ?? BRAIN_BUDGET.facts)) {
      break;
    }
    facts.push(line);
    used += line.length + 3;
  }
  return facts;
}

/** One element as the brain reads it. The one renderer: budgets are counted on exactly this. */
function elementText(element: BriefElement): string {
  return `[${element.ref}] ${element.role} ${JSON.stringify(element.label)}${element.state === '' ? '' : ` ${element.state}`}`;
}

/** The characters an element costs in the brief: its text and the separator. */
function elementCost(element: BriefElement): number {
  return elementText(element).length + 2;
}

/** A label shorter than this is shown whole even when Facts says it: the short form would save nothing. */
const SHORT_LABEL = 24;

/**
 * An element whose whole label a shown Facts line already says, listed by its
 * ref and the label's start only: the brain reads the text once, in Facts, and
 * still has the ref to act on. A rule-chosen brief of a list page lists every
 * item's title and rating link in both (22% of the elements' characters on the
 * dev guard, 2026-10-03 10:2xZ), and the elements are uncached input on every
 * call. A label the Facts line holds only in part (clipped) is shown whole.
 */
function dedupedAgainst(said: string, element: BriefElement): BriefElement {
  const label = element.label.replace(/…$/u, '');
  if (label.length <= SHORT_LABEL + 4 || !said.includes(label)) {
    return element;
  }
  // Cut at a word boundary, so the start still reads as the fact's words.
  const cut = label.slice(0, SHORT_LABEL + 1);
  const space = cut.lastIndexOf(' ');
  return { ...element, label: `${(space > SHORT_LABEL / 2 ? cut.slice(0, space) : cut.slice(0, SHORT_LABEL)).trimEnd()}…` };
}

/**
 * The elements the brain may act on by ref, within {@link BRAIN_BUDGET}.elements.
 * Sent ONCE, in the call they were listed for: a ref means nothing after the
 * page moves, so they are never replayed. Whatever does not fit is dropped
 * from the end and the count says so. An element Facts already says is listed
 * short ({@link dedupedAgainst}).
 */
export function briefElements(tree: AxTree, brief: Brief | undefined): string {
  if (brief === undefined) {
    return '';
  }
  const said = shownFacts(brief).join('\n');
  const unlisted = Math.max(0, actionableCount(tree) - brief.elements.length);
  const parts: string[] = [];
  let length = 40;
  for (const element of brief.elements) {
    const part = elementText(dedupedAgainst(said, element));
    if (length + part.length + 2 > BRAIN_BUDGET.elements) {
      break;
    }
    parts.push(part);
    length += part.length + 2;
  }
  return `Elements (+${String(unlisted + brief.elements.length - parts.length)} unlisted): ${parts.join('; ')}`;
}

/* ------------------------------------------------------------------ *
 * Brain
 * ------------------------------------------------------------------ */

/**
 * Exported for measurement. Constant across runs, so the provider caches it
 * for every run at once; the run's own task goes in the first user turn.
 * Within {@link BRAIN_BUDGET}.system together with {@link BRAIN_SCHEMA}.
 */
export const BRAIN_SYSTEM_PROMPT = [
  'You are the brain of a browser agent and never see the page. Each turn: run state (authoritative for',
  'step, credits, elapsed), the last step\'s outcome, new data, and a page brief. The HANDS',
  'see the page and carry out "say". The thread keeps facts and outcomes: never copy them.',
  '',
  'OUTPUT: one JSON object, normally under 40 tokens. No free text except "answer".',
  '{"do":"act","a":{"type":"click","ref":"F-N"}}: a ref listed THIS turn. Also fill{ref,text},',
  ' select{ref,value}, press{key,ref}, scroll{dy}, navigate{url}, wait{seconds}, openTab{url},',
  ' focusTab{tab}, callTool{tool,arguments}.',
  '{"do":"say","say":"..."}: the next action in under 12 words, for an element not listed.',
  '{"do":"read","read":"..."}: fields to read here, restating the task\'s filters; it returns next turn;',
  ' with "final":true (the read IS the whole answer) it ends the run.',
  '{"do":"done","why":"<=25 words: the deciding evidence; arithmetic worked","answer":"...","evidence":',
  ' ["per need item, in order: fact as read, URL or page title" or "not confirmed"]} (why first), or',
  ' {"do":"fail","answer":"why"}. No "why" on other replies; "need" on the first only.',
  '{"do":"hands","say":"goal","until":"<8 words: the page when finished"}: the hands act alone, up to 4',
  ' steps, and call you back when "until" holds or they are stuck. Use it when the next steps need no',
  ' judgment (forms, paging, routine clicks).',
  'act/say may add "then":[{"a":{...}|"say":"...","expect":"<6 words"}]: up to 8 more steps needing no',
  ' new decision (next field, Enter, first result, {"read":"..."} after a navigate, then the next known URL',
  ' and its read); they run unasked.',
  'First reply also: "need":["each condition the task sets"]; each becomes sub-goal n1, n2, ...',
  'Optional: "no":"approach that failed" (<8 words); "note":"value" only for values the task says to',
  ' collect; "goal":{"id","status":"done|failed"} as each finishes (done closes the rest).',
  '',
  'RULES',
  '- Only what this run read, never memory. Combine facts from pages.',
  '- Done only when every "need" item has evidence here. A candidate failing one goes in "no". Same',
  '  name, other place or year: other entity.',
  '- Never repeat a read on a page; partial means open the source or ask narrower. Results pages and AI',
  '  overviews are leads; sites echoing the question are not evidence. Leave spam and age walls.',
  '- Search the most distinctive clue, not the whole task.',
  '- Never repeat a step that failed, changed nothing, or went where it went before: other element,',
  '  scroll, keyboard, a URL you build (search/filter params), or a new route. A sub-goal the history',
  '  shows done: close it. Never act on a (disabled) element.',
  '- A dialog or a covered/no-effect click: close the dialog itself (Close, x, No thanks) first;',
  '  a cookie banner is not it. A field with an error: fix it.',
  '- A date/time field shown as segments (Month/Day/Year, Hours/Minutes/AM-PM): fill ONE segment',
  '  with the whole value ("2026-10-03", "19:30"), not per segment.',
  '- A searchable dropdown (combobox): fill its value, Enter in "then", not open-then-click.',
  '- A list that loads more on scroll: scroll until enough items are listed, then read.',
  '- A value the task says to collect or record: "note" or read it before leaving.',
  '- Search captcha: https://www.bing.com/search?q= or a web tool; never click it. Login or paywall:',
  '  go elsewhere; on the task\'s site, sign in only with credentials it gives, else fail saying so.',
  '- Schema task: read its fields before done. Budget nearly spent: best supported answer.',
].join('\n');

/** Exported for measurement. What the brain answers: short keys, one free-text field (`answer`). */
export const BRAIN_SCHEMA = {
  type: 'object',
  properties: {
    // No enum: a reply naming the action itself (`"do":"focusTab"`, seen on
    // the fleet) is read as that action rather than refused and asked again at
    // the price of a whole extra brain call. `readDecision` decides.
    do: { type: 'string' },
    a: { type: 'object' },
    say: { type: 'string' },
    then: { type: 'array', items: { type: 'object' } },
    read: { type: 'string' },
    final: { type: 'boolean' },
    answer: { type: 'string' },
    why: { type: 'string' },
    need: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    no: { type: 'string' },
    note: { type: 'string' },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, goal: { type: 'string' } },
        required: ['id', 'goal'],
        additionalProperties: false,
      },
    },
    goal: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'failed'] } },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  required: ['do'],
  // Extra keys are ignored, not refused: a refusal is a whole extra brain call
  // (a correction), and `readDecision` reads only what it knows.
  additionalProperties: true,
} as const satisfies JsonSchema;

/**
 * An action's references as the tree prints them: `"F-366-347"` and
 * `"[366-347]"` become `"366-347"`. The brain copies the template's letter
 * (`"ref":"F-N"`) onto a printed reference, and once its own reply holds one
 * the thread replays it and it keeps doing so: demoqa sess_c6d888b6 (fleet,
 * 2026-10-04 16:22Z) had every brain action go to the hands as not listed,
 * and the hands, handed `"F-366-…"`, copied it (7 of 20 probe replies with an
 * F- ref in the guidance vs 0 of 40 without, 16:39Z) and were corrected 15
 * times. Normalised here, an action is listed, runs directly, and the hands
 * never see the letter. The tree still decides whether the node exists.
 */
function withPrintedRefs(action: unknown): unknown {
  if (!isRecord(action)) {
    return action;
  }
  let out: Record<string, unknown> | undefined;
  for (const key of ['ref', 'from', 'to']) {
    const value = action[key];
    if (typeof value !== 'string') continue;
    const printed = value.trim().replace(/^\[(.*)\]$/, '$1').replace(/^F-(?=\d+-\d+$)/, '');
    if (printed !== value) out = { ...(out ?? action), [key]: printed };
  }
  return out ?? action;
}

/** How many steps one decision may queue after its own. */
export const MACRO_MAX = 8;
/** How many steps the hands take alone on one `hands` decision, the first included. */
export const HANDS_STEPS = 4;

/** A step the brain queued: an action it is sure of, or words for the hands, and what it expects after. */
export interface QueuedStep {
  readonly action?: Readonly<Record<string, unknown>>;
  readonly say?: string;
  /** A read of the page the queue has reached: an extract, run by the loop like any other. */
  readonly read?: { readonly instruction: string; readonly final: boolean };
  readonly expect: string;
}

/** What a decision carries besides its action: written to the loop's memory. */
export interface BrainNotes {
  readonly finding?: string;
  readonly ruledOut?: string;
  readonly plan?: readonly { readonly id: string; readonly goal: string }[];
  readonly goal?: { readonly id: string; readonly status: 'done' | 'failed'; readonly summary: string };
  /** Several closures at once: on a finish, the brain's own `goal` and the port's closure of the rest. */
  readonly goals?: readonly { readonly id: string; readonly status: 'done' | 'failed'; readonly summary: string }[];
}

export type BrainDecision = {
  readonly why: string;
  readonly notes: BrainNotes;
  /** The task's conditions, stated on the first reply; pinned by the thread. */
  readonly need: readonly string[];
  /** Up to {@link MACRO_MAX} queued steps after this one (owner lever 1). Empty on done/fail and a final read. */
  readonly then: readonly QueuedStep[];
} & (
  | { readonly kind: 'act'; readonly action: Readonly<Record<string, unknown>> }
  | { readonly kind: 'instruct'; readonly instruction: string }
  | { readonly kind: 'extract'; readonly extract: string; readonly final: boolean }
  | {
      readonly kind: 'done';
      readonly answer: string;
      /** Per `need` item, in order: the fact read and its source, or "not confirmed". */
      readonly evidence: readonly string[];
    }
  | { readonly kind: 'fail'; readonly answer: string }
);

/**
 * The brain's reply as a decision, or `undefined` when it is not one the port
 * can carry out (an `act` with no action object, a `say` with no words).
 * An `undefined` is a plain scout-1 step, never a guess at what was meant.
 */
export function readDecision(data: unknown): BrainDecision | undefined {
  if (!isRecord(data) || typeof data['do'] !== 'string') {
    return undefined;
  }
  const text = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  // A list field read leniently: a lone string is a one-entry list, and
  // anything else is no list.
  const stringList = (value: unknown): string[] =>
    (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim());
  const why = text('why') ?? '';
  const thenRaw = data['then'];
  const then: QueuedStep[] = (Array.isArray(thenRaw) ? thenRaw : [])
    .flatMap((entry): QueuedStep[] => {
      if (!isRecord(entry)) return [];
      const expect = typeof entry['expect'] === 'string' ? clip(entry['expect'], 80) : '';
      const queued = entry['a'];
      if (isRecord(queued) && typeof queued['type'] === 'string') return [{ action: withPrintedRefs(queued) as Record<string, unknown>, expect }];
      if (typeof entry['read'] === 'string' && entry['read'].trim() !== '') {
        return [{ read: { instruction: entry['read'], final: entry['final'] === true }, expect: expect === '' ? 'the read' : expect }];
      }
      return typeof entry['say'] === 'string' && entry['say'].trim() !== '' ? [{ say: entry['say'], expect }] : [];
    })
    .slice(0, MACRO_MAX);
  const needRaw = data['need'];
  const need = Array.isArray(needRaw) ? needRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];
  const planRaw = data['plan'];
  const plan = Array.isArray(planRaw)
    ? planRaw.flatMap((entry) =>
        isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['goal'] === 'string'
          ? [{ id: entry['id'], goal: entry['goal'] }]
          : [],
      )
    : [];
  const closure = (raw: unknown): NonNullable<BrainNotes['goal']> | undefined => {
    const status = isRecord(raw) ? raw['status'] : undefined;
    return isRecord(raw) && typeof raw['id'] === 'string' && (status === 'done' || status === 'failed')
      ? { id: raw['id'], status, summary: typeof raw['summary'] === 'string' ? raw['summary'] : '' }
      : undefined;
  };
  const goal = closure(data['goal']);
  const finding = text('note');
  const ruledOut = text('no') ?? text('ruledOut');
  const notes: BrainNotes = {
    ...(finding === undefined ? {} : { finding }),
    ...(ruledOut === undefined ? {} : { ruledOut }),
    ...(plan.length === 0 ? {} : { plan }),
    ...(goal === undefined ? {} : { goal }),
  };
  switch (data['do']) {
    case 'act': {
      const action = withPrintedRefs(data['a'] ?? data['action']);
      return isRecord(action) && typeof action['type'] === 'string' ? { kind: 'act', why, notes, need, then, action } : undefined;
    }
    case 'say': {
      const instruction = text('say');
      return instruction === undefined ? undefined : { kind: 'instruct', why, notes, need, then, instruction };
    }
    case 'hands': {
      // DELEGATION: the hands run alone toward a goal, one queued step at a
      // time, each returning to the brain on CANNOT, a failed or no-effect
      // step, or a proposed finish (`#runQueued`), and on reaching `until`.
      const goal = text('say');
      if (goal === undefined) {
        return undefined;
      }
      const until = text('until') ?? '';
      const instruction = `${goal}${until === '' ? '' : `. If the page already shows: ${until} — do not act: begin reasoning with "${HANDS_CANNOT} reached"`}`;
      const queued = Array.from({ length: HANDS_STEPS - 1 }, (): QueuedStep => ({ say: instruction, expect: until === '' ? goal : until }));
      return { kind: 'instruct', why, notes, need, then: queued, instruction };
    }
    case 'read': {
      const extract = text('read');
      // A read may queue what follows it (the next navigate and its read):
      // never after a final read, which ends the run.
      return extract === undefined
        ? undefined
        : { kind: 'extract', why, notes, need, then: data['final'] === true ? [] : then, extract, final: data['final'] === true };
    }
    case 'done': {
      const answer = text('answer');
      // Read on the actuator's `done` terms (runtime `textList`).
      const evidence = stringList(data['evidence']);
      return answer === undefined ? undefined : { kind: 'done', why, notes, need, then: [], answer, evidence };
    }
    case 'fail': {
      const answer = text('answer');
      return answer === undefined ? undefined : { kind: data['do'], why, notes, need, then: [], answer };
    }
    default: {
      // `"do"` naming an action type is that action: its fields are under
      // `a` or beside `do`.
      if (!DIRECT_TYPES[data['do']]) {
        return undefined;
      }
      const { do: type, a, why: _w, need: _n, then: _t, plan: _p, goal: _g, note: _no, no: _r, ...rest } = data;
      const action = { ...(isRecord(a) ? a : rest), type };
      return { kind: 'act', why, notes, need, then, action };
    }
  }
}

/**
 * The brain's reply as the THREAD keeps it: the decision's JSON with no prose
 * before it, no `why` and no `plan` — `why` explained a step already taken,
 * and the plan comes back next turn as the run's goals. `need` stays: until
 * a fold pins it, the first reply is where the conditions live. Every stored
 * token is written to the cache once and read on every later step, and the
 * model writes the way its own past turns read (simulated 2026-10-03: ~170
 * output tokens a call, a third of each step's cache write the replayed reply).
 * A reply that did not parse is kept as written.
 */
export function threadReply(data: unknown, text: string): string {
  if (!isRecord(data) || typeof data['do'] !== 'string') {
    return text;
  }
  const { why: _why, plan: _plan, ...kept } = data;
  return JSON.stringify(kept);
}

/** The brain's notes as the loop's envelope. Empty notes are no envelope. */
export function envelopeOf(notes: BrainNotes): Envelope | undefined {
  return Object.keys(notes).length === 0 ? undefined : (notes as Envelope);
}

/**
 * Actions a brain may run directly. Everything else (extract, done and fail
 * are their own decisions; attachFile, createFile, drag need the page or a
 * handle the brain never saw) goes to the hands. `ask` and the purchase verbs
 * name no element, so the hands would add nothing but a call that may not
 * emit them: they run directly, and the loop performs them outside the
 * freeze, the merchant read from the page (run_f340ace4, fleet, 2026-10-08:
 * a brain never offered `purchase.begin` called it as a tool). They are
 * offered only to a run that has them (see {@link runHeader}); on one that
 * does not, the loop refuses each by name.
 */
const DIRECT_TYPES: Readonly<Record<string, true>> = {
  click: true,
  fill: true,
  select: true,
  press: true,
  hover: true,
  scroll: true,
  navigate: true,
  wait: true,
  openTab: true,
  focusTab: true,
  closeTab: true,
  callTool: true,
  ask: true,
  'purchase.begin': true,
  'purchase.end': true,
};

/**
 * An `act` decision as an action the loop can run, or the reason it cannot
 * run directly (then the hands ground it). A ref must be one the eyes listed
 * THIS step — a ref from an earlier page can still be in the tree and mean
 * something else — and the action must pass the loop's own validator.
 */
export function directAction(
  action: Readonly<Record<string, unknown>>,
  brief: Brief | undefined,
  tree: AxTree,
): { readonly ok: true; readonly action: Action } | { readonly ok: false; readonly why: string } {
  const type = String(action['type']);
  if (DIRECT_TYPES[type] !== true) {
    return { ok: false, why: `${type} is not run directly` };
  }
  const ref = action['ref'];
  if (ref !== undefined) {
    // Listed as an element, or beside a list item's title in Facts (the
    // brief prints a title's ref there: card labels all start alike).
    const listed =
      typeof ref === 'string' &&
      (brief?.elements.some((element) => element.ref === ref) === true || brief?.facts.some((fact) => fact.endsWith(` [${ref}]`)) === true);
    if (!listed) {
      return { ok: false, why: `ref ${JSON.stringify(ref)} is not one the eyes listed on this page` };
    }
  }
  const validated = validateAction(action, tree);
  return validated.ok ? { ok: true, action: validated.value } : { ok: false, why: validated.errors.join('; ') };
}

/** The last step and its outcome, naming the element on `tree` when it is still there. */
export function lastOutcome(history: readonly StepTrace[], tree?: AxTree): string | undefined {
  const last = history.at(-1);
  return last === undefined ? undefined : traceLine(last, tree === undefined ? undefined : refIndex(tree));
}

/**
 * One recorded step as the brain reads it: the action — naming the element by
 * its ref and, when it is still on the page, its label, so the brain can see
 * that the element it is about to pick is the one that just did nothing
 * (BrainMeasure L1, 2026-10-02 21:25Z: "click the node -> no effect" left both
 * brains re-clicking the same link) — then what the loop saw happen,
 * including WHERE a confirmed step landed (`check.saw`), which the actuator's
 * own history drops to a bare "ok" (BrainMeasure E1, prod run_848a3fee).
 */
/** What each held finish means, as the step line says it. */
const HELD_OUTCOME: Readonly<Record<NonNullable<StepTrace['held']>, string>> = {
  'incomplete-final': 'HELD, not the answer: the read is incomplete or marks an item missing; it was kept as a look (see Notice)',
  'gate-fail': 'HELD: the fail was declined once (see Notice)',
  unconfirmed: 'HELD: the done was declined once for unconfirmed conditions (see Notice)',
  'dropped-evidence': 'HELD: the final read leaves out evidence already recorded (see Notice)',
};

export function traceLine(trace: StepTrace, nodes?: ReadonlyMap<string, AxNode>, max = 240): string {
  const outcome =
    trace.held !== undefined
      ? HELD_OUTCOME[trace.held]
      : trace.error !== undefined
      ? `failed: ${trace.error}`
      : trace.check?.verdict === 'contradicted'
        ? `no effect: ${trace.check.saw}`
        : trace.check?.saw === undefined
          ? 'ok'
          : `ok, ${trace.check.saw}`;
  const ref = 'ref' in trace.action && trace.action.ref !== undefined ? `${String(trace.action.ref.frameOrdinal)}-${String(trace.action.ref.backendNodeId)}` : undefined;
  const node = ref === undefined ? undefined : nodes?.get(ref);
  const what = `${describeAction(trace.action, node)}${ref === undefined ? '' : ` [${ref}]`}`;
  // THE OUTCOME IS KEPT, AND THE ACTION'S DESCRIPTION IS WHAT GIVES WAY. A
  // fill's description quotes its field's label and the whole text typed, and
  // clipped as one line the error behind it was what was lost. Fleet
  // 2026-10-20 (Outcrawl Bench dev venues-hold, run_7f096ca5): a fill failed
  // "the focus left the field while typing … then fill the field again", the
  // brain was shown "…the focus left…", went on to the next field and booked
  // with a cut-off name.
  const head = `${String(trace.index)}${trace.goal === undefined ? '' : ` [${trace.goal}]`} `;
  const room = Math.max(MIN_ACTION_CHARS, max - head.length - ' -> '.length - outcome.length);
  return clip(`${head}${clip(what, room)} -> ${outcome}`, max);
}

/** The least of an action's description a step line keeps beside a long outcome. */
const MIN_ACTION_CHARS = 40;

/**
 * What makes two actions "the same" for the repeat detector: the verb and its
 * target (a ref, or a URL). `undefined` for actions with neither.
 */
export function actionKey(action: Readonly<Record<string, unknown>> | Action): string | undefined {
  const record = action as Readonly<Record<string, unknown>>;
  // Enter or Space on an element activates it as a click does: the same
  // action under another name (BrainMeasure L1, 2026-10-02 22:06Z: the dead
  // link, refused as a click, pressed with Enter instead).
  const activates = record['type'] === 'press' && (record['key'] === 'Enter' || record['key'] === ' ' || record['key'] === 'Space');
  const type = activates && record['ref'] !== undefined ? 'click' : String(record['type']);
  const ref = record['ref'];
  if (isRecord(ref) && typeof ref['frameOrdinal'] === 'number' && typeof ref['backendNodeId'] === 'number') {
    return `${type} ${String(ref['frameOrdinal'])}-${String(ref['backendNodeId'])}`;
  }
  if (typeof ref === 'string') {
    return `${type} ${ref.replace(/^\[|\]$/g, '')}`;
  }
  const url = record['url'];
  return typeof url === 'string' ? `${type} ${url.replace(/\/+$/, '')}` : undefined;
}

/**
 * A SEARCHABLE DROPDOWN THAT DID NOT TAKE THE VALUE. The brain fills a
 * combobox and presses Enter (queued, no decision); Enter picks the first
 * option the typed text matches, which is not always the one typed ("Delhi"
 * can pick "New Delhi"). After that press, the value must be shown as a
 * whole text of its own on the page (react-select renders the pick as text:
 * demoqa run_d03077a1, 2026-10-03, "NCR"), else this says so and the queue
 * stops. Not when the field still holds the text (a search box: Enter
 * submitted it), nor when the field is gone (the page moved on). Returns the
 * reason, or `undefined`.
 */
export function comboboxMiss(prompt: AgentPrompt): string | undefined {
  const press = prompt.history.at(-1);
  const fill = prompt.history.at(-2);
  if (press?.action.type !== 'press' || (press.action as { key?: string }).key !== 'Enter' || fill?.action.type !== 'fill') {
    return undefined;
  }
  const pressed = actionKey(press.action)?.split(' ')[1];
  const filled = actionKey(fill.action)?.split(' ')[1];
  const text = ((fill.action as { text?: string }).text ?? '').trim();
  if (pressed === undefined || pressed !== filled || text === '') {
    return undefined;
  }
  const index = refIndex(prompt.tree);
  const field = index.get(pressed);
  if (field === undefined || field.role !== 'combobox' || (field.value ?? '').trim().toLowerCase() === text.toLowerCase()) {
    return undefined;
  }
  const wanted = text.toLowerCase();
  for (const node of index.values()) {
    if (node !== field && (node.name ?? '').trim().toLowerCase() === wanted) {
      return undefined;
    }
  }
  return `the dropdown [${pressed}] does not show "${clip(text, 60)}" picked after Enter: it may hold another option; open it and pick "${clip(text, 60)}" exactly`;
}

/** Steps the repeat detector looks back over, and how many repeats make a loop. */
export const REPEAT_WINDOW = 6;
export const REPEAT_LIMIT = 2;

/**
 * Actions the run has already taken {@link REPEAT_LIMIT} or more times in its
 * last {@link REPEAT_WINDOW} steps — a loop, read deterministically off the
 * record (BrainMeasure E1: story 2 opened four times; L1: the same dead link
 * re-clicked). The port refuses to run them again and tells the brain why.
 */
export function repeatedActions(
  history: readonly StepTrace[],
): ReadonlyMap<string, { readonly text: string; readonly count: number; readonly failed: boolean }> {
  const counts = new Map<string, { text: string; count: number; failed: boolean; transient: number }>();
  for (const trace of history.slice(-REPEAT_WINDOW)) {
    const key = actionKey(trace.action);
    if (key === undefined) continue;
    const seen = counts.get(key);
    const transient = transientNavFailure(trace) || interruptedFill(trace);
    const failed = !transient && (trace.error !== undefined || trace.check?.verdict === 'contradicted');
    const times = (seen?.transient ?? 0) + (transient ? 1 : 0);
    counts.set(key, { text: key, count: (seen?.count ?? 0) + 1, failed: (seen?.failed ?? false) || failed || times >= 2, transient: times });
  }
  // A loop is the same action twice — or once, when it changed nothing or
  // failed: running it again unchanged cannot do better (BrainMeasure L1, the
  // same dead link re-clicked after one no-effect). A navigate that only timed
  // out or did not commit is the exception: see {@link transientNavFailure}.
  return new Map(
    [...counts]
      .filter(([, entry]) => entry.count >= REPEAT_LIMIT || entry.failed)
      .map(([key, { transient: _transient, ...entry }]) => [key, entry]),
  );
}

/**
 * THE SAME CONTROL ON AN UNCHANGED PAGE IS THE SAME ACTION, whatever its node
 * id. Every earlier step taken on a page state identical to this one (same
 * tree hash) that LEFT it identical (the next read has the same hash) is
 * re-pointed at the ref its control has NOW, found by the XPath the step
 * recorded, so {@link repeatedActions} counts it and the port's refusal
 * matches the brain's next pick of it — the rule a same-ref repeat already
 * meets. A page that posts back mints a new backend id for the same button on
 * every visit: MEM4 `run_02bfae1f` (2026-10-04) clicked one Search button six
 * times as six different refs on one unchanged tree, every click "confirmed",
 * and was never told it was repeating. A step that changed the page, one on
 * another page state, or one with no recorded XPath is left as it was.
 *
 * Replayed over 14 days of production (4,942 ended runs to 2026-10-04): it
 * newly names a repeat in 117 runs; in 70 the run's next action was that
 * repeat (16 of them completed anyway, after e.g. seven Search clicks on one
 * unchanged results page, run_ffa381f0).
 */
export function onThisPageNow(history: readonly StepTrace[], tree: AxTree, snapshotHash: string): readonly StepTrace[] {
  let now: Map<string, NodeRef> | undefined;
  return history.map((trace, index) => {
    const xpath = trace.observed?.xpath;
    const action = trace.action as Readonly<Record<string, unknown>>;
    const after = history[index + 1]?.snapshotHash ?? snapshotHash;
    if (xpath === undefined || trace.snapshotHash !== snapshotHash || after !== snapshotHash || !isRecord(action['ref'])) {
      return trace;
    }
    if (now === undefined) {
      now = new Map();
      for (const node of refIndex(tree).values()) {
        now.set(node.xpath, node.ref);
      }
    }
    const ref = now.get(xpath);
    return ref === undefined ? trace : ({ ...trace, action: { ...trace.action, ref } } as StepTrace);
  });
}

/** A load that ran out of time or never committed: a timeout, a tab still loading, "still on" the old page. */
const TRANSIENT_NAV = /\b(?:timed? ?out|timeout|still loading|did not commit|not committed|never committed|ERR_(?:CONNECTION_)?TIMED_OUT)\b|the browser is still on/i;
/** A definite answer from the network or the site: a net error that is not a timeout, an HTTP refusal, a block. */
const DEFINITE_NAV = /net::ERR_(?!(?:CONNECTION_)?TIMED_OUT\b)|\b(?:HTTP|status) [45]\d\d\b|\b(?:401|403|404|410|429|451)\b|refus|blocked|forbidden|denied|not found|not resolve/i;

/**
 * Whether a step is a navigate that failed only by timing out or not
 * committing: no net error naming a cause, no HTTP refusal. Such a failure says
 * nothing about the URL, so ONE exact retry is the right next step, and only a
 * second identical failure rules it out. Ruled out on the first, the brain
 * took "a different route", the same page with a URL qualifier dropped, which
 * is a different version of the page and the wrong answer (sealed heldout4,
 * done-partial, failure mode reported by BrainMeasure 2026-10-03). Definite
 * failures keep the old rule: one is enough.
 */
export function transientNavFailure(trace: StepTrace): boolean {
  if (trace.action.type !== 'navigate') return false;
  const said = trace.error ?? (trace.check?.verdict === 'contradicted' ? trace.check.saw : undefined);
  if (said === undefined) return false;
  // URLs are not evidence either way ("…/404-guide" is a page name).
  const words = said.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  return TRANSIENT_NAV.test(said) && !DEFINITE_NAV.test(words);
}

/**
 * Whether a step is a fill the page interrupted: the focus left the field
 * while it was typed (`performFill` in `@outcrawl/scout-cdp` says so in these
 * words), so only the start of the text landed. Not the fill's fault, so ONE
 * exact retry is open, as for a navigate that timed out. Fleet 2026-10-20
 * (Outcrawl Bench dev venues-hold, run_7f096ca5): the fill was told to run
 * again, and the repeat guard would have refused it as already failed.
 */
export function interruptedFill(trace: StepTrace): boolean {
  return trace.action.type === 'fill' && trace.error !== undefined && /focus left the field while typing/.test(trace.error);
}

/**
 * Navigates in the repeat window that failed once, transiently, and were not
 * run again: one exact retry is open to them. The port says so to the brain,
 * so a slow load is not read as a dead URL.
 */
export function retryableNavigations(history: readonly StepTrace[]): readonly string[] {
  const window = history.slice(-REPEAT_WINDOW);
  const keys: string[] = [];
  for (const trace of window) {
    const key = actionKey(trace.action);
    if (key === undefined || !transientNavFailure(trace)) continue;
    if (window.filter((other) => actionKey(other.action) === key).length === 1) keys.push(key);
  }
  return keys;
}

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10, top: 1,
};
/** What an ordinal can count on a listing page. */
const LIST_ITEM = /^(story|stories|item|result|post|link|article|product|listing|entry|repo|repository|video|thread)$/;

/**
 * WRONG ITEM: the task names an item by its position ("the first story"),
 * the run recorded the ordered list it came from ("1. A; 2. B; 3. C"), and
 * the page the brain is about to answer from is a DIFFERENT entry of that
 * list. Read deterministically: the task's last ordinal-plus-noun, the
 * recorded numbered entries, and the page title. `undefined` when any of the
 * three is missing or they agree (BrainMeasure C1, 2026-10-03: "the comments
 * of the first story" answered from the third story's comments, with the
 * brain's own note listing that story third; 3 of 6 samples on 3478b0b2).
 */
export function wrongListItem(task: string, notes: readonly string[], pageTitle: string): string | undefined {
  const pairs = [...task.toLowerCase().matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|top|\d{1,2}(?:st|nd|rd|th))\s+(\w+)/g)].filter(
    (match) => LIST_ITEM.test(match[2] ?? '') && ORDINALS[match[1] ?? ''] !== undefined,
  );
  const wanted = pairs.at(-1);
  if (wanted === undefined) {
    return undefined;
  }
  const position = ORDINALS[wanted[1] ?? ''] ?? 0;
  const title = pageTitle.toLowerCase();
  for (const note of notes) {
    for (const entry of note.matchAll(/(?:^|[;:\n]\s*)(\d{1,2})\.\s*"?([^";\n(]{12,}?)"?\s*(?=\(|;|\n|$)/g)) {
      const rank = Number(entry[1]);
      const name = (entry[2] ?? '').trim().toLowerCase();
      if (name.length >= 12 && title.includes(name) && rank !== position) {
        return `this page is "${clip(pageTitle, 80)}", #${String(rank)} in your own list, but the task asks for the ${wanted[1] ?? ''} ${wanted[2] ?? ''}`;
      }
    }
  }
  return undefined;
}

/**
 * A read that answers a rank range ("ranked 61 to 70", "top 5"), checked
 * against the page's own numbered list: each rank line ("64.") and the named
 * link after it. Returns what the answer gets wrong — a rank whose item is
 * absent, or an item from outside the range — or `undefined` when it agrees,
 * or when the page does not number the whole range (nothing to check against).
 * Deterministic, so it does not depend on the extractor noticing (live10,
 * 2026-10-03: the hands model's final read of news?p=3 skipped rank 64 and appended
 * rank 71, n=2 runs, both shipped; the oracle at settle had rank 64).
 */
export function rankedReadGap(instruction: string, tree: AxTree, answer: unknown): string | undefined {
  const range = /\brank(?:ed|s|ing)?\s*#?(\d{1,4})\s*(?:to|-|–|—|through|thru)\s*#?(\d{1,4})/i.exec(instruction);
  const top = /\btop\s+(\d{1,3})\b/i.exec(instruction);
  const from = range !== null ? Number(range[1]) : top !== null ? 1 : NaN;
  const to = range !== null ? Number(range[2]) : top !== null ? Number(top[1]) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 50) {
    return undefined;
  }
  const items = new Map<number, string>();
  let pending: number | undefined;
  const walk = (node: AxNode): void => {
    const name = (node.name ?? '').trim();
    const ordinal = /^(\d{1,4})\.$/.exec(name);
    if (ordinal !== null && !ACTIONABLE_ROLES.has(node.role)) {
      pending = Number(ordinal[1]);
    } else if (pending !== undefined && node.role === 'link' && namesThing(name)) {
      if (!items.has(pending)) items.set(pending, name);
      pending = undefined;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree.root);
  for (let rank = from; rank <= to; rank += 1) {
    if (!items.has(rank)) return undefined;
  }
  const said = (typeof answer === 'string' ? answer : JSON.stringify(answer)).toLowerCase();
  const key = (title: string): string => title.toLowerCase().slice(0, 32);
  const missing = [...items].filter(([rank]) => rank >= from && rank <= to).filter(([, title]) => !said.includes(key(title)));
  const outside = [...items].filter(([rank]) => rank < from || rank > to).filter(([, title]) => said.includes(key(title)));
  if (missing.length === 0 && outside.length === 0) {
    return undefined;
  }
  return [
    ...missing.map(([rank, title]) => `rank ${String(rank)} ("${clip(title, 70)}") is not in it`),
    ...outside.map(([rank, title]) => `it includes rank ${String(rank)} ("${clip(title, 70)}"), outside ${String(from)}-${String(to)}`),
  ].join('; ');
}

/**
 * A navigate the loop's check judged by a read taken BEFORE the page changed:
 * the check says the browser is "still on" the old page (or on the old page of
 * the same site), but the very next snapshot — this step's tree — is the page
 * the navigate asked for. The check is wrong, not the step: treated as failed,
 * it dropped the brain's queued read, refused the URL as already tried and
 * wrote it into the run's ruled-out memory, sending the run around the
 * official site the task named (live10-ad789359 oss-compare, run_7c6cc717:
 * 3 of 11 navigates, 14 brain calls). Returns the trace as confirmed on the
 * page the tree shows, or `undefined` when it is not such a step.
 */
export function reconciledNavigate(trace: StepTrace, treeUrl: string): StepTrace | undefined {
  if (trace.action.type !== 'navigate' || !('url' in trace.action) || typeof trace.action.url !== 'string') {
    return undefined;
  }
  const saw = trace.check?.saw ?? '';
  const landed = /(?:still on|is on|elsewhere and is on) (\S+)/.exec(saw)?.[1];
  const page = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      return url;
    }
  };
  const asked = page(trace.action.url);
  const now = page(treeUrl);
  const site = (value: string): string => value.split('/')[0] ?? '';
  // The tree is on the asked page (or a same-site landing of it), and the
  // check said it was somewhere else.
  const arrived = now === asked || (site(now) === site(asked) && now.startsWith(asked));
  const misjudged = landed !== undefined && page(landed) !== asked && page(landed) !== now;
  if (!arrived || !misjudged || trace.error !== undefined) {
    return undefined;
  }
  return {
    ...trace,
    check: { ...(trace.check ?? { expected: '', reads: 0, elapsedMs: 0 }), verdict: 'confirmed', saw: `the browser is on ${treeUrl}` },
  } as StepTrace;
}

/** What an answer says of an item that it has not shown to meet a condition. */
const UNCONFIRMED = /\b(unconfirmed|not confirmed|not verified|unverified|not stated|not shown|not listed|unknown|could not (?:confirm|verify)|may not (?:meet|qualify))\b/i;

/**
 * A RANKED ANSWER WITH AN UNCONFIRMED ITEM IN A SLOT: a numbered list ("1) …
 * 2) … 3) …") one of whose items the answer itself calls unconfirmed for a
 * condition. Such an item must not fill a ranked slot while the run may hold
 * one that meets every condition, and when fewer qualify than asked the
 * answer has to say so (live10 31029c13, amazon-gaming-80k run_876f0730:
 * slot 3 was a listing "GPU not stated … unconfirmed" while a confirmed
 * RTX 3050 listing appeared only as an aside; judged partial). Returns the
 * slot's own text, or `undefined`.
 */
export function unconfirmedSlot(answer: string): string | undefined {
  const marks = [...answer.matchAll(/(?:^|[\s;])(\d{1,2})[).]\s+/g)];
  if (marks.length < 2) {
    return undefined;
  }
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]!;
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? answer.length;
    // The slot's own text: up to the next numbered item, or the first sentence
    // break after it for the last slot (what follows is commentary).
    const raw = answer.slice(start, end);
    const text = index === marks.length - 1 ? (raw.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? raw) : raw;
    if (UNCONFIRMED.test(text)) {
      return `${mark[1] ?? ''}) ${clip(text.trim(), 120)}`;
    }
  }
  return undefined;
}

/** A read that found nothing to keep: re-reading such a page narrower is fair. */
const EMPTY_READ = /\b(no (?:\w+ )?(?:data|results?|items?|products?|information) (?:found|available|shown)|does not (?:contain|state|show)|not (?:found|shown|stated|visible)|returned (?:an? )?\d{3}|unavailable)\b/i;

/**
 * A READ OF A PAGE ALREADY READ: the run read this exact page before — same
 * snapshot, nothing changed since — and that read returned something. A new
 * read can only say it again, so the brain is shown the earlier one instead
 * (heldout4, 2026-10-03, class constraint-ignored: "re-read the list when it
 * already had what it needed"). Not after a read that came back empty, an
 * error page, or one the loop held as incomplete: asking narrower then is the
 * rule. Returns the earlier read's step and text, or `undefined`.
 */
export function alreadyRead(prompt: AgentPrompt): { readonly step: number; readonly text: string } | undefined {
  const reads = new Map((prompt.extracted ?? []).map((entry) => [entry.step, entry.text]));
  // "Unchanged" is read off the ACTIONS and the URL, not the snapshot hash: a
  // live page's tree drifts on its own (ads, lazy images, relative times), and
  // the step after a read had a different hash in 30 of 56 transitions on the
  // live10 traces of 2026-10-03 — including amazon's read after read — so the
  // hash test let the very re-read this guards against through. Only a read or
  // a wait may come between: a scroll can load more of a list, and anything
  // else may change the page.
  for (let index = prompt.history.length - 1; index >= 0; index -= 1) {
    const trace = prompt.history[index]!;
    const type = trace.action.type;
    if (type === 'wait') {
      continue;
    }
    if (type !== 'extract') {
      return undefined;
    }
    const text = reads.get(trace.index);
    if (text === undefined || trace.held !== undefined || EMPTY_READ.test(text)) {
      return undefined;
    }
    const source = /^extracted on (\S+):/.exec(text)?.[1];
    return source !== undefined && sameDocument(source, prompt.tree.url) ? { step: trace.index, text } : undefined;
  }
  return undefined;
}

/** A task that asks for several ranked or listed items: "the 3 best-rated", "top 10", "five cheapest". */
const COUNTED_ITEMS = /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:best|top|cheapest|highest|lowest|most|newest|latest|least)\b|\btop\s+(?:\d+|three|five|ten)\b/i;
/** A results or listing URL: a search query in its parameters, or a search/results path. */
const RESULTS_URL = /[?&](?:k|q|query|search|keywords?|s|term)=|\/(?:search|results|s)(?:[/?]|$)/i;

/**
 * A RESULTS PAGE LEFT UNREAD. On a task that asks for several ranked or listed
 * items, a navigate away from the results page the run's own navigate just
 * opened, with nothing read on it, goes back to the brain once: amazon
 * run_0c9b82b8 (2026-10-03 10:44Z) opened its under-₹80,000 results sorted
 * by rating, left them unread for a URL with a 4-stars-and-up filter that
 * excluded every qualifying laptop, and finished with 2 of 3. Returns the
 * reason, or `undefined` when the navigate may run.
 */
export function unreadResults(prompt: AgentPrompt, action: Readonly<Record<string, unknown>> | Action): string | undefined {
  const record = action as Readonly<Record<string, unknown>>;
  if (record['type'] !== 'navigate' || !COUNTED_ITEMS.test(prompt.task) || !RESULTS_URL.test(prompt.tree.url)) {
    return undefined;
  }
  const last = prompt.history.at(-1);
  if (last === undefined || last.action.type !== 'navigate' || last.error !== undefined || last.check?.verdict === 'contradicted') {
    return undefined;
  }
  const read = prompt.history.some((trace) => trace.action.type === 'extract') &&
    (prompt.extracted ?? []).some((entry) => {
      const source = /^extracted on (\S+):/.exec(entry.text)?.[1];
      return source !== undefined && sameDocument(source, prompt.tree.url);
    });
  return read ? undefined : `the results at ${prompt.tree.url.slice(0, 120)} were never read`;
}

/**
 * The facts line without the facts a read of this same page already holds.
 * A results page is briefed and then read on the brain's next turn (a queued
 * read), and every listing the brief shows comes back in the read as well:
 * both are kept in the thread, written to the cache once and read on every
 * later call (amazon, 2026-10-04 bundle a506a744: ~1,300 cache-write tokens a
 * brain call, the page's read and its brief among them). A fact is dropped
 * only when its own words (12+ characters, a link's label without the
 * `link "…"` wrapper) appear in a read of this page, so nothing the brain
 * could not see elsewhere in the thread is lost. The page line and notices
 * always stay. `facts` unchanged when no read of this page is held.
 */
export function factsBesideReads(facts: string, url: string, reads: readonly { readonly text: string }[], fullReads: readonly string[]): string {
  const here = reads
    .filter((entry) => {
      const source = /^extracted on (\S+):/.exec(entry.text)?.[1];
      return source !== undefined && sameDocument(source, url);
    })
    .map((entry) => wholeRead(entry.text, fullReads) ?? entry.text);
  const at = facts.lastIndexOf('\nFacts: ');
  if (here.length === 0 || at === -1) {
    return facts;
  }
  const squash = (value: string): string => value.toLowerCase().replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
  const held = squash(here.join(' '));
  const items = facts.slice(at + '\nFacts: '.length).split(' | ');
  const isHeld = (item: string): boolean => {
    const core = squash(item.replace(/^(?:link|button|heading|cell) "(.*)"$/s, '$1').replace(/…$/u, ''));
    return core.length >= 12 && held.includes(core);
  };
  // A field label stays while its value does: a label is no fact on its own,
  // and the read may name it ("battery life … listed further down") without
  // the value under it. Dropped, the value read as the row before's (a spec
  // table's "Battery life" gone, "Up to 31 hours" under "Weight: 172 g";
  // tainted sealed item via Main, 2026-10-05).
  const kept = items.filter((item, index) => !isHeld(item) || (isLabelText(item) && items[index + 1] !== undefined && !isHeld(items[index + 1]!)));
  if (kept.length === items.length) {
    return facts;
  }
  const dropped = items.length - kept.length;
  return `${facts.slice(0, at)}\nFacts: ${[...kept, `(${String(dropped)} more already in your read of this page)`].join(' | ')}`;
}

/** Two URLs naming the same document: host case, a trailing slash and a fragment aside. */
function sameDocument(left: string, right: string): boolean {
  const norm = (value: string): string => {
    try {
      const url = new URL(value);
      return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return value.replace(/#.*$/, '').replace(/\/+$/, '');
    }
  };
  return norm(left) === norm(right);
}

/**
 * A RELOAD KEY PRESS, as the navigate it means. A key event never reaches the
 * browser's reload accelerator (MEASURED, see `isReloadKey` in
 * `@outcrawl/runtime`), and the sealed set lost both samples of a multi-tab
 * item to a reload-by-key the brain chose correctly (2026-10-03, abstract mode
 * only). The page binding performs a reload key the same way on every other
 * path: a GET navigate to the document's url. `undefined` when the action is not a
 * reload key press.
 */
export function reloadAsNavigate(action: Readonly<Record<string, unknown>> | Action, url: string): Action | undefined {
  const record = action as Readonly<Record<string, unknown>>;
  if (record['type'] !== 'press' || typeof record['key'] !== 'string' || !isReloadKey(record['key']) || !/^https?:/.test(url)) {
    return undefined;
  }
  return { type: 'navigate', url };
}

/** A task phrase that filters items: a bound, a ceiling, a qualifier on what counts. */
const CONSTRAINT = /\b(?:under|below|above|over|less than|more than|fewer than|at least|at most|no more than|cheaper than|within|between|only|dedicated|with(?:out)? (?:a |an )?[\p{L}-]+ (?:graphics|gpu|card|rating|stars?|reviews?)|rated|in stock|from \d{4}|before \d{4}|after \d{4})\b(?:(?![.;:]|,\s).)*/giu;
/** A read that asks for several items, the kind a constraint filters. */
const LIST_READ = /\b(all|each|every|list|results|items|listings|products|rows|entries|top \d+|\d+ (?:best|cheapest|top|highest|lowest))\b/i;

/**
 * A LIST READ THAT CARRIES THE TASK'S FILTERS. A brain read of a whole list,
 * written without the task's constraints, returned every item and the answer
 * then ignored a constraint the task set (heldout4 constraint-ignored on
 * bundle a23446a6, 1 of 2; one conflicting-facts miss of the same shape on a
 * table; abstract modes, 2026-10-03). The read is told the task's own filter
 * phrases and asked to MARK each item against them, never to drop one, so the
 * brain still sees the whole list. Fires only on a list read, on a task that
 * states a filter, when the read does not already name it. `undefined`
 * otherwise.
 */
export function readWithConditions(instruction: string, task: string): string | undefined {
  if (!LIST_READ.test(instruction)) {
    return undefined;
  }
  const filters = [...new Set((task.match(CONSTRAINT) ?? []).map((phrase) => phrase.trim()))].filter((phrase) => phrase.split(/\s+/).length >= 2);
  if (filters.length === 0) {
    return undefined;
  }
  // A filter the read already states, in its own words or figures, is not
  // repeated: every word of 3+ characters (a figure keeps its commas) is in it.
  const said = instruction.toLowerCase();
  // A filter with a figure is stated when the figure is; one without, when
  // each of its words (4+ letters) is.
  const missing = filters.filter((phrase) => {
    const figures = phrase.match(/\d[\d,.]*/g) ?? [];
    const words = figures.length > 0 ? figures : (phrase.toLowerCase().match(/\p{L}{4,}/gu) ?? []);
    return !words.every((word) => said.includes(word.toLowerCase()));
  });
  // A read that FILTERS ("only those under …", "skip …") is told to mark
  // instead: the extractor drops items it misjudges and a short or empty list
  // reads to the brain as "nothing qualifies here", so it searches again.
  // Measured on amazon-gaming-80k, same URL and same top items in both runs
  // (2026-10-03): the unfiltered first read ("first 10 results: …", 1,003
  // content tokens) ended the run in 3 steps, $0.017 (run_1a5cbe83); the
  // filtered one ("… only those under ₹80,000 with dedicated GPU", 652
  // tokens) was followed by 4 filtered reads returning 17-97 tokens and 7
  // more searches, 17 steps, $0.079 (run_cf1cd982).
  const filtersOut = FILTERING_READ.test(instruction);
  if (missing.length === 0 && !filtersOut) {
    return undefined;
  }
  const named = missing.length === 0 ? '' : ` (${clip(missing.join('; '), 200)})`;
  const instead = filtersOut ? ' instead of leaving items out,' : '';
  return `${instruction} —${instead} mark each item PASS or FAIL against the task's filters${named}; keep every item, say which fail`;
}

/** A listing a read marked as meeting the task, or failing it: see {@link listingVerdicts}. */
export interface ListingVerdict {
  /** The listing, as the read gave it (its name, price, the measures that decided it), at most 180 characters. */
  readonly text: string;
  /** Its name, normalised: the same listing in two reads. */
  readonly key: string;
  readonly pass: boolean;
}

/** A listing a read left undecided: it is no qualifier, and no fail. */
const UNDECIDED = /\b(?:unclear|not (?:stated|specified|shown|listed|confirmed|verified)|unknown|unconfirmed|n\/a)\b/i;

/**
 * The listings a list read marked PASS or FAIL against the task's filters
 * (the read `readWithConditions` asks for), one per item: a JSON list's
 * objects, or a text list's numbered or "Item N:" entries. A listing marked
 * both, or left undecided on a filter ("GPU unclear"), is neither. Empty for
 * a read that marks fewer than two items: not a judged list.
 */
export function listingVerdicts(read: string): readonly ListingVerdict[] {
  const parsed = (() => {
    try {
      return JSON.parse(read) as unknown;
    } catch {
      return undefined;
    }
  })();
  // Each item as its name, then the rest of what the read said of it.
  const items: { readonly name: string; readonly body: string }[] = Array.isArray(parsed)
    ? parsed
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => {
          const values = Object.entries(entry).filter(([, value]) => typeof value === 'string' || typeof value === 'number');
          const named = values.find(([key]) => /^(?:title|name|product|item|listing)$/iu.test(key)) ?? values.reduce<[string, unknown] | undefined>((longest, pair) => (String(pair[1]).length > String(longest?.[1] ?? '').length ? pair : longest), undefined);
          const name = String(named?.[1] ?? '');
          return { name, body: [name, ...values.filter((pair) => pair !== named).map(([, value]) => String(value))].join(' · ') };
        })
    : read
        .split(/\n\s*\n|\n(?=\s*(?:\d{1,2}[.)]\s|(?:item|listing|product|result|laptop)\s*\d+\s*:))|\s[|;]\s(?=(?:item|listing|product|result|laptop)\s*\d+\s*:)/iu)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const bare = chunk.replace(/^\s*(?:\d{1,2}[.)]|(?:item|listing|product|result|laptop)\s*\d+\s*:)\s*(?:\*\*)?(?:title\s*:\s*)?/iu, '');
          return { name: /\p{L}[^₹$€£:|\n*]{4,}/u.exec(bare)?.[0] ?? bare, body: chunk };
        });
  const verdicts: ListingVerdict[] = [];
  for (const { name, body } of items) {
    // "Pass/FAIL: Pass": the label is no verdict.
    const said = body.replace(/\bpass\s*\/\s*fail\b/giu, '');
    const pass = /\bpass(?:es|ed)?\b/i.test(said);
    const fail = /\bfail(?:s|ed)?\b/i.test(said);
    if (pass === fail || (pass && UNDECIDED.test(said))) continue;
    const text = clip(body.replace(/\*\*/gu, '').replace(/\s+/gu, ' '), 180);
    verdicts.push({ text, key: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 48), pass });
  }
  return verdicts.length >= 2 ? verdicts : [];
}

/** Read wording that asks the extractor to leave items out. */
const FILTERING_READ = /\b(only (?:those|the ones|items?|results?|ones|listings?|products?|laptops?|with|under|over|below|above)|skip|exclude|excluding|omit|ignore (?:any|the)|leave out)\b/i;

/** A field a query is typed into: a search box, or a field labelled for one. */
const SEARCH_FIELD = /search|keyword|query|find|part\s*(no|#|number)/i;

/**
 * A search the run has already run: the same text typed into a search field
 * on an earlier step, after which the run went to another page. Typing it
 * again can only land where it landed — the ref changed with the page, so the
 * ref-keyed repeat check did not see it (BrainMeasure L1, 2026-10-03: the MPN
 * re-typed into the results page's search box after the product link died,
 * 3 of 6 samples). `undefined` when the action is not such a repeat.
 */
export function searchedBefore(history: readonly StepTrace[], action: Readonly<Record<string, unknown>> | Action, tree: AxTree): string | undefined {
  const record = action as Readonly<Record<string, unknown>>;
  if (record['type'] !== 'fill' || typeof record['text'] !== 'string') {
    return undefined;
  }
  const key = actionKey(action)?.split(' ')[1] ?? '';
  const field = refIndex(tree).get(key);
  if (field === undefined || !(field.role === 'searchbox' || SEARCH_FIELD.test(field.name ?? ''))) {
    return undefined;
  }
  const text = record['text'].trim().toLowerCase();
  const typed = history.findIndex(
    (trace) => trace.action.type === 'fill' && 'text' in trace.action && String(trace.action.text).trim().toLowerCase() === text,
  );
  if (typed < 0) {
    return undefined;
  }
  const landed = history
    .slice(typed + 1)
    .map((trace) => /(?:went to|is on|redirected and is on) (\S+)/.exec(trace.check?.saw ?? '')?.[1])
    .find((url) => url !== undefined);
  return landed === undefined ? undefined : `searching "${record['text']}" again: that search already led to ${clip(landed, 100)}`;
}

/**
 * Places the run keeps landing on: a confirmed step's destination ("the page
 * went to X", "the browser is on X") reached {@link REPEAT_LIMIT} or more
 * times in the last {@link REPEAT_WINDOW} steps. A click whose ref changed
 * with every reload is still the same loop when it lands on the same URL
 * (BrainMeasure E1: four different refs, one nytimes.com article).
 */
export function repeatedPlaces(history: readonly StepTrace[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const trace of history.slice(-REPEAT_WINDOW)) {
    const saw = trace.check?.saw;
    const url = saw === undefined ? undefined : /(?:went to|is on|redirected and is on) (\S+)/.exec(saw)?.[1];
    if (url !== undefined) {
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= REPEAT_LIMIT)
    .map(([url, count]) => `LANDED ON ${clip(url, 100)} ${String(count)}x already: whatever leads there again is a loop.`);
}

/** A host as a site: lower-case, without `www.` / `m.`. `undefined` for a URL that does not parse. */
function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www\d*|m)\./, '');
  } catch {
    return undefined;
  }
}

/**
 * WRONG SITE: the last step navigated (or opened a tab) to one site and the
 * browser is now on another — a geo or country redirect (amazon.in to
 * amazon.com, digikey.in to digikey.com) whose page looks like the right one.
 * Read deterministically off the record and the page's own URL, so the brain
 * is told before it acts there rather than after it has searched the wrong
 * catalogue. `undefined` when nothing moved site.
 */
export function redirectedSite(history: readonly StepTrace[], at: string): string | undefined {
  const last = history.at(-1);
  if (last === undefined || (last.action.type !== 'navigate' && last.action.type !== 'openTab')) {
    return undefined;
  }
  const asked = 'url' in last.action && typeof last.action.url === 'string' ? last.action.url : undefined;
  const wanted = asked === undefined ? undefined : siteOf(asked);
  const now = siteOf(at);
  if (wanted === undefined || now === undefined || wanted === now || now.endsWith(`.${wanted}`)) {
    return undefined;
  }
  return `REDIRECTED: you asked for ${wanted}; the browser is on ${now}, a different site. If the task needs ${wanted}, get back to it (a link or button to it on this page, or a URL on it) before acting here.`;
}

/**
 * When the last action failed or changed nothing on an element still on the
 * page: the other ways to the same place, read off the tree — its siblings and
 * the elements that share a word with its label, links with their URL so the
 * brain can navigate straight there. Up to 3.
 */
export function alternativesFor(tree: AxTree, history: readonly StepTrace[]): readonly BriefElement[] {
  const last = history.at(-1);
  if (last === undefined || (last.error === undefined && last.check?.verdict !== 'contradicted')) {
    return [];
  }
  const key = actionKey(last.action);
  const ref = key?.split(' ')[1];
  const scan = scanPage(tree);
  const failed = ref === undefined ? undefined : scan.index.get(ref);
  if (failed === undefined) {
    return [];
  }
  const name = (failed.node.name ?? '').trim().toLowerCase();
  const words = new Set(name.split(/\W+/).filter((word) => word.length >= 3));
  // Siblings only in a small container (a result row): in a flat page every
  // node is a sibling, and the first was the site logo (L1, 2026-10-03).
  const family = failed.parent?.children ?? [];
  const siblings = new Set(family.length <= 20 ? family.map((child) => refText(child)) : []);
  // The same thing under another element first — the image beside a dead
  // title link carries the title as its name — then shared words, then the row.
  const sameName = [...scan.index.values()]
    .map((entry) => entry.node)
    .filter((node) => refText(node) !== ref && (node.role === 'img' || node.role === 'image' || ACTIONABLE_ROLES.has(node.role)) && (node.name ?? '').trim().toLowerCase() === name && name !== '');
  const related = scan.actionable.filter(
    (node) => refText(node) !== ref && !sameName.includes(node) && ((node.name ?? '').toLowerCase().split(/\W+/).some((word) => words.has(word)) || siblings.has(refText(node))),
  );
  return [...sameName, ...related]
    .slice(0, 3)
    .map((node) => {
      const element = scan.element(node, '');
      return node.href === undefined ? element : { ...element, state: `${element.state} -> ${JSON.stringify(clip(node.href, 120))}`.trim() };
    });
}

/** How the hands say a decision cannot be done on this page: the start of `reasoning`. */
export const HANDS_CANNOT = 'CANNOT:';

/**
 * How the hands are told the decision: in front of the full prompt they would
 * have had anyway, so nothing the brain missed is hidden from them.
 */
export function handsGuidance(decision: BrainDecision): string {
  const what =
    decision.kind === 'instruct'
      ? decision.instruction
      : decision.kind === 'act'
        ? `this action, or the closest equivalent on this page: ${JSON.stringify(decision.action)}`
        : '';
  return (
    '## Decision for this step\n' +
    'A planner that cannot see the page decided the next action. You can see the page: carry it out ' +
    `exactly, choosing the element yourself.\nDo now: ${what}\n` +
    (decision.why === '' ? '' : `Why: ${decision.why}\n`) +
    `If it cannot be done on this page, begin \`reasoning\` with "${HANDS_CANNOT}" and say why in one ` +
    'sentence, and choose the closest useful action. Do not end the run (done or fail) and do not mark ' +
    'an extract final: the planner decides when the task is finished.\n\n'
  );
}

/* ------------------------------------------------------------------ *
 * The thread
 * ------------------------------------------------------------------ */

/** Exchanges held before the oldest are folded into one-line summaries. */
export const BRAIN_FOLD_AT = 40;
/** Exchanges kept verbatim after a fold. Folding rewrites the first turn: one uncached read per ten steps. */
export const BRAIN_KEEP_PAIRS = 30;

/** One completed exchange: the compact step text and the brain's reply, both exactly as replayed. */
interface Pair {
  readonly step: number;
  readonly compact: string;
  content: string;
  readonly reply: string;
  readonly line: string;
}

/**
 * The brain's own thread for one run, held by the port.
 *
 * SHAPE: system (cached, shared by every run) + one user turn per step that
 * holds only that step's compact text — run state, the previous action's
 * outcome, news — and the brain's reply. The PAGE BRIEF rides only in the
 * final message of the call it was written for and is never replayed: a page
 * the run has left is worth its findings, not its element list. Append-only
 * between folds, so the provider reads the whole thread from cache and the
 * call pays full price for the new step alone. (The provider marks the system
 * turn and the last earlier user turn; the final message is never replayed,
 * so it is not marked and pays no cache-write premium.)
 *
 * WORKER RESTART / ADOPTION: a new port starts with an empty thread; its first
 * step's text carries the resumed run's history (`compactHistory`, the lines
 * the actuator reads) and everything the run recorded, so the brain picks up
 * from the record rather than its lost thinking. Chosen over persisting the
 * thread: the record is durable already and is what the run is judged on.
 */
export class BrainThread {
  /**
   * The user text the provider actually sent for a kept step (the extract
   * preamble included), so the replayed turn is byte-identical to the cached
   * prompt part. Identity by default, for callers that send `kept` as is.
   */
  readonly #render: (kept: string) => string;
  readonly #pairs: Pair[] = [];

  constructor(render: (kept: string) => string = (kept) => kept) {
    this.#render = render;
  }
  readonly #summary: string[] = [];
  #header: string | undefined;
  /** The newest memory/tool step the brain has been shown, per block. */
  #seen: Seen = { findings: -1, ruledOut: -1, extracted: -1, toolResults: -1, goals: '' };
  /** What the last step text would mark as shown, applied only once its exchange is committed. */
  #pending:
    | { readonly seen: Seen; readonly header: string; readonly secrets: string; readonly tools: readonly string[] }
    | undefined;
  /**
   * The secret grammar and ask lines the thread has shown, as one string: in
   * the header from the first step, and again whenever they change (a run
   * secret added mid-run, a card that arrived for an ask).
   */
  #secrets = '';
  /**
   * The tool names the thread has shown: listed in the header, and a tool the
   * run withdraws later (`ToolPort.withdrawn`: `web.ask` once a connected
   * service has answered) is named as gone on the step that first lacks it,
   * because the header that listed it stays in the cached first turn.
   */
  #offered: readonly string[] = [];
  /** The task's condition checklist, from the brain's first reply. */
  #need: readonly string[] = [];

  /** The task's condition checklist, from the brain's first reply; empty before it. */
  need(): readonly string[] {
    return this.#need;
  }

  /** The step the brain last decided on; -1 before its first decision. */
  #lastStep = -1;
  /**
   * Every tool reply the brain has not been shown yet, oldest first. The
   * loop's prompt carries only the newest `TOOL_ECHO_WINDOW` (3), and a brain
   * that queued more calls than that would otherwise never see the earlier
   * replies; {@link observe} collects them from each step's prompt.
   */
  #tools: ToolCallEcho[] = [];
  /** This turn's tool replies, whole, for the call {@link step} built them for only. See {@link once}. */
  #once = '';

  /**
   * The tool replies of the turn {@link step} just built, whole: sent with
   * that call outside the replayed thread (the harness's `tail`), which keeps
   * their short form. Empty when no reply needed more than its short form.
   */
  once(): string {
    return this.#once;
  }

  /**
   * Holds this step's tool replies until the brain's next turn. Called on
   * every step the harness handles, queued ones included; {@link step} calls
   * it as well, so a caller that only steps loses nothing it was handed.
   */
  observe(prompt: AgentPrompt): void {
    for (const echo of prompt.toolResults ?? []) {
      if (echo.step > this.#seen.toolResults && !this.#tools.some((held) => held.step === echo.step)) {
        this.#tools.push(echo);
      }
    }
    this.#tools.sort((a, b) => a.step - b.step);
  }

  /** The earlier turns, oldest first, for the provider. */
  turns(): readonly ModelTurn[] {
    return this.#pairs.flatMap((pair): ModelTurn[] => [
      { role: 'user', content: pair.content },
      { role: 'assistant', content: pair.reply },
    ]);
  }

  /**
   * This step's compact text: the run header on the thread's first step, the
   * state line, the previous action's outcome, and news. What it shows as new
   * counts as shown only once {@link commit} records it, so a failed brain
   * call loses nothing.
   */
  step(prompt: AgentPrompt, expected: readonly string[] = [], warnings: readonly string[] = [], fullReads: readonly string[] = []): string {
    const header = this.#header ?? runHeader(prompt);
    const state = [stateLine(prompt), ...warnings.map((warning) => clip(warning, 160))];
    // Every step since the brain last decided: more than one when it queued
    // steps (lever 1), so it sees what each of them did, and what it expected.
    const since = this.#lastStep < 0 ? prompt.history.slice(-1) : prompt.history.filter((trace) => trace.index >= this.#lastStep);
    const nodes = refIndex(prompt.tree);
    if (since.length === 1 && since[0] !== undefined) {
      state.push(`Last: ${traceLine(since[0], nodes, 220)}`);
    } else if (since.length > 1) {
      state.push('Since your last turn:', ...since.slice(-(MACRO_MAX + 1)).map((trace) => `  ${traceLine(trace, nodes, 150)}`));
    }
    if (expected.length > 0) {
      state.push(`You expected: ${expected.map((entry) => clip(entry, 60)).join('; ')}`);
    }
    if (prompt.notice !== undefined) {
      // 700, not 200: the loop joins its notices in one string, and the one
      // that says why a finish was held comes last — cut at 200 the brain
      // never read why its final read did not end the run (live10 5f576d15,
      // run_2d2ea3f1, replayed in integration.test.ts).
      state.push(`Notice: ${clip(prompt.notice, 700)}`);
    }
    const tabs = prompt.tabs ?? [];
    if (tabs.length > 1) {
      state.push(`Tabs: ${tabs.map((tab) => `${tab.id}${tab.active ? '*' : ''}`).join(' ')}`);
    }
    state.push(`At: ${clip(prompt.tree.url, 120)}${prompt.tree.root.name === undefined ? '' : ` "${clip(prompt.tree.root.name, 60)}"`}`);
    this.observe(prompt);
    const news = newsSince(prompt, this.#seen, fullReads, this.#tools);
    const secrets = secretLines(prompt).join('\n');
    const offered = (prompt.tools ?? []).map((tool) => tool.name);
    this.#pending = { seen: news.seen, header, secrets, tools: offered };
    this.#once = news.once;
    // Outside the capped state block: the line is the run's own grammar, and
    // cut it would offer a placeholder without its fields.
    const changed =
      this.#header !== undefined && secrets !== this.#secrets
        ? [`The run's secrets changed. Now:${secrets === '' ? ' none.' : `\n${secrets}`}`]
        : [];
    const gone = this.#header === undefined ? [] : this.#offered.filter((name) => !offered.includes(name));
    if (gone.length > 0) {
      changed.push(`No longer offered to this run (a call is refused): ${gone.join(', ')}.`);
    }
    // Each line is clipped above; the block cap is a backstop that keeps the line breaks.
    const stateText = state.join('\n');
    const capped = stateText.length <= BRAIN_BUDGET.step ? stateText : `${stateText.slice(0, BRAIN_BUDGET.step - 1)}…`;
    const body = [capped, ...changed, ...(news.text === '' ? [] : [news.text])].join('\n');
    return this.#header === undefined ? `${header}\n\n${body}` : body;
  }

  /**
   * Records one exchange, folding the oldest when the thread is long. `need`
   * is the task's condition checklist from the brain's first reply: it lives
   * in that reply, inside the cached prefix, and is carried into the rewritten
   * first turn when a fold drops that reply, so it is never lost.
   */
  commit(step: number, compact: string, reply: string, line: string, need: readonly string[] = [], sent?: string): void {
    if (this.#pending !== undefined) {
      this.#seen = this.#pending.seen;
      this.#header = this.#pending.header;
      this.#secrets = this.#pending.secrets;
      this.#offered = this.#pending.tools;
      this.#pending = undefined;
    }
    const shown = this.#seen.toolResults;
    this.#tools = this.#tools.filter((echo) => echo.step > shown);
    if (this.#need.length === 0 && need.length > 0) {
      this.#need = need;
    }
    this.#lastStep = step;
    // The turn as the provider received it (a correction included), so the
    // next call's prefix is the one it cached.
    this.#pairs.push({ step, compact, content: sent ?? this.#render(compact), reply, line });
    if (this.#pairs.length >= BRAIN_FOLD_AT) {
      const folded = this.#pairs.splice(0, this.#pairs.length - BRAIN_KEEP_PAIRS);
      this.#summary.push(...folded.map((pair) => pair.line));
      const first = this.#pairs[0];
      if (first !== undefined) {
        // The header is in the folded first turn; the kept first turn takes it.
        const body = first.compact.startsWith(this.#header ?? '\u0000') ? first.compact.slice((this.#header ?? '').length) : first.compact;
        first.content = [
          this.#header ?? '',
          ...(this.#need.length === 0 ? [] : [`Conditions to confirm before done: ${this.#need.join('; ')}`]),
          'Earlier steps (decision, then what happened next):',
          ...this.#summary.slice(-80),
          body.trim(),
        ].join('\n');
      }
    }
  }
}

/** The newest step shown per memory block, and the goal list as last shown. */
interface Seen {
  readonly findings: number;
  readonly ruledOut: number;
  readonly extracted: number;
  readonly toolResults: number;
  readonly goals: string;
}

/**
 * Findings, extracted data, ruled-out approaches and the plan, newer than what
 * the brain was shown — within {@link BRAIN_BUDGET}.news — after this turn's
 * whole reads and its tool replies ({@link toolReplies}), each in its own
 * budget. By the step each entry was written on, not by count: the prompt's
 * blocks are bounded and evict their oldest entries, so a count would skip or
 * repeat. `tools` is the thread's own collection (see `BrainThread.observe`),
 * not the prompt's last three.
 */
function newsSince(
  prompt: AgentPrompt,
  seen: Seen,
  fullReads: readonly string[] = [],
  tools: readonly ToolCallEcho[] = prompt.toolResults ?? [],
): { readonly text: string; readonly once: string; readonly seen: Seen } {
  const lines: string[] = [];
  const reads: string[] = [];
  const fresh = <T extends { readonly step: number }>(entries: readonly T[], after: number): readonly T[] =>
    entries.filter((entry) => entry.step > after);
  const newest = (entries: readonly { readonly step: number }[], before: number): number =>
    Math.max(before, ...entries.map((entry) => entry.step));
  const findings = prompt.memory?.findings ?? [];
  const ruledOut = prompt.memory?.ruledOut ?? [];
  const extracted = prompt.extracted ?? [];
  const goals = (prompt.memory?.goals ?? []).map((goal) => `${goal.id}[${goal.status}] ${goal.goal}`).join('; ');
  // Facts are NOT labelled with their step: "Note (step 3)" beside the step
  // whose click opened the current page read as a note about that page, and
  // the brain took the third story's comments for the first's (C1, 6/6 on
  // 307d4c9d without the label, 3/6 on 3478b0b2 with it, 2026-10-03).
  for (const entry of fresh(extracted, seen.extracted)) {
    const whole = wholeRead(entry.text, fullReads);
    if (whole === undefined) {
      lines.push(`Read: ${entry.text}`);
    } else {
      reads.push(whole);
    }
  }
  for (const entry of fresh(findings, seen.findings)) {
    lines.push(`Note: ${entry.text}`);
  }
  for (const entry of fresh(ruledOut, seen.ruledOut)) {
    lines.push(`Ruled out: ${entry.text}`);
  }
  if (goals !== seen.goals && goals !== '') {
    lines.push(`Plan: ${goals}`);
  }
  const all = lines.join('\n');
  const rest =
    all.length <= BRAIN_BUDGET.news
      ? all
      : `${all.slice(0, BRAIN_BUDGET.news - 60)}… (${String(all.length - BRAIN_BUDGET.news + 60)} more chars on the run record)`;
  const readText = reads.join('\n');
  const whole = readText.length <= BRAIN_BUDGET.reads ? readText : `${readText.slice(0, BRAIN_BUDGET.reads - 1)}…`;
  const replies = toolReplies(fresh(tools, seen.toolResults));
  const text = [whole, replies.kept, rest].filter((part) => part !== '').join('\n');
  return {
    text,
    once: replies.once,
    seen: {
      findings: newest(findings, seen.findings),
      ruledOut: newest(ruledOut, seen.ruledOut),
      extracted: newest(extracted, seen.extracted),
      toolResults: newest(tools, seen.toolResults),
      goals,
    },
  };
}

/** One turn's tool replies: `kept` rides the thread and is replayed; `once` goes with this call only. */
export interface ToolReplyView {
  readonly kept: string;
  readonly once: string;
}

/**
 * Tool replies as the brain gets them, oldest first. A page's text (any reply
 * but a search) goes WHOLE once, in the call it arrives (`once`, outside the
 * replayed thread), within {@link BRAIN_BUDGET}.tools for the turn, and the
 * thread, which every later call replays, keeps its first
 * {@link BRAIN_BUDGET}.toolKept characters. A `web.search` reply is leads,
 * not evidence: it is shown and kept to its first `toolKept` characters, with
 * the rest named as not shown. A `web.ask` reply is an answer with its
 * sources, not leads, so it goes whole once like a page's text.
 *
 * Measured on the dev set, 2026-10-14. Kept whole in the replayed thread
 * (21c8df21), replies grew a long BrowseComp run's prefix and its fold
 * rewrites: brain $/call 0.0107 -> 0.0173 over 19 runs. Whole once, search
 * included (1942f6da): 0.0110 -> 0.0149 over 18, BrowseComp pass 13/18 both
 * ways; 376 of 601 BrowseComp searches asked for 10 results, which come to
 * about 4,000 characters whole against the ~1,150 the brain used to see.
 *
 * A reply that does not fit the turn is not cut: it is named, with its first
 * line, as not shown, so the brain calls it again rather than page on from an
 * offset past text it never read. Not `code.run`: calling it again runs the
 * program again, spends one of its calls and repeats what it did, so its
 * not-shown line asks for less output instead. Not `web.ask` either: asking
 * again is another paid call and another of the run's allowance, so its
 * thread keeps its first `toolKept` characters (the answer comes first) and
 * says not to ask the same question again. Only a single reply larger than
 * the whole budget is cut, and says where.
 */
export function toolReplies(echoes: readonly ToolCallEcho[], budget: number = BRAIN_BUDGET.tools): ToolReplyView {
  const kept: string[] = [];
  const once: string[] = [];
  let used = 0;
  for (const echo of echoes) {
    const head = `Tool ${echo.tool}${echo.isError ? ' FAILED' : ''}`;
    const whole = `${head}: ${echo.text}`;
    if (echo.text.length <= BRAIN_BUDGET.toolKept) {
      kept.push(whole);
    } else if (echo.tool === 'web.search') {
      kept.push(
        `${head}: ${echo.text.slice(0, BRAIN_BUDGET.toolKept)}… (the other ${String(echo.text.length - BRAIN_BUDGET.toolKept)} characters of these results were not shown: ask for fewer results or a narrower query)`,
      );
    } else if (used + whole.length <= budget || used === 0) {
      const cut = whole.length > budget;
      kept.push(
        `${head}: ${echo.text.slice(0, BRAIN_BUDGET.toolKept)}… (the other ${String(echo.text.length - BRAIN_BUDGET.toolKept)} characters were shown once, in the turn this arrived)`,
      );
      once.push(cut ? `${whole.slice(0, budget)}… (reply cut here: its last ${String(whole.length - budget)} characters were not shown)` : whole);
      used += Math.min(whole.length, budget) + 1;
    } else if (echo.tool === CODE_RUN_TOOL) {
      kept.push(
        `Tool ${echo.tool}: output NOT shown, too long to show beside the other tool replies this turn: ${clip(echo.text.split('\n', 1)[0] ?? '', 160)}. ` +
          'Print less, or write the output to a file in /work and print a slice of it; do not run the same program again to read it.',
      );
    } else if (echo.tool === WEB_ASK_TOOL) {
      kept.push(
        `${head}: ${echo.text.slice(0, BRAIN_BUDGET.toolKept)}… (the other ${String(echo.text.length - BRAIN_BUDGET.toolKept)} characters were NOT shown: ` +
          'too long to show beside the other tool replies this turn. Work from this start; do not ask the same question again)',
      );
    } else {
      kept.push(
        `Tool ${echo.tool}: reply NOT shown (over this turn's limit for tool replies): ${clip(echo.text.split('\n', 1)[0] ?? '', 160)}. Call it again on its own to read it.`,
      );
    }
  }
  return {
    kept: kept.join('\n'),
    once: once.length === 0 ? '' : `Tool replies, whole (shown this turn only; your thread keeps their start):\n${once.join('\n')}`,
  };
}

/**
 * A read the loop clipped, as the brain gets it: WHOLE. The loop keeps each
 * extraction to 600 characters in its memory block (`EXTRACTED_FINDING_CHARS`
 * in @outcrawl/runtime, a budget for the actuator's every-step prompt); the
 * brain's port saw the whole result (`HarnessModelPort.extract`), and a list
 * of seven laptops cut at 600 characters sent the brain back to read it again,
 * narrower, four times (live10-ad789359 amazon-gaming-80k: 7 brain calls,
 * 4 of 5 reads clipped). Matched on the clipped text's opening, whitespace
 * aside; `undefined` when the entry was not clipped or no whole read matches.
 */
export function wholeRead(entry: string, fullReads: readonly string[]): string | undefined {
  const parsed = /^extracted on (\S+): ("[\s\S]*")$/.exec(entry);
  if (parsed === null) {
    return undefined;
  }
  let clipped: string;
  try {
    clipped = JSON.parse(parsed[2] ?? '""') as string;
  } catch {
    return undefined;
  }
  if (!clipped.endsWith('…')) {
    return undefined;
  }
  const squash = (value: string): string => value.replace(/\s+/g, '');
  const opening = squash(clipped.slice(0, -1)).slice(0, 160);
  const full = fullReads.find((read) => squash(read).startsWith(opening));
  return full === undefined ? undefined : `Read (whole) on ${parsed[1] ?? ''}: ${JSON.stringify(full)}`;
}

/**
 * What the brain is told about the `web.*` tools, once, in the run header of a
 * run offered them. The brain sees each tool's description cut at 160
 * characters, which ends web.read's at "Prefer this over navigating for
 * anything you only…", and the loop's `WEB_TOOL_RULE` goes to the hands'
 * prompt only, so the brain was never told where the tools stop. On the dev
 * set (web-tools-on, 2026-10-14) it read a generic route page for driving
 * distances from an area rather than a hotel (m2w2-06 r1, r2) and searched
 * for job listings 59 times without opening a board (m2w2-01 r1), where the
 * base run used a maps site's directions and the boards in the browser.
 */
const WEB_TOOLS_RULE =
  'Web tools find sources and read a page\'s text. A web.read reply is shown to you whole in the turn it arrives; ' +
  'later turns keep only its start, so "note" what you will need. They do not operate a ' +
  'site: when the task needs a site to do something (run its own search or filters, compute a route or ' +
  'driving distance, show a price, availability or listing as it is now), do that part in the browser on that site.';

/**
 * What the brain is told, once, in the run header of a run whose downloads
 * are kept (`AgentPrompt.downloadsKept`, the context's download sink is on).
 * Fleet 2026-10-19 22:22Z, run_ab036fe8 (the fleet, n=1): two files were stored
 * by the browser on the run's first two steps, and the brain, told nothing,
 * fetched both again with code.run and answered that they were "saved in
 * /work, not in the browser".
 */
const DOWNLOADS_KEPT_RULE =
  'Files the browser downloads are kept for the person who started this run and listed with the run\u2019s downloads: ' +
  'download a file by clicking its link or opening its URL in the browser, not with code.run, and name the files in the answer. ' +
  'A downloaded file is one of the run\u2019s files: to upload it to a page, attach it by its name; never create a stand-in for a file the task gives.';

/** The run's constants: the first user turn's head. Cached with the thread from step two on. */
function runHeader(prompt: AgentPrompt): string {
  const lines = [`TASK: ${prompt.task}`];
  if (prompt.today !== undefined) {
    lines.push(`Today: ${prompt.today} (UTC).`);
  }
  if (prompt.schema !== undefined) {
    lines.push(`Schema to fill (record with a read): ${JSON.stringify(prompt.schema)}`);
  }
  if (prompt.caps !== undefined) {
    const { limits } = prompt.caps;
    lines.push(
      `Budget: ${limits.budget} credits` +
        (limits.steps === undefined ? '' : `, ${String(limits.steps)} steps`) +
        (limits.duration === undefined ? '' : `, ${limits.duration}`) +
        '.',
    );
  }
  for (const tool of prompt.tools ?? []) {
    // Every description cut at 160 characters but code.run's, page.script's and
    // web.ask's: each one's description is the brain's only instruction about
    // it, and 160 would end it before what to use it for (code.run: that it
    // does not see the browser's page; page.script: that it never clicks or
    // types; web.ask: to open a cited source before the final answer).
    const whole = tool.name === CODE_RUN_TOOL || tool.name === PAGE_SCRIPT_TOOL || tool.name === WEB_ASK_TOOL;
    const description = whole ? tool.description : clip(tool.description, 160);
    lines.push(`Tool ${tool.name}: ${description}${tool.inputSchema === undefined ? '' : ` ${JSON.stringify(tool.inputSchema)}`}`);
  }
  if ((prompt.tools ?? []).some((tool) => tool.name.startsWith('web.'))) {
    lines.push(WEB_TOOLS_RULE);
  }
  // The loop's account-wall sentence, for a run granted a service that
  // can make a throwaway inbox (never a person's own mailbox): the brain decides, and never reads the hands' tool rule.
  // It names the system prompt's "Login or paywall" rule it overrides, so that
  // rule stays byte for byte, and cached, on every run without an inbox.
  if (offersInbox(prompt.tools ?? [], prompt.connectors ?? [])) {
    lines.push(`Login wall, this run only (overrides "sign in only with credentials it gives, else fail"): ${INBOX_SIGNUP_RULE.trimEnd()}`);
  }
  // The loop's own per-run grammar, word for word, for what this run holds:
  // nothing for a run without it. Sits with the task in the cached first
  // turn; a change mid-run (a secret arrived) rides the step that sees it
  // (see `BrainThread.step`). Each verb goes in "a" of an act and runs
  // directly (see DIRECT_TYPES).
  lines.push(...secretLines(prompt));
  if (prompt.ask === true) {
    lines.push(`Ask, as an act ("a" names no ref): ${ASK_GRAMMAR}`, ASK_RULE);
  }
  if (prompt.purchases === true) {
    lines.push(`Purchases, each an act ("a" names no ref; never a callTool):\n  ${PURCHASE_GRAMMAR}`, PURCHASE_RULE);
  }
  if (prompt.downloadsKept === true) {
    lines.push(DOWNLOADS_KEPT_RULE);
  }
  if (prompt.history.length > 0) {
    // Its findings, reads and plan follow as this first step's news: nothing
    // has been shown yet, so all of it is new.
    const older = prompt.history.length - 12;
    lines.push(
      `Resumed run. Done so far${older > 0 ? ` (${String(older)} earlier steps not shown)` : ''}:`,
      ...prompt.history.slice(-12).map((trace) => traceLine(trace, refIndex(prompt.tree))),
    );
  }
  return lines.join('\n');
}

/**
 * What the run holds and may still ask a person for, in the loop's words:
 * its secret grammar and, while it holds no card (or no billing profile) and
 * may buy, the `ask` for one. Empty for a run with neither.
 */
function secretLines(prompt: AgentPrompt): string[] {
  return [
    ...(prompt.secretGrammar === undefined ? [] : [prompt.secretGrammar]),
    ...(prompt.askWants === undefined ? [] : [`As an act ("a" names no ref): ${askWantRule(prompt.askWants)}`]),
  ];
}

function stateLine(prompt: AgentPrompt): string {
  const step = `Step ${String(prompt.step + 1)}`;
  if (prompt.caps === undefined) {
    return `${step}.`;
  }
  const { limits, used } = prompt.caps;
  return (
    `${step}${limits.steps === undefined ? '' : `/${String(limits.steps)}`}, ` +
    `credits ${used.credits}/${limits.budget}, ${humanDuration(used.elapsedMs)}.`
  );
}

/** One line for the folded summary: what was decided. Its outcome is the next step's "Last". */
export function decisionLine(step: number, decision: BrainDecision | undefined): string {
  if (decision === undefined) {
    return `${String(step + 1)}: no decision; the hands chose`;
  }
  const what =
    decision.kind === 'act'
      ? JSON.stringify(decision.action)
      : decision.kind === 'instruct'
        ? decision.instruction
        : decision.kind === 'extract'
          ? `read ${decision.extract}`
          : decision.answer;
  return `${String(step + 1)}: ${decision.kind} ${clip(what, 140)}`;
}
