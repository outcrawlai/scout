/**
 * Typed errors: the base every Outcrawl error extends, and the ones the agent
 * itself raises.
 *
 * `code` is the wire contract: stable, machine-readable, never renamed once
 * shipped. `message` is for humans and may change freely. Every error carries
 * enough structured detail to act on.
 */

export const OUTCRAWL_ERROR_CODES = [
  'unauthorized',
  'profile_in_use',
  'cap_exceeded',
  'exit_unavailable',
  'no_capacity',
  'tenant_scope',
  // Emitted by the router. Named here because they were already on the wire
  // while the union claimed six values, so the type that looked like the error
  // contract did not describe the traffic.
  'bad_request',
  'not_found',
  'profile_not_found',
  'method_not_allowed',
  // A capability this deployment is not configured to serve. Added because
  // there was no honest existing code for it and the alternative was a 500:
  // `no_capacity` is documented retryable, so pointing it at "this worker has
  // no search index" tells every client to retry forever AND makes an
  // unconfigured capability indistinguishable from a busy fleet in the
  // router's own metrics -- somebody would eventually chase a phantom capacity
  // problem that was a missing config. `not_found` lies about a route that is
  // in the registry, and `bad_request` blames a caller who did nothing wrong.
  'capability_unavailable',
  // The OTHER half of that argument, and it took a customer reading a refusal
  // to find it. A stored recording that no machine is free to decode right now
  // is not an unconfigured deployment: the frames are in the bucket, the route
  // works, and the identical call succeeds as soon as any Mac is reachable. It
  // was answered with `capability_unavailable` — documented NOT retryable — so
  // a correct SDK gave up permanently on a recording that would have decoded
  // seconds later, and the sentence it printed blamed configuration nobody had
  // got wrong. `no_capacity` is the closest existing code and is still wrong:
  // it is about a browser slot for a NEW session, carries the cookie schema
  // that decision turns on, and a decode needs neither.
  'decode_unavailable',
  // The two halves of a plan ceiling, and they are deliberately two codes.
  //
  // `quota_exceeded` is "you are over a ceiling somebody set for you", which is
  // a different fact from `cap_exceeded` ("you are over a ceiling you set for
  // this call", 402) and a different fact again from `no_capacity` ("the fleet
  // is busy", 503, documented retryable). Collapsing quota into `no_capacity`
  // is the specific mistake this pair exists to prevent: it tells a customer
  // who is over quota to retry forever, and it makes the router's own metrics
  // report a capacity problem that no amount of hardware fixes.
  'quota_exceeded',
  // A third ceiling, and a third code, for the same reason the two above are
  // two: a customer at their plan's concurrency ceiling and a fleet with no
  // free machine are completely different problems and must not share a code.
  //
  // `no_capacity` says "come back, the fleet is busy" and every client library
  // treats it that way. Answering a concurrency refusal with it tells a
  // customer holding their maximum browsers that OUR hardware is the problem,
  // sends an operator looking for machines that were never missing, and hides
  // the one action that actually clears it — ending a session, or buying a
  // larger plan. `quota_exceeded` is nearly as wrong in the other direction:
  // both of its ceilings lapse on their own at a `resetAt` this one does not
  // have, because a concurrency slot is freed by the customer and by nothing
  // else. A `Retry-After` here would be a number invented to fill a field.
  'concurrency_limit',
  // A key with no plan. Named rather than folded into `unauthorized`, because
  // the credential is valid and the operator who provisioned it is the one who
  // has to act; reporting `invalid_key` would send the customer to rotate a key
  // that was never the problem.
  'plan_required',
  // The page was never fetched: no response of any kind arrived, so there is
  // no status code, no body and nothing to extract. Named because what shipped
  // instead was `internal` — `toOutcrawlError` drops any plain `Error` to an
  // incident id, and the worker's two navigation refusals extended plain
  // `Error`, so a residential exit refusing a CONNECT tunnel told the customer
  // OUR SERVICE CRASHED and handed them an id to quote instead of the one
  // string that explains it. Measured before this code existed: status 500,
  // body `{"code":"internal","details":{"incidentId":…}}`, identically for
  // `net::ERR_TUNNEL_CONNECTION_FAILED`, `net::ERR_NAME_NOT_RESOLVED` and
  // `net::ERR_CONNECTION_REFUSED`.
  //
  // NOT `exit_unavailable`, which is the closest existing code and is wrong
  // twice over. Its constructor requires an `ExitTarget` with a country and
  // the render binding has no idea which exit it is on — it holds a CDP
  // session, not an allocation — so the only way to raise it is to invent a
  // geography. And its documented meaning is resolution-time: "no exit could
  // be resolved for the requested geography", refused before a browser is
  // touched. A tunnel that was resolved, leased, and then died mid-use is a
  // different fact, and a customer who reads "no exit available for us" goes
  // looking for a country that was never the problem.
  //
  // NOT `capability_unavailable`: nothing is misconfigured and every other
  // deployment would fail the same way. NOT `no_capacity`: a worker was
  // allocated and did the work. NOT `decode_unavailable`: no bytes exist to
  // decode, which is the whole complaint. NOT `bad_request`: a URL that
  // resolves for everybody else and not through this exit is not the caller's
  // mistake, and blaming their arguments sends them to edit a correct request.
  //
  // ONE code, with the attribution on the error rather than in its spelling.
  // The part that differs between "our exit refused the tunnel" and "the site
  // never answered" is the STATUS — 503 retryable against 502 upstream — and a
  // client can branch on that plus `details.attribution`. Two codes would make
  // every consumer learn two spellings of "unreachable" and get the second one
  // wrong for a year.
  'page_unreachable',
  // The bytes ARRIVED and this system cannot render them as text. The other
  // half of the same complaint, found the same way: a PDF scrape returned 0
  // characters, and when the render path learned to refuse instead of
  // returning an empty page, the refusal was a plain `Error` and reached the
  // customer as 500 `internal` with an incident id — defect one reproduced by
  // defect two's own failure path.
  //
  // NOT `page_unreachable`, whose contract one comment up is "no response was
  // ever received". 2 215 244 bytes were received, measured through
  // `Network.loadNetworkResource` on the live probe, so reusing that code lies
  // about the one fact it exists to state — and it would send an operator
  // looking at exits and DNS for a document that arrived intact.
  //
  // NOT `decode_unavailable`, which is documented RETRYABLE because the frames
  // are stored and a machine will free up. A scan never grows a text layer and
  // an encrypted file never learns our password: the identical call returns the
  // identical bytes forever, so a retryable code here is an infinite loop over
  // a document that will never change.
  //
  // NOT `bad_request` (400): the request was valid, the URL was right, and the
  // fetch succeeded — 422 is the status for an entity that was understood and
  // cannot be processed. NOT `capability_unavailable`: nothing is
  // unconfigured and no other deployment would do better.
  //
  // WHAT IT IS NOT ALLOWED TO BECOME. It is thrown only when NO text can be
  // produced at all. A document we did extract text from is never this, however
  // thin the text is, and this is never a substitute for an empty page: both of
  // those are results the customer is owed, and answering them with a refusal
  // is how a code like this turns into a dumping ground for every disappointing
  // render.
  'document_unrepresentable',
  // The TAB WE WERE RENDERING IN CEASED TO EXIST before the page could be
  // delivered. The page closed its own tab, or its renderer process crashed.
  //
  // Named for the same reason `page_unreachable` was, one defect later and on
  // the same path: a tab destroyed during a captcha hold took the CDP socket
  // with it, every pending command rejected with a plain `CdpClosedError`
  // ("the CDP connection closed: code 1006"), and `toOutcrawlError` dropped
  // that to `new InternalError(incidentId)`. Measured in the fleet's own logs
  // 2026-09-11, both causes: `tab.lost cause=closed-by-page` and `tab.lost
  // cause=crashed`, each answered HTTP 500 `{"code":"internal"}`. The customer
  // asked us to scrape a page and was told our service had crashed, about a
  // page that had run `window.close()` on itself.
  //
  // NOT `page_unreachable`, whose whole contract is "no response of any kind
  // arrived". Here the navigation committed, a document was often read, and
  // what failed is the tab it was in. Reusing that code would send an operator
  // to the exits and DNS for a renderer that segfaulted.
  //
  // NOT `document_unrepresentable` (422): that says bytes arrived and cannot
  // be turned into text, which is a statement about a document. A tab that no
  // longer exists is a statement about the browser.
  //
  // NOT `internal`, which is what it was, and the distinction is the point of
  // the code: `internal` means WE have a defect and carries nothing but an
  // incident id for somebody else to read. A page closing its own tab is the
  // site's own behaviour, correctly observed and honestly reportable, and a
  // crashed renderer — while ours — is a fact with a next move rather than a
  // mystery.
  //
  // ONE code with the cause on the error, exactly as `page_unreachable` keeps
  // its attribution off its spelling. The status follows the cause because the
  // next move does: 503 with a `Retry-After` when our renderer crashed, 502
  // when the page dismissed itself. See {@link PageLostError}.
  'page_lost',
  // THE MODEL BEHIND THE `json` FORMAT ANSWERED, AND NOT IN THE SHAPE THE
  // CUSTOMER ASKED FOR — or did not finish answering at all. Named for the
  // reason the three codes above it were, and with the same receipt: measured
  // 2026-09-12 on the Facebook Ad Library page with a customer's own key, 3 of
  // 20 replays of ONE fixed 47,401-character render failed outright (two
  // replies were a bare JSON array where the schema's root is an object, one
  // was `finish_reason: error` mid-generation), and AdCountStable measured 7 of
  // 37 the same day on the same page. Every one of them reached the customer as
  // HTTP 500 `{"code":"internal","details":{"incidentId":…}}`: the product
  // telling a customer it had crashed, about a request that commonly succeeds
  // on the next attempt. `ModelSchemaError`, `ModelUnusableError` and
  // `ModelProviderError` are all plain `Error`s, and `toOutcrawlError` drops a
  // plain `Error` to an incident id — the same mechanism that produced
  // `page_unreachable`, `document_unrepresentable` and `page_lost`.
  //
  // RETRYABLE, and that is the load-bearing half. The failure is model
  // SAMPLING: the identical bytes, the identical schema and the identical
  // request produced a satisfying document 17 times in those same 20 replays.
  // A client that gives up permanently here gives up on an answer it would
  // have got by asking again.
  //
  // NOT `capability_unavailable`, which shares the 503 and is documented as
  // exactly the opposite — "the identical call against the same deployment
  // fails identically until an operator configures something". The model IS
  // configured; that is why the request got as far as an answer. Reusing it
  // here is precisely the mistake `decode_unavailable` was added to correct,
  // one code family later.
  //
  // NOT `document_unrepresentable` (422), whose contract is "these bytes can
  // never become text" and which is documented as returning the identical
  // result forever. The page became markdown perfectly; the extraction of it
  // sampled badly once.
  //
  // NOT `no_capacity`: a worker was allocated, opened a browser, rendered the
  // page and paid for a model call. Nothing about the fleet being busy is true.
  //
  // NOT `bad_request`: the schema was valid — it is the same schema that
  // succeeded on the previous request and the next one — so blaming the
  // caller's arguments sends them to edit something that is correct.
  //
  // NOT `internal`, which is what shipped, and the distinction is the point:
  // `internal` means WE have a defect and carries nothing but an id for
  // somebody else to read. A model that sampled a bare array is an observed,
  // reportable fact with a next move.
  //
  // ONE code with the cause on the error, as `page_unreachable` and
  // `page_lost` both keep theirs off their spelling. `details.failure`
  // separates "answered, wrong shape" from "never finished answering", which
  // is the part a client might branch on, and both halves are retryable so the
  // status does not move between them.
  'extraction_failed',
  // THE MACHINE RAN THE REQUEST AND ITS ANSWER NEVER REACHED THE EDGE. Not a
  // failure of the work — the work succeeded — but of the hop that carries it
  // back, and the customer is holding nothing either way.
  //
  // THE RECEIPT, measured 2026-09-12 on a customer's own key. `POST
  // /v1/scrape` answered **HTTP 520 with 7,416 bytes of Cloudflare's error
  // page**: no code, no message, no incident id, nothing to quote. Workers
  // Logs for that invocation: `$workers.event.response.status` 520, `outcome`
  // "ok", `wallTimeMs` 9001, `cpuTimeMs` 7, ray `a3a25df0ed8f709a` — so the
  // router did not throw, it RETURNED that page. The page carries a different
  // ray and names the fleet machine as its host,
  // because it is the SUBREQUEST's error page: `fetchWorker`'s fetch to the
  // machine came back as a synthesized Cloudflare response rather than
  // throwing, and the forward path returns whatever it is handed. Meanwhile
  // the machine's own log, same request, same session: `{"event":
  // "api.request","capability":"scrape","framing":"json","status":200,
  // "elapsedMs":44212}`. We had the answer. The customer got HTML.
  //
  // RATE, with its denominator: 1 of 152 `/v1/scrape` invocations in the two
  // days to 2026-09-12T23:00Z (Workers Logs, `abr_level` 1, unsampled); 1 of
  // 16 among the invocations whose work exceeded 20 s, which is the population
  // that can be exposed at all. NOT reproduced on demand: 44 attempts over
  // three arms returned 200.
  //
  // RETRYABLE, and that is the whole point of naming it. The identical call
  // succeeded 151 times out of 152.
  //
  // NOT `internal`, which is what a customer would otherwise get once the edge
  // stops passing the page through: its message is fixed BY DESIGN — "an
  // internal error is the one place where a helpful message leaks a stack, a
  // query or a hostname" — so it cannot say the one thing that is true and
  // useful here, that the work ran and asking again is the right move.
  //
  // NOT `capability_unavailable`, documented as the exact opposite: "the
  // identical call against the same deployment fails identically until an
  // operator configures something". Nothing is unconfigured.
  //
  // NOT `no_capacity`: a machine was allocated, opened a browser, rendered the
  // page and billed for it. Reporting a busy fleet would send an operator
  // looking for hardware that was never missing — the mistake `quota_exceeded`
  // and `concurrency_limit` were both split out to avoid.
  //
  // NOT `extraction_failed` or `page_lost`: those name a model that sampled
  // badly and a tab that ceased to exist. Here the render finished, the
  // extraction finished, and the response was written to a socket that had
  // gone.
  //
  // NO `Retry-After`. `exitFor` emits one only from `details.retryAfterSeconds`
  // and any number here would be invented: nothing recovers on a schedule,
  // because nothing is broken — the same argument `concurrency_limit` makes for
  // omitting it.
  'answer_lost',
  // THE CALLER'S OWN `timeoutMs` WAS EXCEEDED BY WORK ALREADY DONE. Not a
  // server fault and not a malformed request: the navigation and settle that
  // `ScrapeRequest.timeoutMs` was always documented to bound
  // (`DEFAULT_TIMEOUT_MS`, "Overall ceiling, matching `ScrapeRequest.timeoutMs`")
  // ran to completion on their own, UNCHANGED, honest schedule, and that
  // alone already spent more than the caller asked for.
  //
  // MEASURED 2026-09-16: ScrapeSurfaceAudit found `timeoutMs` accepted and
  // silently ignored — 1 ms, 100 ms, 1 000 ms and 5 000 ms all produced
  // byte-identical 45 207-character output in 3.3-5.2 s wall time, n=4/4. The
  // number was validated at the boundary and consulted only by the
  // navigation-commit wait, which a fast page never blocks long enough to
  // reach — so a customer's stated deadline meant nothing the moment the page
  // took longer than it to settle.
  //
  // NOT `internal`: nothing broke. NOT `bad_request`: `timeoutMs` was a
  // well-formed number and it is the PAGE that took longer than it, not the
  // parameter that was malformed — blaming the caller's syntax sends them to
  // edit a number that was never wrong on its own terms. NOT
  // `page_unreachable` or `page_lost`: a document WAS obtained; refusing under
  // either of those codes would claim no response ever arrived when one
  // plainly did. NOT `cap_exceeded`: that code is documented "refused before a
  // browser is allocated" — a pre-flight, no-cost check — and reusing it here,
  // AFTER navigation and settle already spent real browser time, would
  // silently break that invariant for every existing reader of it, including
  // billing.
  //
  // NOT RETRYABLE with the identical call: the structural cost that exceeded
  // the budget (navigation plus settle) will very largely recur on the
  // identical page, so a client that retries unchanged spends the same money
  // to fail the same way. The caller's own next move is to raise `timeoutMs`,
  // which `details.timeoutMs` and `details.elapsedMs` exist to let them size
  // rather than guess.
  //
  // 408, deliberately: the one HTTP status whose name is exactly this fact
  // ("Request Timeout"), unused anywhere else in this union, so a client
  // branching on numeric status alone does not collide with an existing
  // meaning.
  'deadline_exceeded',
  // AN OPERATOR ALLOWLIST GATE, NOT A CREDENTIAL FAILURE. `outcrawl-lab-arm`
  // selects an internal A/B configuration (`AgentLabArm` in `agent-alias.ts`)
  // and is honoured only for the account ids in the router's
  // lab allowlist — every other account must be refused,
  // and the key itself is perfectly valid, so `unauthorized` (401) is wrong:
  // its three reasons are all about the CREDENTIAL, and rotating a good key
  // fixes nothing here. NOT `plan_required`: nothing is unset, the account
  // has a plan, and the fix is not "buy a bigger tier" but "this account was
  // never on the allowlist for an experiment that is not for sale". NOT
  // `capability_unavailable`: the capability (POST /v1/agent) works fine on
  // this deployment for every account, including this one, the moment the
  // header is dropped — nothing is unconfigured. NOT `bad_request`: the
  // header value can be a perfectly well-formed, real arm id; what is wrong
  // is who is asking, not what they typed (an UNKNOWN arm id, by contrast, is
  // exactly the caller's own mistake and is refused as `bad_request`).
  //
  // 403, because the account is identified and the request is otherwise
  // well-formed, and refused anyway.
  'lab_arm_forbidden',
  // EVERY SEARCH ENGINE THE REQUEST TRIED ANSWERED, AND EVERY ANSWER WAS A
  // REFUSAL: DuckDuckGo's anomaly (challenge) page served with HTTP 202, Brave's
  // HTTP 429 page. Measured on the fleet 2026-09-24: 13 of 346 searches at
  // concurrency 4 ended that way and were answered HTTP 200 with `hits: []` —
  // a customer told "the web has nothing" about a question the engines simply
  // declined to answer from that exit.
  //
  // NOT `page_unreachable`, whose whole contract is "no response of any kind
  // arrived": here a response did arrive from every engine, it was just not a
  // results page. NOT `exit_unavailable`, which is ruled resolution-time only
  // (see `page_unreachable`'s comment above): the exit resolved, connected and
  // carried the request. NOT `no_capacity`, which is about a browser slot and
  // carries a cookie schema; the slot was allocated and used. NOT 200 with an
  // empty list, which is what shipped and is the silent wrongness this code
  // ends: an engine that genuinely found nothing still answers 200 and `[]`.
  //
  // RETRYABLE, with `Retry-After`: a retry is served from another shared
  // search context, and so another exit, which is exactly the variable the
  // refusal was about. Charged nothing: no `search_result` is metered because
  // none was delivered, and the rate card prices `proxy_bytes` for `cdp` and
  // `agent` only, so the refused pages' bandwidth is recorded at zero credits.
  'search_refused',
  // A CONNECT (or an update to a connector's secret) whose connect-time check
  // failed: the MCP server at that URL did not answer as an MCP server, refused
  // the credential, could not be reached, or the secret handle does not exist.
  // 422 and not `bad_request`: the body was well-formed and understood, and
  // what cannot be processed is the server it names. Its own code because the
  // customer's fix depends on `details.reason`, which is the same vocabulary
  // `POST /v1/integrations/test` answers.
  'integration_check_failed',
  // A secret change (`PATCH /v1/integrations/{id}`) whose connector was
  // re-pointed by another request between the check and the write: a connect
  // under the same name replaced its URL or auth kind in place, keeping the
  // id. Writing anyway would attach a secret that was checked against a
  // server the connector no longer names. 409, the conflict status, and not
  // `integration_check_failed`: the check passed, against the old row. Its own
  // code because the fix is "read it again", not "fix the server".
  'integration_changed',
  // A `PUT` to a secret intent's URL whose bearer token does not open THAT
  // intent: never issued, issued for another intent, or sent with a `name`
  // other than the one it was issued for. 401, and deliberately ONE code for
  // all three: a caller without the right token must learn nothing about
  // whether the intent exists, what it names, or whether it was spent.
  // NOT `unauthorized`, whose sentences are about an API key the browser does
  // not hold and must not be told to go and get.
  'secret_intent_invalid',
  // The right token for the right intent, too late: already spent, or past
  // its five minutes. 410, because the resource existed and is gone for good
  // — retrying the same token can never succeed, and the fix is a new intent.
  // Answered only to a caller who PROVED the token, so saying which (used,
  // expired, or its minting key revoked)
  // it was, in `details.reason`, tells nobody anything they could not already do.
  'secret_intent_spent',
  // A stored card carrying its security code (`cvc`, `cvv`, `csc`,
  // `securityCode`...). 400, with `details.field` naming the key. Its own code
  // and not `bad_request` because the fix is not "correct the value": PCI DSS
  // 3.3.1 forbids keeping it after authorisation, so it can never be stored,
  // and the caller supplies it for one run in `runSecrets` instead.
  'cvc_not_storable',
  // A run's temporary secrets past the per-run bound: more than 16, or one
  // larger than 4 KB (wire contract §2, §8). 400, `details.field` names the
  // entry and never a value.
  'run_secrets_limit',
  // A temporary secret sent to a run that cannot hold it: ended, not started
  // on a machine yet, its machine unreachable, or a card field for a name that
  // is not a card of this run. 409, `details.reason` says which. Kept nowhere.
  'run_secret_undeliverable',
  // A recording read (`/play/<id>` and its `/api/*`, `/replay/e/<id>.outcrawl`,
  // or a `/v1/sessions/{id}/…` read or share) whose credential does not admit
  // that recording: none was sent, it belongs to someone the recording is not
  // shared with, or it is an API key an Outcrawl operator was handed (owner
  // rule 2026-09-27: staff do not watch until the customer shares).
  // `details.reason` says which. 403, and NOT `unauthorized`: the credential
  // may be perfectly valid, and rotating it fixes nothing; the fix is signing
  // in as a team member, a share, or a key made in the console.
  'replay_access_denied',
  // Admitted to WATCH a live session (a link holder, a named person), asked to
  // DRIVE it (`/api/control`, `/api/input`). 403: only an API key of the
  // owning account or a member of its team takes control.
  'replay_control_denied',
  // A driving request carried only by the player's cookie, from another site.
  // 403, CSRF: take control from the player page itself, or send the key or
  // viewer token in a header.
  'replay_control_cross_site',
  // ---- Wallet purchase controls (wire contract §3, §4 approval) ----
  // A card handle granted (`secrets`, `runSecrets`) or named (`wallet.card`)
  // with no `caps.spend`. 400: an agent never holds a card without a money
  // ceiling, so the fix is adding one, not retrying.
  'spend_cap_required',
  // Task text (or an `/answer`) carrying a Luhn-valid 13-19 digit number. 400,
  // and the message never echoes a digit: the fix is a secret and its handle.
  'card_number_in_task',
  // A purchase on a site off the run's `merchants` allow-list. Answered to the
  // agent's step, and as a 403 from the reveal gate.
  'merchant_not_allowed',
  // A purchase that would take `spent + reserved` past `caps.spend.limit`.
  'spend_cap_exceeded',
  // A purchase larger than `caps.spend.perPurchase`.
  'per_purchase_exceeded',
  // A card reveal with no reserved purchase open on this run. 403 at the gate.
  'no_open_purchase',
  // The person who started the run answered an approval question with no, or
  // never answered it. The step fails; the purchase is recorded abandoned.
  'approval_denied',
  // An approval question nobody answered within the run's ask timeout. The
  // step fails; the purchase is recorded abandoned.
  'approval_timed_out',
  // An `/answer` sent while the run waits on a `secret` question (contract
  // §4). 400: a secret is never an answer, it is added as a run secret, and
  // the value sent is never logged or echoed.
  'secret_in_answer',
  // ---- Wallet card providers (providers wire contract §2) ----
  // A connect, an upload or a rotation whose provider test failed: the
  // provider refused the credential, or the account cannot issue cards. 422
  // and not `bad_request`: the body was well-formed, and what cannot be
  // processed is the credential at the provider. `details.provider` names it;
  // the message carries the provider's reason as a plain sentence and never
  // a credential. Nothing was stored.
  'provider_test_failed',
  // A disconnect that found cards it could not close, because the provider
  // rejects the connection's credential. 409: `details.cards` names each card
  // by last four, brand and the provider's own id, and the fix is closing
  // them in the provider's own dashboard, then disconnecting again (which
  // then deletes the connection).
  'provider_cards_open',
  'internal',
] as const;

export type OutcrawlErrorCode = (typeof OUTCRAWL_ERROR_CODES)[number];

/**
 * What **we produce**. Every error this package throws serialises to exactly
 * this, with a code drawn from the closed union above.
 */
export interface SerializedOutcrawlError {
  code: OutcrawlErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/**
 * What **a client parses**. Deliberately wider: `code` is an open `string`.
 *
 * Strict in what we emit, lenient in what we accept. A client that rejects an
 * error body because the code is newer than the client turns a 404 into a
 * crash — and the failure lands during an incident, when a new code is most
 * likely to be in flight and least likely to be welcome. Branch on the codes
 * you know and fall through on the rest.
 */
export interface WireError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Narrows an open wire code to the closed union, for exhaustive branching. */
export function isKnownErrorCode(code: string): code is OutcrawlErrorCode {
  return (OUTCRAWL_ERROR_CODES as readonly string[]).includes(code);
}

export abstract class OutcrawlError extends Error {
  /** Stable across releases. Callers branch on this, never on `message`. */
  readonly code: OutcrawlErrorCode;

  /** Default HTTP status for the API layer. */
  readonly status: number;

  /** Structured, JSON-safe payload. Subclasses also expose it as typed fields. */
  readonly details: Readonly<Record<string, unknown>>;

  protected constructor(
    code: OutcrawlErrorCode,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    // `new.target` rather than a hardcoded string, so a subclass never reports
    // the wrong name and stack traces stay honest.
    this.name = new.target.name;
  }

  toJSON(): SerializedOutcrawlError {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/**
 * True for our errors, including ones raised by a second copy of this package
 * in the same process — the SDK and the server can end up with their own — where
 * `instanceof` is false despite an identical shape. Callers that only ever see
 * errors from one copy can use `instanceof OutcrawlError` directly.
 */
export function isOutcrawlError(value: unknown): value is OutcrawlError {
  if (value instanceof OutcrawlError) {
    return true;
  }
  if (!(value instanceof Error)) {
    return false;
  }
  const code: unknown = (value as { code?: unknown }).code;
  return (
    typeof code === 'string' && (OUTCRAWL_ERROR_CODES as readonly string[]).includes(code)
  );
}

/* ------------------------------------------------------------------ *
 * Extractions that never satisfied their schema
 * ------------------------------------------------------------------ */

/**
 * Which half of {@link ExtractionFailedError} this is. Two values, because
 * they are answered by different halves of the client — one has a reply to
 * report violations about and the other has nothing to read — and a customer
 * reading `details.failure` can tell whether the model disagreed with the
 * schema or never finished.
 */
export type ExtractionFailure = 'schema' | 'no-answer';

/**
 * The model behind a schema'd extraction did not produce a document that
 * satisfies it.
 *
 * Two causes, one code, because the next move is the same for both and a
 * client that had to learn two spellings of "ask again" would get the second
 * one wrong for a year:
 *
 * - `'schema'` — replies arrived and none satisfied the schema. `detail`
 *   carries the validator's own lines, which name the path and the offending
 *   value: `$: expected object, got array`.
 * - `'no-answer'` — no usable reply was produced at all: a generation that died
 *   mid-stream, a truncated one, a provider that would not serve the call.
 *
 * RETRYABLE. See the union's own comment for the measurement: 17 of 20 replays
 * of the identical bytes and the identical schema satisfied it.
 *
 * WHAT IT IS NOT ALLOWED TO BECOME. It is raised only after the retries this
 * service makes on the caller's behalf are spent. It is never a substitute for
 * an extraction that succeeded and returned little — an empty array from a page
 * that genuinely had nothing on it is a RESULT the customer is owed — and it is
 * never raised for a failure on our side of the key: a provider refusing our
 * credential or our billing is our defect and stays an `internal` with an
 * incident id, because "retry" would be false advice.
 */
export class ExtractionFailedError extends OutcrawlError {
  readonly failure: ExtractionFailure;

  /** What was wrong, in the words of whatever refused it. Never the page. */
  readonly detail: string;

  constructor(failure: ExtractionFailure, detail: string) {
    super(
      'extraction_failed',
      failure === 'schema'
        ? 'the extraction model was asked again and never returned a document satisfying the ' +
            `schema (${detail}). This is model sampling rather than a rejection of your ` +
            'request (the identical call commonly succeeds), so retrying is worth it, and a ' +
            'smaller page or a simpler schema makes it likelier.'
        : 'the extraction model produced no usable answer, and was asked again before this ' +
            `refusal (${detail}). Nothing is wrong with the request. Retry.`,
      503,
      { failure, detail },
    );
    this.failure = failure;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * Pages that were never fetched
 * ------------------------------------------------------------------ */

/**
 * Whose refusal it was, on the wire rather than in a log line the customer
 * would have to ask an operator to read.
 *
 * The two actors are not interchangeable and the next move differs completely:
 *
 * - `exit` — OUR egress path failed and the request never left it. Nothing is
 *   wrong with the URL and nothing is wrong with the site. A retry is
 *   allocated an exit again, so the identical call is the right call.
 * - `site` — the request left us and nothing upstream answered: DNS, the
 *   origin's TCP stack, its TLS, or simply silence until the budget ran out.
 *   Retrying changes nothing until the site does.
 *
 * Telling a customer to retry a `ERR_NAME_NOT_RESOLVED` is a loop against a
 * hostname that does not exist; telling them to fix their URL after our own
 * proxy refused a CONNECT is a support ticket about a request that was correct.
 */
export type UnreachableAttribution = 'exit' | 'site';

/**
 * The status each attribution answers with, and the ONE place that pair is
 * written down.
 *
 * It has to be shared rather than inlined, because `page_unreachable` is the
 * only code whose status is not a property of the code alone, and two other
 * packages have to arrive at the same number from the same field:
 * `@outcrawl/api` re-hosts an error raised by a second copy of this package
 * and cannot read the status off a sample, and `@outcrawl/sdk` rebuilds the
 * typed error from the wire. A hand-copied `503` in either of them is a status
 * that drifts silently, and the drift shows up as a client retrying a hostname
 * that will never resolve.
 */
export const UNREACHABLE_STATUS: Readonly<Record<UnreachableAttribution, number>> = Object.freeze({
  // Ours: retryable, and it says so with a `Retry-After`.
  exit: 503,
  // Upstream never answered. Not 503, which would claim OUR capacity is the
  // problem and invite a retry loop against a site that is simply down.
  site: 502,
});

/**
 * The Chromium net errors that are OURS.
 *
 * Every one of these is raised before the request reaches the origin: a
 * refused CONNECT, a proxy that would not take our credentials, a SOCKS hop
 * that could not be opened. The customer's URL is not involved in any of them,
 * which is why they are the ones that get the 503 and the `Retry-After`.
 *
 * The list is closed and everything else is `site` — deliberately, because the
 * failure mode of guessing wrong matters asymmetrically. A site failure
 * mislabelled `exit` tells a customer to retry a hostname that will never
 * resolve; an exit failure mislabelled `site` blames them for our proxy. The
 * second is the worse one, so the six the fleet actually produces are named
 * plus the three neighbouring proxy errors that cannot mean anything else.
 */
const EXIT_SIDE_NET_ERRORS: readonly string[] = [
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_INVALID_AUTH_CREDENTIALS',
  'ERR_SOCKS_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  // Not in the measured set, and included because there is no reading of them
  // that is the customer's fault: all three are Chromium refusing OUR proxy
  // configuration before a request is dispatched.
  'ERR_PROXY_CERTIFICATE_INVALID',
  'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  'ERR_UNEXPECTED_PROXY_AUTH',
];

/**
 * Which side refused, read off the text Chromium reported.
 *
 * ONE function, exported, and the only opinion in the codebase on this
 * question. The worker binding that raises the error and the test that pins
 * the mapping call the same code, so a net error added to the list is added
 * once.
 *
 * Substring rather than equality: `Page.navigate` reports a bare
 * `net::ERR_TUNNEL_CONNECTION_FAILED` today, but the same classification has
 * to hold for a text that arrived wrapped in a sentence, and falling through
 * to `site` on a wrapped tunnel failure is the exact misattribution above.
 * None of the names below is a substring of a site-side one.
 *
 * A cause with no `net::` in it at all — a navigation that simply ran out of
 * budget — is `site` by the same default, which is honest: our exit reported
 * no fault of its own.
 */
export function attributionForNetError(cause: string): UnreachableAttribution {
  const text = cause.toUpperCase();
  for (const candidate of EXIT_SIDE_NET_ERRORS) {
    if (text.includes(candidate)) return 'exit';
  }
  return 'site';
}

/**
 * The brake on a retry after an exit-side refusal, and NOT an estimate of when
 * the exit recovers — nothing on this path measured that, and a number invented
 * to fill a header is the mistake {@link ConcurrencyLimitError} refuses to
 * make by carrying no `Retry-After` at all.
 *
 * It is honest here because the recovery is not this exit healing: a retried
 * request is allocated an exit again, so the wait only has to be long enough
 * not to be a tight loop against the pool. `Retry-After: 0` instructs an
 * immediate retry, which is the one instruction a 503 must never give, and a
 * client handed no number at all picks its own — which is how one broken exit
 * becomes a stampede.
 */
export const EXIT_RETRY_AFTER_SECONDS = 2;

/**
 * `PageUnreachableError.cause` for a destination our residential exit
 * PROVIDER refuses to connect to on every one of its exits — its own
 * blocklist, not an exit's health and not the site.
 *
 * Not a `net::` token, and deliberately: Chromium reports this refusal as
 * `net::ERR_TUNNEL_CONNECTION_FAILED`, the same string a dead node produces,
 * and repeating that token here would put "a retry is allocated a different
 * exit" in front of a customer for whom every exit refuses identically. The
 * worker reads the provider's own verdict with one CONNECT after the failure
 * and names it here.
 *
 * Measured 2026-09-24 16:30Z (n=3 per host, 18/18): `www.cnn.com`,
 * `www.bbc.com`, `www.nasa.gov`, `www.weather.gov`, `www.theguardian.com` and
 * `www.reuters.com` are refused this way by the residential package the fleet uses.
 *
 * ALWAYS `site` attribution, so 502 and no `Retry-After`: a retry cannot help
 * (the provider refuses the destination on every exit), and a 503 would tell
 * every client to loop against a refusal that does not lift.
 */
export const EXIT_PROVIDER_REFUSED_CAUSE = 'destination_unreachable_via_residential';

/** The customer's sentence for {@link EXIT_PROVIDER_REFUSED_CAUSE}. Shared with the SDKs through `PageUnreachableError`. */
function providerRefusedMessage(url: string, directCause: string | undefined): string {
  const refused = `could not fetch ${url}: this destination cannot be reached through our residential network.`;
  return directCause === undefined
    ? `${refused} Nothing was fetched and no response was received. Retrying unchanged will not help.`
    : `${refused} It was fetched from our own network address instead, and that failed too ` +
        `(${directCause}), so no response was received. Retrying unchanged will not help.`;
}

/**
 * `PageUnreachableError.cause` for a third-party IP-lookup site (ipinfo.io,
 * api.ipify.org, Cloudflare's `/cdn-cgi/trace`…) the residential network we
 * use does not carry: a condition of that network, applied before anything is
 * sent (`termsForbidDestination` in `@outcrawl/proxy`). ONLY for that rule:
 * a provider's own blocklist is {@link EXIT_PROVIDER_REFUSED_CAUSE}.
 *
 * Its own cause because the generic refusal read as a failure to a customer
 * who only wanted to confirm a session's exit, and that customer has a real
 * answer: the proxy-answered CDP command `Outcrawl.getExit` (the SDK's
 * `browser.exit()`). The sentence names the rule and that answer.
 *
 * ALWAYS `site` attribution, 502, no `Retry-After`: the rule does not lift.
 */
export const IP_LOOKUP_REFUSED_CAUSE = 'ip_lookup_not_offered';

/**
 * The customer's sentence for {@link IP_LOOKUP_REFUSED_CAUSE}. Shared with the SDKs through `PageUnreachableError`.
 *
 * An agent run's brain gets {@link IpLookupAgent}'s variant instead: it cannot
 * send a CDP command, and on 2026-10-20 (production, n=6 ipinfo.io runs) five
 * of six brains called `Outcrawl.getExit` or `browser.exit` as a tool after
 * reading this sentence. It is told the exit the run was started with, when
 * one was named, which is the customer's own setting.
 */
function ipLookupRefusedMessage(url: string, agent: IpLookupAgent | undefined): string {
  const refused = `could not open ${url}: IP-lookup sites are not available through our residential network (a condition of the network we use).`;
  if (agent === undefined) {
    return `${refused} To see this session's exit, send the CDP command Outcrawl.getExit, or call browser.exit() in the SDK.`;
  }
  return agent.exit === undefined ? refused : `${refused} This run's exit is in ${agent.exit}: the exit location it was started with.`;
}

/**
 * Who reads an {@link IP_LOOKUP_REFUSED_CAUSE} refusal when it is an agent
 * run's brain: `exit` is the exit the run was started with (a country code,
 * or `country/region/city`), absent when the run named none.
 */
export interface IpLookupAgent {
  readonly exit: string | undefined;
}

/**
 * The page was never fetched. No response of any kind arrived, so there is no
 * status code, no headers and no body.
 *
 * This is the honest end of a navigation that reported `errorText`, or one
 * that never committed a document inside the caller's budget. Both used to
 * reach the customer as a 500 with an incident id, which said our service
 * crashed about a residential exit that refused a CONNECT tunnel.
 *
 * WHAT IS IN `details`, and why each field is load-bearing:
 *
 * - `url` — what was asked for, as the caller wrote it. Nothing committed, so
 *   there is no response URL to prefer and the page's current URL is whatever
 *   document is still in the tab, which for a crawl is the PREVIOUS page.
 * - `cause` — verbatim, `net::` prefix and all. That prefixed token is the
 *   string an operator greps and the string Chromium's own documentation is
 *   indexed by; stripping it to look tidier costs the one field that makes the
 *   error searchable. The two exceptions are {@link EXIT_PROVIDER_REFUSED_CAUSE},
 *   which names what Chromium's `net::ERR_TUNNEL_CONNECTION_FAILED` hides
 *   (the residential provider refuses the destination on every exit), and
 *   {@link IP_LOOKUP_REFUSED_CAUSE}, an IP-lookup site our residential
 *   network does not carry, refused before anything is sent.
 * - `attribution` — `exit` or `site`. See {@link UnreachableAttribution}.
 * - `retryAfterSeconds` — exit-side only, and read by `exitFor` in
 *   `@outcrawl/api` to emit `Retry-After`. Absent on the site side because a
 *   hostname that does not resolve clears on no schedule we know.
 * - `directCause` — with {@link EXIT_PROVIDER_REFUSED_CAUSE} only, when the
 *   page was then tried from our own network address and that failed too: that
 *   attempt's verbatim `net::` cause.
 *
 * The STATUS follows the attribution, which is the entire reason the two are
 * distinguished: 503 for our own egress path failing (retryable, and it says
 * so with a header), 502 for an upstream that did not answer. A single status
 * for both would either tell customers to retry DNS failures forever or blame
 * them for our proxy.
 */
export class PageUnreachableError extends OutcrawlError {
  /** The URL that was asked for, as the caller wrote it. */
  readonly url: string;

  /**
   * The underlying refusal, verbatim: `net::ERR_TUNNEL_CONNECTION_FAILED` —
   * or {@link EXIT_PROVIDER_REFUSED_CAUSE} when the residential provider
   * refuses the destination itself, or {@link IP_LOOKUP_REFUSED_CAUSE} for an
   * IP-lookup site our residential network does not carry.
   */
  override readonly cause: string;

  /** Whose refusal it was. Decides the status and the customer's next move. */
  readonly attribution: UnreachableAttribution;

  /** Set on an exit-side refusal only, where a retry genuinely helps. */
  readonly retryAfterSeconds: number | undefined;

  /**
   * Only with {@link EXIT_PROVIDER_REFUSED_CAUSE}: the verbatim `net::` cause
   * of the attempt made from our own network address after the provider
   * refused, when one was made. Absent when none could be (a `profile`
   * request, or a worker that cannot state its own geography).
   */
  readonly directCause: string | undefined;

  constructor(
    url: string,
    cause: string,
    attribution: UnreachableAttribution = attributionForNetError(cause),
    directCause?: string,
    /** With {@link IP_LOOKUP_REFUSED_CAUSE} only: the refusal is an agent run's, worded for its brain. */
    agent?: IpLookupAgent,
  ) {
    const refused = cause === EXIT_PROVIDER_REFUSED_CAUSE;
    const lookup = cause === IP_LOOKUP_REFUSED_CAUSE;
    // A provider refusal or a refused IP lookup is never the retryable half,
    // whatever a caller passed.
    const side: UnreachableAttribution = refused || lookup ? 'site' : attribution;
    const ours = side === 'exit';
    super(
      'page_unreachable',
      lookup
        ? ipLookupRefusedMessage(url, agent)
        : refused
          ? providerRefusedMessage(url, directCause)
          : ours
            ? // Only what an exit-side net error observes: the connection through
              // our exit failed before a request reached the site. Not "our exit
              // refused" and not "not the site": a CONNECT to a host with no DNS
              // record fails the same way (2026-09-29, 36 of 2,289 scrapes).
              `could not fetch ${url}: ${cause}. The connection through our exit failed before any ` +
              'request reached the site, so no response was ever received and there is no status ' +
              'code to report. A retry is allocated a different exit.'
            : `could not fetch ${url}: ${cause}. No response was ever received, so there is ` +
              'no status code to report. Our exit path reported no fault of its own: ' +
              'nothing upstream answered.',
      UNREACHABLE_STATUS[side],
      {
        url,
        cause,
        attribution: side,
        ...(ours ? { retryAfterSeconds: EXIT_RETRY_AFTER_SECONDS } : {}),
        ...(refused && directCause !== undefined ? { directCause } : {}),
      },
    );
    this.url = url;
    this.cause = cause;
    this.attribution = side;
    this.retryAfterSeconds = ours ? EXIT_RETRY_AFTER_SECONDS : undefined;
    this.directCause = refused ? directCause : undefined;
  }
}
