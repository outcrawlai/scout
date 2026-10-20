import { describe, expect, test } from 'bun:test';

import { addDecimal, browserTimeCredits, compareDecimal } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import { hasRef } from '../src/actions';
import type { AxTree } from '../src/snapshot';
import { findNode } from '../src/snapshot';
import { CapLedger } from '../src/caps';
import { runAgent } from '../src/loop';
import type { AgentResult, StepTrace } from '../src/result';
import {
  circuitShouldTrip,
  classifyIrreversible,
  ExitSwitchError,
  intentFrom,
  isBrowserLost,
  mayAct,
  reacquisitionBackoffMs,
  reportOnlyResult,
  RAPID_CRASH_BREAKER_LIMIT,
  RAPID_CRASH_THRESHOLD_MS,
  type IrreversibleMark,
  type RunIntent,
  resumeNotice,
} from '../src/resume';
import { capState, harness, node, ref, refOf, testPricing, tree, VirtualClock, type Harness } from './support';

const CAPS = { steps: 8, budget: '10.00', duration: '5m' } as const;

const intentOf = (over: Partial<RunIntent> = {}): RunIntent => ({
  id: 'run-1',
  task: 'read the reference',
  memory: { goals: [], findings: [], ruledOut: [] },
  steps: [],
  used: capState(),
  irreversible: [],
  reacquisitions: 0,
  ...over,
});

const mark = (over: Partial<IrreversibleMark> = {}): IrreversibleMark => ({
  runId: 'run-1',
  step: 3,
  kind: 'order',
  action: 'click the button "Place order"',
  evidence: 'label matched',
  url: 'https://shop.example/checkout',
  at: '2026-09-08T00:00:00.000Z',
  ...over,
});

/* ------------------------------------------------------------------ *
 * The rule
 * ------------------------------------------------------------------ */

describe('the idempotency rule', () => {
  test('a run with no mark may act, and one mark makes it permanently report-only', () => {
    expect(mayAct(intentOf())).toBe(true);
    expect(mayAct(intentOf({ irreversible: [mark()] }))).toBe(false);
  });

  test('an exit switch may act only when confirmed AND after every mark; unconfirmed, on a mark, no step, or a lost browser may not', () => {
    // MUTATIONS (OC-316): every run that ever clicked a suspected commit ended
    // at its next residential exit expiry (run_…, 2026-10-02 23:58Z), though
    // the browser was alive and a page committed after the click; the
    // relaxation reaching a switch whose step read only the error the click's
    // own request met on the dying exit (unconfirmed: outcome unknown,
    // EgressReview 2026-10-03); or a switch that could have sent the act itself.
    const ended = (step?: number, confirmed = true) => ({
      provider: 'residential_a',
      url: 'https://shop.example/',
      reason: 'exit-ended' as const,
      confirmed,
      ...(step === undefined ? {} : { step }),
    });
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 })], exitSwitch: ended(20) }))).toBe(true);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 }), mark({ step: 4 })], exitSwitch: { ...ended(5), reason: 'refused' } }))).toBe(true);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 })], exitSwitch: ended(4, false) }))).toBe(false);
    const { confirmed: _unstated, ...unstated } = ended(4);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 })], exitSwitch: unstated }))).toBe(false);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 }), mark({ step: 5 })], exitSwitch: ended(5) }))).toBe(false);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 })], exitSwitch: ended() }))).toBe(false);
    expect(mayAct(intentOf({ irreversible: [mark({ step: 3 })] }))).toBe(false);
  });

  test('a resume across a switch is told every mark, and a second act of the same kind on the same site is refused before it is marked or sent', async () => {
    // MUTATIONS (OC-316, EgressReview probe 2026-10-03: order@3 "Place order",
    // switch at 20, mayAct true, notice names no mark, so the model re-buys
    // through guest checkout): the notice listing nothing; the gate letting
    // the same kind on the same host through; or refusing another kind/host.
    const orderPage = tree(node({ role: 'button', name: 'Place order' }), 'https://shop.example/checkout');
    const resumed = intentOf({
      // Within this suite's 8-step cap: the probe's order@3 / switch@20, scaled.
      irreversible: [mark({ step: 1 })],
      used: capState({ steps: 3 }),
      exitSwitch: { provider: 'residential_a', url: 'https://shop.example/', reason: 'refused', step: 3, confirmed: true },
    });
    const written: IrreversibleMark[] = [];
    const fake = harness({
      tree: orderPage,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(orderPage, 'Place order') } }
          : { action: { type: 'done', summary: 'reported the earlier order' } },
    });
    const result = await runAgent(fake.deps, {
      task: 'place the order',
      caps: CAPS,
      stepFailures: 3,
      resume: resumed,
      onIrreversible: async (mark) => void written.push(mark),
    });

    const notice = fake.prompts[0]?.notice ?? '';
    expect(notice).toContain('ALREADY DISPATCHED');
    expect(notice).toContain('step 1 (order) on https://shop.example/checkout: click the button "Place order"');
    expect(notice).toContain('Do NOT repeat');
    expect(fake.performed.filter((action) => action.type === 'click')).toEqual([]);
    expect(written).toEqual([]);
    expect(result.steps.at(-2)?.error).toContain('refused: this would be a second order act on shop.example');

    // Another site's order is not the same act: marked and sent as usual.
    const elsewhere = harness({
      tree: orderPage,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(orderPage, 'Place order') } }
          : { action: { type: 'done', summary: 'ordered' } },
    });
    await runAgent(elsewhere.deps, {
      task: 'place the order',
      caps: CAPS,
      stepFailures: 3,
      resume: { ...resumed, irreversible: [mark({ step: 1, url: 'https://other.example/checkout' })] },
      onIrreversible: async () => undefined,
    });
    expect(elsewhere.performed.filter((action) => action.type === 'click')).toHaveLength(1);
  });

  test('a carried SUSPECTED mark blocks only the same control on the same site: "Apply filters" goes, "Next" is refused', async () => {
    // MUTATION (EgressReview P2, 2026-10-03): suspected refused by kind and
    // host alone, so after a password fill a renewed, cookie-less run could
    // not click the login "Next" or filter a list on the same site.
    const signup = tree(
      node({ role: 'form', children: [node({ role: 'button', name: 'Apply filters' }), node({ role: 'button', name: 'Next' })] }),
      'https://mail.example/signup',
    );
    const written: IrreversibleMark[] = [];
    const fake = harness({
      tree: signup,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(signup, 'Apply filters') } }
          : step === 1
            ? { action: { type: 'click', ref: refOf(signup, 'Next') } }
            : { action: { type: 'done', summary: 'filtered' } },
    });
    const result = await runAgent(fake.deps, {
      task: 'sign in and filter',
      caps: CAPS,
      stepFailures: 3,
      resume: intentOf({
        irreversible: [mark({ step: 1, kind: 'suspected', action: 'click the button "Next"', url: 'https://mail.example/signup' })],
        used: capState({ steps: 3 }),
        exitSwitch: { provider: 'residential_a', url: 'https://mail.example/', reason: 'exit-ended', step: 3, confirmed: true },
      }),
      onIrreversible: async (written_) => void written.push(written_),
    });

    expect(fake.performed.filter((action) => action.type === 'click')).toHaveLength(1);
    expect(written.map((mark) => mark.action)).toEqual(['click the button "Apply filters"']);
    expect(result.steps.some((step) => step.error?.includes('refused: this would be a second suspected act on mail.example'))).toBe(true);
  });

  test('a resume past a mark opens no page, calls no model and spends nothing', async () => {
    const page = tree(node({ role: 'button', name: 'Place order' }));
    const fake = harness({
      model: () => {
        throw new Error('the model must not be asked: this run may not act');
      },
      tree: page,
    });

    const carried: StepTrace[] = [
      {
        index: 0,
        action: { type: 'navigate', url: 'https://shop.example/checkout' },
        cache: { status: 'MISS', reason: 'test' },
        elapsedMs: 10,
        snapshotHash: 'h',
        credits: '0.40',
        spent: '0.40',
        pages: 1,
        durationMs: 1_000,
        bandwidthBytes: 0,
        usage: { inputTokens: 5_331 },
        at: '2026-09-08T00:00:00.000Z',
      },
    ];
    const result = await runAgent(fake.deps, {
      task: 'place the order',
      caps: CAPS,
      stepFailures: 3,
      pricing: testPricing(),
      resume: intentOf({
        irreversible: [mark()],
        steps: carried,
        // 0.40 explicitly charged plus 4 s of browser time at a credit a minute.
        used: capState({ steps: 1, credits: '0.466667', charged: '0.40', elapsedMs: 4_000 }),
        memory: { goals: [], findings: [{ step: 0, text: 'the total is $12.00' }], ruledOut: [] },
        data: { total: '$12.00' },
      }),
    });

    // THE REFUSAL: nothing was touched. No lock, no snapshot, no model call.
    expect(fake.events).toEqual([]);
    expect(fake.performed).toEqual([]);
    expect(result.stopReason).toBe('irreversible');
    // And it REPORTED: the data, the findings and the history all came back.
    expect(result.status).toBe('partial');
    expect(result.data).toEqual({ total: '$12.00' });
    expect(result.findings).toHaveLength(1);
    expect(result.steps).toHaveLength(1);
    // Billed for what ran, not for the refusal.
    expect(result.credits).toBe('0.466667');
    expect(result.error).toContain('un-resumable');
  });

  test('the report names the kind, the step and the evidence a human can audit', () => {
    const report = reportOnlyResult(intentOf({ irreversible: [mark()] }), CAPS, testPricing());
    expect(report.error).toContain('order');
    expect(report.error).toContain('step 3');
    expect(report.error).toContain('Place order');
  });
});

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

describe('classifyIrreversible', () => {
  const ask = (
    action: Action,
    page: AxTree = tree(node({ role: 'button', name: 'Place order' })),
  ): { readonly kind: string; readonly evidence: string } | undefined =>
    classifyIrreversible({
      action,
      node: hasRef(action) ? findNode(page, action.ref) : undefined,
      tree: page,
      history: [],
    });

  test('a click on a button that places an order is marked, with the phrase as evidence', () => {
    const page = tree(node({ role: 'button', name: 'Place order' }), 'https://shop.example/cart');
    const verdict = ask({ type: 'click', ref: refOf(page, 'Place order') }, page);
    expect(verdict?.kind).toBe('order');
    expect(verdict?.evidence).toContain('place order');
  });

  test('a fill, a scroll and a navigate are never marked: a resume is re-navigation', () => {
    const page = tree(
      node({ role: 'textbox', name: 'Search', children: [] }),
      'https://shop.example/checkout',
    );
    expect(ask({ type: 'fill', ref: refOf(page, 'Search'), text: 'x' }, page)).toBeUndefined();
    expect(ask({ type: 'scroll', dy: 200 }, page)).toBeUndefined();
    expect(ask({ type: 'navigate', url: 'https://shop.example/checkout' }, page)).toBeUndefined();
  });

  test('a Back button on a checkout page is not marked; an unlabelled Continue is', () => {
    const page = tree(
      node({
        role: 'main',
        children: [node({ role: 'button', name: 'Back' }), node({ role: 'button', name: 'Continue' })],
      }),
      'https://shop.example/checkout/pay',
    );
    expect(ask({ type: 'click', ref: refOf(page, 'Back') }, page)).toBeUndefined();
    // THE FALSE-NEGATIVE CASE THIS EXISTS FOR: a `Continue` that submits
    // payment. No phrase matches, so the url is what marks it.
    expect(ask({ type: 'click', ref: refOf(page, 'Continue') }, page)?.kind).toBe('suspected');
  });

  test('a card field on the page marks any submit, whatever the button says', () => {
    const page = tree(
      node({
        role: 'main',
        children: [
          node({ role: 'textbox', name: 'Card number' }),
          node({ role: 'button', name: 'Go' }),
        ],
      }),
      // A url that says nothing, so the FIELD is the only signal left.
      'https://shop.example/step-3',
    );
    const verdict = ask({ type: 'click', ref: refOf(page, 'Go') }, page);
    expect(verdict?.kind).toBe('suspected');
    expect(verdict?.evidence).toContain('credential field');
  });

  test('typing into a sensitive field earlier in the run marks a later submit', () => {
    const page = tree(node({ role: 'button', name: 'Go' }), 'https://shop.example/step-4');
    const history: StepTrace[] = [
      {
        index: 0,
        action: { type: 'fill', ref: ref(), text: '4242424242424242' },
        observed: {
          ref: '0-1',
          description: 'fill the textbox "Card number" with "4242424242424242"',
          method: 'fill',
          xpath: '/html/body/input',
        },
        cache: { status: 'MISS', reason: 'test' },
        elapsedMs: 1,
        snapshotHash: 'h',
        credits: '0',
        spent: '0',
        pages: 0,
        durationMs: 0,
        bandwidthBytes: 0,
        usage: {},
        at: '2026-09-08T00:00:00.000Z',
      },
    ];
    const verdict = classifyIrreversible({
      action: { type: 'click', ref: refOf(page, 'Go') },
      node: page.root,
      tree: page,
      history,
    });
    expect(verdict?.kind).toBe('suspected');
    expect(verdict?.evidence).toContain('sensitive field');
    // The field, never the number: this evidence is written to a log.
    expect(verdict?.evidence).toContain('"Card number"');
    expect(verdict?.evidence).not.toContain('4242424242424242');
  });

  // jobs-apply (fleet 2026-10-20 06:54Z, run_7f6332df): after a sign-in, three
  // job-board links were marked suspected, and the drain refused the resume.
  test('after a password was typed, a plain link is not marked; a submit, a script link and a commit-worded link still are', () => {
    const site = '/t/abc/jobs';
    const page = tree(
      node({
        role: 'main',
        children: [
          node({ role: 'link', name: 'Kestrel Logistics', xpath: `//a[@href="${site}/companies/kestrel"]` }),
          node({ role: 'link', name: 'Data Analyst', xpath: `//a[@href="${site}/jobs/7044532"]` }),
          node({ role: 'link', name: 'Apply now', href: `https://jobs.example${site}/jobs/7044532/apply` }),
          node({ role: 'button', name: 'Continue', xpath: '//button[@type="submit"]' }),
          node({ role: 'link', name: 'Save job', xpath: '//a[@href="#"]' }),
          node({ role: 'link', name: 'Withdraw', xpath: '//a[@href="javascript:void(0)"]' }),
          node({ role: 'link', name: 'Buy now', xpath: `//a[@href="${site}/premium/buy"]` }),
          node({ role: 'link', name: 'Profile' }),
        ],
      }),
      'https://jobs.example/t/abc/jobs/account',
    );
    const history: StepTrace[] = [
      {
        index: 0,
        action: { type: 'fill', ref: ref(), text: 'Ember-harbour-77#' },
        observed: { ref: '0-1', description: 'fill the textbox "Password" with "Ember-harbour-77#"', method: 'fill', xpath: '//*[@id="f-password"]' },
        cache: { status: 'MISS', reason: 'test' },
        elapsedMs: 1,
        snapshotHash: 'h',
        credits: '0',
        spent: '0',
        pages: 0,
        durationMs: 0,
        bandwidthBytes: 0,
        usage: {},
        at: '2026-10-20T06:52:40.000Z',
      },
    ];
    const verdictFor = (name: string) => {
      const target = refOf(page, name);
      return classifyIrreversible({ action: { type: 'click', ref: target }, node: findNode(page, target), tree: page, history });
    };
    expect(verdictFor('Kestrel Logistics')).toBeUndefined();
    expect(verdictFor('Data Analyst')).toBeUndefined();
    expect(verdictFor('Apply now')).toBeUndefined();
    expect(verdictFor('Continue')?.kind).toBe('suspected');
    expect(verdictFor('Save job')?.kind).toBe('suspected');
    expect(verdictFor('Withdraw')?.kind).toBe('suspected');
    expect(verdictFor('Buy now')?.kind).toBe('order');
    // A link whose destination is not known (a positional xpath) is judged as before.
    expect(verdictFor('Profile')?.kind).toBe('suspected');
  });

  test('declining a priced offer is not a payment; the same decline on a checkout is still marked', () => {
    // Measured: Honey Birdette's discount popup closes on this label, and a
    // "never pay" rule refused it, so 2 of 3 live checkouts ended on a popup.
    const product = tree(
      node({ role: 'button', name: "NO, THANKS I'LL PAY FULL PRICE" }),
      'https://shop.example/products/gel',
    );
    expect(ask({ type: 'click', ref: refOf(product, "NO, THANKS I'LL PAY FULL PRICE") }, product)).toBeUndefined();
    const checkout = tree(node({ role: 'button', name: 'No thanks, pay now' }), 'https://shop.example/checkouts/cn/1');
    expect(ask({ type: 'click', ref: refOf(checkout, 'No thanks, pay now') }, checkout)?.kind).toBe('suspected');
  });

  test('entering checkout is not a commit, even under a heading that says order summary', () => {
    // Measured: the cart's CHECKOUT button was refused because the cart's
    // heading reads "ORDER SUMMARY". The button that pays is still marked.
    const cart = tree(
      node({
        role: 'main',
        children: [
          node({ role: 'heading', name: 'ORDER SUMMARY' }),
          node({ role: 'button', name: 'CHECKOUT' }),
          node({ role: 'button', name: 'Pay now' }),
        ],
      }),
      'https://shop.example/cart',
    );
    expect(ask({ type: 'click', ref: refOf(cart, 'CHECKOUT') }, cart)).toBeUndefined();
    expect(ask({ type: 'click', ref: refOf(cart, 'Pay now') }, cart)?.kind).toBe('payment');
  });

  test("a footer's payment-methods heading does not make the controls above it commits (smythstoys, run_…)", () => {
    // Production 2026-10-06, Stealth Bench run 5: `<h4>Our payment methods</h4>`
    // is the last heading on every smythstoys.com page, in the footer, and it
    // marked all eight dispatches of a browse-only run, so the run's next exit
    // renewal refused to resume. The fork's tree has no landmarks; the
    // heading's place after the control is the only structural signal.
    const home = tree(
      node({
        role: 'RootWebArea',
        name: 'Smyths Toys',
        children: [
          node({ role: 'textbox', name: 'Search', state: { focused: true } }),
          node({ role: 'link', name: 'Gift Finder - Gift Finder' }),
          node({ role: 'heading', name: 'Top Toys' }),
          node({ role: 'link', name: 'Beckton' }),
          node({ role: 'heading', name: 'Our payment methods' }),
          node({ role: 'link', name: 'Contact us' }),
        ],
      }),
      'https://www.smythstoys.com/uk/en-gb/',
    );
    expect(ask({ type: 'click', ref: refOf(home, 'Gift Finder - Gift Finder') }, home)).toBeUndefined();
    expect(ask({ type: 'click', ref: refOf(home, 'Beckton') }, home)).toBeUndefined();
    expect(ask({ type: 'press', key: 'Enter', ref: refOf(home, 'Search') }, home)).toBeUndefined();
    // Unaimed Enter lands on the page's focus, the search box above the footer.
    expect(ask({ type: 'press', key: 'Enter' }, home)).toBeUndefined();
    // A control the heading DOES title is still marked: fail toward marking.
    expect(ask({ type: 'click', ref: refOf(home, 'Contact us') }, home)?.evidence).toContain('Our payment methods');
  });

  test('a commit control under a payment heading on an opaque url is still marked, and so is Enter with no focus to place it', () => {
    // The case the heading rule exists for: no url signal, no card field yet,
    // and a button whose label names nothing.
    const step = tree(
      node({
        role: 'RootWebArea',
        children: [
          node({ role: 'link', name: 'Help' }),
          node({ role: 'heading', name: 'Payment' }),
          node({ role: 'radio', name: 'PayPal' }),
          node({ role: 'button', name: 'Continue' }),
        ],
      }),
      'https://shop.example/s/8f3a',
    );
    expect(ask({ type: 'click', ref: refOf(step, 'Continue') }, step)?.evidence).toContain('"Payment"');
    expect(ask({ type: 'press', key: 'Enter' }, step)?.kind).toBe('suspected');
    expect(ask({ type: 'click', ref: refOf(step, 'Help') }, step)).toBeUndefined();
  });

  test('choosing a shipping option is not a commit; Enter in a field after the card is typed is', () => {
    const page = tree(
      node({
        role: 'main',
        children: [
          node({ role: 'textbox', name: 'Card number', children: [] }),
          node({ role: 'radio', name: 'Standard shipping' }),
          node({ role: 'textbox', name: 'ZIP code', children: [] }),
        ],
      }),
      'https://shop.example/checkouts/cn/1',
    );
    // A radio changes what the form holds and submits nothing.
    expect(ask({ type: 'click', ref: refOf(page, 'Standard shipping') }, page)).toBeUndefined();
    // Enter is implicit submission, whatever field it lands on.
    expect(ask({ type: 'press', key: 'Enter', ref: refOf(page, 'ZIP code') }, page)?.kind).toBe('suspected');
  });

  test('Space on a button activates it, so it is judged as the click it is; in a field it is a space', () => {
    const page = tree(
      node({
        role: 'main',
        children: [node({ role: 'textbox', name: 'Gift note', children: [] }), node({ role: 'button', name: 'Pay now' })],
      }),
      'https://shop.example/step-3',
    );
    for (const key of [' ', 'Space', 'Spacebar']) {
      expect(ask({ type: 'press', key, ref: refOf(page, 'Pay now') }, page)?.kind).toBe('payment');
      expect(ask({ type: 'press', key, ref: refOf(page, 'Gift note') }, page)).toBeUndefined();
    }
    // Focus the step did not name may be that button: judged on the page, as Enter is.
    const checkout = tree(node({ role: 'button', name: 'Continue' }), 'https://shop.example/checkout/pay');
    expect(ask({ type: 'press', key: ' ' }, checkout)?.kind).toBe('suspected');
  });
});

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe('the write-ahead mark', () => {
  const orderPage = tree(
    node({ role: 'button', name: 'Place order' }),
    'https://shop.example/checkout',
  );

  test('the mark is committed before the action is dispatched', async () => {
    const order: string[] = [];
    const fake = harness({
      tree: orderPage,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(orderPage, 'Place order') } }
          : { action: { type: 'done', summary: 'ordered' } },
      perform: () => {
        order.push('dispatch');
      },
    });

    await runAgent(fake.deps, {
      task: 'place the order',
      caps: CAPS,
      stepFailures: 3,
      id: 'run-9',
      onIrreversible: async (written) => {
        order.push(`mark:${written.kind}`);
        expect(written.runId).toBe('run-9');
        expect(written.step).toBe(0);
      },
    });

    expect(order).toEqual(['mark:order', 'dispatch']);
  });

  test('a sink that cannot commit CANCELS the dispatch', async () => {
    const fake = harness({
      tree: orderPage,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(orderPage, 'Place order') } }
          : { action: { type: 'fail', reason: 'cannot order' } },
    });

    const result = await runAgent(fake.deps, {
      task: 'place the order',
      caps: CAPS,
      stepFailures: 3,
      onIrreversible: async () => {
        throw new Error('disk full');
      },
    });

    // The click never happened. An irreversible act nobody could record is
    // exactly the double charge the mark exists to prevent.
    expect(fake.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('disk full');
  });

  test('with no sink bound nothing is marked and nothing is gated', async () => {
    const fake = harness({
      tree: orderPage,
      model: (prompt, step) =>
        step === 0
          ? { action: { type: 'click', ref: refOf(orderPage, 'Place order') } }
          : { action: { type: 'done', summary: 'ordered' } },
    });
    await runAgent(fake.deps, { task: 'place the order', caps: CAPS, stepFailures: 3 });
    expect(fake.performed).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Losing a browser
 * ------------------------------------------------------------------ */

describe('a lost browser', () => {
  test('is told apart from a step that was merely wrong', () => {
    expect(isBrowserLost(new Error('the CDP connection closed: code 1006: Connection ended'))).toBe(
      true,
    );
    expect(isBrowserLost(new Error('Session with given id not found'))).toBe(true);
    expect(isBrowserLost(new AggregateError([new Error('Target closed')]))).toBe(true);
    // A wrong reference and a held command are NOT a dead browser: the first is
    // recovered by the next prompt, the second by waiting.
    expect(isBrowserLost(new Error('model chose an unusable action: no node 0:12'))).toBe(false);
    expect(isBrowserLost(new Error('Outcrawl.lock did not answer within 30000ms'))).toBe(false);
  });

  test('stops the run at once instead of spending the failure tolerance on a dead socket', async () => {
    let models = 0;
    const fake = harness({
      model: (prompt, step) => {
        models += 1;
        return step === 0
          ? { action: { type: 'scroll', dy: 100 } }
          : { action: { type: 'scroll', dy: 200 } };
      },
      perform: (action) => {
        if (action.type === 'scroll' && action.dy === 200) {
          throw new Error('the CDP connection closed: code 1006: Connection ended');
        }
      },
    });

    const result = await runAgent(fake.deps, {
      task: 'read the page',
      caps: CAPS,
      // Three would be absorbed, and three model calls at a socket that no
      // longer exists is what this branch refuses to pay for.
      stepFailures: 3,
      onStep: () => {},
    });

    expect(result.browserLost).toContain('CDP connection closed');
    expect(result.stopReason).toBe('error');
    expect(result.stepsUsed).toBe(2);
    expect(models).toBe(2);
  });

  /**
   * A SOCKET THAT DIES DIES FOR EVERY CALL, not only for the one that noticed.
   * Measured in production 2026-09-24 05:44-05:47Z: six runs lost their CDP
   * connection (`code 1009: Message too big`), the step recorded it, and every
   * one of them still ended `failed` with the raw `CdpClosedError` and zero
   * `agent.browser_lost` lines in the fleet log, because the bandwidth read the
   * loop takes after it stops went to the same dead socket and threw past the
   * result. The resume that exists for exactly this never ran.
   */
  const deadSocket = (): { fake: Harness; bandwidth: () => Promise<number> } => {
    let dead = false;
    const die = (): void => {
      if (dead) {
        throw new Error('the CDP connection closed: code 1009: Message too big');
      }
    };
    const fake = harness({
      model: (_prompt, step) => ({ action: { type: 'scroll', dy: 100 + step } }),
      snapshot: (call) => {
        die();
        return tree(node({ role: 'button', name: `b${String(call)}` }));
      },
      perform: (action) => {
        if (action.type === 'scroll' && action.dy === 101) {
          dead = true;
        }
        die();
      },
      lock: die,
      unlock: die,
    });
    return {
      fake,
      bandwidth: async () => {
        die();
        return 1_000;
      },
    };
  };

  test('a bandwidth read at the dead socket hands back the lost browser instead of throwing past it', async () => {
    const { fake, bandwidth } = deadSocket();
    const result = await runAgent(
      { ...fake.deps, bandwidthBytes: bandwidth },
      { task: 'read the page', caps: CAPS, stepFailures: 3, onStep: () => {} },
    );

    expect(result.browserLost).toContain('1009');
    expect(result.stopReason).toBe('error');
    expect(result.stepsUsed).toBe(2);
  });

  test('a socket found dead by the per-step bandwidth read is a lost browser too', async () => {
    let dead = false;
    const fake = harness({
      model: (_prompt, step) => ({ action: { type: 'scroll', dy: 100 + step } }),
      perform: () => {
        // The step completes; the socket goes between steps.
        dead = true;
      },
    });
    const result = await runAgent(
      {
        ...fake.deps,
        bandwidthBytes: async () => {
          if (dead) {
            throw new Error('the CDP connection closed: code 1009: Message too big');
          }
          return 0;
        },
      },
      { task: 'read the page', caps: CAPS, stepFailures: 3, onStep: () => {} },
    );

    expect(result.browserLost).toContain('1009');
    expect(result.stepsUsed).toBe(1);
  });

  test('a bandwidth read that fails for any other reason still fails loudly', async () => {
    const fake = harness({ model: () => ({ action: { type: 'done', summary: 'ok' } }) });
    await expect(
      runAgent(
        {
          ...fake.deps,
          bandwidthBytes: async () => {
            throw new TypeError('a programming error, not a socket');
          },
        },
        { task: 'read the page', caps: CAPS, stepFailures: 3, onStep: () => {} },
      ),
    ).rejects.toThrow('a programming error');
  });
});

/* ------------------------------------------------------------------ *
 * Resuming
 * ------------------------------------------------------------------ */

describe('a resumed run', () => {
  const carried: StepTrace[] = [
    {
      index: 0,
      action: { type: 'navigate', url: 'https://shop.example/' },
      cache: { status: 'MISS', reason: 'test' },
      elapsedMs: 10,
      snapshotHash: 'h',
      credits: '1.50',
      spent: '1.50',
      pages: 1,
      durationMs: 1_000,
      bandwidthBytes: 0,
      usage: { inputTokens: 5_331 },
      at: '2026-09-08T00:00:00.000Z',
    },
  ];

  test('continues the ceilings the customer set instead of being handed a second one', () => {
    const clock = new VirtualClock();
    const ledger = new CapLedger(
      { steps: 10, budget: '1.60', duration: '10m' },
      clock,
      // What the previous attempt's row held. `charged` is what the
      // constructor seeds; `credits` is the total, and it is read by
      // `GoalLedger` rather than by the constructor — see below for why that
      // split has to exist.
      capState({ steps: 7, credits: '1.50', modelCostUsd: '0.01', elapsedMs: 30_000 }),
      testPricing(),
    );
    expect(ledger.steps).toBe(7);
    // A cent of model usage at the test tier (1.00) and thirty seconds of
    // browser time (0.5) a previous attempt already spent. The seed moves the
    // ledger's own start backwards and carries the model dollars, so the
    // resumed run continues the customer's ceiling in all three currencies
    // instead of being handed a second one.
    expect(ledger.credits).toBe('1.50');
    expect(ledger.elapsedMs()).toBe(30_000);
    expect(ledger.tripped()).toBeUndefined();
    ledger.charge('0.10');
    expect(ledger.tripped()).toBe('budget');
  });

  test('a resume prices its carried time and model usage ONCE, not twice', () => {
    // The trap in seeding a priced ledger, and the whole reason `CapState`
    // carries `charged` beside `credits`. `elapsedMs` is applied by moving the
    // start backwards and `modelCostUsd` is priced again, so those terms
    // already cover the previous attempt — and `credits` is that same spend
    // expressed as money. A constructor that seeded the charge from `credits`
    // would add it a second time, and a customer whose browser died would be
    // billed twice for one set of minutes and stopped at half their ceiling.
    const seeded = new CapLedger(
      { steps: 10, budget: '99.00', duration: '10m' },
      new VirtualClock(),
      capState({ steps: 1, credits: '1.50', modelCostUsd: '0.01', elapsedMs: 30_000 }),
      testPricing(),
    );
    expect(seeded.credits).toBe('1.50');

    // And the part that is genuinely an explicit charge still arrives, added
    // on top of the carried spend rather than instead of it.
    const withCharge = new CapLedger(
      { steps: 10, budget: '99.00', duration: '10m' },
      new VirtualClock(),
      capState({ steps: 1, credits: '1.75', charged: '0.25', modelCostUsd: '0.01', elapsedMs: 30_000 }),
      testPricing(),
    );
    expect(withCharge.credits).toBe('1.75');
  });

  test('a resumed run is priced at the plan it started under, whatever the resuming request says', () => {
    const ledger = new CapLedger(
      { steps: 10, budget: '99.00', duration: '10m' },
      new VirtualClock(),
      capState({ steps: 1, modelCostUsd: '0.01', plan: 'double' }),
      testPricing({ plan: 'test', byok: false }),
    );
    const pricing = testPricing();
    expect(ledger.pricing.model).toEqual({ plan: 'double', byok: false });
    expect(ledger.credits).toBe(pricing.modelCredits('0.01', { plan: 'double', byok: false }));
    expect(ledger.credits).not.toBe(pricing.modelCredits('0.01', { plan: 'test', byok: false }));
  });

  test('a resumed run does not get a fresh bandwidth or model allowance', () => {
    // A re-acquired run's new browser starts its byte counter at zero and a
    // new machine's model client starts its cost ledger at zero — so what
    // every earlier attempt spent has to travel in `CapState.bandwidthBytes`
    // and `CapState.modelCostUsd`, or the ceiling counts it once while the
    // customer is never billed for it at all. Pages travel too, reported and
    // not priced.
    let attemptUsd = '0';
    const ledger = new CapLedger(
      { steps: 10, budget: '99.00', duration: '10m' },
      new VirtualClock(),
      capState({ steps: 4, credits: '9.000000', pages: 3, bandwidthBytes: 4_000_000, modelCostUsd: '0.01' }),
      testPricing(),
      undefined,
      undefined,
      () => attemptUsd,
    );
    expect(ledger.pages).toBe(3);
    expect(ledger.bandwidthBytes).toBe(4_000_000);
    // model (1.00) + bandwidth (4,000,000 x 0.000002 = 8), scale 6.
    expect(ledger.credits).toBe('9.000000');

    // This attempt's own spend adds to what was carried: the SUM, not the
    // newer figure alone.
    attemptUsd = '0.02';
    expect(ledger.modelCostUsd).toBe('0.03');
  });

  test('keeps its findings and its history, and its step indices are monotonic', async () => {
    const fake = harness({
      model: () => ({ action: { type: 'done', summary: 'the reference is FSC-7741' } }),
    });
    const result = await runAgent(fake.deps, {
      task: 'read the reference',
      caps: CAPS,
      stepFailures: 3,
      pricing: testPricing(),
      resume: intentOf({
        steps: carried,
        used: capState({ steps: 1, credits: '1.50', charged: '1.50', elapsedMs: 12_000 }),
        memory: {
          goals: [],
          findings: [{ step: 0, text: 'the catalogue is at /catalogue' }],
          ruledOut: [{ step: 0, text: 'the search box returns nothing' }],
        },
      }),
    });

    expect(result.stepsUsed).toBe(2);
    expect(result.steps[1]?.index).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.ruledOut).toHaveLength(1);
    // The credits of both browsers, on one bill — and that includes both
    // browsers' TIME. 1.50 charged by the dead attempt and carried in
    // `charged`, plus 12.25 s of run time at the published credit a minute:
    // the 12 s the first attempt spent, seeded by moving this ledger's start
    // backwards, and the 250 ms this attempt's settle spent. A resume that
    // priced only its own attempt would hand the customer a fresh ceiling.
    expect(result.credits).toBe('1.704167');
    // And the duration covers the run rather than the attempt.
    expect(result.durationMs).toBeGreaterThanOrEqual(12_000);
  });

  test('reports every attempt\u2019s tokens and subscription calls, not the last attempt\u2019s', async () => {
    // MEASURED BEFORE THE FIX (a fleet Mac, 2026-10-02, run_…): handed to a
    // new machine after 13 steps, the run reported 18,140 input tokens of the
    // 138,845 its steps recorded, and 3 subscription calls of 16.
    const fake = harness({
      model: () => ({ action: { type: 'done', summary: 'the reference is FSC-7741' }, usage: { inputTokens: 200 } }),
    });
    const result = await runAgent(
      { ...fake.deps, subscriptionCalls: () => 3 },
      {
        task: 'read the reference',
        caps: CAPS,
        stepFailures: 3,
        resume: intentOf({ steps: carried, used: capState({ steps: 1, elapsedMs: 1, subscriptionCalls: 13 }) }),
      },
    );

    expect(result.usage.inputTokens).toBe(5_531);
    expect(result.subscriptionCalls).toBe(16);
    // On the step, so a second hand-off resumes from 16 and not from 13.
    expect(result.steps.at(-1)?.subscriptionCalls).toBe(16);
    expect(intentFrom(intentOf({}), result, [], false, 0, 0).used.subscriptionCalls).toBe(16);
  });

  test('is told the page is gone, once, before it is asked for anything', async () => {
    const fake = harness({
      model: () => ({ action: { type: 'done', summary: 'done' } }),
    });
    await runAgent(fake.deps, {
      task: 'read the reference',
      caps: CAPS,
      stepFailures: 3,
      pricing: testPricing(),
      resume: intentOf({
        steps: carried,
        used: capState({ steps: 1, elapsedMs: 1 }),
      }),
    });
    const first = fake.prompts[0];
    expect(first?.notice).toContain('RESUMED on a fresh browser');
    expect(first?.text).toContain('do not re-read a fact that is already in your findings');
  });

  test('intentFrom folds a dead attempt into the intent the next one carries', () => {
    const previous = intentOf({ reacquisitions: 0 });
    const dead: AgentResult = {
      id: 'run-1',
      status: 'partial',
      data: { reference: 'FSC-7741' },
      steps: carried,
      stepsUsed: 1,
      stopReason: 'error',
      usage: {},
      credits: '1.50',
      charged: '1.50',
      durationMs: 12_000,
      parkedMs: 5_000,
      modelCostUsd: '0.01',
      billedModelCostUsd: '0.01',
      pricing: { plan: 'builder', byok: false },
      goals: [],
      findings: [{ step: 0, text: 'a fact' }],
      ruledOut: [],
      browserLost: 'the CDP connection closed',
    };
    // `pages: 2` is the host's running total across every browser this run has
    // held, which is where it has to come from: the dead attempt's tab set is
    // already disposed and the survivor knows only its own. `bandwidthBytes:
    // 4_096_000` on the identical terms.
    const next = intentFrom(previous, dead, [mark()], true, 2, 4_096_000);
    expect(next.used).toEqual({
      steps: 1,
      credits: '1.50',
      charged: '1.50',
      pages: 2,
      bandwidthBytes: 4_096_000,
      modelCostUsd: '0.01',
      plan: 'builder',
      byok: false,
      elapsedMs: 12_000,
      parkedMs: 5_000,
    });
    expect(next.data).toEqual({ reference: 'FSC-7741' });
    expect(next.memory.findings).toHaveLength(1);
    expect(next.reacquisitions).toBe(1);
    // And it is now un-resumable, which is what the supervisor reads.
    expect(mayAct(next)).toBe(false);
  });

  test('a park on an earlier attempt stays off caps.duration, and stays on the bill', () => {
    // Asked a question, waited forty minutes for the answer, worked two, then
    // lost the browser. The duration clock read two minutes before the loss and
    // must read two minutes after it: a run that asked correctly must not stop
    // at max-duration because its browser died later.
    const caps = { budget: '500.00', duration: '30m' };
    const clock = new VirtualClock();
    const first = new CapLedger(caps, clock, undefined, testPricing());
    const unpark = first.park();
    clock.advance(40 * 60_000);
    unpark();
    clock.advance(2 * 60_000);
    expect(first.elapsedMs()).toBe(120_000);

    const resumed = new CapLedger(caps, new VirtualClock(), first.state, testPricing());
    expect(resumed.elapsedMs()).toBe(120_000);
    expect(resumed.tripped()).toBeUndefined();
    // Every open minute is still billed: forty-two, at a credit a minute.
    const billing = resumed.billing();
    expect(billing.billedMs).toBe(42 * 60_000);
    expect(billing.credits).toBe(browserTimeCredits(42 * 60_000, testPricing().creditsPerMinute));
  });

  test('a report-only resume bills model usage no further than the budget funds', () => {
    // The step that tripped the budget was recorded, then the machine was lost
    // before the run settled: the intent carries the MEASURED model USD, which
    // is more than the budget paid for (0.02 USD is 2 credits at the test tier).
    const pricing = testPricing();
    const report = reportOnlyResult(
      intentOf({
        irreversible: [mark()],
        used: capState({ steps: 3, credits: '2.50', modelCostUsd: '0.02', elapsedMs: 60_000 }),
      }),
      { budget: '2.50' },
      pricing,
    );
    expect(compareDecimal(report.billedModelCostUsd, report.modelCostUsd)).toBeLessThan(0);
    expect(compareDecimal(report.credits, '2.50')).toBeLessThanOrEqual(0);
    // And the credits are exactly the billed quantities priced, so the rows
    // the settlement meters from them sum to what agent.get reports.
    const priced = addDecimal(
      pricing.modelCredits(report.billedModelCostUsd, pricing.model),
      browserTimeCredits(report.billedMs ?? report.durationMs, pricing.creditsPerMinute),
    );
    expect(compareDecimal(priced, report.credits)).toBe(0);
  });
});

describe('an exit that refuses a destination', () => {
  test('ends the attempt with exitSwitch, not browserLost, and spends no failure tolerance', async () => {
    // MUTATION: treating it as a step failure (the run burns its tolerance
    // re-meeting the same refusal) or as a lost browser (backoff, breaker).
    let models = 0;
    const fake = harness({
      model: () => {
        models += 1;
        return { action: { type: 'navigate', url: 'https://www.amazon.in/' } };
      },
      perform: (action) => {
        if (action.type === 'navigate') {
          throw new ExitSwitchError({ provider: 'residential_b', url: 'https://www.amazon.in/', reason: 'refused' }, 'residential_b refuses www.amazon.in');
        }
      },
    });
    const result = await runAgent(fake.deps, { task: 'price a kettle', caps: CAPS, stepFailures: 3, onStep: () => {} });
    // `step`: the loop's index of the step whose navigation was refused (OC-316).
    expect(result.exitSwitch).toEqual({ provider: 'residential_b', url: 'https://www.amazon.in/', reason: 'refused', step: 0 });
    expect(result.browserLost).toBeUndefined();
    expect(result.stopReason).toBe('error');
    expect(models).toBe(1);
  });

  test('a fanned navigate on another tab that switches the exit ends the attempt the same way', async () => {
    // MUTATION: the fan folding every element failure into a trace, so a
    // switch the host already prepared (exit retired, renewal recorded) is
    // swallowed and the run carries on through the exit it was leaving.
    let models = 0;
    const fake = harness({
      tabs: [
        { id: 't1', url: 'https://a.test/' },
        { id: 't2', url: 'https://b.test/' },
      ],
      model: () => {
        models += 1;
        return models === 1
          ? { action: { type: 'navigate', url: 'https://a.test/next' }, envelope: { also: [{ tab: 't2', type: 'navigate', url: 'https://www.amazon.in/' }] } }
          : { action: { type: 'done', summary: 'priced' } };
      },
    });
    const tabs = fake.deps.tabs;
    if (tabs === undefined) throw new Error('the harness bound no tab control');
    const deps = {
      ...fake.deps,
      tabs: {
        ...tabs,
        page: (id: string) => ({
          id,
          snapshot: () => tree(node({ role: 'RootWebArea', name: 'b' }), 'https://b.test/'),
          lock: () => undefined,
          unlock: () => undefined,
          perform: (action: { readonly type: string }) => {
            if (action.type === 'navigate') {
              throw new ExitSwitchError({ provider: 'residential_a', url: 'https://www.amazon.in/', reason: 'exit-ended' }, 'the exit stopped answering');
            }
            return {};
          },
          extract: () => {
            throw new Error('nothing is extracted here');
          },
        }),
      },
    };
    const result = await runAgent(deps, { task: 'price a kettle', caps: CAPS, stepFailures: 3, parallel: 1, onStep: () => {} });
    expect(result.exitSwitch).toEqual({ provider: 'residential_a', url: 'https://www.amazon.in/', reason: 'exit-ended', step: 0 });
    expect(result.stopReason).toBe('error');
    expect(models).toBe(1);
  });

  test('the intent carries it without counting a reacquisition, and the resume tells the model where to go again', () => {
    const moved: AgentResult = {
      id: 'run-1',
      status: 'partial',
      data: undefined,
      steps: [],
      stepsUsed: 1,
      stopReason: 'error',
      usage: {},
      credits: '0.10',
      charged: '0.10',
      modelCostUsd: '0',
      billedModelCostUsd: '0',
      pricing: { plan: 'builder', byok: false },
      parkedMs: 0,
      durationMs: 3_000,
      goals: [],
      findings: [],
      ruledOut: [],
      exitSwitch: { provider: 'residential_b', url: 'https://www.amazon.in/', reason: 'refused' },
    };
    const next = intentFrom(intentOf({ reacquisitions: 0 }), moved, [], false, 1, 0);
    expect(next.reacquisitions).toBe(0);
    expect(resumeNotice(next)).toContain('Navigate to https://www.amazon.in/ again');
    expect(resumeNotice(next)).not.toContain('lost');
    // The next attempt that ends normally drops it.
    const { exitSwitch: _dropped, ...plain } = moved;
    expect(intentFrom(next, plain, [], false, 1, 0).exitSwitch).toBeUndefined();
  });
});

describe('an exit whose session ended under a navigation (run_…)', () => {
  const renewedIntent = (): RunIntent =>
    intentOf({
      used: capState({ steps: 2, elapsedMs: 1 }),
      exitSwitch: { provider: 'residential_a', url: 'https://www.search.example/', reason: 'exit-ended' },
    });

  test('the navigation is sent once more on the fresh exit before the first step, and the model is told', async () => {
    // MUTATION: leaving the retry to the model (it arrives on a blank page
    // with a notice), or dropping the exit change from the notice.
    const fake = harness({ model: () => ({ action: { type: 'done', summary: 'done' } }) });

    await runAgent(fake.deps, { task: 'search the web', caps: CAPS, stepFailures: 3, resume: renewedIntent() });

    expect(fake.performed[0]).toEqual({ type: 'navigate', url: 'https://www.search.example/' });
    const notice = fake.prompts[0]?.notice ?? '';
    expect(notice).toContain('network exit CHANGED at step 2');
    expect(notice).toContain('different IP address');
    expect(notice).toContain('https://www.search.example/ was loaded again on the new exit');
    expect(notice).not.toMatch(/residential_a/i);
  });

  test('a renewal the site forced says the site refused the old address, not that the exit closed', async () => {
    // MUTATION: `cause` ignored, so the model reads that a live exit closed.
    // Production 2026-10-06: homedepot's Akamai edge denied one exit 4 of 4.
    const fake = harness({ model: () => ({ action: { type: 'done', summary: 'done' } }) });
    const resume = intentOf({
      used: capState({ steps: 2, elapsedMs: 1 }),
      exitSwitch: { provider: 'residential_a', url: 'https://www.homedepot.com/', reason: 'exit-ended', cause: 'site-refused' },
    });

    await runAgent(fake.deps, { task: 'find a ceiling fan', caps: CAPS, stepFailures: 3, resume });

    expect(fake.performed[0]).toEqual({ type: 'navigate', url: 'https://www.homedepot.com/' });
    const notice = fake.prompts[0]?.notice ?? '';
    expect(notice).toContain('the site refused the address it had');
    expect(notice).not.toContain('closed');
  });

  test('a retry that fails too is the model\u2019s to read, not the end of the run', async () => {
    let navigations = 0;
    const fake = harness({
      model: () => ({ action: { type: 'done', summary: 'done' } }),
      perform: (action) => {
        if (action.type === 'navigate') {
          navigations += 1;
          throw new Error('navigate(https://www.search.example/) failed: net::ERR_TUNNEL_CONNECTION_FAILED');
        }
      },
    });

    const result = await runAgent(fake.deps, { task: 'search the web', caps: CAPS, stepFailures: 3, resume: renewedIntent() });

    expect(navigations).toBe(1);
    expect(fake.prompts[0]?.notice).toContain('Loading https://www.search.example/ again on the new exit failed too');
    expect(result.exitSwitch).toBeUndefined();
    expect(result.stopReason).not.toBe('error');
  });

  test('a run already at a cap is not sent the retry: the caps end it first', async () => {
    // MUTATION: the retry sent ahead of the loop's cap checks (ByoProxyReview
    // P3), so a run with nothing left still loads, and pays for, one page.
    const fake = harness({ model: () => ({ action: { type: 'done', summary: 'done' } }) });

    const result = await runAgent(fake.deps, {
      task: 'search the web',
      caps: CAPS,
      stepFailures: 3,
      resume: { ...renewedIntent(), used: capState({ steps: CAPS.steps, elapsedMs: 1 }) },
    });

    expect(fake.performed).toEqual([]);
    expect(result.stopReason).toBe('max-steps');
  });

  test('a provider move is still left to the model: nothing is sent before the first step', async () => {
    const fake = harness({ model: () => ({ action: { type: 'done', summary: 'done' } }) });

    await runAgent(fake.deps, {
      task: 'price a kettle',
      caps: CAPS,
      stepFailures: 3,
      resume: intentOf({ exitSwitch: { provider: 'residential_b', url: 'https://www.amazon.in/', reason: 'refused' } }),
    });

    expect(fake.performed).toEqual([]);
    expect(fake.prompts[0]?.notice).toContain('Navigate to https://www.amazon.in/ again');
  });
});
/* ------------------------------------------------------------------ *
 * Losing it again and again: unlimited reacquisition, backoff and the
 * circuit breaker that replaces MAX_REACQUISITIONS as the real bound.
 * ------------------------------------------------------------------ */

describe('reacquisitionBackoffMs', () => {
  test('the first loss waits, it does not loop straight back in', () => {
    // Zero reacquisitions (no loss yet) needs no delay; the first LOSS is
    // reacquisitions=1, and it still backs off -- there is no free retry.
    expect(reacquisitionBackoffMs(0)).toBe(0);
    expect(reacquisitionBackoffMs(1)).toBeGreaterThan(0);
  });

  test('doubles from one second up to a one-minute ceiling', () => {
    expect(reacquisitionBackoffMs(1)).toBe(1_000);
    expect(reacquisitionBackoffMs(2)).toBe(2_000);
    expect(reacquisitionBackoffMs(3)).toBe(4_000);
    expect(reacquisitionBackoffMs(4)).toBe(8_000);
    expect(reacquisitionBackoffMs(5)).toBe(16_000);
    expect(reacquisitionBackoffMs(6)).toBe(32_000);
    expect(reacquisitionBackoffMs(7)).toBe(60_000);
  });

  test('never exceeds the ceiling, however long the run has been bouncing', () => {
    expect(reacquisitionBackoffMs(8)).toBe(60_000);
    expect(reacquisitionBackoffMs(50)).toBe(60_000);
    // A week-long marathon can lose hundreds of browsers; this must stay a
    // plain number and not overflow or go negative on a large exponent.
    expect(reacquisitionBackoffMs(500)).toBe(60_000);
  });

  test('is a pure function of the count alone: same input, same answer', () => {
    expect(reacquisitionBackoffMs(4)).toBe(reacquisitionBackoffMs(4));
  });
});

describe('circuitShouldTrip', () => {
  test('never trips on ordinary infrastructure churn: a run may lose many browsers that each did real work', () => {
    // Ten losses, every one after minutes of real running -- exactly what a
    // 7-day marathon is expected to look like. MAX_REACQUISITIONS would have
    // stopped this run at its third loss; the breaker must not.
    const longLivedLosses = Array.from({ length: 10 }, () => 20 * 60_000);
    expect(circuitShouldTrip(longLivedLosses)).toBe(false);
  });

  test('does not trip below the streak length, however fast those attempts died', () => {
    expect(circuitShouldTrip([])).toBe(false);
    expect(circuitShouldTrip([100])).toBe(false);
    expect(
      circuitShouldTrip(Array.from({ length: RAPID_CRASH_BREAKER_LIMIT - 1 }, () => 100)),
    ).toBe(false);
  });

  test('trips once the most recent streak is all rapid', () => {
    const rapid = Array.from({ length: RAPID_CRASH_BREAKER_LIMIT }, () => RAPID_CRASH_THRESHOLD_MS - 1);
    expect(circuitShouldTrip(rapid)).toBe(true);
  });

  test('one attempt in the streak surviving the threshold is enough to hold it open', () => {
    const almostRapid = [
      ...Array.from({ length: RAPID_CRASH_BREAKER_LIMIT - 1 }, () => 1),
      RAPID_CRASH_THRESHOLD_MS, // exactly at the line: survived, not rapid
    ];
    expect(circuitShouldTrip(almostRapid)).toBe(false);
  });

  test('only the TAIL is read: an old rapid streak the run has since recovered from does not trip it', () => {
    const recovered = [
      ...Array.from({ length: RAPID_CRASH_BREAKER_LIMIT + 2 }, () => 1), // a bad start
      ...Array.from({ length: RAPID_CRASH_BREAKER_LIMIT }, () => 30 * 60_000), // then fine for a long stretch
    ];
    expect(circuitShouldTrip(recovered)).toBe(false);
  });

  test('a long healthy run that starts crashing at the very end still trips', () => {
    const degrading = [
      ...Array.from({ length: 20 }, () => 30 * 60_000), // healthy for hours
      ...Array.from({ length: RAPID_CRASH_BREAKER_LIMIT }, () => 500), // then dies immediately, repeatedly
    ];
    expect(circuitShouldTrip(degrading)).toBe(true);
  });
});
