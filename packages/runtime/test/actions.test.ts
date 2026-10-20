import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { describeAction, hasRef, isTerminal, toObservedAction, validateAction } from '../src/actions';
import { filterTree, findNode, nodeRef } from '../src/snapshot';
import { catalogueTree, node, refOf, tree } from './support';

const page = filterTree(catalogueTree());
const search = refOf(page, 'Search');

function errorsFor(action: unknown): readonly string[] {
  const result = validateAction(action, page);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe('validateAction is the trust boundary for model output', () => {
  test('a well-formed action against a node in the tree is accepted', () => {
    const result = validateAction({ type: 'click', ref: search }, page);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ type: 'click', ref: search });
    }
  });

  test('it rejects a node that is not in the tree the action was chosen against', () => {
    // The reference is well-formed; it simply names something the model was
    // never shown. Acting on it anyway is guessing, which is the self-heal
    // behaviour the action-lock exists to make unnecessary.
    const absent = nodeRef(0, 999_999);
    expect(findNode(page, absent)).toBeUndefined();
    expect(errorsFor({ type: 'click', ref: absent })[0]).toContain('not in the snapshot');
  });

  test('it rejects a reference from the wrong frame even when the id exists', () => {
    const otherFrame = nodeRef(7, search.backendNodeId);
    expect(errorsFor({ type: 'click', ref: otherFrame })[0]).toContain('not in the snapshot');
  });

  test('it rejects a bare backendNodeId at runtime, where the compiler cannot help', () => {
    expect(errorsFor({ type: 'click', ref: search.backendNodeId })[0]).toMatch(/^ref /);
  });

  test('it rejects an object or a string that only looks like a reference', () => {
    expect(errorsFor({ type: 'click', ref: { backendNodeId: 42 } })[0]).toMatch(/^ref /);
    expect(errorsFor({ type: 'click', ref: `${String(search.frameOrdinal)}:${String(search.backendNodeId)}` })[0]).toMatch(/^ref /);
  });

  test('the reference a model writes is the string the tree prints, with or without its brackets', () => {
    const printed = `${String(search.frameOrdinal)}-${String(search.backendNodeId)}`;
    // `F-` is the grammar's own letter ("ref":"F-N"), copied with the reference (demoqa, 2026-10-04: 15 of 17 corrections).
    for (const written of [printed, `[${printed}]`, `F-${printed}`, `[F-${printed}]`]) {
      const result = validateAction({ type: 'click', ref: written }, page);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ type: 'click', ref: search });
      }
    }
  });

  test('a written reference with the wrong frame is refused, not re-homed to the frame holding that id', () => {
    // The measured production failure: the node id copied correctly, the
    // frame ordinal written wrong. Moving it to the one frame that has the id
    // would be guessing.
    const wrongFrame = `${String(search.frameOrdinal + 1)}-${String(search.backendNodeId)}`;
    expect(errorsFor({ type: 'click', ref: wrongFrame })[0]).toContain('not in the snapshot');
    expect(errorsFor({ type: 'click', ref: `F-${wrongFrame}` })[0]).toContain('not in the snapshot');
  });

  test('it rejects an unknown action type', () => {
    expect(errorsFor({ type: 'teleport', ref: search })[0]).toContain('action.type must be one of');
  });

  test('it rejects a non-object', () => {
    expect(errorsFor('click the button')[0]).toBe('action must be an object');
  });

  test('fill needs its text, select needs its value', () => {
    expect(errorsFor({ type: 'fill', ref: search }).join(' ')).toContain('fill has no "text"');
    expect(errorsFor({ type: 'select', ref: search })).toContain('value must be a non-empty string');
    const filled = validateAction({ type: 'fill', ref: search, text: '' }, page);
    expect(filled.ok).toBe(true);
  });

  // jobs-apply (fleet 2026-10-20, run_a12880c6) and a probe of the hands'
  // fallback model (n=6): the file was written in `value` or `text`, never in
  // `file`, and every attach was refused "file must be a non-empty string".
  test('an attachFile that names its file in value or text attaches that file', () => {
    const handle = 'file_dl_63eb3410-4827-4cf2-bf3c-0c400d68205c';
    const said: readonly [Record<string, unknown>, string][] = [
      [{ value: handle }, handle],
      [{ value: `cv.pdf (attached by handle: ${handle})` }, handle],
      [{ text: 'cv.pdf', value: 'cv.pdf' }, 'cv.pdf'],
      [{ file: handle, value: 'something else' }, handle],
    ];
    for (const [fields, file] of said) {
      const result = validateAction({ type: 'attachFile', ref: search, ...fields }, page);
      expect(result.ok ? result.value : result.errors).toEqual({ type: 'attachFile', ref: search, file });
    }
    expect(errorsFor({ type: 'attachFile', ref: search })).toContain('file must be a non-empty string');
  });

  test('a fill with no text is refused with its own action quoted and the two actions it can mean (run_…)', () => {
    // HarnessAB 2026-09-26, a lab arm on a fast preview model: 62 of 63
    // schema refusals, in 12 of 39 runs, were this one, and 45 of the 62
    // came straight after a fill had set that field. The reply passed the
    // reply schema, so `text` was ABSENT (a non-string would have failed there
    // first), and the model was told only "text must be a string" — twice
    // per step, unchanged every time, until run_… lost steps 9-12 to
    // it and ended stop=error. What it sent was never recorded; quoting it
    // here is what puts it on the step's error.
    const wire = `${String(search.frameOrdinal)}-${String(search.backendNodeId)}`;
    const said = errorsFor({ type: 'fill', ref: wire }).join(' ');

    expect(said).toContain(`the action arrived as {"type":"fill","ref":"${wire}"}`);
    expect(said).toContain(`{"type":"fill","ref":"${wire}","text":"..."}`);
    expect(said).toContain(`{"type":"press","key":"Enter","ref":"${wire}"}`);
  });

  test('a fill whose text is not a string says what arrived', () => {
    expect(errorsFor({ type: 'fill', ref: search, text: 42 }).join(' ')).toContain('"text" must be a string, got 42');
  });

  test('press may be aimed at the page rather than a node', () => {
    const result = validateAction({ type: 'press', key: 'Enter' }, page);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hasRef(result.value)).toBe(false);
    }
  });

  test('navigate must be an absolute http(s) url', () => {
    expect(errorsFor({ type: 'navigate', url: '/checkout' })[0]).toContain('absolute');
    expect(errorsFor({ type: 'navigate', url: 'file:///etc/passwd' })[0]).toContain('http');
    expect(validateAction({ type: 'navigate', url: 'https://example.com/x' }, page).ok).toBe(true);
  });

  test('extra fields are dropped rather than carried: the action is the cache unit', () => {
    const result = validateAction({ type: 'click', ref: search, note: 'from the model' }, page);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(['ref', 'type']);
    }
  });

  test('done and fail are terminal and need no node', () => {
    const done = validateAction({ type: 'done', summary: 'found it' }, page);
    const failed = validateAction({ type: 'fail', reason: 'login wall' }, page);
    expect(done.ok && isTerminal(done.value)).toBe(true);
    expect(failed.ok && isTerminal(failed.value)).toBe(true);
    expect(errorsFor({ type: 'fail' })[0]).toContain('reason');
  });

  test('a scroll that names the document scrolls the page; any other verb naming it is refused', () => {
    // Production, 7 days to 2026-09-24: 43 steps refused these exact values,
    // the root line's own `0 doc` tokens, 29 of them on an infinite-scroll page.
    for (const written of ['0', '0-0', 'doc', '0-doc', '0doc', '[0-doc]', 0]) {
      const result = validateAction({ type: 'scroll', ref: written, dy: 600 }, page);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ type: 'scroll', dy: 600 });
        expect(describeAction(result.value)).toBe('scroll the page by 0,600');
      }
    }
    expect(errorsFor({ type: 'click', ref: '0-doc' })[0]).toMatch(/^ref /);
    expect(errorsFor({ type: 'hover', ref: '0' })[0]).toMatch(/^ref /);
  });

  test('a scroll anchor that is a real-looking reference outside the tree is still refused', () => {
    // A misremembered node is not the page: scrolling the page instead would
    // move something other than what the model named.
    expect(errorsFor({ type: 'scroll', ref: '0-999999', dy: 600 })[0]).toContain('not in the snapshot');
    expect(errorsFor({ type: 'scroll', ref: 'email-input', dy: 600 })[0]).toMatch(/^ref /);
  });

  test('wait takes a number of seconds, clamped to what one step may spend', () => {
    const three = validateAction({ type: 'wait', seconds: 3 }, page);
    expect(three.ok && three.value).toEqual({ type: 'wait', seconds: 3 });
    const minute = validateAction({ type: 'wait', seconds: 60 }, page);
    expect(minute.ok && minute.value).toEqual({ type: 'wait', seconds: 60 });
    // The model asked for five minutes on production (run_…); one step
    // waits at most a minute, and the loop clamps that further to the caps.
    const long = validateAction({ type: 'wait', seconds: 300 }, page);
    expect(long.ok && long.value).toEqual({ type: 'wait', seconds: 60 });
    const none = validateAction({ type: 'wait', seconds: 0 }, page);
    expect(none.ok && none.value).toEqual({ type: 'wait', seconds: 1 });
    expect(errorsFor({ type: 'wait' })[0]).toContain('seconds');
    expect(errorsFor({ type: 'wait', seconds: '5' })[0]).toContain('seconds');
  });
});

describe('click and hover at a point, and drag (IW6 canvas, IW7 drag-drop, a chart tooltip)', () => {
  const wire = `${String(search.frameOrdinal)}-${String(search.backendNodeId)}`;

  test.each(['click', 'hover'] as const)('a %s at a viewport point is accepted, names no node, and round-trips', (type) => {
    const result = validateAction({ type, at: { x: 412.5, y: 230 } }, page);
    expect(result.ok && result.value).toEqual({ type, at: { x: 412.5, y: 230 } });
    if (!result.ok) return;
    // No node: the action cache cannot heal a point, and the loop must not
    // look one up.
    expect(hasRef(result.value)).toBe(false);
    expect(describeAction(result.value)).toBe(`${type} at (412.5, 230)`);
    // A loop-internal re-validation of the value it already holds is a no-op.
    expect(validateAction(result.value, page)).toEqual(result);
  });

  test.each(['click', 'hover'] as const)('a %s point with a negative or missing coordinate, or alongside a ref, is refused', (type) => {
    expect(errorsFor({ type, at: { x: -1, y: 10 } })[0]).toContain('outside the viewport');
    expect(errorsFor({ type, at: { x: 10 } })[0]).toMatch(/^at must be a viewport point/);
    expect(errorsFor({ type, at: '10,20' })[0]).toMatch(/^at must be a viewport point/);
    expect(errorsFor({ type, at: { x: Number.NaN, y: 1 } })[0]).toMatch(/^at must be a viewport point/);
    expect(errorsFor({ type, ref: wire, at: { x: 1, y: 1 } })[0]).toBe(`${type} takes ref OR at, not both`);
  });

  test('a drag takes a ref or a point at each end', () => {
    const mixed = validateAction({ type: 'drag', from: wire, to: { x: 600, y: 400 } }, page);
    expect(mixed.ok && mixed.value).toEqual({ type: 'drag', from: search, to: { x: 600, y: 400 } });
    if (mixed.ok) {
      expect(describeAction(mixed.value)).toBe(`drag from node ${wire} to (600, 400)`);
      expect(validateAction(mixed.value, page)).toEqual(mixed);
    }
    const points = validateAction({ type: 'drag', from: { x: 100, y: 100 }, to: { x: 300, y: 250 } }, page);
    expect(points.ok).toBe(true);
  });

  test('a drag end that is missing, unknown or off the tree is refused', () => {
    expect(errorsFor({ type: 'drag', to: { x: 1, y: 1 } })[0]).toMatch(/^from is required/);
    expect(errorsFor({ type: 'drag', from: '0-999999', to: { x: 1, y: 1 } })[0]).toContain('not in the snapshot');
    expect(errorsFor({ type: 'drag', from: { x: 1, y: 1 }, to: { x: -5, y: 1 } })[0]).toContain('outside the viewport');
  });

  test('a point-to-point drag is bounded both ways', () => {
    // Under the minimum a page reads a press and release as a click.
    expect(errorsFor({ type: 'drag', from: { x: 100, y: 100 }, to: { x: 103, y: 104 } })[0]).toMatch(/is a click/);
    // Past the maximum it is not one gesture.
    expect(errorsFor({ type: 'drag', from: { x: 0, y: 0 }, to: { x: 1500, y: 900 } })[0]).toMatch(/longer than the 1600 px/);
  });
});

describe('the wire form is what the action cache stores', () => {
  test('it carries the frame-qualified ref as a string and the xpath as the heal path', () => {
    const withXpath = tree(
      node({
        role: 'RootWebArea',
        name: 'checkout',
        children: [node({ role: 'button', name: 'Pay now', ref: nodeRef(1, 88), xpath: '/html/body/button[2]' })],
      }),
    );
    const target = nodeRef(1, 88);
    const action: Action = { type: 'click', ref: target };
    const node88 = findNode(withXpath, target);
    expect(node88).toBeDefined();

    const observed = toObservedAction({ ...action, ref: target }, node88!);
    expect(observed).toEqual({
      ref: '1-88',
      description: 'click the button "Pay now"',
      method: 'click',
      xpath: '/html/body/button[2]',
    });
  });

  test('arguments ride along for the actions that have them', () => {
    const target = findNode(page, search);
    expect(target).toBeDefined();
    const observed = toObservedAction({ type: 'fill', ref: search, text: 'headphones' }, target!);
    expect(observed.method).toBe('fill');
    expect(observed.args).toEqual(['headphones']);
  });

  test('descriptions name the node, so a reviewer can read the plan', () => {
    const target = findNode(page, search);
    expect(describeAction({ type: 'click', ref: search }, target)).toBe('click the searchbox "Search"');
    expect(describeAction({ type: 'navigate', url: 'https://example.com/' })).toBe(
      'navigate to https://example.com/',
    );
  });
});
