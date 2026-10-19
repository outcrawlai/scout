/**
 * `code.run`: what the model gets back when it runs a program on the run's
 * machine, and the bounds on it (reply size, time, calls per run).
 */
import { describe, expect, test } from 'bun:test';

import {
  CODE_RUN_REPLY_MAX_CHARS,
  CODE_RUN_TOOL,
  CODE_RUN_WIPED_LINE,
  CODE_RUNS_PER_RUN,
  CodeSandboxUnavailableError,
  codeRunsTaken,
  codeRunToolPort,
  type CodeRunCall,
  type CodeRunner,
  type CodeRunOutput,
  type CodeRunRequest,
} from '../src/code-run';
import type { StepTrace } from '../src/result';

function output(over: Partial<CodeRunOutput> = {}): CodeRunOutput {
  const stdout = over.stdout ?? '';
  const stderr = over.stderr ?? '';
  return {
    stdout,
    stderr,
    exitCode: 0,
    timedOut: false,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    ms: 420,
    coldStart: false,
    ...over,
  };
}

function runner(reply: (request: CodeRunRequest, signal: AbortSignal) => Promise<CodeRunOutput>): CodeRunner & { ran: CodeRunRequest[] } {
  const ran: CodeRunRequest[] = [];
  return {
    ran,
    run(request, signal) {
      ran.push(request);
      return reply(request, signal);
    },
  };
}

const answers = (over: Partial<CodeRunOutput>): CodeRunner & { ran: CodeRunRequest[] } => runner(async () => output(over));
const PY = { language: 'python', code: 'print(1)' };

describe('code.run', () => {
  test('stdout comes back whole after the tally and the exit, and is kept on the step', async () => {
    const out = await codeRunToolPort({ runner: answers({ stdout: '72\n' }) }).call(CODE_RUN_TOOL, PY);
    expect(out.isError).toBe(false);
    expect(out.text.startsWith(`code.run (1 of ${String(CODE_RUNS_PER_RUN)}) python exited 0 after 0.4 s.`)).toBe(true);
    expect(out.text.endsWith('stdout (3 characters):\n72\n')).toBe(true);
    expect(out.text).not.toContain('stderr');
    expect(out.note).toBe(out.text);
  });

  test('a program that prints nothing is told to print what it needs', async () => {
    const out = await codeRunToolPort({ runner: answers({}) }).call(CODE_RUN_TOOL, PY);
    expect(out.isError).toBe(false);
    expect(out.text).toContain('printed nothing to stdout');
  });

  test('stdout over the cap is cut from its start and the reply says it was cut', async () => {
    const whole = `${'x'.repeat(CODE_RUN_REPLY_MAX_CHARS - 3)}END${'y'.repeat(8_000)}`;
    const out = await codeRunToolPort({ runner: answers({ stdout: whole }) }).call(CODE_RUN_TOOL, PY);
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`20,000 bytes in all; its first 12,000 characters follow and the rest was cut`);
    expect(out.text.endsWith('END')).toBe(true);
    expect(out.text.length).toBeLessThan(CODE_RUN_REPLY_MAX_CHARS + 400);
  });

  test("output the sandbox already cut is reported as cut, from the sandbox's whole size", async () => {
    const shown = 'z'.repeat(5_000);
    const out = await codeRunToolPort({ runner: answers({ stdout: shown, stdoutBytes: 200_000 }) }).call(CODE_RUN_TOOL, PY);
    expect(out.text).toContain('200,000 bytes in all; its first 5,000 characters follow and the rest was cut');
  });

  test('non-ASCII output exactly at its byte size is not called cut', async () => {
    const text = 'é'.repeat(100);
    const out = await codeRunToolPort({ runner: answers({ stdout: text, stdoutBytes: 200 }) }).call(CODE_RUN_TOOL, PY);
    expect(out.text).toContain('stdout (100 characters):');
    expect(out.text).not.toContain('cut');
  });

  test('a non-zero exit is reported plainly with stderr, as a reply and not a failed step', async () => {
    const stderr = 'Traceback (most recent call last):\n  File "<stdin>", line 3\nNameError: name \'x\' is not defined\n';
    const out = await codeRunToolPort({ runner: answers({ exitCode: 1, stderr, stdout: 'partial\n' }) }).call(CODE_RUN_TOOL, PY);
    expect(out.isError).toBe(false);
    expect(out.text).toContain('python exited with code 1 after 0.4 s.');
    expect(out.text).toContain('stdout (8 characters):\npartial\n');
    expect(out.text.endsWith(`stderr (${String(stderr.length)} characters):\n${stderr}`)).toBe(true);
  });

  test('a non-zero exit with nothing on stderr still names stderr as empty', async () => {
    const out = await codeRunToolPort({ runner: answers({ exitCode: 2 }) }).call(CODE_RUN_TOOL, { language: 'bash', code: 'exit 2' });
    expect(out.text).toContain('bash exited with code 2');
    expect(out.text).toContain('stdout: (empty)');
    expect(out.text).toContain('stderr: (empty)');
  });

  test('when both streams are long, stderr keeps its END and the two fit the cap together', async () => {
    const stdout = 'o'.repeat(30_000);
    const stderr = `${'e'.repeat(10_000)}FINAL ERROR`;
    const out = await codeRunToolPort({ runner: answers({ exitCode: 1, stdout, stderr }) }).call(CODE_RUN_TOOL, PY);
    expect(out.text).toContain('stdout, 30,000 bytes in all; its first 9,000 characters follow');
    expect(out.text).toContain('stderr, 10,011 bytes in all; its last 3,000 characters follow');
    expect(out.text.endsWith('FINAL ERROR')).toBe(true);
    expect(out.text.length).toBeLessThan(CODE_RUN_REPLY_MAX_CHARS + 600);
  });

  test('a program stopped at the time limit says so and shows what it printed, and is counted', async () => {
    const out = await codeRunToolPort({ runner: answers({ timedOut: true, exitCode: null, stdout: 'page 1\npage 2\n', ms: 60_000 }) }).call(
      CODE_RUN_TOOL,
      PY,
    );
    expect(out.isError).toBe(false);
    expect(out.text.startsWith('code.run (1 of')).toBe(true);
    expect(out.text).toContain('was stopped at the 60 s limit');
    expect(out.text).toContain('page 2');
  });

  test('the sandbox gets the language, the code and the per-call limit', async () => {
    const run = answers({ stdout: 'ok' });
    await codeRunToolPort({ runner: run, timeoutMs: 15_000 }).call(CODE_RUN_TOOL, { language: 'Python3', code: 'print("ok")' });
    expect(run.ran).toEqual([{ language: 'python', code: 'print("ok")', timeoutMs: 15_000 }]);
  });

  test('an answer that never comes is given up on, aborted, counted, and an error', async () => {
    let aborted = false;
    const port = codeRunToolPort({
      runner: runner(
        (_request, signal) =>
          new Promise<CodeRunOutput>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      ),
      timeoutMs: 20,
      graceMs: 20,
    });
    const started = Date.now();
    const out = await port.call(CODE_RUN_TOOL, PY);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.isError).toBe(true);
    expect(out.text.startsWith('code.run (1 of')).toBe(true);
    expect(out.text).toContain('no answer');
    expect(aborted).toBe(true);
  });

  test('a sandbox that could not run the program is an error naming why, and is not counted', async () => {
    let calls = 0;
    const logged: CodeRunCall[] = [];
    const port = codeRunToolPort({
      runner: runner(async () => {
        calls += 1;
        if (calls === 1) throw new Error('code sandbox unavailable (503): container failed to start');
        return output({ stdout: 'ok' });
      }),
      onCall: (call) => logged.push(call),
    });
    const failed = await port.call(CODE_RUN_TOOL, PY);
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe(`code.run could not run the program: code sandbox unavailable (503): container failed to start`);
    const next = await port.call(CODE_RUN_TOOL, PY);
    expect(next.text.startsWith('code.run (1 of')).toBe(true);
    expect(logged.map((call) => call.outcome)).toEqual(['unavailable', 'ran']);
    expect(logged[1]?.output?.stdout).toBe('ok');
    expect(logged[1]?.replyChars).toBe(next.text.length);
  });

  test('the machine unavailable: the reply says to carry on without it, and after two in a row it is not asked again', async () => {
    let calls = 0;
    const answersOf = ['down', 'ok', 'down', 'down'];
    const port = codeRunToolPort({
      runner: runner(async () => {
        const answer = answersOf[calls] ?? 'ok';
        calls += 1;
        if (answer === 'down') throw new CodeSandboxUnavailableError('the code sandbox refused this host (401): unauthorized');
        return output({ stdout: 'ok' });
      }),
    });
    const advice = 'The code machine is unavailable right now: continue in the browser or with the web tools.';
    const first = await port.call(CODE_RUN_TOOL, PY);
    expect(first).toEqual({
      isError: true,
      unavailable: true,
      text: `code.run could not run the program: the code sandbox refused this host (401): unauthorized ${advice}`,
    });
    // A program that ran in between starts the count again.
    expect((await port.call(CODE_RUN_TOOL, PY)).text.startsWith('code.run (1 of')).toBe(true);
    await port.call(CODE_RUN_TOOL, PY);
    await port.call(CODE_RUN_TOOL, PY);
    const after = await port.call(CODE_RUN_TOOL, PY);
    expect(after).toEqual({ isError: true, unavailable: true, text: `code.run did not run the program. ${advice}` });
    expect(calls).toBe(4);
  });

  test('any other failure to run is a plain error, charged like any failed step', async () => {
    const port = codeRunToolPort({ runner: runner(() => Promise.reject(new Error('the code sandbox answered HTTP 502: the machine stopped mid-run'))) });
    const out = await port.call(CODE_RUN_TOOL, PY);
    expect(out.isError).toBe(true);
    expect(out.unavailable).toBeUndefined();
  });

  test('a fresh machine after the run already used one opens the reply with /work wiped, and the tally still reads back', async () => {
    const colds = [true, false, true];
    let call = 0;
    const port = codeRunToolPort({ runner: runner(async () => output({ stdout: 'x', coldStart: colds[call++] ?? false })) });
    const first = await port.call(CODE_RUN_TOOL, PY);
    const second = await port.call(CODE_RUN_TOOL, PY);
    const third = await port.call(CODE_RUN_TOOL, PY);
    expect(first.text.startsWith('code.run (1 of')).toBe(true);
    expect(second.text.startsWith('code.run (2 of')).toBe(true);
    expect(third.text.startsWith(`${CODE_RUN_WIPED_LINE}\ncode.run (3 of 20) python exited 0`)).toBe(true);
    // A resumed attempt's first program on a fresh machine: the run had used one.
    const resumed = codeRunToolPort({ runner: answers({ coldStart: true }), taken: 5 });
    expect((await resumed.call(CODE_RUN_TOOL, PY)).text.startsWith(`${CODE_RUN_WIPED_LINE}\ncode.run (6 of`)).toBe(true);
    const step = {
      index: 0,
      action: { type: 'callTool', tool: CODE_RUN_TOOL, arguments: PY },
      tool: { isError: false, note: third.note },
    } as unknown as StepTrace;
    expect(codeRunsTaken([step])).toBe(3);
  });

  test('the allowance is counted per call and refused at the limit without running anything', async () => {
    const run = answers({ stdout: '1' });
    const port = codeRunToolPort({ runner: run, taken: CODE_RUNS_PER_RUN - 1 });
    const last = await port.call(CODE_RUN_TOOL, PY);
    expect(last.text.startsWith(`code.run (${String(CODE_RUNS_PER_RUN)} of ${String(CODE_RUNS_PER_RUN)})`)).toBe(true);
    const refused = await port.call(CODE_RUN_TOOL, { language: 'bash', code: 'echo 2' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('spent');
    expect(run.ran.map((request) => request.code)).toEqual(['print(1)']);
  });

  test.each([
    ['no language', { code: 'print(1)' }, 'needs "language"'],
    ['an unknown language', { language: 'ruby', code: 'puts 1' }, 'needs "language"'],
    ['no code', { language: 'python' }, 'needs "code"'],
    ['blank code', { language: 'python', code: '  \n' }, 'needs "code"'],
    ['non-string code', { language: 'python', code: ['print(1)'] }, 'must be a string; got array'],
    ['code over the limit', { language: 'python', code: 'x'.repeat(50_001) }, 'the limit is 50,000'],
  ])('%s is refused with what to send, and nothing runs or is counted', async (_name, args, says) => {
    const run = answers({ stdout: '1' });
    const port = codeRunToolPort({ runner: run });
    const out = await port.call(CODE_RUN_TOOL, args);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(says);
    expect(run.ran).toEqual([]);
    expect((await port.call(CODE_RUN_TOOL, PY)).text.startsWith('code.run (1 of')).toBe(true);
  });

  test('another tool name is refused by name', async () => {
    const out = await codeRunToolPort({ runner: answers({}) }).call('code.exec', PY);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('code.run');
  });

  test('a resumed run reads its allowance back: codeRunsTaken takes the highest tally the steps kept', () => {
    const call = (note: string | undefined): StepTrace =>
      ({
        index: 0,
        action: { type: 'callTool', tool: CODE_RUN_TOOL, arguments: PY },
        tool: { isError: note === undefined, ...(note === undefined ? {} : { note }) },
      }) as unknown as StepTrace;
    const steps = [
      call('code.run (1 of 20) python exited 0 after 0.4 s.\nstdout (2 characters):\n1\n'),
      call('code.run (2 of 20) python exited with code 1 after 0.1 s.'),
      // Refused for its arguments: never ran, carries no tally.
      call(undefined),
      // A tally a program printed is not the reply's.
      call('code.run (2 of 20) python exited 0 after 0.1 s.\nstdout (20 characters):\ncode.run (19 of 20)\n'),
    ];
    expect(codeRunsTaken(steps)).toBe(2);
  });
});
