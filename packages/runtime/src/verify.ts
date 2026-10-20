/**
 * Outcome verification: whether the action did what it was chosen to do.
 *
 * Everything the loop checked before this file existed was a PRE-condition.
 * `validateAction` checks the reply is well-formed against the tree it was
 * chosen from; `refreshChoice` re-checks the reference against the page as it
 * is now; `chainAbort` re-checks each chained element before dispatching it.
 * All three run BEFORE the action. Nothing ran after it, and the two signals
 * that looked like they might have were not:
 *
 * - `PerformOutcome.url` is produced by the production binding on every
 *   navigate (`worker/src/agent-deps.ts` returns `{ url: page.url() }`) and is
 *   read by nothing. The loop consumes `credits` and `usage` off that object
 *   and drops the third field.
 * - the settle asks `surveyTree` whether the page has anything actionable on it
 *   and whether it has stopped growing. That is "a page rendered", never "the
 *   right page".
 *
 * So a click that landed on the wrong element, a form that silently rejected
 * what was typed into it, and a navigate that ended on a consent wall were all
 * recorded with no `error`, rendered to the model by `compactHistory` as
 * `-> ok`, and reset the consecutive-failure count. Over twenty steps a wrong
 * turn is visible to a human reading the trace; over four hundred it is not,
 * and every run bills for the whole time it spends building on the false
 * premise.
 *
 * ## The shape: expectation, then one structural read
 *
 * An {@link Expectation} is derived from the action and the tree it was chosen
 * against, BEFORE it is dispatched — which is the only moment the "before" is
 * still available — and then asserted against one read taken after. The check
 * spends **no model call**, ever. That is not an optimisation, it is the whole
 * economics: one `getAXTree` answers in ~86 ms against a model call of 1.15 s
 * or more, so a verification pass that asked a model would double the expensive
 * half of a step to check the cheap half and would have lost before it shipped.
 *
 * What can be answered structurally is therefore what is checked:
 *
 *   the document moved        `AxTree.url`
 *   the value landed          `AxNode.value` on the node that was typed into,
 *                             or the text it renders when it has none
 *   something happened        url, target identity/state, or `hashSnapshot`
 *   an error appeared         a node the page did not have before that says so
 *
 * What needs judgement — whether the page reached is the RIGHT page, whether an
 * extracted figure is the correct one — is deliberately NOT checked here. The
 * model's own next step re-reads the page and already bills for that call;
 * buying it twice is what a verification pass must not do.
 *
 * ## Which actions, by a rule
 *
 * Check an action iff a single structural read can falsify a post-condition
 * derived from the tree it was chosen against. That admits `navigate`, `fill`,
 * `select`, `click` and `press` — five of the thirteen action types — and
 * excludes `scroll` (the accessibility tree does not express the viewport, so
 * there is nothing to falsify and every verdict would be a false
 * contradiction), `hover` (commits nothing), `extract` (its outcome is data,
 * judged by the schema), the three tab actions (their post-condition is the tab
 * list, which the next step already reads) and `done`/`fail` (they perform
 * nothing). A check that can only ever fire falsely is worse than no check,
 * because it teaches every reader to ignore the verdict.
 *
 * ## The one asymmetry
 *
 * A click that starts a navigation can be read mid-flight: nothing has changed
 * yet, and a naive verdict would call that a contradiction. So the ONLY verdict
 * that waits is the one whose entire evidence is the ABSENCE of change —
 * {@link CheckOutcome.settleable} — and it waits a bounded grace, polling. A
 * confirmed step pays exactly one read. Nothing here polls forever and nothing
 * here asks a model.
 */

import { CONCEALED_FIELD_VALUE, optionAliases, siteOf, type Clock } from '@outcrawl/scout-core';

import type { Action } from './actions';
import { describeAction, isReloadKey } from './actions';
import { monthOfName, nativeDateRuns, nativeDateValue, segmentField, type NativeDateKind } from './native-date';
import type { AxNode, AxTree, NodeRef } from './snapshot';
import { findNode, formatNodeRef, hashSnapshot, walk } from './snapshot';

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

/**
 * What the check concluded.
 *
 * `unchecked` is a first-class answer and not a failure to answer: presence
 * before property. A field that is no longer on the page cannot have its value
 * read back, and a tree that will not read cannot testify about anything, so
 * the honest verdict is that nothing was established — never a contradiction
 * inferred from an absent subject.
 */
export type CheckVerdict = 'confirmed' | 'contradicted' | 'unchecked';

/**
 * The check, as it happened, for the step trace.
 *
 * `expected` and `saw` are one line each and are written for a human reading a
 * replay beside a customer's complaint. `reads` and `elapsedMs` are the COST,
 * recorded per step rather than asserted per design: the claim "an outcome
 * check is cheap" is worth nothing unless the number is in the row.
 */
export interface CheckTrace {
  readonly verdict: CheckVerdict;
  /** What the loop expected the action to do, in the model's own vocabulary. */
  readonly expected: string;
  /** What the page said instead, or the evidence that confirmed it. */
  readonly saw: string;
  /** Extra `getAXTree` calls this check spent. One, on a confirmed step. */
  readonly reads: number;
  /** Wall time inside the check, rounded. The number a cost argument quotes. */
  readonly elapsedMs: number;
  /**
   * THE ERROR THE POST-ACTION READ THREW, verbatim and class-name first.
   *
   * Present whenever any read in this check threw, whether or not a later one
   * succeeded. It exists because the absence of it cost weeks: the read loop
   * below caught with a bare `catch {}` and counted the failure, so a check
   * that answered `unchecked` said only how MANY attempts had failed and never
   * once said why. Measured on `run_…`: 20 post-action reads, 0
   * successes, every click `unchecked`, and no record anywhere in the run of
   * what the browser had actually refused.
   *
   * `${name}: ${message}` rather than `message` alone — unlike every other
   * error string in this system, the DISCRIMINATOR here is the class. A
   * `LockLostError` means the freeze went down under the check, a
   * `LockNotHeldError` means the step's frame is gone, a `TabLostError` or
   * `UnknownTabError` means the read was aimed at a tab that is not there, and
   * a bare protocol message means the renderer refused. Those are four
   * different defects and their messages are the only thing that tells them
   * apart.
   */
  readonly readError?: string;
  /**
   * The download the action began, when that is what confirmed it.
   *
   * Present only on a check the loop confirmed BECAUSE the browser announced a
   * download: the page the action was taken on is unchanged, so without this
   * the row would read like a click that did nothing. The bytes are the
   * browser's; nothing in the run can read them, which the history line tells
   * the model. `url` is where the file came from, as the browser reported it.
   */
  readonly download?: { readonly filename: string; readonly url: string };
}

/* ------------------------------------------------------------------ *
 * The expectation
 * ------------------------------------------------------------------ */

/**
 * The node the action was aimed at, as it read BEFORE the action.
 *
 * A copy rather than a reference into the tree, and only the four fields that
 * decide identity: the tree it came from is discarded at the end of the step,
 * and `sameNode` in the loop already settled that role, name and disabled are
 * what make a node the same node. `value` is carried because it is the subject
 * of the `value` check.
 */
export interface TargetBefore {
  readonly ref: NodeRef;
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
}

/**
 * What the loop expects to be true after the action, and nothing more.
 *
 * `none` is the default for every action type whose outcome no single read can
 * falsify. The loop takes no extra read at all for those, so an unchecked
 * action costs nothing — not a round trip, not an allocation.
 */
export type Expectation =
  | { readonly kind: 'none' }
  /** `navigate`: the document should be the one that was asked for. */
  | { readonly kind: 'url'; readonly from: string; readonly to: string }
  /** `fill`/`select`: the value should be readable back off the node. */
  | { readonly kind: 'value'; readonly target: TargetBefore; readonly text: string }
  /**
   * `click`/`press`: SOMETHING should have happened, and it should not be an
   * error the page did not have before.
   *
   * The weakest of the three and still the one that catches the most, because
   * "the page is bit-for-bit what it was" is the signature of a click that
   * landed on a decoy, and "an error appeared" is the signature of a form that
   * rejected what it was given.
   */
  | {
      readonly kind: 'effect';
      readonly url: string;
      readonly hash: string;
      readonly target?: TargetBefore;
      /** Error-shaped nodes already on the page. Only a NEW one is a signal. */
      readonly errors: readonly string[];
    };

/* ------------------------------------------------------------------ *
 * Error-shaped nodes
 * ------------------------------------------------------------------ */

/** Roles whose whole purpose is to announce that something went wrong. */
const ERROR_ROLES: Readonly<Record<string, true>> = { alert: true, alertdialog: true };

/**
 * The vocabulary a page uses when it has refused something.
 *
 * Matched on the accessible NAME, which is the text a person reads, and only
 * ever against nodes the page did not have before the action — so a site whose
 * footer says "Report an error" cannot manufacture a contradiction. Word
 * boundaries throughout: "terror" is not "error" and "required" must be the
 * word, not a fragment of one.
 */
const ERROR_WORDS =
  /\b(error|invalid|required|failed|failure|incorrect|not allowed|not valid|must be|cannot be|can't be|try again|does not match|do not match|unable to|denied|rejected)\b/iu;

/**
 * A value that is nothing but mask glyphs.
 *
 * Blink renders a password input's accessible value as one mask character per
 * typed character; the glyph has changed between Chromium versions, so all the
 * plausible ones are here rather than the one this fork happens to emit. The
 * pattern deliberately admits NO alphanumerics: a value that carries real
 * characters is a value that can be compared against what was typed, and
 * comparing it is how a partially-landed fill is caught.
 */
const MASKED_VALUE = /^[\u2022\u25CF\u25AA\u2219\u00B7*\u25A0\u2027]+$/u;

/** What an input mask inserts while it formats what was typed. */
const MASK_SEPARATOR = /[\s\-/().]/u;

/**
 * Whether a field reads back `typed` as a mask formats it: every typed
 * character present and in order, and nothing else but {@link MASK_SEPARATOR}.
 *
 * Measured 2026-09-23 on the first production runs whose fills were ever read
 * back (every earlier check was lost to the lock): 6 of 17 fills contradicted,
 * every one a mask at work: "08/31" read "08 / 31", "+13022356545" read
 * "+1 302-235-6545", and a card number read back in groups of four.
 *
 * ONE DIRECTION ONLY: a separator may be ADDED, a typed character may never
 * be missing. So the fill that lost every space on 2026-09-08 still reads as
 * the contradiction it was.
 */
function formattedAs(value: string, typed: string): boolean {
  const want = [...typed.toLowerCase()];
  let next = 0;
  for (const char of value.toLowerCase()) {
    if (char === want[next]) {
      next += 1;
    } else if (!MASK_SEPARATOR.test(char)) {
      return false;
    }
  }
  return next === want.length;
}

/** Collapsed whitespace, lower-cased. The comparison unit for a name. */
function normalise(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * What a control reads as: its accessible value, or — when Blink exposes no
 * value for it — the text it renders, which is what a person reads off it.
 *
 * MEASURED 2026-10-01 on the fleet rig's fork (Chrome/152.0.7977.64,
 * `probe-fill-fidelity.ts`): the three segments of a native
 * `<input type=date>` are `spinbutton` nodes that carry NO `value` at all.
 * What is in a segment is its one `StaticText` child: "mm" while empty, "01"
 * once 01 is typed. Reading `value` alone called every one of those fills
 * "still empty" while the input held `1990-01-15`, and that false verdict
 * stopped three BU Bench runs on the no-effect guard (tasks 22, 27, 77) and
 * told the judge a fourth never filled its date (task 62).
 *
 * Text, not `name`: the segment's name is its label ("Month Date of Birth"),
 * which would compare a fill against the field's caption.
 */
function readBack(node: AxNode): string {
  const value = normalise(node.value);
  if (value !== '' || node.children === undefined) {
    return value;
  }
  const parts: string[] = [];
  const visit = (child: AxNode): void => {
    if (child.role === 'StaticText' && child.name !== undefined) {
      parts.push(child.name);
    }
    for (const grandchild of child.children ?? []) {
      visit(grandchild);
    }
  };
  for (const child of node.children) {
    visit(child);
  }
  return normalise(parts.join(' '));
}

/** The name of the first dialog showing in the tree (`''` when it has none), or `undefined` when none is open. */
function openDialog(node: AxNode): string | undefined {
  if (node.role === 'dialog' || node.role === 'alertdialog') return normalise(node.name);
  for (const child of node.children ?? []) {
    const found = openDialog(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * What a field held before the text was typed after it, when its value is
 * that leftover followed by `want` and the leftover is itself the start of
 * `want` (an earlier entry of it, cut off): else `undefined`. Case-blind.
 */
function leftoverOf(value: string, want: string): string | undefined {
  if (want === '' || value.length <= want.length || !value.toLowerCase().endsWith(want.toLowerCase())) return undefined;
  const leftover = value.slice(0, value.length - want.length);
  return want.toLowerCase().startsWith(leftover.trimEnd().toLowerCase()) && leftover.trim() !== '' ? leftover : undefined;
}

/**
 * Native segmented inputs advance focus as digits are typed. The filtered AX
 * tree flattens their host, leaving spinbuttons separated by literal punctuation.
 * Read only that contiguous run, starting at the segment the action named:
 * unrelated controls, labels and frame boundaries must never supply digits.
 */
function continuedValue(tree: AxTree, target: AxNode, typed: string): string | undefined {
  if (target.role !== 'spinbutton') return undefined;
  for (const parent of walk(tree)) {
    const children = parent.children;
    if (children === undefined) continue;
    const start = children.indexOf(target);
    if (start < 0) continue;
    let value = readBack(target);
    for (let index = start + 1; index + 1 < children.length; index += 2) {
      const separator = children[index];
      const segment = children[index + 1];
      if (
        separator?.role !== 'StaticText' ||
        !/^[\s/.:–-]+$/u.test(separator.name ?? '') ||
        segment?.role !== 'spinbutton' ||
        segment.ref.frameOrdinal !== target.ref.frameOrdinal
      ) {
        break;
      }
      value += (separator.name ?? '') + readBack(segment);
      if (formattedAs(value, typed)) return value;
    }
    return undefined;
  }
  return undefined;
}

interface SegmentedRead {
  /** The kind of input the segments make up, from the fields they edit. */
  readonly kind: NativeDateKind;
  /** The input's value in HTML's syntax, or `undefined` while any segment is unfilled. */
  readonly value: string | undefined;
  /** The segments as a person reads them: "07:30 PM". */
  readonly shown: string;
  /** Each segment's field and what it shows, in order. */
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * The whole native date/time input `target` is one segment of, read off EVERY
 * segment rather than the one the action named.
 *
 * A fill names one segment, and the value lands across all of them: typed
 * into "Hours", "1930" reads "07" there and ":30 PM" in the two segments after
 * it, which is `19:30` in the input. MEASURED on a fleet Mac, 2026-10-02, n=3:
 * that fill leaves `input.value === "19:30"`, and a production run (the brain model)
 * was told it was contradicted because "07" is not "1930".
 *
 * Two segments may also sit side by side with no separator (see
 * {@link nativeDateRuns}), and a segment reads what it SHOWS before its value.
 * MEASURED on stock Chromium 2026-10-13 (Playwright's build, en-US, n=1 per
 * shape): each segment carries a value as well as its text, "7" beside "07",
 * "2" beside "pm", "0" beside "--" when empty. Read by value and stopped at
 * the missing space before AM/PM, a fill that left `input.value === "19:30"`
 * was told it read "7:30, which is 07:30, not 19:30".
 */
function segmentedRead(tree: AxTree, target: AxNode): SegmentedRead | undefined {
  if (target.role !== 'spinbutton') return undefined;
  for (const parent of walk(tree)) {
    const children = parent.children;
    if (children === undefined) continue;
    const at = children.indexOf(target);
    if (at < 0) continue;
    const run = nativeDateRuns(children).find(({ start, end }) => start <= at && at <= end);
    if (run === undefined) return undefined;
    const fields = new Map<string, string>();
    let shown = '';
    for (let index = run.start; index <= run.end; index += 1) {
      const node = children[index] as AxNode;
      const field = segmentField(node);
      if (field === undefined) {
        shown += node.name ?? '';
        continue;
      }
      if (index > run.start && segmentField(children[index - 1]) !== undefined) shown += ' ';
      const drawn = normalise(
        (node.children ?? [])
          .filter((child) => child.role === 'StaticText')
          .map((child) => child.name ?? '')
          .join(' '),
      );
      const text = drawn === '' ? readBack(node) : drawn;
      fields.set(field, text);
      shown += text;
    }
    return { kind: run.kind, value: segmentedValue(run.kind, fields), shown, fields };
  }
  return undefined;
}

/** The input's value from its segments' texts, or `undefined` while one is unfilled. */
function segmentedValue(kind: NativeDateKind, fields: ReadonlyMap<string, string>): string | undefined {
  const number = (field: string): string | undefined => {
    const text = fields.get(field);
    return text !== undefined && /^\d+$/u.test(text) ? text : undefined;
  };
  const month = number('month') ?? monthOfName(fields.get('month') ?? '')?.toString();
  const date = `${number('year') ?? '?'}-${month ?? '?'}-${number('day') ?? '?'}`;
  let time = '?';
  const hour = number('hour');
  const minute = number('minute');
  if (hour !== undefined && minute !== undefined) {
    const ampm = fields.get('ampm');
    const half = ampm === undefined ? '' : /^([AP])\.?M\.?$/iu.exec(ampm)?.[1];
    time = half === undefined ? '?' : `${hour}:${minute}${fields.has('second') ? `:${number('second') ?? '?'}` : ''}${half === '' ? '' : ` ${half}M`}`;
  }
  const text =
    kind === 'time'
      ? time
      : kind === 'date'
        ? date
        : kind === 'datetime-local'
          ? `${date}T${time}`
          : kind === 'month'
            ? `${number('year') ?? '?'}-${month ?? '?'}`
            : `${number('year') ?? '?'}-W${number('week') ?? '?'}`;
  return text.includes('?') ? undefined : nativeDateValue(kind, text);
}

/**
 * The verdict on a fill into a segment of a native date/time input, judged on
 * the WHOLE input; `undefined` when `target` is not one or `want` is not a
 * value of its kind, which leaves the text comparisons to decide.
 *
 * Two shapes of fill, both measured on a fleet Mac 2026-10-02 (n=3 each):
 *
 * - A whole value ("19:30", "7:30 PM", "1930", "2026-10-03") is compared in
 *   HTML's syntax against the value the segments make, both sides normalised
 *   the same way, so "1930" and "07:30 PM" are one value and "07:30 --" is
 *   not a value at all.
 * - An hour past 12 into a 12-hour "Hours" segment: Blink shows 19 as "07"
 *   and sets the AM/PM segment to "PM" itself. That is the hour asked for.
 */
function segmentedVerdict(
  after: AxTree,
  target: AxNode,
  want: string,
  expected: string,
): CheckOutcome | undefined {
  const read = segmentedRead(after, target);
  if (read === undefined) return undefined;
  const wanted = nativeDateValue(read.kind, want);
  if (wanted !== undefined) {
    return read.value === wanted
      ? {
          verdict: 'confirmed',
          expected,
          saw: `the input reads ${JSON.stringify(read.shown)}, which is ${wanted}`,
          settleable: false,
        }
      : {
          verdict: 'contradicted',
          expected,
          saw:
            read.value === undefined
              ? `the input reads ${JSON.stringify(read.shown)}, which is not a complete value: ${wanted} did not land`
              : `the input reads ${JSON.stringify(read.shown)}, which is ${read.value}, not ${wanted}`,
          settleable: true,
        };
  }
  const hour = /^\d{1,2}$/u.test(want) ? Number(want) : undefined;
  const ampm = read.fields.get('ampm');
  const shownHour = read.fields.get('hour');
  if (hour !== undefined && hour > 12 && hour < 24 && ampm !== undefined && shownHour !== undefined) {
    if (Number(shownHour) === hour - 12 && /^P\.?M\.?$/iu.test(ampm)) {
      return {
        verdict: 'confirmed',
        expected,
        saw: `the hour reads ${JSON.stringify(`${shownHour} ${ampm}`)}, which is ${String(hour)}:00 on a 24-hour clock`,
        settleable: false,
      };
    }
  }
  return undefined;
}

/**
 * Every error-shaped node in the tree, as `role|name` keys.
 *
 * Keyed on role and name rather than on the reference, because the reference is
 * minted per renderer and a re-render that recreates the same message must not
 * read as a new one.
 *
 * `AxState.invalid` IS DELIBERATELY NOT CONSULTED, and that is a measurement
 * rather than a preference. This function used to trust it, and the first live
 * proof reported two contradictions that were wrong because of it: clicking
 * Login — which really did log in and navigate — came back `the page now
 * reports "Open Menu"`, and clicking Continue on a complete form came back
 * `the page now reports "Finish"`. `probe-error-signals.ts` then counted what
 * the fork actually sets on `saucedemo.com`: 3 of 13 nodes on the login page
 * and 8 of 55 on the inventory page carry `invalid: true`, and every one of
 * them is an ordinary control — both textboxes, the Login button, the sort
 * combobox and all six Add-to-cart buttons. The flag answers, and it answers
 * about something other than validity, so nothing may be concluded from it.
 *
 * What remains is what a person reads: a node whose ROLE exists to announce a
 * problem, or a node whose accessible NAME says one. Both are page-authored
 * text, and both are diffed against the page as it was, so a footer that says
 * "Report an error" cannot manufacture a verdict.
 */
export function errorSignals(tree: AxTree): readonly string[] {
  const found: string[] = [];
  for (const node of walk(tree)) {
    const name = normalise(node.name);
    if (ERROR_ROLES[node.role] === true || (name !== '' && ERROR_WORDS.test(name))) {
      found.push(`${node.role}|${name}`);
    }
  }
  return found;
}

function snapshotOf(node: AxNode): TargetBefore {
  return {
    ref: node.ref,
    role: node.role,
    name: normalise(node.name),
    value: readBack(node),
    disabled: node.state?.disabled === true,
  };
}

/**
 * What to expect of this action, derived from the tree it was chosen against.
 *
 * MUST be called before the action is dispatched. `hash` is the caller's own
 * `hashSnapshot(chosenFrom)`, passed rather than recomputed because the loop
 * already has it on the pending step and hashing a tree twice per step to save
 * an argument is a real cost on a page with thousands of nodes.
 */
export function expectationFor(action: Action, chosenFrom: AxTree, hash: string): Expectation {
  switch (action.type) {
    case 'navigate':
      return { kind: 'url', from: chosenFrom.url, to: action.url };

    case 'fill':
    case 'select': {
      const node = findNode(chosenFrom, action.ref);
      const target = node === undefined ? undefined : snapshotOf(node);
      if (target === undefined) {
        // Cannot happen through the loop: the reference was validated against
        // this tree. Reported as unverifiable rather than assumed away.
        return { kind: 'none' };
      }
      return { kind: 'value', target, text: action.type === 'fill' ? action.text : action.value };
    }

    case 'click':
    case 'press': {
      // A POINT CLICK ASSERTS NOTHING, like `drag` and `scroll`. What it is
      // for — a canvas, a map, a painted grid — changes pixels and not the
      // accessibility tree, so "the page changed" would contradict a click
      // that worked, charge it to `stepFailures`, and rule it out.
      if (action.type === 'click' && action.at !== undefined) {
        return { kind: 'none' };
      }
      // A RELOAD KEY is performed as a navigate to the document's url (see
      // `isReloadKey`), and a reloaded static page reads bit-for-bit as it
      // did: "nothing changed" would contradict a reload that worked. It is
      // judged as what it is, a load of the page's own url. On the browser's
      // error page the tree's url is not the one reloaded (the failed url
      // is, and only the binding reads it), so nothing is asserted there.
      if (action.type === 'press' && isReloadKey(action.key)) {
        return /^https?:/.test(chosenFrom.url)
          ? { kind: 'url', from: chosenFrom.url, to: chosenFrom.url }
          : { kind: 'none' };
      }
      const aimed = action.ref === undefined ? undefined : findNode(chosenFrom, action.ref);
      const target = aimed === undefined ? undefined : snapshotOf(aimed);
      return {
        kind: 'effect',
        url: chosenFrom.url,
        hash,
        ...(target === undefined ? {} : { target }),
        errors: errorSignals(chosenFrom),
      };
    }

    // Everything else, by the rule in the header: no post-condition one
    // structural read can falsify.
    default:
      return { kind: 'none' };
  }
}

/**
 * The verbs whose outcome a single structural read can falsify, by name.
 *
 * Keyed by string rather than narrowed through {@link expectationFor} because
 * {@link expectationForProgram} is handed the reply's RAW elements: a motor
 * program is validated one element at a time against the page as it is at that
 * instant, deliberately, so at the moment the expectation is derived nothing
 * has been through `validateAction` yet. The verb is the only field read, and
 * an element that is not an object or names an unknown verb simply does not
 * count — it will be refused at dispatch and the expectation must not rest on
 * it.
 *
 * The set is exactly the five `expectationFor` answers for, and that is a
 * contract between the two: a verb added there must be added here or a program
 * containing it goes unwatched.
 */
const CHECKABLE_VERBS: Readonly<Record<string, true>> = {
  navigate: true,
  fill: true,
  select: true,
  click: true,
  press: true,
};

/**
 * What to expect of a whole MOTOR PROGRAM — the head action plus the elements
 * of `Envelope.then` — rather than of its head alone.
 *
 * ── The hole this closes ──────────────────────────────────────────────────
 *
 * The post-action read is taken AFTER the whole program, precisely so that a
 * sequence is judged on where it left the page. The expectation was derived
 * from the head action ALONE, so a step whose head asserts nothing — a
 * `scroll`, a `hover`, an `extract` — took no read at all and every click in
 * its program was unobservable. A click that changes nothing is the single most
 * common real failure there is, and it was invisible for the whole width of
 * that arm.
 *
 * ── What is asserted, and why it is `effect` and not the element's own ─────
 *
 * "The page changed, and no new error appeared on it", derived from the tree
 * the whole program was chosen against. That is the only post-condition that
 * is true of a SEQUENCE: a `value` expectation about a mid-program field would
 * be an expectation about a node a later element may have submitted away, and
 * `checkOutcome` would answer `unchecked` for it — a check that costs a read
 * and establishes nothing. "Something happened" is monotone across the
 * program: whichever element moved the page, the hash moved with it.
 *
 * ── When the head keeps its own ───────────────────────────────────────────
 *
 * Whenever it has one. The head's `value` or `url` expectation is strictly
 * stronger evidence than "something changed", and a program that does not
 * destroy the head's target still confirms it — measured on the fleet rig,
 * four of four `fill` steps `confirmed` on the value they read back. A head
 * whose target the program then destroys answers `unchecked` rather than
 * contradicting, so keeping it can never manufacture a false verdict.
 *
 * ── And when nothing is asserted at all ───────────────────────────────────
 *
 * A head that MOVES FOCUS, because the read after the program lands on a
 * different tab and every field of it would differ from this tree — which
 * `checkOutcome` would read as "the page changed" and CONFIRM, for a program
 * that may have done nothing whatsoever. A false confirmation is worse than no
 * check, so the three tab verbs assert nothing here, exactly as they assert
 * nothing in {@link expectationFor}.
 */
export function expectationForProgram(
  head: Action,
  program: readonly unknown[],
  chosenFrom: AxTree,
  hash: string,
): Expectation {
  const own = expectationFor(head, chosenFrom, hash);
  if (own.kind !== 'none') {
    return own;
  }
  if (head.type === 'openTab' || head.type === 'focusTab' || head.type === 'closeTab') {
    return { kind: 'none' };
  }
  const touches = program.some((element) => {
    if (typeof element !== 'object' || element === null || !('type' in element)) {
      return false;
    }
    const verb = element.type;
    // A point click is exempt here for the reason `expectationFor` gives.
    if (verb === 'click' && 'at' in element && element.at !== undefined) {
      return false;
    }
    return typeof verb === 'string' && CHECKABLE_VERBS[verb] === true;
  });
  return touches
    ? { kind: 'effect', url: chosenFrom.url, hash, errors: errorSignals(chosenFrom) }
    : { kind: 'none' };
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

export interface CheckOutcome {
  readonly verdict: CheckVerdict;
  readonly expected: string;
  readonly saw: string;
  /**
   * Whether this verdict rests entirely on the ABSENCE of a change, which a
   * page that is still working can still supply. The only verdict the caller
   * waits on. A contradiction with positive evidence — an error message, a
   * value that is present and wrong — is final and waits for nothing.
   */
  readonly settleable: boolean;
}

/** One line naming what was expected, for a trace and for a `ruledOut` note. */
export function describeExpectation(expect: Expectation): string {
  switch (expect.kind) {
    case 'none':
      return 'nothing: this action has no outcome one page read can check';
    case 'url':
      return `the browser to be on ${expect.to}`;
    case 'value':
      return expect.text === ''
        ? `${expect.target.role} ${JSON.stringify(expect.target.name)} to be empty`
        : `${expect.target.role} ${JSON.stringify(expect.target.name)} to read ${JSON.stringify(expect.text)}`;
    case 'effect':
      return 'the page to change, and no new error on it';
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Judges a navigate against the url the browser ended up on.
 *
 * Split out of {@link checkOutcome} because a navigate has a SECOND source for
 * that url — `PerformOutcome.url`, which the production binding computes off
 * the navigation's own commit event — and the loop uses it as a FALLBACK when
 * the page could not be read.
 *
 * It used to be preferred outright, on the argument that "a page that has just
 * committed under the freeze cannot produce an accessibility tree at all,
 * because `VirtualTimePolicy::kPause` stops it being produced". THAT ARGUMENT
 * WAS WRONG. No tree was produced because no `Outcrawl.getAXTree` was ever
 * sent: a navigation makes the browser release the action-lock, and the read
 * was refused by `PageSession.#require` on the dead lock before it reached CDP.
 * Measured on the fleet rig on 2026-09-09 — `LockLostError` on 4 of 4
 * navigating clicks, in both a one-page and a tabbed arm, with the -32000 the
 * old comment described appearing nowhere. `PageSession.snapshotAfterAction`
 * is the fix and the read now answers. See {@link checkReportedUrl} for why
 * the self-report is the weaker of the two witnesses.
 */
function compareUrl(expect: Expectation & { kind: 'url' }, landedOn: string): CheckOutcome {
  const expected = describeExpectation(expect);
  const target = originOf(expect.to);
  const landed = originOf(landedOn);
  if (target !== undefined && landed === target) {
    // Same origin is the bar, deliberately, and not the same path: a site
    // routing `/` to `/news` has served the document that was asked for, and
    // the model reads the tree of wherever it ended up on the next step
    // regardless. A cross-site landing is a different matter and is the
    // consent wall, the login gate and the geo-redirect, all of which the model
    // has to be told about.
    return {
      verdict: 'confirmed',
      expected,
      saw: `the browser is on ${landedOn}`,
      settleable: false,
    };
  }
  if (landedOn === expect.from) {
    return {
      verdict: 'contradicted',
      expected,
      saw: `the browser is still on ${landedOn}`,
      settleable: true,
    };
  }
  /**
   * A SAME-SITE REDIRECT TOOK EFFECT. The site moved the navigation to one of
   * its own hosts -- duckduckgo.com/html commits as html.duckduckgo.com/html,
   * example.com as www.example.com -- and the model reads that page's tree, url
   * included, on the next step. Judged `contradicted`, a working navigation
   * was charged to `stepFailures` and BrowseComp smoke runs were stopped on a
   * same-query redirect (2 of 10, 2026-10-02).
   *
   * "Same site" here is one host being the other or a subdomain of it.
   * Sibling subdomains (`www.search.example` and `consent.search.example`) stay
   * contradicted by this rule, which is the consent wall's own shape, and so
   * does every cross-site landing.
   */
  const asked = URL.parse(expect.to);
  const reached = URL.parse(landedOn);
  const host = reached?.hostname;
  if (
    asked !== null &&
    host !== undefined &&
    /^https?:$/.test(reached?.protocol ?? '') &&
    (asked.hostname === host ||
      (host.endsWith(`.${asked.hostname}`) && asked.hostname.includes('.')) ||
      (asked.hostname.endsWith(`.${host}`) && host.includes('.')))
  ) {
    return {
      verdict: 'confirmed',
      expected,
      saw: `the browser was redirected and is on ${landedOn}`,
      settleable: false,
    };
  }
  /**
   * A SITE'S OWN REGIONAL HOST, SAME PAGE. www.shein.com/ commits as
   * us.shein.com/?cdn_rsite=cf&ref=www&rep=dir&ret=us on every load
   * (11 of 12 fleet sessions, 2026-10-07 02:24-02:33Z), so that navigate
   * could never be confirmed: Stealth Bench task 15 r9 (run_…) was
   * stopped on it as the fourth failed step in a row. A sibling host on the
   * same registrable domain ({@link siteOf}) is confirmed only when it serves
   * the SAME PATH, https to https; a query the site adds is allowed. A
   * sibling that moves the path -- `/` to `/login`, a consent or challenge
   * page -- stays contradicted. `saw` names where it landed either way.
   */
  const site = siteOf(expect.to);
  if (
    asked !== null &&
    reached !== null &&
    asked.protocol === 'https:' &&
    reached.protocol === 'https:' &&
    site !== undefined &&
    siteOf(landedOn) === site &&
    reached.pathname === asked.pathname
  ) {
    return {
      verdict: 'confirmed',
      expected,
      saw: `the browser was redirected to the site's own host and is on ${landedOn}`,
      settleable: false,
    };
  }
  return {
    verdict: 'contradicted',
    expected,
    saw: `the browser was sent elsewhere and is on ${landedOn}`,
    settleable: false,
  };
}

/**
 * The navigate check, on the url the ACTION ITSELF reported. Zero page reads.
 *
 * A FALLBACK and no longer the primary. It is the only witness available in two
 * cases — a read that could not answer at all, and a host binding that reports
 * no url, which is every test bed in this package — and in both it is worth
 * having for free.
 *
 * It is the weaker witness because it is a browser-side observation of a commit
 * rather than the renderer's own answer to "what am I showing". `AxTree.url`
 * comes off the document that is actually there, after every redirect;
 * `PerformOutcome.url` was measured LYING on `run_…`, where 2 of 7
 * navigate self-reports came back `contradicted` — "the browser is still on
 * current.fas.harvard.edu" — for navigations that had worked. The race behind
 * that is fixed at its source in `worker/src/agent-deps.ts`, which now waits
 * for the commit EVENT rather than for `Page.navigate`'s reply; this stays the
 * second opinion rather than the first regardless, because a cached string can
 * be stale and a tree cannot.
 */
export function checkReportedUrl(expect: Expectation, landedOn: string): CheckTrace | undefined {
  if (expect.kind !== 'url') {
    return undefined;
  }
  const outcome = compareUrl(expect, landedOn);
  return {
    verdict: outcome.verdict,
    expected: outcome.expected,
    saw: `${outcome.saw}, as the navigation itself reported`,
    reads: 0,
    elapsedMs: 0,
  };
}

/**
 * What a concealed field's check says, word for word. Fixed sentences: the
 * model learns whether ITS OWN write took and nothing about the value.
 */
export const CONCEALED_CHECK_SAW = {
  holds: 'the field holds what you chose (its value is concealed from you)',
  differs: 'the field does not hold what you chose (its value is concealed from you)',
  uncompared: 'the field holds a value concealed from you, and whether it is what you chose could not be compared',
} as const;

/**
 * Whether a field reads, IN THE UNCONCEALED TREE, as `wanted`: the private
 * half of the check on a field the model is shown as
 * {@link CONCEALED_FIELD_VALUE}. Called by the host on a tree it never hands
 * to a model, a step or a log, and only the boolean comes back.
 *
 * The same normalisation as {@link checkOutcome}'s own (whitespace, case, a
 * mask's separators, a native date's segments, mask glyphs), with two
 * differences, both on purpose:
 *
 * - EQUALITY, NEVER A SUBSTRING. A field that ignored the write (read-only,
 *   or a page that reverted it) still holds what was there before, and
 *   "does it contain what I typed" would answer digit by digit what a
 *   concealed card field holds. "Is it exactly what I typed" is one whole
 *   guess per step, and a write that took overwrote the field anyway.
 * - A CODE MATCHES ITS NAME ({@link optionAliases}): a listbox that chose
 *   "California" for a select of "CA" reads as holding it.
 */
export function heldPrivately(raw: AxTree, ref: NodeRef, wanted: string): boolean {
  const live = findNode(raw, ref);
  if (live === undefined) return false;
  const value = readBack(live);
  const want = normalise(wanted);
  if (want === '') return value === '';
  const segmented = segmentedVerdict(raw, live, want, '');
  if (segmented !== undefined) return segmented.verdict === 'confirmed';
  const shown = value.toLowerCase();
  return (
    [want, ...optionAliases(want)].some((name) => name.toLowerCase() === shown) ||
    formattedAs(value, want) ||
    continuedValue(raw, live, want) !== undefined ||
    MASKED_VALUE.test(value)
  );
}

/**
 * The verdict on a field that reads as {@link CONCEALED_FIELD_VALUE}, from
 * the host's private comparison (`held`, see {@link heldPrivately}).
 * `undefined` — a host that cannot compare, or a placeholder this run never
 * revealed into that field — is unchecked, never contradicted: a check must
 * not fail a step on what it could not read.
 */
function concealedVerdict(expected: string, held: boolean | undefined): CheckOutcome {
  if (held === true) return { verdict: 'confirmed', expected, saw: CONCEALED_CHECK_SAW.holds, settleable: false };
  if (held === false) return { verdict: 'contradicted', expected, saw: CONCEALED_CHECK_SAW.differs, settleable: true };
  return { verdict: 'unchecked', expected, saw: CONCEALED_CHECK_SAW.uncompared, settleable: false };
}

/** The fill or select whose field reads as {@link CONCEALED_FIELD_VALUE} in `after`, else `undefined`. */
function concealedTarget(expect: Expectation, after: AxTree): { readonly ref: NodeRef; readonly written: string } | undefined {
  if (expect.kind !== 'value' || normalise(expect.text) === '') return undefined;
  const live = findNode(after, expect.target.ref);
  return live !== undefined && readBack(live) === CONCEALED_FIELD_VALUE ? { ref: live.ref, written: expect.text } : undefined;
}

/**
 * Asserts one expectation against one read. Pure, and the whole verdict logic.
 *
 * Every branch is ordered so that POSITIVE evidence beats absence: an error
 * message that appeared is a contradiction even though the page also changed,
 * because the change IS the error appearing. A page that changed with no new
 * error is confirmed. Only the page that did not change at all is settleable.
 *
 * `held` is the host's private answer for a field the model is shown as
 * {@link CONCEALED_FIELD_VALUE}; see {@link concealedVerdict}.
 */
export function checkOutcome(expect: Expectation, after: AxTree, held?: boolean): CheckOutcome {
  const expected = describeExpectation(expect);
  switch (expect.kind) {
    case 'none':
      return { verdict: 'unchecked', expected, saw: 'nothing was asserted', settleable: false };

    case 'url':
      return compareUrl(expect, after.url);

    case 'value': {
      const live = findNode(after, expect.target.ref);
      if (live === undefined) {
        // The field is gone. Nothing can be read back off it, so nothing is
        // established: a page that replaced the form after accepting the value
        // and a page that threw the form away look identical from here, and
        // guessing between them is exactly the invention this check exists to
        // stop.
        //
        // EXCEPT that a dialog now over the page is said, because it is the
        // usual reason and it changes what the model must do next. Fleet
        // 2026-10-20 (Outcrawl Bench dev venues-hold, run_722c543f and
        // run_456e5cd8, n=2 of 2): a timed "Are you still there?" dialog opened
        // mid-typing, took the rest of the keys, and hid the field; the model
        // read only that the value "cannot be read back", answered the dialog,
        // and booked with the half-typed name.
        const dialog = openDialog(after.root);
        return {
          verdict: 'unchecked',
          expected,
          saw:
            dialog === undefined
              ? 'the element is no longer on the page, so its value cannot be read back'
              : `a dialog${dialog === '' ? '' : ` ${JSON.stringify(dialog)}`} is open over the page and hides the field, so its value ` +
                'cannot be read back; keys typed while it opened may have gone to the dialog instead. Answer the dialog, then ' +
                'read the field and fill it again if it does not hold the whole text',
          settleable: false,
        };
      }
      const value = readBack(live);
      const want = normalise(expect.text);
      if (want === '') {
        return value === ''
          ? { verdict: 'confirmed', expected, saw: 'the field is empty', settleable: false }
          : {
              verdict: 'contradicted',
              expected,
              saw: `the field still reads ${JSON.stringify(value)}`,
              settleable: true,
            };
      }
      if (value === CONCEALED_FIELD_VALUE) {
        return concealedVerdict(expected, held);
      }
      const segmented = segmentedVerdict(after, live, want, expected);
      if (segmented !== undefined) {
        return segmented;
      }
      if (value.toLowerCase().includes(want.toLowerCase())) {
        // TYPED AFTER WHAT THE FIELD ALREADY HELD rather than over it: the text
        // plus a leftover that is itself the start of the text (an earlier,
        // cut-off entry of it). Fleet 2026-10-20, run_456e5cd8: a field read
        // "…members sociaHollinbridge Camera Club members social" and this
        // confirmed it, because the text is in there. An autocomplete that adds
        // to the text ("London" → "London, UK") leaves no such leftover.
        const leftover = leftoverOf(value, want);
        if (leftover !== undefined) {
          return {
            verdict: 'contradicted',
            expected,
            saw:
              `the field reads ${JSON.stringify(value)}: the text was typed after ${JSON.stringify(leftover)}, which the ` +
              'field already held, instead of replacing it. Fill it with "" to empty it, then fill it again',
            settleable: false,
          };
        }
        return {
          verdict: 'confirmed',
          expected,
          saw: `the field reads ${JSON.stringify(value)}`,
          settleable: false,
        };
      }
      if (formattedAs(value, want)) {
        return {
          verdict: 'confirmed',
          expected,
          saw: `the field reads ${JSON.stringify(value)}, which is what was typed as the field formats it`,
          settleable: false,
        };
      }
      const continued = continuedValue(after, live, want);
      if (continued !== undefined) {
        return {
          verdict: 'confirmed',
          expected,
          saw: `the consecutive input segments read ${JSON.stringify(continued)}`,
          settleable: false,
        };
      }
      if (MASKED_VALUE.test(value)) {
        /**
         * A MASKED FIELD IS STILL EVIDENCE, and it is the ONLY case where a
         * value that does not match is accepted.
         *
         * A password input reports its value as mask glyphs — Blink fills it
         * with one per character — so an exact match is unavailable by design,
         * and contradicting every password fill in the product would be the
         * false verdict that makes the whole check ignorable.
         *
         * NARROW ON PURPOSE: the value must contain nothing but mask glyphs. An
         * earlier version of this clause accepted any field that was empty and
         * is no longer, and that version would have CONFIRMED the production
         * defect measured on 2026-09-08 — `agent-deps.ts` dropped every space
         * from every typed string, so a search box asked for "vegan chocolate
         * chip cookies" read back "veganchocolatechipcookies" and three real
         * runs burned 20 steps each searching for a nonsense token. A value
         * with alphanumerics in it is a value that can be compared, so it is.
         */
        return {
          verdict: 'confirmed',
          expected,
          saw: `the field reports ${String(value.length)} masked character(s)`,
          settleable: false,
        };
      }
      return {
        verdict: 'contradicted',
        expected,
        saw:
          value === ''
            ? 'the field is still empty: what was typed did not land in it'
            : `the field reads ${JSON.stringify(value)}, not ${JSON.stringify(want)}`,
        settleable: true,
      };
    }

    case 'effect': {
      /**
       * A NAVIGATION OUTRANKS EVERY OTHER READING, and the order matters.
       *
       * A click that replaced the document did the thing it was for, whatever
       * the destination page happens to say — and destination pages say all
       * sorts of things, including the word "error" in a footer link. Judging
       * the error clause first made the check contradict a click that had just
       * succeeded, which is the one failure mode a verification pass cannot
       * afford. The model reads the destination's own tree on the very next
       * step, so anything wrong with where it landed is one model call away
       * from being visible, at no extra cost.
       */
      if (after.url !== expect.url) {
        return {
          verdict: 'confirmed',
          expected,
          saw: `the page went to ${after.url}`,
          settleable: false,
        };
      }
      /**
       * A NEW ERROR ON THE SAME DOCUMENT, which is what a form that silently
       * rejects looks like: the url holds, the tree gains a node, and that node
       * is the refusal. Diffed against the errors the page already had, so only
       * something this action produced can speak.
       */
      const before = new Set(expect.errors);
      const appeared = errorSignals(after).filter((signal) => !before.has(signal));
      const first = appeared[0];
      if (first !== undefined) {
        return {
          verdict: 'contradicted',
          expected,
          saw: `the page now reports ${JSON.stringify(first.split('|')[1] ?? first)}`,
          settleable: false,
        };
      }
      if (expect.target !== undefined) {
        const live = findNode(after, expect.target.ref);
        if (live === undefined) {
          return {
            verdict: 'confirmed',
            expected,
            saw: `${expect.target.role} ${JSON.stringify(expect.target.name)} is gone from the page`,
            settleable: false,
          };
        }
        const now = snapshotOf(live);
        if (
          now.role !== expect.target.role ||
          now.name !== expect.target.name ||
          now.disabled !== expect.target.disabled ||
          now.value !== expect.target.value
        ) {
          return {
            verdict: 'confirmed',
            expected,
            saw: `${expect.target.role} ${JSON.stringify(expect.target.name)} is now ${now.role} ${JSON.stringify(now.name)}${now.disabled ? ' and disabled' : ''}`,
            settleable: false,
          };
        }
      }
      if (hashSnapshot(after) !== expect.hash) {
        return { verdict: 'confirmed', expected, saw: 'the page changed', settleable: false };
      }
      return {
        verdict: 'contradicted',
        expected,
        saw: 'nothing on the page changed',
        settleable: true,
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * The policy and the read
 * ------------------------------------------------------------------ */

export interface CheckPolicy {
  /**
   * How long a verdict resting only on the absence of change may wait for the
   * page to supply one. Spent on suspicious steps only.
   */
  readonly graceMs: number;
  /** The gap between grace reads. Flat, not escalating: the window is short. */
  readonly pollMs: number;
  /**
   * How many reads that THREW are attempted before the check gives up and
   * answers `unchecked`.
   *
   * Two, and the number now has a reason that is true. `Outcrawl.getAXTree`
   * answers -32000 for the first 30-130 ms after a commit with the page LIVE
   * and then succeeds — that is `settle.ts`'s finding, it is the only throw a
   * retry can beat, and `pollMs` of 150 clears the window on the second
   * attempt. A third would be paid on every failure and could beat nothing.
   *
   * This slot used to be justified by "a page that has just committed under
   * `VirtualTimePolicy::kPause` never produces a tree at all", and that was a
   * misreading of what was being measured: the freeze was not refusing the
   * tree, `PageSession.#require` was refusing the READ, on a lock the
   * navigation had released, before CDP was ever spoken to. Sixty consecutive
   * attempts would have failed just as fast, which is precisely why counting
   * them taught nobody anything until the error was recorded. See
   * {@link CheckTrace.readError} and `PageSession.snapshotAfterAction`.
   */
  readonly failedReads: number;
}

/**
 * 600 ms in four reads, and both numbers have a reason.
 *
 * 600 ms is longer than the 30-130 ms window in which `Outcrawl.getAXTree`
 * refuses to answer after a commit and longer than the 100-250 ms root-only
 * tree that `settle.ts` measured on `saucedemo.com`, so a click that started a
 * navigation has time to produce the tree that confirms it. It is short enough
 * that a run whose every step were contradicted would spend 0.6 s a step
 * against a model call of over a second — the check can never become the
 * dominant cost of a step even in its worst case, which is the property that
 * makes it safe to leave on.
 */
export const DEFAULT_CHECK_POLICY: CheckPolicy = { graceMs: 600, pollMs: 150, failedReads: 2 };

/**
 * Reads the page and returns the verdict, waiting only where waiting can
 * change the answer.
 *
 * A read that THROWS is counted, RECORDED, and retried within the grace rather
 * than propagated: `Outcrawl.getAXTree` answers -32000 for the first 30-130 ms
 * after a commit, which is exactly the state a click that navigated leaves
 * behind, so propagating it would fail the step for the very thing being
 * checked. A check that never got a tree returns `unchecked` with the attempt
 * count AND the error as its evidence — it never contradicts an action on the
 * strength of a page it could not read, and it never again swallows the reason
 * it could not read it.
 *
 * `held`, when the host has it, is asked ONLY for a fill or select whose
 * field reads as {@link CONCEALED_FIELD_VALUE}: whether that field holds what
 * the action wrote, compared by the host on its unconcealed read (see
 * {@link heldPrivately}). A host that throws there is answered as one that
 * could not compare, and the step is told exactly that.
 */
export async function checkAction(
  expect: Expectation,
  read: () => AxTree | Promise<AxTree>,
  clock: Clock,
  policy: CheckPolicy = DEFAULT_CHECK_POLICY,
  held?: (ref: NodeRef, written: string) => Promise<boolean | undefined>,
): Promise<CheckTrace> {
  const started = clock.now();
  let reads = 0;
  let failed = 0;
  let last: CheckOutcome | undefined;
  /**
   * The last read failure, and the reason this function has a variable for it
   * at all: `catch {}` here is what made every defect in this path invisible.
   * Nothing is decided from it — the verdict logic is unchanged — it is carried
   * out to the trace so a human reading a replay is told what the browser said.
   */
  let thrown: string | undefined;

  // READ FIRST, THEN WAIT. The overwhelmingly common case is a confirmed
  // outcome on the first read, and sleeping before looking would charge every
  // step of every run a poll interval for nothing.
  for (;;) {
    let tree: AxTree | undefined;
    try {
      tree = await read();
    } catch (error) {
      // `${name}: ${message}`, and deliberately NOT `loop.ts`'s `errorMessage`,
      // which keeps only `.message`: the CLASS is the discriminator here — see
      // {@link CheckTrace.readError}. One level of `cause` is appended because
      // the tabbed binding wraps a refusal whose inner error names the tab.
      const cause = error instanceof Error ? error.cause : undefined;
      thrown =
        error instanceof Error
          ? `${error.name}: ${error.message}${cause instanceof Error ? ` <- ${cause.name}: ${cause.message}` : ''}`
          : String(error);
      failed += 1;
      if (reads === 0 && failed >= policy.failedReads) {
        // Nothing has answered and the freeze is why. Say so cheaply rather
        // than spending the grace discovering it again.
        break;
      }
    }
    if (tree !== undefined) {
      reads += 1;
      const concealed = held === undefined ? undefined : concealedTarget(expect, tree);
      const answer = concealed === undefined ? undefined : await held?.(concealed.ref, concealed.written).catch(() => undefined);
      last = checkOutcome(expect, tree, answer);
      if (last.verdict !== 'contradicted' || !last.settleable) {
        break;
      }
    }
    const remaining = policy.graceMs - (clock.now() - started);
    if (remaining <= 0) {
      break;
    }
    await clock.sleep(Math.min(policy.pollMs, remaining));
  }

  const elapsedMs = Math.round(clock.now() - started);
  const failure = thrown === undefined ? {} : { readError: thrown };
  if (last === undefined) {
    return {
      verdict: 'unchecked',
      expected: describeExpectation(expect),
      saw:
        thrown === undefined
          ? `the page could not be read back at all (${String(failed)} attempt(s))`
          : `the page could not be read back at all (${String(failed)} attempt(s)): ${thrown}`,
      reads,
      elapsedMs,
      ...failure,
    };
  }
  return {
    verdict: last.verdict,
    expected: last.expected,
    saw: last.saw,
    reads,
    elapsedMs,
    ...failure,
  };
}

/**
 * A form the browser would not send, as the host read it after a click or an
 * Enter that could have submitted it: each control that fails the browser's
 * own constraint validation, by its label and the browser's own
 * `validationMessage`, in form order. `focused` is whether the first of them
 * holds focus, which is where the browser puts it when it refuses a submit.
 */
export interface RefusedSubmit {
  readonly fields: readonly { readonly label: string; readonly message: string }[];
  readonly focused: boolean;
}

/** The longest validation message quoted; a page's custom message can be a paragraph. */
const MAX_VALIDATION_MESSAGE_CHARS = 160;

/**
 * The check on a click or Enter that tried to send a form the browser refused.
 *
 * A refused submit changes nothing a tree shows: the browser's bubble is not
 * in the page, so the model was told "nothing on the page changed", or `ok`
 * when something else moved, and nothing said why. MEASURED 2026-10-13 on
 * stock Chromium (form-fill-a3, httpbin's pizza form): a time field left
 * incomplete blocked the submit, the model clicked "Submit order" five times
 * and the run ended on the repeat.
 *
 * A contradiction keeps what it saw and adds the reason. A confirmed check is
 * turned into a contradiction only when the first invalid field holds focus,
 * which is the browser's own mark of a refused submit; anything else moved by
 * the click stays the page's business.
 */
export function refusedSubmitCheck(check: CheckTrace, refused: RefusedSubmit | undefined): CheckTrace {
  if (refused === undefined || refused.fields.length === 0 || check.verdict === 'unchecked') return check;
  if (check.verdict === 'confirmed' && (!refused.focused || check.download !== undefined)) return check;
  const reasons = refused.fields
    .map(({ label, message }) => {
      const said = message.length > MAX_VALIDATION_MESSAGE_CHARS ? `${message.slice(0, MAX_VALIDATION_MESSAGE_CHARS)}…` : message;
      return label === '' ? said : `${JSON.stringify(label)}: ${said}`;
    })
    .join('; ');
  const refusal = `the browser did not send the form, because a field is invalid: ${reasons}`;
  return {
    ...check,
    verdict: 'contradicted',
    saw: check.verdict === 'contradicted' ? `${check.saw}; ${refusal}` : refusal,
  };
}

/**
 * The durable record of a contradiction, in the model's own vocabulary.
 *
 * Written into `ruledOut` — which is permanent, exempt from compaction, and
 * printed under "Already ruled out. Do not try these again:" on every later
 * prompt — because a contradiction that only reached the step trace would be
 * evidence for us and no help to the run. This sentence is the whole of what
 * verification hands to rectification.
 */
export function contradictionNote(
  action: Action,
  check: CheckTrace,
  described?: string,
): string {
  // `described` is the step trace's own `ObservedAction.description`, which
  // names the node — "click the \"Continue\" button" rather than a reference
  // the next page will have reminted. Absent for an action that named no node.
  // A navigate still on the page it left never committed: a slow load, which
  // says nothing about the URL. One exact retry is the right next step; a
  // second identical failure is a dead URL (sealed heldout4 mode, 2026-10-03:
  // told to do something else, the run dropped a URL qualifier and answered
  // from a different version of the page).
  if (action.type === 'navigate' && check.saw.startsWith('the browser is still on')) {
    return `${described ?? describeAction(action)} did not commit: ${check.saw} (expected ${check.expected}). One exact retry of the same URL is reasonable; if it fails again, do something else.`;
  }
  return `${described ?? describeAction(action)} did not take effect: ${check.saw} (expected ${check.expected}). Do something else rather than repeating it.`;
}

/** The identity a repeat is judged on: the same action at the same reference. */
export function contradictionKey(action: Action): string {
  const ref = 'ref' in action && action.ref !== undefined ? formatNodeRef(action.ref) : 'page';
  return `${action.type}@${ref}`;
}
