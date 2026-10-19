import { describe, expect, test } from 'bun:test';

import { compileRules } from '@outcrawl/scout-core';

import type { Action } from '../src/actions';
import type { ModelChoice, ToolPort } from '../src/loop';
import { renderPrompt, runAgent } from '../src/loop';
import { RuleBlockedError, checkRules, renderRules } from '../src/rules';
import type { AxTree } from '../src/snapshot';
import { harness, node, refOf, tree } from './support';

const CAPS = { steps: 8, budget: '2.00', duration: '5m' };

/**
 * A checkout page shaped the way the AX tree really renders one: the total's
 * label and the total's number are two adjacent `StaticText` nodes, and the
 * commit button's own label carries no number at all. A page where the number
 * sat on the button would be the easy case and is not the common one.
 */
function checkoutPage(total: string): AxTree {
  return tree(
    node({
      role: 'RootWebArea',
      name: 'Checkout',
      children: [
        node({ role: 'heading', name: 'Order summary' }),
        node({ role: 'StaticText', name: 'Order total' }),
        node({ role: 'StaticText', name: total }),
        node({ role: 'textbox', name: 'Card number', value: '4242 4242 4242 4242' }),
        node({ role: 'button', name: 'Place order' }),
        node({ role: 'button', name: 'Back' }),
      ],
    }),
    'https://shop.example.com/checkout',
  );
}

function script(...choices: readonly ModelChoice[]) {
  return (_prompt: unknown, step: number): ModelChoice =>
    choices[step] ?? { action: { type: 'done', summary: 'finished' } };
}

describe('a spend ceiling BLOCKS the dispatch rather than warning about it', () => {
  test('a £249.99 order under a £200 ceiling never reaches the page', async () => {
    const page = checkoutPage('£249.99');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    const result = await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200']),
    });

    // THE ASSERTION THIS WHOLE SLICE EXISTS FOR: the browser was never asked to
    // do it. `performed` is the harness's record of what crossed
    // `AgentDeps.perform`, which in production is input through `agenthands`,
    // and `events` is every boundary crossing in order — so a click that was
    // refused after landing would show up in both.
    expect(h.performed).toEqual([]);
    expect(h.events).not.toContain('perform');

    // And the refusal is on the run's own evidence, naming the customer's rule
    // and the number that tripped it, so a replay says why.
    const step = result.steps[0];
    expect(step?.error).toContain('rule blocked this action');
    expect(step?.error).toContain('Never spend over £200');
    expect(step?.error).toContain('GBP 249.99');
    expect(step?.error).toContain('GBP 200.00');
  });

  test('the same page under the same ceiling dispatches when the total fits', async () => {
    // The control arm, and it is what separates a gate from a brick: a rule
    // that refused every checkout would pass the test above and be useless.
    const page = checkoutPage('£150.00');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200']),
    });

    expect(h.performed).toEqual([placeOrder]);
  });

  test('a commit whose amount cannot be read is refused, not waved through', () => {
    // FAILING TOWARD BLOCKING. The page is a checkout by URL and carries a card
    // field, so the classifier says this click may commit — and there is no
    // total anywhere to check against the ceiling. Passing it would be the one
    // outcome the customer cannot recover from.
    const page = tree(
      node({
        role: 'RootWebArea',
        name: 'Checkout',
        children: [
          node({ role: 'textbox', name: 'Card number', value: '' }),
          node({ role: 'button', name: 'Continue' }),
        ],
      }),
      'https://shop.example.com/checkout',
    );
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'click', ref: refOf(page, 'Continue') },
      node: node({ role: 'button', name: 'Continue', ref: refOf(page, 'Continue') }),
      tree: page,
      history: [],
    });

    expect(refusal?.evidence).toContain('no amount could be read');
  });

  test('a total in another currency is refused rather than converted', () => {
    const page = checkoutPage('$249.99');
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'click', ref: refOf(page, 'Place order') },
      node: node({ role: 'button', name: 'Place order', ref: refOf(page, 'Place order') }),
      tree: page,
      history: [],
    });

    // There is no FX rate anywhere in this product. Guessing one is the only
    // thing worse than refusing.
    expect(refusal?.evidence).toContain('USD 249.99');
    expect(refusal?.evidence).toContain('converts between currencies');
  });

  test('a ceiling does not gate a dispatch that commits nothing', () => {
    const page = checkoutPage('£249.99');
    const refusal = checkRules(compileRules(['Never spend over £200']), {
      action: { type: 'fill', ref: refOf(page, 'Card number'), text: '4242' },
      node: node({ role: 'textbox', name: 'Card number', ref: refOf(page, 'Card number') }),
      tree: page,
      history: [],
    });

    expect(refusal).toBeUndefined();
  });
});

describe('a domain rule blocks the navigation before the browser is sent', () => {
  test('a denied host never reaches perform', async () => {
    const page = checkoutPage('£10.00');
    const h = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://www.ebay.com/itm/1' } }),
    });

    const result = await runAgent(h.deps, {
      task: 'find it',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never use ebay.com']),
    });

    expect(h.performed).toEqual([]);
    // Subdomains are covered: the rule said `ebay.com` and the model tried
    // `www.ebay.com`.
    expect(result.steps[0]?.error).toContain('www.ebay.com is covered by the denied host ebay.com');
  });

  test('an allow-list refuses everything it does not name, and admits subdomains', async () => {
    const page = checkoutPage('£10.00');
    const allowed = compileRules(['Only use github.com']);

    const off = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://gitlab.com/x' } }),
    });
    await runAgent(off.deps, {
      task: 'read the repo',
      caps: CAPS,
      stepFailures: null,
      rules: allowed,
    });
    expect(off.performed).toEqual([]);

    const on = harness({
      tree: page,
      model: script({ action: { type: 'navigate', url: 'https://docs.github.com/x' } }),
    });
    await runAgent(on.deps, {
      task: 'read the repo',
      caps: CAPS,
      stepFailures: null,
      rules: allowed,
    });
    expect(on.performed).toEqual([{ type: 'navigate', url: 'https://docs.github.com/x' }]);
  });
});

describe('a confirmation rule blocks an irreversible dispatch', () => {
  test('an order commit is refused when the customer asked to be asked first', async () => {
    const page = checkoutPage('£10.00');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    const result = await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Ask me before you place an order']),
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('irreversible order action');
  });

  test('a rule about messages does not refuse an order', () => {
    const page = checkoutPage('£10.00');
    const refusal = checkRules(compileRules(['Never send a message without asking me']), {
      action: { type: 'click', ref: refOf(page, 'Place order') },
      node: node({ role: 'button', name: 'Place order', ref: refOf(page, 'Place order') }),
      tree: page,
      history: [],
    });

    // Reading a message rule as covering a purchase would be us inventing a
    // restriction the customer did not write.
    expect(refusal).toBeUndefined();
  });
});

describe('guidance is guidance: it reaches the prompt and gates nothing', () => {
  test('a guidance rule never refuses a dispatch', async () => {
    const page = checkoutPage('£249.99');
    const placeOrder: Action = { type: 'click', ref: refOf(page, 'Place order') };
    const h = harness({ tree: page, model: script({ action: placeOrder }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Prefer sellers with good reviews']),
    });

    expect(h.performed).toEqual([placeOrder]);
  });

  test('both classes are in the prompt and the enforced ones say they are enforced', async () => {
    const page = checkoutPage('£10.00');
    const h = harness({ tree: page, model: script({ action: { type: 'done', summary: 'x' } }) });

    await runAgent(h.deps, {
      task: 'buy the thing',
      caps: CAPS,
      stepFailures: null,
      rules: compileRules(['Never spend over £200', 'Prefer sellers with good reviews']),
    });

    const text = h.prompts[0]?.text ?? '';
    expect(text).toContain('ENFORCED');
    expect(text).toContain('Never spend over £200');
    expect(text).toContain('GUIDANCE');
    expect(text).toContain('Prefer sellers with good reviews');
  });

  test('a run with no rules renders the prompt it rendered before rules existed', () => {
    const page = checkoutPage('£10.00');
    const base = {
      task: 'buy the thing',
      step: 0,
      tree: page,
      snapshotHash: 'ax1:0',
      history: [],
    } as const;

    // The switch-is-off guarantee, asserted rather than hoped: an absent rule
    // set and an empty one both render the byte-identical string.
    expect(renderPrompt({ ...base, rules: [] })).toBe(renderPrompt(base));
    expect(renderRules([])).toBe('');
  });
});

describe('the refusal is legible to a human and to the model', () => {
  test('RuleBlockedError names the rule, the evidence and the enforcement', () => {
    const error = new RuleBlockedError({
      rule: 'Never spend over £200',
      gate: { kind: 'spend_ceiling', currency: 'GBP', amount: '200.00' },
      evidence: 'this dispatch would commit GBP 249.99',
    });

    expect(error.message).toContain('Never spend over £200');
    expect(error.message).toContain('GBP 249.99');
    // The model is told the class, not just the refusal, so it does not spend a
    // second step discovering that arguing is not an option.
    expect(error.message).toContain('ENFORCED, not advice');
  });
});

describe('an email address nobody gave the run is never typed into a page', () => {
  /**
   * Production 2026-10-04, IW2 run_… (n=1): asked to add a product to
   * the cart, the run typed "test@example.com" into a store's "$30 off"
   * sign-up form. The same footer form, as the AX tree renders it.
   */
  const store = tree(
    node({
      role: 'RootWebArea',
      name: 'Honey Birdette',
      children: [
        node({ role: 'StaticText', name: 'ENTER YOUR EMAIL & GET $30 OFF.' }),
        node({ role: 'textbox', name: 'EMAIL ADDRESS*' }),
        node({ role: 'button', name: 'GET $30 OFF' }),
        node({ role: 'link', name: 'View Skeletina Set' }),
      ],
    }),
    'https://us.honeybirdette.com/',
  );
  const typeEmail = (text: string): Action => ({ type: 'fill', ref: refOf(store, 'EMAIL ADDRESS*'), text });

  test('a made-up address is refused before the page is touched, with what to do instead', async () => {
    const h = harness({ tree: store, model: script({ action: typeEmail('test@example.com') }) });

    const result = await runAgent(h.deps, {
      task: 'Add any one product to the cart and reach the cart page, closing any discount popup that appears first.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('"test@example.com" is an email address that neither the task nor the page gave you');
    expect(result.steps[0]?.error).toContain('close it with its close control or Escape');
  });

  test('an address the task gave is typed', async () => {
    const fill = typeEmail('jane.doe@acme.io');
    const h = harness({ tree: store, model: script({ action: fill }) });

    await runAgent(h.deps, {
      task: 'Join the newsletter as jane.doe@acme.io.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([fill]);
  });

  test('a task that asks for made-up values gets the made-up address typed', async () => {
    for (const task of ['Sign up for the newsletter with a test email.', 'Fill the sign-up form with dummy values.']) {
      const fill = typeEmail('test@example.com');
      const h = harness({ tree: store, model: script({ action: fill }) });

      const result = await runAgent(h.deps, { task, caps: CAPS, stepFailures: null });

      expect(h.performed).toEqual([fill]);
      expect(result.steps[0]?.error).toBeUndefined();
    }
  });

  /** A volunteer sign-up page: the form the task means, and a newsletter box in the footer. */
  const signup = tree(
    node({
      role: 'RootWebArea',
      name: 'Volunteer sign-up',
      children: [
        node({ role: 'textbox', name: 'Full name', state: { required: true } }),
        node({ role: 'textbox', name: 'Email', state: { required: true } }),
        node({ role: 'textbox', name: 'Work email *' }),
        node({ role: 'button', name: 'Register' }),
        node({ role: 'textbox', name: 'Get our newsletter' }),
      ],
    }),
    'https://volunteers.test/signup',
  );
  const fillTask = 'Open the volunteer page, fill out the registration form and submit it.';

  test('a task that says to fill in and submit a form gets a test-domain address typed into its required fields', async () => {
    for (const field of ['Email', 'Work email *']) {
      const fill: Action = { type: 'fill', ref: refOf(signup, field), text: 'jane.doe@example.com' };
      const h = harness({ tree: signup, model: script({ action: fill }) });

      const result = await runAgent(h.deps, { task: fillTask, caps: CAPS, stepFailures: null });

      expect(h.performed).toEqual([fill]);
      expect(result.steps[0]?.error).toBeUndefined();
    }
  });

  test('on a form task an address at a real domain is refused and the run is told to use example.com', async () => {
    const h = harness({
      tree: signup,
      model: script({ action: { type: 'fill', ref: refOf(signup, 'Email'), text: 'jane.doe@gmail.com' } }),
    });

    const result = await runAgent(h.deps, { task: fillTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('"jane.doe@gmail.com"');
    expect(result.steps[0]?.error).toContain('use one at example.com');
  });

  /**
   * A form drawn inside a shadow root, as BU Bench run 3 met it (2026-10-14,
   * run_…): the email field reached the tree with no required state and no
   * asterisk in its name.
   */
  const shadowForm = tree(
    node({
      role: 'RootWebArea',
      name: 'Contact us',
      children: [
        node({ role: 'textbox', name: 'Full Name' }),
        node({ role: 'textbox', name: 'Email' }),
        node({ role: 'button', name: 'Submit' }),
      ],
    }),
    'https://contact.test/',
  );
  const shadowTask = 'Go to the page and complete the contact form by filling in all required fields and submitting.';

  test('on a form task a test-domain address is typed into a field the tree does not mark required', async () => {
    const fill: Action = { type: 'fill', ref: refOf(shadowForm, 'Email'), text: 'test@example.com' };
    const h = harness({ tree: shadowForm, model: script({ action: fill }) });

    const result = await runAgent(h.deps, { task: shadowTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([fill]);
    expect(result.steps[0]?.error).toBeUndefined();
  });

  test('on a form task a real domain in a field the tree does not mark required is refused, pointing at example.com', async () => {
    const h = harness({
      tree: shadowForm,
      model: script({ action: { type: 'fill', ref: refOf(shadowForm, 'Email'), text: 'test@gmail.com' } }),
    });

    const result = await runAgent(h.deps, { task: shadowTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('"test@gmail.com"');
    expect(result.steps[0]?.error).toContain('use one at example.com');
  });

  /** A puzzle page whose first level is a form of required personal fields. */
  const challenge = tree(
    node({
      role: 'RootWebArea',
      name: 'Puzzle trail: level 1',
      children: [
        node({ role: 'textbox', name: 'First Name *' }),
        node({ role: 'textbox', name: 'Email *' }),
        node({ role: 'button', name: 'Next level' }),
        node({ role: 'textbox', name: 'Get our newsletter' }),
      ],
    }),
    'https://puzzles.test/trail/1',
  );
  const challengeTask = 'Open the puzzle trail and complete the challenge on its first level.';

  test('a task that says to complete the page\u2019s challenge gets a test-domain address into its required field', async () => {
    const fill: Action = { type: 'fill', ref: refOf(challenge, 'Email *'), text: 'john.smith@example.com' };
    const h = harness({ tree: challenge, model: script({ action: fill }) });

    const result = await runAgent(h.deps, { task: challengeTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([fill]);
    expect(result.steps[0]?.error).toBeUndefined();
  });

  test('on a challenge task a real domain is still refused', async () => {
    const h = harness({
      tree: challenge,
      model: script({ action: { type: 'fill', ref: refOf(challenge, 'Email *'), text: 'john.smith@gmail.com' } }),
    });

    const result = await runAgent(h.deps, { task: challengeTask, caps: CAPS, stepFailures: null });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('use one at example.com');
  });

  test('a task that reads a sign-up page and does not complete it still refuses the address', async () => {
    const h = harness({ tree: challenge, model: script({ action: { type: 'fill', ref: refOf(challenge, 'Email *'), text: 'john.smith@example.com' } }) });

    const result = await runAgent(h.deps, {
      task: 'Complete the following site task. 1. Click "Create account" and report what fields are required on the first signup page.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('neither the task nor the page gave you');
  });

  test('a task that only reads a form\u2019s fields does not permit filling them', async () => {
    const h = harness({
      tree: signup,
      model: script({ action: { type: 'fill', ref: refOf(signup, 'Email'), text: 'jane.doe@example.com' } }),
    });

    const result = await runAgent(h.deps, {
      task: 'Complete these steps. 1. Open the volunteer page and list which fields the registration form requires.',
      caps: CAPS,
      stepFailures: null,
    });

    expect(h.performed).toEqual([]);
    expect(result.steps[0]?.error).toContain('neither the task nor the page gave you');
  });

  /**
   * OC-370, BU Bench task 80: a store's sign-in wall in front of the search.
   * A connected inbox's reply carries the address the run may sign up with.
   */
  const wall = tree(
    node({
      role: 'RootWebArea',
      name: 'Sign in / Register',
      children: [node({ role: 'textbox', name: 'Email or phone number' }), node({ role: 'button', name: 'Continue' })],
    }),
    'https://shop.test/login.html',
  );
  const typeInto = (text: string): Action => ({ type: 'fill', ref: refOf(wall, 'Email or phone number'), text });
  const searchTask = 'Search the store for wireless earbuds and report the price of the first result.';
  /** A port whose tools answer the given replies; `connectors` names the services among them. */
  const servicePort = (replies: Readonly<Record<string, string>>, connectors: readonly string[]): ToolPort => ({
    list: () => Object.keys(replies).map((name) => ({ name, description: name })),
    connectors: () => connectors.map((name) => ({ name })),
    call: (tool) => ({ isError: false, text: replies[tool] ?? '' }),
  });
  const MAIL = {
    'mail.create_inbox': 'Created inbox {"inbox_id":"Scout-7@agentmail.to"}',
    'mail.list_messages': '{"messages":[{"from":"Shop <code@shop.test>","to":["scout-7@agentmail.to"],"preview":"or write to help@vendor.io"}]}',
  };
  const call = (tool: string): ModelChoice => ({ action: { type: 'callTool', tool, arguments: {} } });

  test('the run\u2019s own inbox is typed only after the service made it, and no other address is', async () => {
    const mine = typeInto('scout-7@agentmail.to');
    const h = harness({
      tree: wall,
      model: script({ action: mine }, call('mail.create_inbox'), { action: mine }, { action: typeInto('someone.else@agentmail.to') }),
    });

    const result = await runAgent({ ...h.deps, tools: servicePort(MAIL, ['mail']) }, { task: searchTask, caps: CAPS, stepFailures: 3 });

    expect(h.performed).toEqual([mine]);
    expect(result.steps[0]?.error).toContain('"scout-7@agentmail.to" is an email address that neither the task nor the page gave you');
    expect(result.steps[2]?.error).toBeUndefined();
    expect(result.steps[3]?.error).toContain('"someone.else@agentmail.to" is an email address that neither');
  });

  test('a sender or an address in a message is not the run\u2019s own inbox: still refused', async () => {
    for (const address of ['code@shop.test', 'help@vendor.io']) {
      const h = harness({ tree: wall, model: script(call('mail.create_inbox'), call('mail.list_messages'), { action: typeInto(address) }) });

      const result = await runAgent({ ...h.deps, tools: servicePort(MAIL, ['mail']) }, { task: searchTask, caps: CAPS, stepFailures: 3 });

      expect(h.performed).toEqual([]);
      expect(result.steps[2]?.error).toContain(`"${address}" is an email address that neither`);
    }
  });

  test('a mailbox that cannot make an inbox gives no address, and a built-in tool\u2019s reply never does', async () => {
    // A person's own Gmail, and a connector a customer named `web` beside the built-in web.read.
    const cases = [
      { replies: { 'gmail.search_messages': 'From: jane@customer.com' }, connectors: ['gmail'], tool: 'gmail.search_messages', address: 'jane@customer.com' },
      { replies: { 'web.create_inbox': 'x@agentmail.to', 'web.read': 'Contact scout-9@agentmail.to' }, connectors: ['web'], tool: 'web.read', address: 'scout-9@agentmail.to' },
    ];
    for (const { replies, connectors, tool, address } of cases) {
      const h = harness({ tree: wall, model: script(call(tool), { action: typeInto(address) }) });

      const result = await runAgent({ ...h.deps, tools: servicePort(replies, connectors) }, { task: searchTask, caps: CAPS, stepFailures: 3 });

      expect(h.performed).toEqual([]);
      expect(result.steps[1]?.error).toContain(`"${address}" is an email address that neither`);
    }
  });
});
