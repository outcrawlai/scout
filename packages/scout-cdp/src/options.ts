/**
 * What a binding is bound with: the page's model, input planner, tabs, files,
 * tools and camera, the clock, the freeze timings, the browser's
 * {@link CdpFlavor}, and the host's {@link BindingHooks}.
 */
import type { Clock, WallClock } from '@outcrawl/scout-core';
import type { DownloadStart, LookVision, ModelPort, ToolPort } from '@outcrawl/runtime';

import type { FilePort } from './files';
import type { CdpFlavor } from './flavor';
import type { HandsPort } from './hands';
import type { BindingHooks } from './hooks';
import type { KeepPdf } from './pdf-document';
import type { AgentTabs } from './tabs';

export interface BindingOptions {
  /**
   * The model, or an explicit `null` declining one.
   *
   * Required and nullable. It was `model?: ModelPort` and BOTH of this host's
   * call sites omitted it — `runOneAgent` for `/v1/agent` and `main.ts`'s
   * `agentDeps` for the CDP proxy — so `Outcrawl.observe`, `Outcrawl.extract`
   * and every agent step have refused since they shipped, while the package
   * description advertises the first two as "answered here because they need a
   * model call C++ cannot make".
   *
   * `null` still refuses (see `BindingHooks.modelUnavailable`), and that path is
   * the CDP one: a tenant's `Outcrawl.extract` arrives per-request and there is
   * no earlier moment to refuse at. What changed is that a reader can now tell
   * the refusal was chosen.
   */
  readonly model: ModelPort | null;
  /** Absent means every pointer action refuses. See {@link HandsUnavailableError}. */
  readonly hands?: HandsPort;
  /**
   * The session's tabs, or an explicit `null` for a run that has one page.
   *
   * REQUIRED and nullable, and deliberately not `tabs?: AgentTabs`. The
   * optional-field version of this decision has now cost this repo three
   * capabilities that were built, shipped and never bound — `JobDeps.hands`,
   * `AgentBindingOptions.model`, `AgentBindingOptions.solveChallenge` — each of
   * which compiled cleanly while being absent in production for the life of the
   * feature. Omission has to be a compile error at the composition root, because
   * that is the one place where nothing else can notice.
   *
   * `null` is a real answer and not a lesser one: the CDP proxy path binds one
   * tenant-driven page and has no tab set to offer, and a worker that says
   * `null` should warn at startup (`host.no_tabs`) the way `host.no_model` and
   * `host.no_hands` do. With `null`, `AgentDeps.tabs` is absent — spread away,
   * not set to `undefined` — and the loop's tab actions refuse by name.
   */
  readonly tabs: AgentTabs | null;
  /**
   * This run's uploaded files, or an explicit `null` for a run that has none.
   *
   * REQUIRED and nullable, on exactly the terms `secrets`, `tabs`, `model` and
   * `solveChallenge` above are — this file has now paid for that rule four
   * times and the fifth is not going to be the exception. `null` means
   * `attachFile` refuses BY NAME, so a run with no files and a composition
   * root that forgot are different observable outcomes rather than the same
   * bytes.
   *
   * The CDP-proxy binding is `null`, and correctly: a tenant driving their own
   * page through `/connect` has no run, therefore no `up/<runId>/` prefix, and
   * therefore nothing this port could honestly answer.
   *
   * Bound per RUN and not per worker — see {@link FilePort} — because the run
   * id is closed over rather than passed. A seam that took a run id would make
   * reaching another tenant's uploads a matter of getting a variable right at
   * a call site, and `up/<runId>/<fileId>` is a path in a shared bucket.
   */
  readonly files: FilePort | null;
  /**
   * WHERE `callTool` GOES, or absent for a run that reaches nothing outside
   * the browser.
   *
   * OPTIONAL rather than required-and-nullable, and it is the one seam in this
   * interface where that is the right shape — because the runtime field it
   * feeds is itself optional and carries the same meaning. `AgentDeps.tools`
   * absent means "this run reaches nothing outside the browser", which is the
   * DEFAULT and not a degraded mode: deny by default is the containment story
   * for a page that talks a model into mailing a table to an attacker. A
   * `null` here would have to be spread away into exactly the same absence, so
   * the extra spelling would buy no distinction.
   *
   * What guards the omission is therefore NOT this type. It is
   * `requireToolProxy` in `jobs.ts`: a run whose submit named connectors and
   * whose host has no proxy bound is refused BY NAME rather than served a
   * prompt with no tool grammar in it. That refusal is the loud version of the
   * defect this field was added to end — every `callTool` on every run
   * answering "this run reaches nothing outside the browser" because nobody
   * had written the client.
   *
   * Bound per RUN — see {@link runToolPort} — because the account, the run id
   * and the grant are closed over rather than passed.
   */
  readonly tools?: ToolPort;
  /**
   * The vision model behind `page.look`, or absent for a run that is not
   * offered one — a host with no look model, or a run on the vision arm,
   * whose actuator already sees every frame.
   *
   * Present, the binding composes a per-run `page.look` port (see
   * `@outcrawl/runtime`'s `look.ts`) onto {@link tools}, with this binding's
   * own camera: a screenshot and a DevTools hit test, nothing the page can
   * observe. Bound per RUN because the look count lives in the port.
   */
  readonly look?: LookVision;
  /**
   * Looks this run already took on the browsers it lost, read back from its
   * durable steps (`looksTaken` in `@outcrawl/runtime`), so `page.look`'s
   * limit holds per RUN across re-acquisition and resume. Absent is zero.
   */
  readonly looksTaken?: number;
  /**
   * How many looks this run may make in all: `lookAllowance(caps.budget)`
   * from `@outcrawl/runtime` on a host that bills in credits. Absent is that
   * module's `DEFAULT_LOOKS_PER_RUN`.
   */
  readonly maxLooks?: number;
  /**
   * Scripts this run already ran on the browsers it lost, read back from its
   * durable steps (`scriptsTaken` in `@outcrawl/runtime`), so `page.script`'s
   * allowance holds per RUN across re-acquisition and resume. Absent is zero.
   * The port itself is bound on every binding: its runner is the binding's
   * own page, in an isolated world.
   */
  readonly scriptsTaken?: number;
  /** Monotonic, for the dwell inside a gesture plan. Defaults to core's `systemClock`. */
  readonly clock?: Clock;
  /**
   * The browser's committed-navigation counter, for the BUDGET CAP.
   *
   * Passed straight through to `AgentDeps.pageLoads`. Bound from
   * `session.tabs.pageLoads()` — the same counter `jobs.ts` sums into the
   * invoice's `page_load` rows — so the ceiling and the bill count pages from
   * one increment rather than two tallies.
   *
   * Optional because a page is a credit and a host that cannot count them
   * prices none rather than guessing; every implementer of that shape is a test
   * or a bench. The composition root binds it.
   */
  readonly pageLoads?: () => number;
  /**
   * The session's download ledger, for the outcome CHECK.
   *
   * Passed straight through to `AgentDeps.downloads`. Bound from
   * `session.tabs.downloads()`, so a click that began a download is judged by
   * the browser's own announcement rather than by a page it leaves unchanged.
   * Optional on {@link pageLoads}'s terms: absent, a download click is judged
   * on the page alone.
   */
  readonly downloads?: () => readonly DownloadStart[];
  /**
   * Keeps a PDF a tab opens in the browser's viewer as a file of the run,
   * from the bytes the binding already reads for its text; nothing new is
   * asked of the site. Absent, or answering `undefined`, the PDF is read but
   * not kept, and the snapshot does not say it is. See `./pdf-document.ts`.
   */
  readonly keepPdf?: KeepPdf;
  /** Passed straight through to `AgentDeps.wallClock`. */
  readonly wallClock?: WallClock;
  /**
   * How long the browser holds the action lock before releasing it itself.
   * Absent uses {@link DEFAULT_LOCK_TIMEOUT_MS}, which is where the argument
   * for the value lives. It is NOT the browser's own default, and that is
   * deliberate: the browser's 30 s is shorter than one model call.
   */
  readonly lockTimeoutMs?: number;
  /**
   * How long a freeze command waits for the renderer's reply before it is
   * reported as held. Absent uses {@link FREEZE_REPLY_DEADLINE_MS}, which is
   * where the argument for the value lives.
   */
  readonly freezeReplyTimeoutMs?: number;
  /**
   * How long, from the send, a freeze command held behind this tab's own
   * main-frame navigation is waited for before that navigation is stopped.
   * Absent uses {@link NAVIGATION_FREEZE_HOLD_MS}, which is where the argument
   * for the value lives.
   */
  readonly navigationFreezeHoldMs?: number;

  /** What the browser speaks beyond stock CDP. Absent: {@link outcrawlFlavor}. */
  readonly flavor?: CdpFlavor;
  /** What the host adds to every bound page. Absent: nothing; the portable binding. */
  readonly hooks?: BindingHooks;
}
