/**
 * `@outcrawl/runtime` — the agent loop.
 *
 * ```
 * AX snapshot -> model picks an action -> action-lock freezes the page
 *             -> act on a frame-qualified node id -> repeat
 * ```
 *
 * The browser is an injected interface: this package opens no socket, speaks
 * no CDP and spawns no process, so the whole loop is exercised against a fake.
 *
 * Three invariants are the product:
 * - the lock is held across think **and** act, which removes TOCTOU rather
 *   than healing after it;
 * - node references are frame-qualified, because backend node ids collide
 *   across renderer processes under Site Isolation;
 * - a capped or partial run returns the data it collected. Published success
 *   rates are 42–71%, so that is the common path.
 */

export * from './actions';
export * from './allowance';
export * from './caps';
export * from './code-run';
export * from './fan';
export * from './look';
export * from './loop';
export * from './native-date';
export * from './page-script';
export * from './result';
export * from './resume';
export * from './rules';
export * from './settle';
export * from './site-check';
export * from './site-skills';
export * from './snapshot';
export * from './text-captcha';
export * from './verify';
export * from './view';
