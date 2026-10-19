/**
 * `page.script`: code the run writes and runs on the page, to READ and COMPUTE.
 *
 * scout-1's brain never sees the page: it reads an eyes brief (facts within
 * 2,100 characters, at most 10 elements), `web.read` windows of 4,000
 * characters, and acts through the hands' clicks, fills and extracts. Measured
 * 2026-10-17 (agent://PairDiff): the same brain model in a harness that can run
 * code passed 17 of 28 dev-set tasks scout-1 fails 3+ of 6 times, and in 10 of
 * those 17 the deciding step was code it wrote and ran: a value the page holds
 * but does not render (a `data-*` attribute, shadow-root text), the site's own
 * JSON endpoint fetched from the page, a count or filter over a long page.
 * This is that capability, inside the run.
 *
 * ── Where it runs ───────────────────────────────────────────────────────────
 *
 * The host's {@link PageScriptRunner}: on the fleet, a CDP isolated world in
 * the focused tab's main frame (`@outcrawl/scout-cdp`'s `page-script.ts`),
 * which shares the DOM and nothing else, so the page's own script never sees
 * a call of ours. NEVER the main world (`worker/src/render-deps.ts`
 * `evaluateInPage`: a page that hooks its own prototypes saw every call a
 * main-world read made). The loop runs it on the LIVE page, as it does
 * `page.look` (`PageSession.callTool`): under the freeze a fetch would not
 * move and a timer would not fire.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * Input. A click, a keystroke or a submit made by script is an event no person
 * made, and the hands' natural input exists so that none is ever dispatched.
 * The fleet's runner refuses the input, submit, event and navigation methods
 * and every request but a same-origin GET or HEAD in the script's world
 * (`@outcrawl/scout-cdp`'s `page-script.ts`); DOM mutation itself and
 * `location` cannot be refused there, so for those the description is the
 * boundary, as it is for `extract`.
 *
 * Secrets. The fleet withdraws the tool once the run has filled a card or a
 * private details field (`worker/src/agent-deps.ts`): a script reads a
 * field's value directly, past the concealment the accessibility path applies
 * by field identity.
 *
 * Bounded per run by {@link PAGE_SCRIPTS_PER_RUN}, per call by
 * {@link PAGE_SCRIPT_TIMEOUT_MS}, and its reply by
 * {@link PAGE_SCRIPT_REPLY_MAX_CHARS}.
 */

import type { JsonSchema } from '@outcrawl/scout-core';

import type { ExposedTool, ToolCallOutcome, ToolPort } from './loop';
import type { StepTrace } from './result';

export const PAGE_SCRIPT_TOOL = 'page.script';

/** How many scripts one run may run. A call that ran counts, whether it returned, threw or timed out. */
export const PAGE_SCRIPTS_PER_RUN = 40;

/** How long one script may take before its reply says it timed out. */
export const PAGE_SCRIPT_TIMEOUT_MS = 20_000;

/**
 * The most of a script's result one reply carries. Under the brain's
 * `BRAIN_BUDGET.tools` (13,000) with the tally and the cut note, so one reply
 * reaches the brain whole in the turn it arrives.
 */
export const PAGE_SCRIPT_REPLY_MAX_CHARS = 12_000;

/** What a script returned, as text: a string as it was, anything else as JSON. */
export interface PageScriptValue {
  /**
   * The text, or `undefined` when the script returned nothing (`undefined`,
   * or a value JSON has no text for, such as a function). A runner may cut it
   * at {@link PAGE_SCRIPT_REPLY_MAX_CHARS} before it crosses the wire.
   */
  readonly text: string | undefined;
  /** The whole text's length before any cut. */
  readonly length: number;
}

/** The script itself failed: it threw, rejected, did not compile, or its document went away under it. */
export class PageScriptError extends Error {
  override readonly name = 'PageScriptError';
  /** 1-based line of the model's code, when the error says. */
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(message);
    this.line = line;
  }
}

/**
 * The host's runner, bound to the FOCUSED tab. Runs `code` as the body of an
 * async function and resolves with its return value. Throws
 * {@link PageScriptError} for a failure of the script; anything else it throws
 * means the script never ran (no page, no frame), which is not counted.
 *
 * `timeoutMs` is the port's own limit, passed so the runner can stop a script
 * that never yields; the port times the call itself and does not wait longer.
 */
export interface PageScriptRunner {
  run(code: string, timeoutMs: number): Promise<PageScriptValue>;
}

const PAGE_SCRIPT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'The body of an async JavaScript function; "return" the result. Example: return document.querySelectorAll("tr").length',
    },
  },
  required: ['code'],
  additionalProperties: false,
};

/**
 * Rendered verbatim in the hands' tool catalogue and, whole, in the brain's
 * run header (`@outcrawl/model`'s `runHeader`): it is the brain's only
 * instruction about this tool.
 */
export const PAGE_SCRIPT_TOOL_DESCRIPTION =
  'Run JavaScript on the current page to READ and COMPUTE. "code" is the body of an async function run in the ' +
  "tab's page (the DOM is shared; the page's own JavaScript variables are not visible); its return value comes back " +
  `as text (non-strings as JSON), up to ${PAGE_SCRIPT_REPLY_MAX_CHARS.toLocaleString('en-US')} characters. Use it for values the page holds but does not show ` +
  '(attributes, hidden or shadow-root text, embedded JSON, whole tables and long lists), for the site\u2019s own data ' +
  'endpoints with fetch (same-origin GET only; it carries the page\u2019s cookies), and for counting, filtering, ' +
  'sorting and arithmetic over what it reads. It is read-only: never click, type, submit, navigate or change the ' +
  `page; do those with the normal actions. ${String(PAGE_SCRIPT_TIMEOUT_MS / 1000)} s per call, ` +
  `${String(PAGE_SCRIPTS_PER_RUN)} calls per run; each reply says how many are used.`;

export function pageScriptTools(): readonly ExposedTool[] {
  return [{ name: PAGE_SCRIPT_TOOL, description: PAGE_SCRIPT_TOOL_DESCRIPTION, inputSchema: PAGE_SCRIPT_INPUT_SCHEMA }];
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function parsePageScriptArgs(args: Readonly<Record<string, unknown>> | undefined): Parsed<string> {
  const code = args?.['code'];
  if (code === undefined || code === null || (typeof code === 'string' && code.trim() === '')) {
    return {
      ok: false,
      error: `${PAGE_SCRIPT_TOOL} needs "code": the body of an async JavaScript function whose "return" value is the result.`,
    };
  }
  if (typeof code !== 'string') {
    return { ok: false, error: `${PAGE_SCRIPT_TOOL}'s "code" must be a string of JavaScript; got ${Array.isArray(code) ? 'array' : typeof code}.` };
  }
  return { ok: true, value: code };
}

/** The running count every counted reply opens with; see {@link scriptsTaken}. */
const SCRIPT_TALLY = /^page\.script \((\d+) of \d+\)/u;

/**
 * How many scripts a run's recorded steps show it ran: the highest running
 * count a `page.script` step's note carries. Every call that ran says its
 * count in its reply and the step keeps the reply as its note, failed or
 * not, so the step history is the whole record of the allowance and a
 * re-acquired or resumed browser reads it back unchanged.
 */
export function scriptsTaken(steps: readonly StepTrace[]): number {
  let taken = 0;
  for (const step of steps) {
    if (step.action.type !== 'callTool' || step.action.tool !== PAGE_SCRIPT_TOOL) continue;
    const tally = SCRIPT_TALLY.exec(step.tool?.note ?? '');
    if (tally !== null) taken = Math.max(taken, Number(tally[1]));
  }
  return taken;
}

export interface PageScriptToolOptions {
  readonly runner: PageScriptRunner;
  /**
   * Scripts this RUN already ran on earlier browsers: {@link scriptsTaken}
   * over the resumed intent's steps. The port is rebuilt with every browser
   * the run acquires, so without this seed the limit would hold per browser.
   */
  readonly taken?: number;
  /** Defaults to {@link PAGE_SCRIPT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

const TIMED_OUT = Symbol('timed out');

/**
 * The `page.script` port for ONE run on one browser. The count lives in this
 * closure, seeded with {@link PageScriptToolOptions.taken}.
 */
export function pageScriptToolPort(options: PageScriptToolOptions): ToolPort {
  const limit = PAGE_SCRIPTS_PER_RUN;
  const timeoutMs = options.timeoutMs ?? PAGE_SCRIPT_TIMEOUT_MS;
  const tools = pageScriptTools();
  let used = options.taken ?? 0;

  async function script(args: Readonly<Record<string, unknown>> | undefined): Promise<ToolCallOutcome> {
    const parsed = parsePageScriptArgs(args);
    if (!parsed.ok) {
      return { isError: true, text: parsed.error };
    }
    if (used >= limit) {
      return {
        isError: true,
        text:
          `${PAGE_SCRIPT_TOOL} has been used ${String(used)} of ${String(limit)} times this run and is spent. ` +
          'Act through the normal actions, or answer from what you have already read.',
      };
    }

    const deadline = Promise.withResolvers<typeof TIMED_OUT>();
    const timer = setTimeout(() => deadline.resolve(TIMED_OUT), timeoutMs);
    let outcome: { readonly value: PageScriptValue } | { readonly error: unknown } | typeof TIMED_OUT;
    try {
      outcome = await Promise.race([
        options.runner.run(parsed.value, timeoutMs).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        deadline.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (outcome !== TIMED_OUT && 'error' in outcome && !(outcome.error instanceof PageScriptError)) {
      // Not counted: the script never ran.
      return { isError: true, text: `${PAGE_SCRIPT_TOOL} could not run on this page: ${errorText(outcome.error)}` };
    }
    used += 1;
    const tally = `${PAGE_SCRIPT_TOOL} (${String(used)} of ${String(limit)})`;
    if (outcome === TIMED_OUT) {
      const text =
        `${tally} timed out after ${String(timeoutMs / 1000)} s and returned nothing. Return sooner: ` +
        'fewer requests or pages per call, and no waiting for something that may never happen.';
      return { isError: true, text, note: text };
    }
    if ('error' in outcome) {
      const error = outcome.error as PageScriptError;
      const text = `${tally} threw${error.line === undefined ? '' : ` at line ${String(error.line)}`}: ${errorText(error)}`;
      return { isError: true, text, note: text };
    }
    const { value } = outcome;
    if (value.text === undefined) {
      const text = `${tally} returned nothing: end the code with "return <value>".`;
      return { isError: false, text, note: text };
    }
    const shown = value.text.slice(0, PAGE_SCRIPT_REPLY_MAX_CHARS);
    const cut = Math.max(value.length, value.text.length) - shown.length;
    const size = value.length.toLocaleString('en-US');
    const text =
      cut > 0
        ? `${tally} returned ${size} characters; the first ${shown.length.toLocaleString('en-US')} follow and the other ` +
          `${cut.toLocaleString('en-US')} were cut (return less: filter, slice or count in the code):\n${shown}`
        : `${tally} returned ${size} characters:\n${shown}`;
    return { isError: false, text, note: text };
  }

  return {
    list: () => tools,
    async call(tool, args): Promise<ToolCallOutcome> {
      if (tool !== PAGE_SCRIPT_TOOL) {
        return { isError: true, text: `no tool is named "${tool}" here; this port serves ${PAGE_SCRIPT_TOOL}.` };
      }
      return script(args);
    },
  };
}
