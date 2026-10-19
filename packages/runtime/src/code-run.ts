/**
 * `code.run`: Python or bash the run writes, run on a machine of its own.
 *
 * Measured 2026-10-17 (OC-370, n=1 per task, 28 hard BU tasks, canonical
 * judge): the same brain model passed 17 of 28 in a harness that could run
 * code with plain HTTP and 8-9 of 28 with search and reads only (paired
 * p=0.021). The deciding steps were server-side: a site's own JSON API, a loop
 * over 90 pages, a word list or PDF downloaded and processed, 450 wiki
 * revisions bisected, arithmetic. A script confined to the page's origin did
 * nothing (ws/page-script, dev set 70/90 against 70/90). This is the
 * server-side kind.
 *
 * ── Where it runs ───────────────────────────────────────────────────────────
 *
 * The host's {@link CodeRunner}: in production `@outcrawl/worker`'s
 * `code-tools.ts`, over HTTP to the `outcrawl-code` Cloudflare Worker
 * (`packages/code-sandbox`), one container per run. NEVER on a fleet Mac: the
 * Macs hold customer sessions, and nothing secret is in the container (owner,
 * 2026-10-18). It has internet, so it does not see the browser's page,
 * cookies or exit; the description says so.
 *
 * ── Failure is the program's, not the tool's ────────────────────────────────
 *
 * A program that exits non-zero or is stopped at the time limit is a reply,
 * `isError: false`, stating the exit plainly. An `isError` reply is a FAILED
 * STEP (`ToolReplyError` in `./loop`), and `stepFailures` (3 on the fleet)
 * ends the run on the fourth in a row: writing code is fix-and-retry, and
 * three tracebacks in a row would end a run that is converging. The allowance
 * ({@link CODE_RUNS_PER_RUN}) bounds a run that never converges. `isError` is
 * kept for the tool itself failing: bad arguments, the allowance spent, a
 * sandbox that could not be reached or never answered.
 *
 * A sandbox that cannot be had at all ({@link CodeSandboxUnavailableError})
 * is an `isError` reply marked `unavailable`, which the loop does NOT charge
 * to `stepFailures`: an optional tool's outage must not end a run that can
 * carry on in the browser. After {@link UNAVAILABLE_IN_ROW_LIMIT} in a row the
 * port answers every later call itself, without asking the sandbox.
 *
 * Bounded per run by {@link CODE_RUNS_PER_RUN}, per call by
 * {@link CODE_RUN_TIMEOUT_MS}, and its reply by {@link CODE_RUN_REPLY_MAX_CHARS}.
 */

import type { JsonSchema } from '@outcrawl/scout-core';

import type { ExposedTool, ToolCallOutcome, ToolPort } from './loop';
import type { StepTrace } from './result';

export const CODE_RUN_TOOL = 'code.run';

/**
 * How many programs one run may run. A call that reached the sandbox counts,
 * whatever its exit. 20, not 40: MEASURED on the dev set (ab2-code-1d9b3cd40,
 * 2026-10-18, web.search broken in both arms), runs with 21-40 code.run calls
 * won 0 tasks against 2 for the control at +$4.86 (n=5 runs), and the
 * ceiling arm's tasks with 20 or more eval calls passed 2 of 7.
 */
export const CODE_RUNS_PER_RUN = 20;

/** How long one program may run before the sandbox stops it. The sandbox accepts 1-60 s. */
export const CODE_RUN_TIMEOUT_MS = 60_000;

/**
 * How long past {@link CODE_RUN_TIMEOUT_MS} the port waits for the sandbox's
 * answer before it gives up on the call: a cold container start and one retry
 * of a 503 come out of this.
 */
export const CODE_RUN_GRACE_MS = 30_000;

/**
 * The most of a program's output one reply carries, stdout and stderr
 * together. Under the brain's `BRAIN_BUDGET.tools` (13,000) with the tally and
 * the section labels, so one reply reaches the brain whole in the turn it
 * arrives.
 */
export const CODE_RUN_REPLY_MAX_CHARS = 12_000;

/**
 * The least of stderr a reply keeps when both streams are long: its END, where
 * a traceback names the error.
 */
const STDERR_MIN_CHARS = 3_000;

/** The sandbox's own limit on one program's source. */
export const CODE_MAX_CHARS = 50_000;

export type CodeLanguage = 'python' | 'bash';

/** One program, as the port hands it to the runner. */
export interface CodeRunRequest {
  readonly language: CodeLanguage;
  readonly code: string;
  readonly timeoutMs: number;
}

/** What the sandbox answered for one program (the `POST /v1/run` 200 body). */
export interface CodeRunOutput {
  /** At most 64 KiB, cut by the sandbox; {@link stdoutBytes} is the whole size. */
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed (a timeout) rather than exiting. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** The program's own wall time in the sandbox. */
  readonly ms: number;
  /** Whether this call started the run's container. */
  readonly coldStart: boolean;
}

/**
 * The host's sandbox, bound to ONE run. Resolves with what the program did,
 * whatever its exit. Throws when the program never ran or its answer never
 * came: that call is an `isError` reply and is not counted. Throws
 * {@link CodeSandboxUnavailableError} when the machine cannot be had at all
 * (unreachable, refusing the host, out of instances); any other throw is a
 * plain failed step. `signal` aborts when the port stops waiting.
 */
export interface CodeRunner {
  run(request: CodeRunRequest, signal: AbortSignal): Promise<CodeRunOutput>;
}

/** One call as the host logs it. The code itself is never in it. */
export interface CodeRunCall {
  readonly language: CodeLanguage;
  readonly codeChars: number;
  /** `ran`: the sandbox answered; `unavailable`: the runner threw; `no-answer`: the port stopped waiting. */
  readonly outcome: 'ran' | 'unavailable' | 'no-answer';
  /** Wall time of the call as the port saw it. */
  readonly ms: number;
  /** The sandbox's answer, for `ran`. */
  readonly output?: CodeRunOutput;
  /** The runner's message, for `unavailable`. */
  readonly error?: string;
  /** The reply's length, in characters, as the model receives it. */
  readonly replyChars: number;
}

const CODE_RUN_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['python', 'bash'] },
    code: { type: 'string', description: 'The whole program. Print what you need to stdout.' },
  },
  required: ['language', 'code'],
  additionalProperties: false,
};

/**
 * Rendered verbatim in the hands' tool catalogue and, whole, in the brain's
 * run header (`@outcrawl/model`'s `runHeader`): it is the brain's only
 * instruction about this tool. General on purpose: no task, site or benchmark
 * is named here.
 */
export const CODE_RUN_TOOL_DESCRIPTION =
  'Run Python 3 or bash on a private Linux machine with internet that belongs to this run. Each call is a fresh ' +
  'process; files written in /work stay while the run keeps using the machine. Use it for a site\u2019s data or API endpoints, for ' +
  'downloading and processing files (PDF, CSV, JSON, word lists), for work over many pages or records in a loop, and ' +
  'for counting, sorting, searching and arithmetic. Print what you need to stdout: up to ' +
  `${CODE_RUN_REPLY_MAX_CHARS.toLocaleString('en-US')} characters come back. Python has requests, beautifulsoup4, ` +
  'lxml and pandas; curl and pdftotext are installed. It does not see the browser\u2019s page or cookies: read pages that block ' +
  `scripts with the browser. ${String(CODE_RUN_TIMEOUT_MS / 1000)} s per call, ${String(CODE_RUNS_PER_RUN)} calls ` +
  'per run; each reply says how many are used.';

export function codeRunTools(): readonly ExposedTool[] {
  return [{ name: CODE_RUN_TOOL, description: CODE_RUN_TOOL_DESCRIPTION, inputSchema: CODE_RUN_INPUT_SCHEMA }];
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const LANGUAGES: Readonly<Record<string, CodeLanguage>> = { python: 'python', python3: 'python', bash: 'bash', sh: 'bash' };

export function parseCodeRunArgs(
  args: Readonly<Record<string, unknown>> | undefined,
): Parsed<{ readonly language: CodeLanguage; readonly code: string }> {
  const rawLanguage = args?.['language'];
  const language = typeof rawLanguage === 'string' ? LANGUAGES[rawLanguage.trim().toLowerCase()] : undefined;
  if (language === undefined) {
    return {
      ok: false,
      error: `${CODE_RUN_TOOL} needs "language": "python" or "bash"; got ${rawLanguage === undefined ? 'none' : JSON.stringify(rawLanguage)}.`,
    };
  }
  const code = args?.['code'];
  if (code === undefined || code === null || (typeof code === 'string' && code.trim() === '')) {
    return { ok: false, error: `${CODE_RUN_TOOL} needs "code": the whole program, printing what you need to stdout.` };
  }
  if (typeof code !== 'string') {
    return { ok: false, error: `${CODE_RUN_TOOL}'s "code" must be a string; got ${Array.isArray(code) ? 'array' : typeof code}.` };
  }
  if (code.length > CODE_MAX_CHARS) {
    return {
      ok: false,
      error: `${CODE_RUN_TOOL}'s "code" is ${code.length.toLocaleString('en-US')} characters; the limit is ${CODE_MAX_CHARS.toLocaleString('en-US')}.`,
    };
  }
  return { ok: true, value: { language, code } };
}

/**
 * The line a reply opens with when the program started on a fresh machine
 * after this run had already used one: the sandbox stops an instance idle for
 * 10 minutes and destroys one 60 minutes after it started, and /work goes
 * with it. Without it a run that saved rows to /work and browsed for a while
 * gets a bare FileNotFoundError.
 */
export const CODE_RUN_WIPED_LINE =
  'The machine had stopped (idle over 10 min or older than 60 min), so this program ran on a fresh one and /work started empty: files from earlier calls are gone.';

/**
 * The running count every counted reply opens with, after the
 * {@link CODE_RUN_WIPED_LINE} when there is one; see {@link codeRunsTaken}.
 * Only those two first lines are read, so a program cannot print a count.
 */
const CODE_TALLY = new RegExp(
  `^(?:${CODE_RUN_WIPED_LINE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n)?code\\.run \\((\\d+) of \\d+\\)`,
  'u',
);

/**
 * How many programs a run's recorded steps show it ran: the highest running
 * count a `code.run` step's note carries. Every counted call says its count in
 * its reply and the step keeps the reply's start as its note, so a resumed run
 * reads its allowance back from its own record.
 */
export function codeRunsTaken(steps: readonly StepTrace[]): number {
  let taken = 0;
  for (const step of steps) {
    if (step.action.type !== 'callTool' || step.action.tool !== CODE_RUN_TOOL) continue;
    const tally = CODE_TALLY.exec(step.tool?.note ?? '');
    if (tally !== null) taken = Math.max(taken, Number(tally[1]));
  }
  return taken;
}

function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

/**
 * One stream's section: its label, its whole size, and what of it is shown.
 * `from` names which end is kept when it is cut.
 */
function section(name: string, text: string, bytes: number, shown: string, from: 'start' | 'end'): string {
  // Cut here, or already cut by the sandbox (its 64 KiB cap): `bytes` is the
  // whole stream. Only measured when the characters fall short of the bytes.
  const cut = shown.length < text.length || (text.length < bytes && new TextEncoder().encode(text).byteLength < bytes);
  if (!cut) return `${name} (${text.length.toLocaleString('en-US')} characters):\n${shown}`;
  const which = from === 'start' ? 'first' : 'last';
  return (
    `${name}, ${Math.max(bytes, text.length).toLocaleString('en-US')} bytes in all; its ${which} ${shown.length.toLocaleString('en-US')} characters follow ` +
    `and the rest was cut (print less: filter, slice or count in the code):\n${shown}`
  );
}

/**
 * The reply to a program the sandbox ran: the tally, how it ended, then
 * stdout from its start and stderr from its end, within
 * {@link CODE_RUN_REPLY_MAX_CHARS} together.
 */
export function codeRunReply(tally: string, language: CodeLanguage, output: CodeRunOutput, timeoutMs: number): string {
  const ended = output.timedOut
    ? `was stopped at the ${String(Math.round(timeoutMs / 1000))} s limit; what it printed before then follows (do less per call, or save progress to /work and continue in the next)`
    : output.exitCode === 0
      ? `exited 0 after ${seconds(output.ms)} s`
      : output.exitCode === null
        ? `was killed after ${seconds(output.ms)} s with no exit code`
        : `exited with code ${String(output.exitCode)} after ${seconds(output.ms)} s`;
  const lines = [`${tally} ${language} ${ended}.`];

  const showStderr = output.stderr !== '' || output.exitCode !== 0;
  const stderrRoom = Math.max(STDERR_MIN_CHARS, CODE_RUN_REPLY_MAX_CHARS - output.stdout.length);
  const stderrShown = output.stderr.length <= stderrRoom ? output.stderr : output.stderr.slice(-stderrRoom);
  const stdoutShown = output.stdout.slice(0, CODE_RUN_REPLY_MAX_CHARS - stderrShown.length);

  if (output.stdout === '') {
    lines.push(output.exitCode === 0 && !output.timedOut ? 'It printed nothing to stdout: print the values you need.' : 'stdout: (empty)');
  } else {
    lines.push(section('stdout', output.stdout, output.stdoutBytes, stdoutShown, 'start'));
  }
  if (showStderr) {
    lines.push(output.stderr === '' ? 'stderr: (empty)' : section('stderr', output.stderr, output.stderrBytes, stderrShown, 'end'));
  }
  return lines.join('\n');
}

export interface CodeRunToolOptions {
  readonly runner: CodeRunner;
  /**
   * Programs this RUN already ran: {@link codeRunsTaken} over a resumed
   * intent's steps, so the limit holds per run and not per attempt.
   */
  readonly taken?: number;
  /** Per program, passed to the sandbox. Defaults to {@link CODE_RUN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** How long past `timeoutMs` the port waits for an answer. Defaults to {@link CODE_RUN_GRACE_MS}. */
  readonly graceMs?: number;
  /** Every call that reached the runner, for the host's log. Must not throw. */
  readonly onCall?: (call: CodeRunCall) => void;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Thrown by a {@link CodeRunner} when the code machine cannot be had at all
 * (refused credentials, the service down or out of instances, the network):
 * the program never ran, and calling again soon is unlikely to change that.
 */
export class CodeSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeSandboxUnavailableError';
  }
}

/** After this many unavailable answers in a row, the port stops asking the sandbox for the rest of the run. */
export const UNAVAILABLE_IN_ROW_LIMIT = 2;

const UNAVAILABLE_ADVICE = 'The code machine is unavailable right now: continue in the browser or with the web tools.';

const NO_ANSWER = Symbol('no answer');

/**
 * The `code.run` port for ONE run. The count lives in this closure, seeded
 * with {@link CodeRunToolOptions.taken}.
 */
export function codeRunToolPort(options: CodeRunToolOptions): ToolPort {
  const limit = CODE_RUNS_PER_RUN;
  const timeoutMs = options.timeoutMs ?? CODE_RUN_TIMEOUT_MS;
  const waitMs = timeoutMs + (options.graceMs ?? CODE_RUN_GRACE_MS);
  const tools = codeRunTools();
  let used = options.taken ?? 0;
  let unavailableInRow = 0;

  async function run(args: Readonly<Record<string, unknown>> | undefined): Promise<ToolCallOutcome> {
    const parsed = parseCodeRunArgs(args);
    if (!parsed.ok) {
      return { isError: true, text: parsed.error };
    }
    if (used >= limit) {
      return {
        isError: true,
        text:
          `${CODE_RUN_TOOL} has been used ${String(used)} of ${String(limit)} times this run and is spent. ` +
          'Work in the browser, or answer from what you have already found.',
      };
    }
    if (unavailableInRow >= UNAVAILABLE_IN_ROW_LIMIT) {
      // Not asked, not counted, not charged: see `ToolCallOutcome.unavailable`.
      return { isError: true, unavailable: true, text: `${CODE_RUN_TOOL} did not run the program. ${UNAVAILABLE_ADVICE}` };
    }
    const { language, code } = parsed.value;
    const started = Date.now();
    const abort = new AbortController();
    const deadline = Promise.withResolvers<typeof NO_ANSWER>();
    const timer = setTimeout(() => deadline.resolve(NO_ANSWER), waitMs);
    let outcome: { readonly output: CodeRunOutput } | { readonly error: unknown } | typeof NO_ANSWER;
    try {
      outcome = await Promise.race([
        options.runner.run({ language, code, timeoutMs }, abort.signal).then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        ),
        deadline.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    const log = (call: Omit<CodeRunCall, 'language' | 'codeChars' | 'ms'>): void => {
      options.onCall?.({ language, codeChars: code.length, ms, ...call });
    };

    if (outcome !== NO_ANSWER && 'error' in outcome) {
      // Not counted: the program never ran, or its answer never came back.
      const unavailable = outcome.error instanceof CodeSandboxUnavailableError;
      unavailableInRow = unavailable ? unavailableInRow + 1 : 0;
      const text = `${CODE_RUN_TOOL} could not run the program: ${errorText(outcome.error)}${unavailable ? ` ${UNAVAILABLE_ADVICE}` : ''}`;
      log({ outcome: 'unavailable', error: errorText(outcome.error), replyChars: text.length });
      return unavailable ? { isError: true, unavailable: true, text } : { isError: true, text };
    }
    unavailableInRow = 0;
    const ranBefore = used > 0;
    used += 1;
    const tally = `${CODE_RUN_TOOL} (${String(used)} of ${String(limit)})`;
    if (outcome === NO_ANSWER) {
      abort.abort();
      const text =
        `${tally} got no answer from the machine within ${String(Math.round(waitMs / 1000))} s; whether the program ` +
        'finished is not known. Files it wrote to /work may be there.';
      log({ outcome: 'no-answer', replyChars: text.length });
      return { isError: true, text, note: text };
    }
    const reply = codeRunReply(tally, language, outcome.output, timeoutMs);
    const text = outcome.output.coldStart && ranBefore ? `${CODE_RUN_WIPED_LINE}\n${reply}` : reply;
    log({ outcome: 'ran', output: outcome.output, replyChars: text.length });
    return { isError: false, text, note: text };
  }

  return {
    list: () => tools,
    async call(tool, args): Promise<ToolCallOutcome> {
      if (tool !== CODE_RUN_TOOL) {
        return { isError: true, text: `no tool is named "${tool}" here; this port serves ${CODE_RUN_TOOL}.` };
      }
      return run(args);
    },
  };
}
