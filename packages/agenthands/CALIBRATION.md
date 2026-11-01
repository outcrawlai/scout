# Calibration

How the constants in `src/profile.ts` were derived, and how to redo it.

## Method

A probe page (`harness/probe.html`) listens on `pointermove`, `pointerdown`,
`pointerup`, `keydown` and `keyup` at the capture phase, and records per event:

- coordinates, `movementX/Y`, and whether they are fractional
- `getCoalescedEvents().length`
- `PointerEvent.pressure`
- whether `screenX === clientX`
- `isTrusted`
- press-to-release duration, and offset from the target's geometric centre
- key hold time, and gap between consecutive keydowns

The same page was driven three ways on the same machine, in the same browser
build, in the same session shape — three target clicks and a short typed string:

1. **Human** — a real hand on a trackpad
2. **Naive bot** — an existing Bézier cursor library plus a typing library
3. **Calibrated bot** — this library

Because only the input source differs, any divergence is attributable to input
injection rather than to the browser, the page, or the environment.

## Capture

6 human sessions. 1255 `pointermove` events, 25 clicks, 83 keystrokes.
macOS trackpad, Chromium-family browser, 90×34px targets, August 2026.

## Results

Pooled across all human sessions, against the naive and calibrated bots:

| Metric | Human | Naive bot | Calibrated |
|---|---|---|---|
| Click offset X | mean 8.07, **sd 15.04** | 0.00, **sd 0.00** | 13.8, sd 14.0 |
| Click offset Y | mean 2.26, sd 5.29 | 0.00, sd 0.00 | 2.5, sd 6.0 |
| Dead-centre clicks | **0 / 25** | **3 / 4** | 0 / 4 |
| Click dwell (ms) | mean 99.9, **sd 13.7** | 69.1, sd 39.8 | 98.1, sd 13.8 |
| Key dwell (ms) | mean 83.7, sd 28.3 | 90.1, sd 41.3 | 90.5, sd 31.9 |
| Key flight (ms) | mean 127.4, **sd 89.4** | 111.4, **sd 34.3** | 191.8, sd 66.0 |
| Pointer rate (Hz) | 58.8 – 80.1 | 63.3 | 61.9 |
| Fractional coords | 100% | 95.8% | 100% |
| `coalesced` mean / max | **1.01 / 7** | **1.00 / 1** | **1.00 / 1** |
| `pressure > 0` | 0.4 – 1.1% | 0% | 0% |
| `isTrusted === false` | 0 | 0 | 0 |

## What the numbers changed

**Landing offset is the largest single divergence.** The naive bot clicked the
exact geometric centre on 3 of 4 clicks with a standard deviation of zero. No
human click in 25 landed dead centre. Expressing the offset as a fraction of
element size rather than absolute pixels matters: an absolute spread gets
clamped away on small controls, which is what produced sd 5.3 on a first attempt
against a human sd of 15.0.

**Click dwell: the centre was right, the width was wrong.** The original
25-click sample gave sd ≈ 14ms, and this document concluded that adding variance
was a mistake. Two public datasets say otherwise. Balabit (148,860 pure clicks,
drags excluded) and the SERP in-browser study (2,901 clicks) both show a
right-skewed distribution:

| | p10 | median | p90 | p99 |
|---|---|---|---|---|
| Balabit (n=148,860) | 78 | 94 | 156 | 218 |
| SERP browser (n=2,901) | 69 | 111 | 183 | 797 |
| Profile now emits | 72 | 100 | 170 | 324 |

The median matched all along; 25 clicks from one person simply could not
show a tail. Note Balabit's quantiles are all multiples of ~15.6ms — it is an
RDP capture, and the transport quantises the timing — so its *shape* is
reliable where its fine resolution is not. That is why the browser dataset
carries more weight at the fine end and the two are pooled rather than averaged.

Because the shape is skewed, these constants are stored as **empirical quantile
curves** and sampled by inverse-CDF interpolation. A gaussian has no way to
express a floor near the motor limit with a long tail above it.

**Key flight needed widening — more than first thought.** KeyRecs (99
participants) gives 197,718 down-to-down intervals for typing a *known* string
and 549,404 for free text. Even in the fixed-text case the median is 216ms with
p90 at 616ms, against an original cap of 260ms that truncated the tail
entirely. Key *dwell* from the same dataset confirms the original 83-keystroke
sample almost exactly (median 91ms against a measured mean of 83.7), so only
the flight distribution needed real correction.

The profile sits below KeyRecs' fixed-text median deliberately: that task is
typing a random string, while filling a form means typing an address you know
by heart. The tail is what mattered, and the tail is now present.

**`isTrusted` is not a signal.** Injected events report `isTrusted: true`. It is
frequently cited as a bot check; it did not discriminate here.

**`coalesced` is fixable from the driver, and the fix is not what it looks
like.** Human sessions averaged 1.01 coalesced samples per `pointermove` with a
maximum of 7; both bots were a hard 1 with zero variance, in every browser
tested. The first assumption was that this needed a patched browser, because
`getCoalescedEvents()` looks like an API to override.

It isn't an API question. Coalescing is *emergent*: the browser merges pointer
samples that arrive faster than the compositor can paint them. Real hardware
reports on its own clock, independent of the display, so occasionally a frame is
missed and several samples land together. Injected input is dispatched one call
at a time, each comfortably inside its own frame, so nothing ever merges — hence
the hard 1.

That means the driver *can* produce genuine coalescing simply by dispatching a
few samples back-to-back, and the resulting events come from the browser's own
input pipeline rather than a spoofed accessor. Measured on the same machine:

| Dispatch pattern | mean | max |
|---|---|---|
| Serialised (await each) | 1.000 | 1 |
| 4 in flight | 1.802 | 3 |
| 16 in flight | 2.105 | 7 |
| All in flight | 2.500 | 10 |

Which exposes the second mistake: **both directions are detectable.** A constant
1 is robotic, but so is a mean of 1.8, because it implies a display dropping
most of its frames. Naive pipelining overshoots the human number by 80x.

The profile therefore models the *cause* — a rare missed frame — rather than the
statistic. `frameDropChance` (0.011) is the per-sample probability of a missed
frame and `frameDropBurst` (mean 2.6, max 7) is how many samples it swallows;
the elapsed time is paid back afterwards so the emitted sample rate stays in the
measured 60–80Hz band. Verified output over 8,425 events:

```
coalesced mean 1.012   (human 1.01)
coalesced max  5       (human 7)
histogram      {1: 8340, 2: 71, 3: 10, 4: 3, 5: 1}
emitted rate   75.6 Hz
```

**`PointerEvent.pressure` needs no work at all.** It reads 0 with no button held
and 0.5 with one held — which is exactly what the spec prescribes for hardware
without pressure support, and exactly what a real mouse or trackpad reports. An
early reading of the Chromium source suggested injected events would be pinned
to 0, because the DevTools handler defaults the `force` parameter to 0 when the
driver omits it. Measuring the built browser rather than trusting the source
read showed the mouse path never uses that value. Bot and human are identical
here; there was nothing to fix.

**Scroll had never been measured at all.** The original `scroll()` divided the
distance into six steps, jittered each by 20%, and slept a hand-picked
140±60ms between them — invented constants of exactly the kind this project
exists to replace. The harness did not capture wheel events, so nothing had
ever checked them.

Measured output: 12 wheel events to travel 2800px, ~170ms apart, with
`deltaY` values of 225.15, 288.24, 111.17 … and `wheelDeltaY` pinned at **-120
for every single one**.

That pairing is impossible on real hardware. Blink computes
`wheelDeltaY = wheel_ticks_y * 120` from the tick count alone — `deltaY` never
enters into it — and every real input path in Chromium derives the tick count
by *dividing* the delta by a platform constant:

- `ui/events/blink/web_input_event.cc` — `delta_y / MouseWheelEvent::kWheelDelta`
- `content/browser/renderer_host/input/synthetic_gesture_target_mac.mm` —
  `delta_y / ui::kScrollbarPixelsPerCocoaTick`

So real events satisfy a fixed, platform-specific ratio. Independent
confirmation from device measurements collected in Facebook's `normalizeWheel`:

| Platform / device | deltaY per step | wheelDelta | ratio |
|---|---|---|---|
| macOS Chrome, trackpad | 2 | -6 | **-3.0** |
| Windows Chrome, mouse wheel | 100 | -120 | **-1.2** |

macOS divides by 40 (`kScrollbarPixelsPerCocoaTick`), giving `-3`; Windows
divides by 100, giving `-1.2`. **The ratio is a property of the OS you claim to
be**, so a browser reporting a macOS UA must produce -3.

Measured human scroll, macOS trackpad, 174 wheel events:

```
abs deltaY        mean 7.13   sd 5.61   min 1     max 27
wheelDelta ratio  mean -3.00  sd 0.01   min -3    max -2.95
gap within burst  mean 9.46ms sd 13.86  min 0.4   max 143.9
fractional deltaY 0%   (integers)      multiples of 40: 0%
```

Note the ratio's tiny spread: `wheelDeltaY` is an integer, so sub-tick deltas
round. Reproducing that rounding noise is part of matching the signal.

**The blocker was a Chromium inconsistency, not a law of physics.** The
DevTools handler is the one path that does *not* divide — it pins the tick
count to `+/-1` from the sign of the delta alone
(`content/browser/devtools/protocol/input_handler.cc`). That single line forces
every driver-sent wheel event into an impossible pair unless the delta happens
to equal exactly one tick, and it makes the fine-grained deltas of a continuous
device unreachable. Restoring the same division the rest of the tree performs:

```c++
#if BUILDFLAG(IS_MAC)
    const float pixels_per_tick = 40.0f;   // ui::kScrollbarPixelsPerCocoaTick
#else
    const float pixels_per_tick =
        static_cast<float>(ui::MouseWheelEvent::kWheelDelta);
#endif
    wheel_event->wheel_ticks_x = wheel_event->delta_x / pixels_per_tick;
    wheel_event->wheel_ticks_y = wheel_event->delta_y / pixels_per_tick;
```

`scroll()` probes for this once per instance by sending a single half-tick
event — an ordinary-looking scroll either way — and reading the ratio back:

- **ratio follows the delta** → emit the measured distribution directly:
  small integer deltas at the measured cadence.
- **ratio pinned** → fall back to whole ticks, the only self-consistent value
  a stock browser can send.

Wheel events are dispatched without awaiting each round-trip, because the CDP
hop is ~10ms and would otherwise put a floor under the gap above the measured
9.46ms cadence. Verified over 380 events on a patched build:

| | Human | Library |
|---|---|---|
| abs `deltaY` | mean 7.13, sd 5.61 | mean 7.89, sd 5.51 |
| ratio | -3.00 | -3.00 |
| gap within burst | mean 9.46ms | mean 10.38ms |
| integer deltas | 100% | 100% |

Distance lands exactly. On a stock browser the same call produces whole 40px
ticks with the ratio still at -3.000 and zero impossible pairs.

**That table was measured against a page whose only wheel listener was passive,
and that hid the largest wheel tell there is.** A passive-only wheel listener
makes Blink report the wheel class as passive, the browser then sends every wheel
event non-blocking, and `WheelEvent.cancelable` reads `false` for hardware and
injected input alike. Registering an ordinary non-passive listener — free, and
what any detector would do — separates them completely.

**A scroll is a gesture, and `Input.dispatchMouseWheel` cannot express one.**
Every wheel event carries where it sits in its gesture: `NSEvent.phase` on
macOS, `WebMouseWheelEvent::phase` in Chromium. The CDP handler has no parameter
for it. It stamps `kPhaseBegan` on every event and then, if the event was queued,
sends a synthetic `kPhaseEnded` straight behind it
(`content/browser/devtools/protocol/input_handler.cc`, `InjectWheelEvent`), so
each event is a complete one-event gesture. Two consequences reach the page:

- `MouseWheelEventQueue::TryForwardNextEventToRenderer` clears
  `send_wheel_events_async_` for a `kPhaseBegan` event and marks everything after
  it `kEventNonBlocking`. One cancelable wheel event per GESTURE on real
  hardware; one per EVENT when every event begins a gesture.
- A phase that ends after every event produces a `GestureScrollEnd` after every
  event, and therefore a `scrollend` after every event. This one needs no wheel
  listener at all.

Measured on the shipped browser, 2400px of scroll, non-passive wheel listener:

| | Real trackpad | agenthands over CDP | Naive `mouse.wheel()` loop |
|---|---|---|---|
| wheel events | 134 | 199 | 6 |
| cancelable events | **1** | **199** | **6** |
| cancelable run pattern | `T×1 F×133` | `T×199` | `T×6` |
| `scrollend` events | **1** | **136** | **6** |
| abs `deltaY` | mean 12.1, sd 5.3, max 22 | mean 12.1, sd 10.7, **max 63** | 400, sd 0 |
| `wheelDeltaY`/`deltaY` | -3.00 | -3.00 | -3.00 |
| gap | mean 10.7ms, sd 3.5 | mean 12.0ms, sd 16.5 | 158ms |
| `deltaMode` | 0 | 0 | 0 |
| integer deltas | 100% | 100% | 100% |
| wheel events per animation frame | max 1 | max 2 | max 1 |

The trackpad column is real `CGEvent` scrolls posted to the macOS HID event tap
with the cursor warped over the window, so they arrive as genuine `NSEvent`s and
are built by `web_input_event_builders_mac.mm` like any hardware scroll. Its
deltas are drawn from the same distribution the library samples, so the delta
columns are comparable by construction and only the entry point differs. Two
earlier attempts delivered zero events because the window was not frontmost; the
run above was taken after confirming it was.

**The cause is the phase field, not the transport, and that was checked rather
than argued.** Same real `CGEvent` path, same deltas, same 10ms cadence, only the
phase stamping changed:

| | phases real | every event `began` | no phase at all |
|---|---|---|---|
| wheel events | 131 | 131 | 129 |
| cancelable | **1** | **131** | 1 |
| `scrollend` | **1** | **130** | 2 |
| abs `deltaY` | mean 12.21, sd 5.30 | mean 12.21, sd 5.30 | mean 12.4, sd 5.46 |

Stamping `began` on real hardware events reproduces the injected signature
exactly. Sending no phase at all — the shape of a notched wheel, which reports
none and gets a synthesised one from `MouseWheelPhaseHandler` — behaves like real
hardware. So this is not something a timing model can fix and not something
JavaScript can reach; it is a property of where the event enters the stack, in
the same category as `getCoalescedEvents()`. `scroll()` therefore emits a
`WheelPath` with a phase per sample, and `Outcrawl.dispatchWheelPath` is the
entry point that takes it.

Note the third row of the first table: the injected column's `deltaY` reaches 63
against a sampled maximum of 40. That is the same root cause. Every event being
`kPhaseBegan` makes them all mutually coalescable under
`WebMouseWheelEvent::HaveConsistentPhase`, so events queued behind a blocking ack
merge and their deltas sum. Correct phases restore the boundary: a `began` never
merges into the `changed` run behind it.

**A notched wheel and a trackpad have different scroll physics.** A continuous
device reports `kScrollByPrecisePixel`, applied directly; a notched wheel leaves
`delta_units` at `kScrollByPixel`, which Chrome smooth-scroll animates. Same
40px per event, same `deltaY`/`wheelDeltaY` pair of 40/-120 in every column:

| | Real notched mouse | Real trackpad | CDP |
|---|---|---|---|
| wheel events | 8 | 8 | 8 |
| `scroll` events | **174** | 8 | 8 |
| scroll frames per wheel | **21.75** | 1.00 | 1.00 |
| `scrollend` | 1 | 1 | 8 |

This is the same signal the SERP reconstruction below used to split trackpad from
wheel-mouse sessions in public data — 12 frames per wheel against ≤2 — so it is a
signal detectors demonstrably have. `Input.dispatchMouseWheel` always sends
precise pixels, so `HUMAN_WHEEL_MOUSE` over the fallback route emits notch-sized
deltas with trackpad physics. Profiles now carry `wheelGranularity`, and only the
path route can express it.

**Momentum is not modelled, deliberately.** A macOS trackpad flick continues
after the fingers lift, as wheel events with `momentumPhase` set and a decaying
delta ramp. No momentum sample exists in the capture behind `wheelDelta` and
`wheelEventGap` — it holds two gestures and records no phase — so a decay
constant here would be invented, which is what this document exists to remove. It
is also not required: a scroll that ends with `phaseEnded` and no momentum is
what a slow deliberate drag produces, which is common and is a real device shape.
`WheelSample.momentumPhase` exists in the type so that a caller replaying a
recorded human can carry the momentum that human actually produced.

**`PointerEvent.pressure` needs no work at all.** It reads 0 with no button held
and 0.5 with one held — which is exactly what the spec prescribes for hardware
without pressure support, and exactly what a real mouse or trackpad reports. An
early reading of the Chromium source suggested injected events would be pinned
to 0, because the DevTools handler defaults the `force` parameter to 0 when the
driver omits it. Measuring the built browser rather than trusting the source
read showed the mouse path never uses that value. Bot and human are identical
here; there was nothing to fix.

**Scroll deltas do exist in public data — they just are not labelled as such.**
An earlier draft of this file claimed no public dataset records wheel `deltaY`:
Balabit logs only `Scroll Down`/`Scroll Up`, and the SERP dataset logs a `wheel`
event with no delta column. Both statements are true and the conclusion was
still wrong.

The SERP capture also logs `scroll` events carrying `scrollY`, at ~60Hz.
Differencing that position across each `wheel` event recovers the travel that
wheel produced. Two things fall out of it:

*Device separation is visible in the data.* Chrome animates wheel-mouse scrolls
and applies trackpad scrolls directly, so the number of `scroll` frames per
`wheel` splits the sessions cleanly:

| Session style | Sessions | Frames per wheel | Median travel |
|---|---|---|---|
| Animated (wheel mouse) | 1,771 | 12 | 111px |
| Direct (trackpad) | 216 | ≤2 | 16.7px |

*The pages ran at 0.9 zoom.* Every recovered value is a multiple of 1.111, and
scaling by 0.9 makes **100% of them integers** — which is what real device
deltas are, and confirms the reconstruction is sound rather than an artefact.
Zoom-corrected, the wheel-mouse mode lands on exactly **100px per notch**,
independently reproducing the Windows figure from the `normalizeWheel` table
above and cross-checking the whole method.

Trackpad deltas, zoom-corrected with the 100px notches excluded (n=2,963):

```
mean 13.21  sd 9.90  min 1  p10 2  med 11  p90 29  max 40
most common: 6, 1, 13, 7, 5, 11, 8, 23, 14, 19
```

Against the direct capture (n=174, mean 7.13, max 27) the shape agrees — small
right-skewed integers starting at 1 — while the magnitude runs about 2x higher.
That gap is explained: the SERP logger records wheel events at a ~32ms median
cadence against a real ~9.5ms one, so each logged event absorbs part of its
neighbours' travel. The profile therefore keeps its centre near the direct
`deltaY` reading, which carries no such bias, and takes its tail from the
larger sample, which a 174-event capture could never resolve.

**The trajectory model was the last thing still being guessed, and it was the
worst of them.** Everything above concerns individual events. What a
mouse-dynamics detector actually scores is the *shape of the movement* -
velocity profile, corrections, how direct the path is. Those were governed by
two hand-picked numbers, `curvature: 0.18` and `tremorSd: 0.5`.

Measuring 10,395 browser strokes (SERP) and 53,293 from Balabit through the
same feature extractor, then running the generator's own output through it,
gave this:

| Feature | Human | Bezier + tremor |
|---|---|---|
| Sub-movements | med **3** | **30** |
| Duration (D≈230px) | med **~680ms** | **1767ms** |
| Peak-velocity position | **0.40** | **0.50** |
| Path / straight line | med 1.07, p10 1.01, p90 **2.13** | 1.12, p10 1.10, p90 **1.14** |
| Max deviation / distance | **0.09-0.11** | **0.04** |

Every one of them is wrong, and two are wrong in a way no threshold hides.
Per-sample tremor manufactured **30 velocity peaks** where a human makes 3 - the
noise added to look organic was the single most distinguishing feature in the
output. And path efficiency had a standard deviation near zero: every synthetic
stroke was equally direct, where humans range from dead straight to wandering
twice the distance.

The two datasets agree on all of it independently, apart from sub-movement
count, where Balabit reads 1 because its 15.6ms RDP quantisation aliases the
peaks away. The browser figure is used.

**What replaced it.** A stroke is now built from a sum of lognormal velocity
impulses - one ballistic thrust plus corrections - rather than an eased Bezier.
This follows the kinematic account of human reaching: movement is not one
smooth glide but a large opening thrust and a few homing corrections, each with
an asymmetric velocity profile that rises fast and decays slowly. Three
consequences fall out rather than being imposed:

- Summed asymmetric impulses peak **before** the midpoint, which is why humans
  measure 0.40 and an ease-in-out curve is stuck at 0.50.
- The thrust's share of the distance varies, so it sometimes overshoots and the
  corrections pull back, and sometimes falls short so a large late correction
  dominates. That single parameter reproduces the measured spread of
  peak-velocity position from p10 0.13 to p90 0.81.
- Each impulse carries its own slight lateral direction, so the path wanders.

Path length needed one addition. Human strokes reach a path/straight ratio near
2 while their widest departure from the line stays under half the distance -
arithmetic a single arc cannot satisfy, since one big bow raises both together.
Length has to come from repeated small excursions, so a slow one-or-two-cycle
lateral weave sits on top of the bow.

Result, 4,000 generated strokes through the same extractor:

| Feature | Human | Now |
|---|---|---|
| Duration | 271 / 680 / 1545 | 288 / 644 / 1510 |
| Path / straight | 1.01 / 1.07 / 2.13 | 1.01 / 1.07 / 1.67 |
| Peak-velocity position | 0.13 / 0.40 / 0.81 | 0.22 / 0.44 / 0.79 |
| Sub-movements | 1 / 3 / 8 | 1 / 3 / 10 |
| Max deviation / D | 0.02 / 0.09 / 0.47 | 0.03 / 0.12 / 0.41 |

(p10 / median / p90.) Two residuals are worth naming rather than hiding. The
path-efficiency tail is still short - human p98 reaches 5.5, meaning a stroke
five times longer than the straight line, which is almost certainly two separate
movements merged by the 120ms segmentation threshold rather than one reach. And
the sub-movement tail runs slightly heavy, since lateral wander registers as
extra velocity peaks. Neither is modelled, because modelling them would mean
inventing a mechanism rather than measuring one.

`curvature` and `tremorSd` are gone. Per-sample positional noise is not a
feature of human movement at this scale; it was an assumption, and it was the
loudest signal in the output.

**Matching those five features was not enough.** Aggregate statistics can agree
while the stroke still looks wrong close up, so four more were measured, all
scale-free: turn angle per sample, how often direction reverses, how far each
sample sits from its own 5-point smoothed centreline, and the variability of
step length. The human traces are integer-quantised by their logger, so
generated output is rounded the same way before comparing.

| | Turn/sample | Direction flips | HF residual | Step CV |
|---|---|---|---|---|
| Human | 9.50° | 0.569 | 0.270 | 0.827 |
| Kinematic model, first cut | 6.48° | 0.395 | 0.152 | 0.689 |
| Now | 9.77° | 0.484 | 0.252 | 0.711 |

Closing that gap took two corrections, and the first attempt at each was wrong.

*Noise on the speed does not work.* Adding it raised the fine-grained measures
but pushed sub-movements from 3 back to 6 - the same failure as the original
tremor, arriving by a different route. Anything that perturbs speed directly
shows up as extra velocity peaks.

*Sample timing is the mechanism.* Within-stroke gaps between real `mousemove`
events have a coefficient of variation of **0.95** (n=555,517): a tight core at
16-18ms against the frame interval, then a heavy tail at 34ms and beyond where
frames are missed. Sampling position at those irregular times reproduces the
step-length variability *without* touching the velocity profile, because
distance and elapsed time move together. Sub-movements stayed at 3 while the
fine-grained measures came up.

*A long gap means less movement, not more.* Driving the model straight from
that distribution overshot - step CV went to 1.03 against a human 0.83 - because
a long gap was being treated as a long stretch of travel. A browser emits a move
only when the pointer moves, so in real data a long gap is the hand hesitating.
Counting anything past about one and a half frames as dwell, where the clock
advances and the stroke does not, brought step CV to 0.71 and the residual to
0.25.

What remains: direction flips run about 15% under human and step CV about 14%
under. Part of that is a segmentation artefact - generated strokes begin and end
at rest, while human strokes cut at a 120ms pause often start mid-motion, and
trimming both ends narrows the gap - but not all of it.

## The classifier test

Feature-by-feature agreement is not proof. The real question is whether a model
trained to separate the two can. A gradient-boosted classifier was given 30
features per stroke - the ones tuned above plus untuned ones: lag-1
autocorrelations, the 2/3 power-law exponent relating angular velocity to
curvature, acceleration magnitude, start and end speed. Human folds are split by
**participant**, so it is scored on people it never trained on.

**The control matters more than the score.** Real participants split into two
groups and classified against each other give AUC **0.53**. Humans are
homogeneous under these features, so that is the floor - anything near it is
indistinguishable, and a high score is a real signal rather than an artefact of
the method. Every comparison below is scored against a floor computed on the
same split and the same number of strokes, because both move the number.

| | AUC | floor | |
|---|---|---|---|
| Corpus replay | **0.525** | 0.528 | at the floor |
| Parametric kinematic model | **0.90** | 0.53 | trivially separable |

The parametric model fails, and it fails in an instructive way. After fixing
what the classifier pointed at, *every individual feature* sat at the floor -
turn angle AUC 0.511, peak-velocity position 0.535 - while the joint AUC stayed
at 0.90. Fifteen hand-tuned parameters can match every marginal distribution
without matching the joint distribution, and that gap is exactly what a
classifier occupies. This is the limit of the approach, not a tuning failure.

Replay reaches the floor only when the corpus is dense enough. Warping a stroke
away from the distance it was recorded at is the one step that measurably
degrades it, so the player binary-searches for the nearest unplayed stroke by
recorded distance. At 3,953 strokes over a 100-600px range the median warp is
**0.1%** and the classifier cannot separate the output from real strokes. The
same code against a 900-stroke corpus, where the nearest match is 5-10% away,
scores 0.019 above its floor.

Three things it found that hand-checking had missed:Three things it found that hand-checking had missed:

- **The per-sample jitter was pure error.** Setting it to zero moved direction
  reversals from 0.479 to 0.376 against a human 0.377. It had been added to fix
  a discrepancy that was itself an artefact of measuring at the wrong scale.
- **The gap distribution was mis-measured.** The first figure put the CV at
  0.95; that filter swept in the pauses *between* strokes. Within a stroke it is
  0.58, and using the wrong one made `dt_frac_long` a giveaway.
- **Strokes arrived accelerating.** Lognormal impulses are not finished at t=1,
  so the remaining distance was being dumped into the final step - a real stroke
  decelerates onto its target.

Two failures were in the harness rather than the model, and both would have been
read as bot signals:

- **Rotation artefact.** Replayed strokes showed elevated turn angles until the
  same rotation was applied to real strokes, which reproduced the numbers
  exactly (direction reversals 0.520 rotated vs 0.524 replayed). Rotating an
  integer-quantised path and re-rounding manufactures zig-zag. The test was
  biased against anything that rotates.
- **Memorisation.** Replaying 900 shapes across 4,000 outputs let the classifier
  learn the shapes themselves, since the same shape appeared in training and
  test folds. AUC 0.90 collapsed once each shape was used once. That is a real
  operational constraint, not just a test flaw: a finite corpus repeats, so
  `CorpusPlayer` draws without replacement.
- **Mislabelled sources.** The player selects by distance, not in request order,
  so labelling each output with the participant it was *requested* for grouped
  the folds wrongly and let the classifier learn individual people. Grouping by
  the true source - `lastIndex` exists for exactly this - removed half the
  remaining gap.

Each of those three inflated the score in a way that looked like a bot signal.
A test that has never been wrong in your favour has probably not been checked.

## Keyboard

Typing was measured the same way and needed the same correction: replay, not
resampling.

**Latency depends on the keys, not just the typist.** Over 460,812 real
transitions:

| Transition | Median |
|---|---|
| Same key repeated | 147ms |
| Alternate hands | 160ms |
| Same hand | 180ms |
| Same finger, different key | 186ms |

Row distance adds on top, monotonically: 151ms at no row change, 185ms across
three. One sampled figure cannot produce that structure, and the structure is
checkable from the text alone.

This also solves a problem the corpus creates. A form asks for an address or a
card number; the recorded text is English prose containing no `@` at all and
almost no digits. Latency generalises through the physical relationship between
the keys, so a timing recorded on `th` can be carried onto `4@` correctly.

**23% of real keystrokes overlap.** In the Aalto set - raw press and release
timestamps from 1,338 people - the next key goes down before the current one
comes up almost a quarter of the time, and the KeyRecs corpus agrees at 17%.
A press-release-press-release loop produces zero, and the ordering of keydown
and keyup is visible to any listener. Typing is now scheduled on a timeline and
emitted in time order.

Getting there took two wrong turns worth recording. Walking the recorded stream
contiguously preserves the correlation between consecutive hold times but
destroys the relationship between row distance and latency, because the timings
then bear no relation to the text being typed: AUC 0.85. Splitting the two -
hold from a contiguous walk, latency from a transition match - fixes that and
breaks something else, because hold and latency taken from different keystrokes
can no longer produce overlap, which fell to 3%. Both values have to come from
the same recorded keystroke, chosen to match the transition *and* the key.

Scored within the dataset, against a floor from real participants held out of
the corpus:

| | AUC |
|---|---|
| Real typing, held-out participants | 0.533 |
| Replayed streams | 0.573 |

Close, and not yet the equal of the pointer result. The strongest remaining
signal is the autocorrelation of hold times, which the transition search still
disturbs.

**A caution about cross-dataset scores.** Testing the same output against the
Aalto humans instead gives AUC 0.979 - which looks damning until the control is
run: *real KeyRecs typing* scores 0.986 against Aalto. The two datasets differ
from each other more than the output differs from its own source, so a
cross-dataset number measures collection conditions, not humanity. It is
reported here because it is the kind of figure that would otherwise be quoted
in either direction without its control.

**Licensing.** The shipped keystroke corpus is KeyRecs, CC BY 4.0, which permits
commercial use. The Aalto 136M dataset is far larger and richer - raw press and
release timestamps, 168,000 participants, modifier keys recorded separately -
but its licence is non-commercial, so it is used here only to validate and to
measure the overlap rate, never redistributed.

## Sources

Five datasets were examined; three carried raw event-level timing and are used
above. The other two — SapiMouse and the Minecraft mouse-dynamics set — publish
only preprocessed feature vectors (speed/acceleration summaries), with no event
stream to measure, so nothing from them could be used.

| Dataset | Capture | Used for |
|---|---|---|
| [Balabit Mouse Dynamics](https://github.com/balabit/Mouse-Dynamics-Challenge) | RDP, 10 users, 1,676 sessions | click dwell, wheel bursts |
| [SERP mouse & eye movements](https://zenodo.org/records/15236546) | in-browser, 47 participants | move cadence, wheel bursts, click dwell |
| [KeyRecs](https://zenodo.org/records/7886743) | 99 participants | key dwell and flight |
| [SapiMouse](https://github.com/margitantal68/sapimouse) | features only | — |
| [Minecraft Mouse Dynamics](https://github.com/NyleSiddiqui/Minecraft-Mouse-Dynamics-Dataset) | features only | — |

Pointer *rate* could only come from the browser dataset: median gap between
`mousemove` events is 17ms (~59Hz), with p90 at 41ms. Balabit cannot answer this
question at all — its inter-event gaps cluster on 0, 15, 16 and 31ms, the RDP
transport tick, not the hardware.

## Re-measuring

The profile came from one person on one machine, and yours will differ —
trackpad versus mouse, display refresh rate, and OS pointer acceleration all
move these numbers.

1. Serve `harness/probe.html`.
2. Open it, click the three targets with a real mouse, type in the field, press
   **Report**, and keep the JSON.
3. Drive the same page with your automation and capture its report.
4. Compare, and write the human values into an `InputProfile`.

Collect several human sessions rather than one. The first single-session capture
here gave a click-dwell sd of 8.3ms; pooling six sessions corrected it to 13.7ms,
and only the pooled sample revealed that coalesced events ever exceed 1.
