/**
 * THE LOOP WITH THE OUTCOME CHECK ON.
 *
 * `verify.test.ts` proves the verdict logic. This proves the three things only
 * the loop can be asked:
 *
 * - with the switch off, a step whose action did nothing is recorded `ok`, is
 *   asked nothing, and costs not one extra page read. That is the shipped
 *   behaviour and it must stay byte-identical.
 * - with it on, the contradiction reaches the MODEL — through `ruledOut`, which
 *   is printed on every later prompt — and does not end the run.
 * - a model that repeats an action the loop already contradicted is stopped,
 *   so a check cannot be walked in a polite circle to the cap.
 */

import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import type { AgentDeps, DownloadStart } from '../src/loop';
import { runAgent } from '../src/loop';
import type { AxTree, NodeRef } from '../src/snapshot';
import { nodeRef } from '../src/snapshot';
import { DEFAULT_CHECK_POLICY } from '../src/verify';
import type { Harness } from './support';
import { harness, node, tree } from './support';

const BUTTON: NodeRef = nodeRef(0, 501);
const CAPS = { steps: 6, budget: '1.00', duration: '1m' } as const;

/** One page with one button, at a fixed reference so two reads are comparable. */
function shop(options: { readonly disabled?: boolean; readonly note?: string } = {}): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Shop',
      children: [
        node({
          role: 'button',
          name: 'Add to basket',
          ref: BUTTON,
          ...(options.disabled === true ? { state: { disabled: true } } : {}),
        }),
        ...(options.note === undefined ? [] : [node({ role: 'alert', name: options.note })]),
      ],
    }),
    'https://shop.example/product',
  );
}

const CLICK: Action = { type: 'click', ref: BUTTON };
const DONE: Action = { type: 'done', summary: 'clicked it' };
/** A verb whose outcome no single structural read can falsify. */
const SCROLL: Action = { type: 'scroll', dy: 600 };

/** Click on the first step, finish on the second. The shortest run that acts. */
const clickThenDone = (_prompt: unknown, step: number) => ({
  action: step === 0 ? CLICK : DONE,
});

describe('with the switch off nothing changes', () => {
  test('a click that did nothing is recorded ok, and costs no extra read', async () => {
    const h = harness({ model: clickThenDone, tree: shop() });
    const result = await runAgent(h.deps, { task: 'buy it', caps: CAPS, stepFailures: 3, settle: false });

    expect(result.status).toBe('completed');
    expect(result.steps[0]?.error).toBeUndefined();
    expect(result.steps[0]?.check).toBeUndefined();
    expect(result.ruledOut).toEqual([]);
    // One read per step and not one more. The claim "off pays nothing" is a
    // count, not a promise.
    expect(h.events.filter((event) => event === 'snapshot')).toHaveLength(2);
  });
});

describe('with the switch on the loop asks what the action did', () => {
  test('a click that changed nothing is contradicted, ruled out, and does not end the run', async () => {
    const h = harness({ model: clickThenDone, tree: shop() });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
    });

    const first = result.steps[0];
    expect(first?.check?.verdict).toBe('contradicted');
    expect(first?.check?.saw).toBe('nothing on the page changed');
    // NOT a step failure: the page rejected the input, which is not a model
    // with no idea what it is doing. The run carried on and finished.
    expect(first?.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.stepsUsed).toBe(2);

    // The whole point: the model is told, permanently, in the block the prompt
    // prints under "Already ruled out. Do not try these again:".
    expect(result.ruledOut).toHaveLength(1);
    expect(result.ruledOut[0]?.text).toContain('did not take effect');
    expect(result.ruledOut[0]?.step).toBe(0);
    expect(h.prompts[1]?.text).toContain('Already ruled out');
    expect(h.prompts[1]?.text).toContain('did not take effect');

    // And the history line stops calling it `ok`.
    expect(h.prompts[1]?.text).toContain('-> no effect');
  });

  test('a click the page answered is confirmed, and nothing is ruled out', async () => {
    // Read 0 is the step's own page read; read 1 is the check, and by then the
    // button has gone disabled — which is what a page doing the work looks like.
    const h = harness({
      model: clickThenDone,
      snapshot: (call) => (call === 0 ? shop() : shop({ disabled: true })),
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
    });

    expect(result.steps[0]?.check?.verdict).toBe('confirmed');
    expect(result.steps[0]?.check?.reads).toBe(1);
    expect(result.steps[0]?.check?.elapsedMs).toBe(0);
    expect(result.ruledOut).toEqual([]);
  });

  test('a page that answered with an error contradicts the click on the first read', async () => {
    const h = harness({
      model: clickThenDone,
      snapshot: (call) => (call === 0 ? shop() : shop({ note: 'Postal Code is required' })),
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
    });

    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(result.steps[0]?.check?.saw).toContain('Postal Code is required');
    // Positive evidence is never waited on.
    expect(result.steps[0]?.check?.reads).toBe(1);
  });

  test('an action with no falsifiable outcome is not checked and takes no read', async () => {
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? SCROLL : DONE,
      }),
      tree: shop(),
    });
    const result = await runAgent(h.deps, {
      task: 'look further down',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
    });

    expect(result.steps[0]?.check).toBeUndefined();
    expect(h.events.filter((event) => event === 'snapshot')).toHaveLength(2);
  });

  test('a contradicted step spends the grace and no more', async () => {
    const h = harness({ model: clickThenDone, tree: shop() });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
    });

    const check = result.steps[0]?.check;
    expect(check?.elapsedMs).toBe(DEFAULT_CHECK_POLICY.graceMs);
    expect(check?.reads).toBe(DEFAULT_CHECK_POLICY.graceMs / DEFAULT_CHECK_POLICY.pollMs + 1);
  });
});

describe('a submit the browser refused is contradicted with its reason', () => {
  const INVALID = { label: 'Preferred delivery time:', message: 'Value must be 11:00 AM or later.' };
  const REASON = 'the browser did not send the form, because a field is invalid: "Preferred delivery time:": Value must be 11:00 AM or later.';

  test.each([
    ['nothing changed', false, false, 'contradicted', `nothing on the page changed; ${REASON}`],
    ['the page changed and the invalid field took focus', true, true, 'contradicted', REASON],
    ['the page changed and focus stayed elsewhere', true, false, 'confirmed', undefined],
  ] as const)('%s', async (_case, changed, focused, verdict, saw) => {
    const h = harness({
      model: clickThenDone,
      snapshot: (call) => (call === 0 || !changed ? shop() : shop({ disabled: true })),
    });
    const asked: string[] = [];
    const deps: AgentDeps = {
      ...h.deps,
      refusedSubmit: (ref, by) => {
        asked.push(`${by}@${String(ref.backendNodeId)}`);
        return { fields: [INVALID], focused };
      },
    };
    const result = await runAgent(deps, { task: 'order', caps: CAPS, stepFailures: 3, settle: false, verify: true });

    expect(asked).toEqual(['click@501']);
    expect(result.steps[0]?.check?.verdict).toBe(verdict);
    if (saw !== undefined) {
      expect(result.steps[0]?.check?.saw).toBe(saw);
      expect(h.prompts[1]?.text).toContain(`-> no effect: ${saw}`);
    }
  });
});

describe('a lock the navigation took away does not blind the check', () => {
  /**
   * THE DEFECT THIS WHOLE FILE WAS FAILING TO CATCH.
   *
   * A click that navigates makes the browser release the action-lock. The
   * release lands after `perform` has resolved, so the click succeeds and the
   * check's read — the very next page touch — was refused by `#require` with
   * `LockLostError` before `Outcrawl.getAXTree` was ever sent. Measured on
   * `run_…`: 20 post-action reads, 0 successes, 10 of 10 clicks
   * `unchecked`. Re-measured live on 2026-09-09: 4 of 4 navigating clicks, in
   * both a one-page and a tabbed arm.
   */
  test('a click that navigated is still read back, under a freeze of its own', async () => {
    let released: (() => void) | undefined;
    const h = harness({
      model: clickThenDone,
      // Read 0 is the step's own page read; read 1 is the check, by which time
      // the button has gone — which is what the page doing the work looks like.
      snapshot: (call) => (call === 0 ? shop() : shop({ disabled: true })),
      // The browser takes the freeze away as the click commits its navigation.
      perform: () => {
        released?.();
      },
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
      onSession: (session) => {
        released = () => {
          session.noteLockReleased(h.release('navigated'));
        };
      },
    });

    const check = result.steps[0]?.check;
    expect(check?.verdict).toBe('confirmed');
    expect(check?.reads).toBe(1);
    expect(check?.readError).toBeUndefined();
    /**
     * AND THE LOCK WAS NOT WEAKENED TO GET IT. `liveTouches` counts page
     * operations that reached an UNFROZEN page, so zero is the whole claim:
     * the read was taken under a new freeze over the document the click left,
     * not waved through on the dead one.
     */
    expect(h.browser.liveTouches).toBe(0);
    // One acquire and one release more than the two steps would take alone,
    // and the freeze the browser took is accounted as dropped rather than lost.
    expect(h.events.filter((event) => event === 'lock')).toHaveLength(3);
    expect(h.events.filter((event) => event === 'unlock')).toHaveLength(2);
  });

  test('a loss that must not be retaken refuses, and the trace says which', async () => {
    let released: (() => void) | undefined;
    const h = harness({
      model: clickThenDone,
      tree: shop(),
      perform: () => {
        released?.();
      },
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
      onSession: (session) => {
        released = () => {
          // The renderer is gone: there is nothing left to freeze, so the read
          // must refuse rather than invent a lock over a dead target.
          session.noteLockReleased(h.release('sessionEnded'));
        };
      },
    });

    const check = result.steps[0]?.check;
    expect(check?.verdict).toBe('unchecked');
    // THE REASON REACHES THE TRACE. This is the field whose absence hid the
    // defect above for weeks.
    expect(check?.readError).toContain('LockLostError');
    expect(check?.readError).toContain('sessionEnded');
    // No retake was attempted: two steps, two freezes, and the one the browser
    // took away was not replaced.
    expect(h.events.filter((event) => event === 'lock')).toHaveLength(2);
  });
});

describe('a click in a motor program is watched too', () => {
  test('a head that asserts nothing still gets a verdict when its program clicks', async () => {
    const h = harness({
      model: (_prompt, step) => ({
        action: step === 0 ? SCROLL : DONE,
        ...(step === 0 ? { envelope: { then: [CLICK] } } : {}),
      }),
      tree: shop(),
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 3,
      settle: false,
      verify: true,
      program: 2,
    });

    // The scroll asserts nothing a read can falsify, so before this the step
    // took NO read at all and the click inside it was unobservable. `done`
    // performs nothing, so the dispatches are the program's two.
    expect(h.performed.map((action) => action.type)).toEqual(['scroll', 'click']);
    expect(result.steps[0]?.reflex?.chained).toBe(1);
    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(result.steps[0]?.check?.saw).toBe('nothing on the page changed');
    expect(result.ruledOut).toHaveLength(1);
  });
});

describe('a contradiction is charged, and a step that works gives the charge back', () => {
  test('the same dead action, taken again, ends the run', async () => {
    // Every step clicks the same reference against a page that never moves.
    const h = harness({ model: () => ({ action: CLICK }), tree: shop() });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 1,
      settle: false,
      verify: true,
    });

    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('contradicted');
    // Step 0 charges one of the tolerance, step 1 charges the second and
    // exceeds it. The cap did not end it.
    expect(result.stepsUsed).toBe(2);
    expect(result.cappedBy).toBeUndefined();
  });

  test('one contradiction against zero tolerance ends the run: the sensor is acted on', async () => {
    const h = harness({
      model: (_prompt, step) => ({ action: step === 0 ? CLICK : DONE }),
      tree: shop(),
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      // Zero tolerance: one step the loop has proved did nothing is one too
      // many. Before this the first contradiction at each reference was free,
      // so a run contradicted at a different reference every step zeroed the
      // count on every one of them and spent its whole ceiling.
      stepFailures: 0,
      settle: false,
      verify: true,
    });

    expect(result.stopReason).toBe('error');
    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(result.stepsUsed).toBe(1);
  });

  test('the count is CONSECUTIVE: a confirmed step clears it, so recovery is free', async () => {
    /**
     * Contradict, recover, contradict, finish — with a tolerance of one. This
     * is the diagnose-and-recover flow the old exemption was supposed to
     * protect, and it is protected by the count being consecutive rather than
     * by the first charge being waived: two contradictions in one run, neither
     * of them consecutive, and the run completes.
     */
    // `disabled` and not a `note`: a note renders as an `alert`, which is
    // positive evidence of a REFUSAL and contradicts. A control going disabled
    // is what a page doing the work looks like.
    const basket = shop({ disabled: true });
    /**
     * The page answers exactly ONE read, and that read is step 1's check.
     *
     * Raised in step 1's model call, which is after that step's own page read
     * and before its check; lowered as it is served, so step 2 reads the
     * unmoved page both before and after its click. Neither the read index nor
     * the poll schedule is in the fixture: a contradicted check re-reads
     * through the whole grace, and counting those would make this test depend
     * on `DEFAULT_CHECK_POLICY`.
     */
    let answers = false;
    const h = harness({
      model: (_prompt, step) => {
        if (step === 1) answers = true;
        return { action: step === 3 ? DONE : CLICK };
      },
      snapshot: () => {
        if (!answers) return shop();
        answers = false;
        return basket;
      },
    });
    const result = await runAgent(h.deps, {
      task: 'buy it',
      caps: CAPS,
      stepFailures: 1,
      settle: false,
      verify: true,
    });

    expect(result.steps.map((step) => step.check?.verdict)).toEqual([
      'contradicted',
      'confirmed',
      'contradicted',
      undefined,
    ]);
    expect(result.stopReason).toBe('task-complete');
    expect(result.status).toBe('completed');
  });
});

/**
 * Replayed from production: Coursera--39 (`run_…`, 2026-09-25) and its
 * re-run `run_…` clicked the search card title, an `<a target="_blank">`
 * (read off the fleet with a raw click the same night: `Page.windowOpen` and a
 * new page target, the search tab unchanged). Each click was judged "nothing on
 * the page changed" and the fourth ended the run.
 */
describe('a click that opens a tab took effect', () => {
  const CARD: NodeRef = nodeRef(0, 77);
  const search = tree(
    node({
      role: 'RootWebArea',
      name: 'Search results',
      children: [
        node({ role: 'link', name: 'Space Safety, offered by Technical University of Munich', ref: CARD, href: 'https://courses.example/learn/spacesafety' }),
      ],
    }),
    'https://courses.example/search?query=Space%20Safety',
  );
  const course = tree(
    node({ role: 'RootWebArea', name: 'Space Safety', children: [node({ role: 'heading', name: '42 videos' })] }),
    'https://courses.example/learn/spacesafety',
  );

  /** `opened` is the tab the click's page adopts; the clicked tab keeps focus. */
  function coursera(model: (step: number) => Action, opened: () => { id: string; url: string } = () => ({ id: 't1', url: course.url })) {
    let h: Harness | undefined;
    h = harness({
      model: (_prompt, step) => ({ action: model(step) }),
      tabs: [{ id: 't0', url: search.url }],
      tabTree: (id) => (id === 't0' ? search : course),
      perform: (action) => {
        if (action.type === 'click') h?.tabState.open.push(opened());
      },
    });
    return h;
  }

  test('is confirmed, is not ruled out, and the next step reads the new tab', async () => {
    const h = coursera((step) => (step === 0 ? { type: 'click', ref: CARD } : DONE));
    const result = await runAgent(h.deps, { task: 'count the videos', caps: CAPS, stepFailures: 3, settle: false, verify: true });

    expect(result.steps[0]?.check?.verdict).toBe('confirmed');
    expect(result.steps[0]?.check?.saw).toContain('new tab, t1');
    expect(result.ruledOut).toEqual([]);
    expect(h.tabState.active).toBe('t1');
    expect(result.steps[0]?.tab).toBe('t1');
    expect(h.prompts[1]?.text).toContain('42 videos');
  });

  test('a tab that has not committed yet is waited for, then focused when it is where the link leads', async () => {
    let looks = 0;
    const h = coursera(
      (step) => (step === 0 ? { type: 'click', ref: CARD } : DONE),
      () => ({
        id: 't1',
        // A tab's url is its last COMMITTED page: blank on the first look.
        get url(): string {
          looks += 1;
          return looks === 1 ? 'about:blank' : course.url;
        },
      }),
    );
    const result = await runAgent(h.deps, { task: 'count the videos', caps: CAPS, stepFailures: 3, settle: false, verify: true });

    expect(result.steps[0]?.check?.saw).toContain('new tab, t1');
    expect(h.tabState.active).toBe('t1');
  });

  test('a popunder the click also opened is confirmed as its effect but not focused', async () => {
    const h = coursera(
      (step) => (step === 0 ? { type: 'click', ref: CARD } : DONE),
      () => ({ id: 't1', url: 'https://ads.popunder.example/landing?id=9' }),
    );
    const result = await runAgent(h.deps, { task: 'count the videos', caps: CAPS, stepFailures: 3, settle: false, verify: true });

    expect(result.steps[0]?.check?.verdict).toBe('confirmed');
    expect(result.steps[0]?.check?.saw).toContain('it was not focused because it is not where the link points');
    expect(h.tabState.active).toBe('t0');
    expect(result.steps[0]?.tab).toBe('t0');
    expect(h.prompts[1]?.text).not.toContain('42 videos');
  });

  test('a click that opens nothing is still contradicted', async () => {
    const h = harness({ model: clickThenDone, tree: shop(), tabs: [{ id: 't0', url: 'https://shop.example/product' }] });
    const result = await runAgent(h.deps, { task: 'buy it', caps: CAPS, stepFailures: 3, settle: false, verify: true });

    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(h.tabState.active).toBe('t0');
  });
});

/**
 * Replayed from production: the IW17 probe (fleet 9b8a390aa704, 2026-09-26,
 * n=3, `run_…` among them) clicked the file links on
 * the-internet.herokuapp.com/download. A download leaves the tab exactly as it
 * was, so each click was judged "nothing on the page changed", and in 2 of 3
 * runs those judgements alone spent `stepFailures` and ended the run `error`.
 *
 * The browser announces a download (`Page.downloadWillBegin`) only once the
 * response headers are in, so the fixture announces it AFTER the check's own
 * grace has run out: the timing a real link through a residential exit has.
 */
describe('a click that starts a download took effect', () => {
  const ORIGIN = 'https://the-internet.herokuapp.com';
  const FILES = ['file.txt', 'sample.pdf', 'data.csv'].map((name, index) => ({ name, ref: nodeRef(0, 90 + index) }));
  const listing = tree(
    node({
      role: 'RootWebArea',
      name: 'The Internet',
      children: [
        ...FILES.map(({ name, ref }) => node({ role: 'link', name, ref, href: `${ORIGIN}/download/${name}` })),
        node({ role: 'button', name: 'Refresh', ref: BUTTON }),
      ],
    }),
    `${ORIGIN}/download`,
  );
  const clickFile = (index: number): Action => ({ type: 'click', ref: FILES[index]?.ref ?? BUTTON });

  /**
   * The browser's download ledger beside a two-tab session. `begin` decides
   * what a click starts, and in which tab; the ledger shows it `lateMs` after
   * the click, and `earlier` is what it already held when the run began.
   */
  function downloading(options: {
    readonly model: (step: number) => Action;
    readonly begin: (action: Action) => { readonly tab: string; readonly file: string } | undefined;
    readonly earlier?: readonly DownloadStart[];
    /** The host keeps what the clicks download. */
    readonly saved?: boolean;
  }): { readonly h: Harness; readonly deps: AgentDeps } {
    const lateMs = DEFAULT_CHECK_POLICY.graceMs + 400;
    const begun: { readonly at: number; readonly download: DownloadStart }[] = (options.earlier ?? []).map((download) => ({ at: 0, download }));
    const h: Harness = harness({
      model: (_prompt, step) => ({ action: options.model(step) }),
      tabs: [
        { id: 't0', url: listing.url },
        { id: 't1', url: `${ORIGIN}/` },
      ],
      tabTree: () => listing,
      perform: (action) => {
        const started = options.begin(action);
        if (started === undefined) return;
        begun.push({
          at: h.clock.now() + lateMs,
          download: {
            id: `guid-${String(begun.length)}`,
            tab: started.tab,
            url: `${ORIGIN}/download/${started.file}`,
            filename: started.file,
            ...(options.saved === undefined ? {} : { saved: options.saved }),
          },
        });
      },
    });
    const deps: AgentDeps = {
      ...h.deps,
      downloads: () => begun.filter((entry) => entry.at <= h.clock.now()).map((entry) => entry.download),
    };
    return { h, deps };
  }

  const fileOf = (action: Action): string | undefined =>
    action.type === 'click' ? FILES.find((file) => file.ref === action.ref)?.name : undefined;

  test('is confirmed, costs no step failure, and the model is told what it started', async () => {
    // Three downloads in a row against ZERO tolerance: on the old rule the
    // first one alone ended the run.
    const { h, deps } = downloading({
      model: (step) => (step < 3 ? clickFile(step) : DONE),
      begin: (action) => {
        const file = fileOf(action);
        return file === undefined ? undefined : { tab: 't0', file };
      },
    });
    const result = await runAgent(deps, { task: 'download a file', caps: CAPS, stepFailures: 0, settle: false, verify: true });

    expect(result.steps.map((step) => step.check?.verdict)).toEqual(['confirmed', 'confirmed', 'confirmed', undefined]);
    expect(result.steps[0]?.check?.saw).toContain('download of "file.txt"');
    expect(result.steps[0]?.check?.saw).toContain('the-internet.herokuapp.com');
    expect(result.steps[0]?.check?.download).toEqual({ filename: 'file.txt', url: `${ORIGIN}/download/file.txt` });
    expect(result.ruledOut).toEqual([]);
    expect(result.stopReason).toBe('task-complete');
    // The history line says what the click did, and that the bytes stay put.
    expect(h.prompts[1]?.text).toContain('download of "file.txt"');
    expect(h.prompts[1]?.text).not.toContain('no effect');
  });

  test('the model is told a kept file is saved for the person who started the run, and an unkept one is not', async () => {
    const run = async (saved: boolean | undefined) => {
      const { deps } = downloading({
        model: (step) => (step === 0 ? clickFile(0) : DONE),
        begin: (action) => {
          const file = fileOf(action);
          return file === undefined ? undefined : { tab: 't0', file };
        },
        ...(saved === undefined ? {} : { saved }),
      });
      const result = await runAgent(deps, { task: 'download every file', caps: CAPS, stepFailures: 0, settle: false, verify: true });
      return result.steps[0]?.check?.saw ?? '';
    };

    const kept = await run(true);
    expect(kept).toContain('download of "file.txt"');
    expect(kept).toContain('saved for the person who started this run');
    expect(kept).not.toContain('nothing in this run can open it');

    for (const unkept of [await run(undefined), await run(false)]) {
      expect(unkept).toContain('nothing in this run can open it or hand it over');
      expect(unkept).not.toContain('saved');
    }
  });

  test('a click that changes nothing is still contradicted and charged, whatever the ledger already held', async () => {
    const { deps } = downloading({
      model: (step) => (step === 0 ? CLICK : DONE),
      begin: () => undefined,
      earlier: [{ id: 'guid-old', tab: 't0', url: `${ORIGIN}/download/old.txt`, filename: 'old.txt' }],
    });
    const result = await runAgent(deps, { task: 'refresh it', caps: CAPS, stepFailures: 0, settle: false, verify: true });

    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(result.steps[0]?.check?.saw).toBe('nothing on the page changed');
    expect(result.steps[0]?.check?.download).toBeUndefined();
    expect(result.stopReason).toBe('error');
  });

  test('a download another open tab began meanwhile is not this click\u2019s effect', async () => {
    const { deps } = downloading({
      model: (step) => (step === 0 ? clickFile(0) : DONE),
      begin: (action) => {
        const file = fileOf(action);
        return file === undefined ? undefined : { tab: 't1', file: 'auto-download.zip' };
      },
    });
    const result = await runAgent(deps, { task: 'download a file', caps: CAPS, stepFailures: 0, settle: false, verify: true });

    expect(result.steps[0]?.check?.verdict).toBe('contradicted');
    expect(result.stopReason).toBe('error');
  });
});
