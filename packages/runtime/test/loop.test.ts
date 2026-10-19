import { describe, expect, test } from 'bun:test';

import { compareDecimal, multiplyDecimal } from '@outcrawl/scout-core';

import { RefusedActionError, type Action } from '../src/actions';
import { CODE_RUN_TOOL, CodeSandboxUnavailableError, codeRunToolPort } from '../src/code-run';
import type { AgentPrompt, EvidenceOutcome, LockedPage, ModelChoice, PerformOutcome, ToolPort } from '../src/loop';
import { LockNotHeldError, PageSession, REFUSED_STEP_TOLERANCE, WEB_ASK_TOOL, observe, runAgent } from '../src/loop';
import type { DurableRecord, StepTrace } from '../src/result';
import { MAX_STEP_BRIEF_CHARS, MAX_TOOL_NOTE_CHARS, toWireStep } from '../src/result';
import { SITE_CHECK_TOOL, siteCheckToolPort, type SiteCheckResult } from '../src/site-check';
import { filterTree, formatNodeRef, hashSnapshot, nodeRef } from '../src/snapshot';
import { VirtualClock, catalogueTree, harness, node, refOf, testPricing } from './support';

const page = catalogueTree();
const searchBox = refOf(page, 'Search');
const widget = refOf(page, 'Widget A');

const click: Action = { type: 'click', ref: searchBox };
const done: Action = { type: 'done', summary: 'finished' };

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };
const SCHEMA = {
  type: 'object',
  required: ['airline', 'price'],
  properties: { airline: { type: 'string' }, price: { type: 'number' } },
};

/** Click, then extract, then done — the shape of a real run in three steps. */
function script(...choices: readonly ModelChoice[]) {
  return (_prompt: unknown, step: number): ModelChoice =>
    choices[step] ?? { action: { type: 'done' } };
}

/**
 * A model whose provider bills a fixed USD for every call, and the host's cost
 * ledger that reads it: what `AgentDeps.modelCostUsd` is in production.
 */
function meteredModel(usdPerCall: string, choose: (prompt: AgentPrompt, step: number) => ModelChoice) {
  let calls = 0;
  return {
    model: (prompt: AgentPrompt, step: number): ModelChoice => {
      calls += 1;
      return choose(prompt, step);
    },
    modelCostUsd: (): string => multiplyDecimal(usdPerCall, String(calls)),
  };
}

describe('the lock is held across think and act, which is the whole design', () => {
  test('lock is acquired before the model is asked and released after the act', async () => {
    const h = harness({ tree: page, model: script({ action: click }, { action: done }) });
    await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    // The ordering is the product: the page is frozen before it is read, stays
    // frozen through the 5-15 seconds the model spends thinking, and is only
    // released after the action has landed.
    //
    // Read as the WINDOW AROUND THE MODEL CALL rather than as the first five
    // events, because the step now settles before it thinks: the settle polls a
    // LIVE page — it is `VirtualTimePolicy::kPause`, a frozen page cannot render
    // — so `lock, snapshot, unlock, snapshot…` precedes the pass the model is
    // asked on. What must never appear is an unlock between the read and the
    // act, which is exactly what this window pins.
    const asked = h.events.indexOf('model');
    expect(h.events.slice(asked - 2, asked + 3)).toEqual([
      'lock',
      'snapshot',
      'model',
      'perform',
      'unlock',
    ]);
  });

  test('perform outside a held lock throws', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const session = new PageSession(h.deps);

    expect(session.locked).toBe(false);
    await expect(session.perform(click)).rejects.toThrow(LockNotHeldError);
    expect(h.events).toEqual([]);
  });

  test('the model call is guarded too, so a step cannot think on a live page', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const session = new PageSession(h.deps);
    await expect(
      session.think({
        text: '',
        task: 't',
        step: 0,
        tree: page,
        snapshotHash: 'ax1:0',
        history: [],
      }),
    ).rejects.toThrow(LockNotHeldError);
  });

  test('a page handle that escapes the lock is not a capability', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const session = new PageSession(h.deps);

    let escaped: LockedPage | undefined;
    await session.withLock(async (locked) => {
      escaped = locked;
      await locked.perform(click);
    });

    expect(escaped).toBeDefined();
    // Holding the object is not holding the lock. The guard is the depth.
    await expect(escaped!.perform(click)).rejects.toThrow(LockNotHeldError);
    expect(session.acquires).toBe(1);
    expect(session.releases).toBe(1);
  });

  test('nested locks share one freeze and release once', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const session = new PageSession(h.deps);

    await session.withLock(async () => {
      await session.withLock(async (inner) => {
        await inner.perform(click);
      });
      expect(session.locked).toBe(true);
    });

    expect(h.events).toEqual(['lock', 'perform', 'unlock']);
  });
});

describe('the lock is released on every path', () => {
  test('when the model throws', async () => {
    const h = harness({
      tree: page,
      model: () => {
        throw new Error('model exploded');
      },
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('model exploded');
    // Balanced, not counted: the step settles before it thinks, so a step takes
    // two freezes rather than one. What the lock owes is that every acquire is
    // released on every path, and a count of passes is not that promise.
    expect(h.balance.acquired).toBe(h.balance.released);
    expect(h.balance.acquired).toBeGreaterThan(0);
    expect(h.events.at(-1)).toBe('unlock');
  });

  test('when perform throws', async () => {
    const h = harness({
      tree: page,
      model: script({ action: click }),
      perform: () => {
        throw new Error('element detached');
      },
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('element detached');
    expect(h.balance.acquired).toBe(h.balance.released);
    expect(h.balance.acquired).toBeGreaterThan(0);
    expect(h.events.at(-1)).toBe('unlock');
  });

  test('when a cap trips', async () => {
    const h = harness({ tree: page, model: () => ({ action: click }) });

    const result = await runAgent(h.deps, { task: 'search', caps: { ...CAPS, steps: 3 }, stepFailures: null });

    expect(result.status).toBe('capped');
    expect(h.balance.acquired).toBe(h.balance.released);
    expect(h.balance.acquired).toBeGreaterThanOrEqual(3);
    expect(h.events.at(-1)).toBe('unlock');
  });

  test('a failure to unfreeze surfaces alongside the reason the step failed', async () => {
    const h = harness({
      tree: page,
      model: () => {
        throw new Error('model exploded');
      },
      unlock: () => {
        throw new Error('renderer gone');
      },
    });

    // `settle: false` because the subject is the unfreeze, not the render: with
    // settling on, the FIRST unlock this run attempts is the settle's, which
    // fails before the model is ever asked, and the step then has only one
    // error to report. The two-errors law is about a step that got as far as
    // thinking. Nothing here renders late — `settle.test.ts` prices that.
    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'search',
      caps: CAPS,
      stepFailures: null,
      settle: false,
    });

    // Both, not either: a page that cannot be unfrozen is fatal, and the
    // reason the step failed is what a customer needs to read.
    expect(result.error).toContain('model exploded');
    expect(result.error).toContain('renderer gone');
  });
});

describe('an action the model cannot have chosen is refused, not healed', () => {
  test('a bare backendNodeId ends the run rather than being guessed at', async () => {
    const h = harness({
      tree: page,
      // The exact mistake the composite reference exists to prevent, arriving
      // where the compiler cannot see it: over the wire from a model.
      model: () => ({ action: { type: 'click', ref: 42 } as unknown as Action }),
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/\bref\b.*\b42\b/);
    expect(h.performed).toHaveLength(0);
    expect(h.balance.acquired).toBe(h.balance.released);
  });

  test('a node absent from the snapshot ends the run', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: { type: 'click', ref: nodeRef(0, 999_999) } }),
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    expect(result.error).toContain('not in the snapshot');
    expect(h.performed).toHaveLength(0);
  });
});

describe('every cap trips on its own, and a capped run still returns its data', () => {
  const collecting = script(
    { action: { type: 'extract' } },
    { action: click },
    { action: { type: 'click', ref: widget } },
    { action: click },
    { action: { type: 'click', ref: widget } },
  );
  const extract = () => ({ data: { airline: 'TAP' } });

  test('steps', async () => {
    const h = harness({ tree: page, model: collecting, extract });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      caps: { steps: 3, budget: '2.00', duration: '5m' },
      // Today's behaviour, stated: one failed step ends the run. These tests assert
      // exactly that, so they name it rather than inheriting it.
      stepFailures: null,
      schema: SCHEMA,
    });

    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('steps');
    expect(result.stopReason).toBe('max-steps');
    expect(result.stepsUsed).toBe(3);
    // The point of the whole exercise: the ceiling stopped the run, and the
    // data the run had already collected comes back rather than being binned.
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  /**
   * W44: model usage is the largest term of the bill, and the budget sees it.
   * 3.5 cents of provider spend per call at the test tier is 3.5 credits, so
   * a budget of 10 funds two calls and is crossed by the third.
   * Steps and duration are far out of reach and the clock barely moves, so
   * nothing but model spend can stop this run.
   */
  test('budget trips on model spend mid-run, and bills no more than the budget', async () => {
    const metered = meteredModel('0.035', collecting);
    const h = harness({ tree: page, model: metered.model, extract });

    const result = await runAgent(
      { ...h.deps, modelCostUsd: metered.modelCostUsd },
      {
        task: 'find a flight',
        caps: { steps: 50, budget: '10', duration: '5m' },
        pricing: testPricing(),
        // Today's behaviour, stated: one failed step ends the run. These tests assert
        // exactly that, so they name it rather than inheriting it.
        stepFailures: null,
        schema: SCHEMA,
      },
    );

    expect(testPricing().modelCredits('0.035', testPricing().model)).toBe('3.500');
    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('budget');
    expect(result.stopReason).toBe('max-budget');
    // Stopped at the top of step four: the third call's spend crossed 10.
    expect(result.stepsUsed).toBe(3);
    expect(result.modelCostUsd).toBe('0.105');
    // The ceiling is a ceiling on the bill: the third call and the settle's
    // time are measured and billed only as far as their share of the budget
    // funds them, and the bill is the budget.
    expect(compareDecimal(result.credits, '10')).toBe(0);
    expect(compareDecimal(result.billedModelCostUsd, result.modelCostUsd)).toBe(-1);
    expect(result.billedMs).toBeLessThanOrEqual(result.durationMs);
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  /**
   * A run that spends nothing on its model still cannot outspend the budget:
   * browser time alone is priced, from the clock. Measured on production
   * 2026-09-08 before the ledger priced time: 26 runs carried a budget, 12
   * exceeded it, the worst by 4.20x, and `max-budget` had never once been a
   * stop reason.
   *
   * The model costs NOTHING here on purpose. If this test ever passes because
   * something was charged, it has stopped testing time.
   */
  test('a model that reports no credits at all still cannot outspend the budget', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (prompt, step) => {
        clock.advance(20_000);
        return collecting(prompt, step);
      },
      extract,
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      // `0.50` is run_…'s real cap. Steps and duration are set far
      // beyond reach so the budget is the ONLY ceiling that can stop this run:
      // if these assertions passed because of `max-steps` or `max-duration`
      // they would prove nothing about the budget.
      caps: { steps: 50, budget: '0.50', duration: '30m' },
      stepFailures: null,
      schema: SCHEMA,
      // The arithmetic under test is the ledger's — two model calls at 20 s
      // against a ceiling worth 30 s — so the settle's own milliseconds stay
      // out of it. `settle.test.ts` has its own laws for those.
      settle: false,
    });

    expect(result.stopReason).toBe('max-budget');
    expect(result.cappedBy).toBe('budget');
    expect(result.status).toBe('capped');
    // Nothing was ever charged, and the run priced itself anyway, from time:
    // 40 s of wall clock MEASURED, of which the 0.50 budget funds 30 s at the
    // published credit a minute, and that is what is billed. `charged`
    // staying '0' is what proves the figure came from time.
    expect(result.charged).toBe('0');
    expect(result.credits).toBe('0.5');
    expect(result.durationMs).toBe(40_000);
    expect(result.billedMs).toBe(30_000);
    // Stopped on the third step's cap check, having taken two.
    expect(result.stepsUsed).toBe(2);
    // Each step's frame carries the run's time SO FAR, which is what the live
    // row shows while it runs: cumulative, not the step's own twenty seconds.
    expect(result.steps.map((step) => step.durationMs)).toEqual([20_000, 40_000]);
  });

  /**
   * The half that made the defect INVISIBLE for 26 runs.
   *
   * Of the 12 production runs measured over budget, 8 reported `task-complete`
   * and 3 `schema-satisfied` — every one of them `status: 'completed'`. The
   * worst billed 4.20x its ceiling and told the customer it had finished
   * normally. A ceiling a completed run can sail past without saying so is
   * worse than no ceiling, because the customer believes they are protected.
   */
  test('a run that finishes its task over budget reports the cap, not task-complete', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      // Finishes on the FIRST step, exactly as run_… did — nothing
      // refused it and the model was not interrupted.
      model: () => {
        clock.advance(4_000);
        return { action: done };
      },
      extract,
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      // A ceiling worth three seconds, against a step that takes four.
      //
      // `steps: 8` and not 50, and that is load-bearing: at or above
      // `PLANNING_STEP_THRESHOLD` the loop offers the planning affordance and
      // then HOLDS a first `done` from a run that never stated a plan, so the
      // run would take a second step and stop at the ordinary loop-top cap
      // check. Below the threshold the `done` lands on step one, the loop
      // breaks with `task-complete`, and the end-of-run breach check is the
      // only thing that can produce `max-budget` here — which is precisely the
      // path under test.
      caps: { steps: 8, budget: '0.05', duration: '30m' },
      stepFailures: null,
      settle: false,
    });

    // The model DID finish. The run still says which ceiling it broke, because
    // that is the only place the customer could learn it.
    expect(result.stopReason).toBe('max-budget');
    expect(result.cappedBy).toBe('budget');
    expect(result.status).toBe('capped');
    // Four seconds measured, three billed: the budget, exactly.
    expect(result.credits).toBe('0.05');
    expect(result.durationMs).toBe(4000);
    expect(result.billedMs).toBe(3000);
    expect(result.stepsUsed).toBe(1);
  });

  /**
   * A run that spends its budget to the last credit got what it paid for, and
   * an ending relabelled on equality would make every exactly-priced run read
   * as a breach. The override is for being billed MORE than the number the
   * customer wrote, and nothing else.
   */
  test('a run that finishes exactly AT its budget keeps its own ending', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: () => {
        clock.advance(6_000);
        return { action: done };
      },
      extract,
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      // 6 s at a credit a minute is exactly 0.10, and `steps: 8` keeps the
      // planning hold out of it for the reason the test above gives.
      caps: { steps: 8, budget: '0.10', duration: '30m' },
      stepFailures: null,
      settle: false,
    });

    expect(result.credits).toBe('0.1');
    expect(result.stopReason).toBe('task-complete');
    expect(result.cappedBy).toBeUndefined();
    expect(result.status).toBe('completed');
  });

  test('duration, on a fake clock rather than a sleep', async () => {
    const clock = new VirtualClock();
    const h = harness({
      tree: page,
      clock,
      model: (prompt, step) => {
        clock.advance(400);
        return collecting(prompt, step);
      },
      extract,
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      caps: { steps: 50, budget: '2.00', duration: '1s' },
      // Today's behaviour, stated: one failed step ends the run. These tests assert
      // exactly that, so they name it rather than inheriting it.
      stepFailures: null,
      schema: SCHEMA,
      // The arithmetic under test is the ledger's: three model calls at 400 ms
      // against a 1 s cap. `settle: false` keeps the settle's own milliseconds
      // out of a number that is here to prove the CAP trips, and the settle's
      // cost has its own laws in `settle.test.ts`.
      settle: false,
    });

    expect(result.status).toBe('capped');
    expect(result.cappedBy).toBe('duration');
    expect(result.stopReason).toBe('max-duration');
    expect(result.stepsUsed).toBe(3);
    expect(result.durationMs).toBe(1_200);
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  test('durationMs is integral, because it is metered', async () => {
    // The regression this exists to prevent, and it reached production: a real
    // Clock is monotonic and FRACTIONAL. A live run measured
    // 4708.518583999998 ms, `decimalSecondsFromMs` requires a non-negative
    // integer on purpose, and so every POST /v1/agent that got as far as the
    // meter threw a TypeError and answered 500 — after spending a browser, a
    // residential exit and real inference, and billing for none of it.
    //
    // The fake clock in `harness` advances by whole numbers, so no existing
    // test could see it. This one hands the loop a clock that does what a real
    // one does.
    // A VirtualClock that drifts by a fractional amount on every reading, which
    // is what `performance.now()` does and what every fake in this file does
    // not. Subclassed rather than hand-rolled so it is the type the harness
    // takes, and so a future field on Clock cannot leave this test compiling
    // against a shape nothing real has.
    class DriftingClock extends VirtualClock {
      override now(): number {
        this.advance(137.331_918_4);
        return super.now();
      }
    }

    const h = harness({ tree: page, model: () => ({ action: done }), clock: new DriftingClock(0.5) });

    const result = await runAgent(h.deps, { task: 'x', caps: CAPS, stepFailures: null, schema: SCHEMA });

    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a capped run is not an error: nothing went wrong', async () => {
    const h = harness({ tree: page, model: () => ({ action: click }) });
    const result = await runAgent(h.deps, { task: 'x', caps: { ...CAPS, steps: 1 }, stepFailures: null });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('capped');
  });
});

describe('a run that collects and then falls short returns partial with the data', () => {
  test('the model gives up after collecting', async () => {
    const h = harness({
      tree: page,
      model: script(
        { action: { type: 'extract' } },
        { action: { type: 'fail', reason: 'the price is behind a login wall' } },
      ),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    // Published success rates are 42-71%, so this is the common path.
    expect(result.status).toBe('partial');
    expect(result.data).toEqual({ airline: 'TAP' });
    expect(result.error).toBe('the price is behind a login wall');
  });

  test('a step throws after collecting', async () => {
    let performs = 0;
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, { action: click }),
      extract: () => ({ data: { airline: 'TAP' } }),
      perform: () => {
        performs += 1;
        throw new Error('navigation timed out');
      },
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    expect(performs).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  test('done with an unsatisfied schema is partial, not completed', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, { action: done }),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    // Four of six fields is worth returning; claiming success for it is not.
    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  test('two extractions merge instead of the second replacing the first', async () => {
    const pieces = [{ airline: 'TAP' }, { price: 84 }];
    let call = 0;
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, { action: { type: 'extract' } }),
      extract: () => {
        const data = pieces[call] ?? {};
        call += 1;
        return { data };
      },
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.data).toEqual({ airline: 'TAP', price: 84 });
  });

  test('failing with nothing collected is failed, since there is nothing to return', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'fail', reason: 'blocked' } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    expect(result.status).toBe('failed');
    expect(result.data).toBeUndefined();
  });

  /**
   * MEASURED ON PRODUCTION 2026-09-24 14:00-14:05Z, three of three runs:
   * `done` with a summary, on a schema asking for `answer`, nothing extracted.
   * Nothing threw, so `error` was empty and the control plane wrote "the run
   * failed and the machine serving it reported no reason" — true of no run.
   */
  test('finishing with nothing the schema asks for is failed AND says which fields are missing', async () => {
    const h = harness({ tree: page, model: () => ({ action: done }) });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toBeUndefined();
    expect(result.error).toContain('without extracting the data this run’s schema requires');
    expect(result.error).toContain('missing: airline, price');
    expect(result.error).toContain('No step errored');
  });
});

/**
 * A schema-less run had NO MECHANISM to return an answer. `collected` is written
 * in one place — the `extract` arm — and the only line that ever asked for an
 * extract lived inside `if (prompt.schema !== undefined)`. Measured in
 * production: "report the title of the top story" answered `200 completed` in
 * 6.76s having spent 5,987 input tokens, with no `data` key in the response.
 *
 * The answer was already bought. `DoneAction.summary` is in the grammar, in the
 * parser and on the step trace, and it went nowhere.
 */
describe('a schema-less run returns the answer it was asked for', () => {
  test('the summary the model closed with IS the result', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'done', summary: 'The top story is "A cool thing"' } }),
    });

    const result = await runAgent(h.deps, { task: 'report the top story', caps: CAPS, stepFailures: null });

    // MUTATION THIS CATCHES: drop the promotion in the `terminal === 'done'`
    // branch. Status, stopReason and every step stay exactly as they are, and
    // the customer silently gets nothing again — which is precisely how this
    // shipped, because nothing else in the result changes when it is missing.
    expect(result.data).toBe('The top story is "A cool thing"');
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    // Not bought twice: no extract step was needed to produce it.
    expect(result.stepsUsed).toBe(1);
  });

  test('a task with nothing to report returns nothing, and is NOT held for an answer', async () => {
    // "Click the unsubscribe link" asks no question. `summary` is optional in
    // the grammar and in `DoneAction`, so the model omitting it is the model
    // saying there is nothing to report — that is what distinguishes it from
    // "forgot to report", and it is the model's own statement rather than a
    // heuristic over the task string.
    const h = harness({ tree: page, model: script({ action: { type: 'done' } }) });

    const result = await runAgent(h.deps, { task: 'click the unsubscribe link', caps: CAPS, stepFailures: null });

    expect(result.data).toBeUndefined();
    // NOT HELD. The run ends on the step it said it was finished, and a caller
    // reading `T | undefined` still gets absence meaning absence.
    expect(result.stepsUsed).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
  });

  /**
   * AND THE ANSWER IS NOT A STRING FULL OF ESCAPES.
   *
   * A schema-less `extract` is answered through the model client's
   * `{data:string}` envelope, so `ExtractOutcome.data` is a string whatever the
   * model wrote in it. Ask "return a JSON list of the top 3 comments" with no
   * schema and it returns the JSON — inside that string. Measured on
   * `run_…`: 18 `result` records and the
   * run's own `data`, each a 1,687-byte string whose content is a JSON array,
   * and `agent status` printed it at the owner backslash by backslash.
   */
  test('json the model returned inside a string is parsed, and reaches the record structured', async () => {
    const comments = '[{"author": "cypherpunks01", "text": "the word \\"predicts\\" is a stretch"}]';
    const records: { kind: string; body: unknown }[] = [];
    const h = harness({
      tree: page,
      // A `done` with no summary: the extraction is the answer, and a summary
      // would supersede it (see `finish.test.ts`), which is not this subject.
      model: script({ action: { type: 'extract', instruction: 'the top 3 comments' } }, { action: { type: 'done' } }),
      extract: () => ({ data: comments }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'the top 3 comments',
      caps: CAPS,
      stepFailures: null,
      onRecord: (record) => {
        records.push({ kind: record.kind, body: record.body });
      },
    });

    // MUTATION THIS CATCHES: return `outcome` unchanged from `PageSession.extract`.
    // Nothing about the status, the stop reason or the step count moves — the
    // run reads as a clean success either way, which is exactly how it shipped.
    expect(result.data).toEqual([
      { author: 'cypherpunks01', text: 'the word "predicts" is a stretch' },
    ]);
    // The RECORD too, and not only the merged answer: the record is what
    // `agent results` prints and what a cancelled run has instead of a result.
    expect(records.filter((record) => record.kind === 'result').map((record) => record.body)).toEqual([
      [{ author: 'cypherpunks01', text: 'the word "predicts" is a stretch' }],
    ]);
  });

  test('a string that is not json survives as the string it is', async () => {
    // Three shapes that must not change: prose, a bare JSON scalar, and JSON
    // that opens correctly and does not parse. A record must never be lost or
    // altered because it did not parse — it is evidence behind an invoice.
    for (const answer of [
      'The top story is "A cool thing"',
      '3',
      '[{"author": "cypherpunks01"',
      '{not json at all',
    ]) {
      const h = harness({
        tree: page,
        model: script({ action: { type: 'extract', instruction: 'anything' } }, { action: { type: 'done' } }),
        extract: () => ({ data: answer }),
      });
      const result = await runAgent(h.deps, { task: 'anything', caps: CAPS, stepFailures: null });
      expect(result.data).toBe(answer);
    }
  });

  test('an empty summary is nothing to report, not an empty answer', async () => {
    const h = harness({ tree: page, model: script({ action: { type: 'done', summary: '' } }) });

    const result = await runAgent(h.deps, { task: 'click the unsubscribe link', caps: CAPS, stepFailures: null });

    // An empty string would serialize as a present-but-blank answer, which
    // reads as "the agent replied and said nothing" rather than "no answer was
    // owed". Absent is the honest projection of both.
    expect(result.data).toBeUndefined();
  });

  test('a real extraction is never overwritten by the closing summary', async () => {
    const h = harness({
      tree: page,
      model: script(
        { action: { type: 'extract' } },
        { action: { type: 'done', summary: 'I looked up the flight' } },
      ),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, stepFailures: null });

    // The promotion is guarded on `collected === undefined`. A schema-less run
    // that did extract keeps exactly what it extracted; prose must never
    // replace structured data the run actually gathered.
    expect(result.data).toEqual({ airline: 'TAP' });
  });

  test('a schema\u2019d run is judged on its fields, and a summary does not dilute them', async () => {
    const h = harness({
      tree: page,
      model: script(
        { action: { type: 'extract' } },
        { action: { type: 'done', summary: 'I found the airline but not the price' } },
      ),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    // THE EXISTING PATH, UNCHANGED. The promotion is guarded on
    // `req.schema === undefined` as well, so a half-satisfied schema stays
    // half-satisfied and `partial` rather than being papered over with prose
    // that would make `evaluateSchema` read a string where fields belong.
    expect(result.data).toEqual({ airline: 'TAP' });
    expect(result.status).toBe('partial');
  });

  test('a run that gave up is not made to invent an answer, and stays failed', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'fail', reason: 'the archive is paywalled' } }),
    });

    const result = await runAgent(h.deps, { task: 'report the top story', caps: CAPS, stepFailures: null });

    // `fail` breaks above the `done` branch, so a refusal promotes nothing. A
    // model that correctly declined to invent an answer must not be given one,
    // and `resolveStatus` must still read `hasData: false` — a run that gave up
    // did not complete the task, and status is the only field a caller reads
    // for that.
    expect(result.data).toBeUndefined();
    expect(result.stopReason).toBe('gave-up');
    expect(result.status).toBe('failed');
  });

  test('a capped run that already has data keeps returning it', async () => {
    const h = harness({
      tree: page,
      // A LOOK: an extraction the model marked as its answer would end this
      // schema-less run on the spot, and this test is about the cap.
      model: script({ action: { type: 'extract', instruction: 'the flights' } }, { action: click }, { action: click }),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      caps: { ...CAPS, steps: 2 },
      stepFailures: null,
    });

    // A capped run never reaches the `done` branch at all, so nothing about it
    // moved. Judge on the DATA and not the status: the caller chose the
    // ceiling, and the answer collected before it fired still comes back.
    expect(result.status).toBe('capped');
    expect(result.data).toEqual({ airline: 'TAP' });
  });
});

describe('the run completes when the schema is satisfied, without asking again', () => {
  test('satisfaction ends the run rather than a second inference pass', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { airline: 'TAP', price: 84 } }),
    });

    const result = await runAgent(h.deps, { task: 'find a flight', caps: CAPS, schema: SCHEMA, stepFailures: null });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('schema-satisfied');
    // One model call, not two: the check is deterministic and free.
    expect(h.prompts).toHaveLength(1);
  });

  test('with no schema, the model saying done is the signal', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const result = await runAgent(h.deps, { task: 'log in', caps: CAPS, stepFailures: null });
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
  });
});

/**
 * The WebVoyager answer shape, and the shape the stop condition was measured
 * to be wrong on: one required string, which ANY string satisfies.
 */
const ANSWER = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};

describe('a validating answer that says nothing does not end the run', () => {
  test('an empty required field is not a finish, and the next step gets to fill it', async () => {
    let extracts = 0;
    const h = harness({
      tree: page,
      model: () => ({ action: { type: 'extract' } }),
      extract: () => {
        extracts += 1;
        return { data: extracts === 1 ? { answer: '' } : { answer: 'Apple Tower Theatre' } };
      },
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'which store has it in stock',
      caps: CAPS,
      schema: ANSWER,
      stepFailures: null,
    });

    // `evaluateSchema` said satisfied on step 0 — correctly, `""` is a string —
    // and the loop used to stop there. The answer that was actually on the page
    // arrived on the step that stop was refusing to spend.
    expect(result.data).toEqual({ answer: 'Apple Tower Theatre' });
    expect(result.stepsUsed).toBe(2);
    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.status).toBe('completed');
    // And it was TOLD what was wrong, quoting its own draft. A hold with no
    // explanation buys a re-read of the same page and the same string.
    expect(h.prompts[1]?.notice).toContain('answer=(empty)');
  });

  test('a stock non-answer is held too, and the hold is bounded well short of the cap', async () => {
    const notices: (string | undefined)[] = [];
    const h = harness({
      tree: page,
      model: (prompt) => {
        notices.push(prompt.notice);
        return { action: { type: 'extract' } };
      },
      extract: () => ({ data: { answer: 'Not found.' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'how many figures does the paper have',
      // Ten, deliberately under `PLANNING_STEP_THRESHOLD`: at twelve or more
      // the run also owes a plan, and the step count here would be the sum of
      // two independent holds instead of a measurement of this one.
      caps: { ...CAPS, steps: 10 },
      schema: ANSWER,
      stepFailures: null,
    });

    // Punctuation and case do not smuggle it past, and the quote is the value.
    expect(notices[1]).toContain('answer=Not found.');
    // THE BOUND, which is the half of this that keeps it affordable: three
    // holds, then the non-answer is accepted and returned. A stop condition
    // that never fires spends the whole ceiling, which is the failure
    // `SCHEMA_HOLD_TOLERANCE` was written to record.
    expect(notices.filter((notice) => notice !== undefined)).toHaveLength(3);
    expect(result.stepsUsed).toBe(4);
    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.cappedBy).toBeUndefined();
    // The data is untouched on every path. The point is that the run stops
    // claiming to be finished on it, not that it stops being visible.
    expect(result.data).toEqual({ answer: 'Not found.' });
  });

  test('the hold opens a truthful terminal the branch could not reach before', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, {
        action: { type: 'fail', reason: 'the figure count is not on this page' },
      }),
      extract: () => ({ data: { answer: '' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'how many figures does the paper have',
      caps: CAPS,
      schema: ANSWER,
      stepFailures: null,
    });

    // Before the gate, an empty field ended this run `completed` on step 0 and
    // the model was never asked again. Given the step, it reported the truth.
    expect(result.stopReason).toBe('gave-up');
    expect(result.error).toBe('the figure count is not on this page');
  });

  test('the model saying done over an empty answer is declined the same way', async () => {
    // THE SECOND DOOR, and on the measured arms the busier one: gating only
    // schema satisfaction moves this failure to `task-complete` rather than
    // removing it. `cap-verify-60` row `wv-arxiv-14` ended `task-complete` at
    // step 14 of 60 with `{answer:"no results"}` (n=1, 2026-09-08).
    let extracts = 0;
    const h = harness({
      tree: page,
      model: script(
        { action: { type: 'extract' } },
        { action: { type: 'done', summary: 'no results found' } },
        { action: { type: 'extract' } },
      ),
      extract: () => {
        extracts += 1;
        return { data: extracts === 1 ? { answer: 'no results' } : { answer: '2 Figures, 8 Tables' } };
      },
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'how many figures does the paper have',
      caps: CAPS,
      schema: ANSWER,
      stepFailures: 0,
    });

    // The `done` on step 1 was declined, the extract it bought found the
    // literal, and the run ended on the answer rather than on the claim.
    expect(result.data).toEqual({ answer: '2 Figures, 8 Tables' });
    expect(result.stepsUsed).toBe(3);
    expect(result.stopReason).toBe('schema-satisfied');
    // The decline is RECORDED, so a replay can say why the run carried on past
    // a `done` — and it is not charged to the failure tolerance, which is zero
    // here on purpose: routed through the step-failure channel this run would
    // have come back `status: 'failed'`, blaming the fleet.
    expect(result.status).toBe('completed');
    expect(result.steps[1]?.error).toBe('done was declined: answer carries no answer');
  });

  test('one budget across both doors, so alternating between them buys nothing', async () => {
    // An empty `extract` and an empty `done` are the same claim twice. Three
    // chances in total, not three of each.
    const h = harness({
      tree: page,
      model: (_prompt, step) => ({
        action: step % 2 === 0 ? { type: 'extract' } : { type: 'done' },
      }),
      extract: () => ({ data: { answer: 'n/a' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'how many figures does the paper have',
      caps: { ...CAPS, steps: 10 },
      schema: ANSWER,
      stepFailures: null,
    });

    expect(result.stepsUsed).toBe(4);
    expect(result.cappedBy).toBeUndefined();
  });

  test('a done whose schema is not satisfied at all is not held for substance, only sent back once to extract', async () => {
    // The blast radius. `evaluateSubstance` calls a MISSING field vacuous, so a
    // gate that ran before the validator would hold every half-answered run
    // for its whole tolerance. It does not: the only hold is the single
    // extract demand for missing fields, and the NEXT done ends the run with
    // one of two fields, exactly as it did before either existed.
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, { action: { type: 'done' } }, { action: { type: 'done' } }),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'find a flight',
      caps: CAPS,
      schema: SCHEMA,
      stepFailures: null,
    });

    expect(result.stepsUsed).toBe(3);
    expect(h.prompts[2]?.notice).toContain('price');
    expect(h.prompts[2]?.notice).not.toContain('carries no answer');
    expect(result.stopReason).toBe('task-complete');
    expect(result.status).toBe('partial');
  });

  test('a real answer still finishes on the step it always did, for one model call', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'Apple Tower Theatre, 0.98 mi' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'which store has it in stock',
      caps: CAPS,
      schema: ANSWER,
      stepFailures: null,
    });

    // The whole cost argument: the healthy population pays nothing. One step,
    // one model call, no notice.
    expect(result.stepsUsed).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.notice).toBeUndefined();
    expect(result.stopReason).toBe('schema-satisfied');
  });

  test('an answer that merely contains a non-answer phrase is an answer', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'Apple The Grove: not available until Tuesday' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'is it available for pickup',
      caps: CAPS,
      schema: ANSWER,
      stepFailures: null,
    });

    // The false-hold guard, and the reason the list is matched against the
    // WHOLE value. This sentence answers the question it was asked and holding
    // it would spend a customer's steps to re-derive an answer already given.
    expect(result.stepsUsed).toBe(1);
    expect(result.stopReason).toBe('schema-satisfied');
  });
});

describe('only an extraction that answers can end the run', () => {
  test('a look at the page is read back to the model instead of becoming the answer', async () => {
    // The WebVoyager A/B shape (pre-fix builds, 2026-09-24): "Extract all
    // visible text and interactive elements" filled `{answer}` with a page dump
    // and the run stopped on it, 16 failed runs in all.
    const dump = 'Search Query: Protein prediction. Sort By: Best match. 1. dellacortelab/prospr';
    const h = harness({
      tree: page,
      model: script(
        { action: { type: 'extract', instruction: 'Extract all visible text and interactive elements' } },
        { action: click },
        { action: { type: 'extract', instruction: 'the repository with the most forks', final: true } },
      ),
      extract: (_schema, instruction) => ({
        data: { answer: instruction?.includes('most forks') === true ? 'dellacortelab/prospr' : dump },
      }),
    });

    const result = await runAgent(h.deps, { task: 'most-forked repository', caps: CAPS, schema: ANSWER, stepFailures: null });

    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.stepsUsed).toBe(3);
    expect(result.data).toEqual({ answer: 'dellacortelab/prospr' });
    // The model saw what its look read, once, on the next prompt.
    expect(h.prompts[1]?.notice).toContain('Search Query: Protein prediction');
    expect(h.prompts[2]?.notice ?? '').not.toContain('Search Query');
  });

  test('a step that is not an extraction never ends the run on an answer recorded earlier', async () => {
    // The other half of the class, and the larger: 18 of the 46 pre-fix runs
    // that stopped `schema-satisfied` stopped on a click, navigate, press,
    // scroll or fill. Twelve steps funds a plan, so the first answer is held
    // once for one; the click after it is the model still working.
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }, { action: click }, { action: { type: 'done' } }),
      extract: () => ({ data: { answer: 'Widget A' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'which widget',
      caps: { ...CAPS, steps: 12 },
      schema: ANSWER,
      stepFailures: null,
    });

    expect(result.steps.map((step) => step.action.type)).toEqual(['extract', 'click', 'done']);
    expect(result.stopReason).toBe('task-complete');
    expect(result.data).toEqual({ answer: 'Widget A' });
  });
});

describe('a run that ends on an answer puts the answer on screen', () => {
  test('the element holding the recorded value is scrolled into view, and that is not a step', async () => {
    const spec = node({ role: 'row', children: [node({ role: 'StaticText', name: 'Chip  A15 Bionic chip' })] });
    const h = harness({
      tree: catalogueTree([spec]),
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'A15 Bionic chip' } }),
    });

    const result = await runAgent(h.deps, { task: 'which chip', caps: CAPS, schema: ANSWER, stepFailures: null });

    expect(result.stopReason).toBe('schema-satisfied');
    expect(result.stepsUsed).toBe(1);
    // The row, not its text node: the element is what has a box.
    expect(h.performed).toEqual([{ type: 'scroll', ref: spec.ref, reveal: true }]);
  });

  test('an answer the page does not show moves nothing', async () => {
    const h = harness({
      tree: page,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'A15 Bionic chip' } }),
    });

    await runAgent(h.deps, { task: 'which chip', caps: CAPS, schema: ANSWER, stepFailures: null });

    expect(h.performed).toEqual([]);
  });

  test('the revealed page runs for a second before the run returns, so the film can hold it (run_…)', async () => {
    // Production, python.org with the answer in its footer: the session closed
    // milliseconds after the reveal's unlock and the film ended on the top of
    // the page, n=2. The hold has to be on a LIVE page: a sleep under the
    // lock would change nothing.
    const clock = new VirtualClock();
    let unlockedAt = Number.NaN;
    const spec = node({ role: 'paragraph', children: [node({ role: 'StaticText', name: 'Copyright ©2001-2026.' })] });
    const h = harness({
      tree: catalogueTree([spec]),
      clock,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'Copyright ©2001-2026.' } }),
      unlock: () => {
        unlockedAt = clock.now();
      },
    });

    await runAgent(h.deps, { task: 'the copyright line', caps: CAPS, schema: ANSWER, stepFailures: null });

    expect(h.events.slice(-2)).toEqual(['perform', 'unlock']);
    expect(clock.now() - unlockedAt).toBeGreaterThanOrEqual(1_000);
  });

  test('the hold never outlasts what the run has left', async () => {
    // 350 ms of a five-minute ceiling left when the answer is revealed: a full
    // second of hold would bill past `caps.duration`. The budget is large so the
    // clock is the ceiling that binds.
    const clock = new VirtualClock();
    let unlockedAt = Number.NaN;
    const spec = node({ role: 'paragraph', children: [node({ role: 'StaticText', name: 'Copyright ©2001-2026.' })] });
    const h = harness({
      tree: catalogueTree([spec]),
      clock,
      model: script({ action: { type: 'extract' } }),
      extract: () => {
        clock.advance(5 * 60_000 - 600);
        return { data: { answer: 'Copyright ©2001-2026.' } };
      },
      unlock: () => {
        unlockedAt = clock.now();
      },
    });

    await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'the copyright line',
      caps: { ...CAPS, budget: '50.00' },
      schema: ANSWER,
      stepFailures: null,
    });

    expect(h.events.slice(-2)).toEqual(['perform', 'unlock']);
    expect(clock.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(clock.now() - unlockedAt).toBeGreaterThan(0);
  });

  test('the host is told what the reveal did, and why it did not, with no URL in it (run_…)', async () => {
    // python.org, n=3 on the deploy carrying the paint hold: the film still
    // ended on the top of the page, and the swallowed error said nothing.
    const spec = node({ role: 'paragraph', children: [node({ role: 'StaticText', name: 'Copyright ©2001-2026.' })] });
    const outcomes: EvidenceOutcome[] = [];
    const run = async (perform: (action: Action) => PerformOutcome | undefined, answer: string) => {
      const h = harness({
        tree: catalogueTree([spec]),
        model: script({ action: { type: 'extract' } }),
        extract: () => ({ data: { answer } }),
        perform,
      });
      await runAgent(
        { ...h.deps, onEvidence: (outcome) => outcomes.push(outcome) },
        { task: 'the copyright line', caps: CAPS, schema: ANSWER, stepFailures: null },
      );
    };

    await run(() => ({ gestures: 2 }), 'Copyright ©2001-2026.');
    await run(() => {
      throw new Error('off-screen-target: the page did not move under it on https://www.python.org/?q=secret');
    }, 'Copyright ©2001-2026.');
    await run(() => undefined, 'not on this page at all');

    expect(outcomes).toEqual([
      { kind: 'revealed', gestures: 2 },
      { kind: 'failed', error: 'Error: off-screen-target: the page did not move under it on <url>' },
      { kind: 'not-found' },
    ]);
  });

  test('an answer in CJK punctuation is found by its parts (Cambridge Dictionary--26 run_…)', async () => {
    const sense = node({ role: 'generic', children: [node({ role: 'StaticText', name: '对往事的怀念' })] });
    const h = harness({
      tree: catalogueTree([sense]),
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: '对往事的怀念，怀旧，念旧…' } }),
    });

    await runAgent(h.deps, { task: 'nostalgia in Chinese', caps: CAPS, schema: ANSWER, stepFailures: null });

    expect(h.performed).toEqual([{ type: 'scroll', ref: sense.ref, reveal: true }]);
  });

  test('text with no kept element around it is revealed through its own node (python.org footer, run_…)', async () => {
    // The tree the fork sends, not a DOM-shaped one: `Outcrawl.getAXTree`
    // keeps only actionable and labelling roles, so the footer's contentinfo
    // and paragraph are promoted away and "Copyright ©2001-2026." arrives as
    // a child of the document itself. Production, 2026-09-26, n=3: every run
    // logged `agent.evidence_reveal` not-found and the film ended at the top.
    const footer = node({ role: 'StaticText', name: 'Copyright ©2001-2026.' });
    const document = {
      url: 'https://www.python.org/',
      root: node({
        role: 'RootWebArea',
        name: 'Welcome to Python.org',
        children: [
          node({ role: 'link', name: 'Python', children: [node({ role: 'StaticText', name: 'Python' })] }),
          footer,
          node({ role: 'link', name: 'Python Software Foundation' }),
        ],
      }),
    };
    const outcomes: EvidenceOutcome[] = [];
    const h = harness({
      tree: document,
      model: script({ action: { type: 'extract' } }),
      extract: () => ({ data: { answer: 'Copyright ©2001-2026.' } }),
      perform: () => ({ gestures: 1 }),
    });

    await runAgent(
      { ...h.deps, onEvidence: (outcome) => outcomes.push(outcome) },
      { task: 'the copyright line', caps: CAPS, schema: ANSWER, stepFailures: null },
    );

    expect(h.performed).toEqual([{ type: 'scroll', ref: footer.ref, reveal: true }]);
    expect(outcomes).toEqual([{ kind: 'revealed', gestures: 1 }]);
  });

  test('an answer the page splits across a text node and a link is revealed at its start (python.org, run_…)', async () => {
    const footer = node({ role: 'StaticText', name: 'Copyright ©2001-2026.' });
    const document = {
      url: 'https://www.python.org/',
      root: node({
        role: 'RootWebArea',
        name: 'Welcome to Python.org',
        children: [
          node({ role: 'link', name: 'Python', children: [node({ role: 'StaticText', name: 'Python' })] }),
          footer,
          // The shape the fork's Outcrawl.getAXTree actually sends (measured via
          // /connect, 2026-09-26): a whitespace-only StaticText between the
          // text and the link, and the link carries its name with no text child.
          node({ role: 'StaticText', name: ' ' }),
          node({ role: 'link', name: 'Python Software Foundation' }),
        ],
      }),
    };
    const reveal = async (answer: string) => {
      const h = harness({
        tree: document,
        model: script({ action: { type: 'extract' } }),
        extract: () => ({ data: { answer } }),
        perform: () => ({ gestures: 1 }),
      });
      await runAgent(h.deps, { task: 'the copyright line', caps: CAPS, schema: ANSWER, stepFailures: null });
      return h.performed;
    };

    expect(await reveal('Copyright ©2001-2026. Python Software Foundation')).toEqual([
      { type: 'scroll', ref: footer.ref, reveal: true },
    ]);
    // Every chunk must be on the page: a sentence that merely starts like the
    // footer is not evidence, and nothing is scrolled.
    expect(await reveal('Copyright ©2001-2026. Python is a trademark of someone else')).toEqual([]);
  });

  test('words the page holds in unrelated places are not a spanning answer, and nothing is scrolled', async () => {
    // MUTATION: a piece found in ANY node (ByoProxyReview P2): a summary made
    // of phrases scattered over the page "spanned" them and scrolled to a guess.
    const first = node({ role: 'link', name: 'The quick brown fox' });
    const page = (between: boolean) => ({
      url: 'https://example.com/',
      root: node({
        role: 'RootWebArea',
        name: 'Example',
        children: [
          first,
          ...(between ? [node({ role: 'button', name: 'Subscribe to the newsletter' })] : []),
          node({ role: 'link', name: 'jumps over the lazy dog' }),
        ],
      }),
    });
    const reveal = async (between: boolean) => {
      const h = harness({
        tree: page(between),
        model: script({ action: { type: 'extract' } }),
        extract: () => ({ data: { answer: 'The quick brown fox jumps over the lazy dog' } }),
        perform: () => ({ gestures: 1 }),
      });
      await runAgent(h.deps, { task: 'the sentence', caps: CAPS, schema: ANSWER, stepFailures: null });
      return h.performed;
    };

    // Side by side it is one sentence the page renders in two nodes.
    expect(await reveal(false)).toEqual([{ type: 'scroll', ref: first.ref, reveal: true }]);
    // With anything between them it is two phrases, and no evidence.
    expect(await reveal(true)).toEqual([]);
  });
});

describe('the step trace is the run evidence', () => {
  test('it records the action, the node, the tokens, the cache, the model spend and the elapsed time', async () => {
    const clock = new VirtualClock();
    const metered = meteredModel('0.05', () => {
      clock.advance(250);
      return {
        action: click,
        reasoning: 'the search box is the only input',
        usage: { inputTokens: 742, outputTokens: 24, reasoningTokens: 120 },
        cache: { status: 'HIT' as const, reason: 'url + instruction + tree hash' },
      };
    });
    const h = harness({ tree: page, clock, model: metered.model });

    // `settle: false`: `elapsedMs` below is the step's whole wall clock and the
    // settle is inside it, so leaving it on would make this assertion a test of
    // the settle policy's constants instead of the trace's arithmetic.
    const result = await runAgent({ ...h.deps, modelCostUsd: metered.modelCostUsd }, {
      task: 'search',
      caps: { ...CAPS, steps: 1 },
      stepFailures: null,
      settle: false,
    });
    const [first] = result.steps;

    expect(result.steps).toHaveLength(1);
    expect(first?.action).toEqual(click);
    expect(first?.ref).toEqual(searchBox);
    expect(first?.reasoning).toBe('the search box is the only input');
    expect(first?.reasoningTokens).toBe(120);
    expect(first?.cache).toEqual({ status: 'HIT', reason: 'url + instruction + tree hash' });
    expect(first?.elapsedMs).toBe(250);
    // What the provider billed for the run so far, carried on the frame so a
    // run resumed on another machine prices it again; nothing was explicitly
    // charged.
    expect(first?.modelCostUsd).toBe('0.05');
    expect(first?.credits).toBe('0');
    expect(first?.snapshotHash).toBe(hashSnapshot(filterTree(page)));
    // The wire form rides along, so a reviewer and the cache see the same thing.
    expect(first?.observed?.ref).toBe(formatNodeRef(searchBox));
    expect(first?.observed?.xpath).toBe(`/html/body/*[${String(searchBox.backendNodeId)}]`);
    expect(result.usage.inputTokens).toBe(742);
  });

  test('the failing step is in the trace, because that is the one a dispute is about', async () => {
    const h = harness({
      tree: page,
      model: script({ action: click }, { action: click }),
      perform: (action: Action) => {
        if (action.type === 'click') {
          throw new Error('element detached');
        }
      },
    });

    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.error).toContain('element detached');
    expect(result.steps[0]?.action).toEqual(click);
  });

  test('steps stream as they happen, exactly once each, including the last', async () => {
    const seen: StepTrace[] = [];
    const h = harness({
      tree: page,
      model: script({ action: click }, { action: { type: 'extract', instruction: 'the flights' } }, { action: { type: 'done' } }),
      extract: () => ({ data: { airline: 'TAP' } }),
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'search',
      caps: CAPS,
      stepFailures: null,
      onStep: (step) => seen.push(step),
    });

    expect(seen.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(seen).toEqual([...result.steps]);
  });

  test('the cache is reported as disabled when the caller turned it off', async () => {
    const h = harness({ tree: page, model: script({ action: done }) });
    const result = await runAgent(h.deps, { task: 'search', caps: CAPS, cache: false, stepFailures: null });
    expect(result.steps[0]?.cache.status).toBe('DISABLED');
    expect(result.usage.cache?.status).toBe('DISABLED');
  });
});

describe('a step reports exactly what the ledger charges', () => {
  test('StepTrace.spent is ledger.credits: model usage plus time, live', async () => {
    const clock = new VirtualClock();
    const metered = meteredModel('0.01', () => {
      clock.advance(60_000);
      return { action: done };
    });
    const h = harness({ tree: page, clock, model: metered.model });

    const result = await runAgent(
      { ...h.deps, modelCostUsd: metered.modelCostUsd },
      {
        task: 'search',
        caps: { ...CAPS, budget: '999.00' },
        pricing: testPricing(),
        stepFailures: null,
        settle: false,
      },
    );

    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    const [first] = result.steps;
    // One cent of model usage at the test tier (1.00) plus one minute of
    // browser time (1). No bandwidth reader is wired here, so that term is
    // zero — see the next describe block for what it looks like when one is.
    expect(first?.spent).toBe('2.00');
    // And the run reports the same figure the frame showed.
    expect(result.credits).toBe('2.00');
  });
});

describe('the budget cap reads bandwidth continuously, before every step', () => {
  // Requirement this block pins: `AgentDeps.bandwidthBytes` is read once at
  // the top of every step, before the cap test, and what it reports becomes
  // part of BOTH the figure `tripped()` tests and the figure
  // `AgentResult.credits` reports — one number, never two, see
  // `packages/runtime/src/caps.ts`'s `CapLedger.credits` for the incident
  // that made that promise false until now.

  test('a run whose bandwidth crosses the budget trips at the next step, even though time alone is far under it', async () => {
    const clock = new VirtualClock();
    let reading = 0;
    const h = harness({
      tree: page,
      clock,
      model: script({ action: click }, { action: done }),
      // Bumped from inside the FIRST step's own action — after that step's
      // top-of-loop bandwidth read and before the second's, exactly where a
      // real page's fetch would land the bytes.
      perform: () => {
        reading = 3_000_000_000; // 3 GB, 6,000 credits at the published rate
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'search',
      // Comfortably clears a virtual clock's negligible time — nothing except
      // bandwidth can trip this.
      caps: { steps: 8, budget: '10.00', duration: '5m' },
      stepFailures: null,
      settle: false,
    });

    expect(result.stopReason).toBe('max-budget');
    expect(result.cappedBy).toBe('budget');
    // Stopped after exactly one step: the SECOND top-of-loop read is what
    // noticed the first step's bytes, and the run took no further action
    // once it did — the detect-and-stop bound `docs/AGENTS.md` describes,
    // now honoured for bandwidth the same way it already was for time.
    expect(result.stepsUsed).toBe(1);
  });

  test('reported credits include bandwidth at the published per-byte rate', async () => {
    const clock = new VirtualClock();
    const h = harness({ tree: page, clock, model: script({ action: done }) });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => 500_000_000 };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'search',
      caps: { steps: 8, budget: '9999.00', duration: '5m' },
      stepFailures: null,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // 500,000,000 bytes at the test price list's 2,000 credits/GB is 1,000
    // credits, through `RunPricing.creditsPerByte`. Nothing else is
    // charged: `done` on the first step, no pages, negligible time.
    expect(result.credits).toBe('1000.000000');
  });

  test('a reader that fails or reports less than before never lowers what the run is priced at', async () => {
    const clock = new VirtualClock();
    let reading: number | null = 2_000_000_000; // 2 GB, 4,000 credits
    const h = harness({
      tree: page,
      clock,
      model: script({ action: click }, { action: click }, { action: done }),
      perform: (action) => {
        if (action.type !== 'click') {
          return;
        }
        // The browser stops answering after the first click — an unpatched
        // binary, a wrong control key, whatever the cause — and the one time
        // it answers again it reports a SMALLER number than before. Neither
        // must ever be allowed to make bandwidth cheaper than it was the
        // instant before.
        reading = reading === 2_000_000_000 ? null : 500_000_000;
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'search',
      caps: { steps: 8, budget: '9999.00', duration: '5m' },
      stepFailures: null,
      settle: false,
    });

    expect(result.status).toBe('completed');
    // 2 GB is the last KNOWN-GOOD reading. It is what the run reports —
    // never the `null` that followed it, and never the smaller 500,000,000
    // that arrived after that: `Math.max` at the read site keeps the higher
    // of the two, and a skipped `null` read leaves the ledger exactly where
    // it was.
    expect(result.credits).toBe('4000.000000');
  });

  test('PRODUCTION INCIDENT: bandwidth from the FINAL action, after the last per-step read, is still reported and never bills over budget', async () => {
    // Measured 2026-09-23, an audit account, six checkout runs against a 40.00
    // budget with no steps/duration ceiling: the two that ended naturally
    // (`task-complete`) billed exactly what they reported. The four that
    // ended `max-budget` did not — `run_...bc565428` reported 33.817562
    // while its session billed 42.0914, 2.09 credits OVER the customer's own
    // ceiling. The shared shape: the model's FINAL action (`done`) triggers
    // a page whose bytes are still landing when the loop takes its one read
    // for the step, and there is no next step to re-read them, because
    // `done` ends the run with no further top-of-loop pass.
    const clock = new VirtualClock();
    let reading = 4_000_000; // 8 credits — read before the final step
    const h = harness({
      tree: page,
      clock,
      // Bumped from inside the model call itself rather than from `perform`:
      // `done` is a decision, not a browser action, and never reaches
      // `deps.perform` — this is what actually happens between the loop's
      // one read for the step and the page settling on it in production.
      model: (): ModelChoice => {
        reading = 25_000_000; // 50 credits, comfortably over the budget below
        return { action: done };
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: { steps: 8, budget: '40.00', duration: '5m' },
      stepFailures: null,
      settle: false,
    });

    // (3) THE STOP REASON IS CORRECT: bandwidth genuinely reached the
    // customer's ceiling, even though the RUN ended by the model saying
    // `done` rather than by a top-of-loop `tripped()` break — the post-hoc
    // check and the trailing read together still name it correctly.
    expect(result.stopReason).toBe('max-budget');
    expect(result.cappedBy).toBe('budget');
    // (2) NEVER BILLED MORE THAN BUDGET: bandwidth clamped to exactly fill
    // the 40.00 budget (20,000,000 bytes) is 40.00, not the 50 credits the
    // true 25,000,000-byte reading would have priced.
    expect(result.credits).toBe('40.000000');
  });

  test('PRODUCTION INCIDENT: an error exit — a rule refusal, a lost browser, any step failure — still reports the FINAL bandwidth reading', async () => {
    // Measured 2026-09-23, three live runs on the fix above (ce2ee02e,
    // 0269026d, 732681a7), all `status failed` / `stopReason error` from a
    // rule refusing a dispatch. The completed/capped paths matched exactly;
    // these three did not — reported trailed billed by 0.347876 / 0.922398 /
    // 0.007584 credits. Each run's `agent_seconds`/`context_seconds`, which
    // price off the identical `durationMs` the reported credits use, matched
    // the billed row to the decimal in all three, so time was never the
    // suspect: the entire gap, in every run, was exactly the credits of a
    // bandwidth under-read (173,938 / 461,199 / 3,792 bytes). The trailing
    // read above already runs unconditionally after the loop, on every
    // `break` — this pins that an error exit is not a special case that
    // skips it.
    const clock = new VirtualClock();
    let reading = 1_000_000; // 2 credits, read at the top of the step that fails
    const h = harness({
      tree: page,
      clock,
      model: (): ModelChoice => {
        // Bytes still landing with the refused dispatch — the same shape as
        // the `done` case above, through the error exit instead of a clean
        // one.
        reading = 3_000_000; // 6 credits
        return { action: click };
      },
      perform: (): never => {
        throw new Error(
          'rule blocked this action: "Never pay or place an order." — this dispatch is an ' +
            'irreversible payment action and nobody has confirmed it. This rule is ENFORCED, not advice',
        );
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: { steps: 8, budget: '9999.00', duration: '5m' },
      // Zero tolerance: the run stops on the very first failed dispatch,
      // which is exactly what a hard rule refusal does in production — see
      // `RuleBlockedError`'s own doc in `rules.ts` for why a refusal is a
      // step the run can recover from in general, and `stepFailures: 0` is
      // the caller choosing not to let it.
      stepFailures: 0,
      // Off, matching every sibling test in this block: settle polls the
      // page and advances the virtual clock doing it, which would add its
      // own time credits on top of the bandwidth figure this test is
      // actually about.
      settle: false,
    });

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(result.steps[0]?.error).toContain('rule blocked this action');
    // 3,000,000 bytes at the published rate is 6 credits — the trailing
    // read's figure — not the 1,000,000/2 credits the step-top read saw
    // before the dispatch was refused.
    expect(result.credits).toBe('6.000000');
  });

  test('a cancelled run stops before its next step and still reports the FINAL bandwidth reading', async () => {
    // Measured 2026-09-23 on `run_…c78b0332`, cancelled at step 10: it
    // reported 30.591908 while usage_events charged 32.903012, because the
    // run was ended from outside and this loop's closing read never ran.
    const clock = new VirtualClock();
    const stop = new AbortController();
    let reading = 1_000_000; // 2 credits, read at the top of the only step
    const h = harness({
      tree: page,
      clock,
      model: (): ModelChoice => {
        reading = 3_000_000; // 6 credits: bytes still landing when the owner cancels
        return { action: click };
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: { steps: 8, budget: '9999.00', duration: '5m' },
      stepFailures: null,
      settle: false,
      signal: stop.signal,
      onStep: () => {
        stop.abort();
      },
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.stepsUsed).toBe(1);
    // Nothing collected before the cancel: partial, never failed.
    expect(result.status).toBe('partial');
    expect(result.credits).toBe('6.000000');
  });
});

/**
 * A run that is still inside its step must END when its owner cancels, not
 * when the step does. Production 2026-09-21..28 (n=35 cancels before the run
 * ended): 31 settled only after the step running at the cancel finished, the
 * slowest after 60-150 s steps and a 145 s busy-renderer retry.
 */
describe('a cancel interrupts the step in flight', () => {
  // No wall-clock guard: before the fix each of these runs never returned,
  // because the step it was in never did, so the red is the test timeout.
  const never = Promise.withResolvers<never>().promise;

  test('a cancel during the model call ends the run at once, and the answer that arrives later is never acted on', async () => {
    const stop = new AbortController();
    const answer = Promise.withResolvers<ModelChoice>();
    const h = harness({
      tree: page,
      model: (): Promise<ModelChoice> => {
        queueMicrotask(() => stop.abort());
        return answer.promise;
      },
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: CAPS,
      stepFailures: null,
      settle: false,
      signal: stop.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.status).toBe('partial');
    expect(result.stepsUsed).toBe(1);
    expect(result.steps[0]?.error).toContain('cancelled by its owner');
    // The abandoned step's model answer lands after the run ended: the page
    // it would have clicked on refuses the touch.
    answer.resolve({ action: click });
    // One macrotask: the abandoned step's whole remaining chain is microtasks
    // in this fake browser, so it has run to its refusal by then.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.performed).toEqual([]);
  });

  test('a cancel during a browser action that never returns ends the run at once', async () => {
    const stop = new AbortController();
    const h = harness({
      tree: page,
      model: () => ({ action: click }),
      perform: (): Promise<never> => {
        queueMicrotask(() => stop.abort());
        return never;
      },
    });

    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: CAPS,
      stepFailures: null,
      settle: false,
      signal: stop.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.stepsUsed).toBe(1);
    expect(h.performed).toHaveLength(1);
  });

  test('a cancel while the renderer will not answer the freeze ends the busy retry at once', async () => {
    const stop = new AbortController();
    let locks = 0;
    const h = harness({
      tree: page,
      model: () => ({ action: click }),
      lock: (): never => {
        locks += 1;
        stop.abort();
        throw new Error('Outcrawl.lock was not answered by the renderer of https://example.com/ within 5000ms');
      },
    });

    const result = await runAgent(h.deps, { task: 'buy the item', caps: CAPS, stepFailures: null, signal: stop.signal });

    expect(result.stopReason).toBe('cancelled');
    // The refusal that took the cancel is the last freeze ever asked for.
    expect(locks).toBe(1);
    expect(h.performed).toEqual([]);
  });

  test('a run cancelled mid-step reports what the ledger charged, including the bytes that landed during the step', async () => {
    const stop = new AbortController();
    let reading = 1_000_000; // 2 credits at the top of the step
    const h = harness({
      tree: page,
      clock: new VirtualClock(),
      model: () => ({ action: click }),
      perform: (): Promise<never> => {
        reading = 3_000_000; // 6 credits: the page the action loads is still arriving
        queueMicrotask(() => stop.abort());
        return never;
      },
    });
    const deps = { ...h.deps, bandwidthBytes: async (): Promise<number | null> => reading };

    const result = await runAgent(deps, {
      pricing: testPricing(),
      task: 'buy the item',
      caps: { steps: 8, budget: '9999.00', duration: '5m' },
      stepFailures: null,
      settle: false,
      signal: stop.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.credits).toBe('6.000000');
  });
});

describe('observe reviews and executes nothing', () => {
  test('it returns the actions and performs none of them', async () => {
    const h = harness({
      tree: page,
      model: () => ({
        action: click,
        alternatives: [{ type: 'click', ref: widget }],
        reasoning: 'either input reaches the catalogue',
        usage: { inputTokens: 742 },
      }),
    });

    // `settle: false` — the subject is that `observe` REVIEWS and performs
    // nothing, and this page is fully rendered in the fake browser. With
    // settling on, `observe` settles its first read like a step does, which
    // adds unlocked polls before the pass the model is asked on; those laws are
    // in `settle.test.ts`.
    const result = await observe(h.deps, { instruction: 'the search box', settle: false });

    expect(h.performed).toHaveLength(0);
    expect(h.events).toEqual(['lock', 'snapshot', 'model', 'unlock']);
    expect(result.actions).toHaveLength(2);
    expect(result.snapshotHash).toBe(hashSnapshot(filterTree(page)));
    expect(result.url).toBe('https://example.com/');
  });

  test('what it hands back is the cache unit, with the heal path attached', async () => {
    const h = harness({ tree: page, model: () => ({ action: click }) });

    const result = await observe(h.deps, { instruction: 'the search box' });

    expect(result.observed).toHaveLength(1);
    expect(result.observed[0]?.method).toBe('click');
    expect(result.observed[0]?.ref).toBe(formatNodeRef(searchBox));
    expect(result.observed[0]?.xpath).not.toBe('');
    expect(result.cache).toEqual({ status: 'MISS', reason: 'no action cache attached' });
  });

  test('an unusable proposal is refused here too, and the lock still releases', async () => {
    const h = harness({
      tree: page,
      model: () => ({ action: { type: 'click', ref: nodeRef(0, 999_999) } }),
    });

    await expect(
      observe(h.deps, { instruction: 'the search box', settle: false }),
    ).rejects.toThrow('unusable');
    expect(h.balance.acquired).toBe(1);
    expect(h.balance.released).toBe(1);
  });
});

/**
 * THE ACCOUNT'S CEILING, which is not the caller's.
 *
 * Until 2026-09-08 nothing enforced an account's balance anywhere: the credit
 * pool's `exhausted` flag was reported by `/v1/credits` and read by nothing, so
 * `caps.budget` — a number the CALLER chooses — was the only bound on spend.
 * The owner's own account was serving at roughly -191 credits.
 *
 * The allowance is DELIVERED rather than read: a fleet Mac holds no database
 * credential, so the edge stamps the figure on the dispatch and the loop
 * subtracts what the run spends from it. `caps.budget` is deliberately generous
 * in every test here, so nothing below can pass because of the caller's ceiling.
 */
describe('a run stops when the WORKSPACE runs out of credits', () => {
  test('the remaining work is not performed, and it is not the caller cap', async () => {
    const metered = meteredModel('0.035', script({ action: click }, { action: click }, { action: click }, { action: done }));
    const h = harness({ tree: page, model: metered.model });

    const said: string[] = [];
    const result = await runAgent({ ...h.deps, modelCostUsd: metered.modelCostUsd }, {
      task: 'search',
      caps: { steps: 8, budget: '100.00', duration: '5m' },
      pricing: testPricing(),
      stepFailures: null,
      // Just under two steps' worth of model spend at 3.5 cents (3.5 credits
      // at the test tier) a step.
      accountCredits: '6.90',
      onRecord: (record) => {
        if (record.kind === 'finding') said.push(String(record.body));
      },
    });

    // Two steps ran and the third was never begun: at 7.00 spent the account
    // is past 6.90, so the top of step three stops instead of thinking. STOP
    // BEFORE STARTING A STEP YOU CANNOT AFFORD, which is the same rule
    // `CapLedger` applies to the caller's budget.
    expect(result.stopReason).toBe('account-exhausted');
    expect(result.stepsUsed).toBe(2);
    // NOT the caller's ceiling: their budget is 93 unspent, so reporting
    // `capped`/`max-budget` would be a lie about a number they chose.
    expect(result.cappedBy).toBeUndefined();
    expect(result.status).not.toBe('capped');
    // And the run says so in its own record, with what it had reached, so a
    // customer watching the event stream does not read a stop as a crash.
    expect(said.join('\n')).toContain('out of credits');
    // With the numbers, not an adjective: what it spent, what it could draw
    // from the workspace, and the step it did not take.
    expect(said.join('\n')).toContain('could draw 6.90 credits from the workspace');
  });

  test('a run whose account has room is untouched, and an unlimited one is never stopped', async () => {
    // The other direction, because a ceiling that refuses everything passes the
    // test above. Same script, same spend, three allowances.
    for (const accountCredits of ['100.00', null, undefined]) {
      const metered = meteredModel('0.01', script({ action: click }, { action: done }));
      const h = harness({ tree: page, model: metered.model });
      const result = await runAgent({ ...h.deps, modelCostUsd: metered.modelCostUsd }, {
        task: 'search',
        caps: { steps: 8, budget: '100.00', duration: '5m' },
        pricing: testPricing(),
        stepFailures: null,
        ...(accountCredits === undefined ? {} : { accountCredits }),
      });
      expect({ accountCredits, stopReason: result.stopReason }).toEqual({
        accountCredits,
        stopReason: 'task-complete',
      });
    }
  });
});

describe('what the page did by itself reaches the model once', () => {
  test('a page event is a notice on the next prompt and is not repeated after', async () => {
    const queued = ['A confirm dialog said "Delete it?"; it was accepted (OK).'];
    const h = harness({ model: script({ action: click }, { action: click }, { action: done }) });
    await runAgent(
      { ...h.deps, pageEvents: () => queued.splice(0) },
      { task: 't', caps: CAPS, stepFailures: 3, onStep: () => {} },
    );

    expect(h.prompts[0]?.notice).toContain('A confirm dialog said "Delete it?"');
    expect(h.prompts[1]?.notice ?? '').not.toContain('confirm dialog');
  });
});

describe('a done that skipped the extraction a schema run needs', () => {
  const ANSWER_SCHEMA = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };
  /** Two fields: a sentence cannot be this schema's data, so the summary is never its answer. */
  const PHONE_SCHEMA = {
    type: 'object',
    required: ['chip', 'price'],
    properties: { chip: { type: 'string' }, price: { type: 'string' } },
  };

  test('is sent back once to extract, and the extracted answer is what the run returns', async () => {
    // Measured 2026-09-24, 7 days of production schema runs: 5 of the 20 that
    // ended on `done` (run_…, run_…, run_…, run_…,
    // run_…) put the answer in the summary, never extracted, and ended
    // `failed` with no data.
    const h = harness({
      model: script(
        { action: { type: 'done', summary: 'A15 Bionic, $799' } },
        { action: { type: 'extract', instruction: 'the answer' } },
      ),
      extract: () => ({ data: { chip: 'A15 Bionic', price: '$799' } }),
    });
    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 't',
      caps: CAPS,
      schema: PHONE_SCHEMA,
      stepFailures: 3,
      onStep: () => {},
    });

    expect(result.data).toEqual({ chip: 'A15 Bionic', price: '$799' });
    expect(result.status).toBe('completed');
    expect(h.prompts[1]?.notice).toContain('chip, price');
    expect(h.prompts[1]?.notice).toContain('extract');
  });

  test('is corrected only once: a second done is accepted as it always was', async () => {
    const h = harness({
      model: script(
        { action: { type: 'done', summary: 'first' } },
        { action: { type: 'done', summary: 'second' } },
        { action: { type: 'done', summary: 'third' } },
      ),
    });
    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 't',
      caps: CAPS,
      schema: PHONE_SCHEMA,
      stepFailures: 3,
      onStep: () => {},
    });

    expect(h.prompts).toHaveLength(2);
    expect(result.stopReason).toBe('task-complete');
  });

  test('whose schema is one answer string takes the summary as that answer (run_…)', async () => {
    // HarnessAB 2026-09-26: 12 runs across five arms were declined this way,
    // and in all 3 that then failed the judge the declined summary was the
    // right answer and the extract forced after it was not. run_…
    // (lab-scout1-web, ESPN--28) had its answer from web.read, finished with
    // the summary below, was sent to extract from ESPN's front page and
    // returned "The page does not state the total number of MLB teams".
    // The grammar's own line is {"type":"done","summary":"the answer, if the
    // task asked for one"}, and a one-string schema is where that lands.
    const summary = "There are 30 MLB teams. The team with 'City' in its name is the Kansas City Royals.";
    const h = harness({
      model: script({ action: { type: 'done', summary } }),
      extract: () => ({ data: { answer: 'The page does not state the total number of MLB teams.' } }),
    });
    const records: DurableRecord[] = [];
    const result = await runAgent(h.deps, {
      pricing: testPricing(),
      task: 't',
      caps: CAPS,
      schema: ANSWER_SCHEMA,
      stepFailures: 3,
      onStep: () => {},
      onRecord: (record) => { records.push(record); },
    });

    expect(result.data).toEqual({ answer: summary });
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('task-complete');
    expect(h.prompts).toHaveLength(1);
    expect(result.steps[0]?.error).toBeUndefined();
    // Durable, so a resumed run returns it too.
    expect(records.filter((record) => record.kind === 'result').map((record) => record.body)).toEqual([
      { answer: summary },
    ]);
  });

  test('a summary that says nothing is still sent back to extract, never taken as the answer', async () => {
    const h = harness({
      model: script(
        { action: { type: 'done', summary: 'Not found.' } },
        { action: { type: 'extract', instruction: 'the answer' } },
      ),
      extract: () => ({ data: { answer: '8.8/10' } }),
    });
    const result = await runAgent(h.deps, { task: 't', caps: CAPS, schema: ANSWER_SCHEMA, stepFailures: 3, onStep: () => {} });

    expect(result.steps[0]?.error).toBe("done was declined: the schema's answer was never extracted");
    expect(result.data).toEqual({ answer: '8.8/10' });
  });

  test('after that decline, a finish that does state the answer is taken', async () => {
    const h = harness({
      model: script(
        { action: { type: 'done', summary: 'unknown' } },
        { action: { type: 'done', summary: 'Booking Holdings Inc.' } },
      ),
    });
    const result = await runAgent(h.deps, { task: 't', caps: CAPS, schema: ANSWER_SCHEMA, stepFailures: 3, onStep: () => {} });

    expect(h.prompts[1]?.notice).toContain('stating the answer itself');
    expect(result.data).toEqual({ answer: 'Booking Holdings Inc.' });
    expect(result.status).toBe('completed');
  });

  test('a finish whose every sub-goal failed is a failure report, sent back to extract (run_…)', async () => {
    // HarnessAB 2026-09-26, lab-flashlite-vision: the only goal was closed
    // failed ("Unable to retrieve scores due to CAPTCHA") in the reply that
    // finished with the summary below. Sent back, it extracted the real
    // scores from the results page and passed the judge.
    const h = harness({
      model: script(
        { action: click, envelope: { plan: [{ id: 'get-scores', goal: 'Retrieve IMDb and Metacritic scores' }] } },
        {
          action: { type: 'done', summary: 'The request resulted in a CAPTCHA. Sub-goal failed.' },
          envelope: { goal: { id: 'get-scores', status: 'failed', summary: 'Unable to retrieve scores due to CAPTCHA.' } },
        },
        { action: { type: 'extract', instruction: 'the scores' } },
      ),
      extract: () => ({ data: { answer: 'IMDb 8.8/10, Metacritic 74' } }),
    });
    const result = await runAgent(h.deps, { task: 't', caps: CAPS, schema: ANSWER_SCHEMA, stepFailures: 3, onStep: () => {} });

    expect(result.steps[1]?.error).toBe("done was declined: the schema's answer was never extracted");
    expect(result.data).toEqual({ answer: 'IMDb 8.8/10, Metacritic 74' });
  });
});

/**
 * IW17, production 2026-09-26 run_…: three clicks on a download link
 * charged as contradicted, then `server.get_file` — a name no port lists —
 * answered "no connected tool is named ...". That fourth consecutive failure
 * passed `stepFailures: 3` and ended the run `error` with an empty answer,
 * while the step's own error said the reply was "in the tool results block of
 * the next prompt". There was no next prompt.
 */
describe('a tool error reaches the model before it can end the run', () => {
  const getFile: Action = {
    type: 'callTool',
    tool: 'server.get_file',
    arguments: { url: 'https://the-internet.herokuapp.com/download/a.jpeg' },
  };
  const refusal = 'no connected tool is named "server.get_file". Call one of the names listed above, exactly as spelled.';
  const port: ToolPort = {
    list: () => [{ name: 'web.search', description: 'Search the web.' }],
    call: () => ({ text: refusal, isError: true }),
  };
  const clickFails = (action: Action): void => {
    if (action.type === 'click') throw new Error('the click changed nothing');
  };

  test('the reply is on the next prompt, and the model can still finish', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script({ action: click }, { action: click }, { action: click }, { action: getFile }, { action: done }),
    });

    const result = await runAgent({ ...h.deps, tools: port }, { task: 'download a file', caps: CAPS, stepFailures: 3 });

    expect(h.prompts[4]?.toolResults).toEqual([{ step: 3, tool: 'server.get_file', isError: true, text: refusal }]);
    expect(result.status).toBe('completed');
  });

  test('a failure after the reply was shown still ends the run: one step of grace, not a way round the bound', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script({ action: click }, { action: click }, { action: click }, { action: getFile }, { action: getFile }, { action: done }),
    });

    const result = await runAgent({ ...h.deps, tools: port }, { task: 'download a file', caps: CAPS, stepFailures: 3 });

    expect(h.prompts).toHaveLength(5);
    expect(h.prompts[4]?.toolResults?.[0]?.text).toBe(refusal);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
  });
});

/**
 * Stealth Bench 2026-10-06, `run_…` task 43: three `page.verify` calls
 * recorded only "reported an error; its reply is in the tool results block of
 * the next prompt", so why the check was not worked could not be read from the
 * run. The step now keeps the verdict and, when the port wrote one, its note;
 * never the reply's text, which may be a customer's mailbox.
 */
describe('a tool call leaves its verdict, and only its port\u2019s note, on the step', () => {
  const verify: Action = { type: 'callTool', tool: 'page.verify', arguments: {} };
  const read: Action = { type: 'callTool', tool: 'mail.search', arguments: { q: 'code' } };
  const port: ToolPort = {
    list: () => [
      { name: 'page.verify', description: 'Work the check.' },
      { name: 'mail.search', description: 'Search mail.' },
    ],
    call: (tool) =>
      tool === 'page.verify'
        ? { text: 'page.verify (1 of 3): no check is on the page.', isError: true, note: 'absent: no check is on the page.' }
        : { text: 'From: bank. Your code is 482913', isError: false },
  };

  test('a failed call keeps its note beside the error; a call with no note keeps its verdict and none of its text', async () => {
    const h = harness({ tree: page, model: script({ action: verify }, { action: read }, { action: done }) });

    const result = await runAgent({ ...h.deps, tools: port }, { task: 't', caps: CAPS, stepFailures: 3 });

    expect(result.steps[0]?.tool).toEqual({ isError: true, note: 'absent: no check is on the page.' });
    expect(result.steps[0]?.error).toContain('page.verify reported an error');
    expect(result.steps[1]?.tool).toEqual({ isError: false });
    expect(JSON.stringify(result.steps)).not.toContain('482913');
  });

  test('a note is cut to MAX_TOOL_NOTE_CHARS', async () => {
    const long: ToolPort = { ...port, call: () => ({ text: 'x', isError: false, note: 'n'.repeat(5_000) }) };
    const h = harness({ tree: page, model: script({ action: verify }, { action: done }) });

    const result = await runAgent({ ...h.deps, tools: long }, { task: 't', caps: CAPS, stepFailures: 3 });

    expect(result.steps[0]?.tool?.note).toHaveLength(MAX_TOOL_NOTE_CHARS);
  });
});

/**
 * BU Bench task 80, `run_…` (2026-10-14): page.verify solved a slider, then
 * could not read a pipe check twice, each reply saying "Reload the page once
 * and call this again". The model clicked the widget's Refresh instead, each
 * click contradicted, and error, contradiction, error, contradiction made four
 * and stopped the run with most of its budget left.
 */
describe('page.verify failing on a check that is on the page', () => {
  const verify: Action = { type: 'callTool', tool: SITE_CHECK_TOOL, arguments: {} };
  const ADVICE = 'the pipe check could not be read. Reload the page once and call this again, or reach the information another way.';
  const unreadable = (): Promise<SiteCheckResult> => Promise.resolve({ outcome: 'unreadable', detail: ADVICE, touched: false });
  const clickFails = (action: Action): void => {
    if (action.type === 'click') throw new Error('the click changed nothing');
  };

  test('is not charged to stepFailures, and the advised reload is done while calls remain', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script(
        { action: verify }, { action: click },
        { action: verify }, { action: click },
        { action: verify }, { action: click },
        { action: done },
      ),
    });

    const result = await runAgent(
      { ...h.deps, tools: siteCheckToolPort({ solve: unreadable }) },
      { task: 'search the store', caps: { ...CAPS, steps: 10 }, stepFailures: 3 },
    );

    expect(result.status).toBe('completed');
    // Reloaded after the first and second calls, where calls remained; not after the third.
    expect(h.performed.filter((action) => action.type === 'navigate')).toEqual([
      { type: 'navigate', url: page.url },
      { type: 'navigate', url: page.url },
    ]);
    expect(h.prompts[1]?.toolResults?.find((echo) => echo.step === 0)?.text).toContain('reloaded once for you');
    expect(h.prompts[5]?.toolResults?.find((echo) => echo.step === 4)?.text).toBe(`page.verify (3 of 3): ${ADVICE}`);
    expect(result.steps[0]?.tool?.note).toContain('reloaded once for you');
  });

  test('neither charges nor clears the count, so a page ignoring every click still stops the run', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script({ action: click }, { action: click }, { action: click }, { action: verify }, { action: click }, { action: done }),
    });

    const result = await runAgent(
      { ...h.deps, tools: siteCheckToolPort({ solve: unreadable }) },
      { task: 'search the store', caps: CAPS, stepFailures: 3 },
    );

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');
    expect(result.steps).toHaveLength(5);
  });

  test('a call that finds no check, or one past the limit, is charged as before', async () => {
    const port = siteCheckToolPort({
      maxCalls: 1,
      solve: () => Promise.resolve({ outcome: 'absent', detail: 'no check this tool knows is on the page.' }),
    });
    const absent = await port.call(SITE_CHECK_TOOL, {});
    const limit = await port.call(SITE_CHECK_TOOL, {});

    expect(absent.isError && absent.standingCheck === undefined).toBe(true);
    expect(limit.isError && limit.standingCheck === undefined).toBe(true);
  });
});

/**
 * code.run's machine being down (refused credentials, out of instances, an
 * outage) is the tool's outage, not the model failing: three failed clicks
 * and then two unavailable answers used to make five consecutive failures and
 * end a run that could carry on in the browser.
 */
describe('code.run when its machine is unavailable', () => {
  const code: Action = { type: 'callTool', tool: CODE_RUN_TOOL, arguments: { language: 'python', code: 'print(1)' } };
  const clickFails = (action: Action): void => {
    if (action.type === 'click') throw new Error('the click changed nothing');
  };
  const down = (): { port: ToolPort; asked: () => number } => {
    let asked = 0;
    const port = codeRunToolPort({
      runner: {
        run: () => {
          asked += 1;
          return Promise.reject(new CodeSandboxUnavailableError('the code sandbox could not run it, twice (503): no container instance'));
        },
      },
    });
    return { port, asked: () => asked };
  };

  test('is never the failure that ends the run, and after two in a row the machine is not asked again', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script(
        { action: click }, { action: click }, { action: click },
        { action: code }, { action: code }, { action: code },
        { action: done },
      ),
    });
    const { port, asked } = down();

    const result = await runAgent({ ...h.deps, tools: port }, { task: 't', caps: { ...CAPS, steps: 10 }, stepFailures: 3 });

    expect(result.status).toBe('completed');
    expect(asked()).toBe(2);
    const replies = [3, 4, 5].map((step) => h.prompts[step + 1]?.toolResults?.find((echo) => echo.step === step)?.text);
    expect(replies.every((text) => text?.endsWith('continue in the browser or with the web tools.'))).toBe(true);
  });

  test('neither charges nor clears the count, so a page ignoring every click still stops the run', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script({ action: click }, { action: click }, { action: click }, { action: code }, { action: click }, { action: done }),
    });

    const result = await runAgent({ ...h.deps, tools: down().port }, { task: 't', caps: CAPS, stepFailures: 3 });

    expect(result.stopReason).toBe('error');
    expect(result.steps).toHaveLength(5);
  });
});

/**
 * web.ask's answer engine failing (a 5xx, a rate limit, a timeout) is the
 * tool's outage on the same terms as code.run's machine: a brain retrying it
 * during an outage must not end a run that web.search could carry. Honoured
 * only from the tool's own name.
 */
describe('web.ask when its answer engine is unavailable', () => {
  const ask = (tool: string): Action => ({ type: 'callTool', tool, arguments: { question: 'which bridge?' } });
  const outage = (tool: string): ToolPort => ({
    list: () => [{ name: tool, description: 'ask' }],
    call: () => Promise.resolve({ isError: true, unavailable: true, text: `${tool} got no answer: HTTP 502 (unavailable).` }),
  });
  const clickFails = (action: Action): void => {
    if (action.type === 'click') throw new Error('the click changed nothing');
  };

  test('is never the failure that ends the run', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script(
        { action: click }, { action: click }, { action: click },
        { action: ask(WEB_ASK_TOOL) }, { action: ask(WEB_ASK_TOOL) }, { action: ask(WEB_ASK_TOOL) },
        { action: done },
      ),
    });

    const result = await runAgent({ ...h.deps, tools: outage(WEB_ASK_TOOL) }, { task: 't', caps: { ...CAPS, steps: 10 }, stepFailures: 3 });

    expect(result.status).toBe('completed');
  });

  test('the same reply from another tool is charged, and the run ends', async () => {
    const h = harness({
      tree: page,
      perform: clickFails,
      model: script({ action: click }, { action: click }, { action: click }, { action: ask('mail.search') }, { action: ask('mail.search') }, { action: done }),
    });

    const result = await runAgent({ ...h.deps, tools: outage('mail.search') }, { task: 't', caps: { ...CAPS, steps: 10 }, stepFailures: 3 });

    expect(result.stopReason).toBe('error');
  });
});

/**
 * 2026-10-13: whether a miss's brief had dropped what the page showed could
 * be learned only by recapturing the page, because no brief was stored. The
 * step now keeps the brief its decision was made on.
 */
describe('the brief a decision was made on is kept on its step', () => {
  const brief = { facts: 'Page: Results (chosen by rule)\nFacts: 2 of 9 listings shown | link "Red maple" [0-4]', elements: '[0-4] link "Red maple"' };

  test('a decided step keeps its brief, a step decided on none keeps none, and the wire step carries neither', async () => {
    const h = harness({ tree: page, model: script({ action: { type: 'scroll', dy: 400 }, brief }, { action: done }) });

    const result = await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 3 });

    expect(result.steps[0]?.brief).toEqual(brief);
    expect(result.steps[1]?.brief).toBeUndefined();
    expect(JSON.stringify(toWireStep(result.steps[0]!))).not.toContain('Red maple');
  });

  test('a brief longer than the record keeps is cut', async () => {
    const long = { facts: 'f'.repeat(9_000), elements: 'e'.repeat(9_000) };
    const h = harness({ tree: page, model: script({ action: { type: 'scroll', dy: 400 }, brief: long }, { action: done }) });

    const result = await runAgent(h.deps, { task: 't', caps: CAPS, stepFailures: 3 });

    expect(result.steps[0]?.brief?.facts).toHaveLength(MAX_STEP_BRIEF_CHARS.facts);
    expect(result.steps[0]?.brief?.elements).toHaveLength(MAX_STEP_BRIEF_CHARS.elements);
  });
});

describe('only the first listed action runs, and the next prompt says which did not', () => {
  const count = (text: string | undefined, needle: string): number => (text ?? '').split(needle).length - 1;

  test('the next prompt names the listed actions that did not run, never the performed one, and a later prompt drops them', async () => {
    const prompts: string[] = [];
    const scroll: Action = { type: 'scroll', dy: 600 };
    const h = harness({
      tree: page,
      model: (prompt, step) => {
        prompts.push(prompt.text);
        if (step === 0) {
          // The performed action listed again among the rest, as models do.
          return { action: click, alternatives: [click, { type: 'click', ref: widget }] };
        }
        return step === 1 ? { action: scroll } : { action: done };
      },
    });

    await runAgent(h.deps, { task: 'search', caps: CAPS, stepFailures: null, settle: false });

    expect(h.performed).toEqual([click, scroll]);
    // The page is the same on every prompt, so any extra mention is the loop's.
    // After step 0: the unperformed widget click is named once more than the page
    // names it; the performed search click only by its own history line.
    expect(count(prompts[1], '"Widget A"')).toBe(count(prompts[0], '"Widget A"') + 1);
    expect(count(prompts[1], '"Search"')).toBe(count(prompts[0], '"Search"') + 1);
    // After step 1, which listed nothing, that list is stale and not named.
    expect(count(prompts[2], '"Widget A"')).toBe(count(prompts[0], '"Widget A"'));
  });
});

describe('a refusal is not the page failing to answer', () => {
  const caps = { steps: 20, budget: '5.00', duration: '5m' };
  /** A host that refuses every click, naming the target `name(n)` on the n-th. */
  const refuses = (name: (n: number) => string) => {
    let n = 0;
    return (action: Action): void => {
      if (action.type === 'click') throw new RefusedActionError(`refused: ${name(n)}`, name(n++));
    };
  };

  test('refusals of different targets do not spend stepFailures, and the run goes on to finish', async () => {
    const h = harness({
      tree: page,
      perform: refuses((n) => `target ${String(n)}`),
      model: script(...Array.from({ length: 5 }, () => ({ action: click })), { action: done }),
    });
    const result = await runAgent(h.deps, { task: 'open it', caps, stepFailures: 3 });
    expect(result.steps.filter((step) => step.error !== undefined)).toHaveLength(5);
    expect(result.status).toBe('completed');
  });

  test('a target refused before is charged: the model was told and did it anyway', async () => {
    const h = harness({ tree: page, perform: refuses(() => 'the same target'), model: () => ({ action: click }) });
    const result = await runAgent(h.deps, { task: 'open it', caps, stepFailures: 3 });
    // The first refusal is free; the next four are charged, and the fourth charge is past the tolerance.
    expect(result.steps).toHaveLength(5);
    expect(result.stopReason).toBe('error');
  });

  test(`refusals with no completed step between them stop the run after ${String(REFUSED_STEP_TOLERANCE)}`, async () => {
    const h = harness({ tree: page, perform: refuses((n) => `target ${String(n)}`), model: () => ({ action: click }) });
    const result = await runAgent(h.deps, { task: 'open it', caps, stepFailures: 3 });
    expect(result.steps).toHaveLength(REFUSED_STEP_TOLERANCE + 1);
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe(`refused: target ${String(REFUSED_STEP_TOLERANCE)}`);
  });
});
