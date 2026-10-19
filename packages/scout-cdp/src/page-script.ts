/**
 * `page.script`'s runner: the model's code, run in an ISOLATED WORLD of the
 * page's main frame (see `@outcrawl/runtime`'s `page-script.ts` for the tool).
 *
 * `Page.createIsolatedWorld` with `grantUniveralAccess: false`, the same seam
 * as {@link readWorld}: the world shares the DOM and nothing else, so the
 * page's own script never runs a hook of ours and never sees a stack we made.
 * NEVER the main world (`worker/src/render-deps.ts` `evaluateInPage` has the
 * measurement: a page that hooks its own prototypes saw every call a
 * main-world read made). Its own world name, not the read world's: the code is
 * the model's, and may replace a prototype method the host's reads rely on.
 *
 * ── Read-only, enforced in the world ────────────────────────────────────────
 *
 * Prototypes and the global's own members are separate per world, so the
 * world's copies can be replaced without the page's world seeing anything
 * ({@link GUARD_SOURCE}). Before the model's first line runs, every method
 * that would act as a person or send the run somewhere throws
 * {@link READ_ONLY_TEXT} when aimed at the LIVE document: `click`, `focus`,
 * `blur`, a form's `submit`/`requestSubmit`/`reset`, `dispatchEvent`,
 * `execCommand`, the setters of a field's value, checked state, files and
 * selection, `stepUp`/`stepDown`/`setRangeText`; and, always, `window.open`
 * and `history.pushState`/`replaceState`. A node of another document (a
 * `DOMParser` result) is written as before. Network: `fetch`,
 * `XMLHttpRequest.open`, `sendBeacon` and `WebSocket` answer only GET or HEAD
 * on the page's own origin ({@link OFF_SITE_TEXT}); an element's `src` is not
 * covered. Installed once per world (a non-configurable, non-writable
 * replacement, marked on the world's global), and again for a same-origin
 * frame's world the code reaches through `contentWindow`/`contentDocument`
 * (`frames[i]` and `window[i]` are not intercepted).
 *
 * NOT blocked: DOM mutation itself (`innerHTML`, `remove()`, attributes) and
 * `location` (unforgeable, so a world cannot replace it). The tool's
 * description forbids both; this guard turns the common mistakes into a reply
 * the model can act on, it does not contain a determined script.
 *
 * ── The time limit, in four places ──────────────────────────────────────────
 *
 * The port answers "timed out" at its limit whatever happens here. In the page
 * the wrapper races the code against a timer a little past that limit, so the
 * `Runtime.evaluate` is answered long before the connection's own 30 s command
 * deadline (a command past that deadline is counted as evidence of a hung
 * browser); and `Runtime.evaluate`'s `timeout` ends a script whose synchronous
 * part never yields. When a call settles, by any road, its AbortController
 * aborts: every `fetch` the code made through the wrapper's `fetch` is
 * cancelled and the wrapper's `setTimeout`/`setInterval` stop calling back, so
 * a loop the model was told had timed out does not keep requesting pages. A
 * loop that starves the event loop AFTER an `await` is the fourth: the
 * renderer then cannot answer the next freeze either ({@link heldFreezes}),
 * and the runner sends `Runtime.terminateExecution` to end it
 * ({@link terminateIfPegged}).
 */
import { PAGE_SCRIPT_REPLY_MAX_CHARS, PageScriptError, type PageScriptRunner, type PageScriptValue } from '@outcrawl/runtime';
import { isRecord } from '@outcrawl/scout-core';

import type { CdpPage } from './cdp';
import { readWorld } from './document';
import { heldFreezes } from './freeze';

/** The isolated world the model's code runs in. Visible to DevTools and to nothing the page runs. */
const SCRIPT_WORLD_NAME = 'outcrawl-script';

/** How long past the port's limit the page keeps a script, so the port's "timed out" is always the one the model reads. */
const IN_PAGE_GRACE_MS = 1_000;

/** How often, once a call is past the in-page grace, the runner looks for a renderer that stopped answering. */
const PEGGED_POLL_MS = 250;

/** What a refused input or navigation method throws in the script world. */
export const READ_ONLY_TEXT = 'page.script is read-only: use the click/fill actions';

/** What a refused request throws in the script world. */
export const OFF_SITE_TEXT =
  'page.script requests only GET or HEAD on this page\u2019s own origin; a cross-origin or non-GET request is for code.run or the actions';

/** What the wrapper's `fetch` answers once its call is over (answered, thrown or timed out). */
const CALL_OVER_TEXT = 'this page.script call is over';

/**
 * The world's guard, as source: `__ocGuard(w)` installs it on the window `w`
 * of this world, once (see the header). The originals live only in this
 * function's closures, which the model's code cannot reach.
 */
const GUARD_SOURCE = `const __ocGuard = (w) => {
  let doc;
  try {
    doc = w.document;
    if (typeof doc !== 'object' || doc === null || Object.prototype.hasOwnProperty.call(w, '__ocReadOnly')) return;
    Object.defineProperty(w, '__ocReadOnly', { value: true });
  } catch (error) {
    return;
  }
  const live = (target) => target === w || target === doc || (target !== null && typeof target === 'object' && target.ownerDocument === doc);
  const onLive = (target) => (live(target) ? ${JSON.stringify(READ_ONLY_TEXT)} : '');
  const always = () => ${JSON.stringify(READ_ONLY_TEXT)};
  const proto = (name) => (typeof w[name] === 'function' ? w[name].prototype : undefined);
  const method = (target, name, refuses, rejects) => {
    try {
      const d = target === undefined ? undefined : Object.getOwnPropertyDescriptor(target, name);
      if (d === undefined || typeof d.value !== 'function') return;
      const original = d.value;
      const guarded = { [name](...args) {
        const why = refuses(this, args);
        if (why !== '') {
          if (rejects) return Promise.reject(new Error(why));
          throw new Error(why);
        }
        return Reflect.apply(original, this, args);
      } }[name];
      Object.defineProperty(target, name, { value: guarded, writable: false, enumerable: d.enumerable, configurable: false });
    } catch (error) {}
  };
  const setter = (target, name) => {
    try {
      const d = target === undefined ? undefined : Object.getOwnPropertyDescriptor(target, name);
      if (d === undefined || typeof d.set !== 'function') return;
      const original = d.set;
      const set = function (value) {
        if (live(this)) throw new Error(${JSON.stringify(READ_ONLY_TEXT)});
        Reflect.apply(original, this, [value]);
      };
      Object.defineProperty(target, name, { get: d.get, set, enumerable: d.enumerable, configurable: false });
    } catch (error) {}
  };
  const reach = (target, name, toWindow) => {
    try {
      const d = target === undefined ? undefined : Object.getOwnPropertyDescriptor(target, name);
      if (d === undefined || typeof d.get !== 'function') return;
      const original = d.get;
      const get = function () {
        const value = Reflect.apply(original, this, []);
        try {
          if (value !== null && value !== undefined) __ocGuard(toWindow(value));
        } catch (error) {}
        return value;
      };
      Object.defineProperty(target, name, { get, set: d.set, enumerable: d.enumerable, configurable: false });
    } catch (error) {}
  };
  for (const name of ['click', 'focus', 'blur']) {
    method(proto('HTMLElement'), name, onLive);
    method(proto('SVGElement'), name, onLive);
  }
  for (const name of ['submit', 'requestSubmit', 'reset']) method(proto('HTMLFormElement'), name, onLive);
  method(proto('EventTarget'), 'dispatchEvent', onLive);
  method(proto('Document'), 'execCommand', onLive);
  for (const name of ['stepUp', 'stepDown', 'setRangeText']) method(proto('HTMLInputElement'), name, onLive);
  method(proto('HTMLTextAreaElement'), 'setRangeText', onLive);
  for (const name of ['value', 'checked', 'files', 'valueAsNumber', 'valueAsDate']) setter(proto('HTMLInputElement'), name);
  setter(proto('HTMLTextAreaElement'), 'value');
  for (const name of ['value', 'selectedIndex']) setter(proto('HTMLSelectElement'), name);
  setter(proto('HTMLOptionElement'), 'selected');
  for (const name of ['pushState', 'replaceState']) method(proto('History'), name, always);
  method(w, 'open', always);
  method(proto('Window'), 'open', always);
  const offSite = (url, verb) => {
    try {
      const target = new w.URL(String(url), doc.baseURI);
      const upper = String(verb).toUpperCase();
      return target.origin === w.location.origin && (upper === 'GET' || upper === 'HEAD') ? '' : ${JSON.stringify(OFF_SITE_TEXT)};
    } catch (error) {
      return ${JSON.stringify(OFF_SITE_TEXT)};
    }
  };
  const fetchRefuses = (self, [input, init]) => {
    const request = typeof w.Request === 'function' && input instanceof w.Request ? input : undefined;
    return offSite(request === undefined ? input : request.url, (init === null || init === undefined ? undefined : init.method) ?? (request === undefined ? 'GET' : request.method));
  };
  method(w, 'fetch', fetchRefuses, true);
  method(proto('Window'), 'fetch', fetchRefuses, true);
  method(proto('XMLHttpRequest'), 'open', (self, [verb, url]) => offSite(url, verb));
  method(proto('Navigator'), 'sendBeacon', () => ${JSON.stringify(OFF_SITE_TEXT)});
  try {
    if (typeof w.WebSocket === 'function') {
      Object.defineProperty(w, 'WebSocket', { value: function WebSocket() { throw new Error(${JSON.stringify(OFF_SITE_TEXT)}); }, writable: false, enumerable: false, configurable: false });
    }
  } catch (error) {}
  for (const name of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement']) {
    reach(proto(name), 'contentWindow', (value) => value);
    reach(proto(name), 'contentDocument', (value) => value.defaultView);
  }
};`;

/**
 * Everything before the model's first line: the guard, installed, and the
 * call's own `fetch`, `setTimeout` and `setInterval`, const bindings of the
 * wrapper's scope (no global is touched) that carry the call's abort signal.
 */
const PRELUDE = [
  '(async () => {',
  ...GUARD_SOURCE.split('\n'),
  '__ocGuard(globalThis);',
  'const __ocStop = new AbortController();',
  `const fetch = (input, init) => __ocStop.signal.aborted ? Promise.reject(new Error(${JSON.stringify(CALL_OVER_TEXT)})) : globalThis.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, __ocStop.signal]) : __ocStop.signal });`,
  "const setTimeout = (callback, ms, ...args) => globalThis.setTimeout((...passed) => { if (!__ocStop.signal.aborted && typeof callback === 'function') callback(...passed); }, ms, ...args);",
  "const setInterval = (callback, ms, ...args) => { const id = globalThis.setInterval((...passed) => { if (__ocStop.signal.aborted) globalThis.clearInterval(id); else if (typeof callback === 'function') callback(...passed); }, ms, ...args); return id; };",
  'const __ocRun = async () => {',
];

/** The 1-based line of the evaluated source the model's code starts on: see {@link pageScriptExpression}. */
const CODE_FIRST_LINE = PRELUDE.length + 1;

/**
 * The model's code as the body of an async function, wrapped so that every
 * outcome comes back as one small plain object by value: the text (cut at
 * {@link PAGE_SCRIPT_REPLY_MAX_CHARS} in the page, so a huge result never
 * crosses the wire) and its whole length, what it threw, or that it ran out of
 * time. A DOM node is returned as its HTML (an element) or its text, where JSON
 * would give `{}`; a BigInt as its digits. The guard runs before the code, so
 * nothing in the code (even text that closes the function early) runs first.
 */
export function pageScriptExpression(code: string, timeoutMs: number): string {
  return [
    ...PRELUDE,
    code,
    '};',
    'const __ocLate = Symbol();',
    'let __ocOut;',
    'let __ocTimer;',
    'try {',
    `  __ocOut = await Promise.race([__ocRun(), new Promise((resolve) => { __ocTimer = globalThis.setTimeout(() => resolve(__ocLate), ${String(timeoutMs + IN_PAGE_GRACE_MS)}); })]);`,
    '} catch (error) {',
    "  const named = error !== null && typeof error === 'object' && 'message' in error;",
    "  return { threw: named ? `${error.name ?? 'Error'}: ${error.message}` : String(error), stack: named && typeof error.stack === 'string' ? error.stack : '' };",
    '} finally {',
    '  globalThis.clearTimeout(__ocTimer);',
    '  __ocStop.abort();',
    '}',
    'if (__ocOut === __ocLate) return { late: true };',
    'let __ocText;',
    "if (typeof __ocOut === 'string') __ocText = __ocOut;",
    'else {',
    '  try {',
    "    __ocText = JSON.stringify(__ocOut, (key, value) => typeof value === 'bigint' ? String(value) : value instanceof Element ? value.outerHTML : value instanceof Node ? value.textContent : value);",
    '  } catch (error) {',
    '    __ocText = String(__ocOut);',
    '  }',
    '}',
    "if (typeof __ocText !== 'string') return { length: 0 };",
    `return { text: __ocText.slice(0, ${String(PAGE_SCRIPT_REPLY_MAX_CHARS)}), length: __ocText.length };`,
    '})()',
  ].join('\n');
}

/** The model's line for a line of the evaluated source, when it falls inside the code. */
function codeLine(sourceLine: number, code: string): number | undefined {
  const line = sourceLine - CODE_FIRST_LINE + 1;
  return line >= 1 && line <= code.split('\n').length ? line : undefined;
}

/** The first `<anonymous>:L:C` frame of a stack thrown in the world: the evaluated source's own frames. */
function stackLine(stack: string, code: string): number | undefined {
  const frame = /<anonymous>:(\d+):\d+/u.exec(stack);
  return frame === null ? undefined : codeLine(Number(frame[1]), code);
}

const CONTEXT_MISSING = /Cannot find context with specified id/u;
const CONTEXT_DESTROYED = /Execution context was destroyed/u;

/**
 * A RENDERER PEGGED BY THE SCRIPT, recovered. Once a call is past the port's
 * limit and the in-page grace (so the port has answered "timed out" and the
 * page's own late answer could not fire), the runner watches for the page's
 * next freeze command going unanswered ({@link heldFreezes}): the renderer is
 * then executing script and cannot stop. `Runtime.terminateExecution` ends
 * the script it is executing: on Chromium main it is one of the commands sent
 * on the renderer's IO channel and run as a V8 interrupt
 * (`content/browser/devtools/devtools_session.cc` `ShouldSendOnIO`, read
 * 2026-10-19), so it does not queue behind the busy thread. Not measured on
 * the fleet's build.
 *
 * Not sent while the renderer still answers its freeze: a frozen page also
 * holds the evaluate past the grace (its timers do not fire), and
 * `terminateExecution` with nothing running ends the NEXT script, which may
 * be the page's own. Sent once; never throws. Returns the stop for when the
 * evaluate settles.
 */
export function terminateIfPegged(page: CdpPage, timeoutMs: number): () => void {
  let timer: Timer | undefined;
  const check = (): void => {
    if (heldFreezes.has(page)) {
      timer = undefined;
      page.send('Runtime.terminateExecution', {}).catch(() => undefined);
      return;
    }
    timer = setTimeout(check, PEGGED_POLL_MS);
  };
  timer = setTimeout(check, timeoutMs + IN_PAGE_GRACE_MS);
  return () => {
    clearTimeout(timer);
    timer = undefined;
  };
}

/**
 * The runner for one page: its main frame, through {@link readWorld}'s root
 * frame. A world per call, which Blink resolves to the same context for the
 * same document, and a new one after a navigation.
 */
export function pageScriptRunner(page: CdpPage): PageScriptRunner {
  async function evaluate(code: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const params = {
      expression: pageScriptExpression(code, timeoutMs),
      returnByValue: true,
      awaitPromise: true,
      timeout: timeoutMs + IN_PAGE_GRACE_MS,
    };
    try {
      return await page.send('Runtime.evaluate', { ...params, contextId: await readWorld(page, SCRIPT_WORLD_NAME) });
    } catch (error) {
      // The document went between creating the world and the evaluate, so the
      // code never started: once more in the new document's world, as
      // `readDocument` does.
      if (!(error instanceof Error) || !CONTEXT_MISSING.test(error.message)) throw error;
      return await page.send('Runtime.evaluate', { ...params, contextId: await readWorld(page, SCRIPT_WORLD_NAME) });
    }
  }

  return {
    async run(code: string, timeoutMs: number): Promise<PageScriptValue> {
      let reply: Record<string, unknown>;
      try {
        const stop = terminateIfPegged(page, timeoutMs);
        try {
          reply = await evaluate(code, timeoutMs);
        } finally {
          stop();
        }
      } catch (error) {
        if (error instanceof Error && CONTEXT_DESTROYED.test(error.message)) {
          throw new PageScriptError("the page's document went away while the script ran (it navigated or reloaded), so nothing came back");
        }
        throw error;
      }
      const exception = reply['exceptionDetails'];
      if (isRecord(exception)) {
        // Only what escaped the wrapper: code that did not compile.
        const thrown = isRecord(exception['exception']) ? exception['exception']['description'] : undefined;
        const message = typeof thrown === 'string' ? thrown : typeof exception['text'] === 'string' ? exception['text'] : 'the script failed';
        const line = typeof exception['lineNumber'] === 'number' ? codeLine(exception['lineNumber'] + 1, code) : undefined;
        throw new PageScriptError(message.split('\n')[0] ?? message, line);
      }
      const result = reply['result'];
      const value = isRecord(result) ? result['value'] : undefined;
      if (!isRecord(value)) {
        throw new PageScriptError('the script returned no result the page could send back');
      }
      if (typeof value['threw'] === 'string') {
        throw new PageScriptError(value['threw'], stackLine(typeof value['stack'] === 'string' ? value['stack'] : '', code));
      }
      if (value['late'] === true) {
        throw new PageScriptError(`still running after ${String(timeoutMs / 1000)} s`);
      }
      const length = typeof value['length'] === 'number' ? value['length'] : 0;
      return { text: typeof value['text'] === 'string' ? value['text'] : undefined, length };
    },
  };
}
