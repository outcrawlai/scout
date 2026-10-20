import { describe, expect, test } from 'bun:test';

import type { Action } from '../src/actions';
import { GUEST_BOUNCE_RETRIES, guestBounceReturn, runAgent } from '../src/loop';
import { harness, node, tree } from './support';

const done: Action = { type: 'done', summary: 'finished' };
const caps = { steps: 8, budget: '99.00', duration: '5m' };
const search = 'https://shop.example/search_result.html?search_key=rain%20jacket';
const signIn = (back: string) => `https://shop.example/login.html?from=${encodeURIComponent(back)}&login_scene=2`;

/**
 * A site that answers a guest's search with its sign-in page, naming the
 * search as the page to return to, for the first `bounces` loads of it, and
 * with the results after that.
 */
function site(bounces: number, landsAt: (url: string) => string = signIn, first: string = search) {
  const navigated: string[] = [];
  const asked: number[] = [];
  const notices: (string | undefined)[] = [];
  let at = 'https://shop.example/';
  const h = harness({
    snapshot: () =>
      at === search
        ? tree(node({ role: 'RootWebArea', name: 'Results', children: [node({ role: 'link', name: 'Rain jacket $12.99' })] }), at)
        : tree(node({ role: 'RootWebArea', name: 'Sign in / Register', children: [node({ role: 'textbox', name: 'Email' })] }), at),
    perform: (action) => {
      if (action.type !== 'navigate') return;
      navigated.push(action.url);
      at = navigated.length <= bounces ? landsAt(action.url) : action.url;
    },
    model: (prompt, step) => {
      asked.push(step);
      notices.push(prompt.notice);
      return { action: step === 0 ? { type: 'navigate', url: first } : done };
    },
  });
  return { h, navigated, asked, notices };
}

describe('a page the site sent to its sign-in page is loaded again by the host', () => {
  /**
   * MUTATIONS THIS CATCHES: the sign-in page handed to the model (asked at
   * step 1); the load asked of the model; the model not told what was done.
   */
  test('with no model call until the site lets it through, and the model is told', async () => {
    const { h, navigated, asked, notices } = site(2);
    const result = await runAgent(h.deps, { task: 'search the shop for a rain jacket', caps, stepFailures: 3 });

    expect(navigated).toEqual([search, search, search]);
    expect(asked).toEqual([0, 3]);
    expect(result.steps[1]?.reasoning).toContain('loaded again by the host');
    expect(notices[1]).toContain(`(2 of ${String(GUEST_BOUNCE_RETRIES)})`);
  });

  /** MUTATION THIS CATCHES: a load loop on a site that never lets a guest through. */
  test(`at most ${String(GUEST_BOUNCE_RETRIES)} times per url, then the sign-in page is the model's`, async () => {
    const { h, navigated, asked, notices } = site(99);
    await runAgent(h.deps, { task: 'search the shop for a rain jacket', caps, stepFailures: 3 });

    expect(navigated).toEqual(Array(1 + GUEST_BOUNCE_RETRIES).fill(search));
    expect(asked).toEqual([0, 1 + GUEST_BOUNCE_RETRIES]);
    expect(notices[1]).toContain('will not be loaded again');
  });

  /**
   * MUTATIONS THIS CATCHES: a sign-in page loaded again when it returns
   * somewhere else (the site's home, after a search typed into its box); a
   * sign-in page the run itself opened treated as a bounce.
   */
  test('not when the sign-in page returns elsewhere, nor when the run opened the sign-in page itself', async () => {
    const elsewhere = site(1, () => signIn('https://shop.example/'));
    await runAgent(elsewhere.h.deps, { task: 'search the shop', caps: { ...caps, steps: 2 }, stepFailures: 3 });
    expect(elsewhere.navigated).toEqual([search]);
    expect(elsewhere.asked).toEqual([0, 1]);

    const own = site(0, signIn, signIn(search));
    await runAgent(own.h.deps, { task: 'sign in', caps: { ...caps, steps: 2 }, stepFailures: 3 });
    expect(own.navigated).toEqual([signIn(search)]);
    expect(own.asked).toEqual([0, 1]);
  });
});

describe('guestBounceReturn', () => {
  test('reads the return target from any query key, absolute or relative, on the common sign-in paths', () => {
    expect(guestBounceReturn(search, signIn(search))).toBe(search);
    expect(guestBounceReturn('https://www.site.example/jobs/search?q=x', 'https://www.site.example/authwall?sessionRedirect=%2Fjobs%2Fsearch%3Fq%3Dx')).toBe(
      'https://www.site.example/jobs/search?q=x',
    );
    expect(guestBounceReturn('https://site.example/s?k=lamp', 'https://site.example/ap/signin?openid.return_to=https%3A%2F%2Fsite.example%2Fs%3Fk%3Dlamp')).toBe(
      'https://site.example/s?k=lamp',
    );
    // A page that is not a sign-in page, however it names the search.
    expect(guestBounceReturn(search, `https://shop.example/bgn_verification.html?from=${encodeURIComponent(search)}`)).toBeUndefined();
    // A sign-in page naming another page of the site.
    expect(guestBounceReturn(search, signIn('https://shop.example/search_result.html?search_key=other'))).toBeUndefined();
  });
});
