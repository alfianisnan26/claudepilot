# Checks per screen

Run each at 390 px (touch) and 1280 px, in light and dark. Write the result per row on the ticket: pass, fail (with the screenshot), or not checked (with why).

## Device presets

| Preset | Viewport (`emulate`) | Notes |
| --- | --- | --- |
| Phone | `390x844x3,mobile,touch` | The first width checked |
| Phone landscape | `844x390x3,mobile,touch,landscape` | When the layout or the keyboard area changes |
| Small phone | `360x740x3,mobile,touch` | When text or rows are tight |
| Tablet | `768x1024x2,mobile,touch` | When a breakpoint is near |
| Desktop | `1280x800x1` | The second width checked |
| Wide | `1920x1080x1` | When a layout stretches |

Throttling for phone realism: CPU rate 4, network `Fast 3G` or `Slow 4G`. Offline states: `Offline`. Reset both afterwards.

## Layout

| Check | How |
| --- | --- |
| No horizontal page scroll | A read-only `browser_evaluate`: the document element's `scrollWidth` is not greater than `window.innerWidth` |
| Touch targets at least 44 x 44 px | Read the bounding boxes of buttons, links and inputs in the area you changed |
| No clipped or overlapping text | Screenshot, looked at; long-text and no-space data in the fixture |
| Nothing under the notch or home indicator | Screenshot with safe-area insets on |
| The keyboard does not cover the focused input | Phone preset, focus the input, screenshot |
| The page does not rubber-band or drag | The project's own harness, where it has one |
| Lists hold still | Add and remove an item: the visible neighbours keep their positions |

## Behaviour

| Check | How |
| --- | --- |
| Console clean | `browser_console_messages` at level error, then warning: nothing new |
| Network clean | `browser_network_requests`: no failed calls, no unexpected hosts, no request repeated in a loop |
| Every state | Loading, empty, error with a retry, unavailable with a reason, permission denied, offline, extreme data (0, 1, many; 1 and 200 characters; huge numbers) |
| Keyboard path | Tab through the area: visible focus, sensible order, every action reachable |
| Labels | Icon-only controls have an accessible name (`browser_snapshot` shows it) |
| Themes | Light and dark from the same tokens; contrast holds in both |
| Reduced motion | `browser_emulate_media` reduced motion: no movement left that carries meaning only by motion |

## Evidence

- Screenshot names: `<route>-<width>-<theme>[-<state>].png`.
- A layout fix ships with an automated check that failed before the fix.
- Measurements carry their conditions: tool and version, device preset, throttling, machine load.
