---
name: design-standard
description: "Use when building, changing or reviewing any user interface: a new screen, component, state, layout, copy, colour, spacing or animation, or a UI bug fix. Gives the order to follow (find and read the project's own design standard first, use only its tokens, never invent new ones) and the generic rules that hold in any project where its standard is silent: phone width first then desktop, light and dark, 44 px touch targets, no horizontal page scroll, lists that hold still, the text diet, every state, honest numbers with a source, and motion that explains and respects reduced motion."
---

# Design standard

This skill is a slot. Every project has, or should have, its own design standard; that document decides. This skill tells you how to find it and follow it, and gives the rules that hold anywhere when the project's standard says nothing.

## First: find the project's standard

1. Look, in this order, and stop at the first hit:
   - the design document the project names in its CLAUDE.md, README or a delivered context;
   - a `docs/design/` folder (read its index first);
   - a design-standard context or skill the workspace delivers for this project;
   - the docs system the project names (a wiki, an Outline collection).
2. Read the parts that matter for your change: principles, tokens, the component catalogue, the patterns, the review checklist.
3. **The project's standard wins** over this skill wherever they differ.
4. **None found:** say so on the ticket ("no design standard found; followed the generic rules of the design-standard skill and the existing components"). Derive from the code: the shared components, the theme and token source. Propose a standard as a ticket; do not write one as a side effect of a feature.
5. Never apply one project's standard to another project. Each program keeps its own.

## Tokens: use, never invent

- Use only the colours, spacing steps, type sizes and weights, radii, shadows, blur, durations and easings the project defines (its theme, CSS variables, Tailwind config or design-system package).
- No hard-coded hex, pixel or millisecond values where a token exists. No new token because it "looks better".
- Need a value that does not exist? Use the nearest token, note it in the change, and open a ticket for the owner of the standard. The standard's owner decides tokens and the standards check's thresholds, not you.
- **No tokens yet** (a new project): do not make up a palette inside a feature. Use the stack's or the chosen base design system's defaults unchanged, say so on the ticket, and let the token set come from its own ticket, reviewed, before features depend on it.
- No decoration that does no work: no gradients, glow, emoji or decorative icons. A translucent (glass) surface only where the standard names it; the first program allows it only for the floating header and tab bar.
- Reuse the existing component before you write a new one. Two components that do one job is drift.

## Generic rules (where the project's standard is silent)

**Layout**
- Design and check at phone width first (390 px), then desktop (1280 px). Check phone landscape and a middle width when the layout changes.
- No horizontal page scroll at any width. Text breaks anywhere (long words, IDs and URLs wrap); flex and grid children that hold text may shrink; user text never sets a container's width.
- Respect safe areas on phones (notch, home indicator). The on-screen keyboard never covers the input in use.
- The page itself does not rubber-band or drag; full-screen views are pinned. Use the project's helpers for this; never undo them.

**Touch and input**
- Every interactive target is at least 44 x 44 px.
- Visible focus, a complete keyboard path, an accessible name on every icon-only control.
- A disabled control shows its reason visibly, not only in a tooltip.

**Themes**
- Light and dark, both from tokens. Contrast at least WCAG AA in both. Colour is never the only signal: add a shape, an icon or a letter.

**Lists that hold still**
- Stable keys, reserved space, skeletons the same size as the content.
- New items arrive at an edge or the scroll is anchored; nothing already visible jumps, and the item under the finger never moves.
- Long lists page or window; they do not grow without bound.

**Text diet**
- Titles of one or two words. The explanation goes in a tooltip or info tip, not a paragraph on the screen.
- On phones, icon-only where the icon is clear (with its accessible name).
- One primary action per screen. No card inside a card, no badge that repeats the row.
- Plain, short, consistent terms. No filler, no marketing words, no blame in error text.

**Every state**
- Loading (a skeleton, not a long spinner), empty (what it is and the next action), error (what happened and a retry), unavailable with its reason, permission denied, offline.
- Extreme data: 0, 1 and hundreds of items; 1 and 200 characters; text without spaces; huge numbers; right-to-left text.

**Honest numbers**
- Every number shown has a source: where it came from and when. Estimates are labelled as estimates.
- Unknown is shown as "unavailable" with the reason, never as 0, a dash that looks like a value, or a guess.
- Numbers in tables use tabular figures.

**Motion**
- Motion explains a change (where something came from, where it went); it is never decoration.
- Short (about 120 to 250 ms), transform and opacity only, no layout shift.
- Under reduced motion it becomes a fade or nothing. It never moves content under the pointer or breaks a scroll that follows new content.

## Checking a UI change

1. Screenshots at 390 and 1280 px, light and dark, looked at (see the browser-testing skill).
2. The project's UI harnesses and its review checklist, with the evidence attached to the ticket.
3. A layout fix ships with an automated check that fails before the fix.
4. Review by someone other than the author.
5. A rule you find broken elsewhere is a new ticket, not a sweep inside your slice.

See `references/review-checklist.md` for a checklist to paste into a UI pull request.
