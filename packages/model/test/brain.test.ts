/**
 * Brain mode through the real port over a scripted provider: what reaches each
 * model, what the loop gets back, that the run ends only on the brain's word,
 * and that the brain's input stays inside its hard budgets. See `src/brain.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Clock } from '@outcrawl/scout-core';
import { CODE_RUN_TOOL, CODE_RUN_TOOL_DESCRIPTION, PAGE_SCRIPT_REPLY_MAX_CHARS, PAGE_SCRIPT_TOOL, PAGE_SCRIPT_TOOL_DESCRIPTION, codeRunToolPort, codeRunTools, hashSnapshot, nodeRef, pageScriptTools, renderPrompt, type AgentPrompt, type AxNode, type AxTree, type StepTrace, type ToolCallEcho } from '@outcrawl/runtime';

import { BRAIN_BUDGET, BRAIN_SCHEMA, BRAIN_SYSTEM_PROMPT, BrainThread, actionKey, repeatedActions, retryableNavigations, alreadyRead, reloadAsNavigate, briefElements, briefFacts, rankedReadGap, rawBrief, readBrief, readDecision, reconciledNavigate, redirectedSite, searchedBefore, selectBrief as selectBriefWithRefs, directAction, threadReply, unconfirmedSlot, wholeRead, wrongListItem, readWithConditions, comboboxMiss, factsBesideReads, listingVerdicts, toolReplies } from '../src/brain';
import { HarnessModelPort, type ModelPlan } from '../src/harness';
import { ModelClient } from '../src/client';
import { CostLedger } from '../src/ledger';
import { ModelProviderError } from '../src/provider';
import { BRAIN_MODEL as BRAIN, HANDS_MODEL as HANDS, FakeProvider, brainPlan, cartPage, node, promptFor, reply } from './support';

/**
 * A rule-chosen brief with each list item's title line as most tests read it:
 * without the ref the brief appends (`link "…" [F-N]`), tested on its own.
 */
const selectBrief = (...args: Parameters<typeof selectBriefWithRefs>): ReturnType<typeof selectBriefWithRefs> => {
  const brief = selectBriefWithRefs(...args);
  return { ...brief, facts: brief.facts.map((fact) => fact.replace(/^(link "(?:[^"\\]|\\.)*") \[[\w-]+\]$/u, '$1')) };
};

/** A brain at minimal effort over the hands chain. */
const PLAN = brainPlan({ effort: 'minimal' });

class StillClock implements Clock {
  now(): number {
    return 0;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

function brainPort(provider: FakeProvider, plan: ModelPlan = PLAN, rawView = false): { port: HarnessModelPort; ledger: CostLedger } {
  const ledger = new CostLedger();
  const port = new HarnessModelPort({
    plan,
    provider,
    session: { sessionId: 'sess_brain', accountId: 'acct_brain' },
    ledger,
    clock: new StillClock(),
    actionReasoning: { enabled: false },
    brainReasoning: { effort: 'low' },
    brainView: rawView ? 'raw-or-eyes' : 'eyes',
  });
  return { port, ledger };
}

// cartPage(10): root 0-10 "Cart", button 0-11 "Checkout", textbox 0-12 "Coupon".
const TREE = cartPage(10);

/** The same capture: a junk tag first, the decision after it. */
const DECISION_AFTER_TAGS: readonly string[] = [
  "The current tab is the 2019 report, which is the wrong year. I need the 2025 report in tab t0.\n\n\n<invoke>focusTab</invoke>\n</invoke>\n\nCorrection: reply must be JSON only.\n\n{\"do\":\"act\",\"a\":{\"type\":\"focusTab\",\"tab\":\"t0\"},\"need\":[\"Ridgeway Transit ridership figure for 2025\"],\"no\":\"2019 report is wrong year\",\"then\":[{\"read\":\"Ridership 2025 figure on the annual report\",\"expect\":\"2025 ridership figure shown\"}]}",
  "This page is an independent third-party site, not the bridge district, so I need the official source: goldengate.org.\n\n\n<invoke>navigate</invoke>\n</invoke>\n\n\n<invoke>\n</invoke>\n\n{\"do\":\"act\",\"a\":{\"type\":\"navigate\",\"url\":\"https://www.goldengate.org/bridge/tolls-fastrak/\"},\"need\":[\"Official Golden Gate Bridge district toll for 2-axle car with FasTrak\"],\"then\":[{\"read\":\"2-axle vehicle FasTrak toll rate\",\"expect\":\"toll rates table visible\"}]}",
  "\n<invoke name=\"a\">\n</invoke>\n</invoke>\n```json\n{\"do\":\"act\",\"a\":{\"type\":\"navigate\",\"url\":\"https://rubygems.org/gems/rails\"},\"then\":[{\"read\":\"current version number and release date at top of page\"}]}\n```",
  "\n<invoke name=\"do\">\n</invoke>\n```json\n{\"do\":\"act\",\"a\":{\"type\":\"fill\",\"ref\":\"45-114\",\"text\":\"19707\"},\"then\":[{\"a\":{\"type\":\"fill\",\"ref\":\"85-124\",\"text\":\"4242424242424242\"},\"expect\":\"card number filled\"},{\"say\":\"fill expiry date field with 08/31\",\"expect\":\"expiry filled\"},{\"a\":{\"type\":\"fill\",\"ref\":\"87-126\",\"text\":\"123\"},\"expect\":\"security code filled\"},{\"a\":{\"type\":\"fill\",\"ref\":\"88-127\",\"text\":\"Jordan Lee\"},\"expect\":\"name filled\"}]}\n```\n\nCorrection: output must be only the JSON object.\n\n\n<invoke name=\"do\">\n</invoke>\n\n\n<invoke name=\"do\">\n</invoke>\n\n\n<invoke name=\"do\">\n</invoke>\n\n{\"do\":\"act\",\"a\":{\"type\":\"fill\",\"ref\":\"45-114\",\"text\":\"19707\"},\"then\":[{\"a\":{\"type\":\"fill\",\"ref\":\"85-124\",\"text\":\"4242424242424242\"},\"expect\":\"card number filled\"},{\"say\":\"fill expiry date field with 08/31\",\"expect\":\"expiry filled\"},{\"a\":{\"type\":\"fill\",\"ref\":\"87-126\",\"text\":\"123\"},\"expect\":\"security code filled\"},{\"a\":{\"type\":\"fill\",\"ref\":\"88-127\",\"text\":\"Jordan Lee\"},\"expect\":\"name filled\"}]}",
];

const eyes = (elements: readonly { ref: string; role: string; label: string }[] = [{ ref: '0-11', role: 'button', label: 'Checkout' }]) =>
  reply(JSON.stringify({ page: 'A cart page with one item.', facts: ['Total: $12.00'], elements }), {}, '0.0001');
const brain = (decision: Record<string, unknown>) => reply(JSON.stringify(decision), {}, '0.002');
const hands = (actions: readonly Record<string, unknown>[], reasoning = 'doing it') =>
  reply(JSON.stringify({ reasoning, actions }), {}, '0.0001');

function trace(index: number, hash: string, extra: Partial<StepTrace> = {}): StepTrace {
  return {
    index,
    action: { type: 'click', ref: nodeRef(0, 11) },
    cache: { status: 'MISS' },
    elapsedMs: 1,
    snapshotHash: hash,
    credits: '0',
    spent: '0',
    pages: 1,
    durationMs: 1,
    usage: {},
    at: '2026-10-02T00:00:00.000Z',
    ...extra,
  } as unknown as StepTrace;
}

describe('a brain step', () => {
  /**
   * MUTATIONS THIS CATCHES: passing `prompt.text` or the tree to the brain;
   * calling the hands for a decision that runs directly; executing a ref the
   * eyes did not list.
   */
  test('a listed ref runs directly; the brain never sees the tree, only the brief', async () => {
    const provider = new FakeProvider([eyes(), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port, ledger } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));

    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, BRAIN]);
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
    const brainAsked = provider.requests[1];
    // The unlisted textbox is on the page and absent from everything the brain read.
    expect(`${brainAsked?.prompt ?? ''}${brainAsked?.tail ?? ''}`).not.toContain('Coupon');
    // The elements ride in the never-replayed tail, outside the cached prompt.
    expect(brainAsked?.tail).toContain('[0-11] button "Checkout"');
    expect(brainAsked?.prompt).not.toContain('[0-11]');
    expect(brainAsked?.reasoning).toEqual({ effort: 'low' });
    // The brain call alone is routed to the brain slot's upstream first; the eyes call is not.
    expect(brainAsked?.providerOrder).toEqual(['provider-a']);
    expect(provider.requests[0]?.providerOrder).toBeUndefined();
    expect(ledger.totalsFor('sess_brain').costUsd).toBe('0.0021');
  });

  /**
   * MUTATIONS THIS CATCHES: a decided step's choice without the brief the
   * brain read (the step record keeps it), and a page the thread already
   * holds recorded as the "unchanged" line instead of what was on it.
   */
  test('each decided step carries the brief the brain read, whole even when the thread was told it is unchanged', async () => {
    const provider = new FakeProvider([eyes(), brain({ do: 'act', a: { type: 'scroll', dy: 300 } }), eyes(), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider);
    const first = await port.choose(promptFor(TREE));
    const second = await port.choose(promptFor(TREE, 'check out', 1, [trace(0, hashSnapshot(TREE), { action: { type: 'scroll', dy: 300 } })]));

    expect(provider.requests[3]?.prompt).toContain('Page and facts: unchanged since your last turn.');
    for (const choice of [first, second]) {
      expect(choice.brief?.facts).toContain('Total: $12.00');
      expect(choice.brief?.elements).toContain('[0-11] button "Checkout"');
    }
  });

  test('a ref the eyes did not list is grounded by the hands on the full prompt', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'act', a: { type: 'fill', ref: '0-12', text: 'SAVE10' } }),
      hands([{ type: 'fill', ref: '0-12', text: 'SAVE10' }]),
    ]);
    const { port } = brainPort(provider);
    const prompt = promptFor(TREE);
    const choice = await port.choose(prompt);

    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, BRAIN, HANDS]);
    const handsAsked = provider.requests[2]?.prompt ?? '';
    expect(handsAsked.endsWith(prompt.text)).toBe(true);
    expect(handsAsked).toContain('## Decision for this step');
    expect(choice.action).toEqual({ type: 'fill', ref: nodeRef(0, 12), text: 'SAVE10' });
  });

  /**
   * MUTATION THIS CATCHES: a hands `done` or a final extract reaching the
   * loop without the brain deciding it — the exploratory-extract class.
   */
  test('the hands cannot end the run: a proposed done goes back to the brain, whose word stands', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'say', say: 'apply the coupon' }),
      hands([{ type: 'done', summary: 'looks finished' }]),
      brain({ do: 'done', answer: 'Checked out for $12.00' }),
    ]);
    const { port } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'done', summary: 'Checked out for $12.00' });
    expect(provider.requests[3]?.prompt).toContain('END THE RUN');
    // The re-decide is shown the elements again.
    expect(provider.requests[3]?.tail).toContain('[0-11] button "Checkout"');
  });

  /**
   * MUTATION THIS CATCHES: a "not confirmed" evidence entry reaching the done
   * action, where the answer and the step record would show it.
   */
  test('a done keeps only the evidence that cites what was read', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({
        do: 'done',
        answer: 'Checked out for $12.00',
        evidence: ['Order total $12.00, https://shop.example/checkout', 'not confirmed', 'Delivery Friday, Not confirmed on the page'],
      }),
    ]);
    const { port } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'done', summary: 'Checked out for $12.00', evidence: ['Order total $12.00, https://shop.example/checkout'] });
  });

  test('a done whose every evidence entry is not confirmed carries no evidence', async () => {
    const provider = new FakeProvider([eyes(), brain({ do: 'done', answer: 'Checked out for $12.00', evidence: ['not confirmed', 'not confirmed'] })]);
    const { port } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'done', summary: 'Checked out for $12.00' });
  });

  test('a hands extract is never final and always carries an instruction', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'say', say: 'read the order total' }),
      hands([{ type: 'extract', final: true }]),
    ]);
    const { port } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'extract', instruction: 'read the order total' });
  });

  test('a hands CANNOT goes back to the brain once with the reason', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'say', say: 'open the reviews tab' }),
      hands([{ type: 'scroll', dy: 400 }], 'CANNOT: there is no reviews tab on this page'),
      brain({ do: 'act', a: { type: 'navigate', url: 'https://shop.example.com/reviews' } }),
    ]);
    const { port } = brainPort(provider);
    const choice = await port.choose(promptFor(TREE));
    expect(provider.requests[3]?.prompt).toContain('there is no reviews tab on this page');
    expect(choice.action).toEqual({ type: 'navigate', url: 'https://shop.example.com/reviews' });
  });

  /**
   * MUTATION THIS CATCHES: brain mode being LESS than the plain hands model
   * when the brain is down — a swallowed failure with no action, or a held run.
   */
  test('a brain that does not answer is a plain hands step, done included', async () => {
    const provider = new FakeProvider([
      eyes(),
      new ModelProviderError({ status: 503, providerCode: 'http_503', message: 'down', retryable: true }),
      new ModelProviderError({ status: 503, providerCode: 'http_503', message: 'down', retryable: true }),
      hands([{ type: 'done', summary: 'finished' }]),
    ]);
    const { port } = brainPort(provider);
    const prompt = promptFor(TREE);
    const choice = await port.choose(prompt);
    expect(choice.action).toEqual({ type: 'done', summary: 'finished' });
    expect(provider.requests.at(-1)?.prompt).toBe(prompt.text);
  });

  test('another brain model runs the same port, on its own id', async () => {
    const provider = new FakeProvider([eyes(), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, brainPlan({ model: 'brain-model-2', effort: 'minimal' }));
    await port.choose(promptFor(TREE));
    expect(provider.requests.map((request) => request.model)).toEqual([HANDS, 'brain-model-2']);
  });
});

describe('a results page the run just opened', () => {
  // amazon run_0c9b82b8 (2026-10-03 10:44Z): step 0 opened these results; step 1 left them unread for a 4-stars-and-up filter.
  const TASK = "Go to amazon India and find the 3 best-rated gaming laptops with a dedicated NVIDIA or AMD graphics card under ₹80,000; give each one's price, GPU and rating.";
  const RESULTS = 'https://www.amazon.in/s?k=gaming+laptop+nvidia+rtx&rh=p_36%3A-8000000&s=review-rank';
  const FILTERED = 'https://www.amazon.in/s?k=gaming+laptop&rh=p_36%3A-8000000%2Cp_72%3A1318476031&s=review-rank';
  const page: AxTree = { ...cartPage(10), url: RESULTS };
  const opened = [trace(0, 'h0', { action: { type: 'navigate', url: RESULTS }, check: { verdict: 'confirmed', saw: `the browser is on ${RESULTS}`, expected: '', reads: 1, elapsedMs: 0 } } as Partial<StepTrace>)];

  /**
   * MUTATIONS THIS CATCHES: a counted-items task leaving its fresh results
   * page unread (2 of 3 found), the refusal applied twice (a brain that
   * insists must get its navigate), and it firing on a task that names no count.
   */
  test('is read before a navigate elsewhere on a task that asks for several items; once', async () => {
    const leave = brain({ do: 'act', a: { type: 'navigate', url: FILTERED } });
    const read = brain({ do: 'read', read: 'each result: title, price, GPU, rating' });
    const first = new FakeProvider([leave, read]);
    const choice = await brainPort(first, PLAN, true).port.choose(promptFor(page, TASK, 1, opened));
    expect(first.requests[1]?.prompt).toContain(`the results at ${RESULTS} were never read`);
    expect(choice.action.type).toBe('extract');

    const insists = new FakeProvider([leave, leave]);
    expect((await brainPort(insists, PLAN, true).port.choose(promptFor(page, TASK, 1, opened))).action).toEqual({ type: 'navigate', url: FILTERED });

    const uncounted = new FakeProvider([leave]);
    expect((await brainPort(uncounted, PLAN, true).port.choose(promptFor(page, 'Go to amazon India and find a gaming laptop under ₹80,000', 1, opened))).action).toEqual({ type: 'navigate', url: FILTERED });
    expect(uncounted.calls).toBe(1);
  });
});

describe('a searchable dropdown filled and entered', () => {
  const field = (value: string) => node({ role: 'combobox', name: 'State', value, xpath: '/f', backendNodeId: 405 });
  const form = (value: string, shown: readonly string[]): AxTree => ({
    url: 'https://demoqa.com/automation-practice-form',
    root: node({ role: 'RootWebArea', name: 'Practice Form', xpath: '/html', backendNodeId: 1, children: [field(value), ...shown.map((name, i) => node({ role: 'StaticText', name, xpath: `/t${String(i)}`, backendNodeId: 500 + i }))] }),
  });
  const ref = { frameOrdinal: 0, backendNodeId: 405 };
  const typed = (text: string): StepTrace[] => [
    trace(0, 'h0', { action: { type: 'fill', ref, text } } as Partial<StepTrace>),
    trace(1, 'h1', { action: { type: 'press', key: 'Enter', ref } } as Partial<StepTrace>),
  ];
  const at = (tree: AxTree, history: StepTrace[]): AgentPrompt => promptFor(tree, 'select state NCR and city Delhi', 2, history);

  /**
   * MUTATIONS THIS CATCHES: a fill+Enter that picked another option accepted
   * silently ("Delhi" -> "New Delhi"), a correct pick flagged, a search box
   * whose Enter submitted the text flagged, and the miss never reaching the brain.
   */
  test('is checked: the typed value must show as its own text, else the brain is told', async () => {
    expect(comboboxMiss(at(form('', ['NCR']), typed('NCR')))).toBeUndefined();
    expect(comboboxMiss(at(form('', ['New Delhi']), typed('Delhi')))).toContain('does not show "Delhi" picked');
    expect(comboboxMiss(at(form('Delhi', []), typed('Delhi')))).toBeUndefined();

    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-405' } })]);
    await brainPort(provider, PLAN, true).port.choose(at(form('', ['New Delhi']), typed('Delhi')));
    expect(provider.requests[0]?.prompt).toContain('does not show "Delhi" picked');
  });
});

describe('a brain action written with the template letter', () => {
  /**
   * MUTATIONS THIS CATCHES: a brain ref written "F-0-11" (the template's
   * letter, demoqa sess_c6d888b6) treated as unlisted and sent to the hands
   * with the letter in their guidance, for itself and for a queued step.
   */
  test('runs directly as the printed reference, queued steps too, with no hands call', async () => {
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: 'F-0-11' }, then: [{ a: { type: 'fill', ref: '[F-0-12]', text: 'SAVE10' }, expect: 'coupon typed' }] })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
    expect(provider.requests.map((request) => request.model)).toEqual([BRAIN]);
    const next = await port.choose(promptFor(TREE, 'check out', 1, [trace(0, 'h0', { action: { type: 'click', ref: nodeRef(0, 11) }, check: { verdict: 'confirmed', saw: 'ok', expected: '', reads: 1, elapsedMs: 0 } } as Partial<StepTrace>)]));
    expect(next.action).toEqual({ type: 'fill', ref: nodeRef(0, 12), text: 'SAVE10' });
    expect(provider.calls).toBe(1);
  });
});

describe('the facts line beside a read of the same page', () => {
  /**
   * MUTATIONS THIS CATCHES: listings kept twice in the thread (the brief and
   * the read of the same page), a fact the read does not hold dropped, the
   * page line dropped, and facts of another page's read touched.
   */
  test('drops only the facts the read already holds, says so, and keeps the rest', () => {
    const facts = 'Page: Amazon.in : gaming laptop (chosen by rule)\nFacts: 1-16 of over 2,000 results | link "Acer ALG Gaming Laptop Intel Core i5-12450H, NVIDIA RTX 3050 6GB" | ₹56,990 | link "4.1 out of 5 stars, rating details" | Delivering to Mumbai 400001';
    const read = [{ text: 'extracted on https://www.amazon.in/s?k=gaming+laptop: "Acer ALG Gaming Laptop Intel Core i5-12450H, NVIDIA RTX 3050 6GB — ₹56,990 — 4.1 out of 5 stars, rating details"' }];
    const out = factsBesideReads(facts, 'https://www.amazon.in/s?k=gaming+laptop', read, []);
    expect(out).toContain('Page: Amazon.in : gaming laptop');
    expect(out).not.toContain('link "Acer ALG');
    expect(out).toContain('1-16 of over 2,000 results');
    expect(out).toContain('Delivering to Mumbai 400001');
    expect(out).toContain('(2 more already in your read of this page)');
    expect(factsBesideReads(facts, 'https://www.amazon.in/s?k=other', read, [])).toBe(facts);
  });

  /**
   * MUTATIONS THIS CATCHES: a spec-table label the read only names dropped
   * while its value stays, so the value reads as the row before's (tainted
   * sealed item via Main, 2026-10-05: "Battery life" gone, its hours under
   * "Weight"); a label whose value the read holds too kept.
   */
  test('keeps a label the read names while the value under it stays', () => {
    const facts = 'Page: Nimbus 6 specifications (the whole page, read directly)\nFacts: Weight | 172 g | Battery life | Up to 31 hours video playback | Water resistance | IP68 rated to 6 metres';
    const read = [{ text: 'extracted on https://nimbus.example/specs: "Weight: 172 g. Battery life: listed further down. Water resistance: IP68 rated to 6 metres"' }];
    const out = factsBesideReads(facts, 'https://nimbus.example/specs', read, []);
    expect(out).toContain('172 g | Battery life | Up to 31 hours video playback');
    expect(out).not.toContain('Water resistance');
    expect(out).not.toContain('IP68 rated to 6 metres');
  });
});

describe('a small page goes to the brain as is', () => {
  /**
   * MUTATIONS THIS CATCHES: an eyes call on a page that fits the raw view
   * (owner lever 2), or a raw view that drops an element or its state.
   */
  test('no eyes call; every element, with its state, is the brief', async () => {
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE));
    expect(provider.requests.map((request) => request.model)).toEqual([BRAIN]);
    expect(provider.requests[0]?.tail).toContain('[0-11] button "Checkout"');
    expect(provider.requests[0]?.tail).toContain('[0-12] textbox "Coupon" = empty');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
  });
});

describe('the brain can queue steps that need no new decision', () => {
  /**
   * MUTATIONS THIS CATCHES: a queued step that still calls the brain (no
   * saving), a queued step run after a failed one, or the brain never told
   * what its queued steps did.
   */
  test('a queued step runs with no model call; the brain then sees what it did and what it expected', async () => {
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'click', ref: '0-11' }, then: [{ a: { type: 'fill', ref: '0-12', text: 'SAVE10' }, expect: 'coupon typed' }] }),
      brain({ do: 'done', answer: 'done' }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = promptFor(TREE);
    await port.choose(first);
    const ok0 = trace(0, first.snapshotHash, { check: { verdict: 'confirmed', saw: 'the page changed' } } as Partial<StepTrace>);
    const second = promptFor(TREE, 'check out', 1, [ok0]);
    const queued = await port.choose(second);
    expect(provider.requests).toHaveLength(1);
    expect(queued.action).toEqual({ type: 'fill', ref: nodeRef(0, 12), text: 'SAVE10' });

    const ok1 = trace(1, second.snapshotHash, { action: { type: 'fill', ref: nodeRef(0, 12), text: 'SAVE10' }, check: { verdict: 'confirmed', saw: 'the field reads "SAVE10"' } } as unknown as Partial<StepTrace>);
    await port.choose(promptFor(TREE, 'check out', 2, [ok0, ok1]));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.prompt).toContain('Since your last turn:');
    expect(provider.requests[1]?.prompt).toContain('You expected: coupon typed');
  });

  test('a failed step drops the queue and the brain decides', async () => {
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'click', ref: '0-11' }, then: [{ a: { type: 'fill', ref: '0-12', text: 'SAVE10' }, expect: 'typed' }] }),
      brain({ do: 'act', a: { type: 'fill', ref: '0-12', text: 'SAVE10' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = promptFor(TREE);
    await port.choose(first);
    const failed = trace(0, first.snapshotHash, { error: 'click(0-11) failed: element is covered' });
    await port.choose(promptFor(TREE, 'check out', 1, [failed]));
    expect(provider.requests).toHaveLength(2);
    // And the failed action is named as one that will not run again unchanged.
    expect(provider.requests[1]?.prompt).toContain('FAILED: click 0-11');
  });

  /**
   * IW21's shape (2026-10-04 probes, run_997f84d5 and run_664f11cb): the brain
   * navigated and queued a page-level Escape; the page it landed on was a
   * 1-node document still parsing after the whole 10 s settle, and the queued
   * press ran on it blind, changed nothing, and lost the task.
   *
   * MUTATIONS THIS CATCHES: a queued step run on a page the settle called
   * unrendered; the rest of the queue kept and run on the next step; the
   * brain not told the queue was dropped.
   */
  test('a queued step does not run on a page the settle called unrendered; the brain decides', async () => {
    const provider = new FakeProvider([
      brain({
        do: 'act',
        a: { type: 'navigate', url: 'https://the-internet.herokuapp.com/key_presses' },
        then: [{ a: { type: 'press', key: 'Escape' }, expect: 'result text shows Escape' }, { read: 'the result text' }],
      }),
      brain({ do: 'act', a: { type: 'wait', seconds: 3 } }),
      brain({ do: 'act', a: { type: 'wait', seconds: 5 } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = promptFor(TREE, 'press Escape and report the text');
    await port.choose(first);
    const parsing: AxTree = { url: 'https://the-internet.herokuapp.com/key_presses', root: node({ role: 'RootWebArea', name: '', xpath: '/html', backendNodeId: 1 }) };
    const navigated = trace(0, first.snapshotHash, {
      action: { type: 'navigate', url: 'https://the-internet.herokuapp.com/key_presses' },
      check: { verdict: 'confirmed', saw: 'the browser is on https://the-internet.herokuapp.com/key_presses' },
    } as unknown as Partial<StepTrace>);
    const unrendered = {
      ...promptFor(parsing, 'press Escape and report the text', 1, [navigated]),
      unrendered: { verdict: 'unrendered', waitedMs: 10005, polls: 12, nodes: 1, chars: 0, parsingMs: 10002 },
    } as unknown as AgentPrompt;
    const choice = await port.choose(unrendered);
    expect(choice.action).toEqual({ type: 'wait', seconds: 3 });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.prompt).toContain('2 queued NOT run: page unrendered after 10.0s');
    // Dropped, not postponed: the page renders, and the brain decides again.
    const waited = trace(1, unrendered.snapshotHash, { action: { type: 'wait', seconds: 3 } } as unknown as Partial<StepTrace>);
    const next = await port.choose(promptFor(parsing, 'press Escape and report the text', 2, [navigated, waited]));
    expect(provider.requests).toHaveLength(3);
    expect(next.action).toEqual({ type: 'wait', seconds: 5 });
  });
});

describe('a big page can be chosen by rule instead of by the eyes', () => {
  /** MUTATIONS THIS CATCHES: a rule view that drops the search box, the paging control or the task's match. */
  test('fields, paging and the task-matching elements are kept within the budget; the rest are counted', () => {
    const filler = Array.from({ length: 80 }, (_, i) => node({ role: 'link', name: `Unrelated category ${String(i)} with a long name`, xpath: `/f${String(i)}`, backendNodeId: 500 + i }));
    const tree: AxTree = {
      url: 'https://shop.example.com/search',
      root: node({
        role: 'RootWebArea',
        name: 'Results',
        xpath: '/html',
        backendNodeId: 1,
        children: [
          ...filler.slice(0, 40),
          node({ role: 'searchbox', name: 'Search', xpath: '/s', backendNodeId: 2 }),
          node({ role: 'link', name: 'ASUS TUF gaming laptop - $899.99', xpath: '/a', backendNodeId: 3 }),
          ...filler.slice(40),
          node({ role: 'link', name: 'Next page', xpath: '/n', backendNodeId: 4 }),
        ],
      }),
    };
    const brief = selectBrief(tree, 'Find the cheapest gaming laptop');
    const refs = brief.elements.map((element) => element.ref);
    expect(refs).toContain('0-2');
    expect(refs).toContain('0-3');
    expect(refs).toContain('0-4');
    expect(briefElements(tree, brief).length).toBeLessThanOrEqual(BRAIN_BUDGET.elements);
    expect(brief.page).toContain(`of ${String(83)} elements`);
  });

  /** MUTATIONS THIS CATCHES: a long list shown without its extent or its end, and "187 comments" taken for paging (H1). */
  test('a long numbered list keeps its extent, its end and its paging link, and names what each line belongs to', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [
      node({ role: 'StaticText', name: `${String(i + 1)}.`, xpath: `/r${String(i)}`, backendNodeId: 10000 + i * 4 }),
      node({ role: 'link', name: `Story number ${String(i + 1)} about something`, xpath: `/t${String(i)}`, backendNodeId: 10001 + i * 4 }),
      node({ role: 'StaticText', name: `${String(100 + i)} points by`, xpath: `/p${String(i)}`, backendNodeId: 10002 + i * 4 }),
      node({ role: 'link', name: `${String(10 + i)} comments`, xpath: `/c${String(i)}`, backendNodeId: 10003 + i * 4 }),
    ]).flat();
    const tree: AxTree = {
      url: 'https://news.example.com/',
      root: node({
        role: 'RootWebArea',
        name: 'News',
        xpath: '/html',
        backendNodeId: 1,
        children: [...rows, node({ role: 'link', name: 'More', xpath: '/m', backendNodeId: 9 })],
      }),
    };
    const brief = selectBrief(tree, 'list the titles of the stories ranked 61 to 65');
    expect(brief.page).toContain('numbered items 1-60 on this page');
    expect(brief.elements.map((element) => element.ref)).toContain('0-9');
    expect(brief.facts).toContain('60.');
    expect(brief.facts).toContain('link "Story number 1 about something"');
    expect(brief.facts.some((fact) => /lines not shown/.test(fact))).toBe(true);
  });

  /**
   * MUTATIONS THIS CATCHES: a list page's prices dropped into "+N unlisted"
   * while their titles are listed, and a title kept without the item it
   * heads. A REAL tree: amazon.in results captured through production.
   */
  test('a real results page keeps each listed product beside its price, in the elements and in the text', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'amazon-in-search-tree.json'), 'utf8')) as { readonly tree: AxTree };
    const tree = fixture.tree;
    const brief = selectBrief(tree, 'Find the cheapest 1TB NVMe SSD on Amazon India and give its price.');
    const price = /₹\s?\d/;
    const title = (label: string): boolean => /\b1TB\b|\bSSD\b/i.test(label) && !price.test(label) && label.split(/\s+/).length >= 4;
    // Each listed product's price follows it, before the next product.
    const runs: string[][] = [];
    for (const element of brief.elements) {
      if (element.role === 'link' && title(element.label)) runs.push([]);
      else runs.at(-1)?.push(element.label);
    }
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) expect(run.some((label) => price.test(label))).toBe(true);
    // So does the text: a product line, then its price, before the next.
    const facts = brief.facts.filter((fact) => !/lines not shown|^…$/.test(fact));
    const items: string[][] = [];
    for (const fact of facts) {
      if (/^link "/.test(fact) && title(fact)) items.push([]);
      else items.at(-1)?.push(fact);
    }
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) expect(item.some((fact) => price.test(fact))).toBe(true);
    expect(briefElements(tree, brief).length).toBeLessThanOrEqual(BRAIN_BUDGET.elements);
  });

  /**
   * MUTATION THIS CATCHES: the attribute a listing states under its title
   * (sharing no word with the task) cut while the title is kept, so the brain
   * can pick the listing but not answer from it.
   */
  test("a kept listing keeps the line under its title, and listings drop whole from the bottom", () => {
    const listings = Array.from({ length: 12 }, (_, i) => [
      node({ role: 'link', name: `Harbour View Apartment number ${String(i + 1)}`, xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 4 }),
      node({ role: 'StaticText', name: `Check-in from ${String(13 + (i % 5))}:00`, xpath: `/a${String(i)}`, backendNodeId: 1001 + i * 4 }),
      node({ role: 'StaticText', name: i === 3 ? 'Dogs welcome in every room' : 'No animals', xpath: `/c${String(i)}`, backendNodeId: 1002 + i * 4 }),
    ]).flat();
    const tree: AxTree = {
      url: 'https://stays.example.com/search',
      root: node({ role: 'RootWebArea', name: 'Stays in Porto', xpath: '/html', backendNodeId: 1, children: listings }),
    };
    const brief = selectBrief(tree, 'Which apartment allows pets, and when is its check-in time?');
    const shown = brief.facts;
    for (let i = 0; i < 12; i += 1) {
      const at = shown.indexOf(`link "Harbour View Apartment number ${String(i + 1)}"`);
      if (at >= 0) expect(shown[at + 1]).toBe(`Check-in from ${String(13 + (i % 5))}:00`);
    }
    expect(shown).toContain('link "Harbour View Apartment number 4"');
    const kept = Array.from({ length: 12 }, (_, i) => shown.includes(`link "Harbour View Apartment number ${String(i + 1)}"`));
    expect(kept.filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  /** Five job listings, the 4th the only one meeting the task; `lines(i)` gives listing i's lines after its title. */
  const jobs = (lines: (i: number) => readonly string[], title: (i: number) => string): AxTree => ({
    url: 'https://jobs.example.com/search?q=data+engineer',
    root: node({
      role: 'RootWebArea',
      name: 'Jobs: data engineer',
      xpath: '/html',
      backendNodeId: 1,
      children: Array.from({ length: 5 }, (_, i) => [
        node({ role: 'link', name: title(i), xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 10 }),
        ...lines(i).map((name, k) => node({ role: 'StaticText', name, xpath: `/l${String(i)}-${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
      ]).flat(),
    }),
  });

  /**
   * MUTATION THIS CATCHES: items kept whole in rank order, so with flat
   * match scores and a tight budget three fill it and the 4th, the
   * qualifier, shows nothing (sealed item on ff0a26ea, BrainMeasure
   * 2026-10-03).
   */
  test('every listing shows its title and its best matching line before any listing shows more', () => {
    const tree = jobs(
      (i) => [`Salary €${String(60 + i * 5)},000 a year`, 'Lisbon office, three days a week on site', `Posted ${String(i + 2)} days ago by the hiring team`, `Visa sponsorship: tier ${String(i === 3 ? 2 : 1)}`],
      (i) => `Senior Data Engineer, Platform team ${String.fromCharCode(65 + i)}`,
    );
    const brief = selectBrief(tree, 'Which Lisbon listing offers visa sponsorship, and what does it pay?');
    const listings = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const fact of brief.facts) {
      if (fact.startsWith('link "Senior Data Engineer')) listings.set(fact, (current = []));
      else current?.push(fact);
    }
    for (let i = 0; i < 5; i += 1) {
      expect(listings.get(`link "Senior Data Engineer, Platform team ${String.fromCharCode(65 + i)}"`)).toContain(`Visa sponsorship: tier ${String(i === 3 ? 2 : 1)}`);
    }
  });

  /**
   * MUTATION THIS CATCHES: a task word counted where its line negates it
   * ("Not remote", "Remote: no", "no remote work") or where its date fails
   * the task's bound (a closing date before the one asked), so every
   * listing matched as well as the qualifier and it ranked 4th of 5.
   */
  test('a listing matches only where it satisfies the task: negated terms and dates on the wrong side of a bound do not count', () => {
    const status = ['Not remote', 'Remote: no', 'Fully remote', 'Remote-first team', 'On-site only, no remote work'];
    const closes = ['30 October 2026', '28 October 2026', '3 October 2026', '30 October 2026', '29 October 2026'];
    const tree = jobs(
      (i) => [status[i]!, `Applications close ${closes[i]!}`, `Lisbon · Data Engineer · ${String(i + 1)}`, `Pays ${String(60 + i * 5)},000 euros a year`],
      (i) => `Data Engineer opening ${String.fromCharCode(65 + i)}`,
    );
    const brief = selectBrief(tree, 'Find a remote data engineer job in Lisbon with applications closing after 15 October 2026, and give its salary.');
    // The qualifier (D) ranks first, so it is the one shown whole: its
    // salary is there, and the listing failing on its closing date (C, the
    // only other "remote" one counted as present) gets no more than its head.
    expect(brief.facts).toContain('Pays 75,000 euros a year');
    expect(brief.facts).not.toContain('Pays 70,000 euros a year');
  });

  /**
   * MUTATIONS THIS CATCHES: lines chosen for the brief but cut unseen by
   * `briefFacts` (the choice counted lines, not its gap markers or the page
   * line: 31 of 63 rule-chosen dev briefs, 2026-10-03), and a page's footer
   * displacing its one answer line once the count is honest (dev2 X5).
   */
  test('every line a chosen brief keeps is rendered, and the answer line is kept over the footer', () => {
    // Scattered matches: every kept line sits between lines not shown, so the
    // gap markers cost as much as the lines.
    const lines = [
      ...Array.from({ length: 9 }, (_, i) => [
        `Tier ${String(i + 1)} seating: ${String(2000 + i * 150)} seats`,
        'Concourse, food and family areas.',
        'Accessible entrances on every side.',
        'Bag policy applies to all events.',
      ]).flat(),
      'Total seating capacity for league matches: 37,722',
      'Concourse, food and family areas.',
      'Accessible entrances on every side.',
      'Bag policy applies to all events.',
      '© 2026 Harbor City FC. All rights reserved.',
    ];
    const tree: AxTree = {
      url: 'https://club.example.com/stadium',
      root: node({
        role: 'RootWebArea',
        name: 'Harbor Stadium | Harbor City FC',
        xpath: '/html',
        backendNodeId: 1,
        children: lines.map((name, i) => node({ role: 'StaticText', name, xpath: `/l${String(i)}`, backendNodeId: 100 + i })),
      }),
    };
    const brief = selectBrief(tree, "What is the seating capacity of Harbor Stadium? Check the stadium's own site and the club's page.");
    const rendered = briefFacts(brief, undefined);
    for (const fact of brief.facts) expect(rendered).toContain(fact.length > 160 ? fact.slice(0, 120) : fact);
    expect(rendered).toContain('Total seating capacity for league matches: 37,722');
  });

  /** MUTATION THIS CATCHES: a copyright or cookie footer chosen for the brief over the page's lines (17 of 146 dev briefs, 2026-10-03). */
  test('legal and cookie boilerplate is not chosen unless the task names it', () => {
    const lines = [
      'Branch 12 opens at 9 am on weekdays.',
      ...Array.from({ length: 30 }, (_, i) => `Our staff in team ${String.fromCharCode(65 + (i % 26))} are happy to help with accounts, loans and savings questions.`),
      'We use cookies to improve your experience.',
      'Privacy policy',
      '© 2026 Northgate Savings Bank. All rights reserved.',
    ];
    const tree: AxTree = {
      url: 'https://bank.example.com/branches',
      root: node({ role: 'RootWebArea', name: 'Branches | Northgate Savings Bank', xpath: '/html', backendNodeId: 1, children: lines.map((name, i) => node({ role: 'StaticText', name, xpath: `/l${String(i)}`, backendNodeId: 100 + i })) }),
    };
    const boilerplate = /©|cookies|Privacy policy/;
    expect(selectBrief(tree, 'When does branch 12 open on weekdays?').facts.filter((fact) => boilerplate.test(fact))).toEqual([]);
    expect(selectBrief(tree, 'What does the all rights reserved notice on this page say?').facts).toContain('© 2026 Northgate Savings Bank. All rights reserved.');
  });

  /** Listings as a flat results page: each a title link and its lines. */
  const listingPage = (name: string, listings: readonly (readonly [string, readonly string[]])[]): AxTree => ({
    url: 'https://results.example.com/',
    root: node({
      role: 'RootWebArea',
      name,
      xpath: '/html',
      backendNodeId: 1,
      children: listings.flatMap(([title, lines], i) => [
        node({ role: 'link', name: title, xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 10 }),
        ...lines.map((line, k) => node({ role: 'StaticText', name: line, xpath: `/l${String(i)}-${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
      ]),
    }),
  });
  /** The lines a brief shows under a title, up to the next title link. */
  const shownUnder = (facts: readonly string[], title: string): readonly string[] | undefined => {
    // A title the brief shortened to fit ("Personalized Leather Wallet,…") is still its title.
    // Not a whole shorter title that starts the same ("… number 1" for "… number 10").
    const at = facts.findIndex((fact) => fact.startsWith('link "') && (fact.slice(6, -1) === title || (fact.endsWith('…"') && title.startsWith(fact.slice(6, -2)))) && fact.length > 12);
    if (at < 0) return undefined;
    // The next title: a link naming something, not a value ("₹11,000", "20 ratings").
    const next = facts.findIndex((fact, index) => index > at && /^link "/.test(fact) && fact.split(/\s+/).length >= 4 && !/[$€£¥₹]\s?\d|stars|ratings/.test(fact));
    return facts.slice(at + 1, next < 0 ? undefined : next);
  };

  /**
   * The tainted sealed list pages via Main (2026-10-05; a frontier brain model 8/8 misses on
   * the same briefs). MUTATIONS THIS CATCHES: a failing listing shown
   * unmarked in facts or in its element; a qualifier marked failing.
   */
  test('a cut list marks each failing listing it shows with the condition it fails, in facts and on its element', () => {
    const boards: readonly [string, boolean, number, number][] = [
      ['Ardent', true, 4.4, 89], ['Bramble', false, 4.9, 79], ['Corvid', true, 4.9, 149], ['Dunlin', true, 4.5, 109], ['Egret', false, 4.8, 69], ['Finch', true, 4.3, 99],
      ['Grebe', true, 4.9, 189], ['Heron', false, 4.7, 59], ['Ibis', true, 4.6, 115], ['Kestrel', true, 4.8, 112], ['Lark', true, 4.2, 84], ['Merlin', false, 4.9, 95],
      ['Nuthatch', true, 4.9, 129], ['Oriole', true, 4.1, 79],
    ];
    const tree = listingPage(
      'Results',
      boards.map(([name, hot, rating, price], i) => [`${name} mechanical keyboard`, [hot ? 'Hot-swappable switches' : 'Soldered switches', `${rating.toFixed(1)} out of 5 stars`, `${String(60 + i * 41)} ratings`, `$${String(price)}.00`, 'Ships free, arrives in 2-4 business days from the regional warehouse']]),
    );
    const brief = selectBriefWithRefs(tree, 'Find the best-rated mechanical keyboard with hot-swappable switches for under $120.');
    const titles = brief.facts.filter((fact) => fact.startsWith('link "'));
    expect(titles.find((fact) => fact.includes('Corvid'))).toEndWith('(fails: under $120)');
    expect(titles.find((fact) => fact.includes('Kestrel'))).not.toContain('fails');
    expect(briefElements(tree, brief)).toMatch(/\[0-1020\] link "Corvid[^"]*" fails: under \$120/u);
  });

  /**
   * The tainted sealed shape via Main (2026-10-05, 6/12 to 0/12 on
   * 86958218). MUTATIONS THIS CATCHES: a "Storage: 512 GB" line meeting
   * "at least 16 GB of RAM", so 8 GB laptops show unmarked; a memory line in
   * MB not judged; the note saying 0 shown fail when some were never
   * checked against a condition.
   */
  test("a bound on one attribute is judged on that attribute's label line, and the note never claims a check it did not make", () => {
    const laptops: readonly [string, string, string, number, number][] = [
      ['Orbit', 'Memory: 8 GB', 'Storage: 512 GB SSD', 4.8, 649], ['Pulse', 'Memory: 16 GB', 'Storage: 1 TB HDD', 4.7, 599], ['Vista', 'Memory: 8192 MB', 'Storage: 256 GB SSD', 4.9, 579],
      ['Ridge', 'Memory: 16 GB', 'Storage: 512 GB SSD', 4.3, 749], ['Kite', 'Memory: 16384 MB', 'Storage: 512 GB SSD', 4.6, 829], ['Comet', 'Memory: 16 GB', 'Storage: 256 GB SSD', 4.4, 699],
      ['Delta', 'Memory: 8 GB', 'Storage: 1 TB SSD', 4.8, 719], ['Quill', 'Memory: 4 GB', 'Storage: 128 GB SSD', 4.9, 399], ['Arc', 'Memory: 16 GB', 'Storage: 2 TB HDD', 4.8, 689],
      ['Lumen', 'Memory: 16 GB', 'Storage: 512 GB SSD', 4.2, 679], ['Ember', 'Memory: 12 GB', 'Storage: 512 GB SSD', 4.7, 629], ['Halo', 'Memory: 32 GB', 'Storage: 1 TB SSD', 4.9, 1349],
      ['Sable', 'Memory: 16 GB', 'Storage: 256 GB SSD', 4.1, 589], ['Tern', 'Memory: 8 GB', 'Storage: 256 GB SSD', 4.6, 499],
    ];
    const tree = listingPage('Results', laptops.map(([name, memory, storage, rating, price]) => [`${name} laptop with backlit keyboard`, [memory, storage, `${rating.toFixed(1)} out of 5 stars`, `$${String(price)}.00`]]));
    const facts = selectBriefWithRefs(tree, 'Find the best-rated laptop with at least 16 GB of RAM and an SSD for under $900.').facts;
    // Every 8 GB, 8192 MB, 4 GB and 12 GB laptop shown is marked; none is said to meet the task unmarked.
    for (const name of ['Orbit', 'Vista', 'Delta', 'Quill', 'Ember', 'Tern']) {
      const line = facts.find((fact) => fact.startsWith(`link "${name} laptop`));
      expect(line === undefined || line.includes('(fails: at least 16 GB')).toBe(true);
    }
    expect(facts.find((fact) => fact.startsWith('link "Kite laptop'))).not.toContain('fails');
  });

  /**
   * MUTATIONS THIS CATCHES: a shipping threshold or a discount inside a
   * sentence read as a listing's price, so "Free shipping on orders over
   * $35" meets "under $120" for a $149 card and the note counts it as
   * meeting the task (dev, 2026-10-05); a listing's own price no longer judged.
   */
  test("a threshold or discount in a card's sentence is not its price", () => {
    const tree = listingPage(
      'Results',
      Array.from({ length: 30 }, (_, i) => [`Keyboard model K-${String(100 + i)} mechanical keyboard`, ['Hot-swappable switches', `$${String(i % 2 === 0 ? 149 + i : 89 + i)}.00`, 'Free shipping on orders over $35', 'Save $10 with code KEYS10']] as const),
    );
    const facts = selectBriefWithRefs(tree, 'Find a mechanical keyboard with hot-swappable switches for under $120.').facts;
    // Each card's own price decides it: every $149+ card shown is marked failing, every $89+ one is not.
    const cards = facts.flatMap((fact, at) => (fact.startsWith('link "Keyboard model') ? [{ fact, price: Number(/^\$(\d+)\.00$/u.exec(facts.slice(at + 1, at + 4).find((line) => /^\$\d+\.00$/u.test(line)) ?? '')?.[1]) }] : []));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect([card.price, card.fact.includes('(fails: under $120)')]).toEqual([card.price, card.price >= 120]);
    expect(facts[0]).toMatch(/fails? a condition the task states/u);
  });

  /**
   * MUTATION THIS CATCHES: a task figure split at its comma ("80,000" the
   * word "000"), so every listing naming a figure over 999 ("£3,000") matches
   * the task once more and outranks the cheapest qualifier, which drops from
   * a cut list (dev, 2026-10-05).
   */
  test('a grouped task figure is one word: listings naming another figure do not outrank the cheapest', () => {
    const cars = Array.from({ length: 30 }, (_, i): readonly [string, readonly string[]] => [
      `Honda Civic 1.8 i-VTEC SE 5dr, stock ${String(5100 + i)}`,
      [i === 24 ? '£2,995' : `£${String(3 + (i % 6))},000`, `${String(40 + i)},${i % 2 === 0 ? '500' : '200'} miles`, `Dealer ${String(i + 1)} (${String(4 + i)} miles)`],
    ]);
    const facts = selectBriefWithRefs(listingPage('Results', cars), 'Find the cheapest Honda Civic under 80,000 miles.').facts;
    expect(facts.some((fact) => fact.startsWith('link "Honda Civic 1.8 i-VTEC SE 5dr, stock 5124"'))).toBe(true);
  });

  /**
   * MUTATIONS THIS CATCHES: a superlative task ("cheapest") with no bound
   * whose answer is not among the heads that fit, and value lines (price,
   * mileage, accident status) left out of a head for naming no task word
   * (BrainMeasure, sealed list items on 55b5470a: 4 of 5 lacked them).
   */
  test('the cheapest listing meeting the task is shown with its own value lines, though they name no task word', () => {
    const cars = Array.from({ length: 9 }, (_, i): readonly [string, readonly string[]] => [
      `${String(2015 + (i % 5))} Honda Civic LX stock number ${String(4100 + i)}`,
      [
        `$${(i === 6 ? 14_900 : 13_000 + i * 900).toLocaleString('en-US')}`,
        `Mileage: ${(i === 6 ? 45_210 : i % 2 === 0 ? 88_000 + i * 1000 : 41_000 + i * 1000).toLocaleString('en-US')} mi`,
        i === 6 || i % 2 === 0 ? 'No accidents reported' : '1 accident reported',
        'Seller: Northside Autos, a family business since 1978, offers financing.',
      ],
    ]);
    const brief = selectBrief(listingPage('Used Honda Civic for sale', cars), 'Find the cheapest Honda Civic with no accidents and under 60,000 miles, and give its price.');
    const lines = shownUnder(brief.facts, '2016 Honda Civic LX stock number 4106');
    expect(lines).toBeDefined();
    expect(lines).toContain('$14,900');
    expect(lines).toContain('Mileage: 45,210 mi');
    expect(lines).toContain('No accidents reported');
  });

  /**
   * The real page every amazon-gaming-80k run read first (production
   * capture, 2026-10-05). MUTATIONS THIS CATCHES: the note counting shown
   * RTX listings "not checked" because the task's words NVIDIA, gaming and
   * laptop are the page's subject (on c8e6444f the brain then put on a 4★
   * filter that hid every qualifier: production 6/10 against 10/10; step-2
   * replay 13/20 filter navigations against 2/20); a qualifier marked failing.
   */
  test('on the real gaming-laptop page the note claims no check it did not make, and no qualifier is marked failing', () => {
    const tree = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'amazon-in-gaming-nvidia-tree.json'), 'utf8')) as { readonly tree: AxTree }).tree;
    const facts = selectBrief(tree, "Go to amazon India and find the 3 best-rated gaming laptops with a dedicated NVIDIA or AMD graphics card under ₹80,000; give each one's price, GPU and rating.").facts;
    expect(facts[0]).not.toContain('not checked against every condition');
    for (const qualifier of ['ALG, 13th Gen', 'Aspire 5 15', 'Victus Gaming']) {
      const title = facts.find((fact) => fact.startsWith(`link "${qualifier}`));
      expect(title).toBeDefined();
      expect(title).not.toContain('fails');
    }
  });

  /** MUTATION THIS CATCHES: "cheapest" on the real amazon.in page shows the first two results, not the cheapest (₹11,000, the 3rd). */
  test('a superlative ranks the real results page by the figure it names', () => {
    const tree = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'amazon-in-search-tree.json'), 'utf8')) as { readonly tree: AxTree }).tree;
    const facts = selectBrief(tree, 'Find the cheapest 1TB NVMe SSD on Amazon India and give its price.').facts;
    const title = facts.find((fact) => fact.startsWith('link "CONSISTENT 1TB M.2 NVMe PCIe Internal SSD'));
    expect(title).toBeDefined();
    expect(shownUnder(facts, title!.slice(6, -1))).toContain('₹11,000');
  });

  /** MUTATION THIS CATCHES: a rating stated bare ("4.97 (212 trips)") not read as a rating, so "best rated" cannot rank on it. */
  test('a bare rating ranks a best-rated task', () => {
    const hosts = Array.from({ length: 12 }, (_, i): readonly [string, readonly string[]] => [
      `Weekend rental hosted by driver number ${String(i + 1)}`,
      [`${(i === 9 ? 4.97 : 4.5 + (i % 4) * 0.1).toFixed(2)} (${String(100 + i * 7)} trips)`, `$${String(60 + i * 3)} per day`, 'Pickup at the airport terminal, with free cancellation up to a day before.'],
    ]);
    const facts = selectBrief(listingPage('Car rentals in Denver', hosts), 'Which host is the best rated, and what do they charge per day?').facts;
    expect(shownUnder(facts, 'Weekend rental hosted by driver number 10')).toContain('4.97 (163 trips)');
  });

  /**
   * Cars as whole-card anchors: each card one link holding its title and
   * fields as its own text. `named` gives the link's accessible name: Chrome
   * names an unlabelled link by all its text, an aria-label by the title.
   */
  const cardPage = (named: (title: string, fields: readonly string[]) => string): AxTree => ({
    url: 'https://cars.example.com/used/civic',
    root: node({
      role: 'RootWebArea',
      name: 'Used cars near you',
      xpath: '/html',
      backendNodeId: 1,
      children: Array.from({ length: 10 }, (_, i) => {
        const title = `${String(2014 + (i % 6))} Honda Civic LX sedan number ${String(i + 1)}`;
        const fields = [
          `$${(i === 7 ? 11_400 : 12_000 + i * 700).toLocaleString('en-US')}`,
          `${(i === 7 ? 52_300 : i % 2 === 0 ? 91_000 + i * 1000 : 47_000 + i * 1000).toLocaleString('en-US')} mi`,
          i === 7 || i % 2 === 0 ? 'No accidents reported' : '1 accident reported',
          `Dealer ${String.fromCharCode(65 + i)} Motors, Seattle WA`,
        ];
        return node({
          role: 'link',
          name: named(title, fields),
          xpath: `/c${String(i)}`,
          backendNodeId: 1000 + i * 10,
          children: [title, ...fields].map((text, k) => node({ role: 'StaticText', name: text, xpath: `/c${String(i)}/t${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
        });
      }),
    }),
  });

  /**
   * MUTATION THIS CATCHES: a whole-card link's fields taken as its title's own
   * words, so the page has no list items and the cheapest qualifying car's
   * price, mileage and accident line are not beside its title (9 sealed list
   * items, BrainMeasure 2026-10-03), under both of Chrome's namings.
   */
  for (const [naming, named] of [
    ['content-named', (title: string, fields: readonly string[]) => [title, ...fields].join(' ')],
    ['aria-labelled', (title: string) => title],
  ] as const) {
    test(`a whole-card link is a list item with its own text as its fields (${naming})`, () => {
      const facts = selectBrief(cardPage(named), 'Find the cheapest Honda Civic with no accidents and under 60,000 miles, and give its price.').facts;
      const lines = shownUnder(facts, '2015 Honda Civic LX sedan number 8');
      expect(lines).toBeDefined();
      expect(lines).toContain('$11,400');
      expect(lines).toContain('52,300 mi');
      expect(lines).toContain('No accidents reported');
      // The title is the card's first line, not its whole name.
      expect(facts.some((fact) => fact.startsWith('link "') && fact.includes('$'))).toBe(false);
    });
  }

  /** MUTATION THIS CATCHES: on a real whole-card results page (etsy.com) the cheapest listing's price shown loose, without its title. */
  test('a real whole-card results page shows the cheapest listing with its price', () => {
    const tree = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'etsy-search-tree.json'), 'utf8')) as { readonly tree: AxTree }).tree;
    const facts = selectBrief(tree, 'Find the cheapest leather wallet with free shipping on Etsy and give its price.').facts;
    const lines = shownUnder(facts, 'Personalized Leather Wallet, Minimalist Wallet, Leather Bifold Wallet, Distressed Leather Slim Bifold Wallet, Fathers Day Gift');
    expect(lines).toContain('Sale Price $16.83');
  });

  /** MUTATION THIS CATCHES: on a real card page whose link holds title and price and whose mileage sits beside it (autotrader.co.uk), the cheapest car not first, or a "£20 Tax" line taken for its price. */
  test('a real card page with fields inside and beside the link shows the cheapest car with its mileage', () => {
    const tree = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'autotrader-search-tree.json'), 'utf8')) as { readonly tree: AxTree }).tree;
    const facts = selectBrief(tree, 'Find the cheapest Honda Civic on this page and give its price and mileage.').facts;
    const lines = shownUnder(facts, 'Honda Civic 1.8 i-VTEC SE 5dr');
    expect(lines).toContain('£695');
    expect(lines).toContain('136,000 miles');
  });

  /** Whole-card listings, content-named, as the sealed card pages give them. */
  const cards = (listings: readonly (readonly [string, readonly string[]])[]): AxTree => ({
    url: 'https://shop.example.com/search',
    root: node({
      role: 'RootWebArea',
      name: 'Search results',
      xpath: '/html',
      backendNodeId: 1,
      children: listings.map(([title, fields], i) =>
        node({
          role: 'link',
          name: [title, ...fields].join(' '),
          xpath: `/c${String(i)}`,
          backendNodeId: 1000 + i * 10,
          children: [title, ...fields].map((text, k) => node({ role: 'StaticText', name: text, xpath: `/c${String(i)}/t${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
        }),
      ),
    }),
  });

  /**
   * MUTATION THIS CATCHES: card titles kept at full length while later cards
   * drop whole, so 3-5 of 7-11 titles fit and the qualifier is not among
   * them (sealed card pages, BrainMeasure on a41f3065).
   */
  test('every card shows its title and its first attribute before any card shows more, titles shortened to fit', () => {
    const listings = Array.from({ length: 6 }, (_, i): readonly [string, readonly string[]] => [
      `Solid oak writing desk with two drawers and cable tray, Scandinavian style, model ${String(i + 1)}`,
      [`$${String(240 + i * 15)}.00`, 'Ships from Portland, Oregon', 'Assembly required, about 40 minutes with the included tools'],
    ]);
    const facts = selectBrief(cards(listings), 'Which desk is cheapest, and what does it cost?').facts;
    for (let i = 0; i < 6; i += 1) {
      const at = facts.findIndex((fact) => fact.startsWith('link "Solid oak writing desk') && facts.slice(facts.indexOf(fact)).includes(`$${String(240 + i * 15)}.00`));
      expect(at).toBeGreaterThanOrEqual(0);
    }
    expect(facts.filter((fact) => fact.startsWith('link "Solid oak writing desk')).length).toBe(6);
    expect(facts.filter((fact) => /^\$\d+\.00$/.test(fact)).length).toBe(6);
  });

  /**
   * MUTATIONS THIS CATCHES: a card failing the task counted as matching
   * it, so the qualifier ties with it and page order puts it 7th and out:
   * a bound in another unit (cm against inches, miles against km), a date
   * bound, a status stated the other way (out of stock, refurbished) or a
   * negated attribute.
   */
  for (const [what, task, meets, fails] of [
    ['a size in another unit', 'Find a desk under 30 inches wide and give its price.', 'Width: 70 cm', 'Width: 90 cm'],
    ['a distance in another unit', 'Find a car with under 100,000 km on it and give its price.', '52,000 mi', '70,000 mi'],
    ['a delivery date bound', 'Find one that is delivered by 10 October and give its price.', 'Delivery: Thu, 8 Oct', 'Delivery: Wed, 14 Oct'],
    ['a status stated the other way', 'Find one that is in stock and give its price.', 'In stock', 'Out of stock'],
    ['a negated attribute', 'Find a new one, not refurbished, and give its price.', 'Brand new', 'Refurbished'],
    ['a negated history', 'Find a car with no accidents and give its price.', 'No accidents reported', '1 accident reported'],
    ['a weight in two units', 'Find a tent under 4 lb and give its price.', 'Trail weight: 3 lb 9 oz', 'Trail weight: 5 lb 1 oz'],
    ['one side of a size', 'Find a sofa under 90 cm wide and give its price.', '34 in W x 36 in D', '37 in W x 34 in D'],
    ['a size in inch marks', 'Find a sofa under 80 inches wide and give its price.', "76'' x 38'' x 33''", "84'' x 36'' x 33''"],
    ['a height in feet marks', 'Find a tree under 7 feet tall and give its price.', "6' tall", "8' tall"],
    ['a rating floor with no unit', 'Find one rated 4.8 or higher and give its price.', '4.9 (210 reviews)', '4.6 (310 reviews)'],
  ] as const) {
    test(`a card failing the task ranks below the one meeting it: ${what}`, () => {
      const listings = Array.from({ length: 10 }, (_, i): readonly [string, readonly string[]] => [
        `Listing number ${String(i + 1)} in the catalogue, ref ${String(5000 + i)}, sold by an independent shop near you`,
        [`$${String(300 + i * 11)}`, i === 9 ? meets : fails, `Seller ${String.fromCharCode(65 + i)}, rated by customers`],
      ]);
      const facts = selectBrief(cards(listings), task).facts;
      const at = facts.findIndex((fact) => fact.startsWith('link "Listing number 10 in'));
      expect(at).toBeGreaterThanOrEqual(0);
      const next = facts.findIndex((fact, index) => index > at && fact.startsWith('link "'));
      const lines = facts.slice(at + 1, next < 0 ? undefined : next);
      expect(lines).toContain('$399');
      expect(lines).toContain(meets);
      // The failing cards do not take its room: it is shown at full length,
      // not shortened to fit nine cards that fail.
      // Cards proven failing do not take its room: it is not shortened to fit them.
      expect(facts[at]!.length).toBeGreaterThan(70);
    });
  }

  /**
   * MUTATION THIS CATCHES: a relative delivery day ("Tomorrow", "Friday")
   * not read as a date, so a "delivered by" bound cannot tell the card that
   * meets it from those that do not, and the qualifier, last, is cut.
   */
  test('a relative delivery day meets a date bound against the run date', () => {
    const listings = Array.from({ length: 10 }, (_, i): readonly [string, readonly string[]] => [
      `Listing number ${String(i + 1)} in the catalogue, ref ${String(5000 + i)}, sold by an independent shop near you`,
      [`$${String(300 + i * 11)}`, i === 9 ? 'Get it Monday' : 'Get it Friday', `Seller ${String.fromCharCode(65 + i)}, rated by customers`],
    ]);
    const tree = cards(listings);
    const task = 'Find one that is delivered by 6 October and give its price.';
    const facts = selectBrief(tree, task, '2026-10-03').facts;
    const at = facts.findIndex((fact) => fact.startsWith('link "Listing number 10 in'));
    expect(at).toBeGreaterThanOrEqual(0);
    // The run is on Saturday 3 October: Monday is the 5th, Friday the 9th.
    expect(facts.slice(at + 1, at + 6)).toContain('Get it Monday');
    expect(facts[at]!.length).toBeGreaterThan(70);
  });

  /**
   * MUTATIONS THIS CATCHES: a qualifier squeezed to a clipped title and a
   * clipped value, and a stated requirement (in stock, freestanding) that is
   * no bounded kind left out of every head, so the brain cannot tell which
   * card meets it; and a failing card shown without the line proving it
   * fails (sealed card pages, BrainMeasure on c3e27e4d, 2026-10-03 11:18Z).
   */
  test('the lines deciding the task are kept whole for every card shown, the qualifier and the cards failing it alike', () => {
    const listings = Array.from({ length: 9 }, (_, i): readonly [string, readonly string[]] => [
      `Freestanding bookcase number ${String(i + 1)}, five shelves, solid pine, natural finish`,
      [
        `£${String(120 + i * 9)}.00`,
        i === 7 ? 'In stock: dispatched within 2 working days from Leeds' : 'Out of stock: back in about 6 weeks, order to reserve',
        'Free returns within 30 days of delivery',
      ],
    ]);
    const facts = selectBrief(cards(listings), 'Find a freestanding bookcase that is in stock and give its price.').facts;
    const at = facts.findIndex((fact) => fact.startsWith('link "Freestanding bookcase number 8,'));
    expect(at).toBeGreaterThanOrEqual(0);
    const next = facts.findIndex((fact, index) => index > at && fact.startsWith('link "'));
    expect(facts.slice(at + 1, next < 0 ? undefined : next)).toContain('In stock: dispatched within 2 working days from Leeds');
    // A failing card shown is shown with the line proving it fails, uncut.
    for (const [index, fact] of facts.entries()) {
      if (!fact.startsWith('link "Freestanding bookcase') || index === at) continue;
      const end = facts.findIndex((line, later) => later > index && line.startsWith('link "'));
      expect(facts.slice(index + 1, end < 0 ? undefined : end)).toContain('Out of stock: back in about 6 weeks, order to reserve');
    }
  });

  /** MUTATION THIS CATCHES: a time-of-day bound ("departs after 6 pm") judging no line, so every train ties and the one meeting it, last, is cut. */
  test('a time-of-day bound judges departure lines', () => {
    const listings = Array.from({ length: 10 }, (_, i): readonly [string, readonly string[]] => [
      `Avanti West Coast service number ${String(i + 1)}, London Euston to Manchester Piccadilly`,
      [i === 9 ? 'Departs 18:20, arrives 20:31' : `Departs ${String(9 + i)}:05, arrives ${String(11 + i)}:16`, `£${String(40 + i * 3)}.50`, 'Direct, standard class, seat reservation included'],
    ]);
    const facts = selectBrief(cards(listings), 'Find a train that departs after 6 pm and give its fare.').facts;
    const at = facts.findIndex((fact) => fact.startsWith('link "Avanti West Coast service number 10,'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(facts.slice(at + 1, at + 5)).toContain('Departs 18:20, arrives 20:31');
  });

  /**
   * MUTATIONS THIS CATCHES: "between £130 and £150" read as no bound, and
   * "semi-freestanding" taken for "freestanding", so cheaper cards that fail
   * crowd out the one card meeting the task (sealed heldout5 on 4fb16323).
   */
  for (const [what, task, card] of [
    ['a between bound', 'Find the cheapest bookcase priced between £130 and £150.', (i: number): readonly string[] => [`£${String(i === 23 ? 140 : 60 + i * 2)}.00`, 'Solid pine']],
    ['a feature stated in part', 'Find the cheapest freestanding tent.', (i: number): readonly string[] => [`£${String(i === 23 ? 250 : 90 + i * 4)}.00`, i === 23 ? 'Freestanding design, 6 pegs' : `Semi-freestanding design, ${String(i + 2)} pegs`]],
  ] as const) {
    test(`the one card meeting the task is shown when cheaper cards fail it: ${what}`, () => {
      const listings = Array.from({ length: 24 }, (_, i): readonly [string, readonly string[]] => [
        `Listing number ${String(i + 1)} in the catalogue, ref ${String(5000 + i)}, sold by an independent shop near you`,
        card(i),
      ]);
      const facts = selectBrief(cards(listings), task).facts;
      expect(facts.some((fact) => fact.startsWith('link "Listing number 24 in'))).toBe(true);
    });
  }

  /**
   * MUTATIONS THIS CATCHES: on a cut card list whose cards all start alike,
   * the qualifier's ref not beside its title, and nothing saying the cards
   * not shown fail (dev6, 2026-10-04: the brain read all
   * 12 cards instead of opening the one it could see, 0-1 of 20).
   */
  test('a cut card list gives each title its ref and says the cards not shown fail', () => {
    const listings = Array.from({ length: 12 }, (_, i): readonly [string, readonly string[]] => [
      `Avanti West Coast, London Euston to Manchester Piccadilly, service ${String(9100 + i)}`,
      [i === 9 ? 'Departs 18:20, arrives 20:31' : `Departs ${String(6 + (i % 11)).padStart(2, '0')}:05, arrives ${String(8 + (i % 11)).padStart(2, '0')}:16`, `£${String(40 + i * 3)}.50`, 'Direct · Standard class'],
    ]);
    const tree = cards(listings);
    const facts = selectBriefWithRefs(tree, 'Book the first direct train that departs after 6 pm today.').facts;
    expect(facts).toContain('link "Avanti West Coast, London Euston to Manchester Piccadilly, service 9109" [0-1090]');
    // No mark vouching for a card: a false one is worse than none (sealed heldout5 on 4fb16323).
    expect(facts.some((fact) => fact.includes('✓'))).toBe(false);
    expect(facts[0]).toMatch(/^\d+ of 12 listings shown, in page order; ranked by the task: conditions met first; each of the \d+ not shown fails a condition the task states\.$/u);
    expect(facts).toContain('Every listing: "Direct · Standard class"');
    // The ref beside the title is one the brain may click directly.
    expect(directAction({ type: 'click', ref: '0-1090' }, selectBriefWithRefs(tree, 'Book the first direct train that departs after 6 pm today.'), tree).ok).toBe(true);
  });

  /**
   * MUTATIONS THIS CATCHES: widths in inch marks (84'') not read, so five
   * sofas too wide rank above the one that fits and it is hidden under "the
   * rest rank lower"; and a hidden listing whose deciding figure the matcher
   * could not read said to rank lower instead of not checked (sealed
   * heldout5 on 637a9e9a, the sofa page).
   */
  test("a list in inch marks shows the listing that fits, and a listing not read is said not checked", () => {
    const sofas = (widths: readonly string[]) =>
      cards(
        widths.map((width, i): readonly [string, readonly string[]] => [
          `Harbour three-seat linen sofa with oak legs and removable covers, ${width}, model SF-${String(200 + i)}`,
          [`$${String(900 + i * 40)}`, 'Linen blend upholstery'],
        ]),
      );
    const task = 'Find a 3-seat linen sofa under 80 inches wide.';
    const fits = selectBriefWithRefs(sofas(["84'' x 36'' x 33''", "86'' x 37'' x 33''", "88'' x 38'' x 34''", "85'' x 36'' x 33''", "90'' x 38'' x 34''", "87'' x 37'' x 33''", "89'' x 36'' x 33''", "91'' x 38'' x 34''", "92'' x 38'' x 34''", "76'' x 37'' x 33''"]), task).facts;
    expect(fits.some((fact) => fact.includes('SF-209'))).toBe(true);
    expect(fits[0]).not.toMatch(/rank lower/u);
    // Thirty listings whose width the page does not state, more than the
    // brief holds: those not shown are "not checked", never "rank lower" and
    // never "fail".
    const unread = selectBriefWithRefs(sofas(["84'' x 36'' x 33''", "86'' x 37'' x 33''", "76'' x 37'' x 33''", ...Array.from({ length: 30 }, () => 'size on request')]), task).facts;
    expect(unread[0]).toMatch(/of the \d+ not shown, (?:\d+ fail a condition the task states, )?\d+ not checked\.$/u);
  });

  /**
   * MUTATIONS THIS CATCHES: "no wider than 200 cm" read as no bound against
   * widths written only in aria-labelled titles as NN'', so wider sofas
   * whose other fields pass are shown and the one that fits is hidden
   * (sealed heldout5 on a506a744, 4/4 -> 0/4); and a long title cut before
   * its width, so every shown sofa reads the same.
   */
  test("a comparative bound judges sizes in titles, the one that fits is shown, and a cut title keeps its size", () => {
    const widths = [84, 86, 88, 82, 90, 85, 87, 89, 91, 78, 64, 83, 92, 81];
    const siblings = (title: (i: number) => string): AxTree => ({
      url: 'https://home.example.com/sofas',
      root: node({
        role: 'RootWebArea',
        name: 'Sofas',
        xpath: '/html',
        backendNodeId: 1,
        children: widths.flatMap((_, i) => [
          node({ role: 'link', name: title(i), xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 10 }),
          ...[`Grey | Linen | Seats ${String(i === 10 ? 2 : 3)}`, `4.${String(3 + (i % 6))} (${String(80 + i * 23)})`, `$${String(899 + i * 45)}`, `Get it by Thu, Oct ${String(8 + (i % 5))}`].map((name, k) =>
            node({ role: 'StaticText', name, xpath: `/f${String(i)}-${String(k)}`, backendNodeId: 1001 + i * 10 + k }),
          ),
        ]),
      }),
    });
    const task = 'Find a 3-seat sofa no wider than 200 cm and add it to my cart.';
    const short = selectBriefWithRefs(siblings((i) => `Sofa number ${String(i + 1)} ${String(widths[i])}'' ${i % 2 === 0 ? 'Mid-Century' : 'Modern'} Sofa`), task).facts;
    expect(short.some((fact) => fact.startsWith(`link "Sofa number 10 78''`))).toBe(true);
    expect(short[0]).toMatch(/fails? a condition the task states/u);
    const long = selectBriefWithRefs(
      siblings((i) => `Harbour Modern Three-Seat Sofa with Reversible Cushions, Solid Oak Legs and Removable Machine-Washable Covers in Natural Linen Blend, Model SF-${String(200 + i)}, ${String(widths[i])}'' W x 36'' D x 33'' H`),
      task,
    ).facts;
    expect(long.some((fact) => fact.startsWith('link "') && fact.includes(`78'' W x 36'' D x 33'' H`))).toBe(true);
  });

  /**
   * The cut list pages of sealed heldout6 on 40a02a70 (shape only, recall 0).
   * MUTATIONS THIS CATCHES: a size written in another unit than the task's,
   * rounded where it was written ("139 cm" for a 55-inch set), failing the
   * bound so the qualifier is hidden as failing; litres not compared with
   * quarts; a task word past a long title's 80th character not counted or
   * not shown, so every listing reads the same.
   */
  test("a long title keeps the clause past its cut that decides the task, in any unit of the task's measure", () => {
    const list = (title: (i: number) => string, price: (i: number) => number): AxTree => ({
      url: 'https://shop.example/list',
      root: node({
        role: 'RootWebArea',
        name: 'Results',
        xpath: '/html',
        backendNodeId: 1,
        children: Array.from({ length: 12 }, (_, i) => [
          node({ role: 'link', name: title(i), xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 10 }),
          ...[`4.${String(1 + (i % 7))} out of 5 stars`, `$${String(price(i))}.99`, 'FREE delivery Tue, Oct 7'].map((name, k) =>
            node({ role: 'StaticText', name, xpath: `/f${String(i)}-${String(k)}`, backendNodeId: 1001 + i * 10 + k }),
          ),
        ]).flat(),
      }),
    });
    const sized = (sizes: readonly string[], prices: readonly number[], name: string, task: string): readonly string[] =>
      selectBrief(list((i) => `${name} ${String(i + 3)} with HDR10, Dolby Audio, Voice Remote, Nonstick Basket and Game Mode, ${sizes[i]!}`, (i) => prices[i]!), task).facts;
    const tv = sized(['80 cm', '100 cm', '109 cm', '126 cm', '100 cm', '164 cm', '109 cm', '80 cm', '126 cm', '139 cm', '100 cm', '109 cm'], [229, 279, 319, 389, 289, 749, 329, 219, 399, 579, 299, 339], 'Lumio Series', 'Find a TV of at least 55 inches for under $600.');
    const set = tv.find((fact) => fact.startsWith('link "Lumio Series 12 '));
    expect(set).toContain('139 cm');
    expect(shownUnder(tv, set!.slice(6, -1))).toContain('$579.99');
    // 126 cm (49.6 inches) still fails: the rounding is one centimetre, not a margin.
    expect(tv.some((fact) => fact.includes('126 cm'))).toBe(false);
    const fryer = sized(['3.5 L', '4.5 L', '4.0 L', '4.5 L', '3.0 L', '6.5 L', '4.0 L', '3.5 L', '4.5 L', '5.7 L', '3.0 L', '4.5 L'], [59, 69, 64, 72, 49, 129, 66, 58, 74, 89, 52, 71], 'Crispo Air Fryer', 'Find an air fryer that holds at least 5 quarts and costs under $100.');
    expect(fryer.find((fact) => fact.includes('Crispo Air Fryer 12 '))).toContain('5.7 L');
    expect(fryer[0]).toMatch(/each of the \d+ not shown fails a condition/u);

    const laptops = selectBriefWithRefs(
      list((i) => `VoltBook ${String(14 + (i % 3))} Gaming Laptop, Intel Core i7-13620H, 16GB DDR5, 1TB SSD, 165Hz Display, NVIDIA GeForce RTX ${i === 9 ? '4060 8GB' : '3050 6GB'}, Model VB-${String(200 + i)}`, (i) => (i === 9 ? 949 : 799 + i * 10)),
      'Find a gaming laptop with an RTX 4060 for under $1,000.',
    ).facts;
    expect(laptops.some((fact) => fact.startsWith('link "') && fact.includes('RTX 4060 8GB'))).toBe(true);
  });

  /**
   * MUTATIONS THIS CATCHES: short button chips after each card, as its
   * siblings (sealed heldout6 on 40a02a70, shape only), not counted for the
   * card (the qualifier ranks with the rest) or not shown with its title; a
   * link in a card ("Account", "61 comments") taken for one.
   */
  test("a card's chips after it are its own: counted for it and said with its title", () => {
    const q = 9;
    const tree: AxTree = {
      url: 'https://stays.example/hotels',
      root: node({
        role: 'RootWebArea',
        name: 'Hotels',
        xpath: '/html',
        backendNodeId: 1,
        children: Array.from({ length: 12 }, (_, i) => {
          const fields = [`Harbourside Hotel ${String.fromCharCode(65 + i)} Old Town`, `8.${String(i % 9)} Very good`, `${String(210 + i * 37)} reviews`, `$${String(i === q ? 139 : 112 + i * 7)} per night`];
          return [
            node({
              role: 'link',
              name: fields.join(' '),
              xpath: `/c${String(i)}`,
              backendNodeId: 1000 + i * 10,
              children: fields.map((name, k) => node({ role: 'StaticText', name, xpath: `/c${String(i)}/${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
            }),
            node({ role: 'button', name: i === q || i % 3 === 0 ? 'Free cancellation' : 'Non-refundable', xpath: `/b${String(i)}`, backendNodeId: 1006 + i * 10 }),
            node({ role: 'button', name: i === q || i % 3 === 1 ? 'Breakfast included' : 'Room only', xpath: `/k${String(i)}`, backendNodeId: 1007 + i * 10 }),
            node({ role: 'link', name: 'Free cancellation policy', xpath: `/p${String(i)}`, backendNodeId: 1008 + i * 10 }),
          ];
        }).flat(),
      }),
    };
    const facts = selectBriefWithRefs(tree, 'Find a hotel with free cancellation and breakfast included for under $150 a night.').facts;
    const at = facts.findIndex((fact) => fact.startsWith('link "Harbourside Hotel J Old Town"'));
    expect(facts[at]).toEndWith(', tagged "Free cancellation", "Breakfast included"');
    expect(facts.slice(at + 1, at + 5)).toContain('$139 per night');
    // A card with neither chip is tagged with nothing.
    expect(facts.find((fact) => fact.startsWith('link "Harbourside Hotel C Old Town"')) ?? '').not.toContain('tagged');
  });

  /** MUTATION THIS CATCHES: "by this Friday (Oct 10)" read as no bound, so the one listing arriving in time ranks as any other and is hidden (dev11 N4, 5 of 5 reads). */
  test('a delivery bound after "this" judges dates, and the listing arriving in time is shown', () => {
    // Thirty listings, more than the brief holds; the twenty after the first ten arrive too late.
    const days = ['Tue, Oct 14', 'Mon, Oct 13', 'Fri, Oct 10', 'Wed, Oct 15', 'Tue, Oct 14', 'Thu, Oct 9', 'Fri, Oct 10', 'Mon, Oct 13', 'Wed, Oct 8', 'Tue, Oct 14', ...Array.from({ length: 20 }, (_, i) => `Mon, Oct ${String(13 + (i % 5))}`)];
    const prices = [34, 29, 41, 27, 31, 38, 44, 26, 52, 30, ...Array.from({ length: 20 }, (_, i) => 22 + i)];
    const tree: AxTree = {
      url: 'https://kitchen.example/presses',
      root: node({
        role: 'RootWebArea',
        name: 'French presses',
        xpath: '/html',
        backendNodeId: 1,
        children: days.flatMap((day, i) => [
          node({ role: 'link', name: `Stainless steel French press, model FP-${String(70 + i)}`, xpath: `/t${String(i)}`, backendNodeId: 1000 + i * 10 }),
          ...[`$${String(prices[i])}.99`, `Arrives ${day}`, `4.${String(2 + (i % 6))} out of 5 stars`].map((name, k) => node({ role: 'StaticText', name, xpath: `/f${String(i)}-${String(k)}`, backendNodeId: 1001 + i * 10 + k })),
        ]),
      }),
    };
    const facts = selectBrief(tree, 'I need a French press under $40 that arrives by this Friday (Oct 10). Open the cheapest one that does.', '2026-10-05').facts;
    expect(facts.some((fact) => fact.startsWith('link "Stainless steel French press, model FP-75'))).toBe(true);
    expect(facts[0]).toMatch(/^\d+ of 30 listings shown.*each of the \d+ not shown fails a condition/u);
  });

  /**
   * MUTATIONS THIS CATCHES: a range the task names (24-70mm) met only by the
   * literal range, not by one covering it (20-70mm), and a status stated by
   * another word ("Used - like new", "Refurbished", "Pre-order") not
   * failing "new, in stock" (sealed heldout5 on a506a744; dev7 H2).
   */
  test('a covering range meets a range the task names, and statuses said in other words fail it', () => {
    const lenses = [
      ['Sigma 24-70mm F2.8 DG DN Art', 'In stock', 'Used - like new'],
      ['Sony FE 24-70mm F4 ZA OSS', 'Pre-order', 'New'],
      ['Tamron 28-75mm F/2.8 Di III VXD G2', 'In stock', 'New'],
      ['Samyang AF 24-70mm F2.8 FE', 'In stock', 'Refurbished'],
      ['Sony FE 28-60mm F4-5.6', 'In stock', 'New'],
      ['Sigma 28-70mm F2.8 DG DN Contemporary', 'In stock', 'New'],
      ['Viltrox AF 24-70mm F2.8 Pro', 'In stock', 'Open box'],
      ['Sony FE 16-35mm F4 PZ G', 'In stock', 'New'],
      ['Tamron 35-150mm F/2-2.8 Di III VXD', 'In stock', 'New'],
      ['Sony FE 70-200mm F4 Macro G OSS II', 'In stock', 'New'],
      ['Sigma 20-70mm F2.8 DG DN Contemporary', 'In stock', 'New'],
    ] as const;
    const facts = selectBrief(
      cards(lenses.map(([name, stock, condition], i): readonly [string, readonly string[]] => [name, [`$${String(549 + i * 60)}`, `Sony E-mount · ${stock}`, `Condition: ${condition}`]])),
      'Find a new, in-stock Sony E-mount zoom covering 24-70mm and tell me its price.',
    ).facts;
    const at = facts.indexOf('link "Sigma 20-70mm F2.8 DG DN Contemporary"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(facts.slice(at + 1, at + 4)).toEqual(['$1149', 'Sony E-mount · In stock', 'Condition: New']);
    // Every 24-70 listing fails on condition or stock; shown, it shows the field that fails it.
    for (const [index, fact] of facts.entries()) {
      if (!/^link "(?:Sigma|Sony|Samyang|Viltrox) [^"]*24-70mm/u.test(fact)) continue;
      const end = facts.findIndex((line, later) => later > index && line.startsWith('link "'));
      const own = facts.slice(index + 1, end < 0 ? undefined : end);
      expect(own.some((line) => /Condition: (?:Used|Refurbished|Open box)|Pre-order/u.test(line))).toBe(true);
    }
  });

  /** MUTATION THIS CATCHES: listings shown failing a stated bound while a listing whose size could not be read is hidden (Main, on a506a744). */
  test('a listing not checked is shown before listings that fail a stated condition', () => {
    const listings = Array.from({ length: 24 }, (_, i): readonly [string, readonly string[]] => [
      `Harbour three-seat linen sofa with oak legs and removable covers, model SF-${String(200 + i)}`,
      [`$${String(700 + i * 10)}`, i === 21 ? 'Size: see product page' : `Width: ${String(210 + i)} cm`],
    ]);
    const facts = selectBrief(cards(listings), 'Find the cheapest 3-seat sofa no wider than 200 cm.').facts;
    expect(facts.some((fact) => fact.includes('SF-221'))).toBe(true);
  });

  /**
   * MUTATIONS THIS CATCHES: a table's rows not counted as listings because
   * their names are two words (the brief said "All 15 listings shown" of a
   * 50-row page and left out the rows the task named), and a plural task
   * word ("maples") not matching its singular on the page.
   */
  test('every row of a flat table is a listing, the count is the rows the page holds, and the rows the task names are shown', () => {
    const genera = ['Quercus', 'Pinus', 'Betula', 'Fraxinus', 'Ulmus', 'Tilia', 'Salix', 'Populus', 'Alnus', 'Carpinus'];
    const maples: Readonly<Record<number, readonly [string, string]>> = { 30: ['Acer rubrum', 'Red maple'], 31: ['Acer saccharum', 'Sugar maple'], 32: ['Acer saccharinum', 'Silver maple'] };
    let id = 100;
    const cell = (name: string): AxNode => node({ role: 'StaticText', name, xpath: '', backendNodeId: id++ });
    const link = (name: string): AxNode => node({ role: 'link', name, xpath: `/a${String(id)}`, backendNodeId: id++ });
    const rows = Array.from({ length: 50 }, (_, i) => {
      // Every seventh row a three-word name, the kind counted before; rows 12 and 37 with no link of their own.
      const [scientific, common] = maples[i] ?? [i % 7 === 0 ? `${genera[i % 10]!} species var${String(i)} minor` : `${genera[i % 10]!} species${String(i)}`, `Common tree ${String(i)}`];
      return [
        ...(i === 12 || i === 37 ? [] : [link(scientific)]),
        cell('Plants-Trees'),
        cell(scientific),
        cell(common),
        link('Details'),
        link('Range map'),
        cell(i % 3 === 0 ? 'Introduced' : 'Native'),
      ];
    }).flat();
    const tree: AxTree = {
      url: 'https://flora.example.org/list?group=trees',
      root: node({ role: 'RootWebArea', name: 'Tree checklist', xpath: '/html', backendNodeId: 1, children: [cell('Total records: 50'), link('Scientific Name'), link('Common Name'), ...rows] }),
    };
    const facts = selectBrief(tree, 'Which maples on the checklist are introduced?').facts;
    expect(facts[0]).toMatch(/^\d+ of 48 listings shown/u);
    expect(facts.some((fact) => /\b50 rows\b/u.test(fact))).toBe(true);
    for (const [scientific, common] of Object.values(maples)) {
      expect(facts).toContain(`link "${scientific}"`);
      expect(facts).toContain(common);
    }
  });

  /**
   * MUTATIONS THIS CATCHES: a search page's URL breadcrumbs (links holding
   * their own text) taken for its listings with the result titles left out,
   * snippets dropped as too long for an attribute or shown as the pieces a
   * search engine splits them into, and an AI summary above the results
   * filling the brief before them.
   */
  test('a search page lists every result title with its snippet, before its summary block and breadcrumbs', () => {
    let id = 100;
    const text = (name: string): AxNode => node({ role: 'StaticText', name, xpath: '', backendNodeId: id++ });
    const summary = Array.from({ length: 30 }, (_, i) => text(`Lighthouse keepers in the harbour logged weather and ships, note ${String(i)} of the summary.`));
    const results = Array.from({ length: 10 }, (_, i) => {
      const site = `site${String(i)}.example`;
      const title = `Harbour lighthouse history, part ${String(i)}: keepers and logbooks`;
      return [
        node({ role: 'link', name: `Search domain ${site}`, xpath: `/d${String(i)}`, backendNodeId: id++ }),
        text(`Site ${String(i)}`),
        node({ role: 'link', name: `https://${site} › history › lighthouse`, xpath: `/b${String(i)}`, backendNodeId: id++, children: [text('https://'), text(site), text(' › '), text('history › lighthouse')] }),
        node({ role: 'heading', name: title, xpath: '', backendNodeId: id++, children: [node({ role: 'link', name: title, xpath: `/t${String(i)}`, backendNodeId: id++ })] }),
        text('The'),
        text('lighthouse'),
        text(`at the harbour mouth, result ${String(i)}, kept logbooks of every ship and storm for a century.`),
      ];
    }).flat();
    const tree: AxTree = {
      url: 'https://search.example.com/?q=harbour+lighthouse+keepers',
      root: node({ role: 'RootWebArea', name: 'harbour lighthouse keepers at Search', xpath: '/html', backendNodeId: 1, children: [node({ role: 'heading', name: 'AI summary', xpath: '', backendNodeId: 2 }), ...summary, ...results] }),
    };
    const brief = selectBrief(tree, 'Who kept the harbour lighthouse logbooks?');
    expect(brief.facts[0]).toBe('All 10 listings shown.');
    for (let i = 0; i < 10; i += 1) {
      expect(brief.facts).toContain(`link "Harbour lighthouse history, part ${String(i)}: keepers and logbooks"`);
      expect(brief.facts).toContain(`The lighthouse at the harbour mouth, result ${String(i)}, kept logbooks of every ship and storm for a century.`);
    }
    expect(briefFacts(brief, undefined).length).toBeLessThanOrEqual(brief.factsChars ?? BRAIN_BUDGET.facts);
  });

  /** MUTATION THIS CATCHES: a refused click run again as Enter on the same element (L1). */
  test('Enter on an element is the same action as clicking it', () => {
    expect(actionKey({ type: 'press', key: 'Enter', ref: '7-17211' } as Record<string, unknown>)).toBe(actionKey({ type: 'click', ref: '7-17211' }));
    expect(actionKey({ type: 'press', key: 'Tab', ref: '7-17211' } as Record<string, unknown>)).not.toBe(actionKey({ type: 'click', ref: '7-17211' }));
  });
});

describe('class mechanisms run in the port, not in the prompt', () => {
  /** MUTATION THIS CATCHES: a repeated action run again because the brain chose it again. */
  test('an action already repeated is refused and the brain re-decides with the reason', async () => {
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'click', ref: '0-11' } }),
      brain({ do: 'act', a: { type: 'fill', ref: '0-12', text: 'SAVE10' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = promptFor(TREE);
    const clicked = (index: number) => trace(index, first.snapshotHash, { check: { verdict: 'confirmed', saw: 'the page changed' } } as Partial<StepTrace>);
    const choice = await port.choose(promptFor(TREE, 'check out', 2, [clicked(0), clicked(1)]));
    expect(provider.requests[0]?.prompt).toContain('REPEATED 2x: click 0-11');
    expect(provider.requests[1]?.prompt).toContain('click 0-11 was already done 2 times, so it will not run');
    expect(choice.action).toEqual({ type: 'fill', ref: nodeRef(0, 12), text: 'SAVE10' });
    expect(choice.envelope?.ruledOut).toContain('click 0-11');
  });

  /**
   * MEM4's shape (2026-10-04, run_02bfae1f): a form that posts back on every
   * Search click comes back as the same tree with the button under a new
   * backend id; six clicks, six refs, every check "confirmed", never named a
   * repeat. MUTATIONS THIS CATCHES: repeats keyed on the backend id alone;
   * the rebase applied across different page states.
   */
  test('the same control on the same page is a repeat though a postback renumbered it', async () => {
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'click', ref: '0-301' } }),
      brain({ do: 'act', a: { type: 'fill', ref: '0-302', text: 'SAVE10' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const now = cartPage(300);
    const clicked = (index: number, idBase: number) =>
      trace(index, hashSnapshot(cartPage(idBase)), {
        action: { type: 'click', ref: nodeRef(0, idBase + 1) },
        observed: { ref: `0-${String(idBase + 1)}`, description: 'click the button "Checkout"', method: 'click', xpath: '/html/body/div[1]/button[1]' },
        check: { verdict: 'confirmed', saw: 'button "Checkout" is gone from the page' },
      } as unknown as Partial<StepTrace>);
    expect(hashSnapshot(cartPage(100))).toBe(hashSnapshot(now));
    const choice = await port.choose(promptFor(now, 'check out', 2, [clicked(0, 100), clicked(1, 200)]));
    expect(provider.requests[0]?.prompt).toContain('REPEATED 2x: click 0-301');
    expect(choice.action).toEqual({ type: 'fill', ref: nodeRef(0, 302), text: 'SAVE10' });

    // On another page state the same control is not this step's repeat.
    const elsewhere = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-301' } })]);
    const other = brainPort(elsewhere, PLAN, true).port;
    const moved = (index: number, idBase: number) => ({ ...clicked(index, idBase), snapshotHash: 'ax1:other' }) as StepTrace;
    const kept = await other.choose(promptFor(now, 'check out', 2, [moved(0, 100), moved(1, 200)]));
    expect(elsewhere.requests[0]?.prompt).not.toContain('REPEATED');
    expect(kept.action).toEqual({ type: 'click', ref: nodeRef(0, 301) });
  });

  /** MUTATION THIS CATCHES: the hands re-running what the brain was refused (BrainMeasure L1). */
  test('the hands are held to the same refusals: a disabled target goes back to the brain', async () => {
    const tree: AxTree = {
      url: 'https://parts.example.com/p',
      root: node({
        role: 'RootWebArea',
        name: 'Part',
        xpath: '/html',
        backendNodeId: 1,
        children: [
          node({ role: 'button', name: 'Details', xpath: '/d', backendNodeId: 2, state: { disabled: true } }),
          node({ role: 'link', name: 'Product image', xpath: '/i', backendNodeId: 3 }),
        ],
      }),
    };
    const provider = new FakeProvider([
      brain({ do: 'say', say: 'open the details' }),
      hands([{ type: 'click', ref: '0-2' }]),
      brain({ do: 'act', a: { type: 'click', ref: '0-3' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(tree, 'open the part details'));
    expect(provider.requests[2]?.prompt).toContain('click 0-2 targets a disabled element');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 3) });
  });

  /** MUTATION THIS CATCHES: a step dying on malformed hands with a usable brain one call away (BrainMeasure C1). */
  test('hands whose reply is unusable leave the step to the brain, which names the action', async () => {
    const provider = new FakeProvider([
      brain({ do: 'say', say: 'go back to the front page' }),
      reply('{"reasoning":"back","actions":[{"type":"click"', {}, '0.0001'),
      reply('{"reasoning":"back","actions":[{"type":"click"', {}, '0.0001'),
      brain({ do: 'act', a: { type: 'click', ref: '0-11' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, 'check out'));
    expect(provider.requests[3]?.prompt).toContain('The hands could not carry that out (their reply was unusable)');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
  });

  /** MUTATIONS THIS CATCHES: an answer ended on a view that left the page's text out; a held done that never lets go. */
  test('a done on a partial view is read first, and ends the run once the page was read', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'done', answer: 'Subjects: Maths' }),
      eyes(),
      brain({ do: 'done', answer: 'Subjects: Maths, Physics' }),
    ]);
    const { port } = brainPort(provider);
    const held = await port.choose(promptFor(TREE, 'report every value the confirmation shows'));
    expect(held.action.type).toBe('extract');
    const read = trace(0, 'h1', { action: { type: 'extract', instruction: 'every value' } });
    const ended = await port.choose(promptFor(TREE, 'report every value the confirmation shows', 1, [read]));
    expect(ended.action).toEqual({ type: 'done', summary: 'Subjects: Maths, Physics' });
    expect(provider.requests[3]?.prompt).toContain('Your done was held');
  });

  /** MUTATIONS THIS CATCHES: a chosen brief that keeps paragraphs naming the page's subject and drops the short line stating the value (dev5 D3, 2/2 re-read). */
  test('a chosen brief keeps a short line stating a figure over long paragraphs that only name the page subject', () => {
    let id = 1;
    const at = (role: string, name: string) => node({ role, name, xpath: `/t${String(id)}`, backendNodeId: id++ });
    const notes = Array.from({ length: 8 }, (_, i) => at('StaticText', `Reservoir note ${String(i + 1)}: background paragraph on history, staffing and programmes.`));
    const tree = {
      url: 'https://www.lakemontwater.example.org/reservoir',
      root: node({
        role: 'RootWebArea',
        name: 'Lakemont Reservoir — Current conditions | Lakemont Water District',
        xpath: '/',
        backendNodeId: 999,
        children: [
          at('link', 'Lakemont Water District'),
          at('heading', 'Lakemont Reservoir'),
          at('StaticText', 'Storage today: 61% of capacity'),
          at('StaticText', 'Updated October 3, 2026, 6:00 am'),
          at('StaticText', 'Capacity: 84,000 acre-feet'),
          ...notes,
          at('StaticText', '© 2026 Lakemont Water District'),
        ],
      }),
    };
    const brief = selectBrief(tree, "How full is Lakemont Reservoir? Check both the water district's site and the state drought dashboard, and give me each figure.");
    expect(brief.partial).toBe(true);
    expect(brief.facts).toContain('Storage today: 61% of capacity');
  });

  /** MUTATIONS THIS CATCHES: a stale value the page flags answered as current beside its own refresh control (dev5 D6, 2/2; heldout3 mode 2); the hold firing on a task not about now. */
  test("a done about 'now' off a page that marks itself not current goes back once with the page's refresh control named", async () => {
    const tree = {
      url: 'https://shop.example.com/orders/1',
      root: node({
        role: 'RootWebArea',
        name: 'Order status',
        xpath: '/',
        backendNodeId: 10,
        children: [
          node({ role: 'StaticText', name: 'Status: Processing', xpath: '/s', backendNodeId: 11 }),
          node({ role: 'StaticText', name: 'Status as of Sep 28, 2026. Updates may be delayed.', xpath: '/d', backendNodeId: 12 }),
          node({ role: 'button', name: 'Refresh status', xpath: '/r', backendNodeId: 13 }),
        ],
      }),
    };
    const page = reply(
      JSON.stringify({ page: 'Order status', facts: ['Status: Processing', 'Status as of Sep 28, 2026. Updates may be delayed.'], elements: [{ ref: '0-13', role: 'button', label: 'Refresh status' }] }),
      {},
      '0.0001',
    );
    const provider = new FakeProvider([
      page,
      brain({ do: 'done', answer: 'Processing, as of Sep 28, 2026' }),
      brain({ do: 'act', a: { type: 'click', ref: '0-13' } }),
      page,
      brain({ do: 'done', answer: 'Processing, as of Sep 28, 2026' }),
    ]);
    const held = await brainPort(provider).port.choose(promptFor(tree, 'What is the current status of my order?'));
    expect(held.action).toEqual({ type: 'click', ref: nodeRef(0, 13) });
    expect(provider.requests[2]?.prompt).toContain('Refresh it first: [0-13] "Refresh status"');
    const historic = await brainPort(provider).port.choose(promptFor(tree, 'What was the order status recorded on Sep 28?'));
    expect(historic.action).toEqual({ type: 'done', summary: 'Processing, as of Sep 28, 2026' });
  });

  /** MUTATIONS THIS CATCHES: the difference of two shown figures held for a re-read (dev2 X15, 2/3); a small number "derived" from page noise let through. */
  test('a done stating the difference of two shown figures ends the run; one no shown pair makes is read first', async () => {
    const task = 'one source says 2,650 miles and the other 2,617 miles; compare them';
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'done', answer: '2,650 vs 2,617 miles: they differ by 33 miles.' }),
      eyes(),
      brain({ do: 'done', answer: '2,650 vs 2,617 miles: they differ by 41 miles.' }),
    ]);
    const derived = await brainPort(provider).port.choose(promptFor(TREE, task));
    expect(derived.action.type).toBe('done');
    const unshown = await brainPort(provider).port.choose(promptFor(TREE, task));
    expect(unshown.action.type).toBe('extract');
  });

  /** MUTATIONS THIS CATCHES: a shown figure restated rounded ("$1.18 billion" for "$1,184.6 million") held for a re-read (dev4 C13, 2/2); a near figure that is not its rounding let through. */
  test('a done that restates a shown figure rounded ends the run; a figure that is not its rounding is read first', async () => {
    const task = 'the 10-Q says total revenues were $1,184.6 million; give it in billions';
    const provider = new FakeProvider([eyes(), brain({ do: 'done', answer: 'About $1.18 billion.' }), eyes(), brain({ do: 'done', answer: 'About $1.25 billion.' })]);
    const rounded = await brainPort(provider).port.choose(promptFor(TREE, task));
    expect(rounded.action).toEqual({ type: 'done', summary: 'About $1.18 billion.' });
    const other = await brainPort(provider).port.choose(promptFor(TREE, task));
    expect(other.action.type).toBe('extract');
  });

  /** MUTATIONS THIS CATCHES: a done held for a re-read when every figure in it was shown (dev2 CONFLICTING-FACTS, 0/45); a figure nobody showed let through. */
  test('a done on a partial view ends the run when the brain was shown every figure in it, and is read first when not', async () => {
    const provider = new FakeProvider([eyes(), brain({ do: 'done', answer: 'The total is $12.00.' }), eyes(), brain({ do: 'done', answer: 'The total is $13.50.' })]);
    const shown = await brainPort(provider).port.choose(promptFor(TREE, 'what is the cart total'));
    expect(shown.action).toEqual({ type: 'done', summary: 'The total is $12.00.' });
    const unseen = await brainPort(provider).port.choose(promptFor(TREE, 'what is the cart total'));
    expect(unseen.action.type).toBe('extract');
  });

  /**
   * MUTATIONS THIS CATCHES: a done held for a re-read when every figure in it
   * was shown in another writing: dot-grouped thousands ("9.733.276"), a
   * range written apart ("3 – 5 days"), trailing decimal zeros ("$1,299.00"
   * for "$1,299"); sealed heldout6 on a506a744, abstract: 8 of 8 correct
   * dones held this way. A figure not shown in any writing is still held.
   */
  test('a done is not held for figures the view showed in another writing', async () => {
    const shownFacts = (facts: readonly string[]) => reply(JSON.stringify({ page: 'A results page.', facts, elements: [{ ref: '0-11', role: 'button', label: 'Checkout' }] }), {}, '0.0001');
    const cases: readonly [string, string, boolean][] = [
      ['Einwohner: 9.733.276', 'The ward population is 9,733,276.', true],
      ['Delivery in 3 – 5 business days', 'It arrives in 3-5 business days.', true],
      ['Price: $1,299', 'It costs $1,299.00.', true],
      ['Einwohner: 9.733.276', 'The ward population is 9,733,277.', false],
      ['Statistikamt: 1.284.396 · Stadt: 1,279,000', 'They differ by about 5,400.', true],
      ['Statistikamt: 1.284.396 · Stadt: 1,279,000', 'They differ by about 7,400.', false],
      ['Stand: 31.12.2025, Veränderung +0,8 %', 'As of 31 Dec 2025, up 0.8%.', true],
    ];
    for (const [fact, answer, ends] of cases) {
      const provider = new FakeProvider([shownFacts([fact]), brain({ do: 'done', answer })]);
      const choice = await brainPort(provider).port.choose(promptFor(TREE, 'report the figure'));
      expect(choice.action.type).toBe(ends ? 'done' : 'extract');
    }
  });

  /** MUTATIONS THIS CATCHES: a fail that names its own route ending the run (dev2 Y4); a second fail overridden; a refusal with no route turned into an action (dev3 F3/F8). */
  test('a brain fail that names a site is asked once more; one that names none, or a second fail, stands', async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'fail', answer: 'needs the US store (ikea.com/us)' }),
      brain({ do: 'act', a: { type: 'click', ref: '0-11' } }),
      eyes(),
      brain({ do: 'fail', answer: 'an account already exists for alex@example.com' }),
      eyes(),
      brain({ do: 'fail', answer: 'see https://example.org/help' }),
      brain({ do: 'fail', answer: 'still no route' }),
    ]);
    const routed = await brainPort(provider).port.choose(promptFor(TREE, 'find the US price'));
    expect(routed.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
    expect(provider.requests[2]?.prompt).toContain('A fail ends the run with no answer');
    const refused = await brainPort(provider).port.choose(promptFor(TREE, 'sign up'));
    expect(refused.action).toEqual({ type: 'fail', reason: 'an account already exists for alex@example.com' });
    const failed = await brainPort(provider).port.choose(promptFor(TREE, 'find the US price'));
    expect(failed.action).toEqual({ type: 'fail', reason: 'still no route' });
  });

  /** MUTATIONS THIS CATCHES: a label's short-name value left out of the page text (dev2 Y10, the brain re-read for "Composer"); a call to action taken for a value. */
  test("a link right after a label line is that label's value in the page text, unless it is a call to action", () => {
    let id = 1;
    const at = (role: string, name: string) => node({ role, name, xpath: `/x${String(id)}`, backendNodeId: id++ });
    const tree = {
      url: 'https://letterboxd.com/film/nosferatu-2024/',
      root: node({
        role: 'RootWebArea',
        name: 'Nosferatu (2024)',
        xpath: '/',
        backendNodeId: 99,
        children: [at('StaticText', 'Composer'), at('link', 'Robin Carolan'), at('StaticText', 'Expired'), at('link', 'See Deal')],
      }),
    };
    const facts = rawBrief(tree)?.facts ?? [];
    expect(facts).toContain('link "Robin Carolan"');
    expect(facts.indexOf('link "Robin Carolan"')).toBe(facts.indexOf('Composer') + 1);
    expect(facts).not.toContain('link "See Deal"');
  });

  /** MUTATIONS THIS CATCHES: a country redirect acted on unnoticed; a same-site redirect raised as one (WRONG-PAGE). */
  test('a navigate that lands on another site is named before the brain acts there', () => {
    const went = (url: string) => [trace(0, 'h', { action: { type: 'navigate', url } })];
    expect(redirectedSite(went('https://www.amazon.in'), 'https://www.amazon.com/?ref_=nav_logo')).toContain(
      'you asked for amazon.in; the browser is on amazon.com',
    );
    expect(redirectedSite(went('https://amazon.in/'), 'https://www.amazon.in/gp/home')).toBeUndefined();
    expect(redirectedSite(went('https://wikipedia.org'), 'https://en.wikipedia.org/wiki/Main_Page')).toBeUndefined();
    expect(redirectedSite([trace(0, 'h')], 'https://elsewhere.example/')).toBeUndefined();
  });

  /** MUTATIONS THIS CATCHES: a finish that leaves goals open, or that rewrites a goal the brain closed as failed. */
  test('a brain done closes every open goal, keeping the brain\'s own failed closure', async () => {
    const provider = new FakeProvider([
      brain({ do: 'done', answer: 'two of three found', goal: { id: 'g3', status: 'failed' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const base = promptFor(TREE, 'find three things');
    const choice = await port.choose({
      ...base,
      memory: {
        goals: [
          { id: 'g1', goal: 'first', status: 'done' },
          { id: 'g2', goal: 'second', status: 'active' },
          { id: 'g3', goal: 'third', status: 'pending' },
        ],
        findings: [],
        ruledOut: [],
      },
    } as typeof base);
    expect(choice.action).toEqual({ type: 'done', summary: 'two of three found' });
    expect(choice.envelope?.goal).toBeUndefined();
    expect(choice.envelope?.goals?.map((update) => [update.id, update.status])).toEqual([
      ['g3', 'failed'],
      ['g2', 'done'],
    ]);
  });

  /** MUTATIONS THIS CATCHES: prose, why or plan replayed on every later step; the conditions lost before a fold. */
  test('the thread keeps a reply as its bare decision, conditions included', () => {
    const data = { do: 'act', a: { type: 'click', ref: '0-11' }, why: 'it is the button', plan: [{ id: 'g1', goal: 'x' }], need: ['checked out'] };
    expect(JSON.parse(threadReply(data, `Thinking first. ${JSON.stringify(data)}`))).toEqual({ do: 'act', a: { type: 'click', ref: '0-11' }, need: ['checked out'] });
    expect(threadReply(undefined, 'not json')).toBe('not json');
  });

  /** MUTATIONS THIS CATCHES: a run with conditions and no plan (the finish gate's plan demand); a stated plan overwritten. */
  test('the first reply\'s conditions become the plan when the brain states none', async () => {
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-11' }, need: ['cart open', 'checked out'] })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, 'check out'));
    expect(choice.envelope?.plan).toEqual([
      { id: 'n1', goal: 'cart open' },
      { id: 'n2', goal: 'checked out' },
    ]);
  });

  /** MUTATIONS THIS CATCHES: a final read that does not end the run, or that ends it with the plan still open. */
  test('a read the brain marks final ends the run as the answer and closes the plan', async () => {
    const provider = new FakeProvider([brain({ do: 'read', read: 'titles ranked 31-35', final: true })]);
    const { port } = brainPort(provider, PLAN, true);
    const base = promptFor(TREE, 'list titles 31-35');
    const choice = await port.choose({ ...base, memory: { goals: [{ id: 'n1', goal: 'titles', status: 'active' }], findings: [], ruledOut: [] } } as typeof base);
    expect(choice.action).toEqual({ type: 'extract', instruction: 'titles ranked 31-35', final: true });
    expect(choice.envelope?.goals?.map((update) => [update.id, update.status])).toEqual([['n1', 'done']]);
  });

  /** MUTATION THIS CATCHES: a reply naming the action as "do" refused by the schema and paid for twice (fleet, focusTab). */
  test('a reply that names the action itself as "do" runs as that action, with no second call', async () => {
    const provider = new FakeProvider([brain({ do: 'click', ref: '0-11' })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
    expect(provider.requests).toHaveLength(1);
  });

  /** MUTATION THIS CATCHES: a tool-call-XML reply refused and paid for twice (the brain model on a cloud upstream, laptop sims). */
  test('a brain reply written as tool-call XML is read as its decision, with no second call', async () => {
    const provider = new FakeProvider([
      reply(' <invoke name="act"> <parameter name="a">{"type":"click","ref":"0-11"}</parameter> </invoke>', {}, '0.002'),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE));
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
    expect(provider.requests).toHaveLength(1);
  });

  /** MUTATIONS THIS CATCHES: a search re-run under a new ref (BrainMeasure L1); a first search refused. */
  test('typing a query that already led somewhere into a search box goes back to the brain', async () => {
    const tree: AxTree = {
      url: 'https://parts.example.com/results',
      root: node({
        role: 'RootWebArea',
        name: 'Results',
        xpath: '/html',
        backendNodeId: 1,
        children: [
          node({ role: 'textbox', name: 'Enter keyword or part #', xpath: '/q', backendNodeId: 102 }),
          node({ role: 'link', name: '1N4148W-7-F image', xpath: '/i', backendNodeId: 103 }),
        ],
      }),
    };
    const history = [
      trace(0, 'h0', { action: { type: 'fill', ref: nodeRef(0, 184), text: '1N4148W-7-F' } as StepTrace['action'], check: { verdict: 'confirmed', saw: 'the field reads "1N4148W-7-F"' } } as Partial<StepTrace>),
      trace(1, 'h1', { action: { type: 'click', ref: nodeRef(0, 191) }, check: { verdict: 'confirmed', saw: 'the page went to https://parts.example.com/results' } } as Partial<StepTrace>),
    ];
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'fill', ref: '0-102', text: '1N4148W-7-F' } }),
      brain({ do: 'act', a: { type: 'click', ref: '0-103' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(tree, 'open the part details', 2, history));
    expect(provider.requests[1]?.prompt).toContain('searching "1N4148W-7-F" again: that search already led to https://parts.example.com/results');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 103) });
    // A first search is not a repeat.
    expect(searchedBefore([], { type: 'fill', ref: '0-102', text: '1N4148W-7-F' } as Record<string, unknown>, tree)).toBeUndefined();
  });

  /** MUTATIONS THIS CATCHES: an answer from the wrong entry of the run's own list (C1); a right entry held. */
  test('a done from the wrong entry of a list the run recorded is held and named', async () => {
    const task = 'Go to news.ycombinator.com, open the second story, then go back and open the comments of the first story. Tell me the first comment author.';
    const note = 'Front page: 1. "Using any C++ library in Godot" (godotengine.org, 412 points, 187 comments); 2. "AI companies leak data to advertisers [pdf]" (arxiv.org, 143 comments); 3. "Phyllotaxis: An audio-reactive LED display" (18 comments)';
    expect(wrongListItem(task, [note], 'Phyllotaxis: An audio-reactive LED display | Hacker News')).toContain('#3 in your own list, but the task asks for the first story');
    expect(wrongListItem(task, [note], 'Using any C++ library in Godot | Hacker News')).toBeUndefined();
    expect(wrongListItem('Tell me the first comment author', [note], 'Phyllotaxis: An audio-reactive LED display | Hacker News')).toBeUndefined();

    const tree: AxTree = { url: 'https://news.ycombinator.com/item?id=3', root: node({ role: 'RootWebArea', name: 'Phyllotaxis: An audio-reactive LED display | Hacker News', xpath: '/html', backendNodeId: 1, children: [node({ role: 'link', name: 'Hacker News', xpath: '/a', backendNodeId: 2 })] }) };
    const provider = new FakeProvider([brain({ do: 'done', answer: 'intothemild' }), brain({ do: 'act', a: { type: 'click', ref: '0-2' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const base = promptFor(tree, task, 4);
    const choice = await port.choose({ ...base, memory: { goals: [], findings: [{ step: 1, text: note }], ruledOut: [] } } as typeof base);
    expect(provider.requests[1]?.prompt).toContain('Your done was held: this page is');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 2) });
  });

  /**
   * Taxonomy AB9, run_ed91c6ba (2026-10-04): the only read of an Akamai
   * challenge came back empty, and the brain noted listings no page showed.
   * MUTATIONS THIS CATCHES: a note naming what nothing showed kept as what
   * the run found; the brain not told the names; a note of shown names held.
   */
  test('a note naming what no page, read or note showed is sent back, then dropped', async () => {
    const task = 'Navigate to https://www.walgreens.com/search/results.jsp?Ntt=vitamin and report the page\'s real content, or say plainly that it was blocked.';
    const tree: AxTree = { url: 'https://www.walgreens.com/search/results.jsp?Ntt=vitamin', root: node({ role: 'RootWebArea', name: 'Challenge Validation', xpath: '/html', backendNodeId: 1, children: [node({ role: 'link', name: 'Walgreens', xpath: '/a', backendNodeId: 2 })] }) };
    const invented = 'Walgreens: real vitamin search results loaded (Vitamin D3, Centrum listings with prices); no block';
    const base = promptFor(tree, task, 2);
    const prompt = { ...base, extracted: [{ step: 1, text: 'No accessibility tree content provided in input.' }] } as typeof base;

    const insists = new FakeProvider([
      brain({ do: 'act', a: { type: 'click', ref: '0-2' }, note: invented }),
      brain({ do: 'act', a: { type: 'click', ref: '0-2' }, note: invented }),
    ]);
    const choice = await brainPort(insists, PLAN, true).port.choose(prompt);
    expect(insists.requests[1]?.prompt).toContain('Your note names "D3", "Centrum", which no page, read or note of this run showed you');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 2) });
    expect(choice.envelope?.finding).toBeUndefined();

    const honest = 'Walgreens: Challenge Validation page; the read came back empty, so the search results were blocked';
    const shown = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-2' }, note: honest })]);
    const kept = await brainPort(shown, PLAN, true).port.choose(prompt);
    expect(shown.requests).toHaveLength(1);
    expect(kept.envelope?.finding).toBe(honest);
  });

  /**
   * The live read, replayed (live10-0ebee925, run_6d1a1218, news?p=3): rank 64
   * skipped, rank 71 appended, called complete by the extractor.
   * MUTATIONS THIS CATCHES: a wrong ranked read passing as complete; a right
   * one held; a page that does not number the range treated as checkable.
   */
  test('a final read of a rank range is checked against the page\'s numbered list', async () => {
    const titles = ['Pi 1.0 release notes today', 'Show HN: Our space game has a RISC-V emulator', 'VS Code style IDE in under 200kb', "Big Balls 20yo running the ops for the network", 'Robot Hands for Modern AI and Real Work'];
    const tree: AxTree = {
      url: 'https://news.example.com/news?p=3',
      root: node({
        role: 'RootWebArea',
        name: 'News',
        xpath: '/html',
        backendNodeId: 1,
        children: titles.flatMap((title, i) => [
          node({ role: 'StaticText', name: `${String(61 + i)}.`, xpath: `/r${String(i)}`, backendNodeId: 10 + i * 2 }),
          node({ role: 'link', name: title, xpath: `/t${String(i)}`, backendNodeId: 11 + i * 2 }),
        ]),
      }),
    };
    const wrong = [titles[0], titles[1], titles[2], titles[4]].join('\n');
    const right = titles.slice(0, 4).join('\n');
    expect(rankedReadGap('titles of items ranked 61 to 64, in order', tree, wrong)).toBe(
      'rank 64 ("Big Balls 20yo running the ops for the network") is not in it; it includes rank 65 ("Robot Hands for Modern AI and Real Work"), outside 61-64',
    );
    expect(rankedReadGap('titles of items ranked 61 to 64', tree, right)).toBeUndefined();
    expect(rankedReadGap('titles of items ranked 1 to 4', tree, right)).toBeUndefined();

    const provider = new FakeProvider([reply(JSON.stringify({ answer: wrong, complete: true, missing: '' }), {}, '0.0002')]);
    const { port } = brainPort(provider, PLAN, true);
    const out = await port.extract({ instruction: 'titles of items ranked 61 to 64, in order', schema: { type: 'object', properties: { answer: { type: 'string' }, complete: { type: 'boolean' }, missing: { type: 'string' } }, required: ['answer', 'complete', 'missing'] }, content: { kind: 'tree', tree } });
    expect(out.data).toMatchObject({ complete: false, missing: expect.stringContaining('rank 64') });
  });

  /** MUTATION THIS CATCHES: a refused action run anyway on the fallback path after the one re-decide (L1). */
  test('a refused action never runs, even when the hands insist after the re-decide', async () => {
    const tree: AxTree = {
      url: 'https://parts.example.com/results',
      root: node({ role: 'RootWebArea', name: 'Results', xpath: '/html', backendNodeId: 1, children: [
        node({ role: 'link', name: '1N4148W-7-F', xpath: '/l', backendNodeId: 2 }),
        node({ role: 'link', name: 'Product image', xpath: '/i', backendNodeId: 3 }),
      ] }),
    };
    const dead = trace(0, 'h0', { action: { type: 'click', ref: nodeRef(0, 2) }, check: { verdict: 'contradicted', saw: 'nothing on the page changed' } } as Partial<StepTrace>);
    const provider = new FakeProvider([
      brain({ do: 'say', say: 'open the part' }),
      hands([{ type: 'click', ref: '0-2' }]),
      brain({ do: 'say', say: 'open the part page' }),
      hands([{ type: 'click', ref: '0-2' }]),
      hands([{ type: 'click', ref: '0-3' }]),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(tree, 'open the part details', 1, [dead]));
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 3) });
    expect(provider.requests[4]?.prompt).toContain('Not this, which cannot run');
  });

  /** MUTATION THIS CATCHES: the last resort being a look when the tree offers the other way in (L1). */
  test('when the hands insist twice on a refused link, the sibling way to the same place is taken', async () => {
    const tree: AxTree = {
      url: 'https://parts.example.com/results',
      root: node({ role: 'RootWebArea', name: 'Results', xpath: '/html', backendNodeId: 1, children: [
        node({ role: 'link', name: 'Site logo', xpath: '/logo', backendNodeId: 4 }),
        node({ role: 'img', name: '1N4148W-7-F', xpath: '/i', backendNodeId: 3 }),
        node({ role: 'link', name: '1N4148W-7-F', xpath: '/l', backendNodeId: 2 }),
      ] }),
    };
    const dead = trace(0, 'h0', { action: { type: 'click', ref: nodeRef(0, 2) }, check: { verdict: 'contradicted', saw: 'nothing on the page changed' } } as Partial<StepTrace>);
    const provider = new FakeProvider([
      brain({ do: 'say', say: 'open the part' }),
      hands([{ type: 'click', ref: '0-2' }]),
      brain({ do: 'say', say: 'open the part page' }),
      hands([{ type: 'click', ref: '0-2' }]),
      hands([{ type: 'click', ref: '0-2' }]),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(tree, 'open the part details', 1, [dead]));
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 3) });
  });

  /** MUTATION THIS CATCHES: a reload of the page already open taken for a new route (L1). */
  test('a navigate to the page already open goes back to the brain', async () => {
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'navigate', url: 'https://shop.example.com/cart/' } }), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE));
    expect(provider.requests[1]?.prompt).toContain('is the page already open');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });
  });

  /**
   * MUTATIONS THIS CATCHES: a queued read dropped or sent to the brain (a call
   * per page again), a queued final read that leaves the plan open, a final
   * honoured on a run that already read another page.
   */
  test('one decision plans ahead: navigate and read each page with no further brain call', async () => {
    const provider = new FakeProvider([
      brain({
        do: 'act',
        a: { type: 'navigate', url: 'https://a.example.com/' },
        need: ['stars of A and B'],
        then: [{ read: 'stars of A' }, { a: { type: 'navigate', url: 'https://b.example.com/' } }, { read: 'stars of B', final: true }],
      }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const history: StepTrace[] = [];
    const first = await port.choose(promptFor(TREE, 'compare the stars of A and B'));
    expect(first.action).toEqual({ type: 'navigate', url: 'https://a.example.com/' });
    const actions = [first.action];
    for (let step = 1; step <= 3; step++) {
      history.push(trace(step - 1, `h${String(step)}`, { action: actions.at(-1) as StepTrace['action'] }));
      const base = promptFor(TREE, 'compare the stars of A and B', step, [...history]);
      const extracted = step === 3 ? [{ step: 1, text: 'extracted on https://a.example.com/: "A: 12k"', page: true as const }] : [];
      const choice = await port.choose({ ...base, ...(extracted.length === 0 ? {} : { extracted }) } as typeof base);
      actions.push(choice.action);
    }
    expect(actions.slice(1)).toEqual([
      { type: 'extract', instruction: 'stars of A' },
      { type: 'navigate', url: 'https://b.example.com/' },
      // Not final: the run has already read page A, so B's read alone cannot be the answer.
      { type: 'extract', instruction: 'stars of B' },
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  test('a queued final read on a run with nothing read ends the run and closes the plan', async () => {
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'navigate', url: 'https://pypi.org/project/requests/' }, need: ['latest version'], then: [{ read: 'latest version', final: true }] }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = await port.choose(promptFor(TREE, 'latest version of requests'));
    const base = promptFor(TREE, 'latest version of requests', 1, [trace(0, 'h1', { action: first.action as StepTrace['action'] })]);
    const choice = await port.choose({ ...base, memory: { goals: [{ id: 'n1', goal: 'latest version', status: 'active' }], findings: [], ruledOut: [] } } as typeof base);
    expect(choice.action).toEqual({ type: 'extract', instruction: 'latest version', final: true });
    expect(choice.envelope?.goals?.map((update) => [update.id, update.status])).toEqual([['n1', 'done']]);
    expect(provider.requests).toHaveLength(1);
  });

  /**
   * Replayed from live10-ad789359 oss-compare (run_7c6cc717, step 6): the
   * navigate's check read the page before it changed ("still on
   * github.com/ziglang/zig") while the next tree was rust-lang.org.
   * MUTATIONS THIS CATCHES: a misjudged navigate dropping the queued read (a
   * brain call) and being refused as already tried; a real failure forgiven.
   */
  test('a navigate the check misjudged keeps its queued read and is not ruled out', async () => {
    const site = (url: string, name: string): AxTree => ({
      url,
      root: node({ role: 'RootWebArea', name, xpath: '/html', backendNodeId: 1, children: [node({ role: 'link', name: 'Install', xpath: '/a', backendNodeId: 2 })] }),
    });
    const provider = new FakeProvider([
      brain({ do: 'act', a: { type: 'navigate', url: 'https://www.rust-lang.org/' }, need: ['rust version'], then: [{ read: 'latest stable Rust version' }] }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const first = await port.choose(promptFor(site('https://github.com/ziglang/zig', 'zig'), 'find the latest Rust version on rust-lang.org'));
    expect(first.action).toEqual({ type: 'navigate', url: 'https://www.rust-lang.org/' });
    const misjudged = trace(0, 'h0', {
      action: { type: 'navigate', url: 'https://www.rust-lang.org/' } as StepTrace['action'],
      check: { verdict: 'contradicted', saw: 'the browser is still on https://github.com/ziglang/zig', expected: '', reads: 1, elapsedMs: 0 },
    } as Partial<StepTrace>);
    const next = await port.choose(promptFor(site('https://www.rust-lang.org/', 'Rust'), 'find the latest Rust version on rust-lang.org', 1, [misjudged]));
    expect(next.action).toEqual({ type: 'extract', instruction: 'latest stable Rust version' });
    expect(next.envelope?.ruledOut).toBeUndefined();
    expect(provider.requests).toHaveLength(1);

    // A navigate that really did not move is not forgiven.
    expect(reconciledNavigate(misjudged, 'https://github.com/ziglang/zig')).toBeUndefined();
  });

  /**
   * The live answer, replayed (live10 31029c13, amazon-gaming-80k,
   * run_876f0730). MUTATIONS THIS CATCHES: an unconfirmed item shipped in a
   * ranked slot; a clean ranked answer, or a trailing aside, held.
   */
  test('a ranked answer with an unconfirmed item in a slot is held once, with the rule', async () => {
    const live =
      '1) ALG AL15G-53 (i7-13620H, 16GB/512GB): ₹79,990, NVIDIA GeForce RTX 3050 6GB, rating 3.8/5 (108 ratings). 2) ALG AL15G-53 (Core 5-210H, Office 2024 bundle): ₹79,400, NVIDIA GeForce RTX 3050 4GB, rating 3.4/5 (5 ratings). 3) ₹75,000 listing: rating 3.3/5 (18 ratings), GPU not stated in the listing, so it is unconfirmed. The next confirmed-GPU option is ₹79,900, RTX 3050 4GB, 3.0/5 (2 ratings). Amazon\'s results here are limited and ratings are low, with few reviews.';
    expect(unconfirmedSlot(live)).toMatch(/^3\) ₹75,000 listing/);
    const fixed =
      '1) ALG AL15G-53: ₹79,990, RTX 3050 6GB, 3.8/5. 2) ALG AL15G-53: ₹79,400, RTX 3050 4GB, 3.4/5. 3) ₹79,900 listing: RTX 3050 4GB, 3.0/5. A ₹75,000 listing rated 3.3 was left out: its GPU is not stated.';
    expect(unconfirmedSlot(fixed)).toBeUndefined();

    const provider = new FakeProvider([brain({ do: 'done', why: 'ranked', answer: live }), brain({ do: 'done', why: 'confirmed only', answer: fixed })]);
    const { port } = brainPort(provider, PLAN, true);
    // The run's read of the results, which the answer's names trace to.
    const read = 'ALG AL15G-53 (i7-13620H, 16GB/512GB) ₹79,990 NVIDIA GeForce RTX 3050 6GB 3.8 (108); ALG AL15G-53 (Core 5-210H, Office 2024) ₹79,400 RTX 3050 4GB 3.4 (5); ₹75,000 3.3 (18); ₹79,900 RTX 3050 4GB 3.0 (2)';
    const base = promptFor(TREE, 'find the 3 best-rated gaming laptops with a dedicated GPU under ₹80,000');
    const choice = await port.choose({ ...base, extracted: [{ step: 1, text: read }] } as typeof base);
    expect(provider.requests[1]?.prompt).toContain('Ranked slots take only items confirmed against every condition');
    expect(choice.action).toEqual({ type: 'done', summary: fixed });
  });

  /**
   * Arm ws/doubt-off: the brain is neither asked for nor given a list of
   * what it did not confirm, and a list it sends anyway never reaches the
   * action. The doubt it writes in its answer stays there, word for word.
   * MUTATIONS THIS CATCHES: the `unconfirmed` field or its prompt sentence
   * put back; the port forwarding a stray list onto the `done`; the answer
   * trimmed of its own hedge.
   */
  test('a brain done carries no unconfirmed list, and its answer keeps its own doubt', async () => {
    expect(Object.keys(BRAIN_SCHEMA.properties)).not.toContain('unconfirmed');
    expect(BRAIN_SYSTEM_PROMPT).not.toContain('unconfirmed');
    const answer = 'Shop A, opened 1987. Its street address is unverified.';
    const provider = new FakeProvider([brain({ do: 'done', why: 'from the read', answer, unconfirmed: ['the street address'] })]);
    const { port } = brainPort(provider, PLAN, true);
    const base = promptFor(TREE, 'the shop that opened before 1990, and its street address');
    const choice = await port.choose({ ...base, extracted: [{ step: 1, text: 'Shop A opened 1987' }] } as typeof base);
    expect(choice.action).toEqual({ type: 'done', summary: answer });
  });

  /**
   * MUTATIONS THIS CATCHES: the brain shown only the loop's 600-character cut
   * of a list it asked for (live10-ad789359 amazon: 4 narrower re-reads, 7
   * brain calls), and a whole read attached to an entry it did not produce.
   */
  test('the brain reads a long list whole, not the loop\'s 600-character cut', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ title: `Gaming laptop model ${String(i + 1)} with RTX 4050 and a long marketing name`, price: `₹${String(70_000 + i * 1_000)}`, rating: `4.${String(i)}` }));
    const full = JSON.stringify(items);
    const clipped = `${full.slice(0, 600)}…`;
    const entry = `extracted on https://shop.example.com/s: ${JSON.stringify(clipped)}`;
    expect(wholeRead(entry, [full])).toContain('model 7');
    expect(wholeRead(entry, ['something else entirely'])).toBeUndefined();
    expect(wholeRead('extracted on https://shop.example.com/s: "short read"', [full])).toBeUndefined();

    const provider = new FakeProvider([reply(JSON.stringify({ data: full }), {}, '0.0002'), brain({ do: 'done', why: 'from the read', answer: 'model 7' })]);
    const { port } = brainPort(provider, PLAN, true);
    await port.extract({ instruction: 'all results', schema: null, content: { kind: 'tree', tree: TREE } });
    const base = promptFor(TREE, 'list the laptops', 2);
    await port.choose({ ...base, extracted: [{ step: 1, text: entry, page: true }] } as typeof base);
    expect(provider.requests[1]?.prompt).toContain('Read (whole) on https://shop.example.com/s');
    expect(provider.requests[1]?.prompt).toContain('model 7');
  });

  /**
   * MUTATIONS THIS CATCHES: a second read of an unchanged page that already
   * answered (heldout4 constraint-ignored), and a narrower re-read after an
   * empty read, or of a page that changed, refused.
   */
  test('a read of an unchanged page that was already read goes back to the brain with the earlier read', async () => {
    const hash = hashSnapshot(TREE);
    const read = trace(1, hash, { action: { type: 'extract', instruction: 'all results' } as StepTrace['action'] });
    const text = 'extracted on https://shop.example.com/cart: "Kettle £39.50; Mug £8"';
    const base = promptFor(TREE, 'cheapest item under £10', 2, [read]);
    const prompt = { ...base, extracted: [{ step: 1, text, page: true as const }] } as typeof base;
    expect(alreadyRead(prompt)?.step).toBe(1);
    expect(alreadyRead({ ...prompt, extracted: [{ step: 1, text: 'extracted on x: "No product data available: page returned 503"', page: true as const }] } as typeof base)).toBeUndefined();
    // The live tree drifts between steps (30 of 56 read transitions, live10
    // 2026-10-03): a different hash after the read is still the same page.
    expect(alreadyRead({ ...prompt, history: [trace(1, 'drifted-hash', { action: { type: 'extract', instruction: 'x' } as StepTrace['action'] })] } as typeof base)?.step).toBe(1);
    // A click after the read may have changed the page; a read on another URL is another page.
    expect(alreadyRead({ ...prompt, history: [read, trace(2, hash, { action: { type: 'click', ref: nodeRef(0, 11) } })] } as typeof base)).toBeUndefined();
    expect(alreadyRead({ ...prompt, extracted: [{ step: 1, text: 'extracted on https://elsewhere.example.com/: "Mug £8"', page: true as const }] } as typeof base)).toBeUndefined();

    const provider = new FakeProvider([brain({ do: 'read', read: 'items under £10' }), brain({ do: 'done', why: 'Mug £8 in the read', answer: 'Mug, £8' })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(prompt);
    expect(provider.requests[1]?.prompt).toContain('this page is unchanged since your read at step 2');
    expect(choice.action).toEqual({ type: 'done', summary: 'Mug, £8' });
  });

  /** MUTATIONS THIS CATCHES: a reload by key press shipped (sealed multi-tab, 2 samples); an ordinary key rewritten. */
  test('a reload key press runs as a navigate to the page itself', async () => {
    expect(reloadAsNavigate({ type: 'press', key: 'F5' }, 'https://a.example.com/x')).toEqual({ type: 'navigate', url: 'https://a.example.com/x' });
    expect(reloadAsNavigate({ type: 'press', key: 'Control+R' }, 'https://a.example.com/x')).toEqual({ type: 'navigate', url: 'https://a.example.com/x' });
    expect(reloadAsNavigate({ type: 'press', key: 'Enter' }, 'https://a.example.com/x')).toBeUndefined();
    expect(reloadAsNavigate({ type: 'press', key: 'F5' }, 'about:blank')).toBeUndefined();
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'press', key: 'Meta+R' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, 'reload and check the price'));
    expect(choice.action).toEqual({ type: 'navigate', url: 'https://shop.example.com/cart' });
  });

  /**
   * MUTATIONS THIS CATCHES: a read of a page the brief showed whole (sealed
   * long-history: re-read what was visible instead of acting); a final read,
   * or a second insistence, blocked.
   */
  test('a non-final read of a page shown whole goes back once to act on it', async () => {
    const provider = new FakeProvider([brain({ do: 'read', read: 'the checkout button' }), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, 'check out'));
    expect(provider.requests[1]?.prompt).toContain('this whole page is already in your brief');
    expect(choice.action).toEqual({ type: 'click', ref: nodeRef(0, 11) });

    const insisting = new FakeProvider([brain({ do: 'read', read: 'the total' }), brain({ do: 'read', read: 'the total again' })]);
    const second = brainPort(insisting, PLAN, true);
    expect((await second.port.choose(promptFor(TREE, 'report the total'))).action).toEqual({ type: 'extract', instruction: 'the total' });

    const final = new FakeProvider([brain({ do: 'read', read: 'the total', final: true })]);
    const third = brainPort(final, PLAN, true);
    expect((await third.port.choose(promptFor(TREE, 'report the total'))).action).toMatchObject({ type: 'extract', final: true });
    expect(final.requests).toHaveLength(1);
  });

  /**
   * MUTATIONS THIS CATCHES: a list read on a filtered task sent without the
   * filter (heldout4 constraint-ignored, abstract), a read that already states
   * it rewritten, and reads on unfiltered tasks touched.
   */
  test('a list read on a task with a filter carries the filter, marking items rather than dropping them', async () => {
    const task = 'Go to amazon India and find the 3 best-rated gaming laptops with a dedicated NVIDIA or AMD graphics card under ₹80,000; give each one\'s price, GPU and rating.';
    expect(readWithConditions('List all search results: title, price, GPU, rating', task)).toContain('under ₹80,000');
    expect(readWithConditions('List all search results: title, price, GPU, rating', task)).toContain('keep every item');
    expect(readWithConditions('All results under ₹10,000: name, price', 'find RAM under 10,000 rs on amazon')).toBeUndefined();
    // A read that FILTERS is told to mark instead, even when it states the filter (amazon run_cf1cd982).
    const filtering = readWithConditions('For each listed result (up to 10): title, price, GPU model, star rating; only those under ₹80,000 with dedicated NVIDIA/AMD GPU', task);
    expect(filtering).toContain('instead of leaving items out, mark each item');
    expect(readWithConditions('latest version number of requests', 'what is the latest release of requests on pypi')).toBeUndefined();
    expect(readWithConditions('the price of this book', task)).toBeUndefined();

    // Raw view: the whole-page bounce asks once, the brain insists, the read runs.
    const provider = new FakeProvider([
      brain({ do: 'read', read: 'List all search results: title, price, GPU, rating' }),
      brain({ do: 'read', read: 'List all search results: title, price, GPU, rating' }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, task));
    expect(choice.action).toMatchObject({ type: 'extract' });
    expect((choice.action as { instruction: string }).instruction).toContain("mark each item PASS or FAIL against the task's filters");
  });

  /**
   * MUTATION THIS CATCHES: a recorded reply whose decision FOLLOWS a junk
   * tool-call tag re-asked at a whole brain call (under the `</invoke>` stop,
   * every one was cut before its decision; 2026-10-03).
   */
  test('a decision written after a junk tool-call tag is read with no second call', async () => {
    for (const whole of DECISION_AFTER_TAGS) {
      const replies = new FakeProvider([reply(whole), reply('{"do":"say","say":"asked again"}')]);
      const client = new ModelClient({ provider: replies, model: 'brain-model', session: { sessionId: 's', accountId: 'a' } });
      expect(((await client.extract({ instruction: null, schema: BRAIN_SCHEMA, content: { kind: 'markdown', markdown: 'page' } })).data as { do: string }).do).toBe('act');
      expect(replies.calls).toBe(1);
    }
  });

  /**
   * Production amazon-gaming-80k misses on c8e6444f (2026-10-05): 4 of 4
   * read the third qualifier as PASS, detoured, and answered with two.
   * MUTATIONS THIS CATCHES: listings a read marked PASS not carried to the
   * brain after the run moved on; one a later read FAILs kept; a listing
   * left undecided ("GPU unclear") or a "Pass/FAIL:" label taken for a PASS.
   */
  test('listings a read marked PASS are carried to the brain until a later read fails one', async () => {
    const first = JSON.stringify([
      { title: 'Halberd X15 RTX 3050', price: '₹79,990', status: 'PASS' },
      { title: 'Mira 5 RTX 2050', price: '₹78,990', status: 'PASS' },
      { title: 'Corsa 15 Radeon', price: '₹58,180', pass_filters: 'Under ₹80,000 (Pass). GPU unclear' },
      { title: 'Lumen Air 14', price: '₹68,900', status: 'FAIL: no dedicated GPU' },
    ]);
    expect(listingVerdicts(first).map((verdict) => [verdict.key, verdict.pass])).toEqual([['halberd x15 rtx 3050', true], ['mira 5 rtx 2050', true], ['lumen air 14', false]]);
    expect(listingVerdicts('Item 1: Title: Vanta G16 | Pass/FAIL: Pass\nItem 2: Title: Raptor 16 | Pass/FAIL: Fail').map((verdict) => verdict.pass)).toEqual([true, false]);
    const later = 'Item 1: Title: Mira 5 RTX 2050 | Price: ₹78,990 | Pass/FAIL: Fail (out of stock)\nItem 2: Title: Raptor 16 | Pass/FAIL: Fail (over price)';
    const task = 'find the 3 best-rated gaming laptops with a dedicated GPU under ₹80,000';
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-11' } }), brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const base = promptFor(TREE, task, 3);
    await port.choose({ ...base, extracted: [{ step: 1, text: `extracted on https://shop.example/a: ${JSON.stringify(first)}` }] } as typeof base);
    expect(provider.requests[0]?.prompt).toMatch(/Qualifying listings your reads marked PASS so far[^\n]*Halberd X15 RTX 3050[^\n]*Mira 5 RTX 2050/u);
    expect(provider.requests[0]?.prompt).not.toMatch(/Qualifying listings[^\n]*Corsa/u);
    await port.choose({ ...promptFor(TREE, task, 4), extracted: [{ step: 1, text: `extracted on https://shop.example/a: ${JSON.stringify(first)}` }, { step: 3, text: `extracted on https://shop.example/b: ${JSON.stringify(later)}` }] } as typeof base);
    const line = /Qualifying listings your reads marked PASS so far[^\n]*/u.exec(provider.requests[1]?.prompt ?? '')?.[0] ?? '';
    expect(line).toContain('Halberd X15 RTX 3050');
    expect(line).not.toContain('Mira 5');
  });

  /** MUTATION THIS CATCHES: a collect task leaving a page with nothing recorded (BrainMeasure M1). */
  test('on a collect task, leaving a page records it as a finding', async () => {
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'navigate', url: 'https://en.wikipedia.org/wiki/Special:Random' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose(promptFor(TREE, 'Open 25 random articles and record each title'));
    expect(choice.envelope?.finding).toContain('On "Cart"');
  });
});

describe('a corrected brain reply in the thread', () => {
  /**
   * MUTATION THIS CATCHES: the turn replayed without the correction its
   * accepted reply answered, so the next call misses the cache entry the
   * retry wrote (4 of 18 production runs, a506a744).
   */
  test('replays the turn exactly as the retry sent it', async () => {
    const provider = new FakeProvider([
      reply('\n<invoke name="x">\n</invoke>'),
      brain({ do: 'act', a: { type: 'click', ref: '0-11' } }),
      brain({ do: 'act', a: { type: 'click', ref: '0-12' } }),
    ]);
    const { port } = brainPort(provider, PLAN, true);
    await port.choose(promptFor(TREE));
    await port.choose(promptFor(TREE, 'check out', 1, [trace(0, 'h0', { action: { type: 'click', ref: nodeRef(0, 11) }, check: { verdict: 'confirmed', saw: 'ok', expected: '', reads: 1, elapsedMs: 0 } } as Partial<StepTrace>)]));
    const retried = provider.requests[1]!.prompt;
    expect(retried).not.toBe(provider.requests[0]!.prompt);
    expect(provider.requests[2]!.turns?.[0]?.content).toBe(retried);
  });
});

describe('the brain keeps one compact thread per run', () => {
  /**
   * MUTATIONS THIS CATCHES: replaying a past page brief (the thread then
   * grows by a whole observation a step), or losing the previous outcome.
   */
  test("step 2 replays step 1 as its compact text and the brain's reply, never the brief", async () => {
    const provider = new FakeProvider([
      eyes(),
      brain({ do: 'act', a: { type: 'click', ref: '0-11' } }),
      eyes([{ ref: '0-21', role: 'button', label: 'Checkout' }]),
      brain({ do: 'done', answer: 'done' }),
    ]);
    const { port } = brainPort(provider);
    const first = promptFor(TREE);
    await port.choose(first);
    const covered = trace(0, first.snapshotHash, { error: 'click(0-11) failed: element is covered' });
    await port.choose(promptFor(cartPage(20), 'check out', 1, [covered]));

    const step1 = provider.requests[1];
    const step2 = provider.requests[3];
    expect(step1?.turns ?? []).toEqual([]);
    expect(step2?.cache).toBe(true);
    expect(step2?.turns?.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    const replayed = step2?.turns?.[0]?.content ?? '';
    // Byte-identical to step 1's cached prompt part, so the cache entry it wrote is read back.
    expect(replayed).toBe(step1?.prompt ?? '');
    expect(replayed).toContain('TASK: check out');
    expect(replayed).not.toContain('Elements');
    expect(step2?.turns?.[1]?.content).toBe(JSON.stringify({ do: 'act', a: { type: 'click', ref: '0-11' } }));
    expect(step2?.prompt).toContain('Last: 0 click the node [0-11] -> failed: click(0-11) failed: element is covered');
    expect(step2?.prompt).not.toContain('TASK:');
  });
});

describe('the brain stays inside its budgets', () => {
  const long = (words: number): string => Array.from({ length: words }, (_, i) => `word${String(i)}`).join(' ');
  const bigTree: AxTree = {
    url: `https://shop.example.com/${'a'.repeat(400)}`,
    root: node({
      role: 'RootWebArea',
      name: long(60),
      xpath: '/html',
      backendNodeId: 1000,
      children: Array.from({ length: 300 }, (_, i) =>
        node({ role: 'link', name: long(40), xpath: `/html/body/a[${String(i)}]`, backendNodeId: 1001 + i }),
      ),
    }),
  };
  const huge = readBrief(
    {
      page: long(200),
      facts: Array.from({ length: 30 }, () => long(60)),
      elements: Array.from({ length: 40 }, (_, i) => ({ ref: `0-${String(1001 + i)}`, role: 'link', label: long(40) })),
    },
    bigTree,
  );

  /** MUTATION THIS CATCHES: an unbounded brief — the "3k or 7k tokens to the brain" defect. */
  test('a brief from a huge page is cut to its budgets, with at most 10 elements of 8 words', () => {
    expect(briefFacts(huge, undefined).length).toBeLessThanOrEqual(BRAIN_BUDGET.facts);
    expect(briefElements(bigTree, huge).length).toBeLessThanOrEqual(BRAIN_BUDGET.elements);
    expect(huge?.elements.length).toBe(10);
    expect(huge?.elements.every((element) => element.label.split(' ').length <= 8)).toBe(true);
  });

  test('every step after the first adds at most step + news + brief, however much the run did', () => {
    const thread = new BrainThread();
    const base = (step: number, history: readonly StepTrace[]): AgentPrompt => {
      const raw = {
        task: long(80),
        step,
        tree: bigTree,
        snapshotHash: hashSnapshot(bigTree),
        history,
        notice: long(300),
        tabs: Array.from({ length: 30 }, (_, i) => ({ id: `t${String(i)}`, url: bigTree.url, active: i === 0 })),
        extracted: Array.from({ length: 20 }, (_, i) => ({ step, text: `${String(i)} ${long(80)}` })),
        memory: {
          goals: [],
          findings: Array.from({ length: 10 }, () => ({ step, text: long(50) })),
          ruledOut: [],
        },
      } as unknown as Omit<AgentPrompt, 'text'>;
      return { ...raw, text: renderPrompt(raw) } as AgentPrompt;
    };
    const first = thread.step(base(0, []));
    thread.commit(0, first, '{"do":"act"}', 'line');
    const second = thread.step(base(1, [trace(0, 'h', { error: long(300) })]));
    const page = `${briefFacts(huge, undefined)}\n${briefElements(bigTree, huge)}`;
    expect(second.length + 1 + page.length).toBeLessThanOrEqual(
      BRAIN_BUDGET.step + 1 + BRAIN_BUDGET.news + 1 + BRAIN_BUDGET.facts + 1 + BRAIN_BUDGET.elements,
    );
  });

  test('the cached system turn (rules + schema) is within its budget', () => {
    expect(BRAIN_SYSTEM_PROMPT.length + JSON.stringify(BRAIN_SCHEMA).length).toBeLessThanOrEqual(BRAIN_BUDGET.system);
  });

  /**
   * MUTATIONS THIS CATCHES: tool replies inside the 1,200-character news block
   * (a 4,000-character web.read reached the brain as its first ~1,150), a
   * queued run of calls read off the loop's three-deep echo window (the
   * earlier replies never reached the brain), and whole replies replayed on
   * every later call. Dev set, 2026-10-14.
   */
  test('queued tool replies reach the brain whole once, the thread keeps their start, and one over the limit is named', () => {
    const thread = new BrainThread();
    const reply = (step: number): ToolCallEcho => ({
      step,
      tool: 'web.read',
      isError: false,
      text: `Page ${String(step)} — https://example.com/${String(step)}\nshowing characters 0-4000 of 9000\n\n${`${String(step)}x`.repeat(1_999)}END${String(step)}`,
    });
    const at = (step: number, toolResults: readonly ToolCallEcho[]): AgentPrompt => ({ ...promptFor(TREE, 'list them', step), toolResults });
    const first = thread.step(at(0, []));
    thread.commit(0, first, '{"do":"act"}', 'line');
    // Four queued reads, steps 1-4: by the brain's turn the loop's prompt holds the last three.
    thread.observe(at(2, [reply(1)]));
    thread.observe(at(3, [reply(1), reply(2)]));
    const turn = thread.step(at(5, [reply(2), reply(3), reply(4)]));
    const once = thread.once();
    for (const step of [1, 2, 3]) {
      expect(once).toContain(reply(step).text);
      expect(turn).toContain(reply(step).text.slice(0, BRAIN_BUDGET.toolKept));
      expect(turn).not.toContain(`END${String(step)}`);
    }
    expect(`${turn}${once}`).not.toContain('END4');
    expect(turn).toContain('reply NOT shown (over this turn\'s limit for tool replies): Page 4 — https://example.com/4');
    thread.commit(5, turn, '{"do":"act"}', 'line');
    expect(thread.step(at(6, [reply(2), reply(3), reply(4)]))).not.toContain('Tool web.read');
    expect(thread.once()).toBe('');
  });

  test("code.run's description reaches the brain whole, where a connector's is cut", () => {
    const thread = new BrainThread();
    const connector = { name: 'inbox.read', description: `Read the inbox. ${'More about mail. '.repeat(20)}MAIL-END` };
    const first = thread.step({ ...promptFor(TREE, 'count them', 0), tools: [...codeRunTools(), connector] });
    expect(CODE_RUN_TOOL_DESCRIPTION.length).toBeGreaterThan(160);
    expect(first).toContain(`Tool ${CODE_RUN_TOOL}: ${CODE_RUN_TOOL_DESCRIPTION}`);
    expect(first).toContain('Tool inbox.read: Read the inbox.');
    expect(first).not.toContain('MAIL-END');
  });

  test("page.script's description reaches the brain whole, where a connector's is cut", () => {
    const thread = new BrainThread();
    const connector = { name: 'inbox.read', description: `Read the inbox. ${'More about mail. '.repeat(20)}MAIL-END` };
    const first = thread.step({ ...promptFor(TREE, 'count them', 0), tools: [...pageScriptTools(), connector] });
    expect(first).toContain(`Tool ${PAGE_SCRIPT_TOOL}: ${PAGE_SCRIPT_TOOL_DESCRIPTION}`);
    expect(first).toContain('Tool inbox.read: Read the inbox.');
    expect(first).not.toContain('MAIL-END');
  });

  test('the largest code.run reply reaches the brain whole in the turn it arrives', async () => {
    // Both streams at the sandbox's 64 KiB cap and a failed exit: the most a reply can carry.
    const port = codeRunToolPort({
      runner: {
        run: async () => ({
          stdout: `${'o'.repeat(65_533)}OUT`,
          stderr: `${'e'.repeat(65_533)}ERR`,
          exitCode: 1,
          timedOut: false,
          stdoutBytes: 900_000,
          stderrBytes: 900_000,
          ms: 59_999,
          coldStart: true,
        }),
      },
    });
    const { text } = await port.call(CODE_RUN_TOOL, { language: 'python', code: 'print(1)' });
    const thread = new BrainThread();
    const at = (step: number, toolResults: readonly ToolCallEcho[]): AgentPrompt => ({ ...promptFor(TREE, 'count them', step), toolResults });
    thread.commit(0, thread.step(at(0, [])), '{"do":"act"}', 'line');
    thread.step(at(1, [{ step: 0, tool: CODE_RUN_TOOL, isError: false, text }]));
    expect(text).toContain('ERR');
    expect(thread.once()).toContain(text);
  });

  test('a code.run reply that does not fit beside the turn\u2019s other replies asks for less output, not a re-run', () => {
    const read: ToolCallEcho = { step: 1, tool: 'web.read', isError: false, text: `Page — https://example.com\n${'r'.repeat(4_200)}` };
    const code: ToolCallEcho = {
      step: 2,
      tool: CODE_RUN_TOOL,
      isError: false,
      text: `code.run (3 of 20) python exited 0 after 2.1 s.\nstdout (12,000 characters):\n${'o'.repeat(12_000)}`,
    };
    const { kept, once } = toolReplies([read, code]);
    expect(once).toContain(read.text);
    expect(once).not.toContain('ooooo');
    expect(kept).toContain(
      'Tool code.run: output NOT shown, too long to show beside the other tool replies this turn: code.run (3 of 20) python exited 0 after 2.1 s.. ' +
        'Print less, or write the output to a file in /work and print a slice of it; do not run the same program again to read it.',
    );
    expect(kept).not.toContain('Call it again');
  });

  test('a brain reply calling code.run with a long program runs directly with the code intact', () => {
    const code = Array.from({ length: 80 }, (_, i) => `rows_${String(i)} = [r.get_text(strip=True) for r in soup.select('table tr')][:${String(i)}]`).join('\n');
    expect(code.length).toBeGreaterThan(5_000);
    const decision = readDecision(JSON.parse(JSON.stringify({ do: 'act', a: { type: 'callTool', tool: CODE_RUN_TOOL, arguments: { language: 'python', code } } })));
    expect(decision?.kind).toBe('act');
    const direct = decision?.kind === 'act' ? directAction(decision.action, undefined, TREE) : undefined;
    expect(direct).toEqual({ ok: true, action: { type: 'callTool', tool: CODE_RUN_TOOL, arguments: { language: 'python', code } } });
  });

  test('the largest page.script reply reaches the brain whole in the turn it arrives', () => {
    const thread = new BrainThread();
    const at = (step: number, toolResults: readonly ToolCallEcho[]): AgentPrompt => ({ ...promptFor(TREE, 'count them', step), toolResults });
    thread.commit(0, thread.step(at(0, [])), '{"do":"act"}', 'line');
    const body = `${'r'.repeat(PAGE_SCRIPT_REPLY_MAX_CHARS - 3)}END`;
    const text = `page.script (1 of 40) returned 30,000 characters; the first 12,000 follow and the other 18,000 were cut (return less: filter, slice or count in the code):\n${body}`;
    thread.step(at(1, [{ step: 0, tool: PAGE_SCRIPT_TOOL, isError: false, text }]));
    expect(thread.once()).toContain(body);
  });

  test('a brain reply calling page.script with a long script runs directly with the code intact', () => {
    const code = Array.from({ length: 80 }, (_, i) => `const row${String(i)} = [...document.querySelectorAll('tr')].map((r) => r.innerText);`).join('\n');
    expect(code.length).toBeGreaterThan(5_000);
    const decision = readDecision(JSON.parse(JSON.stringify({ do: 'act', a: { type: 'callTool', tool: PAGE_SCRIPT_TOOL, arguments: { code } } })));
    expect(decision?.kind).toBe('act');
    const direct = decision?.kind === 'act' ? directAction(decision.action, undefined, TREE) : undefined;
    expect(direct).toEqual({ ok: true, action: { type: 'callTool', tool: PAGE_SCRIPT_TOOL, arguments: { code } } });
  });

  test('a long search reply shows its first results and names the rest as not shown; nothing of it goes once', () => {
    const thread = new BrainThread();
    const hits = Array.from({ length: 10 }, (_, i) => `${String(i + 1)}. Result ${String(i + 1)} — https://r.example/${String(i + 1)}\n   ${'snippet '.repeat(40)}HIT${String(i + 1)}`);
    const text = `10 results for "q":\n${hits.join('\n')}`;
    const first = thread.step(promptFor(TREE, 'find it', 0));
    thread.commit(0, first, '{"do":"act"}', 'line');
    const turn = thread.step({ ...promptFor(TREE, 'find it', 1), toolResults: [{ step: 0, tool: 'web.search', isError: false, text }] });
    expect(turn).toContain(text.slice(0, BRAIN_BUDGET.toolKept));
    expect(turn).not.toContain('HIT10');
    expect(turn).toContain('of these results were not shown');
    expect(thread.once()).toBe('');
  });

  test('the port sends a tool reply whole in the never-replayed tail, and never onto the step record', async () => {
    const text = `Long page — https://example.com/long\nshowing characters 0-4000 of 9000\n\n${'word '.repeat(790)}LASTWORDS`;
    const provider = new FakeProvider([brain({ do: 'act', a: { type: 'click', ref: '0-11' } })]);
    const { port } = brainPort(provider, PLAN, true);
    const choice = await port.choose({ ...promptFor(TREE, 'read it', 1), toolResults: [{ step: 0, tool: 'web.read', isError: false, text }] });
    expect(provider.requests[0]?.tail).toContain(text);
    expect(provider.requests[0]?.prompt).not.toContain('LASTWORDS');
    expect(JSON.stringify(choice.brief)).not.toContain('Long page');
  });
});

describe('the eyes are checked, not trusted', () => {
  test('an invented ref is dropped and counted; the label shown is the tree’s own', () => {
    const brief = readBrief(
      {
        page: 'cart',
        facts: [],
        elements: [
          { ref: '0-11', role: 'link', label: 'Proceed' },
          { ref: '0-99', role: 'button', label: 'Buy now' },
        ],
      },
      TREE,
    );
    expect(brief?.elements).toEqual([{ ref: '0-11', role: 'button', label: 'Checkout', state: '' }]);
    expect(brief?.dropped).toBe(1);
  });

  /**
   * MUTATIONS THIS CATCHES: state taken from the eyes' prose instead of the
   * tree — the BrainMeasure losses G1/L1 (a disabled button shown without
   * "(disabled)"), O2 (a refused field shown without its real value and error)
   * and I1 (a dialog's close control never offered).
   */
  test('state, field values, validation text, alerts and dismiss controls come from the tree', () => {
    const tree: AxTree = {
      url: 'https://shop.example.com/checkout',
      root: node({
        role: 'RootWebArea',
        name: 'Checkout',
        xpath: '/html',
        backendNodeId: 1,
        children: [
          node({ role: 'button', name: 'Details', xpath: '/a', backendNodeId: 2, state: { disabled: true } }),
          node({
            role: 'group',
            name: 'Phone',
            xpath: '/b',
            backendNodeId: 3,
            children: [
              node({ role: 'textbox', name: 'Phone', value: '+1 302-555-014', xpath: '/b/i', backendNodeId: 4 }),
              node({ role: 'StaticText', name: 'Enter a valid phone number', xpath: '/b/t', backendNodeId: 5 }),
            ],
          }),
          node({ role: 'alert', name: 'Your session expires in 2 minutes', xpath: '/c', backendNodeId: 6 }),
          node({ role: 'button', name: 'Close newsletter popup', xpath: '/d', backendNodeId: 7 }),
        ],
      }),
    };
    const brief = readBrief(
      {
        page: 'checkout',
        facts: [],
        elements: [
          { ref: '0-2', role: 'button', label: 'Details' },
          { ref: '0-4', role: 'textbox', label: 'Phone: +1 302-555-0142' },
        ],
      },
      tree,
    );
    const shown = briefElements(tree, brief);
    expect(shown).toContain('[0-2] button "Details" (disabled)');
    expect(shown).toContain('[0-4] textbox "Phone" = "+1 302-555-014" error "Enter a valid phone number"');
    expect(shown).toContain('[0-7] button "Close newsletter popup"');
    expect(briefFacts(brief, undefined)).toContain('Alert: "Your session expires in 2 minutes"');
  });
});

describe('the elements tail against the facts', () => {
  /**
   * MUTATIONS THIS CATCHES: an item title sent twice in full (Facts and
   * Elements; 22% of the tail on the dev guard), a deduped element left with
   * no ref to act on, and a label Facts does not say shortened.
   */
  test('an element whose label a shown fact says is listed by its ref and the label start; the rest stay whole', () => {
    const titles: string[] = Array.from({ length: 6 }, (_, i) => `Crucial ${String(8 + i * 8)}GB DDR4 3200MHz CL22 Desktop Memory CT${String(i)}`);
    const tree: AxTree = {
      url: 'https://www.amazon.in/s?k=ram',
      root: node({
        role: 'RootWebArea',
        name: 'Amazon.in : ram',
        xpath: '/html',
        backendNodeId: 1,
        children: [
          ...titles.flatMap((title, i) => [
            node({ role: 'link', name: title, xpath: `/t${String(i)}`, backendNodeId: 10 + i * 3 }),
            node({ role: 'StaticText', name: `₹${String(2000 + i * 900)}`, xpath: `/p${String(i)}`, backendNodeId: 11 + i * 3 }),
          ]),
          node({ role: 'button', name: 'Sort by: Featured, price and customer review', xpath: '/s', backendNodeId: 90 }),
        ],
      }),
    };
    const brief = selectBrief(tree, 'cheapest 16GB DDR4 desktop RAM on amazon india');
    const facts = briefFacts(brief, undefined);
    const shown = briefElements(tree, brief);
    const listed = brief.elements.find((element) => element.label === titles[1]);
    expect(listed).toBeDefined();
    expect(facts).toContain(titles[1]!);
    expect(shown).toContain(`[${listed!.ref}] link "Crucial 16GB DDR4…"`);
    expect(shown).not.toContain(titles[1]!);
    expect(shown).toContain('"Sort by: Featured, price and customer review"');
  });
});

describe('a navigate that only timed out or did not commit', () => {
  const go = (index: number, url: string, extra: Partial<StepTrace>): StepTrace =>
    ({ index, action: { type: 'navigate', url }, cache: { status: 'MISS' }, elapsedMs: 1, snapshotHash: `h${String(index)}`, credits: '0', spent: '0', pages: 1, durationMs: 1, usage: {}, at: '2026-10-03T00:00:00.000Z', ...extra }) as unknown as StepTrace;
  const URL_A = 'https://shop.example.com/p/123?variant=blue';

  /** MUTATIONS THIS CATCHES: a single timeout or no-commit ruling the URL out (sealed heldout4 mode: the run dropped the ?variant= qualifier and answered another version); a second identical failure, or a definite failure, let through. */
  test('is open to one exact retry; a second identical failure or a definite one rules it out', () => {
    for (const once of [
      go(0, URL_A, { error: 'https://shop.example.com/p/123 did not commit a document response within 20000ms' } as Partial<StepTrace>),
      go(0, URL_A, { check: { verdict: 'contradicted', saw: 'the browser is still on https://shop.example.com/', expected: '', reads: 1, elapsedMs: 0 } } as Partial<StepTrace>),
      go(0, URL_A, { error: 'navigation failed: net::ERR_TIMED_OUT' } as Partial<StepTrace>),
    ]) {
      expect(repeatedActions([once]).size).toBe(0);
      expect(retryableNavigations([once])).toEqual([`navigate ${URL_A}`]);
      const twice = repeatedActions([once, { ...once, index: 1 }]).get(`navigate ${URL_A}`);
      expect(twice?.failed).toBe(true);
      expect(retryableNavigations([once, { ...once, index: 1 }])).toEqual([]);
    }
    for (const definite of [
      go(0, URL_A, { error: 'navigation failed: net::ERR_NAME_NOT_RESOLVED' } as Partial<StepTrace>),
      go(0, URL_A, { error: 'the site answered HTTP 403 Forbidden' } as Partial<StepTrace>),
    ]) {
      expect(repeatedActions([definite]).get(`navigate ${URL_A}`)?.failed).toBe(true);
      expect(retryableNavigations([definite])).toEqual([]);
    }
  });
});

