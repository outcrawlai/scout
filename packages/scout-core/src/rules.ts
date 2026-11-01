/**
 * Rules: natural language in, enforceable gates out.
 *
 * A customer forbids things in their own words — "never spend over £200",
 * "only use amazon.co.uk", "ask me before you buy anything" — and this file
 * decides, per rule, whether we can actually STOP it or can only ask a model
 * nicely. That split is the product:
 *
 *   ENFORCED  a gate `@outcrawl/runtime` evaluates before a dispatch reaches
 *             the page. A tripped gate refuses the action. It is not advice.
 *   GUIDANCE  the sentence, rendered into the prompt, where a model under
 *             pressure may weigh it against everything else it was told.
 *
 * **A rule the customer believes is enforced but which is only advice is the
 * worst possible outcome here**, so the class of every rule is returned to them
 * on the same call that sets it, with the gate's canonical parameters beside
 * it. Nothing about the classification is implicit and nothing is a surprise
 * discovered from a bill.
 *
 * ── WHY A PARSER AND NOT A MODEL ─────────────────────────────────────────────
 *
 * Extracting the gate with a model at `rules.set` time is the obvious approach
 * and it is the wrong one, for three reasons that are all about the same thing:
 *
 * 1. REPRODUCIBILITY. A gate that decides whether a £200 payment goes through
 *    has to return the same verdict for the same sentence every time. A model
 *    can reclassify ENFORCED to GUIDANCE between two `rules.get` calls, on the
 *    same text, and the customer would have no signal that their protection had
 *    evaporated. That is precisely the failure this file exists to prevent.
 * 2. NO SECOND STEERING SURFACE. Rule text is customer-authored and a model
 *    extractor is one more place a sentence can talk our behaviour into
 *    something. A parser has none.
 * 3. MEASURABLE COVERAGE. Every phrasing claimed here is a row in
 *    `core/test/rules.test.ts`, and so is every phrasing deliberately refused.
 *    A model extractor's coverage cannot be stated per release.
 *
 * ── HOW A MIS-EXTRACTION IS MADE VISIBLE ─────────────────────────────────────
 *
 * The parser is TOTAL: every rule gets a class and nothing throws. There are
 * three outcomes, and the third is the whole anti-silent-failure device.
 *
 *   ENFORCED, gate present    — the canonical parameters go back to the
 *                               customer, so an extraction that read the wrong
 *                               number, the wrong currency or the wrong host is
 *                               READABLE rather than discovered in production.
 *   GUIDANCE, no warning      — nothing enforceable in the sentence. Correct
 *                               and quiet: "be polite" is guidance and there is
 *                               nothing to warn about.
 *   GUIDANCE, `unenforceable` — the sentence LOOKS enforceable and did not
 *                               compile. A money amount with no currency, a
 *                               host with no allow/deny sense, a limit that is
 *                               a floor rather than a ceiling, or two
 *                               independent constraints in one sentence.
 *
 * The two failure modes therefore land in opposite, both-visible directions. An
 * over-eager extraction that would block legitimate work is visible because the
 * parameters are on screen. An extraction that silently failed to bind is
 * visible because {@link CompiledRule.unenforceable} says so, in the response to
 * the very call that accepted the rule.
 *
 * ── ONE GATE PER RULE ────────────────────────────────────────────────────────
 *
 * A rule compiles to at most one gate. Two independent constraints in one
 * sentence — "never spend over £200 on ebay.com" — is a CONJUNCTION, and
 * neither gate alone is the rule the customer wrote: a bare ceiling would apply
 * it to every site, a bare host deny would forbid a £5 order. So that rule is
 * refused with a warning telling them to split it, which is honest, rather than
 * enforced approximately, which is not. See {@link compileRule}.
 */

import type { ValidationResult } from './types';

/* ------------------------------------------------------------------ *
 * The shapes
 * ------------------------------------------------------------------ */

export const RULE_CLASSES = ['enforced', 'guidance'] as const;

export type RuleClass = (typeof RULE_CLASSES)[number];

/**
 * Currencies a ceiling can be stated in.
 *
 * Short on purpose. A ceiling is only enforceable against an amount read off a
 * page, and there is no FX rate anywhere in this system, so a currency we
 * cannot recognise in BOTH places buys nothing. `$` is read as `USD`; it is
 * also CAD and AUD and a customer who means those writes the code.
 */
export const RULE_CURRENCIES = ['GBP', 'USD', 'EUR', 'JPY'] as const;

export type RuleCurrency = (typeof RULE_CURRENCIES)[number];

/**
 * The classes of irreversible act a confirmation rule can name.
 *
 * These are `IrreversibleKind` from `@outcrawl/runtime` minus `suspected`,
 * which is a verdict the classifier produces and never something a customer
 * asks for by name. Declared here because core cannot import the runtime — the
 * dependency runs the other way — and `runtime/src/rules.ts` is checked against
 * this list at compile time.
 */
export const RULE_IRREVERSIBLE_CLASSES = [
  'payment',
  'order',
  'message',
  'account',
  'handoff',
] as const;

export type RuleIrreversibleClass = (typeof RULE_IRREVERSIBLE_CLASSES)[number];

/**
 * What a compiled rule can actually stop.
 *
 * Three arms, and they are the three the owner scoped: a spend ceiling, a
 * domain allow/deny, and a confirmation requirement on irreversible acts.
 * Everything else a customer can write is guidance. A discriminated union
 * rather than an options bag, so a fourth class added later is a compile error
 * at every evaluation site until somebody handles it.
 */
export type RuleGate =
  | {
      readonly kind: 'spend_ceiling';
      readonly currency: RuleCurrency;
      /** Exact decimal, two places. Never a float; this number gates money. */
      readonly amount: string;
    }
  | {
      readonly kind: 'domain';
      readonly mode: 'allow' | 'deny';
      /** Registrable hosts, lowercased. A host matches itself and its subdomains. */
      readonly hosts: readonly string[];
    }
  | {
      readonly kind: 'confirm_irreversible';
      readonly classes: readonly RuleIrreversibleClass[];
    };

/**
 * One customer rule, classified.
 *
 * `gate` and `unenforceable` are REQUIRED AND NULLABLE, on the doctrine
 * `registry.ts` states at length for `mcpTool`: "we decided this rule has no
 * gate" and "nobody said" must not be the same bytes. A guidance rule writes
 * `gate: null` and a rule nobody classified does not compile.
 */
export interface CompiledRule {
  /**
   * The customer's sentence, VERBATIM. Never a normalised or reworded form:
   * this is what they typed, it is what `rules.get` shows them, and a rule they
   * cannot recognise is a rule they cannot audit.
   */
  readonly text: string;
  readonly class: RuleClass;
  /** The gate, or `null` for a guidance rule. */
  readonly gate: RuleGate | null;
  /**
   * Why a rule that LOOKED enforceable is only guidance, or `null`.
   *
   * Present only on guidance rules, and its presence is the signal a customer
   * acts on: it means we suspect they think this is enforced and it is not.
   */
  readonly unenforceable: string | null;
}

export type RuleSet = readonly CompiledRule[];

/**
 * Ceilings on the rule LIST, not on any one gate.
 *
 * Rules are rendered into every prompt of every step of the run, so an
 * unbounded list is an unbounded per-step token cost the customer did not
 * choose to pay. Thirty-two rules of 240 characters is about 2k tokens, which
 * is affordable against a page.
 */
export const MAX_RULES = 32;
export const MAX_RULE_LENGTH = 240;

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

const CURRENCY_BY_TOKEN: Readonly<Record<string, RuleCurrency>> = Object.freeze({
  '£': 'GBP',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  sterling: 'GBP',
  quid: 'GBP',
  $: 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  '¥': 'JPY',
  jpy: 'JPY',
  yen: 'JPY',
});

/**
 * A monetary amount with an identifiable currency, in either order.
 *
 * Two arms because both orders are ordinary English: `£200.50` and `200 GBP`.
 * A currency is REQUIRED — a bare `200` is not an amount this can compare
 * against a page total, and pretending otherwise is how a ceiling silently
 * stops binding. `\d{1,3}(?:,\d{3})+` before `\d+` so `1,299` is one amount and
 * not two.
 */
const MONEY =
  /(£|\$|€|¥|\bgbp|\busd|\beur|\bjpy)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(gbp|usd|eur|jpy|pounds?|dollars?|euros?|yen|sterling|quid)\b/gi;

/** A bare number that is not money. Read only to explain why a rule did not compile. */
const BARE_NUMBER = /\b\d+(?:\.\d{1,2})?\b/;

/** What the rule is limiting. A ceiling with no subject is not a spend rule. */
const SPEND_SUBJECT =
  /\b(spend|spends|spending|spent|pay|pays|paying|paid|purchase|purchases|purchasing|buy|buys|buying|bought|charge|charged|charges|cost|costs|budget|checkout|order|orders|total|price|prices|bill|billed|invoice|transfer|donate|donation|subscription)\b/i;

/**
 * A ceiling stated directly. "under £200", "max £200", "a budget of £200" — no
 * negation needed, the word itself is the ceiling.
 */
const CEILING_DIRECT =
  /\b(under|below|less than|at most|no more than|max|maximum|up to|within|limit(?:ed)? (?:to|of)|cap(?:ped)? (?:at|to)|budget (?:of|is)|ceiling (?:of|is)|spend limit|limit)\b/i;

/**
 * A ceiling stated by forbidding the other side. "over £200" is only a ceiling
 * when something forbids it, because "spend over £200" on its own is an
 * instruction to spend MORE, not less.
 */
const CEILING_NEGATED = /\b(over|above|more than|greater than|exceed(?:s|ing)?|beyond)\b/i;

/** A floor. Not a thing this file can gate, and a reason to warn rather than to bind. */
const FLOOR = /\b(at least|no less than|minimum of|min(?:imum)?)\b/i;

const PROHIBIT =
  /\b(never|not|no|don'?t|do not|cannot|can'?t|must not|mustn'?t|shouldn'?t|avoid|refuse|forbid|forbidden|prohibited|without|prevent|stop)\b/i;

/**
 * A registrable host. The last label must be two or more letters, which is what
 * keeps `200.00` and `e.g` out of the host set while admitting `amazon.co.uk`.
 */
const HOST = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi;

const ALLOW_CUE =
  /\b(only|solely|exclusively|nothing but|nowhere but|stay on|stick to|restrict(?:ed)? to|limit(?:ed)? to|whitelist|allow ?list)\b/i;

const DENY_CUE =
  /\b(never|don'?t|do not|avoid|no|not|block|blocked|ban|banned|stay (?:off|away from)|steer clear|refuse|forbid|forbidden|blacklist|deny ?list|except)\b/i;

/** Asking a human first, in the phrasings people actually write. */
const CONFIRM_CUE =
  /\b(ask (?:me|first|before)|check with me|confirm with me|confirm first|confirm before|my approval|my permission|my consent|my sign-?off|human approval|without asking|without checking|without (?:my )?(?:approval|permission|confirmation|consent|sign-?off)|get approval|needs approval|require approval)\b/i;

/** "anything", "irreversible" — the customer named no class, so every class. */
const ANY_IRREVERSIBLE =
  /\b(anything|everything|any action|irreversibl[ey]|permanent(?:ly)?|destructive|undone|irrevocabl[ey])\b/i;

const IRREVERSIBLE_TERMS: readonly (readonly [RuleIrreversibleClass, RegExp])[] = [
  ['payment', /\b(pay|pays|paying|paid|payment|payments|card|checkout|donate|donation|subscribe|subscription|transfer|wire|money)\b/i],
  ['order', /\b(order|orders|ordering|buy|buys|buying|bought|purchase|purchases|purchasing|book|books|booking|reserve|reservation)\b/i],
  ['message', /\b(message|messages|messaging|send|sends|sending|sent|post|posts|posting|publish|reply|replies|tweet|comment|comments|email|emails|dm)\b/i],
  ['account', /\b(account|accounts|sign ?up|signup|register|registration|unsubscribe|delete my)\b/i],
  ['handoff', /\b(upload|uploads|uploading|share|shares|sharing|attach|attaches|attaching|invite|invites|inviting|send file|hand over)\b/i],
];

/* ------------------------------------------------------------------ *
 * Amount and host reading
 * ------------------------------------------------------------------ */

/** One monetary amount, currency resolved and value exact to two places. */
export interface RuleAmount {
  readonly currency: RuleCurrency;
  readonly amount: string;
}

/**
 * Every currency-bearing amount in the text, in order.
 *
 * Exported because `runtime/src/rules.ts` reads amounts off a PAGE with the
 * same reader. One reader and not two: a rule's "£200" and a page's "£200.00"
 * have to parse to the same number or the comparison is theatre, and two
 * implementations of that is how they come to differ by a factor of a hundred.
 */
export function readAmounts(text: string): readonly RuleAmount[] {
  const found: RuleAmount[] = [];
  // A fresh matcher per call: `MONEY` is global and `lastIndex` is state.
  const matcher = new RegExp(MONEY.source, 'gi');
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    const token = (match[1] ?? match[6] ?? '').toLowerCase().trim();
    const currency = CURRENCY_BY_TOKEN[token];
    if (currency === undefined) {
      continue;
    }
    const whole = match[2] ?? match[4];
    if (whole === undefined) {
      continue;
    }
    // `1,299` and a bare `.5` become `1299.50`: exact to two places, so the
    // comparison against a page total is a decimal-string comparison and never
    // a float.
    const amount = `${whole.replace(/,/g, '')}.${(match[3] ?? match[5] ?? '').padEnd(2, '0')}`;
    found.push({ currency, amount });
  }
  return found;
}

/** Every host-shaped token in the text, lowercased, de-duplicated, in order. */
function readHosts(text: string): readonly string[] {
  const seen = new Set<string>();
  const matcher = new RegExp(HOST.source, 'gi');
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    const host = match[1];
    if (host !== undefined) {
      seen.add(host.toLowerCase());
    }
  }
  return [...seen];
}

/* ------------------------------------------------------------------ *
 * The three extractors
 * ------------------------------------------------------------------ */

/**
 * The reading of one rule: the gate it compiles to, plus why it did not.
 *
 * `smell` is what makes the warning specific. An extractor that merely returns
 * `undefined` cannot tell "there was nothing enforceable here" from "there was
 * something enforceable here and I could not bind it", and those are the two
 * outcomes the customer needs told apart.
 *
 * Generic in the gate ARM, so {@link compileRule} can read a domain reading's
 * `mode` and `hosts` for the conjunction warning without narrowing a union it
 * already knows the shape of.
 */
interface Reading<G extends RuleGate = RuleGate> {
  readonly gate: G | undefined;
  readonly smell: string | undefined;
}

const NOTHING: Reading<never> = { gate: undefined, smell: undefined };

type SpendGate = Extract<RuleGate, { kind: 'spend_ceiling' }>;
type DomainGate = Extract<RuleGate, { kind: 'domain' }>;
type ConfirmGate = Extract<RuleGate, { kind: 'confirm_irreversible' }>;

function readSpendCeiling(text: string): Reading<SpendGate> {
  const amounts = readAmounts(text);
  const subject = SPEND_SUBJECT.test(text);
  const direct = CEILING_DIRECT.test(text);
  const negated = CEILING_NEGATED.test(text) && PROHIBIT.test(text);
  const ceiling = direct || negated;

  if (amounts.length === 0) {
    // A number, a spending subject and a limit, and no currency to compare it
    // in. This is the single most likely way a customer believes they have a
    // ceiling and does not: "never spend over 200".
    if (subject && ceiling && BARE_NUMBER.test(text)) {
      return {
        gate: undefined,
        smell:
          'this reads as a spend limit but the amount carries no currency, and a ceiling cannot be compared against a page total without one. Write the currency: "never spend over £200" or "never spend over 200 GBP"',
      };
    }
    return NOTHING;
  }

  if (!subject) {
    return {
      gate: undefined,
      smell: `this names an amount (${amounts[0]?.currency} ${amounts[0]?.amount}) but nothing it limits, so there is no dispatch to gate on it. Say what the amount is a ceiling on: "never spend over ..."`,
    };
  }
  if (!ceiling) {
    return {
      gate: undefined,
      smell: FLOOR.test(text)
        ? 'this states a MINIMUM, and a floor is not something a gate can refuse a dispatch on: only a ceiling is. Rephrase as an upper limit if that is what you meant'
        : 'this names an amount and something to spend it on, but no upper limit ("under", "no more than", "never over"), so there is nothing to compare a page total against',
    };
  }
  const distinct = new Set(amounts.map((money) => `${money.currency} ${money.amount}`));
  if (distinct.size > 1) {
    return {
      gate: undefined,
      smell: `this names ${distinct.size} different amounts (${[...distinct].join(', ')}) and a gate holds exactly one ceiling. Set one rule per limit`,
    };
  }
  const money = amounts[0] as RuleAmount;
  return {
    gate: { kind: 'spend_ceiling', currency: money.currency, amount: money.amount },
    smell: undefined,
  };
}

function readDomain(text: string): Reading<DomainGate> {
  const hosts = readHosts(text);
  if (hosts.length === 0) {
    return NOTHING;
  }
  const allow = ALLOW_CUE.test(text);
  const deny = DENY_CUE.test(text);
  if (allow && deny) {
    return {
      gate: undefined,
      smell: `this names ${hosts.join(', ')} with both an allow sense and a deny sense in one sentence, so which way it points is a guess. Write one rule per direction`,
    };
  }
  if (!allow && !deny) {
    return {
      gate: undefined,
      smell: `this names ${hosts.join(', ')} but does not say whether they are the only sites allowed or sites to keep off. Say "only use ..." or "never visit ..."`,
    };
  }
  return { gate: { kind: 'domain', mode: allow ? 'allow' : 'deny', hosts }, smell: undefined };
}

function readConfirmIrreversible(text: string): Reading<ConfirmGate> {
  const asked = CONFIRM_CUE.test(text) || PROHIBIT.test(text);
  if (!asked) {
    return NOTHING;
  }
  const classes = IRREVERSIBLE_TERMS.filter(([, term]) => term.test(text)).map(([kind]) => kind);
  if (classes.length > 0) {
    return { gate: { kind: 'confirm_irreversible', classes }, smell: undefined };
  }
  if (ANY_IRREVERSIBLE.test(text) && CONFIRM_CUE.test(text)) {
    // No class named, and an explicit ask. Every class, which is the reading of
    // "ask me before doing anything irreversible" and the safe direction of the
    // two readings available.
    return {
      gate: { kind: 'confirm_irreversible', classes: RULE_IRREVERSIBLE_CLASSES },
      smell: undefined,
    };
  }
  return NOTHING;
}

/* ------------------------------------------------------------------ *
 * The compiler
 * ------------------------------------------------------------------ */

/**
 * One rule, classified.
 *
 * ── PRECEDENCE, AND IT IS NOT ARBITRARY ──────────────────────────────────────
 *
 * A sentence can trip more than one extractor and only one gate may come out,
 * so the order below is a claim about which reading is COMPLETE:
 *
 *   domain over confirmation. "never buy from ebay.com" is fully enforced by
 *   refusing ebay.com; adding a confirmation gate on `order` would forbid
 *   ordering everywhere, which the customer did not say.
 *
 *   ceiling over confirmation. "don't pay more than £200" is a quantified rule
 *   and the number is the whole point of it; a confirmation gate on `payment`
 *   would refuse a £5 payment the rule permits.
 *
 *   ceiling AND domain is a CONJUNCTION and neither gate is the rule. "never
 *   spend over £200 on ebay.com" is refused with a warning to split it, because
 *   the ceiling alone over-enforces (every site) and the deny alone
 *   under-enforces (a £5 order is allowed by the sentence and blocked by the
 *   gate). We do not have a scoping algebra and inventing an approximate one
 *   here is exactly the "believes it is enforced" defect.
 */
export function compileRule(text: string): CompiledRule {
  const trimmed = text.trim();
  const spend = readSpendCeiling(trimmed);
  const domain = readDomain(trimmed);
  const confirm = spend.gate === undefined ? readConfirmIrreversible(trimmed) : NOTHING;

  const guidance = (unenforceable: string | null): CompiledRule => ({
    text: trimmed,
    class: 'guidance',
    gate: null,
    unenforceable,
  });

  if (domain.gate !== undefined && (spend.gate !== undefined || confirm.gate !== undefined)) {
    return guidance(
      `this combines a site restriction (${domain.gate.mode} ${domain.gate.hosts.join(', ')}) with ${
        spend.gate !== undefined ? 'a spend limit' : 'a confirmation requirement'
      }. A gate holds one constraint, and enforcing either half alone would either forbid more than you wrote or allow more. Split it into two rules and both will be enforced`,
    );
  }

  const gate = spend.gate ?? domain.gate ?? confirm.gate;
  if (gate !== undefined) {
    return { text: trimmed, class: 'enforced', gate, unenforceable: null };
  }
  return guidance(spend.smell ?? domain.smell ?? confirm.smell ?? null);
}

/** The whole list, in the order the customer wrote it. Order is theirs, not ours. */
export function compileRules(texts: readonly string[]): RuleSet {
  return texts.map((text) => compileRule(text));
}

export function enforcedRules(rules: RuleSet): readonly CompiledRule[] {
  return rules.filter((rule) => rule.class === 'enforced');
}

export function guidanceRules(rules: RuleSet): readonly CompiledRule[] {
  return rules.filter((rule) => rule.class === 'guidance');
}

/**
 * The canonical parameters of a gate, as one line of English.
 *
 * This string is the customer's ONLY view of what we extracted, so it says the
 * number, the currency and the hosts rather than the class name: "spend ceiling
 * GBP 200.00" is auditable and "spend_ceiling" is not.
 */
export function describeGate(gate: RuleGate): string {
  switch (gate.kind) {
    case 'spend_ceiling':
      return `blocks any dispatch that would commit more than ${gate.currency} ${gate.amount}`;
    case 'domain':
      return gate.mode === 'allow'
        ? `blocks navigation to any host other than ${gate.hosts.join(', ')} (subdomains allowed)`
        : `blocks navigation to ${gate.hosts.join(', ')} and their subdomains`;
    case 'confirm_irreversible':
      return `blocks irreversible actions of class ${gate.classes.join(', ')}`;
  }
}

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

/**
 * The wire form: an array of non-empty strings.
 *
 * `[]` is VALID and is not the same as absent. Absent on a run means "use the
 * workspace default"; `[]` means "this run runs under no rules", which is a
 * thing a customer is entitled to say out loud and which cannot be spelled if
 * an empty array is rejected.
 */
export function validateRules(input: unknown): ValidationResult<readonly string[]> {
  if (!Array.isArray(input)) {
    return { ok: false, errors: ['rules must be an array of strings'] };
  }
  if (input.length > MAX_RULES) {
    return { ok: false, errors: [`rules must hold at most ${MAX_RULES} entries, got ${input.length}`] };
  }
  const errors: string[] = [];
  const texts: string[] = [];
  input.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(`rules[${index}] must be a string`);
      return;
    }
    const trimmed = entry.trim();
    if (trimmed === '') {
      errors.push(`rules[${index}] must not be empty`);
      return;
    }
    if (trimmed.length > MAX_RULE_LENGTH) {
      errors.push(
        `rules[${index}] must be at most ${MAX_RULE_LENGTH} characters, got ${trimmed.length}. A rule is rendered into every prompt of the run`,
      );
      return;
    }
    texts.push(trimmed);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: texts };
}

/* ------------------------------------------------------------------ *
 * The wire shape of the split
 * ------------------------------------------------------------------ */

/**
 * What `rules.get` and `rules.set` answer.
 *
 * Both routes answer the SAME body, and that is deliberate rather than tidy:
 * the split has to be visible in the response to the call that SET the rules,
 * not only on a later read somebody might not make. A customer who PUTs four
 * rules and gets back "three enforced, one guidance and here is why" has been
 * told at the only moment they were going to look.
 */
export interface RulesView {
  readonly rules: readonly RulesViewRule[];
  /** Counts, so a caller can assert the split without walking the list. */
  readonly enforced: number;
  readonly guidance: number;
}

export interface RulesViewRule {
  readonly text: string;
  readonly class: RuleClass;
  /** What the gate does, in English. `null` for a guidance rule. */
  readonly enforcement: string | null;
  /** The gate's own parameters, for a caller that wants to assert on them. */
  readonly gate: RuleGate | null;
  readonly unenforceable: string | null;
}

export function rulesView(rules: RuleSet): RulesView {
  return {
    rules: rules.map((rule) => ({
      text: rule.text,
      class: rule.class,
      enforcement: rule.gate === null ? null : describeGate(rule.gate),
      gate: rule.gate,
      unenforceable: rule.unenforceable,
    })),
    enforced: enforcedRules(rules).length,
    guidance: guidanceRules(rules).length,
  };
}
