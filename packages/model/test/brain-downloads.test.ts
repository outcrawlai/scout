/**
 * scout-1's brain on a run whose downloads are kept: one line in its run
 * header, and nothing at all on a run whose are not. Driven through the real
 * `runAgent` and `HarnessModelPort` with the production brain plan, so the
 * prompt asserted is the one the port sends.
 *
 * Fleet 2026-10-19 22:22Z, run_ab036fe8 (the fleet, n=1): the browser stored two
 * files on the first two steps, and the brain, never told, fetched both again
 * with code.run and answered that they were on the sandbox's disk.
 */
import { describe, expect, test } from 'bun:test';
import { runAgent, type AgentDeps, type AxTree } from '@outcrawl/runtime';

import { HarnessModelPort } from '../src/harness';
import { CostLedger } from '../src/ledger';
import { BRAIN_MODEL as BRAIN, FakeProvider, VirtualClock, brainPlan, cartPage, reply } from './support';

const PAGE: AxTree = { ...cartPage(30), url: 'https://tenders.example/pack' };
const finish = reply(JSON.stringify({ do: 'done', why: 'done', answer: 'done' }), {}, '0.002');

async function brainSaw(downloadsKept: boolean | undefined): Promise<string> {
  const provider = new FakeProvider([finish]);
  const ledger = new CostLedger();
  const port = new HarnessModelPort({
    plan: brainPlan({}),
    provider,
    session: { sessionId: 'run-dl', accountId: 'acct-9' },
    ledger,
    clock: new VirtualClock(),
    actionReasoning: { enabled: false },
  });
  const deps: AgentDeps = {
    snapshot: () => PAGE,
    lock: () => undefined,
    unlock: () => undefined,
    perform: () => ({}),
    extract: () => Promise.reject(new Error('no extraction in this run')),
    model: port.choose,
    modelCostUsd: () => ledger.totalsFor('run-dl').costUsd,
    clock: new VirtualClock(),
    ...(downloadsKept === undefined ? {} : { downloadsKept }),
  };
  await runAgent(deps, { task: 'download every document in the tender pack', caps: { steps: 4, budget: '5.00', duration: '5m' }, stepFailures: 1, settle: false });
  return JSON.stringify(provider.requests.find((entry) => entry.model === BRAIN) ?? null);
}

describe("the brain's run header and kept downloads", () => {
  test('a run whose downloads are kept tells the brain once, and a run whose are not is byte-identical to before', async () => {
    const kept = await brainSaw(true);
    expect(kept).toContain('Files the browser downloads are kept for the person who started this run');
    expect(kept).toContain('not with code.run');
    expect(kept.split('Files the browser downloads are kept').length - 1).toBe(1);

    const absent = await brainSaw(undefined);
    expect(absent).not.toContain('Files the browser downloads are kept');
    expect(await brainSaw(false)).toBe(absent);
  });
});
