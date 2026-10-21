import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';

import type { CdpPage } from '@outcrawl/scout-cdp';
import { isRecord } from '@outcrawl/scout-core';

import { CdpConnection } from '../src/cdp';

type Params = Record<string, unknown>;

interface Sent {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly params: Params;
}

interface PdfBrowser {
  readonly endpoint: string;
  readonly sent: Sent[];
  /** The next `Page.getFrameTree` arrives just after its session was taken away. */
  raceNextRead(): void;
  /** The page closes itself: its target and sessions go. */
  closeByPage(targetId: string): void;
  /** What `document.readyState` answers from now on. */
  readyState(state: 'loading' | 'interactive' | 'complete'): void;
  emit(sessionId: string, method: string, params: Params): void;
  stop(): void;
}

/**
 * A browser that does to a client what the fleet's does to a /connect one
 * (2026-10-21): a tab that commits a PDF keeps its target, and the client's
 * session on it is detached. A command on a session it no longer has is
 * answered -32001, as the real one answers.
 */
function pdfBrowser(): PdfBrowser {
  const sent: Sent[] = [];
  const sessions = new Map<string, string>();
  const targets = new Set(['TAB-1']);
  let next = 1;
  let race = false;
  let readyState = 'complete';
  let socket: ServerWebSocket<undefined> | undefined;
  const out = (frame: Params): void => {
    socket?.send(JSON.stringify(frame));
  };
  const detach = (sessionId: string): void => {
    const targetId = sessions.get(sessionId);
    sessions.delete(sessionId);
    out({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
  };
  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(_ws, data) {
        const frame: unknown = JSON.parse(String(data));
        if (!isRecord(frame) || typeof frame['id'] !== 'number' || typeof frame['method'] !== 'string') return;
        const { id, method } = frame;
        const params = isRecord(frame['params']) ? frame['params'] : {};
        const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : undefined;
        sent.push({ method, sessionId, params });
        const reply = (result: Params): void => out({ id, result, ...(sessionId === undefined ? {} : { sessionId }) });
        const fail = (code: number, message: string): void => out({ id, error: { code, message } });
        if (sessionId === undefined) {
          if (method === 'Target.attachToTarget') {
            const targetId = String(params['targetId']);
            if (!targets.has(targetId)) return fail(-32602, 'No target with given id found');
            const session = `S-${String(next++)}`;
            sessions.set(session, targetId);
            return reply({ sessionId: session });
          }
          if (method === 'Target.closeTarget') {
            const targetId = String(params['targetId']);
            targets.delete(targetId);
            for (const [session, target] of [...sessions]) if (target === targetId) detach(session);
            return reply({ success: true });
          }
          return reply({});
        }
        if (!sessions.has(sessionId)) return fail(-32001, 'Session with given id not found.');
        if (method === 'Page.getFrameTree' && race) {
          race = false;
          detach(sessionId);
          return fail(-32001, 'Session with given id not found.');
        }
        // A command the session took and will never answer: its session goes while it runs.
        if (method === 'Runtime.evaluate' && params['expression'] === 'taken') return detach(sessionId);
        if (method === 'Page.navigate') {
          const url = String(params['url']);
          reply({ frameId: 'TAB-1', loaderId: 'L-1' });
          out({ method: 'Page.frameNavigated', sessionId, params: { frame: { id: 'TAB-1', url, mimeType: url.endsWith('.pdf') ? 'application/pdf' : 'text/html' } } });
          if (url.endsWith('.pdf')) detach(sessionId);
          return;
        }
        if (method === 'Page.getFrameTree') return reply({ frameTree: { frame: { id: 'TAB-1', url: 'https://papers.test/a.pdf' } } });
        if (method === 'Page.createIsolatedWorld') return reply({ executionContextId: 7 });
        if (method === 'Runtime.evaluate' && params['expression'] === 'document.readyState' && params['contextId'] === 7) {
          return reply({ result: { type: 'string', value: readyState } });
        }
        return reply({});
      },
    },
  });
  return {
    endpoint: `ws://127.0.0.1:${String(server.port)}/devtools/browser/fake`,
    sent,
    raceNextRead: () => {
      race = true;
    },
    closeByPage: (targetId) => {
      targets.delete(targetId);
      for (const [session, target] of [...sessions]) if (target === targetId) detach(session);
    },
    readyState: (state) => {
      readyState = state;
    },
    emit: (sessionId, method, params) => out({ method, sessionId, params }),
    stop: () => void server.stop(true),
  };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

async function tab(): Promise<{ browser: PdfBrowser; connection: CdpConnection; page: CdpPage }> {
  const browser = pdfBrowser();
  const connection = await CdpConnection.open(browser.endpoint);
  cleanup.push(browser.stop, () => connection.close());
  const session = (await connection.send('Target.attachToTarget', { targetId: 'TAB-1', flatten: true }))['sessionId'];
  return { browser, connection, page: connection.page('TAB-1', String(session)) };
}

describe('a page whose session the browser takes away', () => {
  test('when its tab opens a PDF, is attached to the same target again and carries on there', async () => {
    const { browser, page } = await tab();
    const navigated: string[] = [];
    page.on('Page.frameNavigated', (params) => {
      const frame = params['frame'];
      if (isRecord(frame)) navigated.push(String(frame['url']));
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: 'https://papers.test/a.pdf' });

    const tree = await page.send('Page.getFrameTree');
    expect(isRecord(tree['frameTree'])).toBe(true);
    expect(page.targetId).toBe('TAB-1');
    expect(page.sessionId).toBe('S-2');
    expect(page.url()).toBe('https://papers.test/a.pdf');
    // The session state the page was given, first on the session it has now.
    expect(browser.sent.filter((s) => s.sessionId === 'S-2').map((s) => s.method).slice(0, 2)).toEqual(['Page.enable', 'Runtime.enable']);
    // Its handlers moved with it.
    browser.emit('S-2', 'Page.frameNavigated', { frame: { id: 'TAB-1', url: 'https://papers.test/next' } });
    await page.send('Page.getFrameTree');
    expect(navigated).toEqual(['https://papers.test/a.pdf', 'https://papers.test/next']);
    expect(page.url()).toBe('https://papers.test/next');
  });

  test("hears the load its PDF finished while no session was attached, from the document's readyState", async () => {
    const { page } = await tab();
    const heard: string[] = [];
    for (const method of ['Page.domContentEventFired', 'Page.loadEventFired', 'Page.frameStoppedLoading']) {
      page.on(method, (params) => heard.push(`${method} ${String(params['frameId'] ?? '')}`.trim()));
    }
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: 'https://papers.test/a.pdf' });
    await page.send('Page.getFrameTree');
    expect(heard).toEqual(['Page.domContentEventFired', 'Page.loadEventFired', 'Page.frameStoppedLoading TAB-1']);
  });

  test('is told nothing for a document still parsing, whose own events reach the new session', async () => {
    const { browser, page } = await tab();
    const heard: string[] = [];
    page.on('Page.domContentEventFired', () => heard.push('domContentEventFired'));
    await page.send('Page.enable');
    browser.readyState('loading');
    await page.send('Page.navigate', { url: 'https://papers.test/a.pdf' });
    await page.send('Page.getFrameTree');
    expect(heard).toEqual([]);
  });

  test('sends again, on the new session, a command the browser answered on the one it had just taken away', async () => {
    const { browser, page } = await tab();
    browser.raceNextRead();
    const tree = await page.send('Page.getFrameTree');
    expect(isRecord(tree['frameTree'])).toBe(true);
    expect(browser.sent.filter((s) => s.method === 'Page.getFrameTree').map((s) => s.sessionId)).toEqual(['S-1', 'S-2']);
  });

  test('fails a command the old session took and never answered, once the new one is attached, and does not send it again', async () => {
    const { browser, page } = await tab();
    await expect(page.send('Runtime.evaluate', { expression: 'taken' })).rejects.toThrow('went away first');
    await page.send('Page.getFrameTree');
    expect(browser.sent.filter((s) => s.method === 'Runtime.evaluate')).toHaveLength(1);
    expect(page.sessionId).toBe('S-2');
  });

  test('whose tab is gone stays detached, and its commands still fail', async () => {
    const { browser, page } = await tab();
    browser.closeByPage('TAB-1');
    await expect(page.send('Page.getFrameTree')).rejects.toThrow();
    await expect(page.send('Page.getFrameTree')).rejects.toThrow('Session with given id not found');
    expect(page.sessionId).toBe('S-1');
  });

  test('is not attached again when this client closed its tab', async () => {
    const { browser, connection, page } = await tab();
    await connection.send('Target.closeTarget', { targetId: 'TAB-1' });
    await expect(page.send('Page.getFrameTree')).rejects.toThrow('Session with given id not found');
    expect(browser.sent.filter((s) => s.method === 'Target.attachToTarget')).toHaveLength(1);
  });
});
