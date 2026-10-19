import { DEFAULT_MIN_TEXT_LENGTH, type JsonSchema } from '@outcrawl/scout-core';
import type { Action, AgentDeps, AgentPrompt, AxTree, ExtractBound, ExtractOutcome, ExtractSelection, ModelChoice, NodeRef, PageView, PerformOutcome, RefusedSubmit, SettledDocument, TabControl, TabId, TabInfo, TabPage } from '@outcrawl/runtime';
import { CrossFrameRefError } from './errors';
import type { BindingOptions } from './options';
import { fanHolds } from './input';
import { cameras, pageBinding, scriptRunners, siteChecks, type BindingCamera, type BindingSiteCheck } from './page-binding';
import { TabLostError, UnknownTabError, WrongTabRefError, type AgentTab, type AgentTabs, type TabLoss } from './tabs';

/**
 * `AgentDeps` over a set of tabs: one {@link pageBinding} per tab, and a router
 * that follows the focused one.
 *
 * ## The freeze is per tab, and that is the point
 *
 * `Outcrawl.lock` is a command on one flat session, so it freezes one tab's
 * renderer and nothing else. There is deliberately NO session-wide freeze:
 * background tabs run live between steps, which is what lets a checkout page
 * finish loading in tab 3 while the loop is reading tab 1, and the loop
 * re-snapshots at the top of every step so no reference ever crosses a step
 * boundary.
 *
 * What that costs is one invariant this router has to hold: `unlock()` must
 * release the tab `lock()` froze, NOT whatever is focused when `unlock()` is
 * called. A step may focus or open a tab while holding the freeze — the tab
 * actions are ordinary steps — so "unlock the active tab" would send
 * `Outcrawl.unlock` to a tab that was never locked and leave the frozen one
 * paused at `VirtualTimePolicy::kPause` for the rest of the run. That tab
 * would then never load, never fire a timer and never answer a snapshot, and
 * the run would look like a hung site. Hence {@link frozen}.
 *
 * ## Cross-tab references
 *
 * Nothing here has to prevent them: `pageBinding` already refuses a reference
 * whose frame ordinal is not its own session's, and ordinals are browser-global
 * `FrameTreeNodeId`s, so tab A's nodes cannot be mistaken for tab B's. This
 * router only improves the DIAGNOSIS — see {@link WrongTabRefError}.
 */
export function tabbedBinding(tabs: AgentTabs, options: BindingOptions): AgentDeps {
  /** One binding per tab, built on first use, dropped when the tab dies. */
  const bindings = new Map<TabId, AgentDeps>();
  /** Losses seen, so a refusal can say why a tab is gone rather than only that it is. */
  const losses = new Map<TabId, TabLoss>();
  /**
   * The tab `lock()` froze. Read by `unlock()` and by nothing else.
   *
   * Cleared when that tab is lost: a crashed renderer holds no lock, and
   * sending `Outcrawl.unlock` to a dead session would replace a real failure
   * with a CDP error from a `finally` block.
   */
  let frozen: AgentTab | null = null;

  tabs.onLost((loss) => {
    losses.set(loss.id, loss);
    bindings.delete(loss.id);
    if (frozen !== null && frozen.id === loss.id) {
      frozen = null;
    }
  });

  /**
   * The most recently built binding, kept after its tab dies ON PURPOSE.
   *
   * `AgentDeps.model` touches no page, so it must keep answering when the
   * focused tab is gone — that is precisely the moment the loop needs a model
   * call, because it has just been told a tab died and has to decide which tab
   * to continue on. Routing `model()` through the focused tab would refuse
   * exactly then and turn one lost tab into a lost run.
   */
  let lastBinding: AgentDeps | null = null;

  function bindingFor(tab: AgentTab): AgentDeps {
    const existing = bindings.get(tab.id);
    if (existing !== undefined) {
      return existing;
    }
    // `options` carries `tabs`, which `pageBinding` ignores: it is the router's
    // input, not a page's. Passing the same object keeps model, hands, solver,
    // clock and lock timeout identical on every tab, which is what makes a
    // fifth tab behave like the first.
    const built = pageBinding(tab.page, options);
    bindings.set(tab.id, built);
    lastBinding = built;
    return built;
  }

  /** The focused tab and its binding, or {@link TabLostError} if it is gone. */
  async function focused(): Promise<{ readonly tab: AgentTab; readonly deps: AgentDeps }> {
    const tab = await tabs.active();
    if (tab.state !== 'live') {
      throw new TabLostError(tab.id, tab.url(), losses.get(tab.id)?.cause ?? 'unknown');
    }
    return { tab, deps: bindingFor(tab) };
  }

  /**
   * Which live tab minted this ordinal, or `null`.
   *
   * Only ever called from a failure path, so the round trips it may cost are
   * paid by a step that has already failed.
   */
  async function ownerOf(frameOrdinal: number, active: AgentTab): Promise<AgentTab | null> {
    for (const tab of await tabs.list()) {
      if (tab.id === active.id || tab.state !== 'live') {
        continue;
      }
      try {
        if ((await tab.frameOrdinal()) === frameOrdinal) {
          return tab;
        }
      } catch {
        // A tab whose renderer will not answer cannot be identified, and this
        // is the diagnosis path for somebody else's failure. Keep looking.
      }
    }
    return null;
  }

  /**
   * Turns a frame refusal into a tab refusal, when it is one.
   *
   * A `CrossFrameRefError` on a multi-tab session is one of two very different
   * things: a reference from another TAB, which means "focus that tab", or a
   * reference from an out-of-process IFRAME in this tab, which means what it
   * has always meant. Only the first is re-labelled, because telling an iframe
   * refusal to go and focus a tab would send the loop hunting for a tab that
   * does not exist.
   */
  async function asTabRefusal(error: CrossFrameRefError, active: AgentTab): Promise<Error> {
    const owner = await ownerOf(error.ref.frameOrdinal, active);
    if (owner === null && losses.size === 0) {
      return error;
    }
    return new WrongTabRefError({
      ref: error.ref,
      refTab: owner === null ? null : owner.id,
      refTabUrl: owner === null ? null : owner.url(),
      activeTab: active.id,
      activeTabUrl: active.url(),
      cause: error,
    });
  }

  const control: TabControl = {
    /**
     * The open tabs, with the focused one flagged.
     *
     * `TabControl` deliberately has no `active()`: `TabInfo.active` already
     * carries focus, the loop calls this every step to render its open-tabs
     * block, and a second accessor would be a second answer to "which tab is
     * focused" that could disagree with this one.
     */
    async list(): Promise<readonly TabInfo[]> {
      const [live, active] = await Promise.all([tabs.list(), tabs.active()]);
      return live.map((tab) => {
        const title = tab.title();
        return {
          id: tab.id,
          url: tab.url(),
          ...(title === undefined ? {} : { title }),
          active: tab.id === active.id,
        };
      });
    },

    // Focused on return, which is the browser layer's contract and not this
    // router's choice: a model that had to spend a second step focusing the tab
    // it just opened would spend one per site, five times a task.
    async open(url: string): Promise<TabId> {
      return (await tabs.open(url)).id;
    },

    async focus(id: TabId): Promise<void> {
      await tabs.focus(id);
    },

    async close(id: TabId): Promise<void> {
      await tabs.close(id);
    },

    /**
     * ONE NAMED TAB, without focusing it. The fan's whole seam.
     *
     * The binding is `pageBinding` over that tab's own CDP session — the same
     * object the router would use if the tab were focused, from the same
     * `bindings` map, so a fifth tab behaves like the first and there is still
     * exactly one place that knows how a tab id maps to a session.
     *
     * `frozen` IS DELIBERATELY NOT TOUCHED. That slot is the router's memory of
     * which tab the LOOP froze, and `unlock()` releases exactly that tab
     * however focus has moved since. A fan element's lock is its own: it takes
     * it, it releases it, and the loop's freeze on the focused tab is neither
     * consulted nor disturbed. Two independent freezes on two flat sessions,
     * which is what `Outcrawl.lock` being per-session buys.
     */
    async page(id: TabId): Promise<TabPage> {
      const live = await tabs.list();
      const tab = live.find((candidate) => candidate.id === id);
      if (tab === undefined) {
        throw new UnknownTabError(
          id,
          live.map((candidate) => candidate.id),
        );
      }
      if (tab.state !== 'live') {
        throw new TabLostError(tab.id, tab.url(), losses.get(tab.id)?.cause ?? 'unknown');
      }
      const bound = bindingFor(tab);
      const held = fanHolds.get(tab.page) ?? { held: 0 };
      fanHolds.set(tab.page, held);
      return {
        id: tab.id,
        snapshot: async () => bound.snapshot(),
        holds: async (ref: NodeRef, written: string) => bound.holds?.(ref, written),
        /**
         * The hold is marked BEFORE the command, and the unmark AFTER the
         * release — the opposite of `lock()`'s own `frozen = tab` ordering,
         * deliberately.
         *
         * `frozen` is pinned after the command because a refused lock froze
         * nothing and pinning it would unlock a tab we never held. This flag
         * answers a different question — "may a release on this tab reach the
         * run's session?" — and the dangerous direction is the other one: a
         * `lockReleased` can arrive between the command being sent and its
         * reply, and one that arrived before the mark would be routed into the
         * run's `PageSession` as a lost lock on the focused tab's freeze.
         * Marking early costs nothing if the lock is refused, because a tab
         * that never froze emits nothing to swallow.
         */
        lock: async () => {
          held.held += 1;
          try {
            await bound.lock();
          } catch (error) {
            held.held -= 1;
            throw error;
          }
        },
        unlock: async () => {
          try {
            await bound.unlock();
          } finally {
            held.held = Math.max(0, held.held - 1);
          }
        },
        perform: async (action: Action) => {
          try {
            return await bound.perform(action);
          } catch (error) {
            // Re-labelled exactly as the focused path re-labels it: a
            // cross-frame refusal on a multi-tab session is either another
            // TAB's reference or an out-of-process iframe in this one, and
            // only the first should send the loop hunting for a tab.
            if (error instanceof CrossFrameRefError) {
              throw await asTabRefusal(error, tab);
            }
            throw error;
          }
        },
        extract: async (schema: JsonSchema | undefined, instruction?: string, framing?: string, allowance?: ExtractBound, selection?: ExtractSelection) =>
          bound.extract(schema, instruction, framing, allowance, selection),
      };
    },
  };

  const routed: AgentDeps = {
    async snapshot(): Promise<AxTree> {
      return (await focused()).deps.snapshot();
    },

    // The FOCUSED tab, the one `snapshot` above read the field off.
    async holds(ref: NodeRef, written: string): Promise<boolean | undefined> {
      return (await focused()).deps.holds?.(ref, written);
    },

    async refusedSubmit(ref: NodeRef, by: 'click' | 'enter'): Promise<RefusedSubmit | undefined> {
      return (await focused()).deps.refusedSubmit?.(ref, by);
    },

    async capture(): Promise<PageView> {
      // The FOCUSED tab, like every other read here. A capture of a background
      // tab would photograph a page the next action cannot touch.
      const { deps } = await focused();
      const camera = deps.capture;
      if (camera === undefined) {
        throw new TypeError('the per-page binding exposed no capture');
      }
      return camera.call(deps);
    },

    /**
     * THE FOCUSED TAB'S document, for the same reason `capture` reads the
     * focused one: the settle that asks this is settling the page the next
     * action will touch, and a background tab's bytes would answer a question
     * about a page nobody is looking at.
     *
     * The floor is this binding's own rather than the per-tab binding's, so
     * the router cannot be handed a page binding that disagrees with it — and
     * `read` goes through `focused()` on every call, because the focused tab
     * changes between steps.
     */
    document: {
      textFloor: DEFAULT_MIN_TEXT_LENGTH,
      async read(): Promise<SettledDocument> {
        const { deps } = await focused();
        const probe = deps.document;
        if (probe === undefined) {
          throw new TypeError('the per-page binding exposed no document read');
        }
        return probe.read();
      },
      async parsing(): Promise<boolean> {
        const { deps } = await focused();
        return (await deps.document?.parsing?.()) === true;
      },
      // EVERY MEMBER of the probe, forwarded: this one was left out when it was
      // added, so the settle on a production run never heard the tab was still
      // receiving and stopped at its 10 s budget (run_9fb3f662, 2026-10-03
      // 11:24Z: a page whose module script was still downloading ended
      // `unrendered` at 10,003 ms with no `receivingMs`).
      async lastNetworkAt(): Promise<number | undefined> {
        const { deps } = await focused();
        return await deps.document?.lastNetworkAt?.();
      },
    },
    // Every bound tab, not only the focused one: a dialog a background tab
    // opened was answered there, and the model should hear about it as much
    // as one on the tab it is looking at.
    pageEvents: (): readonly string[] => [...bindings.values()].flatMap((deps) => deps.pageEvents?.() ?? []),

    async lock(): Promise<void> {
      const { tab, deps } = await focused();
      await deps.lock();
      // After the command, not before: a lock that was refused froze nothing,
      // and pinning it would make the next `unlock()` release a tab this
      // binding never held.
      frozen = tab;
    },

    async unlock(): Promise<void> {
      const pinned = frozen;
      frozen = null;
      if (pinned === null) {
        // No lock of ours is outstanding. Fall through to the focused tab
        // rather than doing nothing, because that is what the one-page binding
        // does and a caller driving `unlock` on its own is entitled to it.
        const tab = await tabs.active();
        if (tab.state === 'live') {
          await bindingFor(tab).unlock();
        }
        return;
      }
      if (pinned.state !== 'live') {
        // The renderer holding the freeze is gone, which released it. Nothing
        // to unlock, and nothing to report here: the loss was already announced
        // through `onLost`, and throwing from a `finally` would bury the step's
        // real error.
        return;
      }
      await bindingFor(pinned).unlock();
    },

    async perform(action: Action, signal?: AbortSignal, allowanceMs?: number): Promise<PerformOutcome | void> {
      const { tab, deps } = await focused();
      try {
        return await deps.perform(action, signal, allowanceMs);
      } catch (error) {
        if (error instanceof CrossFrameRefError) {
          throw await asTabRefusal(error, tab);
        }
        throw error;
      }
    },

    async extract(
      schema: JsonSchema | undefined,
      instruction?: string,
      framing?: string,
      allowance?: ExtractBound,
      selection?: ExtractSelection,
    ): Promise<ExtractOutcome> {
      return (await focused()).deps.extract(schema, instruction, framing, allowance, selection);
    },

    async model(prompt: AgentPrompt): Promise<ModelChoice> {
      // `lastBinding`, deliberately, and `focused()` deliberately NOT: see
      // `lastBinding`'s comment. A dead page answers a model call perfectly
      // well, because a model call never reaches the page.
      const binding = lastBinding ?? bindingFor(await tabs.active());
      return binding.model(prompt);
    },

    async suggestSchema(task: string): Promise<JsonSchema | null> {
      // `lastBinding` for the reason `model` gives directly above: this call
      // never reaches the page, so a dead page must not be able to refuse it.
      const binding = lastBinding ?? bindingFor(await tabs.active());
      return (await binding.suggestSchema?.(task)) ?? null;
    },

    // Both seams again, for the reason the page binding states: a run with
    // tabs reaches the same connectors and holds the same uploads, and the
    // loop reads both off the binding it was handed rather than off a per-tab
    // one. Omitting them here would have made "this run has two tabs" mean
    // "this run cannot call a tool", which nothing intends.
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.files === null ? {} : { files: options.files }),
    tabs: control,

    ...(options.hooks?.solveChallenge === undefined ? {} : { solveChallenge: options.hooks.solveChallenge }),
    ...(options.pageLoads === undefined ? {} : { pageLoads: options.pageLoads }),
    ...(options.downloads === undefined ? {} : { downloads: options.downloads }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
  };
  // The FOCUSED tab's camera, for `capture`'s reason: a look at a background
  // tab would describe a page the next action cannot touch.
  const focusedCamera = async (): Promise<BindingCamera> => {
    const camera = cameras.get((await focused()).deps);
    if (camera === undefined) {
      throw new TypeError('the focused tab binding registered no camera');
    }
    return camera;
  };
  cameras.set(routed, {
    shoot: async (aim, awaitPaint) => (await focusedCamera()).shoot(aim, awaitPaint),
    locate: async (point) => (await focusedCamera()).locate(point),
    // Only where the host can find one: a tab with no captcha hook answers none.
    ...(options.hooks?.tab === undefined
      ? {}
      : { findTextCaptcha: async (tree: AxTree) => (await focusedCamera()).findTextCaptcha?.(tree) }),
    shootElement: async (ref) => (await focusedCamera()).shootElement(ref),
  });
  // The FOCUSED tab's page, for `capture`'s reason: a script reads the page the
  // next action touches.
  scriptRunners.set(routed, {
    async run(code, timeoutMs) {
      const runner = scriptRunners.get((await focused()).deps);
      if (runner === undefined) {
        throw new TypeError('the focused tab binding registered no script runner');
      }
      return runner.run(code, timeoutMs);
    },
  });
  // The FOCUSED tab's check solver, for `capture`'s reason: the check the model saw
  // is on the page the next action touches.
  if (options.hands !== undefined && options.hooks?.tab !== undefined) {
    const focusedCheck = async (): Promise<BindingSiteCheck> => {
      const check = siteChecks.get((await focused()).deps);
      if (check === undefined) {
        throw new TypeError('the focused tab binding registered no site-check solver');
      }
      return check;
    };
    siteChecks.set(routed, {
      solve: async () => (await focusedCheck()).solve(),
      // A tab that cannot be focused shows nothing to work.
      sight: async () => (await focusedCheck().catch(() => undefined))?.sight(),
    });
  }
  return routed;
}
