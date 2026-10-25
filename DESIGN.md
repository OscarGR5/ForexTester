---
name: ForexTester
description: A dark terminal for manual EURUSD backtesting.
colors:
  canvas: "#10151d"
  chart: "#131722"
  surface: "#171e28"
  toolbar: "#1e2935"
  text: "#e5eaf0"
  muted: "#b2b5be"
  secondary-text: "#a7b3c1"
  divider: "#354250"
  input-border: "#4a596b"
  action: "#2a4955"
  action-hover: "#355c69"
  action-border: "#4d6d79"
  action-text: "#f2f7f8"
  primary-action: "#315e60"
  positive: "#75c4b5"
  negative: "#e2a2a6"
  warning: "#ffcc80"
  focus: "#85c8d4"
  buy-surface: "#254d46"
  sell-surface: "#54383e"
typography:
  body:
    fontFamily: "Inter, system-ui, sans-serif"
  headline:
    fontSize: "28px"
    fontWeight: 700
    letterSpacing: "-.025em"
  title:
    fontSize: "17px"
    fontWeight: 600
  label:
    fontSize: "13px"
  compact:
    fontSize: "12px"
rounded:
  control: "4px"
  message: "6px"
spacing:
  tight: "4px"
  control: "8px"
  compact: "12px"
  field: "16px"
  section: "24px"
components:
  button:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-primary:
    backgroundColor: "{colors.primary-action}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.control}"
    padding: "10px 20px"
  button-buy:
    backgroundColor: "{colors.buy-surface}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-sell:
    backgroundColor: "{colors.sell-surface}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  results-navigation:
    padding: "12px 0"
  trading-dock:
    backgroundColor: "{colors.surface}"
    typography: "{typography.compact}"
    padding: "8px 14px"
---

# Design System: ForexTester

## Overview

**Creative North Star: "Dark trading terminal"**

Price charts lead the trading workspace. Compact controls support deliberate manual execution, while Setup and Results have their own readable, scrolling surfaces. The interface uses slate layers, restrained color, and direct labels.

**Key Characteristics:**

- Chart dominates Trading.
- Setup, Trading, and Results are distinct phases.
- Dense controls retain visible labels and keyboard focus.

## Colors

Slate backgrounds separate the application canvas, chart, controls, and toolbars. Light text carries primary information; muted text carries metadata and explanations. Thin dividers establish sections.

Muted aqua identifies ready states, positive PnL, and realized performance. Restrained red identifies negative PnL and errors; amber identifies coverage warnings and the cash curve. Buy and Sell have tinted surfaces plus explicit labels. Focus uses the brighter aqua outline.

Chart series keep their own observed conventions: white up candles, blue (`#2962ff`) down candles, white borders and wicks, no grid, and a dashed gray crosshair. Confirmed stop lines use salmon (`#ef9a9a`), with explicit SL 1 / SL 2 labels. Pending stops are dashed; active stops are solid. Draft stops use the focus color. Chart annotations keep nearby stop labels apart while the price axis retains exact values. Distances use the existing forex-style pip (0.0001) convention, including 6E-derived sessions; amounts show net stop-level outcomes including commissions, with pending values marked as estimates. Do not reinterpret candle direction as the interface's positive/negative palette.

## Typography

Keep the existing `Inter, system-ui, sans-serif` stack without adding a font download. Controls inherit it; charts retain their chart-library typography. Time, prices, PnL, tables, and statistics use tabular numerals where styled by the application.

Setup uses a 28px heading; Results uses 26px. The app name and Setup section titles use 17px. Supporting copy and labels are mainly 12–14px; Trading dock text is 12px. Mobile Setup and dock entry fields use 16px text. Financial units and UTC remain visible in labels.

## Layout

The shell fills `100dvh`, with a compact header and phase-specific content. Desktop Trading gives remaining height to one chart, two equal columns, or a large left chart beside two stacked right charts. A replay strip sits above and the trading dock stays below. At 900px and below, panes stack inside a scrolling chart workspace, with at least 300px per pane. Chart panes have no outer card border or rounded corners; narrow 4px gaps separate them. Pane toolbars reserve 32px for controls and a second row for indicator readiness.

Setup is centered at a maximum 1080px width, with 36px 32px padding. Its vertical hierarchy is Historical period, Trading account, then collapsed Advanced settings. Dates, the daily history timeline, presets, and readiness lead the first viewport; account and advanced controls follow in a scrolling form. The Start backtest footer remains visible outside that scroll area. Results uses 28px padding, flat statistic groups, and section dividers. Results scrolls independently of the header.

At 700px and below, Setup uses 24px 16px padding and a full-width Start button; Results uses 20px 12px. The header and replay controls wrap, account PnL occupies its own row, and Trading can scroll with a chart workspace minimum of 400px. At 600px and below, journal statistics use two columns. Wide journal tables scroll within their own container.

## Elevation & Depth

Most surfaces are flat, distinguished by tone and 1px borders. Shadows are reserved for overlays: chart messages use `0 6px 28px #0007`, indicator settings use `0 8px 24px #0008`, and session management uses `0 12px 40px #0009`. The native management dialog has a `#080d16b8` backdrop.

## Shapes

Controls use 4px corners and thin borders. Chart messages use 6px corners. Data regions remain rectangular; avoid pill navigation or decorative card grids. The chart-layout radio group rounds only its outside corners.

## Components

Buttons are compact, normally at least 34px high. Start backtest has larger padding. Hover changes enabled buttons to the action-hover color; disabled buttons use 45% opacity. Keyboard focus is a 2px focus-color outline with a 2px offset.

Inputs use dark surfaces, visible labels, 4px corners, and a minimum 36px height in Setup and the dock. Date and time fields retain native browser interaction. Error text accompanies invalid state; existing invalid-input styles use the negative border color.

Setup's responsive daily timeline uses two labeled range handles, explicit From and Through dates, and a legend for downloaded days, local gaps, and contract-change markers. Preserve keyboard, mouse, and touch interaction. The 7-, 30-, and 90-day presets precede readiness text; manual date entry stays secondary under Advanced settings or Get more historical data. Keep the existing terminal palette and visible status labels.

Results navigation uses three labeled buttons with `aria-pressed`; the active button has the action surface and focus-color border. Chart layout uses native radio inputs. Indicator settings expand as a bounded overlay attached to the pane toolbar.

The trading dock groups sizing, Buy/Sell, slot count, and execution context. Entries automatically join the single active setup, with at most two same-direction submissions before it resolves. Stop placement adds a labeled review area with estimate, confirm, cancel, and keyboard price entry. Open and pending positions remain compact inline records. Preserve these explicit actions and status labels. Existing stops also support vertical dragging within a 7px hit target while paused. Overlapping stops open a position-ID chooser; hold the chosen button and drag. Show draft price and risk without saving, commit on valid release, and cancel on Escape or pointer cancellation. Keep Modify SL and keyboard price entry available.

Session management opens in a native dialog positioned at the right on desktop and inset 8px on mobile. Results statistics are unboxed; charts and tables follow their section headings and explanatory text.

Setup's paid-download confirmation uses a centered native modal, inset and vertically scrollable on mobile without horizontal overflow. Initial focus goes to the title so long content starts at the top. Existing slate surfaces and Inter frame the requested dates, native missing-range details, and large amber tabular USD estimate before acknowledgement and actions. Explain the internal reservation separately from actual billing and state that billing can vary. Approval requires acknowledgement; expiry, blockers, and submission retain real disabled states with explicit messages. Keep Cancel and Approve actions explicit, with the estimated amount repeated in approval and full-width stacked buttons on mobile.

## Do's and Don'ts

- Do preserve chart space and keep trading controls compact.
- Do retain visible units, UTC labels, numeric alignment, and keyboard focus.
- Do keep Setup, Trading, and Results visually distinct.
- Don't introduce a SaaS dashboard aesthetic, decorative card grids, or new fonts.
- Don't use color as the only indication of action or state.
- Don't turn auxiliary controls into persistent panels that crowd the chart.
