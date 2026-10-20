import { optionAliases } from '@outcrawl/scout-core';
import type { AxNode } from '@outcrawl/runtime';
import type { ShownNode } from './errors';
import type { HandsTarget } from './hands';

/**
 * Called on the node `attachFile` named, in the look world: the file input it
 * stands for, or `null` to keep the node as given. See `fileInputNear`.
 */
export const FILE_INPUT_NEAR = `function () {
  const isFile = (node) => node instanceof HTMLInputElement && node.type === 'file';
  if (isFile(this)) return this;
  if (this instanceof HTMLLabelElement && isFile(this.control)) return this.control;
  if (!(this instanceof Element)) return null;
  const inside = this.querySelectorAll('input[type=file]');
  if (inside.length === 1) return inside[0];
  let up = this.parentElement;
  for (let depth = 0; up !== null && depth < 3; depth += 1, up = up.parentElement) {
    const near = up.querySelectorAll('input[type=file]');
    if (near.length === 1) return near[0];
    if (near.length > 1) return null;
  }
  return null;
}`;

/**
 * Names of the controls that put an overlay away: the paywall's "Skip for
 * now" (`run_e3086fc2`, phys.org, 2026-09-26), a cookie banner's "Accept all"
 * or "Reject all", an icon button's "Close" or bare "×". Offered to the model
 * as ways to close what is over its target; it chooses.
 */
export const DISMISS_NAME =
  /\b(close|dismiss|skip|no,? thanks|not now|maybe later|cancel|decline|reject( all)?|accept( all)?|agree|got it|ok|continue without)\b|^[×✕✖xX]$/i;

/** How many closing controls a refusal names. */
export const MAX_DISMISS_NAMED = 2;

/**
 * How many closing-named controls of the tree are checked for being inside
 * an overlay the tree has no node for: each check is an ancestor walk.
 */
export const MAX_DISMISS_CHECKS = 12;

/** A tree node as a refusal names it. */
export function asShown(node: AxNode): ShownNode {
  return { ref: node.ref, role: node.role, ...(node.name === undefined ? {} : { name: node.name }) };
}

/**
 * `this` is the click's target, `cover` what the hit test named instead:
 * whether a press on `cover` is a press on the target's own control. See
 * `sameControlAs` in {@link agentDepsFor}. Runs in the look world; reads only.
 *
 * A text node is never what the hit test names: a point on its glyphs names
 * the element the text is in, so that element is the text's own paint and not
 * a cover. MEASURED: dev it-17 (2026-10-14, 5 runs on the live build and on
 * ws/editable-fix), all 20 clicks on a custom radio's option text (in a plain
 * `<span>` inside the clickable option) were refused as covered by that
 * `<span>`, and the form never submitted; reproduced on stock Chromium.
 */
export const SAME_CONTROL = `function (cover) {
  var target = this;
  if (cover.nodeType !== 1 || (target.nodeType !== 1 && target.nodeType !== 3)) return false;
  if (target.nodeType === 3 && target.parentNode === cover) return true;
  var label = cover.closest('label');
  if (label !== null && label.control === target) return true;
  var CONTROL = 'a[href],area[href],button,input,select,textarea,summary,label,iframe,[contenteditable],[tabindex],' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=option],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=menuitemradio],[role=combobox],[role=treeitem],[role=gridcell],[role=slider],' +
    '[role=spinbutton],[role=textbox],[role=searchbox]';
  var HOSTS = { INPUT: true, TEXTAREA: true, SELECT: true, BUTTON: true, VIDEO: true, AUDIO: true, DETAILS: true, METER: true, PROGRESS: true };
  var plain = target.nodeType === 3 || !target.matches(CONTROL);
  var between = false;
  for (var node = target, hops = 0; hops < 64; hops += 1) {
    var up = node.parentNode;
    var shadow = up !== null && up.nodeType === 11;
    if (shadow) up = up.host === undefined ? null : up.host;
    if (up === null || up.nodeType !== 1) return false;
    if (up === cover) return shadow ? HOSTS[cover.tagName] === true : plain && !between && cover.matches(CONTROL);
    if (up.matches(CONTROL)) between = true;
    node = up;
  }
  return false;
}`;

/**
 * What the focused element does with a select-all, read after `fill` has
 * focused its target: `'text'` when focus is in something that edits text
 * (a text-like `<input>`, a `<textarea>`, editable content), `'other'` when it
 * is in something that does not, and `'unknown'` when the focus has gone where
 * this world cannot follow — into a frame, or into a shadow root it cannot
 * open. Runs in the look world; reads only. See `performFill`.
 */
export const FOCUS_TAKES_TEXT = `function () {
  var focused = this.ownerDocument.activeElement;
  for (var hops = 0; focused !== null && focused.shadowRoot && focused.shadowRoot.activeElement && hops < 32; hops += 1) {
    focused = focused.shadowRoot.activeElement;
  }
  if (focused === null) return 'other';
  if (focused.isContentEditable || focused.tagName === 'TEXTAREA') return 'text';
  if (focused.tagName === 'INPUT') {
    return /^(text|search|url|tel|email|password|number)$/.test(focused.type) ? 'text' : 'other';
  }
  if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(focused.tagName) || focused.tagName.indexOf('-') !== -1) return 'unknown';
  return 'other';
}`;

/**
 * The value a native text field holds, or `null` for anything else (a
 * contenteditable region, a select, a date segment). Read so a `fill` can tell
 * whether it replaced the field's text or was typed after it. `this` is the
 * element the fill focused.
 */
export const FIELD_VALUE = `function () {
  if (this.tagName === 'TEXTAREA') return String(this.value);
  if (this.tagName === 'INPUT' && /^(text|search|url|tel|email|password)$/.test(this.type)) return String(this.value);
  return null;
}`;

/**
 * One native `<select>` choice, worked out and made in the LOOK WORLD, where
 * the page's own script sees none of it. `this` is the select or one of its
 * options. The option is matched by `value`, then by the label a person
 * reads: the model names what it SEES (`select("United States")`,
 * `select("2020")`, `select("مصر")` measured in production), where an
 * exact-value match could never succeed on a form whose values are codes.
 * Failing both, a state, province or country CODE matches the one option
 * labelled with its name (`optionAliases` in `@outcrawl/scout-core`): a billing
 * profile holds "CA", and a checkout may offer only "California".
 *
 *   plan   reads only. `{ custom: true }` when `this` is no native select or
 *          option, `{ ok: false, why }` when no option matches, `{ ok: true,
 *          already: true }` when it is the chosen one, else `{ ok: true, keys }`:
 *          the shortest run of keys, with no whitespace in it, that Blink's
 *          type-ahead lands on the option with, or `null` when none does.
 *          Simulated after `TypeAhead::HandleEvent`: a single key searches
 *          from the option after the chosen one, a longer run matches its
 *          whole prefix from the chosen one inclusive, a repeated first key
 *          cycles; labels compared case-folded and leading-space-stripped over
 *          the select's list items, where an optgroup, an `<hr>` and a
 *          disabled option are items no prefix matches.
 *   check  reads only. `{ ok }`: whether the option is now the chosen one.
 *   set    the remainder, for a choice type-ahead cannot reach: `selected` set
 *          here and `input` then `change` dispatched, the order the HTML spec
 *          gives. A listener sees those two with `isTrusted: false`.
 */
export function nativeSelect(wanted: string | null, mode: 'plan' | 'check' | 'set'): string {
  return `function () {
  var wanted = ${JSON.stringify(wanted)}, mode = ${JSON.stringify(mode)}, aliases = ${JSON.stringify(wanted === null ? [] : optionAliases(wanted))};
  var isOption = this instanceof HTMLOptionElement;
  var select = this instanceof HTMLSelectElement ? this : isOption ? this.closest('select') : null;
  if (select === null || (wanted === null && !isOption)) return { custom: true };
  var options = Array.prototype.slice.call(select.options);
  var norm = function (text) { return text.replace(/\\s+/g, ' ').trim().toLowerCase(); };
  var named = function () {
    var hits = options.filter(function (o) { return aliases.some(function (alias) { return norm(o.label) === norm(alias); }); });
    return hits.length === 1 ? hits[0] : undefined;
  };
  var option = wanted === null ? this
    : options.find(function (o) { return o.value === wanted; }) || options.find(function (o) { return norm(o.label) === norm(wanted); }) || named();
  if (option === undefined || options.indexOf(option) < 0) return { ok: false, why: 'no option with that value or label' };
  if (mode === 'check') return { ok: option.selected };
  if (option.selected) return { ok: true, already: true };
  if (mode === 'set') {
    option.selected = true;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (select.disabled || option.disabled) return { ok: true, keys: null };
  var items = [];
  for (var i = 0; i < select.children.length; i += 1) {
    var child = select.children[i];
    if (child instanceof HTMLOptionElement) items.push(child);
    else if (child instanceof HTMLHRElement) items.push(null);
    else if (child instanceof HTMLOptGroupElement) {
      items.push(null);
      for (var j = 0; j < child.children.length; j += 1) {
        if (child.children[j] instanceof HTMLOptionElement) items.push(child.children[j]);
      }
    }
  }
  var target = items.indexOf(option);
  if (target < 0) return { ok: true, keys: null };
  var texts = items.map(function (o) { return o === null || o.disabled ? '' : o.label.replace(/^\\s+/, '').toLowerCase(); });
  var chosen = select.selectedIndex < 0 ? -1 : items.indexOf(options[select.selectedIndex]);
  var land = function (keys) {
    var at = chosen, buffer = '', repeating = '';
    for (var k = 0; k < keys.length; k += 1) {
      var c = keys.charAt(k), prefix = buffer += c, offset = 1;
      if (c === repeating) prefix = c;
      else if (buffer.length > 1) { repeating = ''; offset = 0; }
      else repeating = c;
      for (var n = 0, x = ((at < 0 ? 0 : at) + offset) % items.length; n < items.length; n += 1, x = (x + 1) % items.length) {
        if (texts[x].indexOf(prefix) === 0) { at = x; break; }
      }
    }
    return at;
  };
  var label = texts[target];
  for (var length = 1; length <= Math.min(label.length, 24) && !/\\s/.test(label.charAt(length - 1)); length += 1) {
    if (land(label.slice(0, length)) === target) return { ok: true, keys: label.slice(0, length) };
  }
  for (var times = 2; times <= 6 && label !== ''; times += 1) {
    var cycle = new Array(times + 1).join(label.charAt(0));
    if (land(cycle) === target) return { ok: true, keys: cycle };
  }
  return { ok: true, keys: null };
}`;
}

/** The `<select>` that `this` is, or that `this` option is in. Runs in the look world; reads only. */
export const SELECT_OF = `function () {
  return this instanceof HTMLSelectElement ? this : this.closest('select');
}`;

/**
 * The native `<input type=date|time|datetime-local|month|week>` that `this` is,
 * or whose user-agent shadow tree `this` is a segment of; `null` for anything
 * else. Runs in the look world; reads only. See `nativeDatePlan`.
 */
export const NATIVE_DATE_HOST = `function () {
  var kinds = { date: true, time: true, 'datetime-local': true, month: true, week: true };
  var host = this;
  if (host.nodeType !== 1 || host.tagName !== 'INPUT') {
    var root = host.getRootNode();
    host = root && root.nodeType === 11 ? root.host : null;
  }
  return host && host.tagName === 'INPUT' && kinds[host.type] === true ? host : null;
}`;

/**
 * Called on the first segment of a native date/time input: the input's type,
 * every segment's field, range and placeholder in the order they are drawn,
 * and the locale's month and AM/PM names, which is what a symbolic segment is
 * chosen by. The locale is the one Blink draws the input in — the nearest
 * `lang`, else the browser's. Runs in the look world; reads only: the user-agent
 * shadow root is reachable from a node already inside it, and from nowhere the
 * page's own script can stand.
 */
export const NATIVE_DATE_LAYOUT = `function () {
  var root = this.getRootNode();
  var host = root && root.nodeType === 11 ? root.host : null;
  if (host === null || host.tagName !== 'INPUT') return null;
  var segments = [];
  var spans = root.querySelectorAll('[role=spinbutton]');
  for (var i = 0; i < spans.length; i += 1) {
    var pseudo = /^-webkit-datetime-edit-(\\w+)-field$/.exec(spans[i].getAttribute('pseudo') || '');
    segments.push({ field: pseudo === null ? '' : pseudo[1], max: Number(spans[i].getAttribute('aria-valuemax')), placeholder: spans[i].getAttribute('aria-placeholder') || '' });
  }
  var named = host.closest('[lang]');
  var locale = (named !== null && named.lang) || navigator.language;
  var months = [];
  var ampm = [];
  try {
    var month = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    for (var m = 0; m < 12; m += 1) months.push(month.format(new Date(Date.UTC(2000, m, 15))));
    var clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' });
    [3, 15].forEach(function (hour) {
      var half = clock.formatToParts(new Date(Date.UTC(2000, 0, 1, hour))).filter(function (part) { return part.type === 'dayPeriod'; })[0];
      ampm.push(half === undefined ? '' : half.value);
    });
  } catch (error) {}
  return { type: host.type, segments: segments, months: months, ampm: ampm };
}`;

/**
 * The form a click on `this` (`by` 'click') or an Enter in it ('enter') sends,
 * and every control in it that fails the browser's constraint validation, by
 * label and `validationMessage`, at most three, in form order; `null` when
 * `this` sends no form, the form or its submitter skips validation, or every
 * control is valid. `focused`: the first invalid control holds focus, where
 * the browser puts it when it refuses a submit.
 *
 * Runs in the look world and reads PROPERTIES only: `willValidate`,
 * `validity`, `validationMessage`, `labels`. Never `checkValidity()` or
 * `reportValidity()`, which fire `invalid` events at the page. A segment of a
 * date or time input answers for its input. Mirrors Blink's implicit
 * submission for 'enter': the form's default button sends it, and with none
 * a form sends only when it has at most one field that blocks it.
 */
export function refusedSubmit(by: 'click' | 'enter'): string {
  return `function () {
  var by = ${JSON.stringify(by)};
  var el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  var root = el.getRootNode();
  if (root && root.nodeType === 11 && root.host && root.host.tagName === 'INPUT') el = root.host;
  if (!el.isConnected) return null;
  var isSubmitter = function (node) {
    return (node.tagName === 'BUTTON' && node.type === 'submit') ||
      (node.tagName === 'INPUT' && (node.type === 'submit' || node.type === 'image'));
  };
  var form = null;
  var submitter = el.closest('button, input');
  if (submitter !== null && isSubmitter(submitter)) {
    if (submitter.disabled || submitter.formNoValidate) return null;
    form = submitter.form;
  } else if (by === 'enter' && el.tagName === 'INPUT' && !(submitter !== null && submitter.tagName === 'BUTTON')) {
    form = el.form;
    if (form === null) return null;
    var blocking = { text: 1, search: 1, url: 1, tel: 1, email: 1, password: 1, date: 1, month: 1, week: 1, time: 1, 'datetime-local': 1, number: 1 };
    var fallback = null;
    var fields = 0;
    for (var e = 0; e < form.elements.length; e += 1) {
      var item = form.elements[e];
      if (fallback === null && isSubmitter(item)) fallback = item;
      if (item.tagName === 'INPUT' && blocking[item.type] === 1) fields += 1;
    }
    if (fallback !== null ? fallback.disabled || fallback.formNoValidate : fields > 1) return null;
  }
  if (form === null || form.noValidate) return null;
  var words = function (node, out) {
    if (node.nodeType === 3) { out.push(node.nodeValue); return; }
    if (node.nodeType !== 1 || /^(SELECT|TEXTAREA|BUTTON|SCRIPT|STYLE|DATALIST)$/.test(node.tagName)) return;
    for (var c = node.firstChild; c !== null; c = c.nextSibling) words(c, out);
  };
  var tidy = function (text) { return (text || '').replace(/\\s+/g, ' ').trim().slice(0, 80); };
  var labelOf = function (control) {
    var named = tidy(control.getAttribute('aria-label'));
    var ids = control.getAttribute('aria-labelledby');
    if (named === '' && ids) {
      named = tidy(ids.split(/\\s+/).map(function (id) {
        var target = control.getRootNode().getElementById(id);
        return target === null ? '' : target.textContent;
      }).join(' '));
    }
    if (named === '' && control.labels && control.labels.length > 0) {
      var out = [];
      words(control.labels[0], out);
      named = tidy(out.join(' '));
    }
    return named || tidy(control.getAttribute('title')) || tidy(control.getAttribute('placeholder')) || tidy(control.getAttribute('name'));
  };
  var invalid = [];
  var first = null;
  for (var i = 0; i < form.elements.length && invalid.length < 3; i += 1) {
    var control = form.elements[i];
    if (!control.willValidate || control.validity.valid) continue;
    if (first === null) first = control;
    invalid.push({ label: labelOf(control), message: control.validationMessage });
  }
  if (first === null) return null;
  return { fields: invalid, focused: el.ownerDocument.activeElement === first };
}`;
}

/**
 * `this` and each argument are tree nodes whose label carries a labelled
 * control's checked state: for each, in order, the `type` of the `<input>`
 * the nearest enclosing `<label>` controls, or `null`. The walk crosses
 * shadow roots to their hosts, as the fork's own walk does
 * (`ParentOrShadowHostNode`, patch 0030). Runs in the look world; reads only.
 * See `withRadioLabelsResolved` in {@link agentDepsFor}.
 */
export const LABELLED_CONTROL_TYPES = `function () {
  var nodes = [this].concat(Array.prototype.slice.call(arguments));
  return nodes.map(function (start) {
    for (var node = start, hops = 0; node !== null && node !== undefined && hops < 64; hops += 1) {
      if (node.nodeType === 1 && node.tagName === 'LABEL') {
        var control = node.control;
        return control !== null && control.tagName === 'INPUT' ? control.type : null;
      }
      var up = node.parentNode;
      node = up !== null && up.nodeType === 11 ? (up.host === undefined ? null : up.host) : up;
    }
    return null;
  });
}`;

/**
 * How many label nodes carrying `checked: 'mixed'` one snapshot resolves.
 * A bound, not a target: each costs one `DOM.resolveNode`, and a page of a
 * hundred untouched radio groups is not worth a hundred round trips per step.
 * Past it the wire's own word stands.
 */
export const MAX_MIXED_LABEL_READS = 64;

/** The most native date/time inputs one snapshot reads to mark (`withNativeDateFields`). */
export const MAX_NATIVE_DATE_READS = 16;

/**
 * `this` is the click's target, `cover` what the hit test named instead: the
 * dialog over the page, or `null`. That is the open `<dialog>` or
 * `[aria-modal="true"]` the cover is in, or — when the cover is something
 * else, a backdrop — a visible MODAL one open anywhere. Never one that holds
 * the target: a control inside the open dialog is not under it.
 */
export const MODAL_OF = `function (cover) {
  var target = this;
  if (cover.nodeType !== 1) return null;
  var open = cover.closest('dialog[open],[aria-modal="true"]');
  if (open !== null) return open.contains(target) ? null : open;
  var all = document.querySelectorAll('dialog[open],[aria-modal="true"]');
  for (var i = all.length - 1; i >= 0; i -= 1) {
    var element = all[i];
    if (element.contains(target)) continue;
    if (element.tagName === 'DIALOG' && element.getAttribute('aria-modal') !== 'true' && !element.matches(':modal')) continue;
    var box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden') return element;
  }
  return null;
}`;

/**
 * `this` is the click's target, `cover` what the hit test named instead: the
 * outermost element the cover is in that is fixed or sticky to the viewport
 * and does not hold the target — a cookie banner, a sticky bar, a chat
 * launcher — or `null` when the cover scrolls with the page.
 */
export const FIXED_OF = `function (cover) {
  var target = this;
  var fixed = null;
  for (var node = cover, hops = 0; node !== null && node.nodeType === 1 && hops < 64; hops += 1) {
    if (node.contains(target)) break;
    var position = getComputedStyle(node).position;
    if (position === 'fixed' || position === 'sticky') fixed = node;
    var up = node.parentNode;
    node = up !== null && up.nodeType === 11 ? (up.host === undefined ? null : up.host) : up;
  }
  return fixed;
}`;

/**
 * `this` is the click's target: the nearest scroller below the document's
 * own that clips its centre, as the scroller's client rect in viewport
 * pixels and the scroll that would centre the target in it, or `null`.
 */
export const CLIPPING_SCROLLER = `function () {
  var rect = this.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  var SCROLLS = /^(auto|scroll|overlay)$/;
  for (var node = this, hops = 0; hops < 64; hops += 1) {
    var up = node.parentNode;
    if (up !== null && up.nodeType === 11) up = up.host === undefined ? null : up.host;
    if (up === null || up.nodeType !== 1) return null;
    if (up === document.scrollingElement || up === document.documentElement || up === document.body) return null;
    node = up;
    var style = getComputedStyle(node);
    var scrollsY = SCROLLS.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    var scrollsX = SCROLLS.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (!scrollsY && !scrollsX) continue;
    var box = node.getBoundingClientRect();
    var left = box.left + node.clientLeft;
    var top = box.top + node.clientTop;
    var right = left + node.clientWidth;
    var bottom = top + node.clientHeight;
    var dy = scrollsY && (cy < top || cy > bottom) ? cy - (top + bottom) / 2 : 0;
    var dx = scrollsX && (cx < left || cx > right) ? cx - (left + right) / 2 : 0;
    if (dx === 0 && dy === 0) continue;
    return { x: left, y: top, width: right - left, height: bottom - top, dx: dx, dy: dy };
  }
  return null;
}`;

/**
 * `this` is the element a look is aimed at: the part of its box that its
 * clipping ancestors leave showing, in viewport pixels, as `{x, y, width,
 * height}` (zero size when they hide it all). An ancestor clips when its
 * overflow is not `visible` on that axis — except one an absolutely
 * positioned box escapes on the way to its containing block — and the walk
 * stops at the document's own scroller and at a fixed box. Runs in the look
 * world; reads only.
 *
 * WHY: a box the viewport shows can still be scrolled out of sight inside a
 * pane. MEASURED 2026-10-16 on a neutral fixture (stock headless shell, n=5):
 * an image scrolled out of its 340 px pane, looked at by reference, was
 * photographed where its box lay — the text beneath the pane — and the look
 * model read years off it on 5 of 5 looks.
 */
export const VISIBLE_PART = `function () {
  var rect = this.getBoundingClientRect();
  var left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  var position = this.nodeType === 1 ? getComputedStyle(this).position : 'static';
  var escaping = position === 'absolute';
  for (var node = this, hops = 0; position !== 'fixed' && hops < 64; hops += 1) {
    var up = node.parentNode;
    if (up !== null && up.nodeType === 11) up = up.host === undefined ? null : up.host;
    if (up === null || up.nodeType !== 1) break;
    if (up === document.scrollingElement || up === document.documentElement || up === document.body) break;
    node = up;
    var style = getComputedStyle(node);
    position = style.position;
    if (escaping && position !== 'static') escaping = false;
    if (!escaping) {
      var box = node.getBoundingClientRect();
      var innerLeft = box.left + node.clientLeft;
      var innerTop = box.top + node.clientTop;
      if (style.overflowX !== 'visible') { left = Math.max(left, innerLeft); right = Math.min(right, innerLeft + node.clientWidth); }
      if (style.overflowY !== 'visible') { top = Math.max(top, innerTop); bottom = Math.min(bottom, innerTop + node.clientHeight); }
    }
    if (position === 'absolute') escaping = true;
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}`;

/** {@link VISIBLE_PART}'s answer, checked. */
export function visibleFrom(value: unknown): HandsTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => {
    const field: unknown = (value as Record<string, unknown>)[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
  });
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

/** How many editable regions one read of a document lists. */
export const MAX_EDITABLE_FIELDS = 24;

/** The values {@link EDITABLE_FIELDS} reads per region, in order. */
export const EDITABLE_FIELD_WIDTH = 8;

/**
 * Every editable region of the document a person can see and type in, which
 * the accessibility tree does not show as a field: a `contenteditable` element
 * whose parent is not editable (the region's own root, the element a rich-text
 * editor such as Quill, ProseMirror or Lexical types into). Blink maps one with
 * no role to `generic`, which the tree's filter drops, so the model is shown
 * only the text around it, a placeholder's included, and a fill lands on that
 * text. An expression for `lookWorldList`, run in the look world; reads only.
 *
 * Per region, {@link EDITABLE_FIELD_WIDTH} values: the root, its first text
 * node, the three text nodes before it in document order (where it goes in the
 * tree when it holds no text the tree shows), the name a person reads for it
 * (its ARIA name, its `<label for>`, an enclosing label, then its placeholder),
 * its text, and its `id`. `null` when there is none.
 */
export const EDITABLE_FIELDS = `(function () {
  var all = document.querySelectorAll('[contenteditable]');
  if (all.length === 0) return null;
  var squash = function (text, max) { text = (text || '').replace(/\\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max) : text; };
  var shown = function (node) {
    var up = node.parentElement;
    return up !== null && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(up.tagName) && /\\S/.test(node.data) && up.getClientRects().length > 0;
  };
  var out = [];
  for (var i = 0; i < all.length && out.length < ${String(MAX_EDITABLE_FIELDS * EDITABLE_FIELD_WIDTH)}; i += 1) {
    var root = all[i];
    if (!root.isContentEditable || (root.parentElement !== null && root.parentElement.isContentEditable)) continue;
    var box = root.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || getComputedStyle(root).visibility !== 'visible') continue;
    var inside = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var first = null;
    while (first === null && inside.nextNode() !== null) if (shown(inside.currentNode)) first = inside.currentNode;
    var before = [];
    var back = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    back.currentNode = root;
    for (var hops = 0; before.length < 3 && hops < 64 && back.previousNode() !== null; hops += 1) {
      if (shown(back.currentNode)) before.push(back.currentNode);
    }
    var name = root.getAttribute('aria-label') || '';
    var by = root.getAttribute('aria-labelledby');
    if (name === '' && by) {
      name = by.split(/\\s+/).map(function (id) { var el = document.getElementById(id); return el === null ? '' : el.textContent; }).join(' ');
    }
    if (squash(name, 1) === '' && root.id) {
      var labels = document.querySelectorAll('label[for="' + CSS.escape(root.id) + '"]');
      if (labels.length > 0) name = labels[0].textContent;
    }
    if (squash(name, 1) === '' && root.closest('label') !== null) name = root.closest('label').textContent;
    if (squash(name, 1) === '') {
      name = root.getAttribute('aria-placeholder') || root.getAttribute('placeholder') || root.getAttribute('data-placeholder') || root.getAttribute('title') || '';
    }
    out.push(root, first, before[0] || null, before[1] || null, before[2] || null, squash(name, 120), squash(root.innerText, 4000), root.id || null);
  }
  return out.length === 0 ? null : out;
})()`;

/**
 * Called on the node a `fill` named when it is not itself something that
 * takes typing: the root of the editable region it is in (see
 * {@link EDITABLE_FIELDS}), else the nearest enclosing element that is a text
 * field by role, else `null`. A text node inside a rich-text editor, its
 * paragraph, or a placeholder's text: the field is the region around it. Runs
 * in the look world; reads only.
 */
export const EDITABLE_HOST = `function () {
  var element = this.nodeType === 1 ? this : this.parentElement;
  if (element === null) return null;
  if (element.isContentEditable) {
    while (element.parentElement !== null && element.parentElement.isContentEditable) element = element.parentElement;
    return element;
  }
  return element.closest('[role=textbox],[role=searchbox]');
}`;

/** {@link CLIPPING_SCROLLER}'s answer, checked. */
export function clipFrom(value: unknown): { readonly box: HandsTarget; readonly dx: number; readonly dy: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const read = (key: string): number | undefined => {
    const field: unknown = (value as Record<string, unknown>)[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
  };
  const [x, y, width, height, dx, dy] = ['x', 'y', 'width', 'height', 'dx', 'dy'].map(read);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    dx === undefined ||
    dy === undefined
  ) {
    return undefined;
  }
  return { box: { x, y, width, height }, dx, dy };
}
