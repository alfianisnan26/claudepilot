# Code viewer: tokens to theme (T-148)

The read-only code viewer (`apps/web/src/features/code/`) is CodeMirror 6, styled only with the portal's CSS variables so light and dark
follow the app's theme live. Nothing of CodeMirror is in the main bundle: `CodeViewer.tsx` loads `CodeMirrorView.tsx` on the first file
opened, and each language's grammar loads on its own (`languages.ts`).

| Part | Token |
| --- | --- |
| text | `--ink` on a transparent background (the sheet's `bg`) |
| frame | `rounded-xl`, `border-line` |
| gutter (line numbers) | background `--surface-2`, numbers `--muted` (tabular), border `--line` |
| selection | `--accent` at 30 percent (native selection, so a long press selects on iOS) |
| comment, meta | `--muted`, italic |
| string, regexp, inserted | `--code-string` (emerald 700 / 400) |
| keyword, tag | `--code-keyword` (violet 700 / 300) |
| number, bool, null, atom, `$VAR` | `--code-number` (cyan 700 / 300) |
| property, attribute, key, link | `--code-flag` (blue 700 / 300) |
| type, class, changed | `--code-type` (amber 700 / 400) |
| deleted, invalid | `--danger` |
| operator, punctuation | `--ink-soft` |
| disguising character or an escape `⟦U+202E⟧` | `--danger` on `--danger-soft` |

The `--code-*` steps are the ones a tool row's CodeBlock uses (Tailwind 700 in light, 300 or 400 in dark), defined in
`apps/web/src/index.css`, so a file, a diff and a tool row read as one family. The font is `MONO` (`features/code/font.ts`), 12.5 px, line
height 1.6. A wrapped line hangs 2ch under its own start; long words break anywhere.
