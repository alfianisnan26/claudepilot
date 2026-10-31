# UI review checklist

Paste into the pull request or the ticket. The project's own checklist replaces this one where it exists. Each line: pass, fail (with evidence), or not checked (with why).

```
Standard read: <document and section>             | none found (said so on the ticket)
Tokens only: no new colour, spacing, size, radius, duration
No decoration: no gradient, glow, emoji; glass only where the standard names it
Existing components reused: <which>
Adjusted first: the existing token, opacity, spacing or prop was tuned; any new element or wrapper says why no adjustment could do
Sibling pages sharing the look got the same fix: <which>
390 px, light   screenshot: <link>
390 px, dark    screenshot: <link>
1280 px, light  screenshot: <link>
1280 px, dark   screenshot: <link>
No horizontal page scroll at any width checked
Touch targets >= 44 px in the changed area
Text wraps; long and no-space data checked
Lists hold still on add and remove
States: loading, empty, error + retry, unavailable + reason, denied, offline
Extreme data: 0 / 1 / many items, 1 / 200 characters, huge numbers
Text diet: titles 1-2 words, explanations in a tooltip, one primary action
Numbers: each has a source; estimates labelled; unknown shown as unavailable
Keyboard: focus visible, order sensible, icon-only controls named
Contrast AA in both themes; colour not the only signal
Motion: explains a change, short, transform/opacity, reduced motion respected
Automated check added (layout fixes): <test or harness>
Reviewed by: <someone other than the author>
```
