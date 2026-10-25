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
  trading-toolbar:
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

Chart series keep their own observed conventions: white up candles, blue (`#2962ff`) down candles, white borders and wicks, no grid, and a dashed gray crosshair. Confirmed stop lines use salmon (`#ef9a9a`), with explicit SL 1 / SL 2 labels. Pending stops are dashed; active stops are solid. Draft stops use the focus color. Entry references use aqua horizontal lines with B1 / B2 labels for buys and S1 / S2 for sells. Pending entries are dotted, explicitly estimated from the observed quote; filled entries are dashed at their actual durable fill price. Coincident entries share a line with both identities. Automatic price scales include entry references; fixed manual ranges are respected. The entry level is gross breakeven before commissions.

Bollinger and Ichimoku price lines render behind candle bodies and wicks through native series ordering. The cloud retains its bottom rendering layer. Wheel zoom stays right-anchored; click-hold dragging pans each chart independently. The left edge is free. Replay follows with a 12-bar right offset or the larger indicator projection. Manual panning permits up to 40% of the visible logical span as future-side margin, capped at 80 bars unless the indicator projection needs more. Paused manual views persist without replay-follow. Forward replay observations recover a pane when its latest candle is outside the plot or within two bars of the right edge, preserving zoom and restoring the follow margin. Tight zoom limits the margin to keep the candle visible. Historical review never triggers live-follow recovery. The margin never adds market observations.

Chart annotations show identity, pip distance and signed net outcome without duplicating the exact price on the Y-axis. Nearby labels remain apart with connectors to their lines. SL numbering follows original entry-ID order within each setup, including resolved entries, so SL 2 retains its identity when SL 1 leaves. Distances use the existing forex-style pip (0.0001) convention, including 6E-derived sessions; amounts show net stop-level outcomes including commissions, with pending values marked as estimates. Do not reinterpret candle direction as the interface's positive/negative palette.

## Typography

Keep the existing `Inter, system-ui, sans-serif` stack without adding a font download. Controls inherit it; charts retain their chart-library typography. Time, prices, PnL, tables, and statistics use tabular numerals where styled by the application.

Setup uses a 28px heading; Results uses 26px. The app name and Setup section titles use 17px. Supporting copy and labels are mainly 12–14px; Trading toolbar text is 12px. Financial units and UTC remain visible in labels.

## Layout

The shell fills `100dvh`, with a compact header and phase-specific content. Desktop Trading gives remaining height to one chart, two equal columns, or a large left chart beside two stacked right charts. Replay and chart-count controls occupy the application header. Trade entry and position management use the full toolbar below it. No permanent bottom dock remains. Risk, Buy, Sell, Slots and pending/open positions share one toolbar row; only the position strip scrolls horizontally when space is limited. Desktop and smaller laptops retain the same chart topology; smartphone layouts are not supported. Chart panes have no outer card border or rounded corners; narrow 4px gaps separate them. Pane toolbars use a single grid row for instrument, timeframe and Indicators. Readiness appears at the top of the bounded, scrolling Indicators overlay. Opening settings does not change column positions or chart dimensions.

Setup is centered at a maximum 1080px width, with 36px 32px padding. Its vertical hierarchy is Historical period, Trading account, then collapsed Advanced settings. Dates, the daily history timeline, presets, and readiness lead the first viewport; account and advanced controls follow in a scrolling form. The Start backtest footer remains visible outside that scroll area. Results uses 28px padding, flat statistic groups, and section dividers. Results scrolls independently of the header.

The application has a 1000px minimum width and is verified at 1100px and 1440px. At 1350px and below, replay controls use a second row within the application header. The replay timestamp remains above Account PnL; both stay beside Sessions / settings. Smaller laptop heights retain the chart canvas. Wide journal tables scroll within their own container.

## Elevation & Depth

Most surfaces are flat, distinguished by tone and 1px borders. Shadows are reserved for overlays: chart messages use `0 6px 28px #0007`, indicator settings use `0 8px 24px #0008`, and session management uses `0 12px 40px #0009`. The native management dialog has a `#080d16b8` backdrop.

## Shapes

Controls use 4px corners and thin borders. Chart messages use 6px corners. Data regions remain rectangular; avoid pill navigation or decorative card grids. The chart-layout radio group rounds only its outside corners.

## Components

Buttons are compact, normally at least 34px high. Start backtest has larger padding. Hover changes enabled buttons to the action-hover color; disabled buttons use 45% opacity. Keyboard focus is a 2px focus-color outline with a 2px offset.

Inputs use dark surfaces, visible labels, 4px corners, and a minimum 36px height in Setup and the dock. Date and time fields retain native browser interaction. Error text accompanies invalid state; existing invalid-input styles use the negative border color.

Setup's responsive daily timeline uses two labeled range handles, explicit From and Through dates, and a legend for downloaded days, local gaps, and contract-change markers. Preserve keyboard, mouse, and touch interaction. The 7-, 30-, and 90-day presets precede readiness text; manual date entry stays secondary under Advanced settings or Get more historical data. Keep the existing terminal palette and visible status labels.

Results navigation uses three labeled buttons with `aria-pressed`; the active button has the action surface and focus-color border. Chart layout uses native radio inputs. Indicator settings expand as a bounded overlay attached to the pane toolbar.

The trading toolbar places Risk (%), Buy/Sell, Slots and compact B1/B2 or S1/S2 position records on one row. Open records show only identity, lots, estimated net USD/percentage and Close. Pending records show identity, allocated risk and Cancel. Full position/setup IDs remain internal, and action labels retain full position/order IDs. At smaller laptop widths only the position strip scrolls; entry controls stay visible. The application header groups replay actions, speed, chart count, compact status/progress and Finish backtest. Active setup status remains visible only when a setup exists. Execution assumptions, contract mappings and the distinction between entry price and commission-adjusted breakeven are behind an info icon in the app header. The replay timestamp sits immediately left of Account PnL. Entries automatically join the single active setup, with at most two same-direction submissions before it resolves. Stop placement adds a labeled review area with estimate, confirm, cancel, and keyboard price entry. Draft labels show the live distance from the current observed entry quote or, for modifications, the current stop-side market quote. The exact draft price stays on the price axis. Invalid sides and missing distance references are explicit. Hover updates stay local to the chart; selected lines can be dragged without submitting. Once a level is selected, a keyboard-accessible on-chart tick sits immediately left of its draft label, inside the plot boundary. It uses the same validation as the toolbar confirmation. Escape cancels the draft. Open and pending positions remain compact inline records. Preserve these explicit actions and status labels. Existing stops also support vertical dragging within a 7px hit target while paused. The closest actual line wins within 7px, with individually separated SL annotations taking priority through their rendered canvas bounds. Coincident shared lines require an individual annotation. Lock each drag to its starting position ID. Show price and risk previews without saving, commit on valid release, and cancel on Escape or pointer cancellation. Initial placement retains keyboard price entry, selected-line dragging, the on-chart tick, Confirm order and Cancel placement.

Session management opens in a native dialog positioned at the right. Results statistics are unboxed; charts and tables follow their section headings and explanatory text.

Setup's paid-download confirmation uses a centered native modal, bounded and vertically scrollable. Initial focus goes to the title so long content starts at the top. Existing slate surfaces and Inter frame the requested dates, native missing-range details, and large amber tabular USD estimate before acknowledgement and actions. Explain the internal reservation separately from actual billing and state that billing can vary. Approval requires acknowledgement; expiry, blockers, and submission retain real disabled states with explicit messages. Keep Cancel and Approve actions explicit, with the estimated amount repeated in approval with explicit labels.

## Do's and Don'ts

- Do preserve chart space and keep trading controls compact.
- Do retain visible units, UTC labels, numeric alignment, and keyboard focus.
- Do keep Setup, Trading, and Results visually distinct.
- Don't introduce a SaaS dashboard aesthetic, decorative card grids, or new fonts.
- Don't use color as the only indication of action or state.
- Don't turn auxiliary controls into persistent panels that crowd the chart.
