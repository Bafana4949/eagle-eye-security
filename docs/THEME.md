# Eagle Eye Theme

The palette comes from Dawie's original app (`:root` in `1 - app (host these files)/index.html`).
The tokens are defined once in `src/app/globals.css` inside Tailwind v4's `@theme` block. Each
`--color-ee-*` token becomes Tailwind utilities, e.g. `--color-ee-bg` → `bg-ee-bg`, `text-ee-bg`,
`border-ee-bg`.

## Colour tokens

| Token (`@theme`) | Utility example | Dawie variable | Hex | Use for |
| --- | --- | --- | --- | --- |
| `--color-ee-bg` | `bg-ee-bg` | `--night` | `#18212B` | Page background |
| `--color-ee-surface` | `bg-ee-surface` | `--panel` | `#212C38` | Cards, panels, bottom navigation |
| `--color-ee-surface-raised` | `bg-ee-surface-raised` | – (panel, lightened) | `#2A3746` | Hover / pressed surfaces |
| `--color-ee-border` | `border-ee-border` | `--line` | `#324050` | Borders, dividers, inactive outlines |
| `--color-ee-text` | `text-ee-text` | `--bone` | `#E9E4D8` | Headings and body text |
| `--color-ee-muted` | `text-ee-muted` | `--dim` | `#9AA5B1` | Secondary text, labels, inactive nav |
| `--color-ee-primary` | `bg-ee-primary` | `--lamp` | `#F0A53A` | Primary buttons, active nav, focus ring, links |
| `--color-ee-primary-strong` | `bg-ee-primary-strong` | `--lamp-deep` | `#C9801C` | Primary pressed / emphasis |
| `--color-ee-on-primary` | `text-ee-on-primary` | – | `#2A1A04` | Text on primary fills |
| `--color-ee-success` | `text-ee-success` | `--ok` | `#76C08F` | Done, online, uploaded, GPS verified |
| `--color-ee-warning` | `text-ee-warning` | `--lamp` | `#F0A53A` | Due soon, offline, queued, low GPS confidence |
| `--color-ee-danger` | `bg-ee-danger` | `--bad` | `#E0685C` | Errors, missed, outside radius, failed upload (fills, icons, large text) |
| `--color-ee-danger-text` | `text-ee-danger-text` | – | `#EF8A80` | Danger **small text** on `ee-surface` / tinted panels (`ee-danger` is only 4.25:1 there, below WCAG AA; this is 5.8:1) |
| `--color-ee-sos` | `bg-ee-sos` | – | `#B3261E` | SOS button |
| `--color-ee-sos-deep` | `bg-ee-sos-deep` | – | `#7A1812` | SOS / panic screen background |
| `--color-ee-on-danger` | `text-ee-on-danger` | – | `#FFFFFF` | Text on SOS / danger fills |

Dawie's variable names (`--night`, `--panel`, `--line`, `--bone`, `--dim`, `--lamp`, `--lamp-deep`, `--ok`,
`--bad`) are still defined in `:root` as aliases of the tokens, for any CSS that uses them.

## Fonts

- **Barlow** – body text (`font-sans`, from `--font-barlow`).
- **Barlow Condensed** – headings, big numbers, buttons (`font-display`, from `--font-barlow-condensed`).

Both are loaded with `next/font/google` in `src/app/layout.tsx` (Dawie's app used the same two families).

## Rules

1. Components use the `ee-*` tokens only. **No hex literals, `rgb()` values or other Tailwind palettes**
   (`red-500`, `slate-900`, …) in components. Need a new colour? Add a token to `@theme` in `globals.css`
   and a row to this table.
2. Status colours carry meaning: success = done/uploaded, warning = waiting/queued/weak GPS,
   danger = failed/missed/outside. Never use colour alone – always add text or an icon.
3. SOS uses only `ee-sos`, `ee-sos-deep` and `ee-on-danger`. Nothing else in the app uses these reds, so the
   SOS control is never confused with an ordinary error.
4. Small red text on dark panels uses `text-ee-danger-text`, not `text-ee-danger`.
5. The app is dark only (`color-scheme: dark`). Printing (QR checkpoint cards) switches to white paper with
   black text.
6. Exceptions: `globals.css` itself (token definitions and the punch-clock button's highlight gradient).
