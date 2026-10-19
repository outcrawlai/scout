/**
 * `page.script`: what the model gets back when it runs code on the page, and
 * the bounds on it (reply size, time, calls per run).
 */
import { describe, expect, test } from 'bun:test';

import type { PageScriptRunner, PageScriptValue } from '../src/page-script';
import {
  PAGE_SCRIPT_REPLY_MAX_CHARS,
  PAGE_SCRIPT_TOOL,
  PAGE_SCRIPTS_PER_RUN,
  PageScriptError,
  pageScriptToolPort,
  scriptsTaken,
} from '../src/page-script';
import type { StepTrace } from '../src/result';

function runner(reply: (code: string) => Promise<PageScriptValue>): PageScriptRunner & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run(code) {
      ran.push(code);
      return reply(code);
    },
  };
}

const returns = (text: string | undefined): PageScriptRunner & { ran: string[] } =>
  runner(async () => ({ text, length: text?.length ?? 0 }));

describe('page.script', () => {
  test('a returned value comes back whole, after the tally, and is kept on the step', async () => {
    const port = pageScriptToolPort({ runner: returns('{"percent":"72"}') });
    const out = await port.call(PAGE_SCRIPT_TOOL, { code: 'return {percent: el.dataset.percent}' });
    expect(out.isError).toBe(false);
    expect(out.text.startsWith(`page.script (1 of ${String(PAGE_SCRIPTS_PER_RUN)})`)).toBe(true);
    expect(out.text.endsWith('\n{"percent":"72"}')).toBe(true);
    expect(out.note).toBe(out.text);
  });

  test('a result over the cap is cut to it, and the reply says how much was cut', async () => {
    const whole = 'x'.repeat(PAGE_SCRIPT_REPLY_MAX_CHARS + 8_000);
    const out = await pageScriptToolPort({ runner: returns(whole) }).call(PAGE_SCRIPT_TOOL, { code: 'return big' });
    expect(out.isError).toBe(false);
    const body = out.text.slice(out.text.indexOf('\n') + 1);
    expect(body).toBe('x'.repeat(PAGE_SCRIPT_REPLY_MAX_CHARS));
    expect(out.text).toContain('20,000 characters');
    expect(out.text).toContain('other 8,000 were cut');
  });

  test('a cut the runner made in the page is reported from the whole length', async () => {
    const shown = 'y'.repeat(PAGE_SCRIPT_REPLY_MAX_CHARS);
    const port = pageScriptToolPort({ runner: runner(async () => ({ text: shown, length: 50_000 })) });
    const out = await port.call(PAGE_SCRIPT_TOOL, { code: 'return big' });
    expect(out.text).toContain('other 38,000 were cut');
  });

  test('a result exactly at the cap is not called cut', async () => {
    const out = await pageScriptToolPort({ runner: returns('z'.repeat(PAGE_SCRIPT_REPLY_MAX_CHARS)) }).call(PAGE_SCRIPT_TOOL, {
      code: 'return s',
    });
    expect(out.text).not.toContain('cut');
  });

  test('a script that returns nothing is told to return its value', async () => {
    const out = await pageScriptToolPort({ runner: returns(undefined) }).call(PAGE_SCRIPT_TOOL, { code: 'document.title' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('returned nothing');
    expect(out.text).toContain('return');
  });

  test('a script that throws is an error naming the message and the line, and is counted', async () => {
    const port = pageScriptToolPort({
      runner: runner(async () => {
        throw new PageScriptError("TypeError: Cannot read properties of null (reading 'textContent')", 3);
      }),
    });
    const out = await port.call(PAGE_SCRIPT_TOOL, { code: 'a\nb\nnull.textContent' });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(
      `page.script (1 of ${String(PAGE_SCRIPTS_PER_RUN)}) threw at line 3: TypeError: Cannot read properties of null (reading 'textContent')`,
    );
    expect(out.note).toBe(out.text);
  });

  test('a script still running at the limit is answered as timed out, and is counted', async () => {
    const port = pageScriptToolPort({ runner: runner(() => new Promise<PageScriptValue>(() => {})), timeoutMs: 30 });
    const started = Date.now();
    const out = await port.call(PAGE_SCRIPT_TOOL, { code: 'await new Promise(() => {})' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('(1 of');
    expect(out.text).toContain('timed out');
  });

  test('a runner that could not reach the page is an error, and is not counted', async () => {
    let calls = 0;
    const port = pageScriptToolPort({
      runner: runner(async () => {
        calls += 1;
        if (calls === 1) throw new Error('Page.getFrameTree returned no root frame id');
        return { text: 'ok', length: 2 };
      }),
    });
    const failed = await port.call(PAGE_SCRIPT_TOOL, { code: 'return 1' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('could not run');
    expect(failed.text).toContain('no root frame id');
    const next = await port.call(PAGE_SCRIPT_TOOL, { code: 'return 1' });
    expect(next.text.startsWith('page.script (1 of')).toBe(true);
  });

  test('the allowance is counted per call and refused at the limit without running the code', async () => {
    const run = returns('1');
    const port = pageScriptToolPort({ runner: run, taken: PAGE_SCRIPTS_PER_RUN - 1 });
    const last = await port.call(PAGE_SCRIPT_TOOL, { code: 'return 1' });
    expect(last.text.startsWith(`page.script (${String(PAGE_SCRIPTS_PER_RUN)} of ${String(PAGE_SCRIPTS_PER_RUN)})`)).toBe(true);
    const refused = await port.call(PAGE_SCRIPT_TOOL, { code: 'return 2' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('spent');
    expect(run.ran).toEqual(['return 1']);
  });

  test.each([
    ['missing', {}],
    ['empty', { code: '   ' }],
    ['null', { code: null }],
  ])('%s code is refused with what to send, and nothing runs or is counted', async (_name, args) => {
    const run = returns('1');
    const port = pageScriptToolPort({ runner: run });
    const out = await port.call(PAGE_SCRIPT_TOOL, args);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('needs "code"');
    expect(run.ran).toEqual([]);
    expect((await port.call(PAGE_SCRIPT_TOOL, { code: 'return 1' })).text.startsWith('page.script (1 of')).toBe(true);
  });

  test('non-string code is refused naming what was sent', async () => {
    const run = returns('1');
    const out = await pageScriptToolPort({ runner: run }).call(PAGE_SCRIPT_TOOL, { code: ['return 1'] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('must be a string');
    expect(out.text).toContain('array');
    expect(run.ran).toEqual([]);
  });

  test('the allowance survives a new browser: scriptsTaken reads the highest tally the steps kept', () => {
    const call = (note: string | undefined, error?: string): StepTrace =>
      ({
        index: 0,
        action: { type: 'callTool', tool: PAGE_SCRIPT_TOOL, arguments: { code: 'return 1' } },
        tool: { isError: error !== undefined, ...(note === undefined ? {} : { note }) },
        ...(error === undefined ? {} : { error }),
      }) as unknown as StepTrace;
    const steps = [
      call('page.script (1 of 40) returned 1 characters:\n1'),
      call('page.script (2 of 40) threw at line 1: ReferenceError: x is not defined', 'page.script reported an error'),
      // Refused for its arguments: never ran, carries no tally.
      call(undefined, 'page.script reported an error'),
    ];
    expect(scriptsTaken(steps)).toBe(2);
  });
});
