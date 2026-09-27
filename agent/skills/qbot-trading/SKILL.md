---
name: qbot-trading
description: QBot's trading playbook — market regime, the four tradable setups, position sizing and stops, position management, review and self-correction. Load it before any trading decision.
whenToUse: When assessing the market, opening, adding to, reducing or closing positions, reviewing trade results, or changing trading rules.
---

# QBot Trading Playbook

This is an evolving trading system. Follow it while the data supports it; when a review finds a better approach, edit this file and record the reasoning in the journal.

## 0. Core beliefs

- Crypto markets are highly volatile, 24/7 and sentiment-driven. Retail losses come mainly from overtrading, excessive leverage, missing stops, adding to losers, and chasing hype.
- Your edge is not speed or inside information; it is cross-source synthesis, disciplined execution, and reviewing your own trades.
- The goal is not to catch every move, but long-run positive expectancy. Better to miss a trade than to take a bad one.
- Fees are the enemy: a round trip costs about 0.1% (taker 0.05% × 2), so the expected move must be at least 3× the cost (≈0.3%) to be worth taking.
- When data is missing, stay flat and wait; when uncertain, halve the size or skip the trade.

## 1. Establish the market regime first

Use market_indicators + market_data on 1h/4h/1d to classify:

| Regime | Characteristics | Allowed actions |
|---|---|---|
| Trend | Price on one side of EMA200, EMA20/50 aligned, mid-range ATR% | Trend pullbacks only (setup A) |
| Range | Price oscillating around EMA200, Bollinger bands narrowing, low ATR% | Edge reversals only (setup B) |
| Chaotic | ATR% at an extreme percentile, consecutive large candles, major events | No new positions; manage existing ones only |

Supporting evidence: funding rate, open interest (OI), 24h turnover, Fear & Greed, news and macro (market_news / web_search / web_fetch).

## 2. The four tradable setups (take only these; skip everything else)

### A. Trend Pullback
- Conditions: clear 4h trend; 15m/1h pullback to EMA20/50 or the prior breakout level; a stabilisation signal (long lower wick / engulfing / volume-backed reclaim).
- Entry: close of the stabilising candle, or a break of its high.
- Stop: 0.3–0.5 ATR below the pullback structure low.
- Target: prior high or 2–3R. Move the stop to breakeven at 1R; take half off at 2R.

### B. Range Fade
- Conditions: a clear range (at least 3 touches of the edge); price at the edge; a rejection signal (long wick / volume that fails to break).
- Entry: close of the rejection candle.
- Stop: 0.3–0.5 ATR outside the range.
- Target: the range midpoint. Do not trade range breakouts; wait for a retest to confirm first.

### C. Funding Squeeze
- Conditions: funding rate persistently extreme (|rate| ≥ 0.05%/8h) + OI rising fast + price stalling.
- Entry: counter-trend, after price rejects a key level.
- Stop: 0.5 ATR beyond the extreme, and execute fast.
- Target: 1.5–2R, exit quickly and do not overstay.

### D. Event Reaction
- Conditions: a verifiable catalyst (regulation, listing, security incident, macro data) + price and volume confirming the direction.
- Entry: the direction of the first 15m volume-backed close after the event; do not chase the tail of a long candle.
- Stop: the structure level from before the event.
- Target: trailing take-profit; exit if there is no follow-through volume within 3 × 15m candles.
- Forbidden: unconfirmed headlines, social-media rumours, chasing pumps or dumping into crashes.

## 3. Position sizing and risk (hard rules)

- Risk per trade ≤ 1% of equity; position size = risk amount ÷ (entry price − stop price).
- At most 2 concurrent positions; gross exposure ≤ 3× equity; leverage ≤ 5x (enforced by desk_risk).
- Every trade must carry stop_loss; no stop logic means no order.
- Daily loss reaching 2% of equity: stop opening new positions, manage existing ones only, and write the reason in the journal.
- Two consecutive losses: mandatory 1-hour cooldown, observe only, no orders.
- Never add to a losing position. Add to a winner only as planned and only when the structure confirms.
- Liquidity threshold: skip instruments with 24h turnover < 50 million USDT.
- Slippage check: if the order-book spread > 0.1%, use a limit order or skip the trade.

## 4. Position management

- +1R: move the stop to breakeven.
- +2R: close 50%; trail the remainder with 1h ATR(14) or the prior 1h low/high.
- Time stop: no progress within 8–12 × 15m candles after entry → exit (opportunity cost).
- Adverse signal (structure break / setup invalidation): exit immediately; do not wait for the stop to be hit.
- If the market turns chaotic: actively reduce exposure and protect profits.

## 5. Each loop (driven by schedule)

1. `desk_status`: account, positions, open orders, equity.
2. Manage existing positions: stops, trims, time stops; handle filled orders first.
3. If flat and the regime allows: multi-timeframe market data + indicators + news, and `web_search` the instrument's catalysts and risks over the last 24h.
4. Check against setups A–D; only on a match compute the size, write the journal, then `desk_order` (always with stop_loss).
5. Record in `journal/YYYY-MM-DD.md`: time, regime, information summary (with links), decision, rationale, risk, sentiment.
6. `schedule_create` the next loop: 5–15 minutes while in a position; 30–60 minutes when flat; longer during chaotic regimes.
7. Report briefly in Chinese: account changes, positions, actions, next step.

## 6. Review and self-correction (every 20 trades or weekly)

- Statistics: win rate, average win R, average loss R, expectancy, max drawdown, distribution by setup.
- Evaluate per setup: keep what works; reduce size or disable what does not.
- Write conclusions back into this file (adjust parameters / disable setups / add rules) and explain the change in the journal.
- Change based on data only, never on emotion; change one thing at a time so attribution stays clean.

## 7. Absolute prohibitions

- Orders without a stop, moving a stop against the position, adding to losers, or running maximum leverage.
- Trading out of boredom, FOMO or revenge.
- Treating unverified news as fact, or fabricating price/indicator/fill data.
- Considering live before paper proves itself: only discuss live after ≥ 20 consecutive paper trades with positive expectancy AND an explicit user request.