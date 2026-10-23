# ForexTester

ForexTester is a personal, browser-based forex backtesting application for Linux. The MVP focuses on manually replaying EURUSD price action, placing simulated trades, and reviewing backtest results.

## MVP requirements

- Support EURUSD initially.
- Retrieve historical forex data automatically, without MT5 or manual imports.
- Provide multiple selectable timeframes.
- Display one, two, or three synchronized charts at once, including vertically stacked layouts.
- Include Ichimoku Cloud, Bollinger Bands, and Stochastic Oscillator indicators with configurable settings.
- Allow manual simulated buy and sell orders.
- Support multiple simultaneous positions, each with independent stop-loss (SL) and take-profit (TP) levels.
- Provide controls to replay a backtest.
- Show performance statistics and trade history when a backtest finishes.
- Base chart appearance and indicator styling on TradingView references to be supplied later.
- Run as a browser-based application compatible with Linux.

## Prerequisites

- Linux desktop with a current browser
- Node.js 22.12+ (22.x) or 24.x and npm

## Installation

```sh
npm install
```

## Start locally on Linux

Run these commands in separate terminals from the repository root:

```sh
npm run dev:backend
npm run dev:frontend
```

Open the URL printed by Vite, normally http://127.0.0.1:5173. The API health check is at http://127.0.0.1:3001/api/health.

## Development commands

```sh
npm run typecheck
npm run test
npm run build
npm run start --workspace backend # starts the built API after npm run build
```

## Current status

The React/Vite frontend displays a dark application shell and chart workspace placeholder. The Node.js backend exposes `GET /api/health`. The historical data, charting, indicators, replay, trading, and statistics features listed above are not implemented yet. The approved future stack includes TradingView Lightweight Charts, `dukascopy-node`, and `technicalindicators`; these packages are deferred until those features are built.
