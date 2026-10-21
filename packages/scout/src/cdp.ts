/**
 * A CDP client over one WebSocket: commands with deadlines, flat sessions,
 * and events routed by session. It is the whole of what `@outcrawl/scout-cdp`
 * needs from a connection (see its `CdpPage`), and it uses the runtime's own
 * global `WebSocket`, so Scout carries no socket dependency.
 *
 * Errors are told apart by `name`, which is how the binding and the agent loop
 * read them: `CdpError` (the browser refused), `CdpTimeoutError` (it did not
 * answer in time, carrying `method`), `CdpClosedError` (the socket went) and
 * `CdpTargetGoneError` (the page a command was sent to went away first).
 */
import { readWorld, type CdpPage } from '@outcrawl/scout-cdp';
import { isRecord } from '@outcrawl/scout-core';

type Params = Record<string, unknown>;
type Handler = (params: Params) => void;

/** The browser refused a command. */
export class CdpError extends Error {
  override readonly name = 'CdpError';
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method} failed (${String(code)}): ${message}`);
    this.method = method;
    this.code = code;
  }
}

/** A command went unanswered past its deadline. */
export class CdpTimeoutError extends Error {
  override readonly name = 'CdpTimeoutError';
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${String(timeoutMs)}ms`);
    this.method = method;
  }
}

/** The connection to the browser closed. */
export class CdpClosedError extends Error {
  override readonly name = 'CdpClosedError';

  constructor(reason: string) {
    super(`the CDP connection closed: ${reason}`);
  }
}

/** The page a command was sent to went away before it answered. */
export class CdpTargetGoneError extends Error {
  override readonly name = 'CdpTargetGoneError';
  readonly method: string;

  constructor(method: string) {
    super(`${method} was not answered: the page it was sent to went away first`);
    this.method = method;
  }
}

interface Pending {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (value: Params) => void;
  readonly reject: (error: Error) => void;
  /** Stops the deadline. */
  readonly settle: () => void;
}

export interface CdpConnectionOptions {
  /** How long the socket may take to open. Default 15 s. */
  readonly openTimeoutMs?: number;
  /** Per-command deadline. Default 30 s; `0` disables it. */
  readonly commandTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** The protocol's code for a command sent on a session the browser no longer has. */
const SESSION_NOT_FOUND = -32001;

/**
 * Commands that leave state on a SESSION rather than on the page, which a
 * session attached again does not have until they are sent again: every
 * domain's `enable` (its `disable` forgets it), and frame discovery.
 */
function sessionState(method: string): 'keep' | 'forget' | undefined {
  if (method.endsWith('.enable') || method === 'Target.setAutoAttach') return 'keep';
  return method.endsWith('.disable') ? 'forget' : undefined;
}

export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #commandTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  /** Event handlers by `${sessionId ?? ''} ${method}`. */
  readonly #handlers = new Map<string, Set<Handler>>();
  /** What each page's session does when the browser detaches it: see {@link CdpConnection.page}. */
  readonly #followers = new Map<string, (abandon: () => void) => void>();
  /** Sessions this client detached and targets it closed: their detach was asked for, so nothing follows it. */
  readonly #letGo = new Set<string>();
  #nextId = 1;
  #closed: string | undefined;

  private constructor(socket: WebSocket, commandTimeoutMs: number) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener('message', (event) => {
      this.#receive(event.data);
    });
    socket.addEventListener('close', (event) => {
      this.#fail(`close ${String(event.code)}${event.reason === '' ? '' : ` ${event.reason}`}`);
    });
    socket.addEventListener('error', () => {
      this.#fail('socket error');
    });
  }

  /** Opens a connection to a browser's `webSocketDebuggerUrl`. */
  static async open(endpoint: string, options: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const socket = new WebSocket(endpoint);
    const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`no CDP connection to ${redact(endpoint)} within ${String(openTimeoutMs)}ms`));
    }, openTimeoutMs);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (): void => {
      cleanup();
      reject(new Error(`could not connect to the CDP endpoint ${redact(endpoint)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFail);
      socket.removeEventListener('close', onFail);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onFail);
    socket.addEventListener('close', onFail);
    await promise;
    return new CdpConnection(socket, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  }

  /** Whether the socket has closed. */
  get closed(): boolean {
    return this.#closed !== undefined;
  }

  send(method: string, params?: Params, sessionId?: string): Promise<Params> {
    if (this.#closed !== undefined) {
      return Promise.reject(new CdpClosedError(this.#closed));
    }
    const id = this.#nextId++;
    if (method === 'Target.detachFromTarget' && typeof params?.['sessionId'] === 'string') this.#letGo.add(params['sessionId']);
    if (method === 'Target.closeTarget' && typeof params?.['targetId'] === 'string') this.#letGo.add(params['targetId']);
    const { promise, resolve, reject } = Promise.withResolvers<Params>();
    const timer =
      this.#commandTimeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new CdpTimeoutError(method, this.#commandTimeoutMs));
          }, this.#commandTimeoutMs)
        : undefined;
    this.#pending.set(id, { method, sessionId, resolve, reject, settle: () => clearTimeout(timer) });
    this.#socket.send(
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }), ...(sessionId === undefined ? {} : { sessionId }) }),
    );
    return promise;
  }

  /** Subscribes to `method` on `sessionId` (absent: the browser target). Returns the unsubscribe. */
  on(method: string, handler: Handler, sessionId?: string): () => void {
    const key = `${sessionId ?? ''} ${method}`;
    let set = this.#handlers.get(key);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * A page on this connection: `targetId` with the flat session `sessionId` already attached.
   *
   * THE PAGE FOLLOWS ITS TARGET ACROSS A SESSION THE BROWSER TAKES AWAY. A
   * client the browser does not trust with local files may not be attached to
   * a frame whose URL is not a web one, and a tab showing a PDF holds such a
   * frame: the browser's PDF viewer. So the moment a tab commits a PDF, the
   * browser detaches this client's session from it, while the tab itself
   * stays, with the same target id and the PDF on screen. Measured through
   * Outcrawl's /connect 2026-10-21 (n=3 PDF navigations over 2 sessions):
   * `Target.detachedFromTarget` 13-23 ms after `Page.navigate` answered, the
   * target still listed, every later command answered "Session with given id
   * not found", and a new `Target.attachToTarget` on the same target id
   * served the frame tree and the PDF's bytes. Before this, that answer ended
   * the run as a lost browser: 4 of 6 runs that opened a PDF, 2026-10-20.
   *
   * So when the browser detaches this page's session and this client neither
   * detached it nor closed the target, the page attaches to the same target
   * again and carries on there: the same object, the same target id, a new
   * `sessionId`. Its event handlers move to the new session, the session
   * state it was given (see {@link sessionState}) is sent again, a command
   * sent meanwhile waits for the attach, and one the browser answered "not
   * found" is sent again on the new session, because the browser never ran
   * it. The load events the browser sent the old session after it detached
   * are told again from the document's own `readyState` (see `catchUp`). A
   * target that is really gone refuses the attach, and the page stays
   * detached and says so, exactly as before.
   */
  page(targetId: string, sessionId: string, url = 'about:blank'): CdpPage {
    let session = sessionId;
    let current = url;
    let following: Promise<void> | undefined;
    const subscriptions = new Set<{ readonly method: string; readonly handler: Handler; off: () => void }>();
    const state = new Map<string, Params | undefined>();

    const subscribe = (method: string, handler: Handler): (() => void) => {
      const subscription = { method, handler, off: this.on(method, handler, session) };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        subscription.off();
      };
    };
    /**
     * THE LOAD EVENTS THE OLD SESSION WAS SENT AFTER IT WENT, told again to
     * this page's handlers from the document's `readyState`, read in an
     * isolated world on the new session. The detach comes at the PDF's
     * commit, so its `DOMContentLoaded` and load went to a session nobody
     * held, and a reader waiting for them (the binding's `parsing` probe)
     * waited its whole ceiling instead: on the fleet 2026-10-21 (n=2 of 2
     * forced PDF runs), four steps and 58-64 s per PDF, two of them refused
     * "the page is still loading". A document still parsing sends its own
     * events to the new session, and nothing is told for it here. Told
     * without the browser's timestamps, which no reader of these two events uses.
     */
    const catchUp = async (on: string): Promise<void> => {
      const view: CdpPage = {
        targetId,
        sessionId: on,
        url: () => current,
        send: (method, params) => this.send(method, params, on),
        sendBrowser: (method, params) => this.send(method, params),
        on: (method, handler) => this.on(method, handler, on),
      };
      const contextId = await readWorld(view);
      const reply = await this.send('Runtime.evaluate', { expression: 'document.readyState', contextId, returnByValue: true }, on);
      const ready = isRecord(reply['result']) ? reply['result']['value'] : undefined;
      const missed: readonly [string, Params][] =
        ready === 'complete'
          ? [['Page.domContentEventFired', {}], ['Page.loadEventFired', {}], ['Page.frameStoppedLoading', { frameId: targetId }]]
          : ready === 'interactive'
            ? [['Page.domContentEventFired', {}]]
            : [];
      for (const [method, params] of missed) {
        for (const subscription of [...subscriptions]) if (subscription.method === method) subscription.handler(params);
      }
    };
    /**
     * `abandon` fails the commands still owed on the old session. Not at the
     * detach: a command that reached the browser after it is answered "not
     * found" and can be sent again, and the browser answers it before the
     * attach sent after it. What is still owed once the attach is answered was
     * taken by the old session and will never be answered.
     */
    const follow = (abandon: () => void): void => {
      const attach = async (): Promise<void> => {
        let attached: unknown;
        try {
          attached = (await this.send('Target.attachToTarget', { targetId, flatten: true }))['sessionId'];
        } catch {
          // The target is gone too: the page stays on the session it had,
          // whose every command now says so.
          return;
        } finally {
          abandon();
        }
        if (typeof attached !== 'string' || attached === '') return;
        session = attached;
        for (const subscription of subscriptions) {
          subscription.off();
          subscription.off = this.on(subscription.method, subscription.handler, attached);
        }
        this.#followers.set(attached, follow);
        for (const [method, params] of state) await this.send(method, params, attached).catch(() => undefined);
        // Only a page whose `Page` events someone enabled was hearing them.
        if (state.has('Page.enable')) await catchUp(attached).catch(() => undefined);
      };
      const attaching: Promise<void> = attach().finally(() => {
        if (following === attaching) following = undefined;
      });
      following = attaching;
    };
    this.#followers.set(sessionId, follow);

    const remember = (method: string, params: Params | undefined): void => {
      const kind = sessionState(method);
      if (kind === 'keep') state.set(method, params);
      else if (kind === 'forget') state.delete(`${method.slice(0, -'.disable'.length)}.enable`);
    };
    const send = async (method: string, params?: Params): Promise<Params> => {
      if (following !== undefined) await following;
      const sentOn = session;
      let reply: Params;
      try {
        reply = await this.send(method, params, sentOn);
      } catch (error) {
        if (!(error instanceof CdpError && error.code === SESSION_NOT_FOUND)) throw error;
        if (following !== undefined) await following;
        if (session === sentOn) throw error;
        reply = await this.send(method, params, session);
      }
      remember(method, params);
      return reply;
    };

    // The main frame's navigations keep `url()` current without asking the
    // page, which a frozen renderer could not answer.
    subscribe('Page.frameNavigated', (params) => {
      const frame = params['frame'];
      if (!isRecord(frame) || frame['parentId'] !== undefined) return;
      const next = frame['url'];
      if (typeof next === 'string' && next !== '') current = next;
    });
    return {
      targetId,
      get sessionId() {
        return session;
      },
      url: () => current,
      send,
      sendBrowser: (method, params) => this.send(method, params),
      on: subscribe,
      forSession: (childSession, childTarget) => this.page(childTarget, childSession),
    };
  }

  close(): void {
    this.#fail('closed by Scout');
    try {
      this.#socket.close();
    } catch {
      // Already closing.
    }
  }

  #receive(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const id = frame['id'];
    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      pending.settle();
      const error = frame['error'];
      if (isRecord(error)) {
        pending.reject(
          new CdpError(
            pending.method,
            typeof error['code'] === 'number' ? error['code'] : 0,
            typeof error['message'] === 'string' ? error['message'] : 'unknown error',
          ),
        );
      } else {
        pending.resolve(isRecord(frame['result']) ? frame['result'] : {});
      }
      return;
    }
    const method = frame['method'];
    if (typeof method !== 'string') return;
    const params = isRecord(frame['params']) ? frame['params'] : {};
    const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : undefined;
    if (method === 'Target.detachedFromTarget' && typeof params['sessionId'] === 'string') {
      const ended = params['sessionId'];
      const follow = this.#followers.get(ended);
      this.#followers.delete(ended);
      const asked = this.#letGo.has(ended) || (typeof params['targetId'] === 'string' && this.#letGo.has(params['targetId']));
      if (follow !== undefined && !asked) follow(() => this.#targetGone(ended));
      else this.#targetGone(ended);
    }
    for (const handler of [...(this.#handlers.get(`${sessionId ?? ''} ${method}`) ?? [])]) {
      handler(params);
    }
  }

  /** A detached session answers nothing more: its owed commands fail now rather than at their deadline. */
  #targetGone(sessionId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.settle();
      pending.reject(new CdpTargetGoneError(pending.method));
    }
  }

  #fail(reason: string): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const pending of this.#pending.values()) {
      pending.settle();
      pending.reject(new CdpClosedError(reason));
    }
    this.#pending.clear();
  }
}

/** An endpoint as it may be printed: query strings carry tickets and keys. */
export function redact(endpoint: string): string {
  const at = endpoint.indexOf('?');
  return at === -1 ? endpoint : `${endpoint.slice(0, at)}?…`;
}
