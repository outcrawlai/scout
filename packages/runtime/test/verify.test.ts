/**
 * OUTCOME VERIFICATION.
 *
 * The loop's other checks all run BEFORE an action. These are about the only
 * question nothing asked until now: did it do what it was for. Two properties
 * are load-bearing and both are asserted here rather than argued:
 *
 * - a contradiction is only ever reported on POSITIVE evidence or on a page
 *   that has demonstrably not moved within a bounded grace, because a check
 *   that fires falsely teaches every reader to ignore the verdict;
 * - no path here asks a model. The check is one structural read, and the tests
 *   count the reads.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { AxNode, AxTree, NodeRef } from '../src/snapshot';
import { hashSnapshot, nodeRef } from '../src/snapshot';
import type { Expectation } from '../src/verify';
import {
  CONCEALED_CHECK_SAW,
  DEFAULT_CHECK_POLICY,
  checkAction,
  checkReportedUrl,
  checkOutcome,
  contradictionKey,
  contradictionNote,
  errorSignals,
  expectationFor,
  expectationForProgram,
  heldPrivately,
} from '../src/verify';
import { VirtualClock, node, tree } from './support';

const BUTTON: NodeRef = nodeRef(0, 11);
const FIELD: NodeRef = nodeRef(0, 12);

/** A page with one button and one text field, both at fixed references. */
function page(options: {
  readonly url?: string;
  readonly buttonName?: string;
  readonly disabled?: boolean;
  readonly value?: string;
  readonly extra?: readonly AxNode[];
} = {}): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Checkout',
      children: [
        node({
          role: 'button',
          name: options.buttonName ?? 'Continue',
          ref: BUTTON,
          ...(options.disabled === true ? { state: { disabled: true } } : {}),
        }),
        node({
          role: 'textbox',
          name: 'Postal Code',
          ref: FIELD,
          ...(options.value === undefined ? {} : { value: options.value }),
        }),
        ...(options.extra ?? []),
      ],
    }),
    options.url ?? 'https://shop.example/checkout',
  );
}

const CLICK: Action = { type: 'click', ref: BUTTON };
const FILL: Action = { type: 'fill', ref: FIELD, text: 'SW1A 1AA' };
function expectationOf(action: Action, from: AxTree = page()): Expectation {
  return expectationFor(action, from, hashSnapshot(from));
}

describe('which actions are checked is a rule, not a list', () => {
  test('the five actions whose outcome one read can falsify get an expectation', () => {
    expect(expectationOf({ type: 'navigate', url: 'https://elsewhere.example/' }).kind).toBe('url');
    expect(expectationOf(FILL).kind).toBe('value');
    expect(expectationOf({ type: 'select', ref: FIELD, value: 'UK' }).kind).toBe('value');
    expect(expectationOf(CLICK).kind).toBe('effect');
    expect(expectationOf({ type: 'press', key: 'Enter' }).kind).toBe('effect');
  });

  test('an action with no falsifiable post-condition is not checked at all', () => {
    // `scroll` is the important one: the accessibility tree does not express the
    // viewport, so every verdict on a scroll would be a false contradiction.
    for (const action of [
      { type: 'scroll', direction: 'down' },
      { type: 'hover', ref: BUTTON },
      // A canvas click and a drag change pixels, not the tree: "the page
      // changed" would contradict every one that worked.
      { type: 'click', at: { x: 300, y: 200 } },
      { type: 'drag', from: { x: 100, y: 100 }, to: { x: 300, y: 200 } },
      { type: 'extract' },
      { type: 'openTab', url: 'https://shop.example/' },
      { type: 'focusTab', tab: 't1' },
      { type: 'closeTab', tab: 't1' },
      { type: 'done', summary: 'finished' },
      { type: 'fail', reason: 'blocked' },
    ] as readonly Action[]) {
      expect(expectationOf(action).kind).toBe('none');
    }
  });
});

describe('a click is judged on what the page did, not on what it returned', () => {
  test('a click that changed nothing at all is contradicted: the wrong-element signature', () => {
    const outcome = checkOutcome(expectationOf(CLICK), page());
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toBe('nothing on the page changed');
    // Absence of change is the one verdict a slow page can still overturn.
    expect(outcome.settleable).toBe(true);
  });

  test('a click that navigated is confirmed', () => {
    const outcome = checkOutcome(
      expectationOf(CLICK),
      page({ url: 'https://shop.example/checkout/overview' }),
    );
    expect(outcome.verdict).toBe('confirmed');
    expect(outcome.saw).toContain('overview');
  });

  test('a click whose target changed state is confirmed without a navigation', () => {
    const outcome = checkOutcome(expectationOf(CLICK), page({ disabled: true }));
    expect(outcome.verdict).toBe('confirmed');
    expect(outcome.saw).toContain('disabled');
  });

  test('a form that silently rejects is contradicted even though the page changed', () => {
    // The real shape, from saucedemo's checkout: the url holds, the tree gains
    // one node, and that node says the form was refused. Without the error
    // clause this reads as "the page changed" and the run continues.
    const rejected = page({
      extra: [node({ role: 'heading', name: 'Error: Postal Code is required' })],
    });
    const outcome = checkOutcome(expectationOf(CLICK), rejected);
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('Postal Code is required');
    // Positive evidence. Waiting cannot change it, so the check does not wait.
    expect(outcome.settleable).toBe(false);
  });

  test('an error the page already had is not evidence about this action', () => {
    const before = page({
      extra: [node({ role: 'link', name: 'Report an error' })],
    });
    const after = tree(
      { ...before.root, children: [...(before.root.children ?? [])] },
      'https://shop.example/checkout/overview',
    );
    const outcome = checkOutcome(expectationFor(CLICK, before, hashSnapshot(before)), after);
    expect(outcome.verdict).toBe('confirmed');
  });
  test('an ordinary control is never an error signal, whatever state.invalid says', () => {
    /**
     * MEASURED on the fleet with `probe-error-signals.ts`: this fork sets
     * `state.invalid: true` on plain controls — 3 of 13 nodes on saucedemo's
     * login page (both textboxes and the Login button) and 8 of 55 on the
     * inventory page (the burger button, the sort combobox, all six Add to
     * cart buttons). An earlier version of this check trusted the flag and
     * contradicted a Login click that had really logged in. Nothing may be
     * concluded from it, so nothing is.
     */
    const signals = errorSignals(
      page({ extra: [node({ role: 'button', name: 'Open Menu', state: { invalid: true } })] }),
    );
    expect(signals).toEqual([]);
  });

  test('a role whose purpose is to announce a problem is a signal with no vocabulary at all', () => {
    const signals = errorSignals(
      page({ extra: [node({ role: 'alert', name: 'Your card was declined' })] }),
    );
    expect(signals).toEqual(['alert|Your card was declined']);
  });

  test('a click that navigated is confirmed even though the destination mentions an error', () => {
    // The destination page's own words are not a verdict on the click that got
    // there, and the model reads that page's tree on the next step regardless.
    const outcome = checkOutcome(
      expectationOf(CLICK),
      page({
        url: 'https://shop.example/checkout/overview',
        extra: [node({ role: 'link', name: 'Report an error' })],
      }),
    );
    expect(outcome.verdict).toBe('confirmed');
  });
});

describe('a typed value is judged on what the field reads back', () => {
  test('the typed text present in the field confirms it', () => {
    const outcome = checkOutcome(expectationOf(FILL), page({ value: 'SW1A 1AA' }));
    expect(outcome.verdict).toBe('confirmed');
  });

  test('a field that is still empty contradicts the fill', () => {
    const outcome = checkOutcome(expectationOf(FILL), page());
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('still empty');
  });

  test('a masked field that was empty and now reports something is confirmed', () => {
    // A password input reports bullets, so an exact match is unavailable by
    // design. Contradicting every password fill in the product would be the
    // false verdict that makes the whole check ignorable.
    const outcome = checkOutcome(
      expectationOf({ type: 'fill', ref: FIELD, text: 'secret_sauce' }),
      page({ value: '\u2022\u2022\u2022\u2022\u2022\u2022' }),
    );
    expect(outcome.verdict).toBe('confirmed');
  });

  test('a value that landed with characters missing is contradicted, not waved through', () => {
    /**
     * THE MEASURED PRODUCTION DEFECT of 2026-09-08, in this check's terms.
     *
     * `agent-deps.ts` put ' ' in NAMED_KEYS and attached `text` only for Enter,
     * so Blink inserted nothing for a space: every multi-word string the agent
     * has ever typed lost its spaces. Three real Allrecipes rows searched for
     * one nonsense token each and burned all 20 steps, `fill` reporting success
     * throughout. These are the three strings as they were measured.
     *
     * This test also pins the narrowing of the masked-field clause above: an
     * earlier version accepted any field that was empty and is no longer, and
     * it would have called every one of these `confirmed`.
     */
    const dropped: readonly [string, string][] = [
      ['vegan chocolate chip cookies', 'veganchocolatechipcookies'],
      ['Most Popular Recipes of the 1960s', 'MostPopularRecipesofthe1960s'],
      ['Easy Vegetarian Spinach Lasagna', 'EasyVegetarianSpinachLasagna'],
    ];
    for (const [typed, landed] of dropped) {
      const outcome = checkOutcome(
        expectationOf({ type: 'fill', ref: FIELD, text: typed }),
        page({ value: landed }),
      );
      expect(outcome.verdict).toBe('contradicted');
      expect(outcome.saw).toContain(landed);
      expect(outcome.saw).toContain(typed);
    }
  });

  // venues-hold (fleet 2026-10-20, run_456e5cd8): a cut-off entry, then the
  // whole text typed after it, read back and confirmed because the text was in it.
  test('the text typed after an earlier cut-off entry of it is contradicted, and named', () => {
    const typed = 'Hollinbridge Camera Club members social';
    const outcome = checkOutcome(
      expectationOf({ type: 'fill', ref: FIELD, text: typed }),
      page({ value: `Hollinbridge Camera Club members socia${typed}` }),
    );
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('typed after "Hollinbridge Camera Club members socia"');
    expect(outcome.saw).toContain('Fill it with ""');
  });

  test('a field that adds to the text, as an autocomplete does, still confirms it', () => {
    const outcome = checkOutcome(expectationOf({ type: 'fill', ref: FIELD, text: 'London' }), page({ value: 'London, UK' }));
    expect(outcome.verdict).toBe('confirmed');
  });

  // venues-hold (fleet 2026-10-20, run_722c543f): a timed dialog opened while
  // the event name was typed and hid the form; the model read only "cannot be
  // read back", answered the dialog, and booked with a half-typed name.
  test('a field hidden by a dialog that opened says the dialog, and that keys may have gone to it', () => {
    const covered = tree(
      node({
        role: 'RootWebArea',
        name: 'Checkout',
        children: [node({ role: 'dialog', name: 'Are you still there?', children: [node({ role: 'button', name: 'Keep my hold' })] })],
      }),
      'https://shop.example/checkout',
    );
    const outcome = checkOutcome(expectationOf(FILL), covered);
    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.saw).toContain('a dialog "Are you still there?" is open over the page');
    expect(outcome.saw).toContain('fill it again');
  });

  test('a fill a mask formatted is confirmed', () => {
    // The shapes measured on production 2026-09-23, the first fills ever read
    // back: 6 of 17 contradicted, each one a mask formatting what was typed.
    const formatted: readonly [string, string][] = [
      ['08/31', '08 / 31'],
      ['+13022356545', '+1 302-235-6545'],
      ['4242424242424242', '4242 4242 4242 4242'],
      ['3022356545', '(302) 235-6545'],
    ];
    for (const [typed, shown] of formatted) {
      const outcome = checkOutcome(expectationOf({ type: 'fill', ref: FIELD, text: typed }), page({ value: shown }));
      expect(outcome.verdict).toBe('confirmed');
    }
  });

  test('a mask cannot hide a wrong or a missing character', () => {
    const wrong: readonly [string, string][] = [
      ['4242424242424242', '4242 4242 4242 4241'],
      ['4242424242424242', '4242 4242 4242 424'],
      ['08/31', '08 / 3'],
    ];
    for (const [typed, shown] of wrong) {
      const outcome = checkOutcome(expectationOf({ type: 'fill', ref: FIELD, text: typed }), page({ value: shown }));
      expect(outcome.verdict).toBe('contradicted');
    }
  });

  test('a field that is gone establishes nothing rather than contradicting', () => {
    const gone = tree(
      node({ role: 'RootWebArea', name: 'Overview', children: [] }),
      'https://shop.example/checkout',
    );
    expect(checkOutcome(expectationOf(FILL), gone).verdict).toBe('unchecked');
  });

  /**
   * A native `<input type=date>` as the fork's tree shows it, MEASURED on the
   * fleet rig 2026-10-01 (`probe-fill-fidelity.ts`): each segment is a
   * `spinbutton` named for its label, with NO value, and the segment's content
   * is its one StaticText child — the placeholder "mm" while empty, the digits
   * once typed. BU Bench tasks 22, 27, 62 and 77 typed 01/15/YYYY into exactly
   * these and were told, three times each, that nothing landed.
   */
  const MONTH: NodeRef = nodeRef(0, 40);
  function dateSegment(shown: string): AxTree {
    return page({
      extra: [
        node({
          role: 'spinbutton',
          name: 'Month Date of Birth',
          ref: MONTH,
          children: [node({ role: 'StaticText', name: shown })],
        }),
      ],
    });
  }

  test('a date segment that shows what was typed confirms the fill, though it carries no value', () => {
    const fill: Action = { type: 'fill', ref: MONTH, text: '01' };
    const outcome = checkOutcome(expectationFor(fill, dateSegment('mm'), ''), dateSegment('01'));
    expect(outcome.verdict).toBe('confirmed');
    expect(outcome.saw).toContain('"01"');
  });

  test('a date segment still showing its placeholder contradicts the fill, and says what it shows', () => {
    const fill: Action = { type: 'fill', ref: MONTH, text: '01' };
    const outcome = checkOutcome(expectationFor(fill, dateSegment('mm'), ''), dateSegment('mm'));
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('"mm"');
  });

  test('typing through consecutive segments reads back the whole value, not only the first segment', () => {
    const date = (day: string, separator = '/', frame = 0): AxTree => page({
      extra: [
        node({ role: 'spinbutton', ref: MONTH, children: [node({ role: 'StaticText', name: '10' })] }),
        node({ role: 'StaticText', name: separator }),
        node({ role: 'spinbutton', ref: nodeRef(frame, 41), children: [node({ role: 'StaticText', name: day })] }),
        node({ role: 'StaticText', name: '/' }),
        node({ role: 'spinbutton', ref: nodeRef(frame, 42), children: [node({ role: 'StaticText', name: '2026' })] }),
      ],
    });
    const expected = expectationFor({ type: 'fill', ref: MONTH, text: '10012026' }, date('dd'), '');
    expect(checkOutcome(expected, date('01')).verdict).toBe('confirmed');
    // Wrong digits, an unfilled segment, another field's label and another
    // frame cannot supply the remainder of the requested value.
    expect(checkOutcome(expected, date('02')).verdict).toBe('contradicted');
    expect(checkOutcome(expected, date('dd')).verdict).toBe('contradicted');
    expect(checkOutcome(expected, date('01', 'Other date')).verdict).toBe('contradicted');
    expect(checkOutcome(expected, date('01', '/', 1)).verdict).toBe('contradicted');
  });

  test('the label is never read as the content', () => {
    // A segment with no text child is empty, whatever its name says: a name of
    // "Month 01 Date" must not confirm a fill of "01".
    const empty = page({ extra: [node({ role: 'spinbutton', name: 'Month 01 Date', ref: MONTH })] });
    const outcome = checkOutcome(expectationFor({ type: 'fill', ref: MONTH, text: '01' }, empty, ''), empty);
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('still empty');
  });

  /**
   * httpbin.org/forms/post's `<input type=time>` as the fork's tree shows it,
   * MEASURED on a fleet Mac 2026-10-02 (Chrome/154, en-US, n=3 per shape): three
   * named spinbuttons, Hours (1-12), Minutes and AM/PM, separated by ":" and
   * " ". Filling the Hours segment with "1930", "19:30" or "0730P" left
   * `input.value === "19:30"` and the segments reading 07 : 30 PM, 3/3 each.
   * `run_…` filled "1930" there and was told it was contradicted
   * because the Hours segment alone read "07".
   */
  const HOURS: NodeRef = nodeRef(0, 52);
  function timeInput(hours: string, minutes: string, ampm: string): AxTree {
    return page({
      extra: [
        node({
          role: 'generic',
          children: [
            node({ role: 'spinbutton', name: 'Hours Hours', ref: HOURS, children: [node({ role: 'StaticText', name: hours })] }),
            node({ role: 'StaticText', name: ':' }),
            node({ role: 'spinbutton', name: 'Minutes Minutes', ref: nodeRef(0, 54), children: [node({ role: 'StaticText', name: minutes })] }),
            node({ role: 'StaticText', name: ' ' }),
            node({ role: 'spinbutton', name: 'AM/PM AM/PM', ref: nodeRef(0, 56), children: [node({ role: 'StaticText', name: ampm })] }),
          ],
        }),
      ],
    });
  }
  const emptyTime = timeInput('--', '--', '--');
  const timeFill = (text: string): Expectation => expectationFor({ type: 'fill', ref: HOURS, text }, emptyTime, '');

  test('a whole time typed into one segment is judged on the whole input, in any shape it was written', () => {
    const landed = timeInput('07', '30', 'PM');
    for (const text of ['1930', '19:30', '7:30 PM', '07:30 pm']) {
      const outcome = checkOutcome(timeFill(text), landed);
      expect(outcome.verdict).toBe('confirmed');
      expect(outcome.saw).toContain('19:30');
    }
  });

  test('a time that did not wholly land, or landed as another time, is still contradicted', () => {
    // "07:30 PM" typed with its space: the AM/PM segment stayed empty, 3/3.
    const partial = checkOutcome(timeFill('07:30 PM'), timeInput('07', '30', '--'));
    expect(partial.verdict).toBe('contradicted');
    expect(partial.saw).toContain('"07:30 --"');
    const morning = checkOutcome(timeFill('19:30'), timeInput('07', '30', 'AM'));
    expect(morning.verdict).toBe('contradicted');
    expect(morning.saw).toContain('07:30, not 19:30');
  });

  test('an hour past 12 typed into a 12-hour Hours segment reads back as that hour', () => {
    // Typing "19" into Hours shows "07" and sets AM/PM to "PM" (a fleet Mac, 3/3).
    expect(checkOutcome(timeFill('19'), timeInput('07', '--', 'PM')).verdict).toBe('confirmed');
    expect(checkOutcome(timeFill('19'), timeInput('07', '--', 'AM')).verdict).toBe('contradicted');
  });

  /**
   * The same input as stock Chromium's tree shows it, MEASURED 2026-10-13
   * (Playwright's build, en-US): each segment carries a value beside the text
   * it draws ("7" beside "07", "2" beside "pm", "0" beside "--"), and no
   * separator stands between Minutes and AM/PM.
   */
  function stockTimeInput(hours: [string, string], minutes: [string, string], ampm: [string, string]): AxTree {
    const segment = (name: string, at: number, [value, text]: [string, string]): AxNode =>
      node({ role: 'spinbutton', name, value, ref: at === 52 ? HOURS : nodeRef(0, at), children: [node({ role: 'StaticText', name: text })] });
    return page({
      extra: [
        segment('Hours Hours', 52, hours),
        node({ role: 'StaticText', name: ':' }),
        segment('Minutes Minutes', 54, minutes),
        segment('AM/PM AM/PM', 56, ampm),
        segment('Hours Hours', 58, ['0', '--']),
      ],
    });
  }

  test('a stock tree is read by what each segment shows, across a gap before AM/PM, and only for its own input', () => {
    const landed = checkOutcome(timeFill('19:30'), stockTimeInput(['7', '07'], ['30', '30'], ['2', 'pm']));
    expect(landed.verdict).toBe('confirmed');
    expect(landed.saw).toBe('the input reads "07:30 pm", which is 19:30');
    const empty = checkOutcome(timeFill('19:30'), stockTimeInput(['7', '07'], ['30', '30'], ['0', '--']));
    expect(empty.verdict).toBe('contradicted');
    expect(empty.saw).toContain('"07:30 --", which is not a complete value');
  });

  test('a date is judged on the fields its segments are named for, not on their order', () => {
    const MONTH_SEGMENT = nodeRef(0, 60);
    const dateInput = (first: [string, string], second: [string, string]): AxTree =>
      page({
        extra: [
          node({ role: 'spinbutton', name: `${first[0]} Date`, ref: MONTH_SEGMENT, children: [node({ role: 'StaticText', name: first[1] })] }),
          node({ role: 'StaticText', name: '/' }),
          node({ role: 'spinbutton', name: `${second[0]} Date`, ref: nodeRef(0, 61), children: [node({ role: 'StaticText', name: second[1] })] }),
          node({ role: 'StaticText', name: '/' }),
          node({ role: 'spinbutton', name: 'Year Date', ref: nodeRef(0, 62), children: [node({ role: 'StaticText', name: '2026' })] }),
        ],
      });
    const before = dateInput(['Month', 'mm'], ['Day', 'dd']);
    const fill = expectationFor({ type: 'fill', ref: MONTH_SEGMENT, text: '2026-10-03' }, before, '');
    expect(checkOutcome(fill, dateInput(['Month', '10'], ['Day', '03'])).verdict).toBe('confirmed');
    expect(checkOutcome(fill, dateInput(['Day', '10'], ['Month', '03'])).verdict).toBe('contradicted');
  });
});

describe('a navigate is judged on where the browser ended up', () => {
  const going: Action = { type: 'navigate', url: 'https://elsewhere.example/list' };

  test('the requested origin confirms it, whatever path the site routed to', () => {
    const outcome = checkOutcome(
      expectationOf(going),
      page({ url: 'https://elsewhere.example/list/page-2' }),
    );
    expect(outcome.verdict).toBe('confirmed');
  });

  test('a page that never left is contradicted, and can still catch up', () => {
    const outcome = checkOutcome(expectationOf(going), page());
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.settleable).toBe(true);
  });

  test('a same-site redirect took effect, and says where it landed', () => {
    // BrowseComp smoke, 2026-10-02 (2 of 10 runs): duckduckgo.com/html commits
    // as html.duckduckgo.com/html. Judged contradicted, a working navigation
    // was charged to stepFailures and the run was stopped.
    const search: Action = { type: 'navigate', url: 'https://duckduckgo.com/html/?q=short+film+2015' };
    const outcome = checkOutcome(expectationOf(search), page({ url: 'https://html.duckduckgo.com/html/?q=short+film+2015' }));
    expect(outcome.verdict).toBe('confirmed');
    expect(outcome.saw).toContain('html.duckduckgo.com');

    const bare: Action = { type: 'navigate', url: 'https://example.com/' };
    expect(checkOutcome(expectationOf(bare), page({ url: 'https://www.example.com/' })).verdict).toBe('confirmed');
  });

  test('a landing on a different site is contradicted and final: this is the consent wall', () => {
    const outcome = checkOutcome(expectationOf(going), page({ url: 'https://consent.example/eu' }));
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.saw).toContain('consent.example');
    expect(outcome.settleable).toBe(false);

    // A sibling subdomain on another path is the consent wall's own shape, and
    // two hosts under one public suffix are not one site.
    const search: Action = { type: 'navigate', url: 'https://www.search.example/search?q=x' };
    expect(checkOutcome(expectationOf(search), page({ url: 'https://consent.search.example/ml?continue=x' })).verdict).toBe('contradicted');
    const uk: Action = { type: 'navigate', url: 'https://shop.co.uk/' };
    expect(checkOutcome(expectationOf(uk), page({ url: 'https://other.co.uk/' })).verdict).toBe('contradicted');
  });

  test("a site's own regional host serving the same page took effect, and says where it landed", () => {
    // Stealth Bench task 15 r9 (run_…, 2026-10-07): www.shein.com/
    // always commits on a regional host; judged contradicted, it was the
    // fourth failed step in a row and ended the run.
    const shein: Action = { type: 'navigate', url: 'https://www.shein.com/' };
    const landed = 'https://us.shein.com/?cdn_rsite=cf&ref=www&rep=dir&ret=us';
    const outcome = checkOutcome(expectationOf(shein), page({ url: landed }));
    expect(outcome.verdict).toBe('confirmed');
    expect(outcome.saw).toContain(landed);
    expect(checkReportedUrl(expectationOf(shein), landed)?.verdict).toBe('confirmed');
    const uk: Action = { type: 'navigate', url: 'https://www.bbc.co.uk/news' };
    expect(checkOutcome(expectationOf(uk), page({ url: 'https://news.bbc.co.uk/news' })).verdict).toBe('confirmed');
  });

  test('a regional host stays contradicted on another site, another path or a downgrade to http', () => {
    const copilot: Action = { type: 'navigate', url: 'https://copilot.microsoft.com/' };
    expect(checkOutcome(expectationOf(copilot), page({ url: 'https://copilot.com/?fromcode=cmc' })).verdict).toBe('contradicted');
    const shein: Action = { type: 'navigate', url: 'https://www.shein.com/' };
    expect(checkOutcome(expectationOf(shein), page({ url: 'https://us.shein.com/login' })).verdict).toBe('contradicted');
    const deep: Action = { type: 'navigate', url: 'https://www.shein.com/pdsearch/winter%20jackets/' };
    const gate = 'https://us.shein.com/risk/challenge?captcha_type=909&redirection=https%3A%2F%2Fus.shein.com%2F';
    expect(checkOutcome(expectationOf(deep), page({ url: gate })).verdict).toBe('contradicted');
    expect(checkOutcome(expectationOf(shein), page({ url: 'http://us.shein.com/' })).verdict).toBe('contradicted');
  });

  test('a landing on the browser error page is contradicted and final', () => {
    const outcome = checkOutcome(expectationOf(going), page({ url: 'chrome-error://chromewebdata/' }));
    expect(outcome.verdict).toBe('contradicted');
    expect(outcome.settleable).toBe(false);
  });

  test('the url the navigation itself reported is judged with no page read at all', () => {
    // `PerformOutcome.url` is produced by the production binding on every
    // navigate and was read by nothing. It is the only source that works here:
    // a page that has just committed under the freeze produces no accessibility
    // tree at all, measured six-attempts-zero-successes on the fleet.
    const confirmed = checkReportedUrl(expectationOf(going), 'https://elsewhere.example/list');
    expect(confirmed?.verdict).toBe('confirmed');
    expect(confirmed?.reads).toBe(0);
    expect(confirmed?.elapsedMs).toBe(0);
    expect(confirmed?.saw).toContain('as the navigation itself reported');

    const gated = checkReportedUrl(expectationOf(going), 'https://consent.example/eu');
    expect(gated?.verdict).toBe('contradicted');
    const redirected = checkReportedUrl(expectationOf(going), 'https://www.elsewhere.example/list');
    expect(redirected?.verdict).toBe('confirmed');
    const failed = checkReportedUrl(expectationOf(going), 'chrome-error://chromewebdata/');
    expect(failed?.verdict).toBe('contradicted');

    // Only a navigate has a reported url; everything else must read the page.
    expect(checkReportedUrl(expectationOf(CLICK), 'https://shop.example/checkout')).toBeUndefined();
  });
});

describe('what the check costs is measured, not asserted', () => {
  test('a confirmed outcome costs exactly one read and no wait', async () => {
    const clock = new VirtualClock();
    let reads = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        reads += 1;
        return page({ url: 'https://shop.example/checkout/overview' });
      },
      clock,
    );
    expect(check.verdict).toBe('confirmed');
    expect(check.reads).toBe(1);
    expect(reads).toBe(1);
    expect(check.elapsedMs).toBe(0);
  });

  test('a page that had not moved yet is re-read within the grace and confirms', async () => {
    const clock = new VirtualClock();
    let reads = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        reads += 1;
        // Two reads mid-flight, then the navigation lands. This is the case a
        // naive check reports as a contradiction on every slow click.
        return reads > 2 ? page({ url: 'https://shop.example/checkout/overview' }) : page();
      },
      clock,
    );
    expect(check.verdict).toBe('confirmed');
    expect(check.reads).toBe(3);
    expect(check.elapsedMs).toBe(2 * DEFAULT_CHECK_POLICY.pollMs);
  });

  test('a page that never moves spends the grace and no more', async () => {
    const clock = new VirtualClock();
    let reads = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        reads += 1;
        return page();
      },
      clock,
    );
    expect(check.verdict).toBe('contradicted');
    expect(check.elapsedMs).toBe(DEFAULT_CHECK_POLICY.graceMs);
    expect(reads).toBe(DEFAULT_CHECK_POLICY.graceMs / DEFAULT_CHECK_POLICY.pollMs + 1);
  });

  test('positive evidence is not waited on', async () => {
    const clock = new VirtualClock();
    let reads = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        reads += 1;
        return page({ extra: [node({ role: 'alert', name: 'Postal Code is required' })] });
      },
      clock,
    );
    expect(check.verdict).toBe('contradicted');
    expect(reads).toBe(1);
    expect(check.elapsedMs).toBe(0);
  });

  test('a page that will not read establishes nothing and never contradicts', async () => {
    const clock = new VirtualClock();
    let attempts = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        attempts += 1;
        // `Outcrawl.getAXTree` answers -32000 for the first 30-130ms after a
        // commit, which is exactly the state a click that navigated leaves.
        throw new Error('No accessibility tree was produced');
      },
      clock,
    );
    expect(check.verdict).toBe('unchecked');
    expect(check.reads).toBe(0);
    expect(check.saw).toContain(`${String(attempts)} attempt(s)`);
    // BOUNDED, and the bound is the -32000 window above: 150 ms of poll clears
    // it, so a second attempt is the last one that can beat anything and a
    // third would be paid on every failure for nothing.
    expect(attempts).toBe(DEFAULT_CHECK_POLICY.failedReads);
    expect(check.elapsedMs).toBe(DEFAULT_CHECK_POLICY.pollMs);
  });
});

/**
 * THE BARE CATCH, WHICH WAS ITSELF THE DEFECT.
 *
 * `catch { failed += 1 }` counted the failures and discarded every reason, so
 * `run_…` recorded 20 post-action reads, 0 successes and NO record
 * anywhere of what the browser had refused. The reason was a `LockLostError`
 * raised inside this process, one statement away, for weeks.
 */
describe('a read that throws puts the reason on the trace', () => {
  test('the class and the message both survive, and the verdict quotes them', async () => {
    const clock = new VirtualClock();
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        const error = new Error('snapshot cannot proceed: the browser released the action-lock');
        error.name = 'LockLostError';
        throw error;
      },
      clock,
    );
    expect(check.verdict).toBe('unchecked');
    // The CLASS, because it is the discriminator: a lost lock, a tab that is
    // gone and a renderer refusal are three different defects and only the name
    // tells them apart.
    expect(check.readError).toBe(
      'LockLostError: snapshot cannot proceed: the browser released the action-lock',
    );
    expect(check.saw).toContain('LockLostError');
  });

  test('a cause is carried one level, because the tabbed binding wraps refusals', async () => {
    const clock = new VirtualClock();
    const inner = new Error('tab_3 is gone');
    inner.name = 'TabLostError';
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        throw new Error('the read named no live tab', { cause: inner });
      },
      clock,
    );
    expect(check.readError).toContain('TabLostError: tab_3 is gone');
  });

  test('a throw that a later read recovers from is still recorded', async () => {
    const clock = new VirtualClock();
    let attempts = 0;
    const check = await checkAction(
      expectationOf(CLICK),
      () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('-32000 No accessibility tree was produced');
        }
        return page({ url: 'https://shop.example/checkout/overview' });
      },
      clock,
    );
    // The verdict is the tree's, and the throw that preceded it is not erased:
    // a check that only reports failures it never recovered from cannot tell a
    // healthy retry from a browser that is refusing every other read.
    expect(check.verdict).toBe('confirmed');
    expect(check.reads).toBe(1);
    expect(check.readError).toContain('-32000');
  });

  test('a check that read cleanly carries no reason, because there was none', async () => {
    const clock = new VirtualClock();
    const check = await checkAction(
      expectationOf(CLICK),
      () => page({ url: 'https://shop.example/checkout/overview' }),
      clock,
    );
    expect(check.readError).toBeUndefined();
  });
});

/**
 * A CLICK MUST PRODUCE AN EXPECTATION WHEREVER IT APPEARS IN THE STEP.
 *
 * The post-action read is taken after the whole motor program. The expectation
 * was derived from the head action alone, so a step whose head asserts nothing
 * took no read at all and every click in its `then` was unobservable — the
 * single most common real failure there is, invisible for the whole width of
 * that arm.
 */
describe('the expectation is about the program, not only its head', () => {
  const SCROLL: Action = { type: 'scroll', dy: 600 };

  test('a head that asserts nothing still watches a program that clicks', () => {
    const from = page();
    const expectation = expectationForProgram(
      SCROLL,
      [{ type: 'click', ref: BUTTON }],
      from,
      hashSnapshot(from),
    );
    expect(expectation.kind).toBe('effect');
    // And it is falsifiable: a page that did not move contradicts it.
    expect(checkOutcome(expectation, page()).verdict).toBe('contradicted');
    expect(
      checkOutcome(expectation, page({ url: 'https://shop.example/basket' })).verdict,
    ).toBe('confirmed');
  });

  test('a program of verbs no read can falsify still asserts nothing', () => {
    const from = page();
    expect(
      expectationForProgram(SCROLL, [{ type: 'hover', ref: BUTTON }], from, hashSnapshot(from)).kind,
    ).toBe('none');
    expect(expectationForProgram(SCROLL, [], from, hashSnapshot(from)).kind).toBe('none');
    // A point click in the program is exempt for the same reason it is as a head.
    expect(
      expectationForProgram(SCROLL, [{ type: 'click', at: { x: 300, y: 200 } }], from, hashSnapshot(from)).kind,
    ).toBe('none');
  });

  test('the verb is read off a RAW element, because nothing has been validated yet', () => {
    // A motor program is validated one element at a time against the page as it
    // is at that instant, so at this point the elements are whatever the model
    // sent. An element that is not an object, or names an unknown verb, must not
    // be the thing an expectation rests on.
    const from = page();
    for (const program of [[null], ['click'], [{ type: 'nonsense' }], [{}]] as readonly unknown[][]) {
      expect(expectationForProgram(SCROLL, program, from, hashSnapshot(from)).kind).toBe('none');
    }
  });

  test('a head that moves focus asserts nothing, however the program clicks', () => {
    // The read after the program lands on a DIFFERENT TAB, so every field of it
    // differs from this tree — which `checkOutcome` would read as "the page
    // changed" and confirm, for a program that may have done nothing at all. A
    // false confirmation is worse than no check.
    const from = page();
    for (const head of [
      { type: 'openTab', url: 'https://shop.example/' },
      { type: 'focusTab', tab: 't1' },
      { type: 'closeTab', tab: 't1' },
    ] as readonly Action[]) {
      expect(
        expectationForProgram(head, [{ type: 'click', ref: BUTTON }], from, hashSnapshot(from)).kind,
      ).toBe('none');
    }
  });

  test('a head with its own expectation keeps it: it is the stronger evidence', () => {
    const from = page();
    const expectation = expectationForProgram(
      FILL,
      [{ type: 'click', ref: BUTTON }],
      from,
      hashSnapshot(from),
    );
    expect(expectation.kind).toBe('value');
    // And it cannot manufacture a false verdict when the program destroys its
    // target: an absent field is `unchecked`, never a contradiction.
    expect(checkOutcome(expectation, tree(node({ role: 'RootWebArea' }))).verdict).toBe('unchecked');
  });
});

test('a repeat is judged on the action and the reference, not on the whole reply', () => {
  expect(contradictionKey(CLICK)).toBe(contradictionKey({ type: 'click', ref: BUTTON }));
  expect(contradictionKey(CLICK)).not.toBe(contradictionKey({ type: 'click', ref: FIELD }));
  expect(contradictionKey({ type: 'press', key: 'Enter' })).toContain('page');
});

describe('a reload key is judged as a load of the same url', () => {
  test('a reloaded page that reads exactly as before is confirmed, not "nothing changed"', () => {
    const from = page();
    const expectation = expectationFor({ type: 'press', key: 'F5' }, from, hashSnapshot(from));
    expect(checkOutcome(expectation, page()).verdict).toBe('confirmed');
    // An ordinary key on an unchanged page still reads as no effect.
    expect(checkOutcome(expectationOf({ type: 'press', key: 'Enter' }), page()).verdict).toBe('contradicted');
  });

  test('on the browser error page nothing is asserted, since the url reloaded is the failed one', () => {
    const errorPage = page({ url: 'chrome-error://chromewebdata/' });
    expect(expectationFor({ type: 'press', key: 'F5' }, errorPage, hashSnapshot(errorPage)).kind).toBe('none');
  });
});

describe('the ruled-out note for a contradicted step', () => {
  const check = (saw: string) => ({ verdict: 'contradicted' as const, expected: 'the browser goes to https://shop.example.com/p/1?v=2', saw, reads: 1, elapsedMs: 0 });

  /** MUTATIONS THIS CATCHES: a navigate that never committed told "do something else" (sealed heldout4 mode: the run dropped a URL qualifier); every other contradiction losing that instruction. */
  test('a navigate still on the page it left allows one exact retry; any other contradiction says do something else', () => {
    const go: Action = { type: 'navigate', url: 'https://shop.example.com/p/1?v=2' };
    expect(contradictionNote(go, check('the browser is still on https://shop.example.com/'))).toContain('One exact retry of the same URL is reasonable');
    const elsewhere = contradictionNote(go, check('the browser is on https://other.example.net/'));
    expect(elsewhere).toContain('Do something else rather than repeating it');
    expect(elsewhere).not.toContain('retry');
  });
});

describe('a fill into a field the model is shown concealed', () => {
  const masked = page({ value: '[concealed field]' });

  /** MUTATION THIS CATCHES: a host without the private comparison failing the step on the mask (run_…'s "reads [concealed field], not CA"). */
  test('is asked of the host privately, and a host that cannot say leaves it unchecked', async () => {
    const asked: string[] = [];
    const confirmed = await checkAction(expectationOf(FILL), () => masked, new VirtualClock(), DEFAULT_CHECK_POLICY, async (ref, written) => {
      asked.push(`${String(ref.backendNodeId)}:${written}`);
      return true;
    });
    expect(asked).toEqual(['12:SW1A 1AA']);
    expect(confirmed).toMatchObject({ verdict: 'confirmed', saw: CONCEALED_CHECK_SAW.holds });
    const blind = await checkAction(expectationOf(FILL), () => masked, new VirtualClock());
    expect(blind).toMatchObject({ verdict: 'unchecked', saw: CONCEALED_CHECK_SAW.uncompared });
  });

  test('a field that reads as itself never asks the host', async () => {
    let asked = 0;
    await checkAction(expectationOf(FILL), () => page({ value: 'SW1A 1AA' }), new VirtualClock(), DEFAULT_CHECK_POLICY, async () => {
      asked += 1;
      return false;
    });
    expect(asked).toBe(0);
  });

  /**
   * THE ORACLE THIS REFUSES. A field that ignored the write still holds what
   * was there; a substring rule would answer, digit by digit, what a
   * concealed card field holds. MUTATION: `includes` in place of equality.
   */
  test('the private comparison is whole-value, never a substring, with a mask and a code name allowed', () => {
    const raw = (value: string) => page({ value });
    expect(heldPrivately(raw('4242 4242 4242 4242'), FIELD, '4242')).toBe(false);
    expect(heldPrivately(raw('4242 4242 4242 4242'), FIELD, '4242424242424242')).toBe(true);
    expect(heldPrivately(raw('California'), FIELD, 'CA')).toBe(true);
    expect(heldPrivately(raw('Colorado'), FIELD, 'CA')).toBe(false);
  });
});
