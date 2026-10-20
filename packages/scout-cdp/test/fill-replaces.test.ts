/**
 * A fill leaves the field holding exactly what was written, and an empty fill
 * empties it. Outcrawl Bench dev venues-hold (fleet 2026-10-20, run_456e5cd8):
 * a field holding a partial entry was filled again and read back as the
 * partial entry followed by the whole text, and `fill ""` was refused, so the
 * model could not clear it. Against a fake page whose select-all chord does
 * not select: no browser.
 */
import { describe, expect, test } from 'bun:test';

import { nodeRef } from '@outcrawl/runtime';

import { bindAgent, type CdpFlavor, type CdpPage, type HandsPort, type HandsStep } from '../src/index';
import { FIELD_VALUE, FOCUS_TAKES_TEXT } from '../src/scripts';

const FIELD = nodeRef(0, 7);

/** One text input on a page. `selectAllSelects: false` is the failure: the chord selects nothing. */
function fieldPage(initial: string, options: { readonly selectAllSelects: boolean }) {
  const field = { value: initial, selected: false };
  const keys: string[] = [];
  const reply = (method: string, params: Record<string, unknown>): Record<string, unknown> => {
    switch (method) {
      case 'Other.frame':
        return { frameOrdinal: 0, frameId: 'FRAME-0' };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'FRAME-0' } } };
      case 'DOM.describeNode':
        return { node: { backendNodeId: 7, nodeType: 1, localName: 'input', attributes: ['type', 'text'] } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 1 };
      case 'DOM.resolveNode':
        return { object: { objectId: 'field' } };
      case 'Runtime.callFunctionOn':
        if (params['functionDeclaration'] === FOCUS_TAKES_TEXT) return { result: { value: 'text' } };
        if (params['functionDeclaration'] === FIELD_VALUE) return { result: { value: field.value } };
        return { result: {} };
      case 'Input.dispatchKeyEvent': {
        const commands = params['commands'];
        if (Array.isArray(commands) && commands.includes('selectAll')) {
          keys.push('select-all');
          field.selected = options.selectAllSelects && field.value !== '';
        } else if (typeof params['text'] === 'string') {
          keys.push(`type ${params['text']}`);
          field.value = field.selected ? params['text'] : field.value + params['text'];
          field.selected = false;
        } else {
          keys.push(String(params['key']));
          if (params['key'] === 'Backspace') field.value = field.selected ? '' : field.value.slice(0, -1);
          field.selected = false;
        }
        return {};
      }
      default:
        return {};
    }
  };
  const page: CdpPage = {
    targetId: 'TARGET-1',
    sessionId: 'SESSION-1',
    url: () => 'https://venues.test/book',
    send: async (method, params) => reply(method, params ?? {}),
    sendBrowser: async () => ({}),
    on: () => () => undefined,
  };
  return { page, field, keys };
}

const flavor: CdpFlavor = {
  name: 'other',
  axTree: (session, params) => session.send('Other.tree', params),
  frameOrdinal: (session) => session.send('Other.frame'),
  lock: 'Other.freeze',
  unlock: 'Other.thaw',
  lockReleased: 'Other.thawed',
  dispatch: (session, step) => session.send(step.command, step.params as unknown as Record<string, unknown>),
  challengeSolving: 'Other.held',
  networkEvents: [],
};

/** A key event, as the real planner sends one; the fake page applies it. */
function key(key: string, extra: { readonly text?: string; readonly commands?: readonly string[] } = {}): HandsStep {
  return { command: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key, code: '', windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, ...extra } };
}

/** Hands that type a whole text as one key event, and send the chord with its select-all command. */
const hands: HandsPort = {
  click: () => [],
  hover: () => [],
  scroll: () => [],
  drag: () => [],
  type: (text, { replace }): readonly HandsStep[] => [...(replace ? [key('a', { commands: ['selectAll'] })] : []), key(text, { text })],
  press: (pressed): readonly HandsStep[] => [pressed === 'Control+a' ? key('a', { commands: ['selectAll'] }) : key(pressed)],
};

const instant = { now: (): number => 0, sleep: async (): Promise<void> => undefined };

function bound(page: CdpPage) {
  return bindAgent(page, { model: null, tabs: null, files: null, clock: instant, hands, flavor });
}

describe('a fill replaces what the field held', () => {
  test('a fill typed after a partial entry it could not select is erased and typed once more', async () => {
    const { page, field } = fieldPage('Hollinbridge Camera Club members socia', { selectAllSelects: false });
    await bound(page).perform({ type: 'fill', ref: FIELD, text: 'Hollinbridge Camera Club members social' });
    expect(field.value).toBe('Hollinbridge Camera Club members social');
  });

  test('a fill whose select-all works is typed once, with no erasing', async () => {
    const { page, field, keys } = fieldPage('old text', { selectAllSelects: true });
    await bound(page).perform({ type: 'fill', ref: FIELD, text: 'new text' });
    expect(field.value).toBe('new text');
    expect(keys).toEqual(['select-all', 'type new text']);
  });

  test('a fill into an empty field is typed once', async () => {
    const { page, field, keys } = fieldPage('', { selectAllSelects: false });
    await bound(page).perform({ type: 'fill', ref: FIELD, text: 'Ada' });
    expect(field.value).toBe('Ada');
    expect(keys).toEqual(['select-all', 'type Ada']);
  });
});

describe('an empty fill clears the field', () => {
  for (const selectAllSelects of [true, false]) {
    test(`whether or not the select-all selects (${String(selectAllSelects)})`, async () => {
      const { page, field } = fieldPage('members sociaHollinbridge', { selectAllSelects });
      await bound(page).perform({ type: 'fill', ref: FIELD, text: '' });
      expect(field.value).toBe('');
    });
  }
});
