# Tracearr Style Guide

`apps/web/src/styles/globals.css` is the source of truth. This guide quotes it and says what
each token is for; when the two disagree, the CSS wins and this file needs fixing.

## 1. Core brand concept

Tracearr's visual identity reflects:

- **Security**: controlled access, protection, enforcement
- **Visibility**: tracing sessions, device intel, location anomalies
- **Modern simplicity**: clean geometry, minimal noise
- **Deep contrast**: a near-black page where posters and data carry the color

---

## 2. Logo system

### Primary logo (horizontal)

Shield icon left + "TRACEARR" wordmark.

### Icon-only logo

Shield monogram with stylized T-path + radar arcs.

### Safe spacing and minimum size

- Clearspace around the logo = height of the dot at the bottom of the shield.
- Minimum display:
  - Icon only: **24×24 px**
  - Full logo: **140 px width**

### Backgrounds

- Solid dark or solid light backgrounds recommended.
- Avoid busy imagery behind the logo.

### Brand colors

The logo (`components/brand/Logo.tsx`) is the only user of these tokens. The cyan steps follow
the accent hue, so the logo matches the accent the user picked.

| Token        | Value                     | Usage              |
| ------------ | ------------------------- | ------------------ |
| `cyan-core`  | `hsl(accent-hue 80% 50%)` | Logo mark and arcs |
| `cyan-deep`  | `hsl(accent-hue 86% 42%)` | Brand gradients    |
| `cyan-dark`  | `hsl(accent-hue 85% 31%)` | Brand outlines     |
| `blue-core`  | `#0B1A2E`                 | Logo shield fill   |
| `blue-steel` | `#162840`                 | Logo shield panel  |
| `blue-soft`  | `#1E3A5C`                 | Brand hover        |

Logo glow: `0px 0px 14px rgba(24, 209, 231, 0.22)`.

---

## 3. How tokens are stored

Each token is a bare channel triplet in a CSS variable, and the `@theme inline` block in
`globals.css` wraps it once to make the Tailwind color (`bg-card`, `text-success`, `/50`
opacity modifiers and all).

- Neutrals and surfaces are HSL triplets: in TypeScript, `hsl(var(--border))`.
- Accent, status and data-viz tokens are OKLCH triplets: `oklch(var(--chart-1))`.

Highcharts and inline styles cannot use Tailwind classes, so they write the wrapper
themselves. Chart code imports its colors from `components/charts/chartUtils.ts`
(`CATEGORICAL_COLORS`, `MEDIA_TYPE_COLORS`, `PLAYBACK_COLORS`) and
`lib/resolutionColors.ts` rather than writing token strings by hand.

Light mode is `:root`; dark mode is `.dark` on the same `<html>` element. Tokens declared only
on `:root` that reference another token (the media and playback mappings) resolve against
whichever mode is active for that reason.

No raw Tailwind palette class (`text-green-500`, `bg-amber-500/10`), hex, `hsl(...)` or
`rgb(...)` literal belongs in a component. The exceptions are listed in section 13.

---

## 4. Surfaces and elevation

Three surface steps plus the popover. A panel separates from the page by fill, so borders stay
quiet.

| Token         | Dark         | Light          | Usage                                            |
| ------------- | ------------ | -------------- | ------------------------------------------------ |
| `background`  | `240 10% 4%` | `240 5% 97%`   | Page                                             |
| `card`        | `240 6% 7%`  | `0 0% 100%`    | Panels, stat tiles, dialogs, sheets              |
| `card-raised` | `240 5% 10%` | `240 5% 98.5%` | Anything nested in a card or sheet, builder rows |
| `popover`     | `240 5% 11%` | `0 0% 100%`    | Menus, popovers, chart tooltips                  |
| `muted`       | `240 4% 16%` | `240 5% 96%`   | Skeletons, subtle fills, placeholder art         |
| `sidebar`     | `240 6% 6%`  | `0 0% 98%`     | App sidebar                                      |
| `overlay`     | `240 10% 4%` | same           | Scrims over artwork, maps and modals             |

`Card` steps itself up: a `Card` or `StatCard` inside a `Card` (or a `StatCard` inside a sheet)
takes `bg-card-raised` and drops its shadow. Do not set `bg-card-raised` by hand on a card.

`overlay` and `overlay-foreground` (`0 0% 98%`) do not change with the theme. Artwork has no
theme, so anything laid over a poster (chips, the hover panel, the paused scrim on Now
Playing) uses `bg-overlay/NN` and `text-overlay-foreground`. Never put `text-foreground` on a
scrim: in light mode it is near-black on near-black.

Shadows: cards `shadow-sm`; dialogs `shadow-lg`; lifted posters
`shadow-[0_12px_32px_hsl(var(--overlay)/0.7)]`.

---

## 5. Text and borders

| Token              | Dark         | Light        | Usage                                             |
| ------------------ | ------------ | ------------ | ------------------------------------------------- |
| `foreground`       | `0 0% 98%`   | `240 10% 4%` | Body text, values                                 |
| `muted-foreground` | `240 5% 65%` | `240 4% 46%` | Labels, captions, axis labels, neutral state      |
| `border`           | `240 4% 18%` | `240 6% 88%` | Layout lines, card edges, table rules             |
| `input`            | `240 4% 16%` | `240 6% 90%` | Input fill in dark mode                           |
| `control`          | `240 4% 44%` | `240 4% 55%` | Boundary of checkboxes, radios, text fields (3:1) |

Contrast, WCAG 2.x:

| Pair                        | Dark   | Light  |
| --------------------------- | ------ | ------ |
| foreground on card          | 18.0:1 | 19.8:1 |
| muted-foreground on card    | 7.3:1  | 4.8:1  |
| muted-foreground on page    | 7.7:1  | 4.5:1  |
| muted-foreground on popover | 6.7:1  | 4.8:1  |

---

## 6. Accent

The accent is one OKLCH hue with lightness fixed per mode, so every preset gives the same
contrast. `ThemeProvider` writes `--accent-h`, `--accent-cl` and `--accent-cd` from
`ACCENT_PRESETS` (`components/theme-provider.tsx`).

| Token                     | Dark                             | Light                           |
| ------------------------- | -------------------------------- | ------------------------------- |
| `primary`                 | `oklch(0.75 accent-cd accent-h)` | `oklch(0.5 accent-cl accent-h)` |
| `primary-foreground`      | `oklch(0.18 0.02 accent-h)`      | `oklch(0.99 0 0)`               |
| `ring`, `sidebar-primary` | same as primary                  | same as primary                 |

Presets (HSL hue is what is stored in the browser; OKLCH hue is what renders):

| Name   | HSL hue | OKLCH hue | Text on primary, dark | White on primary, light |
| ------ | ------- | --------- | --------------------- | ----------------------- |
| Cyan   | 187     | 212       | 8.8:1                 | 5.8:1                   |
| Blue   | 220     | 260       | 8.4:1                 | 6.2:1                   |
| Purple | 270     | 293       | 8.1:1                 | 6.5:1                   |
| Pink   | 330     | 354       | 7.8:1                 | 6.7:1                   |
| Red    | 0       | 25        | 8.0:1                 | 6.6:1                   |
| Orange | 24      | 45        | 8.0:1                 | 6.4:1                   |
| Green  | 150     | 150       | 9.0:1                 | 5.6:1                   |
| Teal   | 175     | 183       | 8.9:1                 | 5.7:1                   |

Teal is a Tracearr preset that predates tofa's teal brand color; the two stay separate tokens.
The light column is against pure white; the rendered `oklch(0.99 0 0)` ink reads about 0.15
lower (Green 5.5:1, the lowest). Primary as text reads at 7.8:1 or better on the dark card
and 5.3:1 or better on the light page.

The accent is for interaction: buttons, links, focus rings, selected states, the active nav
mark, stat tile icon chips and single-series charts. It is never a status color.

---

## 7. Status

Reserved for state. A status color is never a chart series and never decoration.

| Token         | Dark (oklch)       | Light (oklch)   | Meaning                            |
| ------------- | ------------------ | --------------- | ---------------------------------- |
| `success`     | `0.76 0.15 150`    | `0.48 0.13 150` | Done, healthy, connected, up       |
| `warning`     | `0.8 0.15 80`      | `0.5 0.11 65`   | Paused, pending, degraded, caution |
| `destructive` | `0.68 0.19 25`     | `0.51 0.2 25`   | Error, failed, delete, down        |
| `info`        | `0.74 0.12 250`    | `0.49 0.13 250` | In progress, informational         |
| neutral       | `muted-foreground` | same            | Unknown, skipped, not started      |

Measured from a headless Chrome render (sRGB, pixels sampled, alpha composited by the
browser), in the order success, warning, destructive, info:

| Where the text sits              | Dark               | Light              |
| -------------------------------- | ------------------ | ------------------ |
| Flat card (white in light mode)  | 9.3, 9.9, 6.0, 8.2 | 6.2, 6.2, 6.4, 6.3 |
| Callout tint `/10` on the card   | 7.9, 8.4, 5.4, 7.1 | 5.3, 5.3, 5.4, 5.4 |
| Pill tint `/15` on the card      | 7.2, 7.6, 5.0, 6.5 | 4.9, 5.0, 4.9, 5.0 |
| Pill tint `/15` on the page      | 7.9, 8.3, 5.4, 7.1 | 4.6, 4.7, 4.6, 4.7 |
| Pill tint `/15` on `card-raised` | 6.7, 7.0, 4.7, 6.0 | 4.8, 4.8, 4.7, 4.8 |

The lowest is 4.58:1 (light destructive pill on the page). Every status color passes AA as
12px text on its own tint and on every surface, in both modes. Light values sit at L 0.48 to
0.51 for that reason; at 0.52 to 0.55 the pills measured 3.9 to 4.3:1.

Patterns:

- Text or icon: `text-success`.
- Pill: `<Badge variant="success" | "warning" | "danger">` (15% tint, status text).
- Callout: `<Alert variant="warning" | "destructive">`, or for an inline box
  `border-warning/20 bg-warning/5` with a `text-warning` icon and title.
- Dot: `bg-success`.
- Graded health (direct play rate and similar): success, warning, destructive by threshold,
  from one tone map per component.

`destructive-foreground` is the text on a filled destructive button or badge: white on the
light fill reads 6.4:1, and on the dark button (`destructive/60` over the card) 6.6:1.

---

## 8. Data visualization

Three kinds of palette, each with one job.

### 8.1 Categorical: `chart-1` to `chart-8`

For unordered categories: platforms, top lists, media types, playback decisions. Light mode
varies lightness by hue (warm hues lighter, so orange stays orange instead of brown) and keeps
every step at 3:1 or better against the white card. Dark mode sits at L 0.70 to 0.78.
Ratios are measured from a headless Chrome render.

| Token     | Hue     | Dark (oklch)    | Light (oklch)   | Light vs white | Dark vs card |
| --------- | ------- | --------------- | --------------- | -------------- | ------------ |
| `chart-1` | blue    | `0.72 0.14 255` | `0.55 0.17 255` | 4.9:1          | 7.6:1        |
| `chart-2` | orange  | `0.76 0.15 55`  | `0.68 0.17 50`  | 3.1:1          | 8.5:1        |
| `chart-3` | magenta | `0.72 0.16 340` | `0.58 0.19 340` | 4.8:1          | 7.1:1        |
| `chart-4` | teal    | `0.74 0.11 200` | `0.6 0.1 200`   | 3.8:1          | 8.5:1        |
| `chart-5` | violet  | `0.7 0.15 295`  | `0.55 0.17 295` | 5.2:1          | 6.7:1        |
| `chart-6` | olive   | `0.78 0.13 100` | `0.66 0.13 100` | 3.1:1          | 9.5:1        |
| `chart-7` | green   | `0.74 0.15 150` | `0.6 0.15 150`  | 3.7:1          | 8.7:1        |
| `chart-8` | rose    | `0.7 0.16 15`   | `0.6 0.17 15`   | 4.3:1          | 6.6:1        |

Eight hues cannot all avoid the four server brand hues. chart-4 sits near tofa teal, chart-6
near Plex gold, chart-5 near Jellyfin purple and chart-7 near Emby green, so the fixed mappings
below use chart-1 to chart-5 only.

### 8.2 Fixed mappings

Defined once in `globals.css`, read through Tailwind (`bg-media-movie`) or `chartUtils.ts`.

| Meaning         | Token                | Color   |
| --------------- | -------------------- | ------- |
| Movies          | `media-movie`        | chart-1 |
| TV / episodes   | `media-show`         | chart-2 |
| Music / tracks  | `media-music`        | chart-3 |
| Other media     | `media-other`        | chart-4 |
| Direct play     | `playback-direct`    | chart-1 |
| Direct stream   | `playback-copy`      | chart-4 |
| Audio transcode | `playback-audio`     | chart-5 |
| Transcode       | `playback-transcode` | chart-2 |

The categorical colors are tuned for 3:1 graphics, not 4.5:1 text. A media type badge colors its
icon and keeps its label on the text token.

### 8.3 Sequential: `seq-1` to `seq-7`

For ordered data: resolution tiers (`lib/resolutionColors.ts`), engagement tiers
(`TIER_COLORS` in `EngagementChart.tsx`), completion, the request funnel. Highest tier first.
Dark mode runs bright to dark; light mode runs dark to light. The weakest step keeps 3:1:
seq-7 measures 3.0:1 on the white card and 3.2:1 on the dark card. Where several tiers are
lines on one chart (`QualityTimelineChart`), each tier also gets its own dash pattern and the
lines are 3px, because neighboring steps are close in color.

| Step  | Dark (oklch)    | Light (oklch)   |
| ----- | --------------- | --------------- |
| seq-1 | `0.9 0.04 300`  | `0.33 0.14 295` |
| seq-2 | `0.83 0.07 290` | `0.39 0.16 285` |
| seq-3 | `0.76 0.11 278` | `0.45 0.17 272` |
| seq-4 | `0.69 0.15 266` | `0.51 0.16 260` |
| seq-5 | `0.62 0.14 254` | `0.57 0.14 248` |
| seq-6 | `0.56 0.11 242` | `0.62 0.11 236` |
| seq-7 | `0.5 0.08 230`  | `0.66 0.08 225` |

### 8.4 Chart rules

- One series: `primary`, with the area gradient `primary / 0.3` to `primary / 0.05`.
- Two-value comparison (validated plays against raw sessions): `chart-1` against
  `muted-foreground`.
- Stacked areas: `fillOpacity` `STACKED_AREA_FILL_OPACITY` (0.25), so the series below and the
  grid stay visible. Never leave Highcharts' 0.75 default on a stacked chart.
- Donuts: segments separated by a 2px `card` border (`PIE_SEGMENT_BORDER`).
- Per-server series take the server's own color. That color is user data.
- Chrome: axis labels `muted-foreground`, grid and axis lines `border`, tooltips `popover` with
  `popover-foreground`, legend `muted-foreground` hovering to `foreground`. All chart text is
  12px or larger; narrow-width rules may move a legend but never shrink text.

---

## 9. Server brand colors

`SERVER_TYPE_BRAND_COLORS` in `packages/shared/src/constants.ts`:

| Server   | Color     |
| -------- | --------- |
| Plex     | `#F4A825` |
| Jellyfin | `#895FDD` |
| Emby     | `#39C668` |
| tofa     | `#14B8A6` |

Brand colors are identity marks only: a dot, a 2 to 3px edge, a map pin, the Plex sign-in
button (gold with dark `overlay` ink; white on the gold is about 2:1). They are never a text
color and never a fill in a data chart. A server's chosen color (`servers.color`) is user data
and is used as given.

---

## 10. Type scale

Inter Variable, self-hosted from `apps/web/src/styles/inter/` (weights 100 to 900, so 600 is a
real semibold). No request leaves the instance for fonts.

| Step         | Size / line height | Weight   | Use                                                             |
| ------------ | ------------------ | -------- | --------------------------------------------------------------- |
| `text-xs`    | 12 / 16            | 400, 500 | Meta, captions, badges, chart text                              |
| `text-dense` | 13 / 18            | 400, 600 | Stat labels, dense media meta, poster hover titles              |
| `text-sm`    | 14 / 20            | 400, 500 | Body, table cells, controls                                     |
| `text-base`  | 16 / 24            | 600      | Card titles, section headings (h2, h3)                          |
| `text-lg`    | 18 / 28            | 600      | Compact stat values                                             |
| `text-xl`    | 20 / 28            | 600      | Page titles (h1), sheet titles, stat values                     |
| `text-2xl`   | 24 / 32            | 600, 700 | User and setup headers, poster rank, standalone summary numbers |
| `text-3xl`   | 30 / 36            | 700      | Media detail hero title and poster initials                     |

Rules:

- Nothing a user reads is below 12px. No `text-[Npx]` arbitrary sizes.
- Most list pages keep their h1 in `PageHeader` as `sr-only`; where a page shows its title
  (Settings, automation and violation detail, Maintenance), it is `text-xl font-semibold`.
- `CardTitle` is an h3 at `text-base font-semibold`. Page sections (dashboard
  `SectionHeading`, `SettingsSection`, media detail panels) are h2 at `text-base font-semibold`.
- Numbers that line up or tick (stat values, durations, table numbers) use `tabular-nums`.
- Uppercase is for short labels only (table headers, nav group labels, small eyebrows), at
  `text-xs` with `tracking-wide`. Stat labels are sentence case.

---

## 11. Radii

`--radius` is `0.5rem`.

| Token          | Value | Use                                                       |
| -------------- | ----- | --------------------------------------------------------- |
| `rounded-sm`   | 4px   | Checkboxes, kbd, tiny chips, heat cells                   |
| `rounded-md`   | 6px   | Buttons, inputs, selects, toggles                         |
| `rounded-lg`   | 8px   | Inline boxes inside a panel, menus, icon chips, small art |
| `rounded-xl`   | 12px  | Cards, stat tiles, dialogs, media panels, posters, hero   |
| `rounded-full` | pill  | Badges, avatars, dots, chips over artwork                 |

No `rounded-[...]` arbitrary values.

---

## 12. Components and states

### Stat tile

`StatCard` (`components/ui/stat-card.tsx`) is the only stat tile. Layout: optional 32px icon
chip (`bg-primary/10`, 16px accent icon), then two lines. The value line holds the value
(`text-xl` semibold, tabular), a muted suffix, the colored delta percent and, beside it, the
delta's comparison label ("+43% vs prior 30d"). The label line is sentence case, regular weight,
muted, at `text-dense`, with the sub value joined by " · " ("Plays · 5 sessions"). Padding is
12px. It fills its grid cell (`h-full`) so a row of tiles shares one height. `compact` (sheets)
drops to 8px vertical padding, a 28px chip and an 18px value. Linked tiles use the `card-hover`
utility.

### Cards and panels

`Card` is `bg-card rounded-xl border shadow-sm` with 24px padding (`py-6`, `px-6` on header,
content and footer). Bare section panels (media detail) match it: `bg-card rounded-xl border
p-6 shadow-sm` with an h2 at `text-base font-semibold`.

### Selected, hover, focus, disabled

- "Where am I" (sidebar, settings nav): neutral `sidebar-accent` fill, accent icon, 2px accent
  bar on the leading edge.
- "Which value" (toggle groups, segmented controls): `primary/15` tint with `primary` text.
- "Which view" (page tabs): underline.
- Hover brightens: text goes to `foreground`, a surface goes up one step (`card-hover` is
  `hover:bg-card-raised hover:border-foreground/15`). Panels do not scale on hover; posters
  lift 3px because they are objects.
- Focus: `ring` at 3px, `ring/50`. Never remove an outline without a ring.
- Disabled: 50% opacity, no pointer events.

### Density

- Tables: `DataTable` densities `comfortable` (16px cells), `default` (12px), `compact` (6px
  rows, 12px sides); header text `text-xs` uppercase.
- Grids of tiles and panels: `gap-3` for stat rows, `gap-4` to `gap-6` between panels.

### Motion

Durations from `globals.css`: accordion 200ms, fade-in 300ms, fade-in-up 400ms, scale-in 200ms,
slide-in-right 300ms, all ease-out. Color and opacity transitions run 150 to 200ms. Animate
color, opacity and transform only.

---

## 13. Documented exceptions

Places that keep a literal color, and why:

- **Map basemap and map paint** (`components/map/maplibre.ts`, `StreamMap.tsx`,
  `LocationPicker.tsx`, `MiniMap.tsx`): MapLibre paints on WebGL and cannot read CSS variables, so the
  basemap palette, label colors, the white highlight ring and the accent-derived point colors
  are concrete values. The basemap mirrors the neutral surfaces.
- **QR code** (`settings/access/MobileDevices.tsx`): `bg-white` behind the code; scanners need a
  white quiet zone in both themes.
- **Email preview frame** (`settings/shared/HtmlPreviewDialog.tsx`): `bg-[#0f1115]` is the email
  template's own page color (`packages/emails/src/styles.ts`), so the frame does not flash.
- **User data**: server colors, the newsletter branding colors, poster dominant colors.
- **Logo brand tokens** (section 2).

---

## 14. Implementation notes

- Web tokens: `apps/web/src/styles/globals.css`.
- Mobile: the Expo app lives in the sibling `mobile-app` checkout, is dark mode only, and mirrors
  these neutrals in its own `global.css`.
- Theme switching: `.dark` on the document root; the accent is set at runtime by
  `ThemeProvider`.

---

## 15. Brand tone

Tracearr should feel:

- Authoritative but friendly
- Technical but approachable
- Privacy-conscious
- Clear, concise, no fluff
