import type { AgentDeps, TextCaptchaPort } from '@outcrawl/runtime';
import { TEXT_CAPTCHA_QUESTION, lookToolPort, pageScriptToolPort, siteCheckToolPort, textCaptchaCode } from '@outcrawl/runtime';

import type { CdpPage } from './cdp';
import type { BindingOptions } from './options';
import { cameras, pageBinding, scriptRunners, siteChecks } from './page-binding';
import { tabbedBinding } from './tabbed-binding';
import { composeToolPorts } from './tools';

/**
 * Binds `AgentDeps` to a page, or to a set of tabs.
 *
 * Most seams are optional and every absent one refuses at the point of use
 * rather than at construction: a binding with no model can still run
 * `navigate`/`fill`/`press` flows, and one with no hands can still `observe`.
 * Refusing late is what keeps those partial configurations usable instead of
 * unbootable.
 *
 * With {@link BindingOptions.tabs} `null` this is the one-page binding, and
 * `page` is the page. With tabs bound it is one one-page binding PER TAB
 * behind a router, and `page` is then only the tab the session started on:
 * every call follows the focused tab instead.
 */
export function bindAgent(page: CdpPage, options: BindingOptions): AgentDeps {
  const tabs = options.tabs;
  const deps = tabs === null ? pageBinding(page, options) : tabbedBinding(tabs, options);
  const camera = cameras.get(deps);
  const runner = scriptRunners.get(deps);
  const siteCheck = siteChecks.get(deps);
  // The model's `page.verify` and the loop's sighted check share this one
  // port, so they share its allowance.
  const siteCheckPort =
    siteCheck === undefined ? undefined : siteCheckToolPort({ solve: () => siteCheck.solve(), sight: () => siteCheck.sight() });
  const sighted = siteCheckPort === undefined ? {} : { sightedCheck: siteCheckPort };
  const vision = camera === undefined ? undefined : options.look;
  // ONE port of each per binding, and a binding is one run: each tool's
  // allowance lives in its port, so a per-tab port would hand every tab a
  // fresh one.
  const composed = composeToolPorts(
    options.tools,
    vision === undefined || camera === undefined
      ? undefined
      : lookToolPort({
          camera,
          vision,
          ...(options.looksTaken === undefined ? {} : { taken: options.looksTaken }),
          ...(options.maxLooks === undefined ? {} : { maxLooks: options.maxLooks }),
        }),
    runner === undefined
      ? undefined
      : pageScriptToolPort({ runner, ...(options.scriptsTaken === undefined ? {} : { taken: options.scriptsTaken }) }),
    siteCheckPort,
  );
  // A look or a script reads the page, and its answer is text the run's
  // model reads and its step records: the host may wrap the port, e.g. to
  // scrub a secret a look named like any other page text.
  const wrap = options.hooks?.tools;
  const tools = composed === undefined || composed === options.tools || wrap === undefined ? composed : wrap(composed);
  if (vision === undefined || camera === undefined) {
    if (siteCheckPort === undefined && tools === options.tools) return deps;
    return { ...deps, ...(tools === undefined ? {} : { tools }), ...sighted };
  }
  // Text captchas are read by the same vision model, outside the look
  // allowance: the host finds them, not the model.
  const find = camera.findTextCaptcha;
  const textCaptcha: TextCaptchaPort | undefined =
    find === undefined
      ? undefined
      : {
          find: (tree) => find(tree),
          async read(sighting) {
            const image = await camera.shootElement(sighting.image);
            const answer = await vision.ask({ question: TEXT_CAPTCHA_QUESTION, image });
            const code = answer.found ? textCaptchaCode(answer.answer) : undefined;
            if (code === undefined) {
              throw new Error(`the code image could not be read (the reader said: ${answer.answer.slice(0, 120)})`);
            }
            return { code, usage: answer.usage };
          },
        };
  return {
    ...deps,
    ...(tools === undefined ? {} : { tools }),
    ...(textCaptcha === undefined ? {} : { textCaptcha }),
    ...sighted,
  };
}
