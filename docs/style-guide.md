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

The logo (`components/brand/Logo.tsx`) is the only user of these tokens. The cyan follows the
accent hue, so the logo matches the accent the user picked.

| Token        | Value                     | Usage              |
| ------------ | ------------------------- | ------------------ |
| `cyan-core`  | `hsl(accent-hue 80% 50%)` | Logo mark and arcs |
| `blue-core`  | `#0B1A2E`                 | Logo shield fill   |
| `blue-steel` | `#162840`                 | Logo shield panel  |

---

## 3. How tokens are stored

Each token is a bare channel triplet in a CSS variable, and the `@theme inline` block in
`globals.css` wraps it once to make the Tailwind color (`bg-card`, `text-success`, `/50`
opacity modifiers and all).

- Everything is an OKLCH triplet (`L C H`): in TypeScript, `oklch(var(--border))`,
  `oklch(var(--chart-1))`.
- Four exceptions stay HSL triplets, `hsl(var(--overlay))`: `overlay` and `overlay-foreground`
  (fixed scrim colors), `destructive-foreground` (white) and the logo tokens in section 2.

The neutral grays (page, surfaces, fills, borders, text grays) take the accent's hue:
`L C var(--accent-h)`, with L fixed per mode and C too low to read as color, 0.006 in light and
0.012 in dark (0.005 for body text; 0.014 and 0.016 for `muted-foreground` and `control`). They
follow whichever accent preset is picked, the way Material 3 builds its neutral palettes from the
source color at very low chroma. Status and chart colors do not move with the accent.

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
quiet. Values are `L C`; the hue is `var(--accent-h)` (section 3).

| Token            | Dark          | Light         | Usage                                    |
| ---------------- | ------------- | ------------- | ---------------------------------------- |
| `background`     | `0.142 0.012` | `0.976 0.006` | Page                                     |
| `card`           | `0.178 0.012` | `1 0` (white) | Panels, stat tiles, dialogs, sheets      |
| `card-raised`    | `0.211 0.012` | `0.976 0.006` | Anything nested in a card or sheet       |
| `popover`        | `0.222 0.012` | `1 0` (white) | Menus, popovers, chart tooltips          |
| `muted`          | `0.275 0.012` | `0.92 0.006`  | Skeletons, subtle fills, placeholder art |
| `sidebar`        | `0.166 0.012` | `0.985 0.006` | App sidebar                              |
| `sidebar-accent` | `0.275 0.012` | `0.896 0.006` | Selected nav item                        |
| `overlay`        | `240 10% 4%`  | same (HSL)    | Scrims over artwork, maps and modals     |

`accent` (hover and focused menu items) and `secondary` share `muted`'s value in both modes.

In light mode the card is the lightest surface, so a nested panel steps down to the page tone
instead of up. Each fill in this table separates from the surface under it by at least the
step dark mode uses for the same element, or within 0.02 of it (WCAG ratio of fill against
surface, lowest preset):

| Element                              | Dark | Light |
| ------------------------------------ | ---- | ----- |
| `muted` / `accent` fill on a card    | 1.27 | 1.26  |
| `muted/50` (row hover) on a card     | 1.11 | 1.12  |
| ghost hover on the page              | 1.12 | 1.18  |
| focused menu item on the popover     | 1.16 | 1.26  |
| nested card (`card-raised`) on card  | 1.07 | 1.07  |
| hovered linked card against the page | 1.12 | 1.12  |
| selected nav item on the sidebar     | 1.29 | 1.31  |
| `border` on a card                   | 1.36 | 1.37  |
| `sidebar-border` on the sidebar      | 1.29 | 1.33  |

Three light pairs stay below dark's step on purpose. A fill sitting on the bare page (skeletons
on a loading page, the empty-state icon, poster placeholders) reads 1.18 against dark's 1.34,
because the light page is a mid step rather than the darkest surface, and matching it would put
hover fills near 86% lightness. `border` on the page reads 1.28 against 1.43; light cards also
carry `shadow-sm`, which dark mode cannot show. A top-level panel on the page reads 1.07 in
light (the card) against 1.12 in dark, where those panels use `card-raised` (next paragraph).

`Card` steps itself up: a `Card` or `StatCard` inside a `Card` (or a `StatCard` inside a sheet)
takes `bg-card-raised` and drops its shadow. Do not set `bg-card-raised` by hand on a card.

Panels that sit straight on the page without being a `Card` (the automation builder's rows, its
name and description panel, the step numbers) are `bg-card dark:bg-card-raised`: light has no
surface lighter than the card, and in dark the raised step keeps them apart from the page.
Rows nested in an If row take the other step from the If row's branch container
(`IfRow.tsx`: `card-raised` in light, `card` in dark), so they separate from it by 1.07:1 in
both modes; an orphaned condition keeps its `warning/5` tint at any depth.

`overlay` and `overlay-foreground` (`0 0% 98%`) do not change with the theme. Artwork has no
theme, so anything laid over a poster (chips, the hover panel, the paused scrim on Now
Playing) uses `bg-overlay/NN` and `text-overlay-foreground`. Never put `text-foreground` on a
scrim: in light mode it is near-black on near-black.

Shadows: cards `shadow-sm`; dialogs `shadow-lg`; lifted posters `shadow-(--poster-lift)` and the
media detail poster `shadow-(--poster-hero)`. Those two are set per mode in `globals.css`:
`overlay` at 0.7 and 0.6 alpha in dark mode, 0.2 and 0.18 in light, where the dark-mode blur
spread a gray smear over the cards below it.

---

## 5. Text and borders

| Token              | Dark          | Light         | Usage                                                         |
| ------------------ | ------------- | ------------- | ------------------------------------------------------------- |
| `foreground`       | `0.985 0.005` | `0.142 0.005` | Body text, values                                             |
| `muted-foreground` | `0.713 0.016` | `0.499 0.014` | Labels, captions, axis labels, neutral state                  |
| `border`           | `0.295 0.012` | `0.895 0.006` | Layout lines, card edges, table rules                         |
| `sidebar-border`   | `0.275 0.012` | `0.89 0.006`  | Sidebar edge and its separators                               |
| `input`            | `0.275 0.012` | `0.92 0.006`  | Off switch track, outline toggle border, input fill in dark   |
| `control`          | `0.533 0.016` | `0.629 0.014` | Boundary of checkboxes, radios, text fields, off switch (3:1) |

Contrast, WCAG 2.x, lowest preset:

| Pair                        | Dark   | Light  |
| --------------------------- | ------ | ------ |
| foreground on card          | 18.1:1 | 19.8:1 |
| muted-foreground on card    | 7.4:1  | 6.0:1  |
| muted-foreground on page    | 7.8:1  | 5.6:1  |
| muted-foreground on popover | 6.7:1  | 6.0:1  |
| muted-foreground on muted   | 5.8:1  | 4.7:1  |
| control on card             | 3.6:1  | 3.5:1  |
| control on page             | 3.8:1  | 3.3:1  |

Light `muted-foreground` is dark enough to keep 4.5:1 on `muted` (count pills, `kbd`, the
focused menu item). Text never takes an opacity modifier on `muted-foreground`: at `/70` it
falls to 3.1:1 in light and 4.2:1 in dark. Ratios in this guide are computed from the token
values (HSL and OKLCH to sRGB, alpha composited in sRGB, WCAG relative luminance) for all eight
accent presets and checked against pixels from a headless Chromium render, which agreed within
0.1.

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
The light column is against pure white; the rendered `oklch(0.99 0 0)` ink reads about 0.17
lower (Green 5.5:1, the lowest). Primary as text reads at 7.8:1 or better on the dark card
and 5.3:1 or better on the light page.

A stored hue that is not one of the presets takes the nearest preset's values
(`accentPreset`), so the grays and the accent stay on a preset's hue.

The accent is for interaction: buttons, links, focus rings, selected states, the active nav
mark, stat tile icon chips and single-series charts. It is never a status color.

Focus halos are `ring-ring/(--ring-alpha)`: 80% in light mode and 60% in dark. At 50% the halo
measured 2.1:1 on the light page and, on the dark card, 2.8 to 3.1:1 depending on the preset
(Blue, Purple, Pink, Red and Orange under 3:1). At these values every preset keeps 3:1 against
the card, page, popover, `card-raised`, sidebar and `muted`; the lowest is Pink on dark `muted`,
3.1:1. Destructive buttons use the same halo.

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

Computed for the lowest accent preset (the surfaces carry its hue), in the order success,
warning, destructive, info:

| Where the text sits              | Dark               | Light              |
| -------------------------------- | ------------------ | ------------------ |
| Flat card (white in light mode)  | 9.3, 9.9, 6.0, 8.2 | 6.2, 6.2, 6.4, 6.3 |
| Callout tint `/10` on the card   | 7.9, 8.4, 5.4, 7.0 | 5.3, 5.4, 5.4, 5.4 |
| Pill tint `/15` on the card      | 7.1, 7.5, 5.0, 6.4 | 4.9, 5.0, 4.9, 5.0 |
| Pill tint `/15` on the page      | 7.7, 8.2, 5.4, 6.9 | 4.6, 4.7, 4.6, 4.7 |
| Pill tint `/15` on `card-raised` | 6.5, 6.9, 4.6, 5.9 | 4.6, 4.7, 4.6, 4.7 |

The lowest is 4.58:1 (light destructive pill on the page, Pink preset). Every status color passes AA as
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
light fill reads 6.4:1, and the dark mode's 98% white on the dark button (`destructive/60` over
the card) 6.3:1.

---

## 8. Data visualization

Three kinds of palette, each with one job.

### 8.1 Categorical: `chart-1` to `chart-8`

For unordered categories: platforms, top lists, media types, playback decisions. Light mode
varies lightness by hue (warm hues lighter, so orange stays orange instead of brown) and keeps
every step at 3:1 or better against the white card. Dark mode sits at L 0.70 to 0.78.
The dark column is against the dark card for the lowest preset.

| Token     | Hue     | Dark (oklch)    | Light (oklch)   | Light vs white | Dark vs card |
| --------- | ------- | --------------- | --------------- | -------------- | ------------ |
| `chart-1` | blue    | `0.72 0.14 255` | `0.55 0.17 255` | 4.9:1          | 7.6:1        |
| `chart-2` | orange  | `0.76 0.15 55`  | `0.68 0.17 50`  | 3.1:1          | 8.4:1        |
| `chart-3` | magenta | `0.72 0.16 340` | `0.58 0.19 340` | 4.8:1          | 7.0:1        |
| `chart-4` | teal    | `0.74 0.11 200` | `0.6 0.1 200`   | 3.8:1          | 8.5:1        |
| `chart-5` | violet  | `0.7 0.15 295`  | `0.55 0.17 295` | 5.2:1          | 6.7:1        |
| `chart-6` | olive   | `0.78 0.13 100` | `0.66 0.13 100` | 3.1:1          | 9.5:1        |
| `chart-7` | green   | `0.74 0.15 150` | `0.6 0.15 150`  | 3.7:1          | 8.7:1        |
| `chart-8` | rose    | `0.7 0.16 15`   | `0.6 0.17 15`   | 4.3:1          | 6.5:1        |

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

Brand colors are identity marks only: a dot, a 2 to 4px edge (the Connections row's 4px left
border), a map pin. They are never a text
color and never a fill in a data chart. The Plex sign-in button is outside this table: it keeps
`#E5A00D` with white text, hovering to `#C88A0B`. A server's chosen color (`servers.color`) is user data
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
| `text-3xl`   | 30 / 36            | 700      | Media detail hero title, poster initials, `lg` logo wordmark    |
| `text-4xl`   | 36 / 40            | 700      | Sign-in page title, the 404 numeral, `xl` logo wordmark         |

The member sign-in code (`auth/MemberLogin.tsx`) is a monospace `text-3xl` that grows to
`text-4xl` from the `sm` breakpoint.

Rules:

- Nothing a user reads is below 12px. No `text-[Npx]` arbitrary sizes. Inline code is
  `text-xs`. Two arbitrary sizes remain on purpose: the initial in a 24px avatar
  (`users/UserCell.tsx`, 10px), which is `aria-hidden` decoration beside the name it repeats,
  and the builder's sentence chips at `text-[0.9375em]` (`builder/Sentence.tsx`, 15px in a
  16px sentence), which scale with the sentence they sit in.
- Most list pages keep their h1 in `PageHeader` as `sr-only`; where a page shows its title
  (Settings, automation and violation detail, the automation builder, Maintenance, Debug), it is
  `text-xl font-semibold`. Setup and user detail headers are `text-2xl`.
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
| `rounded-xs`   | 2px   | Tooltip arrow, sheet close button                         |
| `rounded-sm`   | 4px   | Checkboxes, kbd, tiny chips, heat cells                   |
| `rounded-md`   | 6px   | Buttons, inputs, selects, toggles                         |
| `rounded-lg`   | 8px   | Inline boxes inside a panel, menus, icon chips, small art |
| `rounded-xl`   | 12px  | Cards, stat tiles, dialogs, media panels, posters, hero   |
| `rounded-full` | pill  | Badges, avatars, dots, chips over artwork                 |

No `rounded-[...]` arbitrary values; `rounded-[inherit]` on the scroll area viewport only passes
its parent's radius through.

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

- Pickers: a form select shows a `control` boundary, 3:1 against what it sits on, like every
  form field. The sidebar's server picker and account menu trigger use `SidebarMenuButton`
  `variant="outline"`, which draws the same `border` edge cards use: their label and chevron
  identify them, so they match the cards around them instead of standing out. The server picker
  keeps its 2px left bar in the server's color when one server is selected. Plain nav items and segmented toggles carry no boundary: their label is
  what identifies them.
- "Where am I" (sidebar, settings nav): neutral `sidebar-accent` fill, accent icon, 2px accent
  bar on the leading edge.
- "Which value" (toggle groups, segmented controls): a `primary` tint with `primary` text, `/15`
  in dark mode and `/10` in light, where `/15` left Cyan, Green and Teal text under 4.5:1 on the
  page (lowest now: Green, 4.6:1).
- "Which view" (page tabs): underline.
- Hover: text goes to `foreground`; a linked card moves one step away from the page
  (`card-hover`: `hover:bg-muted/70` in light, `dark:hover:bg-card-raised` in dark, and
  `hover:border-foreground/15`; 1.12:1 against the page in both). Panels do not scale on hover;
  posters lift 3px because they are objects.
- Focus: controls (buttons, inputs, selects, toggles, badges, builder chips) take the 3px halo,
  `ring/(--ring-alpha)` (section 6). Navigation items and whole-object links, where a 3px halo
  would crowd neighbors or be clipped, take a 2px full-strength ring instead: `ring-sidebar-ring`
  in the sidebar and settings nav, `ring-ring` on posters, album tiles, heat cells and setup
  steps, with `ring-offset-2` on linked stat tiles and the dialog and sheet close buttons, inset
  on the media detail history rows. A full-strength ring is the accent itself: 5.3:1 or better
  on every surface, 4.1:1 on the selected nav fill. Never remove an outline without a ring.
- Switch, off: light mode outlines the track in `control` (3.5:1 on the card) with a white
  thumb; dark mode shows a `foreground` thumb on `input/80`.
- Disabled: 50% opacity, no pointer events.

### Connections server row

`settings/servers/ServerRow.tsx`. An outline `Item` with a 4px left border in the server's
color (user data), a drag handle when there is more than one server, the server icon on a
`bg-muted` 40px chip, the name with its badges, a `text-xs` meta line and a `text-xs` definition
list (requests, the owner's own account). On the right, one ghost Sync button and one ghost
icon button that opens the row's single menu: edit, open on server, the request service and
own-account items, mark historical or resume (owner only), and remove as a destructive item.
Badges carry state with the status rule: `success` for real time, `outline` for polling or
checking, `danger` for a broken plugin (clicking it opens setup), `warning` for an update or
for "cannot stop streams", `outline` for a historical server. A badge with a hint gets a
tooltip and is focusable.

### Import card

`import/ImportProgressCard.tsx` renders inside each import source. With no import it renders
only its live region. Otherwise it is `rounded-lg border p-4` with a status line and an icon:
waiting and retrying show a pulsing muted clock, running shows a muted spinner, complete a
`text-success` check, failed a `text-destructive` cross and the message in `text-destructive`.
Counts below use status text (imported `success`, skipped and filtered `warning`, enriched
`info`, errors `destructive`) beside `muted-foreground` labels, over a `Progress` bar.

`import/StartImportButton.tsx` is every source's start button, `size="lg"`: hidden while the
import waits, a spinner and "Importing" while it runs, the source's icon and label otherwise,
and "Start again" after a failure.

### Density

- Tables: `DataTable` densities `comfortable` (16px cells), `default` (12px), `compact` (6px
  rows, 12px sides); header text `text-xs` uppercase.
- Grids of tiles and panels: `gap-3` for stat rows, `gap-4` to `gap-6` between panels.

### Motion

Durations from `globals.css`: accordion 200ms, fade-in 300ms, fade-in-up 400ms, scale-in 200ms,
slide-in-right 300ms, all ease-out. Sheets slide in over 500ms and out over 300ms. Color and
opacity transitions run 150 to 200ms. Animate color, opacity and transform only.

---

## 13. Documented exceptions

Places that keep a literal color, and why:

- **Map basemap and map paint** (`components/map/maplibre.ts`, `StreamMap.tsx`,
  `StreamCard.tsx`, `LocationPicker.tsx`, `MiniMap.tsx`): MapLibre paints on WebGL and cannot
  read CSS variables. `palette()` in `maplibre.ts` holds every basemap color. The grays (land,
  urban areas, landuse, roads, tunnels, rail, buildings, borders, the canvas behind the tiles)
  and the place, road and count labels follow the gray rule in code: `oklchRgb` builds each from
  its fixed lightness, the accent preset's OKLCH hue (`useAccentH`) and the gray chroma (labels
  take the muted-text chroma), and every map rebuilds its style when the preset or theme
  changes. Water (OKLCH hue 235) and parks and woods (hue 150) keep fixed hues at low chroma so
  they read as water and green on warm presets too. Roads step by lightness, highway darker than
  major darker than minor in light and the reverse in dark, with casings in the land color.
  Labels meet 4.5:1 (city and town names) and 3:1 (state, country, neighborhood, road and water
  names) against their halos and the land, on every preset in both themes; town names are a
  step lighter (light) or dimmer (dark) than city names. Label sizes are the Protomaps layers'
  own (8 to 20px by zoom), outside the 12px rule. Data layers go in through `addDataLayers`,
  which draws them above the road and water labels and below the place names, with the data's
  own count labels on top; place names sit beside their point at every zoom so a circle at a
  city's coordinates is not hidden by that city's name. Data colors stay concrete: the server
  colors, the accent-derived points and heatmap ramp, and the white highlight ring.
- **QR code** (`settings/access/MobileDevices.tsx`): `bg-white` behind the code; scanners need a
  white quiet zone in both themes.
- **Email preview frame** (`settings/shared/HtmlPreviewDialog.tsx`): `bg-[#0f1115]` is the email
  template's own page color (`packages/emails/src/styles.ts`), so the frame does not flash.
- **Plex sign-in button** (`auth/PlexSignIn.tsx`): `#E5A00D` with white text, hovering to
  `#C88A0B` (section 9).
- **User data**: server colors, the newsletter branding colors, poster dominant colors.
- **Logo brand tokens** (section 2).

---

## 14. Implementation notes

- Web tokens: `apps/web/src/styles/globals.css`.
- Mobile: the Expo app lives in the sibling `mobile-app` checkout, is dark mode only, and keeps
  its own neutrals as hex in `global.css` (the zinc values from before the accent-tinted grays).
- Theme switching: `.dark` on the document root; the accent is set at runtime by
  `ThemeProvider`.

---

## 15. Brand tone

Tracearr should feel:

- Authoritative but friendly
- Technical but approachable
- Privacy-conscious
- Clear, concise, no fluff
