/**
 * THE DOCUMENT, READ.
 *
 * One evaluation in an isolated world returning the document's `outerHTML`,
 * the length of its rendered text and its `readyState`; a document too large
 * for one reply is read in slices behind a handle. Shared by everything that
 * reads a page's document, so an agent's settle and a scrape cannot disagree
 * about what an interstitial is.
 */
import type { CdpPage } from './cdp';

/** `document.readyState`'s three values. */
export type DocumentReadyState = 'loading' | 'interactive' | 'complete';

/** The document as the renderer has it, read once. */
export interface ReadDocument {
  /** The document as the renderer has it: post-script, pre-transform. */
  html: string;
  /** Rendered text length, at the instant of the read. */
  textLength: number;
  /** `document.readyState` at the instant of the read, or absent when it could not be said. */
  readyState?: DocumentReadyState | undefined;
}

/**
 * A CDP reply this binding cannot trust: a shape the shipped PDL does not
 * describe, a `Runtime.evaluate` that threw, or a score that is not a number.
 *
 * Thrown rather than coerced. Every field read here feeds a number or a string
 * that reaches the customer, so a missing one has to stop the request instead
 * of becoming `0` or `''` — both of those read as verdicts.
 */
export class CdpResultError extends Error {
  override readonly name = 'CdpResultError';
  constructor(message: string) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * readDocument
 * ------------------------------------------------------------------ */

/**
 * The settled document, in one expression.
 *
 * Descended from the smoke script's sample (smoke-e2e.ts:35-39). `readyState`
 * came back on 2026-09-24, and NOT as the stop it used to be: `parseComplete`
 * — `document.readyState !== 'loading'` — was this side deciding from that
 * string whether to keep waiting, and `Outcrawl.documentSettled` rightly
 * replaced it. What it answers now is a question the settle cannot: whether
 * the document being RETURNED had finished parsing, which is
 * `partial_document` (see {@link ReadDocument.readyState}).
 *
 * The optional chains stay, and NOT as defensive noise: this runs after the
 * document settled, but a `challenge` or `ceiling` settle is a document that
 * did NOT finish, and `document.body` on a bare interstitial or a torn-down
 * context genuinely may be absent. A `TypeError` there would turn an anomaly
 * into a failed scrape.
 *
 * `innerText` and not `textContent`, matching the floor the renderer applies
 * for `reason: 'challenge'`: `textContent` counts an inline JSON island, which
 * is how a shell with a 40 KB `__NEXT_DATA__` blob and no visible words would
 * read as a page.
 */
const DOCUMENT_EXPRESSION =
  "({ html: document.documentElement?.outerHTML ?? '', " +
  "textLength: (document.body?.innerText ?? '').length, readyState: document.readyState })";

/**
 * The most UTF-16 code units of `outerHTML` one CDP reply may carry.
 *
 * THE CEILING IS OUR OWN SOCKET'S, NOT THE BROWSER'S. Bun's WebSocket client
 * refuses any inbound message over 128 MiB and closes the whole connection
 * with `1009: Message too big` (measured 2026-09-24: 134,217,728 bytes is
 * received, 134,283,264 closes it), which kills every session on that
 * connection, not just the read. The protocol's JSON writer escapes a
 * non-ASCII code unit as `\uXXXX`, six bytes, so the worst case for N code
 * units is 6N bytes; 8 Mi units is 48 MiB at worst, under half the cap, and
 * no page anyone has measured comes near it, so the one-reply path below is
 * the path every ordinary document still takes.
 */
const DOCUMENT_CHUNK_UNITS = 8 * 1024 * 1024;

/**
 * The same three fields, bounded: a document larger than one chunk answers
 * with its length instead of itself, and {@link readDocumentPaged} takes it in
 * slices. Not a truncation — nothing is dropped, it is read in more replies.
 */
const BOUNDED_DOCUMENT_EXPRESSION =
  "(() => { const html = document.documentElement?.outerHTML ?? ''; " +
  "const textLength = (document.body?.innerText ?? '').length; " +
  'const readyState = document.readyState; ' +
  `return html.length > ${String(DOCUMENT_CHUNK_UNITS)} ` +
  '? { length: html.length, textLength, readyState } : { html, textLength, readyState }; })()';

/**
 * The isolated world the document is read in. Visible to the browser's own
 * tooling and to nothing the page can run, like `SERP_WORLD_NAME`.
 */
const READ_WORLD_NAME = 'outcrawl-read';

/**
 * THE READ RUNS IN AN ISOLATED WORLD, never the page's own. It used to be a
 * bare `Runtime.evaluate`, which is the MAIN world: a page that put a getter
 * on `outerHTML`, `innerText` or `readyState` saw every read we made, with a
 * stack no script of its own produced. `Page.createIsolatedWorld` shares the
 * DOM and nothing else — the separation `serpReaderFor` and
 * `Outcrawl.extractArticle` already have.
 *
 * A world per call, and that costs no accumulation: Blink's
 * `EnsureInspectorIsolatedWorldWithName` reuses the world for a name, and
 * `WindowProxy(world)` the context for a window, so a second call on the same
 * document answers the same context id. A new document is a new context,
 * which is why the id is never cached across reads.
 *
 * `worldName` names another world for a caller whose code must not share
 * globals with this read: `page.script` runs code the model wrote, which may
 * replace a prototype method this read relies on.
 */
export async function readWorld(page: CdpPage, worldName: string = READ_WORLD_NAME): Promise<number> {
  const tree = nested(await page.send('Page.getFrameTree'), 'frameTree');
  const frameId = (tree === undefined ? undefined : nested(tree, 'frame'))?.['id'];
  if (typeof frameId !== 'string' || frameId === '') {
    throw new CdpResultError('Page.getFrameTree returned no root frame id');
  }
  const created = await page.send('Page.createIsolatedWorld', {
    frameId,
    worldName,
    grantUniveralAccess: false,
  });
  const contextId = created['executionContextId'];
  if (typeof contextId !== 'number') {
    throw new CdpResultError('Page.createIsolatedWorld returned no executionContextId');
  }
  return contextId;
}

/** The three values `document.readyState` can hold; anything else is unknown. */
function readyStateOf(value: unknown): DocumentReadyState | undefined {
  return value === 'loading' || value === 'interactive' || value === 'complete' ? value : undefined;
}

/**
 * Exported for {@link agentDepsFor}'s `document` seam, which needs the same
 * fields from the same expression: the agent loop's settle runs
 * `interstitialOf` over them, and the `innerText` floor argument above is the
 * delicate half of that decision. A second copy of this expression on the
 * agent path is a place for the two to diverge.
 */
export async function readDocument(page: CdpPage): Promise<ReadDocument> {
  try {
    return await readDocumentIn(page, await readWorld(page));
  } catch (error) {
    // The world went with its document between `createIsolatedWorld` and the
    // read: the page navigated in that gap, which is a real event during a
    // redirecting load (airbnb's `.com` -> `.co.uk`, booking's WAF reload).
    // The main-world read this replaced read whichever document was there, so
    // one retry in a fresh world keeps that behaviour rather than failing the
    // scrape. A second loss in a row is thrown.
    const worldGone =
      error instanceof Error &&
      error.name === 'CdpError' &&
      /Cannot find context with specified id|Execution context was destroyed/.test(error.message);
    if (!worldGone) throw error;
    return await readDocumentIn(page, await readWorld(page));
  }
}

async function readDocumentIn(page: CdpPage, contextId: number): Promise<ReadDocument> {
  const value = evaluatedValue(
    await page.send('Runtime.evaluate', {
      expression: BOUNDED_DOCUMENT_EXPRESSION,
      contextId,
      returnByValue: true,
    }),
    'the document read',
  );

  const textLength = finiteNumber(value['textLength']);
  const html = value['html'];
  if (typeof html === 'string' && textLength !== null) {
    return { html, textLength, readyState: readyStateOf(value['readyState']) };
  }
  if (finiteNumber(value['length']) !== null && textLength !== null) {
    return readDocumentPaged(page, contextId);
  }
  throw new CdpResultError('document read did not match RenderedDocument');
}

/**
 * A document too large for one reply, read in {@link DOCUMENT_CHUNK_UNITS}
 * slices off ONE evaluation, so every slice is of the same string.
 *
 * The evaluation is kept by reference (`returnByValue: false`), which the
 * inspector holds in its own object table — nothing is written into the page,
 * and the handle is released on every path. The document is re-read here
 * rather than trusted from the first reply's length, because the page kept
 * running between the two and this is the read the slices come from.
 */
async function readDocumentPaged(page: CdpPage, contextId: number): Promise<ReadDocument> {
  const reply = await page.send('Runtime.evaluate', {
    expression: DOCUMENT_EXPRESSION,
    contextId,
    returnByValue: false,
  });
  const exception = nested(reply, 'exceptionDetails');
  if (exception !== undefined) {
    throw new CdpResultError(`Runtime.evaluate threw while reading: ${String(exception['text'])}`);
  }
  const objectId = nested(reply, 'result')?.['objectId'];
  if (typeof objectId !== 'string') {
    throw new CdpResultError('Runtime.evaluate returned no handle for the paged document read');
  }
  try {
    // Slice `-1` answers the two numbers instead of text; every other call
    // is one chunk of the SAME string the handle holds.
    const slice = async (start: number): Promise<Record<string, unknown>> =>
      evaluatedValue(
        await page.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function (start, size) { return start < 0 ' +
            '? { length: this.html.length, textLength: this.textLength, readyState: this.readyState } ' +
            ': { html: this.html.substring(start, start + size) }; }',
          arguments: [{ value: start }, { value: DOCUMENT_CHUNK_UNITS }],
          returnByValue: true,
        }),
        'a slice of the document read',
      );
    const head = await slice(-1);
    const length = finiteNumber(head['length']);
    const textLength = finiteNumber(head['textLength']);
    if (length === null || textLength === null) {
      throw new CdpResultError('paged document read did not report its length');
    }
    let html = '';
    for (let start = 0; start < length; start += DOCUMENT_CHUNK_UNITS) {
      const part = (await slice(start))['html'];
      if (typeof part !== 'string') {
        throw new CdpResultError('a slice of the document read was not a string');
      }
      html += part;
    }
    return { html, textLength, readyState: readyStateOf(head['readyState']) };
  } finally {
    await page.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

/** `result.value` of an evaluation, or the reason there is none. */
function evaluatedValue(reply: Record<string, unknown>, what: string): Record<string, unknown> {
  // `Runtime.evaluate` reports a thrown expression in its result, like
  // `Page.navigate` does. The only way this expression throws is a context that
  // was torn down between the settle and the read, which is a real event during
  // a crawl.
  const exception = nested(reply, 'exceptionDetails');
  if (exception !== undefined) {
    throw new CdpResultError(`Runtime.evaluate threw while reading: ${String(exception['text'])}`);
  }
  const result = nested(reply, 'result');
  const value = result === undefined ? undefined : nested(result, 'value');
  if (value === undefined) {
    throw new CdpResultError(`Runtime.evaluate returned no value for ${what}`);
  }
  return value;
}

function nested(reply: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = reply[key];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
