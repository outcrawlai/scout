/**
 * `page.script`'s runner over CDP, with no browser: a fake page whose
 * `Runtime.evaluate` runs the wrapped code here, so what the wrapper does with
 * a value, a throw and a long result is the real code's behaviour, and every
 * command it sends is recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runInContext, type Context } from 'node:vm';

import { PAGE_SCRIPT_REPLY_MAX_CHARS, PageScriptError } from '@outcrawl/runtime';

import type { CdpPage } from '../src/cdp';
import { heldFreezes } from '../src/freeze';
import { OFF_SITE_TEXT, READ_ONLY_TEXT, pageScriptExpression, pageScriptRunner } from '../src/page-script';

type Sent = { readonly method: string; readonly params: Record<string, unknown> | undefined };

function fakePage(
  evaluate?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  other?: (method: string) => Promise<Record<string, unknown>> | undefined,
): CdpPage & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    targetId: 'T',
    sessionId: 'S',
    url: () => 'https://example.test/',
    on: () => () => {},
    sendBrowser: () => Promise.reject(new Error('no browser commands here')),
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        if (evaluate !== undefined) return evaluate(params ?? {});
        // The page: the wrapped code, run for real.
        const value: unknown = await (0, eval)(String(params?.['expression']));
        return { result: { type: 'object', value } };
      }
      const answered = other?.(method);
      if (answered !== undefined) return answered;
      throw new Error(`unexpected ${method}`);
    },
  };
}

// The DOM classes the wrapper's JSON replacer names, which Bun does not have.
class FakeNode {
  constructor(readonly textContent: string) {}
}
class FakeElement extends FakeNode {
  constructor(readonly outerHTML: string) {
    super('');
  }
}
const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
  globals['Node'] = FakeNode;
  globals['Element'] = FakeElement;
});
afterAll(() => {
  delete globals['Node'];
  delete globals['Element'];
});

describe('the page.script runner', () => {
  test('runs in its own isolated world of the main frame, never the main world, awaiting the code', async () => {
    const page = fakePage();
    const value = await pageScriptRunner(page).run('const n = 6 * 7;\nreturn `n=${n}`;', 20_000);
    expect(value).toEqual({ text: 'n=42', length: 4 });
    const world = page.sent.find((entry) => entry.method === 'Page.createIsolatedWorld');
    expect(world?.params).toEqual({ frameId: 'main-frame', worldName: 'outcrawl-script', grantUniveralAccess: false });
    const evaluate = page.sent.find((entry) => entry.method === 'Runtime.evaluate');
    expect(evaluate?.params).toMatchObject({ contextId: 7, awaitPromise: true, returnByValue: true });
    expect(page.sent.map((entry) => entry.method)).not.toContain('Runtime.enable');
  });

  test('a non-string is JSON, a DOM element its HTML, and nothing returned is no text', async () => {
    const run = pageScriptRunner(fakePage());
    expect(await run.run('return { a: [1, 2], b: 3n };', 1_000)).toEqual({ text: '{"a":[1,2],"b":"3"}', length: 19 });
    globals['__el'] = new FakeElement('<b data-percent="72">x</b>');
    expect((await run.run('return [globalThis.__el];', 1_000)).text).toBe('["<b data-percent=\\"72\\">x</b>"]');
    delete globals['__el'];
    expect(await run.run('const title = 1;', 1_000)).toEqual({ text: undefined, length: 0 });
  });

  test('a long result is cut in the page at the reply cap, with its whole length', async () => {
    const value = await pageScriptRunner(fakePage()).run(`return 'x'.repeat(${String(PAGE_SCRIPT_REPLY_MAX_CHARS * 3)});`, 1_000);
    expect(value.text?.length).toBe(PAGE_SCRIPT_REPLY_MAX_CHARS);
    expect(value.length).toBe(PAGE_SCRIPT_REPLY_MAX_CHARS * 3);
  });

  test('a throw or a rejection is a PageScriptError with the message', async () => {
    const run = pageScriptRunner(fakePage());
    const thrown = await run.run("await null;\nthrow new TypeError('no such table');", 1_000).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(PageScriptError);
    expect((thrown as Error).message).toBe('TypeError: no such table');
    const rejected = await run.run("return Promise.reject('plain');", 1_000).catch((error: unknown) => error);
    expect((rejected as Error).message).toBe('plain');
  });

  test("the error's line is the model's line, from the page's stack or the compile error", async () => {
    const failure = async (running: Promise<unknown>): Promise<PageScriptError> => {
      const error: unknown = await running.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof PageScriptError)) throw new Error('expected a PageScriptError');
      return error;
    };
    // The evaluated source's own line numbers, wherever the wrapper puts the code.
    const sourceLine = (code: string, line: string): number => pageScriptExpression(code, 1_000).split('\n').indexOf(line) + 1;
    const stack = `TypeError: x is null\n    at __ocRun (<anonymous>:${String(sourceLine('a\nb\nx.y\nd', 'x.y'))}:12)\n    at <anonymous>:900:30`;
    const thrown = await failure(
      pageScriptRunner(fakePage(async () => ({ result: { value: { threw: 'TypeError: x is null', stack } } }))).run('a\nb\nx.y\nd', 1_000),
    );
    expect(thrown.line).toBe(3);

    const compile = await failure(
      pageScriptRunner(
        fakePage(async () => ({
          result: { type: 'object', subtype: 'error' },
          exceptionDetails: {
            text: 'Uncaught',
            lineNumber: sourceLine('let a = 1;\nlet b = };', 'let b = };') - 1,
            exception: { description: "SyntaxError: Unexpected token '}'\n    at x" },
          },
        })),
      ).run('let a = 1;\nlet b = };', 1_000),
    );
    expect(compile.message).toBe("SyntaxError: Unexpected token '}'");
    expect(compile.line).toBe(2);
  });

  test('a script still running past the limit is answered by the page, before the connection deadline', async () => {
    const page = fakePage();
    const started = Date.now();
    const late = await pageScriptRunner(page).run('await new Promise(() => {});', 50).catch((error: unknown) => error);
    expect(late).toBeInstanceOf(PageScriptError);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The renderer's own bound on a script that never yields.
    expect(page.sent.find((entry) => entry.method === 'Runtime.evaluate')?.params?.['timeout']).toBe(1_050);
  });

  test('a document gone before the code started is retried once in the new one; gone while it ran is an error', async () => {
    let calls = 0;
    const page = fakePage(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Cannot find context with specified id');
      return { result: { value: { text: 'ok', length: 2 } } };
    });
    expect(await pageScriptRunner(page).run('return "ok"', 1_000)).toEqual({ text: 'ok', length: 2 });
    expect(page.sent.filter((entry) => entry.method === 'Runtime.evaluate')).toHaveLength(2);

    const navigated = await pageScriptRunner(
      fakePage(async () => {
        throw new Error('Execution context was destroyed.');
      }),
    )
      .run('location.reload()', 1_000)
      .catch((error: unknown) => error);
    expect(navigated).toBeInstanceOf(PageScriptError);
    expect((navigated as Error).message).toContain('went away');
  });
});

/**
 * A window of its own for the wrapper to run in: a `node:vm` realm whose
 * global is the "window", with the DOM classes the guard replaces. Its
 * prototypes are the world's own, as an isolated world's are, so nothing the
 * guard does reaches this test's realm.
 */
interface World {
  readonly context: Context;
  readonly log: string[];
  readonly requests: { readonly url: string; readonly signal: AbortSignal | undefined }[];
  readonly timers: { readonly ms: number; readonly id: unknown }[];
  readonly cleared: unknown[];
}

function world(): World {
  const log: string[] = [];
  const requests: World['requests'] = [];
  const timers: World['timers'] = [];
  const cleared: unknown[] = [];
  const context = createContext({
    log,
    URL,
    Request,
    AbortController,
    AbortSignal,
    setInterval,
    clearInterval,
    setTimeout: (callback: () => void, ms: number) => {
      const id = setTimeout(callback, ms);
      timers.push({ ms, id });
      return id;
    },
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(id);
      clearTimeout(id);
    },
    // The network: each request answers after 10 ms, and records its signal.
    fetch: (input: unknown, init?: { signal?: AbortSignal }) => {
      requests.push({ url: String(input), signal: init?.signal });
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10));
    },
  });
  runInContext(
    `
    class EventTarget { dispatchEvent() { log.push('dispatchEvent'); return true; } }
    class Node extends EventTarget { constructor(doc) { super(); this.ownerDocument = doc; } get textContent() { return ''; } }
    class Element extends Node { get outerHTML() { return '<x></x>'; } }
    class HTMLElement extends Element { click() { log.push('click'); } focus() { log.push('focus'); } blur() { log.push('blur'); } }
    class HTMLInputElement extends HTMLElement {
      get value() { return this._value ?? ''; }
      set value(value) { this._value = String(value); log.push('value'); }
    }
    class HTMLFormElement extends HTMLElement { submit() { log.push('submit'); } requestSubmit() { log.push('requestSubmit'); } }
    class History { pushState() { log.push('pushState'); } }
    class XMLHttpRequest { open(verb, url) { log.push('xhr ' + verb + ' ' + url); } }
    class Document {}
    Object.assign(globalThis, { EventTarget, Node, Element, HTMLElement, HTMLInputElement, HTMLFormElement, History, XMLHttpRequest, Document });
    globalThis.document = new Document();
    document.baseURI = 'https://shop.test/list';
    globalThis.parsed = new Document();
    globalThis.history = new History();
    globalThis.location = { origin: 'https://shop.test' };
    globalThis.open = function open() { log.push('open'); };
    `,
    context,
  );
  return { context, log, requests, timers, cleared };
}

/** A page whose `Runtime.evaluate` runs the wrapped code in `realm`, by value as CDP returns it. */
function pageIn(realm: World): CdpPage & { sent: Sent[] } {
  return fakePage(async (params) => {
    const value: unknown = await runInContext(String(params['expression']), realm.context);
    return { result: { type: 'object', value: JSON.parse(JSON.stringify(value)) as unknown } };
  });
}

async function thrown(running: Promise<unknown>): Promise<string> {
  const error: unknown = await running.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof PageScriptError)) throw new Error(`expected a PageScriptError, got ${String(error)}`);
  return error.message;
}

describe('the script world is read-only (P1)', () => {
  test('input, submit, events and navigation on the live document throw, and the originals never run', async () => {
    const realm = world();
    const run = pageScriptRunner(pageIn(realm));
    const snippets = [
      "new HTMLInputElement(document).value = 'typed';",
      'new HTMLElement(document).click();',
      'new HTMLElement(document).focus();',
      'new HTMLElement(document).blur();',
      'new HTMLFormElement(document).submit();',
      'new HTMLFormElement(document).requestSubmit();',
      "new HTMLElement(document).dispatchEvent({ type: 'keydown' });",
      "history.pushState({}, '', '/next');",
      "open('https://shop.test/popup');",
    ];
    for (const code of snippets) {
      expect(await thrown(run.run(code, 1_000))).toBe(`Error: ${READ_ONLY_TEXT}`);
    }
    expect(realm.log).toEqual([]);
  });

  test("a detached document's nodes are written and clicked as before", async () => {
    const realm = world();
    const value = await pageScriptRunner(pageIn(realm)).run(
      "const field = new HTMLInputElement(parsed);\nfield.value = 'kept';\nnew HTMLElement(parsed).click();\nreturn field.value;",
      1_000,
    );
    expect(value.text).toBe('kept');
    expect(realm.log).toEqual(['value', 'click']);
  });

  test('installed before the first line of code, once per world, and the code cannot take it off', async () => {
    const realm = world();
    const run = pageScriptRunner(pageIn(realm));
    // Code that closes its own function early still runs after the guard.
    await run.run(
      "return 1;\n};\nglobalThis.configurableBefore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'click').configurable;\nconst __later = async () => {",
      1_000,
    );
    expect(runInContext('configurableBefore', realm.context)).toBe(false);
    const installed: unknown = runInContext("Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'click').value", realm.context);
    await run.run(
      "HTMLElement.prototype.click = function () { log.push('replaced'); };\ndelete HTMLElement.prototype.click;\nreturn 'tried';",
      1_000,
    );
    expect(await thrown(run.run('new HTMLElement(document).click();', 1_000))).toBe(`Error: ${READ_ONLY_TEXT}`);
    // Not wrapped a second time by the later calls.
    expect(runInContext("Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'click').value", realm.context)).toBe(installed);
    expect(realm.log).toEqual([]);
  });
});

describe("the script's fetch is same-origin GET only, and ends with its call (P1, P2)", () => {
  test('a same-origin GET goes out; POST, cross-origin and the world fetch past the wrapper are refused', async () => {
    const realm = world();
    const run = pageScriptRunner(pageIn(realm));
    expect((await run.run("await fetch('/api/items?page=1');\nreturn 'ok';", 1_000)).text).toBe('ok');
    expect(realm.requests.map((request) => request.url)).toEqual(['/api/items?page=1']);
    for (const code of [
      "await fetch('/api/cart', { method: 'POST', body: '{}' });",
      "await fetch('https://elsewhere.test/api');",
      "await globalThis.fetch('https://elsewhere.test/api');",
      "new XMLHttpRequest().open('POST', '/api/cart');",
      "new XMLHttpRequest().open('GET', 'https://elsewhere.test/api');",
    ]) {
      expect(await thrown(run.run(code, 1_000))).toBe(`Error: ${OFF_SITE_TEXT}`);
    }
    expect(realm.requests).toHaveLength(1);
    expect(realm.log).toEqual([]);
  });

  test('a call that settles aborts its requests, drops its timers and clears its grace timer', async () => {
    const realm = world();
    const value = await pageScriptRunner(pageIn(realm)).run(
      "fetch('/api/slow');\nsetTimeout(() => { globalThis.ticked = true; }, 5);\nreturn 'done';",
      50,
    );
    expect(value.text).toBe('done');
    expect(realm.requests[0]?.signal?.aborted).toBe(true);
    const grace = realm.timers.find((timer) => timer.ms === 1_050);
    expect(grace).toBeDefined();
    expect(realm.cleared).toContain(grace?.id);
    await Bun.sleep(30);
    expect(runInContext('globalThis.ticked', realm.context)).toBeUndefined();
  });

  test('a loop the model is told timed out stops requesting pages', async () => {
    const realm = world();
    const message = await thrown(pageScriptRunner(pageIn(realm)).run("for (let page = 1; ; page += 1) await fetch('/api/items?page=' + page);", 50));
    expect(message).toContain('still running');
    const sent = realm.requests.length;
    expect(sent).toBeGreaterThan(10);
    expect(realm.requests.every((request) => request.signal?.aborted === true)).toBe(true);
    await Bun.sleep(60);
    expect(realm.requests.length).toBe(sent);
  });
});

describe('a renderer pegged by a timed-out script (P2)', () => {
  test('is sent Runtime.terminateExecution once its freeze goes unanswered, and only then', async () => {
    const pending = Promise.withResolvers<Record<string, unknown>>();
    const page = fakePage(
      () => pending.promise,
      (method) => {
        if (method !== 'Runtime.terminateExecution') return undefined;
        pending.resolve({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: Execution terminated' } } });
        return Promise.resolve({});
      },
    );
    const running = thrown(pageScriptRunner(page).run('await null;\nfor (;;) {}', 50));
    await Bun.sleep(1_300);
    // Past the port's limit and the grace, but the renderer still answers its freeze.
    expect(page.sent.map((entry) => entry.method)).not.toContain('Runtime.terminateExecution');
    heldFreezes.set(page, { method: 'Outcrawl.lock', sinceMs: 0 });
    try {
      expect(await running).toContain('terminated');
      expect(page.sent.filter((entry) => entry.method === 'Runtime.terminateExecution')).toHaveLength(1);
    } finally {
      heldFreezes.delete(page);
    }
  });

  test('a script that answered is never terminated, and a terminate that fails never throws', async () => {
    const answered = fakePage(async () => ({ result: { value: { text: 'ok', length: 2 } } }));
    expect((await pageScriptRunner(answered).run('return "ok"', 50)).text).toBe('ok');
    heldFreezes.set(answered, { method: 'Outcrawl.lock', sinceMs: 0 });
    try {
      await Bun.sleep(1_300);
      expect(answered.sent.map((entry) => entry.method)).not.toContain('Runtime.terminateExecution');
    } finally {
      heldFreezes.delete(answered);
    }

    const pending = Promise.withResolvers<Record<string, unknown>>();
    const refusing = fakePage(
      () => pending.promise,
      (method) => (method === 'Runtime.terminateExecution' ? Promise.reject(new Error('session closed')) : undefined),
    );
    heldFreezes.set(refusing, { method: 'Outcrawl.lock', sinceMs: 0 });
    try {
      const running = thrown(pageScriptRunner(refusing).run('for (;;) {}', 50));
      await Bun.sleep(1_200);
      expect(refusing.sent.map((entry) => entry.method)).toContain('Runtime.terminateExecution');
      pending.resolve({ result: { value: { late: true } } });
      expect(await running).toContain('still running');
    } finally {
      heldFreezes.delete(refusing);
    }
  });
});
