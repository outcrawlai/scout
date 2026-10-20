/**
 * The agent loop, bound to one page.
 *
 * `@outcrawl/runtime` deliberately opens no socket: `AgentDeps` is a hole where
 * a browser goes, and this fills it for one CDP page. Its whole surface is
 * {@link pageBinding}; {@link bindAgent} adds the tab router and the tools.
 *
 * ## Three things this file gets right that are easy to get wrong
 *
 * **The lock comes down for ALL input, and only for input.**
 * `dispatchPointerPath` and `dispatchWheelPath` both refuse while
 * `Outcrawl.lock` is held — the lock's `WebContents::ScopedIgnoreInputEvents`
 * drops every event before it reaches the renderer, so the browser refuses
 * rather than dispatching into a void. Stock `Input.dispatchKeyEvent` gets the
 * same treatment from the lock and does NOT refuse: it reports success while
 * the event is discarded. So keystrokes take the same release/act/retake path
 * as gestures now; see {@link agentDepsFor}'s `dispatchGesture` for the whole
 * of that argument and for what it means about every `press` this binding did
 * before today. Geometry is read frozen, the freeze is dropped for exactly the
 * length of the input, and retaken. This is the same shape
 * `PageSession.withSolve` uses for an in-page challenge, for the same reason:
 * some things cannot happen to a page that is not running.
 *
 * **All input goes through `agenthands` or it does not go.** There is no
 * `Input.dispatchMouseEvent` fallback for a click and no `Input.insertText`
 * fallback for a fill. Five of the ten actions are input — `click`, `hover`,
 * `scroll`, `press`, `fill` — and all five route through {@link HandsPort}.
 * `select` is the sixth action that touches a control and deliberately does
 * NOT: a `<select>` popup is drawn by the OS, so there is no in-page geometry
 * to click. See {@link HandsPort} and `performSelect`.
 *
 * **A node reference is frame-qualified and this binding checks it.** See
 * {@link CrossFrameRefError}. With tabs bound the same check is what keeps a
 * reference minted on one tab from resolving against another: an AX frame
 * ordinal is the browser's own `FrameTreeNodeId` (see `getFrameOrdinal` in
 * `0010-tenancy.patch`), which is browser-global and never reused, so two tabs
 * cannot mint the same ordinal and a foreign reference is refused rather than
 * landing on whatever node happens to carry that id in the focused tab. See
 * {@link WrongTabRefError} for why that refusal names the tab.
 */
import { DEFAULT_MIN_TEXT_LENGTH, isRecord, optionAliases, systemClock, type JsonSchema } from '@outcrawl/scout-core';
import { ACTIONABLE_ROLES, MAX_DRAG_PX, MIN_DRAG_PX, filterTree, findNode, formatNodeRef, framedInstruction, heldPrivately, isReloadKey, isViewportPoint, nativeDateKeys, nativeDateKind, nativeDateRuns, nativeDateValue, nodeRef, walk, type Action, type AgentDeps, type AgentPrompt, type AxNode, type AxTree, type DragAction, type DragEnd, type ExtractBound, type ExtractContent, type ExtractOutcome, type ExtractSelection, type LookCamera, type LookShot, type NativeDateKind, type PageScriptRunner, type RefusedSubmit, type ModelChoice, type NodeRef, type PerformOutcome, type SiteCheckResult, type SiteCheckSighting, type TextCaptchaSighting, type ViewportPoint } from '@outcrawl/runtime';
import { axTreeFromCdp, frameOrdinalsOf } from './ax-tree';
import { isCdpTimeout, type CdpPage } from './cdp';
import { readDocument } from './document';
import { pageCamera } from './camera';
import { ancestorsOf, descendantsOf, documentClip, elementOf, hitAt, inLookWorld, lookWorldList, onScreenPart, reachable, scrollPosition, viewport } from './page-reads';
import { pageScriptRunner } from './page-script';
import { childFrameIds } from './frames';
import { outcrawlFlavor } from './flavor';
import type { LoadRequest, LoadResult, ShotRegion, TabHooks } from './hooks';
import type { BindingOptions } from './options';
import { dialogReadMs } from './dialog';
import { DRAG_OVER_INTERVAL_MS, DRAG_START_WAIT_MS, liftOf, type Html5DragArm } from './drag';
import { NoModelError, CoveredTargetError, CrossFrameRefError, DISABLEABLE_TAGS, DisabledTargetError, FileInputClickError, FilesUnavailableError, HandsUnavailableError, NativeSelectPopupError, OffScreenTargetError, PointerAimRefusedError, TextTargetError, UnmeasurableTargetError, UnperformableActionError, opensPopupMenu, overlayAccount, type CoverAccount, type Hit, type ShownNode } from './errors';
import { DEFAULT_LOCK_TIMEOUT_MS, ERROR_PAGE_PREFIX, FREEZE_REPLY_DEADLINE_MS, FreezeNotAnsweredError, LOADING_HOLDS_BEFORE_TURN, NAVIGATION_FREEZE_HOLD_MS, StillLoadingError, UNANSWERED_RELEASE_WAIT_MS, heldFreezes, within } from './freeze';
import type { HandsContext, HandsPort, HandsStep, HandsTarget, PointerSample } from './hands';
import { selfReleases, sendUntilForwarded } from './input';
import { asksForDestination, withLinkHrefs } from './link-hrefs';
import { pdfDocuments, pdfMarkdown, pdfNotice } from './pdf-document';
import { textDocumentMarkdown, textDocumentNotice, textDocumentWindow, textDocuments, type TextDocumentRead } from './text-document';
import { topFrameWatch } from './top-frame';
import { HIT_SAMPLES, HIT_WINDOW_PX, LANDING_DRAWS, LIST_OPTION_POLL_MS, LIST_OPTION_ROLES, LIST_OPTION_WAIT_MS, LIST_SELECT_SETTLE_MS, MAX_REACH_GESTURE_PX, MAX_REACH_TOTAL_PX, MAX_SCROLLS_TO_REACH, MIN_HITTABLE_PX, PAINTED_DESCENDANT_DEPTH, PAINTED_DESCENDANT_READS, PAINTED_RUN_STEPS, POINT_AIM_PX, REST_EPSILON_PX, SCROLL_PROGRESS_PX, SCROLL_REST_POLL_MS, SCROLL_REST_TIMEOUT_MS, TYPED_LIST_ROLES, normalisedName, textOutsideLists } from './reach';
import { CLIPPING_SCROLLER, DISMISS_NAME, EDITABLE_FIELD_WIDTH, EDITABLE_FIELDS, EDITABLE_HOST, FILE_INPUT_NEAR, FIXED_OF, FOCUS_TAKES_TEXT, LABELLED_CONTROL_TYPES, MAX_DISMISS_CHECKS, MAX_DISMISS_NAMED, MAX_MIXED_LABEL_READS, MAX_NATIVE_DATE_READS, MODAL_OF, NATIVE_DATE_HOST, NATIVE_DATE_LAYOUT, SAME_CONTROL, SELECT_OF, VISIBLE_PART, asShown, clipFrom, nativeSelect, refusedSubmit, visibleFrom } from './scripts';

/**
 * The `Outcrawl.getAXTree` node ceiling this binding asks for, well above the
 * fork's own default of 20,000 (`kDefaultMaxNodes`,
 * `packages/browser/patches/brave-core/0010-tenancy.patch`'s
 * `OutcrawlHandler::GetAXTree`) — a hard refusal of the WHOLE snapshot past
 * whichever bound applies, never a truncation. Two acct_henrylabs runs
 * (45c07dd9, 2024add4, "open Wikipedia featured articles") died on the
 * default: measured on the fleet rig against the production binary,
 * Wikipedia:Featured_articles is 23,579 kept nodes at depth 2, refused at
 * 20,000 and answered in 701ms for a 2.02MB reply at 50,000, while
 * World_War_II (12,125) and India (14,254) already fit under the default —
 * so this is a page-size bound, not a depth one, and 100,000 is comfortably
 * past every page measured so far without discovering where the fork's own
 * (currently absent) upper limit would start to matter.
 *
 * Not raised to remove the refusal entirely: `runtime/src/loop.ts`'s
 * `serializeTree` re-bounds every tree to `TREE_CHAR_BUDGET` before a model
 * ever sees it, so a bigger fetch only decides whether the PAGE is reachable
 * at all. The fork refusing outright past this ceiling is the answer this
 * binding wants to keep: a tree silently truncated at some larger bound would
 * read as complete while quietly dropping the page's own content, which is a
 * worse failure than a loud one a caller can see and raise again.
 */
const SNAPSHOT_MAX_NODES = 100_000;

/**
 * How long `perform({type:'navigate'})` waits for the requested navigation's
 * COMMIT (or its failure) before returning without one.
 *
 * Not a timeout on the command: the command may never answer and that is a
 * legal state on this fork. It bounds the wait for `Page.frameNavigated`,
 * which is the observable that says the page arrived. Every reader after this
 * — the outcome check in `runtime/src/verify.ts` above all — judges whatever
 * document is there when it returns, so returning before the commit hands
 * them the page the run is LEAVING.
 *
 * It was 6 s, on the argument that a measured commit is 173-233 ms. Through
 * residential exits it is not. MEASURED on production `run_7c6cc717`
 * (2026-10-03): from the document request to the commit, 8.4 s, 11.0 s and
 * 16.4 s, and the navigate that took 11.0 s was judged "still on about:blank"
 * while the next step read the target. Across all 46 agent navigates since
 * 01:00Z (24 runs) the slowest commit that DID beat the old bound was 6.8 s.
 *
 * 30 s is the CDP deadline the 6 s replaced. A navigation that has neither
 * committed nor failed by then returns the url the page still shows, and the
 * check reports that it did not take effect, which by then is the truth.
 */
const NAVIGATE_COMMIT_CEILING_MS = 30_000;
const NAVIGATE_POLL_MS = 25;

/**
 * How long after its commit a document may still be reported as parsing to the
 * settle (`DocumentProbe.parsing`): the settle's loading ceiling
 * (`DEFAULT_SETTLE_POLICY.loadingBudgetMs`), which it spends past its ten-second
 * budget only while the tab is still receiving (`lastNetworkAt`). So a
 * `DOMContentLoaded` that never arrives on a silent tab costs what an
 * unrendered page already may, and on one still downloading at most this,
 * once per document.
 */
const MAX_PARSE_WAIT_MS = 30_000;

/**
 * A binding's camera: `page.look`'s two reads, plus the two the text-captcha
 * reader needs (the finder only where a host hook offers one). All are
 * invisible to the page.
 */
export interface BindingCamera extends LookCamera {
  findTextCaptcha?(tree: AxTree): Promise<TextCaptchaSighting | undefined>;
  shootElement(ref: NodeRef): Promise<LookShot['image']>;
}

/** Each binding's camera, for {@link bindAgent} to hand `page.look` and the text-captcha reader. */
export const cameras = new WeakMap<AgentDeps, BindingCamera>();

/** One binding's check solver and its sighting, for {@link bindAgent} to hand `page.verify` and the loop. */
export interface BindingSiteCheck {
  solve(): Promise<SiteCheckResult>;
  sight(): Promise<SiteCheckSighting | undefined>;
}

/** Each binding's site-check solver, for {@link bindAgent} to hand `page.verify`. */
export const siteChecks = new WeakMap<AgentDeps, BindingSiteCheck>();

/** Each binding's `page.script` runner, in its page's main frame, for {@link bindAgent} to hand the port. */
export const scriptRunners = new WeakMap<AgentDeps, PageScriptRunner>();

/**
 * The BORDER box of a `DOM.getBoxModel` reply, as a rect: the area a press
 * lands on. A pointer event hit-tests against the border box — padding is the
 * element's own paint, and `DOM.getNodeForLocation` in the padding names the
 * element itself — so this is the rect `landOnTarget`'s hit test agrees with.
 *
 * NOT THE CONTENT BOX. It was, and a control whose whole area is padding read
 * as zero wide. MEASURED 2026-09-26 (production `/connect`, n=1): a maps site's
 * pre-hydration "Menu" is a `<button>` with `padding: 12px 16px` around an
 * empty 0x0 icon span — border 32x42 at (88, 12), content 0x18 at (104, 24) —
 * and the click was refused off-screen-target, "it has no area to click".
 * No caller of this reads the content box for anything else: every one aims,
 * lands, reveals or photographs, and all of those mean the border box. A Text
 * node's quads are all its laid-out text, so text is unaffected.
 */
export function boxFrom(payload: Record<string, unknown>): HandsTarget {
  const model = payload['model'];
  if (typeof model !== 'object' || model === null || !('border' in model)) {
    throw new TypeError('DOM.getBoxModel returned no model with a border quad');
  }
  const border = model.border;
  if (!Array.isArray(border) || border.length < 8) {
    throw new TypeError('DOM.getBoxModel returned no border quad');
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    const x = border[i];
    const y = border[i + 1];
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new TypeError('DOM.getBoxModel border quad is not numeric');
    }
    xs.push(x);
    ys.push(y);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/**
 * Binds `AgentDeps` to a page, or to a set of tabs.
 *
 * Most seams here are optional and every absent one refuses at the point of
 * use rather than at construction: a worker with no model can still run
 * `navigate`/`fill`/`press` flows, and a worker with no hands can still
 * `observe`. Refusing late is what keeps those partial configurations usable
 * instead of unbootable.
 *
 * `options` itself is NOT optional any more, and neither is
 * {@link AgentBindingOptions.solveChallenge}. It defaulted to `{}`, so every
 * caller got a binding with no solver and the challenge path was dead on
 * arrival — a default that silently omits a dependency is the same defect as a
 * caller that forgets it, minus the chance of noticing.
 *
 * With {@link AgentBindingOptions.tabs} `null` this is exactly the one-page
 * binding it has always been, down to the CDP call sequence, and `page` is the
 * page. With tabs bound it returns {@link tabbedBinding}, which is one
 * one-page binding PER TAB behind a router, and `page` is then only the tab
 * the session started on — every call follows the focused tab instead.
 */
/**
 * `sleep`, or less: resolves when `sleep` does or when `signal` aborts,
 * whichever is first. The sleep itself is left to run out on its own — a
 * `Clock` cannot cancel one — and holds nothing but its timer.
 */
async function sleepUnlessAborted(sleep: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep;
  if (signal.aborted) return;
  const aborted = Promise.withResolvers<void>();
  const onAbort = (): void => {
    aborted.resolve();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([sleep, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run `act` with a REVEALED value, and answer any refusal it throws in what
 * the model WROTE. A select names the option it could not choose
 * (`select("12") did not apply`), and that sentence becomes the step's error,
 * which the model and the step trace read; with a secret substituted, the
 * option it names is a card's value. No-op when nothing was substituted.
 */
async function asWritten<T>(written: string, revealed: string, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    if (revealed !== written && error instanceof Error && revealed !== '') {
      error.message = error.message
        .split(JSON.stringify(revealed))
        .join(JSON.stringify(written))
        .split(revealed)
        .join(written);
    }
    throw error;
  }
}

/**
 * `tree` without the text a person does not see because it is painted fully
 * transparent (`paintHidden`: `opacity: 0` on it or an ancestor, which the
 * accessibility tree keeps), with one line first saying how many lines went.
 * Controls stay, painted or not: a transparent checkbox under its styled label
 * is still the one a key or a label press reaches. What the tree already
 * leaves out stays out (`display: none`, `visibility: hidden`, `hidden`,
 * `aria-hidden`, closed `<details>`), and screen-reader-only text, which is
 * painted, stays in.
 *
 * MEASURED: dev it-07.r1 (2026-10-14, live build), an extract before any key
 * was pressed returned the page's transparent "completed successfully" line
 * as its status, and the run finished on a page that had not succeeded; the
 * tree it read marked the line not painted, and the extraction model reported
 * it anyway. Stock Chromium the same day: 5 of the 18 InteractionTests dev
 * pages hold their success line at `opacity: 0` from load, each `paintHidden`.
 */
function withoutUnpaintedText(tree: AxTree): AxTree {
  const unpainted = (node: AxNode): boolean => node.state?.paintHidden === true && !ACTIONABLE_ROLES.has(node.role);
  if (!walk(tree).some(unpainted)) return tree;
  let dropped = 0;
  const kept = (node: AxNode): AxNode[] => {
    const children = node.children?.flatMap(kept);
    if (unpainted(node)) {
      if ((node.name ?? '').trim() !== '') dropped += 1;
      return children ?? [];
    }
    return [children === undefined ? node : { ...node, children }];
  };
  const children = (tree.root.children ?? []).flatMap(kept);
  const notice: AxNode = {
    ref: tree.root.ref,
    role: 'StaticText',
    name: `[${String(dropped)} text ${dropped === 1 ? 'line' : 'lines'} not shown on screen (fully transparent) left out; a page may show such text after an action or on scroll]`,
    xpath: '',
  };
  return { ...tree, root: { ...tree.root, children: dropped === 0 ? children : [notice, ...children] } };
}

export function pageBinding(page: CdpPage, options: BindingOptions): AgentDeps {
  const clock = options.clock ?? systemClock;
  const flavor = options.flavor ?? outcrawlFlavor;
  const hooks = options.hooks ?? {};
  const lockParams = { timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS };
  const replyDeadlineMs = options.freezeReplyTimeoutMs ?? FREEZE_REPLY_DEADLINE_MS;
  const navigationHoldMs = options.navigationFreezeHoldMs ?? NAVIGATION_FREEZE_HOLD_MS;

  /**
   * `base64` (a PNG of this tab) as a model may see it: the tab's masking hook
   * paints out what must not be shown (or withholds the shot), and with no
   * hook the shot is the page as painted. `region` names what a CLIPPED shot
   * shows: its top-left in viewport CSS px and its CSS width; absent, the shot
   * is the viewport. `sweep: false` asks for the cheap pass, for cameras that
   * photograph one box many times a second.
   */
  async function maskedShot(
    base64: string,
    region?: ShotRegion,
    sweep = true,
  ): Promise<string> {
    const shot = tab?.masking?.shot;
    return shot === undefined ? base64 : await shot(base64, region, sweep);
  }

  /**
   * THIS TAB'S MAIN-FRAME NAVIGATION, while one is in flight, and how many
   * main-frame documents have committed. See {@link NAVIGATION_FREEZE_HOLD_MS}
   * for why a freeze command waits on the first and is corrected by the second.
   *
   * Keyed on `page.targetId`: a page target's main frame carries its target's
   * id, measured on the fleet 2026-09-25 (`frameStartedNavigating.frameId ===
   * targetId` for both main-frame navigations of the probe). A same-document
   * navigation holds nothing, so it is not one.
   */
  let mainNavigation: { readonly url: string } | undefined;
  let commits = 0;
  page.on('Page.frameStartedNavigating', (params) => {
    const kind = params['navigationType'];
    if (params['frameId'] !== page.targetId || kind === 'sameDocument' || kind === 'historySameDocument') {
      return;
    }
    mainNavigation = { url: typeof params['url'] === 'string' ? params['url'] : '' };
  });
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (typeof frame === 'object' && frame !== null && (frame as Record<string, unknown>)['parentId'] === undefined) {
      mainNavigation = undefined;
      commits += 1;
    }
  });
  page.on('Page.frameStoppedLoading', (params) => {
    if (params['frameId'] === page.targetId) {
      mainNavigation = undefined;
    }
  });

  /** What this tab's top frame shows, for the two readers below. */
  const topFrame = topFrameWatch(page);
  /** The PDF this tab is showing, when it shows one: see `./pdf-document.ts`. */
  const pdf = pdfDocuments(page, topFrame);
  /** The large plain-text file this tab is showing, when it shows one: see `./text-document.ts`. */
  const textFile = textDocuments(page, topFrame);

  /**
   * THE NAVIGATION THIS TAB WAS LEFT TO LOAD, and how many freeze holds have
   * expired on it ({@link StillLoadingError}). Matched by identity: every
   * main-frame navigation start is a new object, so a new navigation starts
   * the count again. See {@link LOADING_HOLDS_BEFORE_TURN}.
   */
  let leftToLoad: { readonly navigation: { readonly url: string }; holds: number } | undefined;
  /**
   * Whether the last `Outcrawl.lock` was answered by NOT freezing — a turn on
   * a tab still loading — so the unlock that pairs with it has nothing to
   * release, is not sent, and books no echo.
   */
  let unfrozenTurn = false;
  /**
   * How many times the LOOP asked this binding to release its freeze
   * (`unlock()`). A live window (`whileLive`) that sees this move handed the
   * freeze away while the page was live: the loop's `interrupt` releases it
   * to a human taking control and marks the lock lost, and from then on the
   * loop's hold owns re-freezing, after the human hands back. See
   * {@link whileLive}.
   */
  let loopReleases = 0;

  /**
   * `Outcrawl.lock` / `Outcrawl.unlock`, bounded. THE ONLY ROUTE either
   * command takes out of this binding.
   *
   * See {@link FREEZE_REPLY_DEADLINE_MS} for why a held reply is the shape of
   * this failure and why waiting the 30 s CDP deadline for it, four times in a
   * row, is what a customer's run actually paid on nordstrom.
   *
   * The command is NOT abandoned when the deadline passes: the renderer will
   * answer it eventually and that reply clears {@link heldFreezes}, which is
   * what lets a page that recovers be driven again. What ends here is only our
   * willingness to wait for it.
   *
   * `retaken` is set only on the fresh lock this sends itself after a lock
   * answered across a commit, so that retake happens once.
   *
   * `method` is `null` for a browser with no freeze ({@link CdpFlavor.lock}):
   * nothing is sent, no freeze is ever held, so there is no hold to release
   * and no echo to book.
   */
  async function sendFreeze(method: string | null, params?: Record<string, unknown>, retaken = false): Promise<void> {
    if (method === null) {
      return;
    }
    // THE RELEASE IS TOLD FIRST, before any of the reasons below not to send
    // it: whether or not a freeze was held, the caller is about to act on this
    // tab, and a replay screencast idled while it sat still has to be filming
    // before the action paints. See {@link ScreencastHold}.
    if (method === flavor.unlock) {
      tab?.recording?.held?.(false);
    }
    // Neither half is sent to the browser's own error page: see
    // {@link ERROR_PAGE_PREFIX} for what it did with them and why nothing is
    // lost by not asking. `url()` is the tab's last committed main-frame url,
    // read at the moment of sending, so a Reload that has already committed
    // the site is frozen as usual.
    if (page.url().startsWith(ERROR_PAGE_PREFIX)) {
      return;
    }
    // The release paired with a lock that froze nothing: nothing to send.
    if (method === flavor.unlock && unfrozenTurn) {
      unfrozenTurn = false;
      return;
    }
    /**
     * A TURN ON A TAB STILL LOADING. See {@link LOADING_HOLDS_BEFORE_TURN}:
     * the navigation this tab was left to load has now outlasted that many
     * holds, so the lock is answered by not freezing — the precedent is the
     * error page above — and the step reads the page the tab still shows,
     * live, and is told why. Nothing is sent, so nothing queues behind the
     * navigation.
     */
    if (
      method === flavor.lock &&
      leftToLoad !== undefined &&
      leftToLoad.navigation === mainNavigation &&
      leftToLoad.holds >= LOADING_HOLDS_BEFORE_TURN
    ) {
      unfrozenTurn = true;
      const notice =
        `The tab is still loading ${leftToLoad.navigation.url === '' ? 'a new page' : leftToLoad.navigation.url}, ` +
        `which has not arrived after ${((leftToLoad.holds * navigationHoldMs) / 1000).toFixed(0)} s. You are shown ` +
        `the page the tab still displays, and it is not frozen while it loads, so anything that touches it may ` +
        'wait for the load. Go back, go somewhere else, or stop if it will not load.';
      if (!pageEvents.includes(notice)) {
        pageEvents.push(notice);
      }
      return;
    }
    const outstanding = heldFreezes.get(page);
    if (outstanding !== undefined) {
      const silentFor = ((clock.now() - outstanding.sinceMs) / 1000).toFixed(1);
      throw new FreezeNotAnsweredError(
        `${method} was refused without being sent: the renderer of ${page.url()} has not answered ` +
          `${outstanding.method} for ${silentFor}s, and a freeze command sent now would queue ` +
          `behind it in that same renderer. The page is executing script and cannot be frozen.`,
        /*sent=*/ false,
      );
    }
    if (method === flavor.lock) {
      unfrozenTurn = false;
    }

    const startedMs = clock.now();
    const committedBefore = commits;
    let answered = false;
    let failure: unknown;
    /** Whether the reply is a lock answered across a commit. See the `finally` below. */
    let acrossCommit = false;
    /** Whether this call has already returned or thrown, so a reply now is one we gave up on. */
    let settled = false;
    const sent = page
      .send(method, params)
      .catch((cause: unknown) => {
        failure = cause;
      })
      .finally(() => {
        answered = true;
        /**
         * A LOCK ANSWERED ACROSS A COMMIT FROZE A PAGE NOBODY HOLDS. MEASURED
         * on the fleet 2026-09-25 (n=3 probes): a lock held behind a navigation
         * is answered right after `lockReleased{navigated}` and the commit, and
         * the new document is then paused with the browser's lock already gone
         * — a 100 ms timer did not fire in 3 s, and a wheel was neither acked
         * nor scrolled (scrollY 0) until an explicit `Outcrawl.unlock`, which
         * restored both at once. No echo is booked for that unlock: it emitted
         * no `lockReleased` in any of the three probes, because the browser
         * holds nothing to release.
         *
         * While this call is still waiting, the unlock and a fresh lock are
         * sent below, before it returns, so a lock that resolves is a freeze
         * that is held. A reply that arrives after this call gave up is
         * nobody's freeze: the pause is lifted HERE, before the held record is
         * cleared, so no freeze command of ours can be sent ahead of it.
         */
        acrossCommit =
          method === flavor.lock &&
          failure === undefined &&
          commits !== committedBefore &&
          !page.url().startsWith(ERROR_PAGE_PREFIX);
        if (acrossCommit && settled && flavor.unlock !== null) {
          void page.send(flavor.unlock).catch(() => undefined);
        }
        heldFreezes.delete(page);
      });
    // A reply that arrives after we stopped waiting must not become an
    // unhandled rejection; it is already captured above.
    void sent;

    try {
      /**
       * RACED, NEVER POLLED. The reply is a promise and the healthy case has to
       * cost nothing: a loop that checked a flag first would always miss it —
       * the flag is set in a `finally` microtask, three ticks after `send`
       * resolves — and would charge every lock and every unlock of every step
       * one interval for a command that had already answered.
       */
      await within(sent, replyDeadlineMs);

      /**
       * HELD BEHIND THIS TAB'S OWN NAVIGATION, NOT BY A BUSY RENDERER. The
       * reply comes with the commit, so it is waited for, up to
       * {@link NAVIGATION_FREEZE_HOLD_MS} from the send; a navigation still not
       * committed then is left to load, and the step is told so.
       */
      if (!answered && mainNavigation !== undefined) {
        await within(sent, navigationHoldMs - replyDeadlineMs);
        const loading = mainNavigation;
        if (!answered && loading !== undefined) {
          if (leftToLoad?.navigation === loading) {
            leftToLoad.holds += 1;
          } else {
            leftToLoad = { navigation: loading, holds: 1 };
          }
          throw new StillLoadingError(
            `${method} is waiting on this tab's own navigation: the tab is still loading ` +
              `${loading.url === '' ? 'a new page' : loading.url} after ` +
              `${(navigationHoldMs / 1000).toFixed(0)} s. It is left to load and nothing was stopped; the tab ` +
              `shows ${page.url()} until the new page commits, and the next step reads whichever page it is on then.`,
          );
        }
      }

      if (answered) {
        if (failure !== undefined) {
          throw failure;
        }
        if (acrossCommit) {
          await sendFreeze(flavor.unlock);
          // ONE retake. The navigation this lock waited on has committed, so a
          // fresh one is answered by the new document — unless the page
          // navigated yet again under it, which is a page still loading.
          if (retaken) {
            throw new StillLoadingError(
              `${method} was answered across two navigations in a row: the tab is still loading, now on ` +
                `${page.url()}. It is left to load, and the next step reads whichever page it is on then.`,
            );
          }
          await sendFreeze(method, params, /*retaken=*/ true);
        } else if (method === flavor.lock) {
          // A freeze the renderer answered and that holds: only this one is a
          // held tab. A lock refused, left to load or sent to the error page
          // froze nothing, and the retake above says it for itself.
          tab?.recording?.held?.(true);
        }
        return;
      }

      // THE PAGE LEFT FOR THE ERROR PAGE WHILE WE WAITED. The command went to the
      // site document the tab was showing when it was sent; the tab now shows
      // the browser's own error page instead, which is never frozen (see
      // {@link ERROR_PAGE_PREFIX}). So there is no freeze to take or release on
      // what the tab now shows, and nothing the next command would queue behind:
      // recording this one as held would refuse every later freeze on the tab,
      // including after the model navigates to a real page, for a reply
      // addressed to a document that is gone. Measured 2026-09-24,
      // run_f42d97f3-581e-4d2a-a20d-4a37ae8aa7f6 step 5: booking.com's renderer
      // had held Outcrawl.unlock for 25 s, the lock sent once it answered was
      // unanswered 5 s later with the tab on chrome-error://chromewebdata/, and
      // that third failed step in a row ended the run. Not measured: whether the
      // reply was lost with the old document or held by the error page's.
      if (page.url().startsWith(ERROR_PAGE_PREFIX)) {
        return;
      }
      heldFreezes.set(page, { method, sinceMs: startedMs });
      throw new FreezeNotAnsweredError(
        `${method} was not answered by the renderer of ${page.url()} within ` +
          `${String(replyDeadlineMs)}ms. The command is handled in the renderer, so a page ` +
          `busy executing script holds it rather than refusing it; the freeze this step needed does ` +
          `not exist and the page cannot be read under one.`,
        /*sent=*/ true,
      );
    } finally {
      settled = true;
    }
  }

  /**
   * Where this binding's last dispatched path left the pointer, PER SESSION.
   *
   * Per session and not one value for the whole tab, because a path
   * dispatched inside an out-of-process iframe (see `sessionFor` below) ends
   * in THAT frame's own coordinate space — see `dispatchGesture` for why
   * dispatch coordinates are frame-local there — which has nothing to do with
   * the main page's viewport a later action on `page` would compare it
   * against, and the reverse is equally wrong. One shared value would hand a
   * click on the main page a "from" point measured inside a 380px-wide
   * checkout iframe, or the other way round.
   */
  const pointerBySession = new WeakMap<CdpPage, { readonly x: number; readonly y: number }>();

  /**
   * Nodes a click PROVED the page keeps parked outside the viewport, by wire
   * reference: a scroll gesture did not move them, so no coordinate lands on
   * them. {@link snapshot} leaves each one out of the tree for as long as a
   * re-measure still finds it off-screen.
   *
   * The case is a Shopify "sticky add to bag" bar: a second, identically named
   * button fixed just below the bottom edge until the theme slides it in. The
   * accessibility tree offers it like any other button and the model cannot
   * tell it from the visible one. Measured on 6 Honey Birdette checkouts on
   * the production fleet, 2026-09-23: every run clicked it, 1 to 10 times, and
   * the run that spent 10 of its 40 steps on it had been told each time why it
   * failed. Those are steps a 40-credit checkout does not have. Leaving a node
   * out only after this binding failed to reach it is not a guess about
   * visibility; it is the result of trying.
   */
  const parked = new Map<string, NodeRef>();

  /**
   * How many times a click on each node has been refused as covered, by wire
   * reference, which names one element for as long as its renderer lives.
   * MEASURED 2026-09-26: `run_06b045f2` (ups.com) had the same click on one
   * option refused 7 times and ran out of its 40 steps, and `run_e3086fc2`
   * (phys.org) 4 times until the run stopped; every refusal read exactly like
   * the first, so nothing told the model it was repeating itself. See
   * {@link CoveredTargetError}.
   */
  const coveredRefusals = new Map<string, number>();

  /**
   * Nodes whose click was refused as covered a SECOND time, by wire
   * reference: {@link snapshot} leaves each one out of the tree for as long as
   * the same hit test that refused it ({@link paintedSample}) still finds
   * something else drawn over it at every sampled point of its on-screen part.
   * The first refusal names the cover and how to close it; after the second
   * the model is repeating a click that cannot land. MEASURED 2026-09-28
   * (production, 7 days): 43 of 194 covered-target steps repeated a refused
   * click, and `run_bc9b76c6` ended on its third refusal of one B&N link.
   * Closing the cover — `run_37d143f8`'s paywall had a "Skip for now" — puts
   * the node back.
   */
  const covered = new Map<string, NodeRef>();

  /**
   * This session's own frame ordinal, fetched once and INVALIDATED on every
   * top-level navigation of this tab's main frame — see the listener right
   * below for why "fetched once" alone was wrong.
   *
   * `FrameTreeNodeId` is never reused for the life of the process, which is
   * true and is not the fact that matters here: a top-level navigation —
   * including one this binding never called `perform({type:'navigate'})`
   * for, such as a form submit or a redirect a click triggered — commits a
   * NEW main frame with a NEW ordinal, so "read once, correct for the life
   * of the binding" held only for a tab that never navigated again after the
   * first read.
   *
   * MEASURED IN PRODUCTION, 2026-09-23/24, 27 occurrences across 9 runs of
   * "node F-N belongs to frame F, but this session is attached to frame M":
   * `run_fb37d4df` clicked frame 3013 three times without error, then a
   * FOURTH click — no explicit navigate in between — named frame 3046, 33
   * higher; `run_2e57f8dc` went stale after its own second `navigate`
   * action, frame 3005 to 3031. Both are the same fact: this binding's
   * cached ordinal stopped being this tab's CURRENT main frame, and every ref
   * the model wrote after that point — all of them genuinely naming this
   * tab's own document — was refused as though it belonged to a foreign
   * frame, because {@link sessionFor} had nothing but the stale value to
   * compare against. "Long-lived fleet browser" is why the ordinals are large
   * enough to be memorable in a log line, not why the drift happens; the
   * mechanism fires on the very first post-navigation ref on a browser of any
   * age, including a fresh one, which is why the fix is a cache invalidation
   * and not a range check.
   *
   * Invalidating rather than re-fetching reactively on every mismatch is what
   * keeps the untouched cases untouched: a ref that names a GENUINE
   * out-of-process iframe still mismatches `sessionFrame()` exactly once,
   * still costs exactly the one `Outcrawl.getFrameOrdinal` call the existing
   * tests pin, and still reaches {@link frameSession} unchanged — this
   * listener only ever clears a value that navigation has already made
   * wrong, so the next read (if any) is the only one ever charged for it.
   */
  let frameOrdinal: Promise<number> | undefined;
  /**
   * THIS TAB'S HOOKS, built once the tab's own state exists: what the host
   * adds to a bound page (see {@link BindingHooks}). Every member is optional
   * and its absence is the portable behaviour.
   */
  const tab: TabHooks | undefined = hooks.tab?.({
    page,
    clock,
    parsingSince: () => parsingSince,
    challengeAt: () => challengeAt,
    load: (target, load) => loadDocument(target, load),
    viewport,
    documentClip,
    contextFor,
    forward,
    pointers: pointerBySession,
    framePages: () => framePages,
    frameUrl: (frame) => frameUrls.get(frame),
    sessionFrame,
  });
  /**
   * AN ANSWER THE NETWORK WROTE IN THE SITE'S PLACE, never shown to the model.
   *
   * The tab's exit hook names a document its network answered instead of the
   * site (a forward proxy's refusal committed as the tab's document). When
   * one commits the tab is taken back to `about:blank`, every read of the
   * page waits for that ({@link scrubbed}), and the model is told OUR
   * sentence instead: `perform({type:'navigate'})` throws it as the step's
   * error, and any other navigation (a click, a form, a redirect) reports it
   * as a page event.
   */
  const watch = tab?.exits?.watch;
  /** The `about:blank` navigation replacing an exit-written document, while it runs. */
  let scrubbed: Promise<void> | undefined;
  /**
   * A `navigate` action in flight. Its refusal is THROWN as the step's error,
   * so the same sentence is not also queued as a page event for the next
   * prompt.
   */
  let navigating = false;
  /**
   * When the main frame's current document committed, while its
   * `DOMContentLoaded` has not fired yet; `undefined` otherwise. What
   * `document.parsing` answers from (see `DocumentProbe.parsing` in
   * `@outcrawl/runtime`): two events `Page.enable` already delivers, so the
   * page is asked nothing. A back/forward-cache restore fires no
   * `DOMContentLoaded` and parses nothing, so only a `Navigation` commit counts.
   */
  let parsingSince: number | undefined;
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (typeof frame === 'object' && frame !== null && (frame as Record<string, unknown>)['parentId'] === undefined) {
      parsingSince = params['type'] === 'Navigation' ? clock.now() : undefined;
    }
  });
  page.on('Page.domContentEventFired', () => {
    parsingSince = undefined;
  });
  /** When this tab last received anything; `DocumentProbe.lastNetworkAt`. */
  let lastNetworkAt: number | undefined;
  for (const method of flavor.networkEvents) {
    page.on(method, () => {
      lastNetworkAt = clock.now();
    });
  }
  /** The model filled or selected on the document now shown; cleared by a new one. */
  let formTouched = false;
  /**
   * When the browser last HELD something on this tab for a challenge
   * (`challengeSolving`: "emitted once per hold"), on the binding's clock. A
   * time, not a flag cleared by the next commit: a navigation hold is
   * announced BEFORE the commit of the document it holds, so a flag the
   * commit cleared never saw one (EgressReview, 2026-10-03). Not
   * `challengeDetected`, which fires when a vendor's script merely loaded.
   */
  let challengeAt: number | undefined;
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (isRecord(frame) && frame['parentId'] === undefined) formTouched = false;
  });
  if (flavor.challengeSolving !== null) {
    page.on(flavor.challengeSolving, () => {
      challengeAt = clock.now();
    });
  }
  // `{frame:{parentId,url}}` is `Page.frameNavigated`'s shape; `parentId`
  // absent is the main frame, exactly as the commit-tracker inside
  // `perform({type:'navigate'})` below reads the same event. A subframe's own
  // navigation is not a reason to forget what frame THIS tab is attached to.
  page.on('Page.frameNavigated', (params) => {
    const frame = params['frame'];
    if (typeof frame === 'object' && frame !== null && (frame as Record<string, unknown>)['parentId'] === undefined) {
      frameOrdinal = undefined;
      // The old document's frames went with it; see {@link tabFrames}.
      tabFrames = undefined;
      forgetFrameOwners();
      const committed = frame as Record<string, unknown>;
      const refusal = watch?.answerFor(committed, params['type']);
      if (refusal !== undefined) {
        scrubbed = page.send('Page.navigate', { url: 'about:blank' }).then(
          () => undefined,
          () => undefined,
        );
        if (!navigating) {
          pageEvents.push(
            `${refusal.message} What our exit answered instead of the site is not shown: the ` +
              'tab was cleared to about:blank.',
          );
        }
        return;
      }
      if (typeof committed['url'] === 'string' && committed['url'].startsWith(ERROR_PAGE_PREFIX)) {
        const wanted = committed['unreachableUrl'];
        const tunnel = typeof wanted === 'string' ? watch?.tunnelFor(wanted) : undefined;
        if (tunnel !== undefined) {
          if (!navigating) {
            pageEvents.push(
              `${tunnel.message} The tab is showing the browser's own error page, which is not ` +
                'the site, and retrying the same URL fails the same way.',
            );
          }
          return;
        }
        pageEvents.push(
          `The navigation${typeof wanted === 'string' ? ` to ${wanted}` : ''} FAILED: the site did ` +
            "not load, and the tab is showing the browser's own error page, which is not the " +
            'site. Retry by navigating to the same URL, or go somewhere else.',
        );
      }
    }
  });

  /**
   * What the page did by itself that the model has to be told, drained by
   * `AgentDeps.pageEvents` once per prompt. Two producers, both below: a
   * JavaScript dialog this binding answered, and a main-frame navigation that
   * committed the browser's own network-error page.
   */
  const pageEvents: string[] = [];

  /**
   * A JAVASCRIPT DIALOG IS ANSWERED, after the time a person takes to read it.
   *
   * `alert()`, `confirm()`, `prompt()` and `beforeunload` block the renderer's
   * main thread until somebody answers, and with the `Page` domain enabled —
   * which the tab set and the recorder both do — the browser waits for THIS
   * client to answer rather than answering itself. Nothing did, so the page
   * stayed blocked and every freeze command after it was held: measured in
   * production, 3 of 3 runs on the-internet.herokuapp.com/javascript_alerts
   * (run_9b23bfda, run_b25dff47, run_bd365d15, 2026-09-24) clicked "Click for
   * JS Alert" and then lost every later step to `Outcrawl.lock was not
   * answered`, 12 step errors in all.
   *
   * Accepted, because the dialog is the page asking to go ahead with the thing
   * the model's own action just started, and OK is the answer that does it; a
   * `prompt` keeps the page's own default text. The model is told what the
   * dialog said and what it was answered, so a task that needed Cancel can see
   * that it did not get it. The wait is a reading time, scaled to the message
   * and capped well inside {@link FREEZE_REPLY_DEADLINE_MS}, because a freeze
   * command sent while the dialog is open is queued behind it and must still
   * be answered inside its own deadline once the dialog closes.
   */
  page.on('Page.javascriptDialogOpening', (params) => {
    const type = typeof params['type'] === 'string' ? params['type'] : 'alert';
    const message = typeof params['message'] === 'string' ? params['message'] : '';
    const promptText = typeof params['defaultPrompt'] === 'string' ? params['defaultPrompt'] : '';
    const readMs = dialogReadMs(message);
    void (async () => {
      await clock.sleep(readMs);
      await page.send('Page.handleJavaScriptDialog', {
        accept: true,
        ...(type === 'prompt' ? { promptText } : {}),
      });
      pageEvents.push(
        `The page opened a JavaScript ${type} dialog saying ${JSON.stringify(message)}. It was ` +
          `answered OK${type === 'prompt' ? ` with ${JSON.stringify(promptText)}` : ''} after ` +
          `${String(readMs)} ms, because a dialog blocks the page until it is answered and ` +
          'OK carries on with what your last action started.',
      );
    })().catch((error: unknown) => {
      pageEvents.push(
        `The page opened a JavaScript ${type} dialog saying ${JSON.stringify(message)}, and ` +
          `answering it failed (${error instanceof Error ? error.message : String(error)}), so ` +
          'the page may still be blocked behind it.',
      );
    });
  });

  async function sessionFrame(): Promise<number> {
    frameOrdinal ??= flavor.frameOrdinal(page).then((result) => {
      const value = result['frameOrdinal'];
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new TypeError('Outcrawl.getFrameOrdinal returned no integer frameOrdinal');
      }
      return value;
    });
    return frameOrdinal;
  }

  /* ---------------------------------------------------------------- *
   * Out-of-process iframes of THIS tab
   *
   * `page` is one flat CDP session over the tab's MAIN frame. A ref whose
   * `frameOrdinal` names a different frame is not automatically another
   * tab's reference — Shopify-style checkouts put card fields in a
   * cross-origin iframe of the SAME tab, and under Site Isolation that
   * iframe is a different renderer process with its own CDP target. Sending
   * its `backendNodeId` to `page` would silently resolve against whatever
   * node happens to hold that id in the MAIN frame's renderer (see
   * `CrossFrameRefError`), so acting on it needs a session attached to THAT
   * frame, never `page`.
   *
   * `Target.setAutoAttach` sent on `page` scopes attachment to `page`'s own
   * target and its descendants — nothing on another tab ever answers it —
   * and fires `Target.attachedToTarget` for every OOPIF already on the page
   * at the moment it is armed, not only ones created afterwards. That
   * ordering is relied on rather than assumed: `CdpConnection#receive`
   * (`./cdp.ts`) resolves a command only after every event that arrived on
   * the wire before its reply has already reached this session's `on`
   * handlers — the same guarantee `proxy.ts` cites for `Target.createTarget`
   * — so registering the listener before awaiting `setAutoAttach` below is
   * enough to catch a frame that was already there.
   * ---------------------------------------------------------------- */

  /**
   * Sessions confirmed to own a frame ordinal, keyed by that ordinal. A
   * confirmation is a round trip, so once made it is kept for the life of
   * this binding — a frame ordinal never changes for a frame that is still
   * there, only the document inside it does.
   */
  const framePages = new Map<number, CdpPage>();

  /**
   * Each attached iframe session's URL as `Target.attachedToTarget` announced
   * it: which vendor's frame it is, for {@link fieldIdentity}. The frame's
   * first document; a payment vendor's frame does not navigate off its host.
   */
  const frameUrls = new WeakMap<CdpPage, string>();

  /** Attached sessions `Target.attachedToTarget` reported that no ref has asked for yet. */
  const unconfirmedFrames: CdpPage[] = [];

  /** Whether `Target.setAutoAttach` has been armed on `page`. Armed at most once, lazily. */
  let frameDiscovery: Promise<void> | undefined;

  /** Iframe sessions `Target.attachedToTarget` has delivered, and how many never answered `Outcrawl.getFrameOrdinal`. Reported in a refusal. */
  let attachedFrames = 0;
  let unansweredFrames = 0;

  function onTargetAttached(params: Record<string, unknown>): void {
    const sessionId = params['sessionId'];
    const info = params['targetInfo'];
    if (typeof sessionId !== 'string' || typeof info !== 'object' || info === null) {
      return;
    }
    const targetInfo = info as Record<string, unknown>;
    // Auto-attach also delivers dedicated workers, and a POPUP would arrive
    // as its own target if one existed here — neither is a frame a `NodeRef`
    // can ever name.
    const targetId = targetInfo['targetId'];
    if (targetInfo['type'] !== 'iframe' || typeof targetId !== 'string' || page.forSession === undefined) {
      return;
    }
    // CALLED ON `page`, NEVER DETACHED FROM IT. `CdpPageSession.forSession`
    // reads `this.#connection`, and the first version of this handler took
    // the method off `page` into a local and called that: it threw a
    // `TypeError` inside this event handler for every iframe the tab had, so
    // discovery recorded nothing and every refusal read "0 iframe session(s)
    // attached". Measured on the real Honey Birdette checkout through this
    // binding on the production binary, 2026-09-23 — the fix it was written to
    // ship had never once reached a frame in production.
    const framePage = page.forSession(sessionId, targetId);
    if (typeof targetInfo['url'] === 'string') frameUrls.set(framePage, targetInfo['url']);
    attachedFrames += 1;
    unconfirmedFrames.push(framePage);
    // Cascades discovery into this child's OWN descendants — a payment
    // iframe nested inside a wrapper iframe is a real checkout shape, and
    // Chromium versions differ on whether one `setAutoAttach` already
    // recurses on its own.
    //
    // THE LISTENER GOES ON THE CHILD, BEFORE ITS `setAutoAttach`. In flat
    // mode a descendant's `Target.attachedToTarget` is delivered on the
    // session that armed auto-attach for it -- this child's, not `page`'s --
    // so arming the cascade with only `page` listening attached grandchild
    // frames that nothing ever received. Registered first for the same
    // ordering reason `ensureFrameDiscovery` gives.
    framePage.on('Target.attachedToTarget', onTargetAttached);
    void framePage
      .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch(() => {
        // Cascading is a bonus for nested frames; this frame is still
        // confirmable and usable for its own ordinal without it.
      });
  }

  function ensureFrameDiscovery(): Promise<void> {
    frameDiscovery ??= (async () => {
      page.on('Target.attachedToTarget', onTargetAttached);
      await page.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    })();
    return frameDiscovery;
  }

  /**
   * The session that owns `wanted`, when it is an out-of-process iframe of
   * THIS tab — confirmed by asking the session itself with
   * `Outcrawl.getFrameOrdinal`, never assumed from attach order or from
   * `Target`'s own metadata. `undefined` when no attached session confirms
   * it, which is the honest answer both for a genuinely different tab's
   * reference and for a `CdpPage` with no `forSession` to give.
   */
  async function frameSession(wanted: number): Promise<CdpPage | undefined> {
    const known = framePages.get(wanted);
    if (known !== undefined) {
      return known;
    }
    if (page.forSession === undefined) {
      return undefined;
    }
    try {
      await ensureFrameDiscovery();
    } catch {
      // No worse than the refusal this ref would have gotten anyway: the
      // owning frame simply cannot be reached from here.
      return undefined;
    }
    while (unconfirmedFrames.length > 0) {
      const candidate = unconfirmedFrames.shift();
      if (candidate === undefined) {
        break;
      }
      let ordinal: number;
      try {
        const result = await flavor.frameOrdinal(candidate);
        const value = result['frameOrdinal'];
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          continue;
        }
        ordinal = value;
      } catch {
        // A session that will not answer cannot be confirmed as anything.
        unansweredFrames += 1;
        continue;
      }
      framePages.set(ordinal, candidate);
    }
    return framePages.get(wanted);
  }

  /* ---------------------------------------------------------------- *
   * IN-PROCESS iframes of THIS tab
   *
   * A SAME-SITE iframe has a frame ordinal of its own (every frame is a
   * `FrameTreeNode`, and `getAXTree` labels its nodes with that id) but NO
   * target of its own: it runs in its parent's renderer, so
   * `Target.setAutoAttach` never announces it and `frameSession` can never
   * confirm it. Before this, every ref inside one was refused as though it
   * belonged to another tab. Measured in production 2026-09-24, fleet
   * 54476fe6: PG3-datepicker `run_7a2b9340` step 4, 6 and 7, "node 29-1180
   * belongs to frame 29, but this session is attached to frame 28 ... 0
   * iframe session(s) attached" — the date field inside jqueryui.com's
   * same-origin demo frame, 0 of 3 runs able to touch it.
   *
   * Its backend node ids are ids in its PARENT's renderer, so the session
   * that resolves them correctly is the one attached to that renderer's
   * local root: `page` for a frame in the main renderer, or an out-of-process
   * iframe's own session for a frame nested in-process inside it. Handing
   * the id to any OTHER session is exactly the collision `CrossFrameRefError`
   * exists to refuse, so the owner is PROVEN, never guessed from the tree's
   * shape — a same-site frame inside a cross-site wrapper with no nodes of
   * its own (a payment field inside its vendor's frame) is emitted straight
   * under the top document's nodes, and nesting would name `page` for it.
   *
   * The proof uses only what the browser answers about frames:
   *
   * 1. `wanted` is a frame of THIS tab: the latest `getAXTree` on `page`
   *    walked it (`frameOrdinals`, which lists every frame that answered,
   *    kept nodes or not). A ref from another tab is still refused.
   * 2. `wanted` is not an out-of-process frame: `frameSession` has already
   *    drained every attached session, and auto-attach announces every
   *    local root below `page` before its reply — so a frame with no
   *    confirmed session of its own has none.
   * 3. Its local root is the DEEPEST confirmed out-of-process frame whose
   *    own `getAXTree` walked it (that command walks the session's frame and
   *    every frame below it), or `page` when none did. A live one that cannot
   *    answer leaves the question open, and an open question is a refusal.
   * ---------------------------------------------------------------- */

  /**
   * Every frame the latest `Outcrawl.getAXTree` on `page` walked, or
   * `undefined` when there is none to go on: before the first snapshot, after
   * a main-frame commit, or from a browser whose reply carries no
   * `frameOrdinals`.
   */
  let tabFrames: ReadonlySet<number> | undefined;

  /**
   * Per snapshot: the frames each confirmed out-of-process session's own
   * `getAXTree` walked (`null` when it could not answer), and the proven
   * owner of each in-process frame already resolved. Both describe ONE
   * snapshot's frame tree and are dropped with it.
   */
  const subtreeFrames = new Map<CdpPage, ReadonlySet<number> | null>();
  const inProcessOwners = new Map<number, CdpPage>();

  function forgetFrameOwners(): void {
    subtreeFrames.clear();
    inProcessOwners.clear();
  }

  async function framesBelow(session: CdpPage): Promise<ReadonlySet<number> | null> {
    try {
      return frameOrdinalsOf(await flavor.axTree(session, { maxNodes: SNAPSHOT_MAX_NODES })) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The session that owns in-process frame `wanted` — see the section note.
   * Call only after {@link frameSession} came back empty for the same ordinal:
   * that call is what drains discovery, which step 2 of the proof rests on.
   */
  async function inProcessSession(wanted: number): Promise<CdpPage | undefined> {
    if (tabFrames === undefined || !tabFrames.has(wanted)) {
      return undefined;
    }
    const known = inProcessOwners.get(wanted);
    if (known !== undefined) {
      return known;
    }
    let owner = page;
    let ownerFrames = Number.POSITIVE_INFINITY;
    for (const [ordinal, session] of framePages) {
      // A confirmed frame this tab no longer has owns nothing now.
      if (!tabFrames.has(ordinal)) {
        continue;
      }
      let below = subtreeFrames.get(session);
      if (below === undefined) {
        below = await framesBelow(session);
        subtreeFrames.set(session, below);
      }
      if (below === null) {
        return undefined;
      }
      if (below.has(wanted) && below.size < ownerFrames) {
        owner = session;
        ownerFrames = below.size;
      }
    }
    inProcessOwners.set(wanted, owner);
    return owner;
  }

  /**
   * The session and backend node id to act through for `ref`: `page` itself
   * for this session's own frame, a CONFIRMED out-of-process iframe of this
   * SAME TAB, or the proven local root of an in-process one (see
   * {@link inProcessSession}). Throws {@link CrossFrameRefError} exactly as
   * the old `backendNodeId` did when none can serve it, so `tabbedBinding`'s
   * existing wrong-tab diagnosis (`asTabRefusal`) is untouched: it only ever
   * sees a refusal this function could not resolve within this tab.
   */
  async function sessionFor(
    ref: NodeRef,
  ): Promise<{ readonly page: CdpPage; readonly backendNodeId: number }> {
    const own = await sessionFrame();
    if (ref.frameOrdinal === own) {
      return { page, backendNodeId: ref.backendNodeId };
    }
    const framePage = (await frameSession(ref.frameOrdinal)) ?? (await inProcessSession(ref.frameOrdinal));
    if (framePage === undefined) {
      throw new CrossFrameRefError(ref, own, {
        confirmed: [...framePages.keys()].sort((a, b) => a - b),
        attached: attachedFrames,
        unanswered: unansweredFrames,
      });
    }
    return { page: framePage, backendNodeId: ref.backendNodeId };
  }

  /**
   * THE INBOUND HALF OF THE SUBSTITUTION BOUNDARY. Every accessibility tree
   * this process produces passes through here, and a resolved secret value is
   * concealed back to its `{{secret:<handle>}}` placeholder before the tree is
   * handed to anything.
   *
   * One place, and it has to be this one. `capture()` reads the tree the model
   * is shown, `extract()` reads the tree the extraction model is shown,
   * `runtime/src/verify.ts` reads it to check a fill landed, and `tabbedBinding`
   * delegates every tab's snapshot to a `pageBinding` — so concealing here is
   * concealing in the prompt, the step trace, the event stream, the verdict,
   * the extracted data and the log line, with no second list to keep in step.
   *
   * A field that holds a secret is concealed by its IDENTITY, whatever it
   * reads: see `SecretVault.concealTree` and {@link fieldIdentity}.
   */
  function snapshot(): Promise<AxTree> {
    return observe(true);
  }

  /**
   * The tree, concealed or not. `conceal: false` is for THIS FILE's own reads
   * of an element it is driving — the options of a list a secret is being
   * chosen from, which a concealed tree drops with the field — and its result
   * must never be handed to a model, a step or a log.
   */
  async function observe(conceal: boolean): Promise<AxTree> {
    // Never a tree of what our exit wrote: see {@link scrubbed}.
    await scrubbed;
    // A large plain-text file is never handed to the tree, whose build on it
    // holds the renderer for minutes: see `./text-document.ts`.
    const large = await textFile.large();
    if (large !== undefined) {
      tabFrames = undefined;
      forgetFrameOwners();
      const shown = await textDocumentTree(large);
      const mask = conceal ? tab?.masking?.tree : undefined;
      return mask === undefined ? shown : await mask(shown);
    }
    // `maxNodes: SNAPSHOT_MAX_NODES` and not the fork's own default — see
    // that constant's own comment for the measurement and the reasoning.
    const reply = await flavor.axTree(page, { maxNodes: SNAPSHOT_MAX_NODES });
    const tree = axTreeFromCdp(reply);
    // Before `withoutParked`, which resolves refs through `sessionFor`.
    tabFrames = frameOrdinalsOf(reply);
    forgetFrameOwners();
    const resolved = await withEditableFields(await withNativeDateFields(await withRadioLabelsResolved(tree)));
    const shown = parked.size === 0 && covered.size === 0 ? resolved : await withoutParked(resolved);
    if (!conceal) return shown;
    // Before the mask, so a secret the PDF's title might hold is concealed too.
    const noted = await withPdfNotice(withoutUnpaintedText(shown));
    const mask = tab?.masking?.tree;
    return mask === undefined ? noted : await mask(noted);
  }

  /**
   * The tree of a large text document: its root, the line saying what it is,
   * and its opening window. Both lines carry the root's ref: they are text,
   * not controls. The root is the document node, by the same number the tree
   * would have given it (Blink's accessibility id is the DOM node id).
   */
  async function textDocumentTree(read: TextDocumentRead): Promise<AxTree> {
    const documentNode = (await page.send('DOM.getDocument', { depth: 0 }))['root'];
    const backendNodeId = isRecord(documentNode) ? documentNode['backendNodeId'] : undefined;
    if (typeof backendNodeId !== 'number') throw new TypeError('DOM.getDocument returned no backendNodeId for the document');
    const ref = nodeRef(await sessionFrame(), backendNodeId);
    return {
      url: read.url,
      root: {
        ref,
        role: 'RootWebArea',
        name: read.url,
        xpath: '',
        children: [
          { ref, role: 'StaticText', name: textDocumentNotice(read), xpath: '' },
          { ref, role: 'StaticText', name: textDocumentWindow(read), xpath: '' },
        ],
      },
    };
  }

  /**
   * `tree` with one line saying the tab shows a PDF and that `extract` reads
   * its text, as the root's first child, when the top document is a PDF.
   *
   * The tree of a PDF tab is the viewer's toolbar (`./pdf-document.ts`), and a
   * model shown only that concludes there is nothing to read: in one
   * production run (2026-10-13) the model said "the accessibility tree shows
   * only a sidebar toggle button" and never ran `extract` on the PDF it had
   * open at any of 14 decisions. The line carries the root's ref: it is text,
   * not a control, and names no element of its own.
   */
  async function withPdfNotice(tree: AxTree): Promise<AxTree> {
    const shown = await pdf.peek();
    if (shown === undefined) return tree;
    const notice: AxNode = { ref: tree.root.ref, role: 'StaticText', name: pdfNotice(shown.read), xpath: '' };
    return { ...tree, root: { ...tree.root, children: [notice, ...(tree.root.children ?? [])] } };
  }

  /**
   * `tree` with the first segment of each native date/time input marked
   * `nativeDate`, which the prompt renders as how to fill the whole value.
   *
   * The tree shows such an input only as its segments, "Hours Hours"="0" and
   * the rest, and nothing says one fill takes the whole time. MEASURED
   * 2026-10-13 on httpbin's pizza form (the hands model by role): of 10
   * form-fill runs, 9 sent the order with delivery "" (7 on stock Chromium, 2
   * on the fleet) and 1 failed on the blocked submit, after selecting "7" in
   * Hours, typing "7" there, or planning the segments and never filling them.
   *
   * Marked only where the element IS one of Blink's segments (its `pseudo`
   * attribute, read with `DOM.describeNode`; DevTools-side, page-invisible),
   * because a whole-value fill works only there (`nativeDatePlan`); an ARIA
   * widget whose parts happen to be named Hours or Month is left alone. One
   * read per input, only on a page that has segment-named spinbuttons.
   */
  async function withNativeDateFields(tree: AxTree): Promise<AxTree> {
    const marked = new Map<string, NativeDateKind>();
    for (const node of walk(tree)) {
      const children = node.children ?? [];
      for (const run of nativeDateRuns(children)) {
        const first = children[run.start];
        if (first === undefined || marked.size >= MAX_NATIVE_DATE_READS) continue;
        try {
          const { page: session, backendNodeId } = await sessionFor(first.ref);
          const pseudo = (await elementOf(session, backendNodeId))?.attribute('pseudo') ?? '';
          if (pseudo.startsWith('-webkit-datetime-edit-')) marked.set(formatNodeRef(first.ref), run.kind);
        } catch {
          // A segment this read cannot reach keeps its plain line.
        }
      }
    }
    if (marked.size === 0) return tree;
    const mark = (node: AxNode): AxNode => {
      const kind = marked.get(formatNodeRef(node.ref));
      const own = kind === undefined ? node : { ...node, state: { ...node.state, nativeDate: kind } };
      return own.children === undefined ? own : { ...own, children: own.children.map(mark) };
    };
    return { ...tree, root: mark(tree.root) };
  }

  /**
   * `tree` with a `textbox` for each editable region of the top document that
   * it shows no field for: see `EDITABLE_FIELDS`. Each goes where the region
   * is in the page — before the first of its own text the tree shows, else
   * after the text before it, else last — named as a person reads it, its text
   * as its value, so a fill is checked against what it holds.
   *
   * Blink maps a `contenteditable` with no role to `generic`, and the tree's
   * filter drops that role, so the model was shown a form's text and no field.
   * MEASURED: dev it-17.r1 (2026-10-14, live build), a contenteditable form
   * whose brief listed the submit button as its only element; the hands put
   * `fill email` on the text "Select country..." twice ("DOM.focus failed: Node
   * is not an Element", steps 2 and 13). BU Bench final run 27C: a Quill editor
   * shown only as its placeholder text, filled and clicked through a node that
   * no longer existed. Stock Chromium, 2026-10-14: that form's two editable
   * fields read `generic`, `editable: richtext`, and are absent from the tree.
   *
   * One look-world read per snapshot, page-invisible; two round trips on a
   * page with no `contenteditable`. Frames below the top document are not
   * read. The tree's root is this session's own frame, whose id is read once:
   * a tab's main frame keeps its id across navigations.
   */
  let topFrameId: string | undefined;
  async function withEditableFields(tree: AxTree): Promise<AxTree> {
    let listed: readonly (number | string | null)[] | undefined;
    try {
      if (topFrameId === undefined) {
        const top = (await page.send('Page.getFrameTree'))['frameTree'];
        const frame = typeof top === 'object' && top !== null && 'frame' in top ? top.frame : undefined;
        const id = typeof frame === 'object' && frame !== null && 'id' in frame ? frame.id : undefined;
        if (typeof id !== 'string' || id === '') return tree;
        topFrameId = id;
      }
      listed = await lookWorldList(page, topFrameId, EDITABLE_FIELDS);
    } catch {
      // A document this read cannot reach keeps the tree as the browser gave
      // it, and the frame is read again next time.
      topFrameId = undefined;
      return tree;
    }
    if (listed === undefined) return tree;
    const own = tree.root.ref.frameOrdinal;
    const shown = new Set(walk(tree).map((node) => formatNodeRef(node.ref)));
    const keyOf = (item: number | string | null | undefined): string | undefined => {
      if (typeof item !== 'number') return undefined;
      const key = formatNodeRef(nodeRef(own, item));
      return shown.has(key) ? key : undefined;
    };
    const before = new Map<string, AxNode[]>();
    const after = new Map<string, AxNode[]>();
    const last: AxNode[] = [];
    const add = (into: Map<string, AxNode[]>, key: string, field: AxNode): void => {
      into.set(key, [...(into.get(key) ?? []), field]);
    };
    for (let at = 0; at + EDITABLE_FIELD_WIDTH <= listed.length; at += EDITABLE_FIELD_WIDTH) {
      const [root, first, prior1, prior2, prior3, name, value, id] = listed.slice(at, at + EDITABLE_FIELD_WIDTH);
      // Already a field in the tree: a region with `role=textbox`, as Lexical
      // and Draft.js give theirs, is shown by the browser itself.
      if (typeof root !== 'number' || keyOf(root) !== undefined) continue;
      const field: AxNode = {
        ref: nodeRef(own, root),
        role: 'textbox',
        xpath: typeof id === 'string' && !id.includes('"') && id.length <= 200 ? `//*[@id="${id}"]` : '',
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
        ...(typeof value === 'string' && value !== '' ? { value } : {}),
      };
      const inside = keyOf(first);
      const prior = keyOf(prior1) ?? keyOf(prior2) ?? keyOf(prior3);
      if (inside !== undefined) add(before, inside, field);
      else if (prior !== undefined) add(after, prior, field);
      else last.push(field);
    }
    if (before.size === 0 && after.size === 0 && last.length === 0) return tree;
    const place = (node: AxNode): AxNode => {
      if (node.children === undefined) return node;
      const children: AxNode[] = [];
      for (const child of node.children) {
        const key = formatNodeRef(child.ref);
        children.push(...(before.get(key) ?? []), place(child), ...(after.get(key) ?? []));
      }
      return { ...node, children };
    };
    const placed = place(tree.root);
    return { ...tree, root: last.length === 0 ? placed : { ...placed, children: [...(placed.children ?? []), ...last] } };
  }

  /**
   * `tree` with every label node that reads `checked: 'mixed'` because it
   * labels a RADIO read as unchecked instead.
   *
   * Patch 0030 puts a labelled checkable `<input>`'s state on the label's text
   * nodes (a styled radio is often `display:none`, absent from the tree), as
   * `ShouldAppearIndeterminate() ? mixed : Checked()`. For a checkbox that is
   * its real indeterminate state. For a radio it means only that no radio in
   * its group is checked yet — Blink itself refuses to expose that as mixed on
   * the radio's own node. MEASURED 2026-10-03 01:08Z through production on
   * one machine (.56, Chrome/154, n=1): a lone unchecked hidden
   * radio's label read `mixed`; the unchecked one of a group with a checked
   * member read `false`; an indeterminate checkbox's label read `mixed`; a
   * visible radio and `role=radio aria-checked=mixed` both read `false` on the
   * radio's own node. So a model was shown an untouched radio as half-set.
   *
   * The label text alone cannot say which control it labels, so the control's
   * type is read: one look-world call per frame for all such nodes,
   * DevTools-side, page-invisible. A node whose control cannot be read (a
   * frame this world does not reach, a node gone) keeps the wire's word.
   */
  async function withRadioLabelsResolved(tree: AxTree): Promise<AxTree> {
    const byFrame = new Map<number, NodeRef[]>();
    let wanted = 0;
    for (const node of walk(tree)) {
      if (wanted >= MAX_MIXED_LABEL_READS) break;
      if (node.state?.checked !== 'mixed' || (node.role !== 'StaticText' && node.role !== 'LabelText')) continue;
      const group = byFrame.get(node.ref.frameOrdinal) ?? [];
      group.push(node.ref);
      byFrame.set(node.ref.frameOrdinal, group);
      wanted += 1;
    }
    if (wanted === 0) {
      return tree;
    }
    const radios = new Set<string>();
    for (const refs of byFrame.values()) {
      const [first, ...rest] = refs as [NodeRef, ...NodeRef[]];
      try {
        const { page: session } = await sessionFor(first);
        const frameId = await frameIdOf(session, first);
        if (frameId === undefined) continue;
        const types = await inLookWorld(session, frameId, {
          on: first.backendNodeId,
          declaration: LABELLED_CONTROL_TYPES,
          args: rest.map((ref) => ref.backendNodeId),
          returns: 'value',
        });
        if (!Array.isArray(types)) continue;
        refs.forEach((ref, index) => {
          if (types[index] === 'radio') radios.add(formatNodeRef(ref));
        });
      } catch {
        // The wire's word stands for a frame this read cannot reach.
      }
    }
    if (radios.size === 0) {
      return tree;
    }
    const unmix = (node: AxNode): AxNode => {
      const own =
        node.state !== undefined && radios.has(formatNodeRef(node.ref))
          ? { ...node, state: { ...node.state, checked: false } }
          : node;
      return own.children === undefined ? own : { ...own, children: own.children.map(unmix) };
    };
    return { ...tree, root: unmix(tree.root) };
  }

  /**
   * `tree` without the nodes in {@link parked} that are STILL off-screen, and
   * those in {@link covered} that are STILL covered.
   *
   * Each one is measured again rather than trusted from the click that failed:
   * a theme that slides its sticky bar in once the page scrolls makes the node
   * reachable, and it is offered again the moment its box has a hittable part
   * on screen. A covered node is offered again the moment the refusing hit
   * test finds it painted at one sampled point — the dialog over it was
   * closed — or finds no hittable part of it on screen to test. A node that
   * no longer resolves — the page navigated, the frame went away — is
   * forgotten, because there is nothing left to hide.
   */
  async function withoutParked(tree: AxTree): Promise<AxTree> {
    const hidden = new Set<string>();
    for (const [wire, ref] of parked) {
      try {
        const { page: session } = await sessionFor(ref);
        const shown = onScreenPart(await boxOf(ref), await viewport(session));
        if (shown.width >= MIN_HITTABLE_PX && shown.height >= MIN_HITTABLE_PX) {
          parked.delete(wire);
        } else {
          hidden.add(wire);
        }
      } catch {
        parked.delete(wire);
      }
    }
    for (const [wire, ref] of covered) {
      try {
        const { page: session } = await sessionFor(ref);
        const shown = onScreenPart(await boxOf(ref), await viewport(session));
        if (
          shown.width >= MIN_HITTABLE_PX &&
          shown.height >= MIN_HITTABLE_PX &&
          (await paintedSample(session, shown, painterOf(session, ref))) === undefined
        ) {
          hidden.add(wire);
        } else {
          covered.delete(wire);
        }
      } catch {
        covered.delete(wire);
      }
    }
    if (hidden.size === 0) {
      return tree;
    }
    const prune = (node: AxNode): AxNode =>
      node.children === undefined
        ? node
        : {
            ...node,
            children: node.children
              .filter((child) => !hidden.has(formatNodeRef(child.ref)))
              .map(prune),
          };
    return { ...tree, root: prune(tree.root) };
  }

  /**
   * The hands port, or the refusal. One helper because five actions need it and
   * each of them must refuse BEFORE its first round trip.
   */
  function requireHands(action: string): HandsPort {
    const hands = options.hands;
    if (hands === undefined) {
      throw new HandsUnavailableError(action);
    }
    return hands;
  }

  /** {@link sendUntilForwarded} on `target`, on this binding's gesture clock. */
  async function forward(step: HandsStep, target: CdpPage): Promise<void> {
    await sendUntilForwarded(step, (sent) => flavor.dispatch(target, sent), clock);
  }

  /**
   * Drops the freeze, dispatches the plan on the plan's own timing, retakes.
   *
   * The release is the only way input reaches the renderer at all, and that is
   * true of KEYSTROKES as well as paths — which is why `press` and `fill` come
   * through here now instead of sending `Input` directly. The two path commands
   * at least refuse while the lock is held. Stock `Input.dispatchKeyEvent` does
   * not: the lock's `ScopedIgnoreInputEvents` makes
   * `WebContentsImpl::ShouldIgnoreWebInputEvents` return true
   * (`web_contents_impl.cc:10971`) and the event is dropped before it reaches
   * the renderer (`render_widget_host_impl.cc:1635`) while **the command still
   * reports success** — the fork's own PDL says so at patch line 8199, which is
   * why the fork's commands were given an explicit refusal and the stock ones
   * were not. So every `press` this binding has ever done was dispatched into a
   * frozen page and silently discarded, and `perform` runs inside `withLock`
   * (`loop.ts:698`), so it was frozen every time.
   *
   * The retake happens on the failure path too, because the frame above this
   * one is entitled to the freeze it started the step with whether or not the
   * gesture landed.
   *
   * A long `fill` holds the page live for seconds rather than milliseconds, and
   * that is inherent: nobody can type into a frozen page. It is the same
   * exposure the pointer path already accepts, for longer, and a lock the
   * browser takes away meanwhile arrives through `bindLockReleases`.
   *
   * **A refused event is resent until the browser takes it.** See
   * {@link sendUntilForwarded}. A dropped keystroke used to be reported as a
   * success, so a 17-character `fill` could leave 16 characters in the field
   * and nothing anywhere said so; the browser now refuses, and this is the
   * frame that answers the refusal.
   *
   * ── `target`, AND WHY THE DISPATCH ITSELF IS NEVER UNCONDITIONALLY `page` ──
   *
   * The freeze above IS unconditionally `page`, and that is correct rather
   * than an oversight: `Outcrawl.lock`'s guard is a
   * `WebContents::ScopedIgnoreInputEvents` (`0010-tenancy.patch`), and a
   * `WebContents` is the whole TAB — every frame's `RenderWidgetHostImpl`,
   * main or out-of-process, is refused input while it is held, whichever
   * session sends the command. One freeze taken on `page` already covers a
   * dispatch on any other session of this same tab.
   *
   * The DISPATCH is `target` because `Outcrawl.dispatchPointerPath` and
   * `Outcrawl.dispatchWheelPath` are delivered to the SENDING SESSION's own
   * attached widget rather than hit-tested down to it — measured in
   * `packages/captcha/src/agentic/cdp-widget.ts`: 90 pointer-path samples
   * sent on the embedder's session with capturing listeners inside a live
   * cross-origin hCaptcha frame, zero of them observed inside the frame.
   * Stock `Input.dispatchMouseEvent` does not share that limit and reaches an
   * out-of-process iframe from the embedder's own session — same file, the
   * working half of the same measurement — but this fork's own PDL for
   * `dispatchPointerPath` says it "enters at
   * `RenderWidgetHostImpl::ForwardMouseEvent`, the same entry point
   * `Input.dispatchMouseEvent` uses" (`0010-tenancy.patch`), so a session
   * that lacks whatever makes the stock command's hit test work cannot be
   * trusted for either command once one plan is allowed to mix them — and
   * every plan `agenthands` returns does. So every step of one plan goes out
   * on the SAME session `sessionFor` resolved for the ref that plan is
   * aiming at, never the main session with a page-composed coordinate.
   *
   * `target`'s coordinates are therefore FRAME-LOCAL when it is an
   * out-of-process iframe's own session, exactly as `boxOf` already reads
   * them: `DOM.getBoxModel` is answered by the renderer `target` is attached
   * to, and a renderer under Site Isolation has no idea it is embedded in
   * anything — so reading a box on `target` and dispatching to the same
   * `target` describe one origin without this binding ever composing an
   * iframe's own offset into the top document's. NOT MEASURED against a real
   * out-of-process frame in this change — no browser may be launched from
   * here — so this is the smallest mechanism consistent with everything
   * above, not a second thing independently confirmed; that confirmation is
   * what the fleet verification this ships behind is for.
   */
  async function dispatchGesture(plan: readonly HandsStep[], target: CdpPage, drag?: Html5DragArm): Promise<void> {
    if (plan.length === 0) {
      throw new RangeError('agenthands returned an empty plan: nothing would be dispatched');
    }

    await whileLive(async () => {
      // Where a button went down that has not come up yet. A plan that dies
      // between its press and its release — a drag whose held path the page
      // navigated out from under — leaves a press with no release: the page
      // saw `mousedown` and would never see its `mouseup`. A hand lets go; so
      // does this, at wherever the pointer last was, once, and the release's
      // own failure is not allowed to replace the error that explains the step.
      let pressed: { readonly x: number; readonly y: number } | undefined;
      /** An HTML5 drag the page started and that has not been dropped yet. See `Html5DragArm`. */
      let dragging: unknown;
      const send = async (step: HandsStep): Promise<void> => {
        if (step.delayMs !== undefined && step.delayMs > 0) {
          await clock.sleep(step.delayMs);
        }
        await forward(step, target);
        if (step.command === 'Outcrawl.dispatchPointerPath') {
          const last = step.params.path[step.params.path.length - 1];
          if (last !== undefined) {
            pointerBySession.set(target, { x: last.x, y: last.y });
          }
          // The replay records this path from the browser's own
          // `Outcrawl.sessionPointer`, which names this session as the
          // injector, so nothing is written down here.
        } else if (step.command === 'Input.dispatchMouseEvent') {
          pointerBySession.set(target, { x: step.params.x, y: step.params.y });
          pressed = step.params.type === 'mousePressed' ? { x: step.params.x, y: step.params.y } : undefined;
        }
      };
      try {
        if (drag === undefined) {
          for (const step of plan) await send(step);
          return;
        }
        // Up to the press, then the held path only as far as the drag
        // threshold: the move that crosses it is the one a page's HTML5 drag
        // starts on.
        for (const step of plan.slice(0, drag.pressAt + 1)) await send(step);
        await send(drag.lift);
        await Promise.race([drag.started, clock.sleep(DRAG_START_WAIT_MS)]);
        const data = drag.intercepted();
        if (data === undefined) {
          // No HTML5 drag: a slider, a canvas, a pointer-driven sortable list.
          // The rest of the held path and the release, as planned.
          for (const step of [drag.carry, ...plan.slice(drag.pressAt + 2)]) await send(step);
          return;
        }
        // The page started an HTML5 drag, and the renderer now ignores mouse
        // input until it ends (`WebFrameWidgetImpl::HandleInputEvent`
        // suppresses it while `doing_drag_and_drop_`). It is carried the way
        // the browser carries a real one: drag updates along the same path at
        // the same pace, then the drop, with the page's own drag data back.
        dragging = data;
        pressed = undefined;
        const event = async (type: 'dragEnter' | 'dragOver' | 'drop', at: PointerSample): Promise<void> => {
          await target.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data, modifiers: 0 });
          pointerBySession.set(target, { x: at.x, y: at.y });
        };
        const from = drag.lift.params.path[drag.lift.params.path.length - 1];
        const path = drag.carry.params.path;
        const end = path[path.length - 1];
        if (from === undefined || end === undefined) throw new RangeError('agenthands returned an empty drag path');
        await event('dragEnter', from);
        await clock.sleep(drag.carry.delayMs ?? 0);
        let at = 0;
        for (const sample of path.slice(0, -1)) {
          if (sample.offsetMs - at < DRAG_OVER_INTERVAL_MS) continue;
          await clock.sleep(sample.offsetMs - at);
          at = sample.offsetMs;
          await event('dragOver', sample);
        }
        await clock.sleep(Math.max(0, end.offsetMs - at));
        // The drop ends the drag for both sides (`DragTargetDrop`, then
        // `DragSourceEndedAt`, which fires `dragend`). No `mouseup` follows: a
        // page never sees one after a real HTML5 drag, whose release the
        // drag itself consumes.
        await event('drop', end);
        dragging = undefined;
      } catch (error) {
        if (dragging !== undefined) {
          // Ended the way a drag the user abandons ends: `dragleave` on the
          // target and `dragend` with no drop on the source.
          const at = pointerBySession.get(target) ?? { x: 0, y: 0 };
          await target
            .send('Input.dispatchDragEvent', { type: 'dragCancel', x: at.x, y: at.y, data: dragging, modifiers: 0 })
            .catch(() => undefined);
        } else if (pressed !== undefined) {
          const at = pointerBySession.get(target) ?? pressed;
          const letGo = target
            .send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: at.x,
              y: at.y,
              button: 'left',
              buttons: 0,
              clickCount: 1,
            })
            .catch(() => undefined);
          // SENT, BUT NOT WAITED FOR PAST A MOMENT when the event that failed
          // was never answered: the renderer that did not acknowledge this
          // plan's own input will not acknowledge its release inside the
          // deadline either. Production 2026-10-04, IW19 run_6772e5fa (figma
          // third-party sign-in button, n=1): 60.6 s from the dispatch's
          // irreversible mark (17:46:48.335Z) to the step record, which is two
          // 30 s deadlines — the plan's release, then this one (derived from
          // the timings, not separately logged) — while the popup the click
          // opened had been adopted as t1 0.64 s after the dispatch.
          if (isCdpTimeout(error, 'Input.dispatchMouseEvent')) {
            await Promise.race([letGo, clock.sleep(UNANSWERED_RELEASE_WAIT_MS)]);
          } else {
            await letGo;
          }
        }
        throw error;
      }
    });
  }

  /**
   * A `drag`, as an HTML5 drag when the page starts one and as the plain
   * pointer gesture it always was when it does not. Decided by the page, not
   * by a rule about it: the browser is asked to hand over any drag the page
   * starts (`Input.setInterceptDrags`, browser-side, invisible to the page),
   * and `Input.dragIntercepted` arriving is the page having started one.
   *
   * WHY. Production 0b2e01ad, IW7 (2026-10-05 00:14-00:18Z, n=3, 0 pass;
   * the-internet /drag_and_drop, 16 drags in 10 calls, 0 swaps on a fully
   * rendered page): the page swaps on HTML5 `drop`, and the held path goes
   * out on `Outcrawl.dispatchPointerPath`, which enters at
   * `RenderWidgetHostImpl::ForwardMouseEvent` and so never reaches the
   * DevTools `InputHandler::DragController` that carries a drag begun by
   * `Input.dispatchMouseEvent`. Upstream `InputHandler::StartDragging`
   * (content/browser/devtools/protocol/input_handler.cc, read 2026-10-05 from
   * chromium main) finds the CDP press but no CDP move, cancels the drag, and
   * reports it intercepted, so no OS drag starts either: the page saw
   * `dragstart` and never a `drop`. That reading is of upstream source, not
   * of the shipped binary.
   *
   * ON THIS TAB'S OWN PAGE ONLY. `Input.dispatchDragEvent` is positioned in
   * the main frame's viewport, and a drag whose ends are inside an
   * out-of-process frame is dispatched on that frame's session in its own
   * coordinates; it keeps the plain gesture.
   */
  async function dispatchDrag(plan: readonly HandsStep[], target: CdpPage): Promise<void> {
    const pressAt = plan.findIndex((step) => step.command === 'Input.dispatchMouseEvent' && step.params.type === 'mousePressed');
    const held = plan[pressAt + 1];
    const split = target === page && pressAt >= 0 && held?.command === 'Outcrawl.dispatchPointerPath' ? liftOf(held) : undefined;
    if (split === undefined) {
      await dispatchGesture(plan, target);
      return;
    }
    let data: unknown;
    const started = Promise.withResolvers<void>();
    const off = target.on('Input.dragIntercepted', (params) => {
      data = params['data'];
      started.resolve();
    });
    try {
      await target.send('Input.setInterceptDrags', { enabled: true });
      await dispatchGesture(plan, target, { pressAt, ...split, started: started.promise, intercepted: () => data });
    } finally {
      off();
      await target.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    }
  }

  /**
   * Drops this tab's freeze, runs `body` on the live page, and retakes the
   * freeze whether or not `body` succeeded — the frame above is entitled to
   * the freeze it started the step with. The one shape both input and a wait
   * for the page to react take; see {@link dispatchGesture} for why input
   * cannot reach a frozen page at all.
   */
  async function whileLive(body: () => Promise<void>): Promise<void> {
    // No release is sent to the error page, after a lock that froze nothing
    // (see `sendFreeze`), or by a browser with no freeze at all, so none is
    // booked: an echo booked for a command that never went out would swallow
    // the next real loss.
    const owed = selfReleases.get(page) ?? { owed: 0 };
    selfReleases.set(page, owed);
    if (flavor.unlock !== null && !page.url().startsWith(ERROR_PAGE_PREFIX) && !unfrozenTurn) {
      owed.owed += 1;
    }
    try {
      await sendFreeze(flavor.unlock);
    } catch (error) {
      // Unbooked ONLY when the command never reached the wire. A command that
      // went out already ran its browser half — the input guard is down and
      // `lockReleased{explicit}` has been emitted — so the echo is genuinely
      // owed even though the renderer never answered, and taking the booking
      // back would let that echo reach the session as a lost lock this
      // binding caused itself. A command refused before the wire emitted
      // nothing, and leaving its booking standing would swallow the next real
      // loss instead.
      if (error instanceof FreezeNotAnsweredError && !error.sent) {
        owed.owed -= 1;
      }
      throw error;
    }

    const releasesBefore = loopReleases;
    try {
      await body();
    } finally {
      // NEVER RE-FREEZE A PAGE A HUMAN NOW DRIVES. If the loop released the
      // freeze while this window was open (a take of control mid-wait, mid-
      // gesture), the page belongs to the human until they hand back, and the
      // loop retakes then. Re-locking here froze the page under the human:
      // measured 2026-09-28 on sess_f45606ef, 388 of 411 inputs refused with
      // "This session holds an action lock" for 65 s after an agent `wait`.
      if (loopReleases === releasesBefore) await sendFreeze(flavor.lock, lockParams);
    }
  }

  /**
   * `DOM.getBoxModel`, on the session that owns `ref` — `page` for this
   * session's own frame, or a confirmed out-of-process iframe of this tab.
   * The box comes back in THAT SESSION's own viewport coordinates: frame-
   * local when it is an iframe's session, because `DOM.getBoxModel` is
   * answered by the renderer the session is attached to, and a renderer
   * under Site Isolation has no idea it is embedded in anything. See
   * `dispatchGesture` for why every later read and every dispatch for this
   * same `ref` stays on that same session rather than composing this box
   * against the top document's own coordinates.
   */
  async function boxOf(ref: NodeRef): Promise<HandsTarget> {
    const { page: target, backendNodeId: id } = await sessionFor(ref);
    let model: Record<string, unknown>;
    try {
      model = await target.send('DOM.getBoxModel', { backendNodeId: id });
    } catch (error) {
      // The two `-32000` refusals, by the browser's own wording, as the
      // outcomes they are. Anything else — a closed socket, a timeout — is
      // not a fact about the node and propagates unchanged.
      const said = error instanceof Error ? error.message : '';
      if (said.includes('Could not compute box model')) {
        throw new UnmeasurableTargetError('this action', ref, 'not-rendered');
      }
      if (said.includes('No node found for given backend id')) {
        throw new UnmeasurableTargetError('this action', ref, 'replaced');
      }
      throw error;
    }
    return boxFrom(model);
  }

  /**
   * The box once the scroll it was asked for has come to rest.
   *
   * `dispatchWheelPath` returns when the last sample has gone OUT, and the
   * scroll it causes is applied by the compositor over the frames after that —
   * with `scroll-behavior: smooth` in play, over several hundred milliseconds.
   * A box read the instant the command resolves is therefore stale by however
   * much scrolling is still in flight, which is the original defect displaced
   * by one step rather than fixed. So this reads until two consecutive reads
   * agree, which is the page's own statement that it has stopped moving.
   */
  async function boxAtRest(ref: NodeRef): Promise<HandsTarget> {
    let previous = await boxOf(ref);
    const deadline = clock.now() + SCROLL_REST_TIMEOUT_MS;
    while (clock.now() < deadline) {
      await clock.sleep(SCROLL_REST_POLL_MS);
      const current = await boxOf(ref);
      if (Math.abs(current.y - previous.y) < REST_EPSILON_PX && Math.abs(current.x - previous.x) < REST_EPSILON_PX) {
        return current;
      }
      previous = current;
    }
    return previous;
  }

  /** `session`'s last pointer position, but only while it is somewhere a hand could be. */
  function contextFor(
    view: { readonly width: number; readonly height: number },
    session: CdpPage,
  ): HandsContext {
    const from = pointerBySession.get(session);
    const usable =
      from !== undefined && from.x >= 0 && from.y >= 0 && from.x < view.width && from.y < view.height;
    return { viewport: view, ...(usable ? { from } : {}) };
  }

  /**
   * Whether what is PAINTED at the centre of `visible` belongs to `ref`: the
   * hit is `ref`, one of the descendants `subtree` already lists, or has
   * `ref` among its ancestors. `DOM.getBoxModel` is a LAYOUT box — Chromium
   * reads the border box with no clip, visibility or occlusion test — so a
   * child clipped by `height:0;overflow:hidden` or `visibility:hidden` has
   * one, and aiming at it would land the input on whatever is really there.
   */
  async function paintsInside(
    session: CdpPage,
    ref: NodeRef,
    subtree: ReadonlySet<number>,
    visible: HandsTarget,
  ): Promise<boolean> {
    const hit = await hitAt(session, { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 });
    if (hit === undefined) return false;
    if (hit.backendNodeId === ref.backendNodeId || subtree.has(hit.backendNodeId)) return true;
    return (await ancestorsOf(session, hit.backendNodeId, hit.frameId)).includes(ref.backendNodeId);
  }

  /**
   * The outermost element inside `ref` that has a box and is actually what is
   * painted there, breadth first, or `undefined`.
   *
   * DevTools reads only — `DOM.describeNode` for the subtree's backend ids,
   * `DOM.getBoxModel` per element, and a hit test ({@link paintsInside}) —
   * so the page sees nothing. Every candidate is considered before one is
   * chosen, and a VERIFIED on-screen one wins: a candidate on screen that the
   * hit test does not confirm is skipped. Only when none is confirmed does a
   * candidate below or above the fold come back, `verified: false`, to be
   * confirmed once scrolled into view — and only one that overlaps the
   * viewport HORIZONTALLY, because a vertical wheel is all this path has and
   * a box parked off to the side (`left:-9999px`, a sr-only label) is never
   * brought on screen by it; aiming at one would spend a wheel gesture for
   * nothing. Bounded by {@link PAINTED_DESCENDANT_DEPTH} and
   * {@link PAINTED_DESCENDANT_READS}.
   *
   * Same frame and same session as `ref` by construction: a descendant lives
   * in its ancestor's document, so its backend id is in the same renderer.
   */
  async function paintedDescendant(
    session: CdpPage,
    ref: NodeRef,
    view: { readonly width: number; readonly height: number },
  ): Promise<
    | {
        readonly ref: NodeRef;
        readonly box: HandsTarget;
        readonly verified: boolean;
        readonly subtree: ReadonlySet<number>;
      }
    | undefined
  > {
    let described: Record<string, unknown>;
    try {
      described = await session.send('DOM.describeNode', {
        backendNodeId: ref.backendNodeId,
        depth: PAINTED_DESCENDANT_DEPTH,
      });
    } catch {
      return undefined;
    }
    const childrenOf = (node: unknown): unknown[] =>
      typeof node === 'object' && node !== null && 'children' in node && Array.isArray(node.children)
        ? node.children
        : [];
    // Elements only: a text node's box is its parent's line, and the parent
    // is listed ahead of it.
    const elements: number[] = [];
    const queue = childrenOf(described['node']);
    while (queue.length > 0) {
      const node = queue.shift();
      if (typeof node !== 'object' || node === null) continue;
      queue.push(...childrenOf(node));
      if ('nodeType' in node && node.nodeType === 1 && 'backendNodeId' in node && typeof node.backendNodeId === 'number') {
        elements.push(node.backendNodeId);
      }
    }
    const subtree: ReadonlySet<number> = new Set(elements);
    let fallback: { readonly ref: NodeRef; readonly box: HandsTarget } | undefined;
    for (const id of elements.slice(0, PAINTED_DESCENDANT_READS)) {
      const child = nodeRef(ref.frameOrdinal, id);
      let box: HandsTarget;
      try {
        box = await boxOf(child);
      } catch (error) {
        // An unrendered child (`display: none`) is a normal answer here; any
        // other failure is not a fact about the node and propagates.
        if (!(error instanceof UnmeasurableTargetError)) throw error;
        continue;
      }
      if (box.width < MIN_HITTABLE_PX || box.height < MIN_HITTABLE_PX) continue;
      const visible = onScreenPart(box, view);
      if (visible.width >= MIN_HITTABLE_PX && visible.height >= MIN_HITTABLE_PX) {
        if (await paintsInside(session, ref, subtree, visible)) {
          return { ref: child, box, verified: true, subtree };
        }
        continue;
      }
      const across = Math.min(box.x + box.width, view.width) - Math.max(box.x, 0);
      if (fallback === undefined && across >= MIN_HITTABLE_PX) {
        fallback = { ref: child, box };
      }
    }
    return fallback === undefined ? undefined : { ...fallback, verified: false, subtree };
  }

  /**
   * Leaves `ref` out of later snapshots while it stays off-screen — but only
   * when `ref` itself is what was aimed at — and says which it did.
   * `withoutParked` re-measures the PARKED ref's own box, and a zero-area
   * target aimed through a descendant has no box of its own at any scroll
   * offset, so parking it would remove it from every later snapshot for good.
   */
  function park(ref: NodeRef, aim: NodeRef): string {
    if (aim !== ref) {
      return 'it stays in the page you are shown';
    }
    parked.set(formatNodeRef(ref), ref);
    return 'it is left out of the page you are shown for as long as it stays off-screen';
  }

  /**
   * Leaves `ref` out of later snapshots while it stays covered, on
   * {@link park}'s terms: only when `ref` itself is what was aimed at,
   * because `withoutParked` hit-tests the PARKED ref's own box. Says which it
   * did.
   */
  function parkCovered(ref: NodeRef, aim: NodeRef): string {
    if (aim !== ref) {
      return 'it stays in the page you are shown';
    }
    covered.set(formatNodeRef(ref), ref);
    return 'it is left out of the page you are shown for as long as something stays drawn over it';
  }

  /**
   * Bring the node on screen, then measure it AGAIN, and return the rect to
   * aim inside.
   *
   * ── Why the box is re-read after every scroll ───────────────────────────────
   *
   * A box measured before a scroll is stale by exactly the scroll delta. Aiming
   * with it would move the miss rather than remove it.
   *
   * ── Why the scroll goes through `hands` ─────────────────────────────────────
   *
   * Scrolling is an OBSERVABLE ACT: it is dispatched into the page, it is
   * recorded, and a person genuinely does scroll before clicking something
   * below the fold — so doing it makes the session more human-like, not less,
   * PROVIDED it is done the way the rest of this file does input.
   * `AgentHandsPort.scroll` emits `Outcrawl.dispatchWheelPath` with a generated
   * wheel path and prepends an approach stroke when the anchor is not where the
   * cursor already is, so the page sees a cursor arrive and then a real
   * multi-event gesture with `deltaY`/`wheelDeltaY` agreeing by construction.
   * A `Runtime.evaluate` of `scrollIntoView()` would have been one line and is
   * refused for the reason this whole file exists: it needs `Runtime.enable`,
   * which `docs/specs/2026-08-29-system-scope.md:96` records as a detection
   * surface, and it produces a scroll with no wheel events at all — a page that
   * moves under a cursor that never touched it.
   *
   * The anchor is deliberately NOT the target: `AgentHandsPort.#scrollAt` puts
   * the wheel over `request.target`'s centre when one is given, and the centre
   * of an off-screen target is off-screen, which is the very thing being fixed.
   * With no target it lands at the cursor, or at the viewport centre — always
   * on the page.
   */
  async function aimInsideViewport(
    action: 'click' | 'hover' | 'scroll' | 'drag',
    ref: NodeRef,
    hands: HandsPort,
  ): Promise<{
    readonly target: HandsTarget;
    readonly context: HandsContext;
    readonly session: CdpPage;
    /** What `target` is the box of: `ref`, or the painted descendant a zero-area `ref` is aimed through. */
    readonly aim: NodeRef;
    /** Wheel gestures sent to get here: 0 when the node was measured on screen already. */
    readonly gestures: number;
  }> {
    // The box FIRST, and the viewport after: `boxOf` resolves the reference,
    // so a cross-frame ref is refused before this path has spent a round trip
    // on a page the caller then cannot use. Same rule as `requireHands`.
    //
    // `sessionFor` resolved a second time here rather than threaded out of
    // `boxOf`: once `frameSession` has confirmed an ordinal it is a `Map`
    // lookup, so the repeat costs nothing this loop would otherwise have to
    // plumb `boxOf`'s return shape to avoid.
    const { page: session } = await sessionFor(ref);
    let box = await boxOf(ref);
    let view = await viewport(session);
    // A ZERO-AREA BOX IS AIMED THROUGH WHAT IT PAINTS, when it paints anything.
    // An inline `<a>` whose only child is absolutely positioned has a 0x0 box
    // of its own and a real one a level down, and a person clicking it clicks
    // that child: the events land on the child and bubble to the link, and
    // `:hover` holds on every ancestor. Measured on IW11-hover, `run_f38297e7`
    // step 1: "Fork me on GitHub", 0x0 at (100, 32), refused. Only when
    // nothing inside it is painted either — a `display:none` ancestor, a
    // control sized away — is there no point to click at any scroll offset,
    // and that is refused before a gesture is spent on it.
    let aim = ref;
    let unverified: ReadonlySet<number> | undefined;
    if (box.width <= 0 || box.height <= 0) {
      const painted = await paintedDescendant(session, ref, view);
      if (painted === undefined) {
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: 0,
          why: 'it has no area to click, and nothing inside it is painted either',
        });
      }
      aim = painted.ref;
      box = painted.box;
      unverified = painted.verified ? undefined : painted.subtree;
    }

    // `scrolls` counts only the gestures aimed at the whole remaining distance
    // (see MAX_SCROLLS_TO_REACH). `gestures` counts every one sent, and it is
    // the number a refusal reports, because it says how far the page moved.
    let gestures = 0;
    let travelled = 0;
    let listTried = false;
    for (let scrolls = 0; ; ) {
      const visible = onScreenPart(box, view);
      if (visible.width >= MIN_HITTABLE_PX && visible.height >= MIN_HITTABLE_PX) {
        // A descendant found below the fold is confirmed once it is on screen,
        // on `paintedDescendant`'s terms: a layout box is not a painted one.
        if (unverified !== undefined && !(await paintsInside(session, ref, unverified, visible))) {
          throw new OffScreenTargetError({
            action,
            ref,
            box,
            viewport: view,
            scrolls: gestures,
            why:
              'it has no area to click, and what is painted where its content is laid out belongs ' +
              'to something else — it is collapsed, clipped or covered',
          });
        }
        return { target: visible, context: contextFor(view, session), session, aim, gestures };
      }
      // A DRAG NEVER SCROLLS: scrolling to reach one end moves the other, and
      // a point end is a place in the viewport, not on the page, so it would
      // silently come to name something else.
      if (action === 'drag') {
        throw new PointerAimRefusedError(
          'drag',
          'outside-viewport',
          `node ${formatNodeRef(ref)} is ${box.width.toFixed(0)}x${box.height.toFixed(0)} at ` +
            `(${box.x.toFixed(0)}, ${box.y.toFixed(0)}), not on screen in the ${String(view.width)}x` +
            `${String(view.height)} viewport. A drag does not scroll, because scrolling to reach one end ` +
            'moves the other: scroll until both ends are on screen, then drag.',
        );
      }
      // CLIPPED BY ITS OWN SCROLLER, ONCE: a dropdown option below the fold of
      // its list is wheeled into the list, not the page into the viewport —
      // the page wheel moves the list and the option together, and leaves the
      // option on screen but outside the list (`run_06b045f2`). See
      // `wheelClippingScroller`.
      if (!listTried) {
        listTried = true;
        const sent = await wheelClippingScroller(session, aim, view, hands);
        if (sent > 0) {
          gestures += sent;
          box = await boxOf(aim);
          view = await viewport(session);
          continue;
        }
      }
      /**
       * TO THE SIDE OF THE VIEWPORT, NO PAGE SCROLL REACHES IT, so no wheel is
       * spent trying. What lies wholly left or right of the viewport is in a
       * strip or panel the page moves itself — a carousel whose own scroller
       * would have been wheeled just above, or one it slides by transform, or
       * an off-canvas menu — and only its own control brings it in. MEASURED,
       * production 7 days to 2026-10-14: 79 of 215 "the page did not move"
       * refusals, over 29 runs, were boxes wholly to the side (a closed menu's
       * "Coupons & Deals" at x = -760, 40 steps over 8 runs on one shop), and
       * every one had first wheeled the page vertically and then blamed it.
       * Reproduced on the fleet the same day (`/connect`, n=3): a search
       * page's image strip, items at x = 1372, 2933 and 3753 of a 1200 px
       * viewport, each refused after a vertical wheel that could not help.
       */
      if (box.x + box.width <= 0 || box.x >= view.width) {
        const shown = park(ref, aim);
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: gestures,
          why:
            `it lies ${box.x < 0 ? 'left' : 'right'} of the viewport, where scrolling the page up or down never ` +
            'brings it — it is in a carousel, slider or side panel the page has moved out of view — so ' +
            shown,
          remedy:
            'Bring it in the way the page does: the next or previous arrow of the strip it is in, or the ' +
            'button that opens the menu or panel that holds it. Or choose something that is on screen.',
        });
      }
      if (scrolls >= MAX_SCROLLS_TO_REACH) {
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: gestures,
          why: 'it is still outside the viewport',
        });
      }
      // Toward the middle of the viewport rather than just far enough to clear
      // the edge: an element flush against the fold is one lazy-loaded banner
      // away from leaving again, and the middle is where a person puts the
      // thing they are about to click.
      const dy = box.y + box.height / 2 - view.height / 2;
      // ALREADY CENTRED AND STILL NOT HITTABLE: the part missing is not above
      // or below the viewport — the box lies off to the side (a carousel slide)
      // or is under MIN_HITTABLE_PX tall — and a vertical wheel cannot fix
      // either. It used to be asked anyway, with a path of zero samples the
      // browser refused (-32602), which failed the step with a message about
      // the wheel instead of the target: 18 click steps over 7 production runs
      // in the 7 days to 2026-09-24, repeated on the same node step after step.
      // The same holds for a box already wholly inside the viewport's height:
      // nothing above or below is missing, so a wheel only moves the page off
      // it. Production stealth runs 2026-10-06/07 wheeled 1x1 visually hidden
      // inputs at (32, 441) and (64, 422) of a 719 px viewport that way, then
      // blamed the page.
      if (Math.abs(dy) < 1 || (box.y >= 0 && box.y + box.height <= view.height)) {
        const shown = park(ref, aim);
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: gestures,
          why:
            'it is already within the height of the viewport and still has no area to hit — it is too ' +
            'small to press (a control hidden from sight and drawn by its label or by a picture), or lies ' +
            `partly outside the viewport to the side — so scrolling the page cannot reach it; ${shown}`,
          remedy: 'Act on what is drawn for it instead: its label, or the visible control beside it.',
        });
      }
      // TOO FAR FOR ONE CLICK. Refused before the gesture that would pass the
      // total, and before any gesture at all when the target starts out of
      // range. Not parked: the node is reachable by scrolling, just not in one
      // step's worth of wheel input.
      if (travelled + Math.abs(dy) > MAX_REACH_TOTAL_PX) {
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: gestures,
          why:
            `it is ${Math.abs(dy).toFixed(0)} px ${dy > 0 ? 'below' : 'above'} the middle of the viewport` +
            (travelled > 0 ? ` after ${travelled.toFixed(0)} px of scrolling toward it` : '') +
            `, and one ${action} scrolls at most ${String(MAX_REACH_TOTAL_PX)} px to reach its target`,
        });
      }
      const wasAt = box.y;
      const pageWas = await scrollPosition(session).catch(() => undefined);
      // At most MAX_REACH_GESTURE_PX per gesture, so the wheel finishes before
      // the command deadline. A shortened gesture is part of the approach and
      // does not count against MAX_SCROLLS_TO_REACH; the next turn continues it.
      const travel = Math.max(-MAX_REACH_GESTURE_PX, Math.min(MAX_REACH_GESTURE_PX, dy));
      const plan = await hands.scroll({ dx: 0, dy: travel }, contextFor(view, session));
      await dispatchGesture(plan, session);
      gestures += 1;
      travelled += Math.abs(travel);
      if (travel === dy) {
        scrolls += 1;
      }
      box = await boxAtRest(aim);
      view = await viewport(session);
      if (Math.abs(box.y - wasAt) < SCROLL_PROGRESS_PX) {
        const shown = park(ref, aim);
        /**
         * WHY IT DID NOT MOVE, told as the cause and what undoes it. The
         * refusal used to say "fixed to the viewport, or inside a container
         * this page does not scroll" for every case, and in production (7
         * days to 2026-10-14, 215 steps over 103 runs) most were neither.
         * Reproduced on the fleet that day through this binding (`/connect`):
         *
         * - THE PAGE SCROLLED AND IT CAME ALONG: a search results page that
         *   loads more results as it scrolls, its footer link at y = 6582.
         *   Two gestures took the page from 0 to 12,677 px while it grew from
         *   7,357 to 19,821 px, and the footer stayed 6,582 px down (n=3).
         * - THE PAGE DID NOT SCROLL, held by something over it: a home page
         *   that opened a modal dialog on the first scroll (html and body
         *   went `overflow: hidden`), and a bot check's full-page frame.
         *
         * Whether the page moved is `Page.getLayoutMetrics` either side of the
         * gesture; what holds it is the cover account a covered click gets,
         * for whatever the wheel went in over.
         */
        const pageIs = await scrollPosition(session).catch(() => undefined);
        const moved = pageWas === undefined || pageIs === undefined ? 0 : Math.abs(pageIs.y - pageWas.y);
        if (moved >= SCROLL_PROGRESS_PX) {
          const grew = pageIs === undefined || pageWas === undefined ? 0 : pageIs.height - pageWas.height;
          const feed = grew >= SCROLL_PROGRESS_PX;
          throw new OffScreenTargetError({
            action,
            ref,
            box,
            viewport: view,
            scrolls: gestures,
            why: feed
              ? `the page scrolled ${moved.toFixed(0)} px toward it and grew ${grew.toFixed(0)} px taller above ` +
                'it, so it moved away as fast as the page scrolled — it sits below content that keeps loading as ' +
                `the page scrolls, and no amount of scrolling reaches it — so ${shown}`
              : `the page scrolled ${moved.toFixed(0)} px and it stayed where it was — it is fixed to the ` +
                'viewport outside the visible part, and the page brings it in on its own, not by scrolling — so ' +
                shown,
            ...(feed
              ? {
                  remedy:
                    'Reach it another way: open the page it leads to by its address if you know it, follow a ' +
                    'link elsewhere that leads there, or use {"type":"extract"} if you only need to read it.',
                }
              : {}),
          });
        }
        const wheel = plan.find((step) => step.command === 'Outcrawl.dispatchWheelPath');
        const wheelAt =
          wheel === undefined ? undefined : { x: Number(wheel.params['x']), y: Number(wheel.params['y']) };
        const under =
          wheelAt === undefined || !Number.isFinite(wheelAt.x) || !Number.isFinite(wheelAt.y)
            ? undefined
            : await hitAt(session, wheelAt).catch(() => undefined);
        const account = under === undefined ? undefined : await accountFor(session, ref, under, 0).catch(() => undefined);
        const where =
          wheelAt === undefined
            ? ''
            : `; the wheel went in at (${wheelAt.x.toFixed(0)}, ${wheelAt.y.toFixed(0)})` +
              (account === undefined ? '' : `, over ${account.element}`);
        const held = account?.overlay === undefined ? undefined : overlayAccount(account.overlay);
        throw new OffScreenTargetError({
          action,
          ref,
          box,
          viewport: view,
          scrolls: gestures,
          why:
            held !== undefined
              ? `the page did not scroll: ${held.what} holds it still${where}, so ${shown}`
              : 'the page did not move under it — it is fixed to the viewport, or inside a ' +
                `container this page does not scroll — so ${shown}${where}`,
          ...(held === undefined ? {} : { remedy: held.remedy }),
        });
      }
    }
  }

  /**
   * The parameter is the pointer subset of `Action`, not `Action`: `navigate`
   * and `done` have no `ref` to resolve, and letting the compiler prove that
   * here is cheaper than a runtime check that can only ever fire on a bug.
   */
  async function performPointer(
    action: Extract<Action, { type: 'click' | 'hover' | 'scroll' }>,
  ): Promise<PerformOutcome | undefined> {
    // First statement in the pointer path, before any round trip. A refusal
    // that has already frozen or touched the page costs the caller a page it
    // cannot then use.
    const hands = requireHands(action.type);

    /**
     * `reveal`: the node itself is the destination, not the wheel's anchor.
     * Exactly the walk a click takes to reach a node below the fold — the
     * same wheel gestures toward the middle of the viewport, the same box
     * re-read after each, the same refusals — without the click. The loop asks
     * for it once, to put a run's recorded answer on screen before the run
     * ends; a node already on screen costs one box read and moves nothing.
     * The gestures it sent go back to the loop, which reports them to the
     * host's log (`AgentDeps.onEvidence`).
     */
    if (action.type === 'scroll' && action.reveal === true && action.ref !== undefined) {
      const { gestures } = await aimInsideViewport('scroll', action.ref, hands);
      return { gestures };
    }
    if (action.type === 'scroll') {
      // The box before the viewport, so a cross-frame ref is refused before
      // this path spends a round trip. See `aimInsideViewport`.
      const session = action.ref === undefined ? page : (await sessionFor(action.ref)).page;
      // An anchor with no box is dropped the same way an off-screen one is,
      // below: the page is still asked to move, just not under that node.
      let box: HandsTarget | undefined;
      try {
        box = action.ref === undefined ? undefined : await boxOf(action.ref);
      } catch (error) {
        if (!(error instanceof UnmeasurableTargetError)) {
          throw error;
        }
      }
      const view = await viewport(session);
      // The named element is the wheel's ANCHOR, not its destination, so an
      // anchor that is off screen is dropped rather than refused: the model
      // asked for the page to move, and `#scrollAt` then puts the wheel where
      // the cursor is, or at the viewport centre. Dispatching a wheel at an
      // off-screen anchor would scroll whatever happens to be under a point
      // outside the window, which is nothing.
      const anchor = box === undefined ? undefined : onScreenPart(box, view);
      const target = anchor !== undefined && anchor.width > 0 && anchor.height > 0 ? anchor : undefined;
      // A SCROLL FURTHER THAN ONE GESTURE CARRIES is clamped to how far the
      // page can actually go and walked in gestures of at most
      // MAX_REACH_GESTURE_PX, never refused. Production 2026-10-04, IW12
      // `run_83139043` step 10: `dy: -100000` went out as one wheel path and
      // the browser refused it ("'path' may not exceed 4096 samples"); unsplit,
      // a path that size would also outlive the 30 s command deadline (see
      // MAX_REACH_GESTURE_PX). An anchored scroll may drive a container the
      // document's extent says nothing about, so it is bounded by
      // MAX_REACH_TOTAL_PX alone; a request within one gesture is sent as it
      // was, because an infinite feed grows under the wheel past the extent
      // it had when the gesture began.
      const [dx, dy] = await reachable(action.dx ?? 0, action.dy ?? 0, target === undefined ? session : undefined);
      const gestures = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_REACH_GESTURE_PX));
      for (let gesture = 0; gesture < gestures; gesture += 1) {
        const plan = await hands.scroll(
          { dx: dx / gestures, dy: dy / gestures, ...(target === undefined ? {} : { target }) },
          contextFor(view, session),
        );
        // A scroll of under one pixel plans nothing (see `AgentHandsPort.scroll`):
        // the page is asked to move by nothing, and nothing is what it does. Not
        // `dispatchGesture`'s empty-plan refusal, which is for a generator that
        // produced nothing for a gesture that had somewhere to go.
        if (plan.length === 0) {
          return;
        }
        await dispatchGesture(plan, session);
      }
      return;
    }
    // A POINT is aimed under the freeze in the top document's viewport and
    // reached by the same approach a click's point takes; a hover is that
    // approach and nothing else (see `HandsPort.hover`).
    if ((action.type === 'click' || action.type === 'hover') && action.at !== undefined) {
      const aimed = await aimAtPoint(action.type, action.at);
      const context = contextFor(aimed.view, page);
      await dispatchGesture(
        action.type === 'click' ? await hands.click(aimed.target, context) : await hands.hover(aimed.target, context),
        page,
      );
      return;
    }
    // A DISABLED CONTROL IS REFUSED BEFORE ANY GESTURE: a press on it runs no
    // activation, so neither the wheel that would reach it nor the press is
    // worth sending. A DevTools read; a failure to read leaves the aim to say
    // what is wrong with the node. See {@link DisabledTargetError}.
    if (action.type === 'click') {
      const { page: owner } = await sessionFor(action.ref);
      const element = await elementOf(owner, action.ref.backendNodeId).catch(() => undefined);
      if (element !== undefined && DISABLEABLE_TAGS[element.tag] === true && element.attribute('disabled') !== undefined) {
        throw new DisabledTargetError('click', action.ref, element.tag);
      }
      if (element !== undefined && opensPopupMenu(element)) {
        throw new NativeSelectPopupError('click', action.ref);
      }
      if (element?.tag === 'input' && element.attribute('type')?.toLowerCase() === 'file') {
        throw new FileInputClickError('click', action.ref);
      }
    }

    let aimed: {
      readonly target: HandsTarget;
      readonly context: HandsContext;
      readonly session: CdpPage;
      readonly aim: NodeRef;
    };
    try {
      aimed = await aimInsideViewport(action.type, action.ref, hands);
    } catch (error) {
      // AN <option> OF A NATIVE <select> IS NEVER LAID OUT — its popup is
      // drawn by the OS — so a click on one always failed here, and clicking
      // it means choosing it. Measured: saucedemo "Price (high to low)", the
      // ember and non-Latin stress forms, 5 steps over 3 runs. Choosing it
      // through its select is the whole of what that click meant; anything
      // that is not such an option still refuses.
      if (
        action.type === 'click' &&
        error instanceof UnmeasurableTargetError &&
        error.reason === 'not-rendered' &&
        (await performSelect(action.ref, null)) === 'native'
      ) {
        return;
      }
      throw error;
    }
    if (action.type === 'hover') {
      await dispatchGesture(await hands.hover(aimed.target, aimed.context), aimed.session);
      return;
    }
    await dispatchGesture(await landOnTarget(action.ref, aimed, hands), aimed.session);
  }

  /**
   * Whether a press on a hit lands on `ref`: the hit is `ref`, inside it, or
   * its own control ({@link sameControlAs}). Remembers what it read, so one
   * returned function serves every hit test of one landing.
   */
  function painterOf(session: CdpPage, ref: NodeRef): (hit: Hit) => Promise<boolean> {
    let subtree: ReadonlySet<number> | undefined;
    const verdicts = new Map<number, boolean>();
    return async (hit) => {
      if (hit.backendNodeId === ref.backendNodeId) return true;
      subtree ??= await descendantsOf(session, ref);
      if (subtree.has(hit.backendNodeId)) return true;
      const known = verdicts.get(hit.backendNodeId);
      if (known !== undefined) return known;
      const inside =
        (await ancestorsOf(session, hit.backendNodeId, hit.frameId)).includes(ref.backendNodeId) ||
        (await sameControlAs(session, ref, hit));
      verdicts.set(hit.backendNodeId, inside);
      return inside;
    };
  }

  /**
   * The first of {@link HIT_SAMPLES} over `rect` where what is painted is
   * the target (`paints`), or `undefined` when something else is drawn at
   * every one of them: the hit test a covered click is refused on, and the
   * one `withoutParked` re-runs for a node parked as covered.
   */
  async function paintedSample(
    session: CdpPage,
    rect: HandsTarget,
    paints: (hit: Hit) => Promise<boolean>,
  ): Promise<ViewportPoint | undefined> {
    for (const [fx, fy] of HIT_SAMPLES) {
      const point = { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
      const hit = await hitAt(session, point).catch(() => undefined);
      if (hit !== undefined && (await paints(hit))) return point;
    }
    return undefined;
  }

  /**
   * THE CLICK ON `ref` THAT IS SENT: a plan whose press the hit test puts on
   * `ref`, checked before anything is dispatched.
   *
   * `hands.click` picks a point anywhere in the rect it is given, and the rect
   * is the target's LAYOUT box: a drawer, a vignette ad, a sticky bar or a
   * cookie banner drawn over it takes the press instead, and the page reports
   * nothing changed about a click that never reached the target. MEASURED on
   * the fleet 2026-09-25 (`/connect`, n=1): with a maps site's drawer open, the
   * hit test at the centre of its "Menu" button is the drawer's logo image —
   * `run_fa5c9309` clicked "Menu" four times into it and stopped.
   *
   * THE HAND CHOOSES FIRST, and the hit test only vetoes. The plan is drawn
   * over the whole on-screen rect and its press point is hit-tested; a press
   * on `ref` (or on something the renderer cannot name, which leaves the
   * click as it always was) is sent unchanged. That is the common case and it
   * costs one hit test, with the landing exactly as spread as before this
   * check existed — a target pinned to its centre, or to any point we chose,
   * is a click distribution no person produces. Only after
   * {@link LANDING_DRAWS} draws have all hit a cover is the landing steered:
   * {@link HIT_SAMPLES} find a point `ref` paints, the window is grown to the
   * painted run around it ({@link PAINTED_RUN_STEPS}), and the hand draws
   * inside that, still hit-tested. When no sample paints `ref`, the scroller
   * that clips it is wheeled first ({@link wheelClippingScroller}: an option
   * scrolled out of its own list is not covered, it is clipped), then the page
   * is wheeled toward the middle of the viewport once — a sticky header or
   * footer covers only the edges — and all of it runs again. Covered even
   * there, the click is refused with an account of what covers it
   * ({@link CoveredTargetError}, {@link accountFor}): never a keystroke in its
   * place.
   *
   * A PRESS THAT REACHES `ref`'S OWN CONTROL IS A PRESS ON `ref`
   * ({@link sameControlAs}): a `<label>` whose control is `ref`, the form
   * control whose own shadow `ref` is drawn in, or the control a plain `ref`
   * sits inside. MEASURED 2026-09-26: `run_fdfbca90` (a date input's "Day"
   * spinbutton) was refused as covered by `<input#birthDate>`, the input the
   * spinbutton is part of.
   *
   * DevTools reads only (`DOM.getNodeForLocation`, `DOM.describeNode`, and
   * isolated-world reads of the DOM), so the page sees none of it, and a plan
   * that is not sent is not seen either. The only input is the wheel, sent
   * through `hands` like every other.
   */
  async function landOnTarget(
    ref: NodeRef,
    aimed: {
      readonly target: HandsTarget;
      readonly context: HandsContext;
      readonly session: CdpPage;
      readonly aim: NodeRef;
    },
    hands: HandsPort,
  ): Promise<readonly HandsStep[]> {
    const { session } = aimed;
    const paints = painterOf(session, ref);
    /**
     * Up to {@link LANDING_DRAWS} plans over `rect`: the first whose press
     * lands on `ref` or on nothing the renderer can name, else the first
     * cover a press was aimed into.
     */
    const draw = async (
      rect: HandsTarget,
      context: HandsContext,
    ): Promise<{ readonly plan: readonly HandsStep[] } | { readonly cover: Hit }> => {
      let cover: Hit | undefined;
      for (let drawn = 0; drawn < LANDING_DRAWS; drawn += 1) {
        const plan = await hands.click(rect, context);
        let at: ViewportPoint | undefined;
        for (const step of plan) {
          if (step.command === 'Input.dispatchMouseEvent' && step.params.type === 'mousePressed') {
            at = { x: step.params.x, y: step.params.y };
            break;
          }
        }
        const hit = at === undefined ? undefined : await hitAt(session, at).catch(() => undefined);
        if (hit === undefined || (await paints(hit))) return { plan };
        cover ??= hit;
      }
      // Every draw returned a hit, so `cover` is set: LANDING_DRAWS is positive.
      return { cover: cover as Hit };
    };
    /** How far from `point` toward one edge `ref` is still what is painted. */
    const reach = async (point: ViewportPoint, dx: number, dy: number, span: number): Promise<number> => {
      let reached = 0;
      for (const step of PAINTED_RUN_STEPS) {
        const hit = await hitAt(session, { x: point.x + dx * span * step, y: point.y + dy * span * step }).catch(
          () => undefined,
        );
        if (hit === undefined || !(await paints(hit))) break;
        reached = span * step;
      }
      return reached;
    };
    const refuse = async (cover: Hit): Promise<never> => {
      const key = formatNodeRef(ref);
      const refusals = (coveredRefusals.get(key) ?? 0) + 1;
      coveredRefusals.set(key, refusals);
      const account = await accountFor(session, ref, cover, refusals);
      // A second refusal of the same click: the model is repeating a click
      // that cannot land, so the node leaves the page it is shown until the
      // cover goes. See {@link covered}.
      const shown = account.refusals > 1 ? parkCovered(ref, aimed.aim) : undefined;
      throw new CoveredTargetError('click', ref, account, shown);
    };

    const half = HIT_WINDOW_PX / 2;
    let rect = aimed.target;
    let context = aimed.context;
    let unclipped = false;
    let wheeled = false;
    for (;;) {
      const whole = await draw(rect, context);
      if ('plan' in whole) return whole.plan;
      const { cover } = whole;

      const found = await paintedSample(session, rect, paints);
      if (found !== undefined) {
        const left = Math.max(await reach(found, -1, 0, found.x - rect.x), Math.min(half, found.x - rect.x));
        const right = Math.max(
          await reach(found, 1, 0, rect.x + rect.width - found.x),
          Math.min(half, rect.x + rect.width - found.x),
        );
        const up = Math.max(await reach(found, 0, -1, found.y - rect.y), Math.min(half, found.y - rect.y));
        const down = Math.max(
          await reach(found, 0, 1, rect.y + rect.height - found.y),
          Math.min(half, rect.y + rect.height - found.y),
        );
        // Drawn inside the painted run. A hand that still misses from every
        // draw is refused rather than pinned to the sample.
        const run = await draw({ x: found.x - left, y: found.y - up, width: left + right, height: up + down }, context);
        if ('plan' in run) return run.plan;
        return refuse(run.cover);
      }

      // Painted nowhere it was sampled. Clipped by its own scroller first
      // (MEASURED 2026-09-26, `run_06b045f2` and `run_4feda68f`: an option
      // below the fold of its dropdown list, "covered" by whatever page was
      // under the list), then toward the middle once, where no sticky edge reaches.
      const view = context.viewport;
      if (!unclipped) {
        unclipped = true;
        if ((await wheelClippingScroller(session, ref, view, hands)) > 0) {
          const moved = await viewport(session);
          rect = onScreenPart(await boxOf(ref), moved);
          if (rect.width < MIN_HITTABLE_PX || rect.height < MIN_HITTABLE_PX) return refuse(cover);
          context = contextFor(moved, session);
          continue;
        }
      }
      const dy = rect.y + rect.height / 2 - view.height / 2;
      if (wheeled || Math.abs(dy) <= view.height / 4) return refuse(cover);
      wheeled = true;
      await dispatchGesture(await hands.scroll({ dx: 0, dy }, contextFor(view, session)), session);
      const moved = await viewport(session);
      rect = onScreenPart(await boxAtRest(ref), moved);
      if (rect.width < MIN_HITTABLE_PX || rect.height < MIN_HITTABLE_PX) return refuse(cover);
      context = contextFor(moved, session);
    }
  }

  /** `<tag#id> "label"`, short, for a sentence naming an element the model cannot see by ref. */
  async function nameOf(session: CdpPage, backendNodeId: number): Promise<string> {
    const element = await elementOf(session, backendNodeId).catch(() => undefined);
    if (element === undefined) return 'another element';
    const id = element.attribute('id');
    const label = element.attribute('aria-label') ?? element.attribute('alt');
    return (
      `<${element.tag}${id === undefined ? '' : `#${id.slice(0, 40)}`}>` +
      (label === undefined ? '' : ` ${JSON.stringify(label.slice(0, 60))}`)
    );
  }

  /**
   * The top frame id of `session` when `ref` lives in that frame, else
   * `undefined`. Coordinates read inside a frame are that frame's own, and
   * they compare with `boxOf`'s only when the frame is the session's top one;
   * a same-process child frame's node is left alone rather than mis-measured.
   */
  async function frameIdOf(session: CdpPage, ref: NodeRef): Promise<string | undefined> {
    let own: number | undefined;
    if (session === page) {
      own = await sessionFrame();
    } else {
      for (const [ordinal, candidate] of framePages) {
        if (candidate === session) {
          own = ordinal;
          break;
        }
      }
    }
    if (own !== ref.frameOrdinal) return undefined;
    const tree = (await session.send('Page.getFrameTree'))['frameTree'];
    const frame = typeof tree === 'object' && tree !== null && 'frame' in tree ? tree.frame : undefined;
    const id = typeof frame === 'object' && frame !== null && 'id' in frame ? frame.id : undefined;
    return typeof id === 'string' && id !== '' ? id : undefined;
  }

  /**
   * Whether a press on `hit` is a press on `ref`'s own control, so landing
   * there is landing on `ref` and not on a cover:
   *
   * - `hit` is a `<label>`, or inside one, whose `control` is `ref`. The label
   *   forwards its activation to that control: the custom checkbox whose real
   *   `<input>` is drawn under its styled label.
   * - `hit` is the form control whose own shadow tree `ref` is in. The hit
   *   test runs with `includeUserAgentShadowDOM: false`, so it names the host
   *   for any point on a date input's "Day" field. `run_fdfbca90`
   *   (2026-09-26): the "Day" spinbutton, refused as covered by its own
   *   `<input#birthDate type=date>`; its backend id 134 lies in the gap
   *   125-139 the recording's light DOM never assigns, just before the input's
   *   140.
   * - `ref` is text or a plain element (nothing a person could focus or activate on
   *   its own), and `hit` is the nearest control it sits inside: the press
   *   bubbles to that control from `ref` anyway.
   *
   * Anything else the target sits inside — a clickable card around a button —
   * is a different control, and stays a cover.
   */
  async function sameControlAs(session: CdpPage, ref: NodeRef, hit: Hit): Promise<boolean> {
    const value = await inLookWorld(session, hit.frameId, {
      on: ref.backendNodeId,
      declaration: SAME_CONTROL,
      args: [hit.backendNodeId],
      returns: 'value',
    }).catch(() => undefined);
    return value === true;
  }

  /**
   * What the refusal of a covered click says about `cover`: its element, the
   * node of the model's tree it is (or the nearest ancestor the tree has),
   * and what it is part of when that is over the page — an open dialog
   * ({@link MODAL_OF}) or something fixed to the viewport ({@link FIXED_OF})
   * — with the controls in it whose names say they put it away. `refusals`
   * is the caller's count of covered refusals of this same click.
   *
   * The tree is `filterTree(snapshot())`, the one the model is shown, so every
   * reference named here is one `validateAction` accepts. Nodes are matched
   * only in `ref`'s own frame: the hit test ran in that frame's renderer.
   */
  async function accountFor(session: CdpPage, ref: NodeRef, cover: Hit, refusals: number): Promise<CoverAccount> {
    const element = await nameOf(session, cover.backendNodeId);
    const over = async (declaration: string): Promise<number | undefined> => {
      const id = await inLookWorld(session, cover.frameId, {
        on: ref.backendNodeId,
        declaration,
        args: [cover.backendNodeId],
        returns: 'node',
      }).catch(() => undefined);
      return typeof id === 'number' ? id : undefined;
    };
    const dialogId = await over(MODAL_OF);
    const fixedId = dialogId === undefined ? await over(FIXED_OF) : undefined;
    const overlayId = dialogId ?? fixedId;
    const kind = dialogId !== undefined ? 'dialog' : 'fixed';
    let tree: AxTree;
    try {
      tree = filterTree(await snapshot());
    } catch {
      return { element, refusals, ...(overlayId === undefined ? {} : { overlay: { kind, dismiss: [] } }) };
    }
    const byId = new Map<number, AxNode>();
    const dismissible: AxNode[] = [];
    for (const node of walk(tree)) {
      if (node.ref.frameOrdinal !== ref.frameOrdinal) continue;
      if (!byId.has(node.ref.backendNodeId)) byId.set(node.ref.backendNodeId, node);
      if ((node.role === 'button' || node.role === 'link') && node.name !== undefined && DISMISS_NAME.test(node.name.trim())) {
        dismissible.push(node);
      }
    }

    let found = byId.get(cover.backendNodeId);
    if (found === undefined) {
      for (const id of await ancestorsOf(session, cover.backendNodeId, cover.frameId).catch((): readonly number[] => [])) {
        found = byId.get(id);
        if (found !== undefined) break;
      }
    }
    const shown = found === undefined || found === tree.root ? undefined : asShown(found);
    if (overlayId === undefined) {
      return { element, refusals, ...(shown === undefined ? {} : { shown }) };
    }
    // Its closing controls: those under its own node when the tree has it,
    // else the ones whose ancestors include it, the first few only.
    const node = byId.get(overlayId);
    const inside = node === undefined ? undefined : new Set(walk({ url: tree.url, root: node }));
    const dismiss: ShownNode[] = [];
    for (const candidate of inside === undefined ? dismissible.slice(0, MAX_DISMISS_CHECKS) : dismissible) {
      if (dismiss.length >= MAX_DISMISS_NAMED) break;
      const held =
        inside !== undefined
          ? inside.has(candidate)
          : (await ancestorsOf(session, candidate.ref.backendNodeId, cover.frameId).catch((): readonly number[] => [])).includes(overlayId);
      if (held) dismiss.push(asShown(candidate));
    }
    return {
      element,
      refusals,
      ...(shown === undefined ? {} : { shown }),
      overlay: { kind, ...(node === undefined ? {} : { node: asShown(node) }), dismiss },
    };
  }

  /**
   * Wheels the scroller that clips `ref` until `ref`'s centre is inside it,
   * and returns how many gestures that took: 0 when nothing but the viewport
   * clips it, or the scroller is not on screen for a wheel to go in over.
   *
   * AN OPTION BELOW THE FOLD OF ITS OWN LIST IS CLIPPED, NOT COVERED, and the
   * page wheel cannot reach it: that moves the list and the option together.
   * MEASURED 2026-09-26 from the recordings: ups.com's State list (`run_06b045f2`)
   * showed Alabama to Connecticut with "New York", option 33, below its
   * bottom edge, and was refused 7 times as covered by `<app-navigation-button>`,
   * `<footer>` and `<div>` — whatever part of the page lay under the list's
   * box that time; americashealthrankings.org's measure list (`run_4feda68f`)
   * showed categories A to E with a scrollbar and "Mortality" below them,
   * refused 4 times as covered by `<h3>` and `<p>`.
   *
   * A person scrolls the list with the wheel over the list, and that is what
   * this sends: the same `hands.scroll` gesture as every other scroll, with
   * the wheel over the part of the scroller that is on screen.
   */
  async function wheelClippingScroller(
    session: CdpPage,
    ref: NodeRef,
    view: { readonly width: number; readonly height: number },
    hands: HandsPort,
  ): Promise<number> {
    const frameId = await frameIdOf(session, ref).catch(() => undefined);
    if (frameId === undefined) return 0;
    const clamp = (delta: number): number => Math.max(-MAX_REACH_GESTURE_PX, Math.min(MAX_REACH_GESTURE_PX, delta));
    let gestures = 0;
    for (let turn = 0; turn < MAX_SCROLLS_TO_REACH; turn += 1) {
      const clip = clipFrom(
        await inLookWorld(session, frameId, {
          on: ref.backendNodeId,
          declaration: CLIPPING_SCROLLER,
          returns: 'value',
        }).catch(() => undefined),
      );
      if (clip === undefined) break;
      const over = onScreenPart(clip.box, view);
      if (over.width < MIN_HITTABLE_PX || over.height < MIN_HITTABLE_PX) break;
      const plan = await hands.scroll(
        { dx: clamp(clip.dx), dy: clamp(clip.dy), target: over },
        contextFor(view, session),
      );
      if (plan.length === 0) break;
      const before = await boxOf(ref);
      await dispatchGesture(plan, session);
      gestures += 1;
      const after = await boxAtRest(ref);
      if (Math.abs(after.x - before.x) < SCROLL_PROGRESS_PX && Math.abs(after.y - before.y) < SCROLL_PROGRESS_PX) break;
    }
    return gestures;
  }

  /**
   * The small box a VIEWPORT point is aimed through, after the checks that
   * make it a place a hand could press. All reads, under the freeze.
   *
   * Always on `page`: a point is in the TOP document's viewport, the space
   * `page.look` photographs and answers in.
   *
   *   * Outside the viewport is refused, never clamped — see
   *     {@link PointerAimRefusedError}.
   *   * The hit test is in DOCUMENT coordinates (`hitAt` adds the layout
   *     viewport's `pageX/pageY`), so on a scrolled page it names what is
   *     painted at the point rather than what is S px above it.
   *   * A point over an `<iframe>` is refused. `dispatchPointerPath` goes to
   *     the session's own widget and is not hit-tested into another frame's
   *     process — MEASURED 2026-09-09 (`packages/captcha/src/agentic/
   *     cdp-widget.ts`): 90 samples sent on the embedder's session, zero
   *     events inside a cross-origin challenge frame. So a point click there
   *     would land on the `<iframe>` element and nothing inside it: a click
   *     that reports success and did nothing. The element inside has a ref,
   *     and a ref is dispatched on that frame's own session.
   */
  async function aimAtPoint(
    action: 'click' | 'hover' | 'drag',
    point: ViewportPoint,
  ): Promise<{ readonly target: HandsTarget; readonly view: { readonly width: number; readonly height: number } }> {
    const view = await viewport(page);
    const at = `(${String(point.x)}, ${String(point.y)})`;
    if (point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) {
      throw new PointerAimRefusedError(
        action,
        'outside-viewport',
        `${at} is outside the ${String(view.width)}x${String(view.height)} viewport. A point is viewport CSS ` +
          'pixels from its top-left corner, the space page.look answers in, and one past the edge is ' +
          'refused rather than moved onto whatever happens to be at the edge.',
      );
    }
    const hit = await hitAt(page, point);
    if (hit === undefined) {
      throw new PointerAimRefusedError(action, 'nothing-there', `nothing on the page is painted at ${at}.`);
    }
    const described = await page.send('DOM.describeNode', { backendNodeId: hit.backendNodeId });
    const node = described['node'];
    const name = typeof node === 'object' && node !== null && 'nodeName' in node ? node.nodeName : undefined;
    if (name === 'IFRAME' || name === 'FRAME') {
      throw new PointerAimRefusedError(
        action,
        'embedded-frame',
        `${at} is over an embedded frame, and input aimed by position on this page does not reach inside ` +
          "another frame's process. Act on the element inside it by its ref.",
      );
    }
    const half = POINT_AIM_PX / 2;
    return {
      target: onScreenPart({ x: point.x - half, y: point.y - half, width: POINT_AIM_PX, height: POINT_AIM_PX }, view),
      view,
    };
  }

  /**
   * `drag`: both ends aimed under the freeze, bounded, then ONE gesture —
   * approach, press, held path, release — through {@link dispatchGesture},
   * which drops the freeze for exactly its length like every other input.
   *
   * Both ends must be on the same session, because one pointer path is
   * dispatched to one widget in that widget's coordinates. A point is always
   * `page`'s; a ref is on whichever session owns its frame. Two ends that
   * disagree cannot be one gesture here and are refused, not approximated.
   */
  async function performDrag(action: DragAction): Promise<void> {
    const hands = requireHands('drag');
    const aim = async (end: DragEnd): Promise<{ readonly target: HandsTarget; readonly session: CdpPage }> => {
      if (isViewportPoint(end)) {
        return { target: (await aimAtPoint('drag', end)).target, session: page };
      }
      const aimed = await aimInsideViewport('drag', end, hands);
      return { target: aimed.target, session: aimed.session };
    };
    const from = await aim(action.from);
    const to = await aim(action.to);
    if (from.session !== to.session) {
      throw new PointerAimRefusedError(
        'drag',
        'split-frames',
        'its two ends are in different frames, and one drag is one pointer path into one frame. Drag ' +
          'between two elements of the same frame, naming both by ref when either is inside an embedded one.',
      );
    }
    // Centre to centre: the planner lands inside each box, so this is the
    // gesture's length to within the boxes' own size.
    const length = Math.hypot(
      to.target.x + to.target.width / 2 - (from.target.x + from.target.width / 2),
      to.target.y + to.target.height / 2 - (from.target.y + from.target.height / 2),
    );
    if (length < MIN_DRAG_PX) {
      throw new PointerAimRefusedError(
        'drag',
        'too-short',
        `its ends are ${length.toFixed(1)} px apart, which a page reads as a click: drag at least ` +
          `${String(MIN_DRAG_PX)} px, or click.`,
      );
    }
    if (length > MAX_DRAG_PX) {
      throw new PointerAimRefusedError(
        'drag',
        'too-long',
        `its ends are ${length.toFixed(0)} px apart, past the ${String(MAX_DRAG_PX)} px one gesture may cover.`,
      );
    }
    const view = await viewport(from.session);
    await dispatchDrag(await hands.drag(from.target, to.target, contextFor(view, from.session)), from.session);
  }

  /**
   * Whether `ref` is a native `<input type=date|time|datetime-local|month|week>`
   * or one of its segments. Reads only: `DOM.describeNode` first, so anything
   * that is neither a spinbutton nor such an input pays one round trip, then
   * {@link NATIVE_DATE_HOST} in the look world.
   */
  async function isNativeDateField(ref: NodeRef): Promise<boolean> {
    const { page: session, backendNodeId: id } = await sessionFor(ref);
    const element = await elementOf(session, id).catch(() => undefined);
    if (
      element === undefined ||
      !(element.attribute('role') === 'spinbutton' || (element.tag === 'input' && nativeDateKind(element.attribute('type') ?? '') !== undefined))
    ) {
      return false;
    }
    const frameId = await frameIdOf(session, ref).catch(() => undefined);
    if (frameId === undefined) return false;
    const host = await inLookWorld(session, frameId, { on: id, declaration: NATIVE_DATE_HOST, returns: 'node' }).catch(() => undefined);
    return typeof host === 'number';
  }

  /**
   * A fill into a native date/time input, as one `[segment, keys]` per
   * segment in drawn order; `undefined` when `ref` is not such an input or
   * one of its segments, or `text` is not a value of its kind in any shape
   * `nativeDateValue` reads, and the fill types `text` as it always did.
   *
   * WHY THE WHOLE INPUT AND NOT THE SEGMENT. A model names one segment and a
   * value for the whole input ("19:30" into "Hours"). Typed as written, the
   * value's own punctuation is keystrokes the segments act on: MEASURED on
   * the fleet 2026-10-02 through trusted key events into httpbin's 12-hour time
   * input, "07:30 PM" and "7:30 PM" left the AM/PM segment empty and
   * `input.value` "" (3/3 and 3/3), while "07" "30" "P" into the three
   * segments made `19:30` (3/3). `run_49621d26` (an alternate brain model) ended in
   * error on exactly that input.
   *
   * Every segment is focused before its keys, as a person clicks each one,
   * so the plan never rests on when Blink advances focus by itself — which
   * differs by field width and by locale. Focus moving inside one input's
   * user-agent shadow tree retargets to the input on both sides, and Blink
   * dispatches no focus event whose target is its own related target.
   *
   * Reads only: `DOM.describeNode` and the look world. Nothing here sets a
   * value; what lands is what the keys typed.
   */
  async function nativeDatePlan(
    session: CdpPage,
    ref: NodeRef,
    id: number,
    text: string,
  ): Promise<readonly (readonly [number, string])[] | undefined> {
    const frameId = await frameIdOf(session, ref).catch(() => undefined);
    if (frameId === undefined) return undefined;
    const host = await inLookWorld(session, frameId, { on: id, declaration: NATIVE_DATE_HOST, returns: 'node' }).catch(
      () => undefined,
    );
    if (typeof host !== 'number') return undefined;
    const described = await session.send('DOM.describeNode', { backendNodeId: host, depth: -1, pierce: true });
    const segments: number[] = [];
    const collect = (node: unknown, inside: boolean): void => {
      if (!isRecord(node)) return;
      const attributes = Array.isArray(node['attributes']) ? node['attributes'] : [];
      const isSegment = attributes.some(
        (value, at) => at % 2 === 0 && value === 'role' && attributes[at + 1] === 'spinbutton',
      );
      if (inside && isSegment && typeof node['backendNodeId'] === 'number') segments.push(node['backendNodeId']);
      for (const child of Array.isArray(node['children']) ? node['children'] : []) collect(child, inside);
      for (const root of Array.isArray(node['shadowRoots']) ? node['shadowRoots'] : []) {
        if (isRecord(root) && root['shadowRootType'] === 'user-agent') collect(root, true);
      }
    };
    collect(described['node'], false);
    const first = segments[0];
    if (first === undefined) return undefined;
    const layout = await inLookWorld(session, frameId, { on: first, declaration: NATIVE_DATE_LAYOUT, returns: 'value' }).catch(
      () => undefined,
    );
    if (!isRecord(layout) || typeof layout['type'] !== 'string' || !Array.isArray(layout['segments'])) return undefined;
    const kind = nativeDateKind(layout['type']);
    const value = kind === undefined ? undefined : nativeDateValue(kind, text);
    if (kind === undefined || value === undefined) return undefined;
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    const keys = nativeDateKeys(
      kind,
      value,
      layout['segments'].filter(isRecord).map((segment) => ({
        field: typeof segment['field'] === 'string' ? segment['field'] : '',
        max: typeof segment['max'] === 'number' ? segment['max'] : Number.NaN,
        placeholder: typeof segment['placeholder'] === 'string' ? segment['placeholder'] : '',
      })),
      { months: strings(layout['months']), ampm: strings(layout['ampm']) },
    );
    // The DOM's segments and the look world's must be the same list, or a key
    // would land in a segment it was not planned for.
    if (keys === undefined || keys.length !== segments.length) return undefined;
    return segments.map((segment, index) => [segment, keys[index] as string] as const);
  }

  /**
   * The url a reload of this tab loads: the CURRENT HISTORY ENTRY's, which on
   * the browser's error page is the url that failed (what a person's F5
   * retries), else the document's own. `Page.getNavigationHistory` is answered
   * by the browser process, not the renderer, so a wedged renderer, which is
   * when a reload gets pressed, cannot hold it; `Page.getFrameTree` could.
   * MEASURED through production 2026-10-03 07:48Z (sess_109218ef, n=1 each):
   * after a tunnel failure the current entry read the failed url while the
   * frame read `chrome-error://chromewebdata/`; a page and a refused port read
   * their own urls.
   */
  async function reloadTarget(): Promise<string | undefined> {
    const history = await page.send('Page.getNavigationHistory');
    const entries = history['entries'];
    const index = history['currentIndex'];
    const current = Array.isArray(entries) && typeof index === 'number' ? (entries[index] as unknown) : undefined;
    const url = typeof current === 'object' && current !== null && 'url' in current ? current.url : undefined;
    return typeof url === 'string' && url !== '' ? url : page.url() || undefined;
  }

  /**
   * One `Page.navigate` to `target`, waited for to its main-frame COMMIT: the
   * url that commit carried, or `undefined` when nothing committed within
   * {@link NAVIGATE_COMMIT_CEILING_MS}. Throws the load's own failure (an
   * exit's refusal, a net error) in our words. `verb` names the load in a
   * failure; `method` is what `agent.navigate` reports it as: the model's
   * `navigate`, or a reload key performed as a navigate to the document's url.
   */
  async function loadDocument(target: string, load: LoadRequest): Promise<LoadResult> {
    const resumeAt = load.resumeAt ?? target;
    // FIRE AND POLL, NOT AWAIT. `Page.navigate` is a command this fork can
    // HOLD: a challenge gate defers its reply until the hold resolves, so
    // awaiting it turns a page that arrived into a run that never started.
    // Measured on the fleet: a healthy headful browser on a real site,
    // `Page.navigate did not answer within 30000ms`, and then every
    // subsequent `Outcrawl.lock` queued behind the freeze bookkeeping the
    // timeout left inconsistent -- four verification harnesses lost their
    // runs to it in one night, and on the production path it silently
    // costs a step and a third of `stepFailures`.
    //
    // ── WHY THE ANSWER IS THE COMMIT EVENT AND NOT THE REPLY ─────────
    //
    // `Page.navigate`'s reply means the navigation has been STARTED. The
    // url this returns is `PerformOutcome.url`, which `verify.ts`'s
    // `checkReportedUrl` judges a navigate on — so a reply that beats
    // `Page.frameNavigated` to our handler returns the url we were on
    // BEFORE, and the check contradicts a navigation that worked. That is
    // not a rare interleaving; it is a coin flip. Measured on the fleet
    // rig on 2026-09-09, two arms taking the identical navigate to live
    // Hacker News: arm A won the race and read `confirmed`, arm B lost it
    // and read `contradicted: the browser is still on about:blank` while
    // the very next step read the live Hacker News tree. In production,
    // `run_ee2f6142`: 2 of 7 navigate self-reports came back
    // contradicted.
    //
    // So the wait is ORDERED against the navigation rather than raced
    // with it: the commit is subscribed BEFORE the command goes out, and
    // the url returned is the one the commit carried. No sleep and no
    // retry — a sleep would make the race narrower and still a race.
    //
    // BOTH commit events, because a fragment navigation is a commit too:
    // `Page.navigatedWithinDocument` is what a same-document url change
    // fires, `CdpPageSession` does not track it, and the old code broke
    // out of the poll on `answered` and returned the stale url for every
    // one of them. Only one that lands on the requested url counts: see
    // `noteCommit` below for the departing page's own events.
    //
    // A destination the tab's network refuses on every route: sent anyway it
    // only fails the same way again, so it is refused here, before any
    // navigation, in the words the post-failure path uses.
    const exits = tab?.exits;
    const refusal = exits?.refusal?.(target, resumeAt);
    if (refusal !== undefined) throw refusal;
    const ceiling = Math.max(0, Math.min(NAVIGATE_COMMIT_CEILING_MS, load.ceilingMs ?? NAVIGATE_COMMIT_CEILING_MS));
    let committed: string | undefined;
    /** `agent.navigate`'s fields: the main-frame commit's status and when it came. */
    let committedStatus: number | undefined;
    let committedAt: number | undefined;
    /** For an error page committed in the asked page's place: what its request failed of (`failureFor`), or `null` when unseen. */
    let committedFailure: string | null | undefined;
    /**
     * An answer our exit wrote in the site's place, seen at its commit.
     * Once set, later commits are ignored: the next one is the
     * `about:blank` this binding sends to clear it, not the answer.
     */
    let refused: Error | undefined;
    // ONLY THE REQUESTED NAVIGATION'S COMMIT. A cross-document commit of
    // the main frame is a new document, and after `Page.navigate` that is
    // this navigation (or a redirect of it). A SAME-document one is ours
    // only when it lands on the url asked for — a fragment navigation is
    // the one case `Page.navigate` commits without a new document. Any
    // other is the DEPARTING page rewriting its own history: MEASURED
    // through production 2026-10-03 (`probe-nav-commit.mjs`, 3
    // sessions), github.com fires `navigatedWithinDocument` with its own
    // url 85-650 ms BEFORE the next navigation commits, on 4 of 6
    // navigations away from a repository page. Taking that for the
    // commit returned the old url, the check read the old tree, and
    // `run_7c6cc717` was told "still on github.com/ziglang/zig" about a
    // navigation that landed, and "on github.com/golang/go" CONFIRMED a
    // navigate to ziglang/zig before it had happened.
    const asked = URL.parse(target)?.href;
    const noteCommit = (params: Record<string, unknown>): void => {
      if (refused !== undefined) return;
      // `Page.frameNavigated` carries `{frame:{parentId,url}}`;
      // `Page.navigatedWithinDocument` carries `{frameId,url}` flat. A
      // subframe navigation is not this page's url, and `parentId` absent
      // is the main frame — exactly as `CdpPageSession` filters it.
      const frame = params['frame'];
      let url: unknown;
      if (typeof frame === 'object' && frame !== null) {
        const fields = frame as Record<string, unknown>;
        url = fields['parentId'] === undefined ? fields['url'] : undefined;
        if (watch !== undefined && fields['parentId'] === undefined) {
          committedStatus = watch.statusFor(fields);
          const unreachable = fields['unreachableUrl'];
          committedFailure = typeof unreachable === 'string' ? (watch.failureFor(unreachable) ?? null) : undefined;
          refused =
            watch.answerFor(fields, params['type']) ??
            (typeof unreachable === 'string' ? watch.tunnelFor(unreachable) : undefined);
        }
      } else {
        const within = params['url'];
        url = typeof within === 'string' && URL.parse(within)?.href === asked ? within : undefined;
      }
      if (typeof url === 'string' && url !== '') {
        committed = url;
        committedAt ??= performance.now();
      }
    };
    const offCommits = [
      page.on('Page.frameNavigated', noteCommit),
      page.on('Page.navigatedWithinDocument', noteCommit),
    ];
    let errorText: string | undefined;
    let answered = false;
    /** The browser never answered `Page.navigate` (a CDP timeout): a dead route or a slow site. */
    let unanswered = false;
    // Documents must be intercepted BEFORE the navigation, or its
    // response's headers are never seen. Settles even on a refusal.
    await watch?.ready;
    navigating = true;
    const sentAt = performance.now();
    try {
      const sent = page
        .send('Page.navigate', { url: target })
        .then((result) => {
          const text = result['errorText'];
          if (typeof text === 'string' && text.length > 0) {
            errorText = text;
          }
        })
        .catch((cause: unknown) => {
          // A refusal is a real failure and is rethrown below; a HOLD that
          // never answers is not, and must not become an unhandled rejection
          // after we have already returned on the commit.
          errorText = cause instanceof Error ? cause.message : String(cause);
          unanswered = isCdpTimeout(cause, 'Page.navigate');
        })
        .finally(() => {
          answered = true;
        });
      void sent;

      // Bounded twice: by the clock, and by the sleeps actually taken,
      // so a clock that does not advance (a test's) still ends the wait.
      const started = clock.now();
      for (
        let waited = 0;
        waited < ceiling && clock.now() - started < ceiling;
        waited += NAVIGATE_POLL_MS
      ) {
        // The COMMIT, or a REFUSAL. Deliberately not a bare `answered`:
        // a command that answered successfully has told us the
        // navigation started and nothing about where it landed, which is
        // the whole defect above.
        if (committed !== undefined || (answered && errorText !== undefined)) {
          break;
        }
        await clock.sleep(NAVIGATE_POLL_MS);
      }
    } finally {
      navigating = false;
      for (const off of offCommits) off();
    }
    const failed = refused === undefined && answered && errorText !== undefined;
    const netError = failed ? (/net::ERR_[A-Z0-9_]+/.exec(errorText ?? '')?.[0] ?? null) : null;
    // AN UNANSWERED NAVIGATE IS PROBED, NOT PRESUMED: a slow site must not
    // retire a healthy route, so the exit hook's own probe decides; nothing is
    // probed on any navigate that was answered.
    const exitProbe: 'dead' | 'alive' | undefined =
      failed && unanswered && exits?.alive !== undefined
        ? await exits.alive().then(
            (alive) => (alive === false ? 'dead' : alive === true ? 'alive' : undefined),
            () => undefined,
          )
        : undefined;
    exits?.navigated?.({
      url: target,
      method: load.method,
      status: committedStatus ?? null,
      commitMs: committedAt === undefined ? null : Math.round(committedAt - sentAt),
      outcome:
        refused !== undefined
          ? 'refused'
          : answered && errorText !== undefined
            ? 'failed'
            : committed !== undefined
              ? 'committed'
              : 'no-commit',
      netError,
      ...(exitProbe === undefined ? {} : { exitProbe }),
      errorPage: failed || committed === undefined ? null : (committedFailure ?? null),
      ...(refused === undefined && !(answered && errorText !== undefined) && committed === undefined && ceiling < NAVIGATE_COMMIT_CEILING_MS
        ? { cutByCap: true as const }
        : {}),
    });

    // OUR sentence, never the exit's: the step's error is what the model
    // and the run's events read. Thrown only once the tab no longer
    // shows what the exit wrote, so the next snapshot cannot either.
    if (refused !== undefined) {
      await scrubbed;
      throw refused;
    }
    // Only an answered command can carry a reason. A held one that
    // committed is a success we observed by another route; a held one that
    // did not commit returns the URL we still have, and the loop's settle
    // is what decides whether that page is usable.
    if (answered && errorText !== undefined) {
      throw (
        (await exits?.failed?.({ target, resumeAt, verb: load.verb, errorText, netError, exitProbe })) ??
        new Error(`${load.verb} failed: ${errorText}`)
      );
    }
    // AN EXIT THAT STOPPED ANSWERING (measured 2026-10-03 07:34-07:42Z, n=186
    // agent navigates, both Macs: lease 50 committed three error pages and
    // failed four navigates in a row on amazon.in and bing, which loaded at
    // once on a fresh exit). An error page committed in the page's place, or
    // no commit within the ceiling, is the exit's verdict; a page the site
    // served, whatever its status, is not. Safe to load again on another exit
    // because this is a `Page.navigate`, a GET, for both methods (a reload key
    // included: see `reloadTarget`); nothing here re-sends a form.
    // Cut short by a cap rather than by the exit: nothing to count either way.
    if (committed === undefined && ceiling < NAVIGATE_COMMIT_CEILING_MS) {
      return { url: undefined, status: null };
    }
    const moved = exits?.settled?.({ resumeAt, committed, failure: committedFailure });
    if (moved !== undefined) throw moved;
    return { url: committed, status: committedStatus ?? null };
  }

  /** `fill`: the field's content replaced by `written`, typed through the hands. */
  async function performFill(ref: NodeRef, written: string): Promise<void> {
    const hands = requireHands('fill');
    // THE OUTBOUND HALF OF THE SUBSTITUTION BOUNDARY, and it is the last
    // line of our code before the credential is a `KeyEventParams.text`
    // on the CDP wire. Nothing above this statement — not the runtime,
    // not the loop, not the model client, not the step trace, not the
    // event stream, not the run row, not the replay — ever holds the
    // plaintext. It exists as a local in this block and is unreachable
    // when the block ends.
    //
    // A run granted nothing types what the model wrote, verbatim, which
    // is what every fill has always done. A run that WAS granted secrets
    // and whose text names a handle it does not hold throws rather than
    // typing the literal `{{secret:...}}` into the field: that string in
    // a card input is a checkout attempt the model would read as having
    // landed, and the shape a page's prompt injection takes.
    //
    // `await` before `DOM.focus`, deliberately. A round trip to the
    // control plane is 5-40 ms and it must not happen with the page
    // already focused and the freeze already taken — a refusal after the
    // focus costs the caller a page it then cannot use, which is the same
    // argument `requireHands` above makes for refusing before its own
    // first round trip.
    // `ref` goes with it: the element the value is typed into is the one place
    // a card's short parts (an expiry, a postcode) can be concealed again. And
    // THIS TAB's top-level origin, read from the page and never from the
    // model: a card is revealed only into an open purchase made for that site,
    // a payment provider's iframe under it included.
    const masking = tab?.masking;
    const text = masking?.reveal === undefined ? written : await masking.reveal(written, ref);
    const { page: session, backendNodeId: named } = await sessionFor(ref);
    const namedElement = await elementOf(session, named).catch(() => undefined);
    // TEXT INSIDE A FIELD IS TYPED INTO THE FIELD. A node that takes typing
    // itself (a native field, an editable region's root, a text-field role)
    // is typed into as named. Anything else is resolved, in the look world, to
    // the editable region it is in or the text field enclosing it: a rich-text
    // editor's paragraph or text, a placeholder's text. Text that no field
    // encloses is refused rather than handed to `DOM.focus`, whose "Node is not
    // an Element" told the model nothing (dev it-17.r1, 2026-10-14). An element
    // with no field around it is typed into as before.
    let id = named;
    const editable = namedElement?.attribute('contenteditable');
    if (
      namedElement !== undefined &&
      (namedElement.text || namedElement.tag !== '') &&
      !/^(input|textarea|select)$/.test(namedElement.tag) &&
      (editable === undefined || editable === 'false') &&
      !/^(textbox|searchbox|combobox|spinbutton)$/.test(namedElement.attribute('role') ?? '')
    ) {
      const frameId = await frameIdOf(session, ref).catch(() => undefined);
      const host =
        frameId === undefined
          ? undefined
          : await inLookWorld(session, frameId, { on: named, declaration: EDITABLE_HOST, returns: 'node' }).catch(() => undefined);
      if (typeof host === 'number') id = host;
      else if (namedElement.text) throw new TextTargetError('fill', ref);
    }
    // A field about to hold a secret is registered BEFORE its first keystroke,
    // so no capture of this tab — replay frame, vision screenshot, look — shows
    // it unmasked, and the live view stops streaming the tab (`capture-mask.ts`,
    // `live-video.ts`). The registry holds the node, never the value.
    if (text !== written) masking?.concealed?.(session, id);
    // A popup `<select>` is not typed into. A space outside a type-ahead run
    // opens its native menu, and on macOS so do the arrow keys
    // (`MenuListSelectType::ShouldOpenPopupForKeyPressEvent`,
    // `LayoutThemeMac::PopsMenuByArrowKeys`), and that menu wedges the browser
    // (see `NativeSelectPopupError`). Filling one means choosing what it names.
    const element = id === named ? namedElement : await elementOf(session, id).catch(() => undefined);
    if (element !== undefined && opensPopupMenu(element)) {
      await asWritten(written, text, () => performSelect(ref, text));
      return;
    }
    // A native date/time input is filled segment by segment: see
    // `nativeDatePlan`. Gated on what the element already said it is, so a
    // text field pays nothing for it.
    if (
      element !== undefined &&
      (element.attribute('role') === 'spinbutton' ||
        (element.tag === 'input' && nativeDateKind(element.attribute('type') ?? '') !== undefined))
    ) {
      const plan = await nativeDatePlan(session, ref, id, text);
      if (plan !== undefined) {
        for (const [segment, keys] of plan) {
          await session.send('DOM.focus', { backendNodeId: segment });
          await dispatchGesture(await hands.type(keys, { replace: false }), session);
        }
        return;
      }
    }
    await session.send('DOM.focus', { backendNodeId: id });
    // PER-CHARACTER KEY EVENTS. This was one `Input.insertText`, which
    // put the whole string in at once with no `keydown`, no `keyup` and
    // no timing — a page listening for keystrokes saw a value appear from
    // nowhere, which is every form fill this agent has ever done.
    //
    // The comment that used to sit here defended `insertText` against
    // `Runtime.evaluate` setting `.value`, and that argument was correct
    // and still is: a JS-assigned value fires no `input` event, so every
    // React-controlled field reverts it on the next render. It simply
    // never argued for `insertText` over real keystrokes, which fire
    // `input` for free and are better than both.
    //
    // THE SELECT-ALL CHORD ONLY WHERE THERE IS TEXT TO SELECT. A fill replaces
    // what a text field holds, so its typing opens with Cmd/Ctrl+A. Focus in
    // anything else — a date input's Month/Day/Year segment above all — has no
    // text of its own for the chord to select, and the browser selects the
    // whole DOCUMENT instead. MEASURED 2026-10-01 on the fleet rig
    // (`probe-fill-formik.ts`): after the three date fills 253 characters of
    // the page were selected, `selectionchange` fired on the document each
    // time, and BU Bench runs 22, 27 and 77 replayed with every word on the
    // page highlighted — a modifier chord no person presses on a date field,
    // leaving a mark any page can read. A segment needs no clearing: its
    // typed digits replace what it held. Undeterminable (a frame, a closed
    // shadow root, a session whose frame this world cannot name) keeps the
    // chord, which is what every fill did before.
    const takes =
      (await frameIdOf(session, ref)
        .then((frameId) =>
          frameId === undefined
            ? undefined
            : inLookWorld(session, frameId, { on: id, declaration: FOCUS_TAKES_TEXT, returns: 'value' }),
        )
        .catch(() => undefined)) ?? 'unknown';
    await dispatchGesture(await hands.type(text, { replace: takes !== 'other' }), session);
  }

  /**
   * A native `<select>`, chosen through the element: `'native'` once it is
   * applied, `'custom'` when the node is not a native select or one of its
   * options, and a throw when it is one and the choice cannot be made.
   *
   * `value` null means "the option this ref names", which is what a click on
   * a native option asks for; otherwise see {@link nativeSelect} for how the
   * option is matched.
   *
   * ── NOTHING RUNS IN THE PAGE'S WORLD, AND A PERSON'S KEYS MAKE THE CHOICE ──
   *
   * This used to resolve the node with `DOM.resolveNode` and no context, which
   * is the page's MAIN world, and there read `options`, every option's `value`
   * and `label`, set `selected` and dispatch `input` and `change` itself.
   * MEASURED on production 2026-10-07 04:12Z and 04:18Z (n=2, `oc-isolate-probe`
   * `/sel`, a page hooking its own prototypes): 29 hooked calls per select with
   * our function's own source on the stack, and both events `isTrusted: false`.
   *
   * Now the option is worked out in the look world, and chosen the way a
   * person chooses one without opening the menu: the select is focused and the
   * first letters of the option are typed. Blink's type-ahead moves the choice
   * and fires `input` and `change` itself, trusted. MEASURED on the fleet
   * binary 2026-10-07 04:25Z (n=1, `/sel`, keys `n`,`e`,`w` on a focused
   * select): New Zealand chosen, every keydown, keypress, `input` and `change`
   * `isTrusted: true`, no menu opened.
   *
   * NO WHITESPACE IS EVER TYPED, and no arrow or Return: on macOS a space
   * outside a type-ahead run, the arrows and Return open the OS-drawn menu,
   * which wedges the browser (see {@link NativeSelectPopupError}). A label whose
   * shortest reachable prefix needs a space, an unfocusable or disabled select,
   * and a host with no hands get the remainder: `selected` set in the look
   * world with untrusted events, which still keeps every read out of the page.
   * The choice is CHECKED after the keys, because a pause over a second resets
   * Blink's type-ahead buffer mid-prefix, and a run that landed elsewhere gets
   * the remainder too rather than reading as a success.
   */
  async function performSelect(ref: NodeRef, value: string | null): Promise<'native' | 'custom'> {
    const found = await inSelectWorld(ref, nativeSelect(value, 'plan'));
    if (found === undefined) {
      throw new Error(`select(${JSON.stringify(value)}) did not apply: the element did not resolve in its document`);
    }
    const { target, frameId, id, outcome: plan } = found;
    const field = (outcome: unknown, key: string): unknown =>
      typeof outcome === 'object' && outcome !== null && key in outcome ? (outcome as Record<string, unknown>)[key] : undefined;
    if (field(plan, 'custom') === true) {
      return 'custom';
    }
    if (field(plan, 'ok') !== true) {
      // A select that did not change is a step that reads as a success and
      // then fails three steps later on a page in the wrong state.
      throw new Error(`select(${JSON.stringify(value)}) did not apply: ${String(field(plan, 'why') ?? 'unknown')}`);
    }
    if (field(plan, 'already') === true) {
      return 'native';
    }
    const keys = field(plan, 'keys');
    const hands = options.hands;
    if (typeof keys === 'string' && keys !== '' && hands !== undefined) {
      // The SELECT takes focus, also when the ref is one of its options.
      const select = await inLookWorld(target, frameId, { on: id, declaration: SELECT_OF, returns: 'node' });
      if (typeof select === 'number') {
        await target.send('DOM.focus', { backendNodeId: select });
        await dispatchGesture(await hands.type(keys, { replace: false }), target);
        const chosen = await inLookWorld(target, frameId, { on: id, declaration: nativeSelect(value, 'check'), returns: 'value' });
        if (field(chosen, 'ok') === true) {
          return 'native';
        }
      }
    }
    const set = await inLookWorld(target, frameId, { on: id, declaration: nativeSelect(value, 'set'), returns: 'value' });
    if (field(set, 'ok') !== true) {
      throw new Error(`select(${JSON.stringify(value)}) did not apply: ${String(field(set, 'why') ?? 'unknown')}`);
    }
    return 'native';
  }

  /**
   * `declaration` run on `ref` in the look world of the document the node is
   * in: the session's own frame when `frameIdOf` can name it, else whichever
   * frame of the session the node resolves in (a same-process child frame).
   * `undefined` when it resolves in none.
   */
  async function inSelectWorld(
    ref: NodeRef,
    declaration: string,
  ): Promise<{ readonly target: CdpPage; readonly frameId: string; readonly id: number; readonly outcome: unknown } | undefined> {
    const { page: target, backendNodeId: id } = await sessionFor(ref);
    const own = await frameIdOf(target, ref);
    let frames: readonly string[];
    if (own === undefined) {
      const tree = (await target.send('Page.getFrameTree'))['frameTree'];
      const root = typeof tree === 'object' && tree !== null && 'frame' in tree ? tree.frame : undefined;
      const rootId = typeof root === 'object' && root !== null && 'id' in root ? root.id : undefined;
      frames = [...(typeof rootId === 'string' && rootId !== '' ? [rootId] : []), ...childFrameIds(tree)];
    } else {
      frames = [own];
    }
    for (const frameId of frames) {
      const outcome = await inLookWorld(target, frameId, { on: id, declaration, returns: 'value' });
      if (outcome !== undefined) return { target, frameId, id, outcome };
    }
    return undefined;
  }

  /**
   * THE PRIVATE HALF OF A CONCEALED FIELD'S CHECK (`AgentDeps.holds`):
   * whether `ref` holds `written`, decided here on reads no model, step or log
   * is handed, and answered as a boolean alone.
   *
   * A placeholder is compared as the value this run revealed into that field
   * (`SecretVault.compareWritten`: no new reveal, no gate, nothing spent).
   * A native `<select>` is asked in the look world whether the option the
   * text names — by value, label or a code's name, exactly as
   * {@link performSelect} matched it — is the chosen one; anything else is
   * read off the unconcealed tree ({@link observe}) by `heldPrivately`, the
   * runtime's own normalisation with equality in place of a substring.
   */
  async function holds(ref: NodeRef, written: string): Promise<boolean | undefined> {
    const compare = async (typed: string): Promise<boolean> => {
      const chosen = (await inSelectWorld(ref, nativeSelect(typed, 'check')))?.outcome;
      if (isRecord(chosen) && chosen['custom'] !== true) return chosen['ok'] === true;
      return heldPrivately(await observe(false), ref, typed);
    };
    const check = tab?.masking?.compareWritten;
    return check === undefined ? compare(written) : check(ref, written, compare);
  }

  /**
   * `AgentDeps.refusedSubmit`: the form a click or Enter on `ref` sends, when
   * the browser's own validation refuses it. One read in the look world (see
   * {@link refusedSubmit}): properties only, so the page sees no event, no
   * call into its own script and no global (probed on stock Chromium by
   * `stock-chromium.test.ts`). Anything unreadable answers `undefined`.
   */
  async function refusedSubmitOf(ref: NodeRef, by: 'click' | 'enter'): Promise<RefusedSubmit | undefined> {
    const read = (await inSelectWorld(ref, refusedSubmit(by)))?.outcome;
    if (!isRecord(read) || !Array.isArray(read['fields'])) return undefined;
    const fields = read['fields']
      .filter(isRecord)
      .map((field) => ({
        label: typeof field['label'] === 'string' ? field['label'] : '',
        message: typeof field['message'] === 'string' ? field['message'] : '',
      }))
      .filter((field) => field.message !== '');
    return fields.length === 0 ? undefined : { fields, focused: read['focused'] === true };
  }

  /**
   * A select on something that is NOT a native `<select>`: an ARIA combobox,
   * a listbox, or one of their options. Driven the way a person drives one,
   * through the same hands every other input takes, and then checked.
   *
   * MEASURED, 30 days to 2026-09-24: 14 `select` steps over 8 runs refused
   * `not a <select>` — react-select state pickers (run_ba7dbb69,
   * run_ab72032c), Shopify's address autocomplete (run_7a5a71e5,
   * run_b6512e00), Bing Maps suggestions (run_5a1c6fbb) — and the model spent
   * up to four steps each learning that the verb did not exist for them.
   *
   * 1. An option already on screen with the wanted name is clicked.
   * 2. Otherwise the control is clicked open; failing an option, a control
   *    that takes text has the value typed into it, which is how an
   *    autocomplete is asked for its list.
   * 3. The page runs while the list is waited for — a list rendered by a
   *    timer or a fetch never arrives under the freeze — and the freeze is
   *    back before anything is read to act on.
   * 4. The choice is CHECKED: the control reads the value, the option reads
   *    selected, or the value's text appears outside the list where it did
   *    not before. A click that changed nothing is refused as a failure.
   *
   * Its reads are UNCONCEALED ({@link observe}): a list a secret is chosen
   * from is a field the concealed tree reads whole, options dropped. Nothing
   * read here leaves this function, and its refusals name only `value`, which
   * `asWritten` turns back into what the model wrote.
   */
  async function performListSelect(ref: NodeRef, value: string): Promise<void> {
    const want = normalisedName(value);
    // A state, province or country code, failing an exact name: the one
    // option labelled with its name ("CA" chooses "California"). See
    // `optionAliases`; before the substring rule, which "ca" would satisfy
    // in California, Carolina and Canada alike and so choose nothing.
    const aliases = optionAliases(value).map(normalisedName);
    const optionIn = (tree: AxTree): AxNode | undefined => {
      const options = walk(tree).filter((node) => LIST_OPTION_ROLES.has(node.role) && node.name !== undefined);
      const exact = options.find((node) => normalisedName(node.name ?? '') === want);
      if (exact !== undefined) {
        return exact;
      }
      const named = options.filter((node) => aliases.includes(normalisedName(node.name ?? '')));
      if (named.length === 1) {
        return named[0];
      }
      const partial = options.filter((node) => normalisedName(node.name ?? '').includes(want));
      return partial.length === 1 ? partial[0] : undefined;
    };

    const before = await observe(false);
    const control = findNode(before, ref);
    let option = control !== undefined && LIST_OPTION_ROLES.has(control.role) ? control : optionIn(before);
    if (option === undefined) {
      await performPointer({ type: 'click', ref });
      option = await waitForOption(optionIn);
    }
    if (option === undefined && control !== undefined && TYPED_LIST_ROLES.has(control.role)) {
      await performFill(ref, value);
      option = await waitForOption(optionIn);
    }
    if (option === undefined) {
      throw new Error(
        `select(${JSON.stringify(value)}) did not apply: the ${control?.role ?? 'control'} was opened ` +
          `and no option named ${JSON.stringify(value)} appeared. Nothing was chosen.`,
      );
    }

    await performPointer({ type: 'click', ref: option.ref });
    await whileLive(() => clock.sleep(LIST_SELECT_SETTLE_MS));
    const after = await observe(false);

    const controlNow = findNode(after, ref);
    const optionNow = findNode(after, option.ref);
    const shown =
      normalisedName(controlNow?.value ?? '').includes(want) ||
      (aliases.includes(normalisedName(option.name ?? '')) && normalisedName(controlNow?.value ?? '').includes(normalisedName(option.name ?? ''))) ||
      optionNow?.state?.selected === true ||
      textOutsideLists(after, want) > textOutsideLists(before, want);
    if (!shown) {
      throw new Error(
        `select(${JSON.stringify(value)}) did not apply: the option was clicked, and afterwards ` +
          'the control does not show it chosen.',
      );
    }
  }

  /** Polls for `find` to answer with the page LIVE, then freezes it again. */
  async function waitForOption(find: (tree: AxTree) => AxNode | undefined): Promise<AxNode | undefined> {
    await whileLive(async () => {
      // Counted in polls rather than against `clock.now()`, so the bound
      // holds under an injected clock whose time does not move.
      for (let poll = 0; poll * LIST_OPTION_POLL_MS < LIST_OPTION_WAIT_MS; poll += 1) {
        await clock.sleep(LIST_OPTION_POLL_MS);
        if (find(await observe(false)) !== undefined) {
          return;
        }
      }
    });
    // Read again under the freeze: a ref acted on must come from a frozen read.
    return find(await observe(false));
  }

  /**
   * Put an uploaded file into a file input.
   *
   * The file port stages an owned copy until this browser attempt closes.
   * Chromium only keeps the path here, not the bytes: on the production fleet
   * (2026-10-01), deleting it after the reply made File.size read 0 and
   * File.text() reject NotFoundError. A filename in AX is not an upload.
   */
  async function performAttachFile(ref: NodeRef, fileId: string): Promise<void> {
    const files = options.files;
    if (files === null) {
      throw new FilesUnavailableError(
        'this run was granted no files. A file is handed to a run with POST ' +
          '/v1/agent/{id}/files, which answers the handle attachFile takes.',
      );
    }
    // Resolved BEFORE the node round trip, on the rule `performPointer` and
    // the `press` case both state: a refusal that has already touched the page
    // costs the caller a page it cannot then use — and on a frozen page it has
    // spent the freeze too.
    const path = await files.stage(fileId);
    if (path === undefined) {
      throw new FilesUnavailableError(
        `no file ${fileId} on this run. Name a file the run holds by the handle listed beside it or by its ` +
          'exact name. A file reaches a run through POST /v1/agent/{id}/files, createFile, or a download in the ' +
          'browser once it is stored, and is destroyed when its run ends.',
      );
    }

    const { page: target, backendNodeId: named } = await sessionFor(ref);
    const id = await fileInputNear(target, ref, named);
    await target.send('DOM.setFileInputFiles', { backendNodeId: id, files: [path] });
  }

  /**
   * The `<input type=file>` the model MEANT when it named something else.
   *
   * A styled upload control hides its input (`opacity: 0`, `display: none`,
   * off-screen) behind a button or a label, and the accessibility tree the
   * model reads shows the button. `DOM.setFileInputFiles` on that button
   * answers "Node is not a file input element" — measured on production
   * 2026-10-01, BU Bench V1 task 37 (material-ui form, run_d0cd2ec3), where
   * the run then gave up on a form it had otherwise filled.
   *
   * So: the node itself when it is a file input; else the control of a
   * `<label>`; else the one file input inside it; else the one file input
   * within three ancestors. "The one": a region holding two inputs is
   * ambiguous, and the original node is kept so the browser's own refusal
   * reaches the model rather than a guess reaching the wrong field. The same
   * search browser-use runs (`find_file_input_near_element`, browser-use
   * 0.11.5 `tools/service.py`).
   *
   * Read in the isolated look world (`inLookWorld`): the page's own script
   * sees none of it. A node in a child frame keeps the ref as given.
   */
  async function fileInputNear(session: CdpPage, ref: NodeRef, backendNodeId: number): Promise<number> {
    const frameId = await frameIdOf(session, ref);
    if (frameId === undefined) return backendNodeId;
    const found = await inLookWorld(session, frameId, {
      on: backendNodeId,
      declaration: FILE_INPUT_NEAR,
      returns: 'node',
    });
    return typeof found === 'number' ? found : backendNodeId;
  }

  /** What a scrolled pane leaves showing of `ref`: `VISIBLE_PART`, read in the look world of `ref`'s own frame. */
  async function visiblePart(ref: NodeRef): Promise<HandsTarget | undefined> {
    const { page: session } = await sessionFor(ref);
    const frameId = await frameIdOf(session, ref);
    if (frameId === undefined) return undefined;
    return visibleFrom(await inLookWorld(session, frameId, { on: ref.backendNodeId, declaration: VISIBLE_PART, returns: 'value' }));
  }

  // The camera: the set-of-marks capture and `page.look`'s reads (`./camera`).
  const { capture, lookShoot, shootElement, lookLocate } = pageCamera({
    page,
    clock,
    snapshot,
    maskedShot,
    sessionFor,
    boxOf,
    sessionFrame,
    visiblePart,
  });

  const bound: AgentDeps = {
    snapshot,
    holds,
    refusedSubmit: refusedSubmitOf,
    capture,
    /**
     * THE DOCUMENT, FOR THE SETTLE'S CHALLENGE GATE.
     *
     * Bound unconditionally, like `snapshot`: a real CDP page can always
     * answer this, and the optionality on `AgentDeps` is there for the tests
     * and benches that drive the loop without a browser.
     *
     * The SAME read the scrape path makes — `readDocument` from
     * `./render-deps`, one `Runtime.evaluate` returning `outerHTML` plus
     * `innerText.length` — and the same floor, so the agent path and the
     * render path cannot disagree about what an interstitial is. The loop
     * spends it only on a settled tree with less content than the floor, so an
     * ordinary page costs nothing; see `./settle` in `@outcrawl/runtime`.
     */
    document: {
      textFloor: DEFAULT_MIN_TEXT_LENGTH,
      read: async () => {
        await scrubbed;
        return await readDocument(page);
      },
      // Bounded by MAX_PARSE_WAIT_MS from the commit, so a lost
      // `DOMContentLoaded` costs one settle that much and never more.
      parsing: () => parsingSince !== undefined && clock.now() - parsingSince < MAX_PARSE_WAIT_MS,
      lastNetworkAt: () => lastNetworkAt,
    },
    pageEvents: (): readonly string[] => pageEvents.splice(0),

    async lock(): Promise<void> {
      await sendFreeze(flavor.lock, lockParams);
    },

    async unlock(): Promise<void> {
      loopReleases += 1;
      await sendFreeze(flavor.unlock);
    },

    async perform(action: Action, signal?: AbortSignal, allowanceMs?: number): Promise<PerformOutcome | void> {
      // Read BEFORE the switch narrows, so the `default` arm below has a name
      // to report without asserting a shape onto a `never`. `ActionType` is a
      // string union, so this is the verb and nothing else — never a field of
      // the action, which could carry a customer's text.
      const verb: string = action.type;
      // What the tab already shows may move the run before anything acts on it.
      await tab?.exits?.beforeAction?.();
      switch (action.type) {
        case 'navigate': {
          // See `loadDocument`, which a reload key shares. Read before the
          // load: the navigate's own commit clears it.
          const midForm = formTouched;
          const enteredAt = clock.now();
          const first = await loadDocument(action.url, { method: 'navigate', verb: `navigate(${action.url})` });
          // The exit hook judges what landed, and may load it again.
          const landed = await tab?.exits?.landed?.({ target: action.url, first, allowanceMs, enteredAt, midForm });
          const committed = (landed ?? first).url;
          // The commit's own url, which is what survives a redirect chain: the
          // last `frameNavigated` before the poll broke is the document that is
          // there now. `page.url()` remains the answer for a navigation that
          // never committed, where it is the only url anybody has.
          return { url: committed ?? page.url() };
        }

        case 'press': {
          // A RELOAD KEY IS A GET OF THE DOCUMENT'S URL, for every planner
          // that can choose one, and the same thing the brain does with it
          // (`reloadAsNavigate`). Sent as a key event it reaches the page's
          // `keydown` and never the browser's accelerator, so it reloads
          // nothing (MEASURED, see `isReloadKey`); F5 and Ctrl/Cmd+R were
          // refused outright as unknown keys (7 production F5 presses in the
          // 14 days to 2026-10-03, every one an error).
          //
          // NEVER `Page.reload`: DevTools reloads without the repost check,
          // so a page a form POST made would be POSTED AGAIN — an order placed
          // twice, past the irreversible mark that guards only Enter. And on
          // an error page it is the FAILED url that is reloaded, which
          // `page.url()` (`chrome-error://chromewebdata/`) does not name, so
          // the exit pre-check and the tunnel diagnosis would look at the
          // wrong host. Hence `reloadTarget`, and `loadDocument`'s own checks.
          if (isReloadKey(action.key)) {
            const at = await reloadTarget();
            if (at === undefined || !/^https?:/.test(at)) {
              throw new Error(
                `press(${JSON.stringify(action.key)}) reloads a web page, and this tab shows ` +
                  `${at === undefined ? 'no document' : JSON.stringify(at.split(/[?#]/)[0])}, which is not one. ` +
                  'Navigate to the page you want instead.',
              );
            }
            const committed = (await loadDocument(at, { method: 'reload', verb: `reload of ${at}` })).url;
            return { url: committed ?? page.url() };
          }
          // Refused before the focus round trip, for the same reason
          // `performPointer` refuses before its own: a refusal that has already
          // touched the page costs the caller a page it cannot then use.
          const hands = requireHands('press');
          let session = page;
          if (action.ref !== undefined) {
            const resolved = await sessionFor(action.ref);
            session = resolved.page;
            await session.send('DOM.focus', { backendNodeId: resolved.backendNodeId });
          }
          await dispatchGesture(await hands.press(action.key), session);
          return;
        }

        case 'fill': {
          formTouched = true;
          await performFill(action.ref, action.text);
          return;
        }

        case 'select': {
          formTouched = true;
          // A card's expiry is often two <select>s, so a select substitutes a
          // placeholder exactly as a fill does, and remembers the element for
          // concealment. The selects below name the value they could not
          // choose in their refusals; the model wrote a placeholder, so that is
          // what a refusal says back.
          const masking = tab?.masking;
          const value =
            masking?.reveal !== undefined && masking.names?.(action.value) === true
              ? await masking.reveal(action.value, action.ref)
              : action.value;
          if (value !== action.value) {
            // Registered before it is chosen, as a fill is: see `performFill`.
            const { page: owner, backendNodeId } = await sessionFor(action.ref);
            masking?.concealed?.(owner, backendNodeId);
          }
          await asWritten(action.value, value, async () => {
            if ((await performSelect(action.ref, value)) === 'custom') {
              // A segment of a native date or time input has no options: a
              // person chooses its value by typing it, which is a fill. MEASURED
              // 2026-10-13 (form-fill-a1..a3, stock Chromium): 3 of 3 runs
              // first asked to select "7" in httpbin's Hours segment and were
              // refused "no option named "7" appeared".
              if (await isNativeDateField(action.ref)) await performFill(action.ref, action.value);
              else await performListSelect(action.ref, value);
            }
          });
          return;
        }

        case 'attachFile':
          await performAttachFile(action.ref, action.file);
          return;

        case 'click':
        case 'hover':
        case 'scroll':
          return performPointer(action);

        case 'drag':
          await performDrag(action);
          return;

        case 'wait':
          // The page runs for the wait and is frozen again after it — see
          // `WaitAction` in @outcrawl/runtime. No input, no script, no request:
          // the page observes only time passing, as it would with a person.
          //
          // `signal` ends it early — the loop's cancel, a drain, a human taking
          // the page, a hold — and it ends QUIETLY: the loop decides what the
          // interruption means, and the freeze goes back up (or not, if the
          // loop released it to a human) exactly as after a full wait.
          await whileLive(() => sleepUnlessAborted(clock.sleep(action.seconds * 1_000), signal));
          return;

        case 'extract':
        case 'done':
        case 'fail':
          throw new UnperformableActionError(action.type);

        case 'openTab':
        case 'focusTab':
        case 'closeTab':
        case 'ask':
        case 'callTool':
        case 'createFile':
        case 'purchase.begin':
        case 'purchase.end':
          /*
           * PERFORMED ELSEWHERE, and that is a different fact from
           * unperformable.
           *
           * Every one of these is dispatched by `@outcrawl/runtime`'s own
           * `switch (action.type)` in `loop.ts`, ABOVE its
           * `default: page.perform`: the three tab verbs go to `AgentDeps.tabs`,
           * `ask` parks the run, `callTool` reaches a connector through the
           * broker, and `createFile` writes through `AgentDeps.files.create`.
           * None touches this page binding, so none ever arrives here.
           *
           * The three tab verbs were found by the `default` below the moment it
           * was written, which is the fix earning its keep on its first run:
           * they had been absent from this switch since tabs shipped, and the
           * only thing standing between that and a silent no-op was the runtime
           * happening to dispatch them first. Nothing in this file said so.
           *
           * Listed so the `default` can be a `never` check rather than a
           * catch-all.
           *
           * THE TRAP THIS ARM EXISTS TO STOP: a verb executed elsewhere
           * belongs in the RUNTIME's dispatch above `default: page.perform`;
           * only a verb that genuinely cannot be performed on a page belongs
           * in the throw list above. Verb seventeen will hit the compile error
           * below, and the tempting fix — adding it to
           * `UnperformableActionError` — moves the failure to the wrong layer
           * and tells the model a lie about why its action did not happen.
           */
          throw new UnperformableActionError(
            `${action.type} (dispatched by the runtime, never through the page binding)`,
          );

        default: {
          /*
           * EXHAUSTIVENESS, and it is load-bearing because of the return type
           * rather than in spite of it.
           *
           * `perform` answers `Promise<PerformOutcome | void>`, so before this
           * existed a verb added to the `Action` union with no case here fell
           * off the end of the case list and returned `undefined` — which the
           * loop reads as a SUCCESSFUL NO-OP. The agent then reports success
           * for an action that did nothing, which is the exact shape of defect
           * this codebase spent 2026-09-08 removing: the failing state
           * rendering identically to the passing state from the only vantage
           * anyone checks from.
           *
           * A growing union is not a silent-failure generator on its own. A
           * growing union PLUS a void-tolerant return type is. This assignment
           * is what converts the next one into a compile error.
           */
          const unreachable: never = action;
          void unreachable;
          throw new UnperformableActionError(verb);
        }
      }
    },

    async extract(
      schema: JsonSchema | undefined,
      instruction?: string,
      framing?: string,
      allowance?: ExtractBound,
      selection?: ExtractSelection,
    ): Promise<ExtractOutcome> {
      const model = options.model;
      // Checked before the snapshot. A refusal that costs a `getAXTree` round
      // trip first has already spent browser time on a page it will not use,
      // and on a frozen page it has spent the freeze too.
      if (model === null) {
        throw hooks.modelUnavailable?.('extract') ?? new NoModelError('extract');
      }
      const conceal = tab?.masking?.conceal;
      const concealed = (text: string): string => (conceal === undefined ? text : conceal(text));
      // A tab showing a PDF is read from the PDF's own text, not from its
      // tree, which is the viewer's toolbar: see `./pdf-document.ts`. One that
      // cannot be read (no copy kept, encrypted, a scan) falls through to the
      // tree, whose first line says why.
      const document = await pdf.read();
      // A large plain-text file is read from its own text too, never from a
      // tree: see `./text-document.ts`.
      const large = document === undefined ? await textFile.large() : undefined;
      let content: ExtractContent;
      if (document?.outcome === 'read') {
        content = { kind: 'markdown', markdown: concealed(pdfMarkdown(document)) };
      } else if (large !== undefined) {
        content = { kind: 'markdown', markdown: concealed(textDocumentMarkdown(large)) };
      } else {
        // Where links go, only when this extraction asks for a destination: see
        // `./link-hrefs.ts` for what that costs and why the page cannot see it
        // being read. `snapshot()` has already concealed the tree, and a second
        // `concealTree` would rewrite its placeholders, so only the added
        // destinations are concealed.
        const shown = await snapshot();
        const tree = asksForDestination(instruction, schema)
          ? await withLinkHrefs(shown, {
              owner: sessionFor,
              top: page,
              axTree: (session) => flavor.axTree(session, { maxNodes: SNAPSHOT_MAX_NODES }),
              conceal: concealed,
              clock,
            })
          : shown;
        content = { kind: 'tree', tree };
      }
      // Every field named, none spread conditionally. `ExtractInput` is
      // required-and-nullable throughout precisely because this call used to
      // omit `markdown` while the client read only `markdown`: the model was
      // asked about a page whose content was the string "undefined".
      //
      // The run's `framing` is appended HERE, after `asksForDestination` read
      // the instruction: it is the task, and a task that mentions a website
      // must not open the destination read for an extraction that asked for
      // no link (see `AgentDeps.extract`).
      const output = await model.extract({
        instruction: framedInstruction(instruction, framing) ?? null,
        schema: schema ?? null,
        content,
        ...(selection === undefined ? {} : { selection }),
        // What this extraction may spend (OC-284). The client cuts a page over
        // it and says so; the cut comes back on `cut` for the step record.
        ...(allowance === undefined ? {} : { maxUsd: allowance.maxUsd }),
      });
      return {
        data: output.data,
        ...(output.usage === undefined ? {} : { usage: output.usage }),
        ...(output.cut === undefined ? {} : { cut: output.cut }),
      };
    },

    async model(prompt: AgentPrompt): Promise<ModelChoice> {
      const model = options.model;
      if (model === null) {
        throw hooks.modelUnavailable?.('model') ?? new NoModelError('model');
      }
      return model.choose(prompt);
    },

    async suggestSchema(task: string): Promise<JsonSchema | null> {
      /*
       * `null` on every absence, and deliberately NOT the
       * `ModelUnavailableError` that `model` throws one method up. The
       * difference is what the run can still do: a run with no model cannot
       * take a single action and has to fail loudly, whereas a run that merely
       * cannot be offered a guessed schema is a run that works perfectly.
       *
       * Three absences collapse to the same answer on purpose — no model bound
       * at all, a port that predates this method, and a port that answered
       * with nothing usable. The loop treats `null` as "no suggestion" in one
       * branch, so there is nothing here for a caller to distinguish.
       */
      return (await options.model?.suggestSchema?.(task)) ?? null;
    },

    /*
     * THE TWO SEAMS THE MODEL IS TOLD ABOUT, and both were built and unbound.
     *
     * `tools` is where `callTool` goes; `files` is the manifest the prompt
     * names an uploaded file from. Neither is used by anything in this file —
     * `perform` refuses `callTool` as performed-elsewhere, and `attachFile`
     * reads `options.files` directly for the BODY — and that is exactly why
     * they have to be here: the loop reads them off `AgentDeps` to decide what
     * the model is offered. Without these two lines the port and the manifest
     * exist on this host and no prompt ever mentions them.
     *
     * Spread rather than assigned, on the rule stated for `solveChallenge`
     * below: the loop tests both fields for `undefined`, so a property whose
     * value is `null` would satisfy the check and then be called.
     */
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.files === null ? {} : { files: options.files }),
    // Absent is "this run does not solve", and it must not reach `AgentDeps`
    // as a property whose value is undefined: `PageSession.solve` tests the
    // field for `undefined`, so only a real solver is spread in.
    ...(hooks.solveChallenge === undefined ? {} : { solveChallenge: hooks.solveChallenge }),
    ...(options.pageLoads === undefined ? {} : { pageLoads: options.pageLoads }),
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
  };
  const findTextCaptcha = tab?.captcha?.findTextCaptcha;
  cameras.set(bound, {
    shoot: lookShoot,
    locate: lookLocate,
    shootElement,
    ...(findTextCaptcha === undefined ? {} : { findTextCaptcha }),
  });
  scriptRunners.set(bound, pageScriptRunner(page));
  const hands = options.hands;
  const siteCheck = tab?.captcha?.siteCheck;
  if (hands !== undefined && siteCheck !== undefined) {
    siteChecks.set(bound, { solve: () => siteCheck.solve(hands), sight: () => siteCheck.sight() });
  }
  return bound;
}
