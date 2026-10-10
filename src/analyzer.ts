import type {
  StockData,
  SectorPerformance,
  RotationSignal,
  SectorETF,
  ETFValidation,
  AssetClassETF,
  AssetClassFlow,
  TechnicalData,
  TrendPhase,
  ETFTrendDetail,
  ActionRecommendation,
  ActionSignal,
  InvestingMode,
  CapitalMode,
  Strategy,
  SectorDiagnostic,
  ETFFundFlow,
  DarkPoolTrend,
  OptionsData,
} from "./types.js";

// ---------------------------------------------------------------------------
// 1. Aggregate by sector
// ---------------------------------------------------------------------------

export function aggregateBySector(stocks: StockData[]): SectorPerformance[] {
  // Group stocks by sector
  const grouped = new Map<string, StockData[]>();
  for (const s of stocks) {
    const list = grouped.get(s.sector) ?? [];
    list.push(s);
    grouped.set(s.sector, list);
  }

  const sectors: SectorPerformance[] = [];

  for (const [sector, sectorStocks] of grouped) {
    const n = sectorStocks.length;
    const totalMcap = sectorStocks.reduce((sum, s) => sum + s.marketCap, 0);

    // Equal-weight averages
    const ew1W = sectorStocks.reduce((s, st) => s + st.perf1W, 0) / n;
    const ew1M = sectorStocks.reduce((s, st) => s + st.perf1M, 0) / n;
    const ew3M = sectorStocks.reduce((s, st) => s + st.perf3M, 0) / n;

    // Market-cap-weighted averages
    const mcw1W =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf1W * st.marketCap, 0) / totalMcap
        : ew1W;
    const mcw1M =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf1M * st.marketCap, 0) / totalMcap
        : ew1M;
    const mcw3M =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf3M * st.marketCap, 0) / totalMcap
        : ew3M;

    // Breadth: % of stocks positive
    const breadth1W = (sectorStocks.filter((s) => s.perf1W > 0).length / n) * 100;
    const breadth1M = (sectorStocks.filter((s) => s.perf1M > 0).length / n) * 100;
    const breadth3M = (sectorStocks.filter((s) => s.perf3M > 0).length / n) * 100;

    // Top 3 movers by 1W performance
    const sorted1W = [...sectorStocks].sort((a, b) => b.perf1W - a.perf1W);
    const topMovers = sorted1W.slice(0, 3).map((s) => ({
      ticker: s.ticker,
      perf1W: s.perf1W,
    }));

    sectors.push({
      sector,
      stockCount: n,
      mcw1W,
      mcw1M,
      mcw3M,
      ew1W,
      ew1M,
      ew3M,
      breadth1W,
      breadth1M,
      breadth3M,
      topMovers,
    });
  }

  return sectors;
}

// ---------------------------------------------------------------------------
// 2. Calculate rotation signals
// ---------------------------------------------------------------------------

export function calculateRotationSignals(
  sectorPerfs: SectorPerformance[]
): RotationSignal[] {
  const n = sectorPerfs.length;

  // Rank sectors by MCW performance per timeframe (1 = best, n = worst)
  const rank = (arr: SectorPerformance[], key: keyof SectorPerformance) => {
    const sorted = [...arr].sort(
      (a, b) => (b[key] as number) - (a[key] as number)
    );
    const ranks = new Map<string, number>();
    sorted.forEach((s, i) => ranks.set(s.sector, i + 1));
    return ranks;
  };

  const ranks1W = rank(sectorPerfs, "mcw1W");
  const ranks1M = rank(sectorPerfs, "mcw1M");
  const ranks3M = rank(sectorPerfs, "mcw3M");

  const signals: RotationSignal[] = sectorPerfs.map((sp) => {
    const r1W = ranks1W.get(sp.sector)!;
    const r1M = ranks1M.get(sp.sector)!;
    const r3M = ranks3M.get(sp.sector)!;

    // Rank shift: positive = sector is improving in short term vs long term
    const rankShift = r3M - r1W;

    // Momentum acceleration — SMOOTHED to prevent daily whipsaw.
    // Problem: raw mcw1W is a rolling 5-day figure that shifts materially
    // as one day drops off. Using it directly can flip signals on a single day.
    //
    // Fix: Blend short-term (1W) and medium-term (1M) into a smoothed rate,
    // then compare against long-term (3M) rate. This requires 2+ timeframes
    // to agree before momentum registers as accelerating.
    const weeklyRate = sp.mcw1W;              // % per week (noisy)
    const monthlyRate = sp.mcw1M / 4.33;     // 1M normalized to per-week
    const quarterlyRate = sp.mcw3M / 13;     // 3M normalized to per-week

    // Smoothed short-term: blend 1W (40%) with 1M-rate (60%) to dampen single-week noise
    const smoothedShortRate = weeklyRate * 0.4 + monthlyRate * 0.6;
    // Compare smoothed short vs long-term baseline
    const momentumAccel = smoothedShortRate - quarterlyRate;

    // Institutional spread: MCW - EW for 1W
    // Positive = large-cap stocks outperforming (institutional buying)
    // Also smooth with 1M data to reduce daily noise
    const instSpread1W = sp.mcw1W - sp.ew1W;
    const instSpread1M = sp.mcw1M - sp.ew1M;
    const institutionalSpread = instSpread1W * 0.4 + instSpread1M * 0.6;

    // Breadth divergence: short-term breadth vs long-term breadth
    // Blend 1W and 1M breadth for smoother signal
    const smoothedBreadthShort = sp.breadth1W * 0.4 + sp.breadth1M * 0.6;
    const breadthDivergence = smoothedBreadthShort - sp.breadth3M;

    // Composite rotation score (weighted combination)
    // Weights: rank shift (35%), momentum accel (25%), institutional spread (20%), breadth (20%)
    // Normalize each component to roughly similar scales
    const normRankShift = rankShift / n; // range [-1, 1]
    const normMomentum = Math.tanh(momentumAccel / 2); // squash; scale is now per-week diffs (~±3)
    const normInstitutional = Math.tanh(institutionalSpread / 3);
    const normBreadth = breadthDivergence / 100; // already in pct

    const rotationScore =
      normRankShift * 35 +
      normMomentum * 25 +
      normInstitutional * 20 +
      normBreadth * 20;

    // Classify signal — use hysteresis-aware thresholds.
    // Wider band (±10) prevents rapid NEUTRAL→INFLOW→NEUTRAL oscillation.
    let signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
    if (rotationScore > 10) signal = "INFLOW";
    else if (rotationScore < -10) signal = "OUTFLOW";
    else signal = "NEUTRAL";

    return {
      sector: sp.sector,
      signal,
      rotationScore: Math.round(rotationScore * 100) / 100,
      rankShift,
      momentumAccel: Math.round(momentumAccel * 100) / 100,
      institutionalSpread: Math.round(institutionalSpread * 100) / 100,
      breadthDivergence: Math.round(breadthDivergence * 100) / 100,
      rank1W: r1W,
      rank3M: r3M,
    };
  });

  // Sort by rotation score descending
  signals.sort((a, b) => b.rotationScore - a.rotationScore);
  return signals;
}

// ---------------------------------------------------------------------------
// 3. ETF validation
// ---------------------------------------------------------------------------

export function validateWithETFs(
  sectorPerfs: SectorPerformance[],
  etfs: SectorETF[]
): ETFValidation[] {
  const sectorMap = new Map(sectorPerfs.map((sp) => [sp.sector, sp]));

  return etfs
    .map((etf) => {
      const sp = sectorMap.get(etf.sector);
      if (!sp) return null;

      const divergence =
        Math.round((etf.perf1W - sp.mcw1W) * 100) / 100;

      let volumeSignal: "HIGH" | "NORMAL" | "LOW";
      if (etf.relVolume >= 1.5) volumeSignal = "HIGH";
      else if (etf.relVolume <= 0.7) volumeSignal = "LOW";
      else volumeSignal = "NORMAL";

      return {
        etfTicker: etf.ticker,
        sector: etf.sector,
        etfPerf1W: etf.perf1W,
        stockAvg1W: Math.round(sp.mcw1W * 100) / 100,
        divergence,
        relVolume: etf.relVolume,
        volumeSignal,
      };
    })
    .filter((v): v is ETFValidation => v !== null)
    .sort((a, b) => b.relVolume - a.relVolume);
}

// ---------------------------------------------------------------------------
// 4. Asset class rotation matrix
// ---------------------------------------------------------------------------

export function calculateAssetClassFlows(
  assetClassETFs: AssetClassETF[],
  technicals?: Map<string, TechnicalData>
): AssetClassFlow[] {
  // Group ETFs by asset class
  const grouped = new Map<string, AssetClassETF[]>();
  for (const etf of assetClassETFs) {
    const list = grouped.get(etf.assetClass) ?? [];
    list.push(etf);
    grouped.set(etf.assetClass, list);
  }

  const flows: AssetClassFlow[] = [];

  for (const [assetClass, etfs] of grouped) {
    const n = etfs.length;

    const avgPerf1W = etfs.reduce((s, e) => s + e.perf1W, 0) / n;
    const avgPerf1M = etfs.reduce((s, e) => s + e.perf1M, 0) / n;
    const avgPerf3M = etfs.reduce((s, e) => s + e.perf3M, 0) / n;
    const avgRelVolume = etfs.reduce((s, e) => s + e.relVolume, 0) / n;

    // Flow score: blended multi-timeframe with capped volume confidence
    // Problem with old formula: relVolume was unbounded multiplier (crypto ~93x!)
    // and 1W was annualized (×52) making daily noise dominate.
    //
    // New approach:
    //   - Blend timeframes: 1W (20%), 1M (50%), 3M (30%) for directional signal
    //   - Cap volume multiplier at 2x to prevent new/volatile ETFs from dominating
    //   - Volume below 0.7 dampens the signal (low conviction)
    const blendedPerf = avgPerf1W * 0.2 + avgPerf1M * 0.5 + avgPerf3M * 0.3;

    // Volume confidence: cap at 2x, floor at 0.5x, linear scale between
    const volCapped = Math.min(Math.max(avgRelVolume, 0.5), 2.0);
    const volConfidence = volCapped / 1.0; // 1.0 = neutral, range [0.5, 2.0]

    // Momentum acceleration: is the short-term trend diverging from long-term?
    // Use weekly rate vs monthly rate (not annualized) to avoid amplification
    const weeklyRate = avgPerf1W;            // % per week
    const monthlyRate = avgPerf1M / 4.33;    // % per week (from monthly)
    const accel = weeklyRate - monthlyRate;   // positive = accelerating inflow

    // Composite: blended direction (scaled) + acceleration bonus
    const flowScore =
      blendedPerf * 3 * volConfidence +       // main directional signal
      Math.tanh(accel / 2) * 2;               // bounded acceleration [-2, +2]

    let signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
    if (flowScore > 3) signal = "INFLOW";
    else if (flowScore < -3) signal = "OUTFLOW";
    else signal = "NEUTRAL";

    flows.push({
      assetClass,
      label: etfs.map((e) => e.label).join(", "),
      tickers: etfs.map((e) => e.ticker),
      avgPerf1W: Math.round(avgPerf1W * 100) / 100,
      avgPerf1M: Math.round(avgPerf1M * 100) / 100,
      avgPerf3M: Math.round(avgPerf3M * 100) / 100,
      avgRelVolume: Math.round(avgRelVolume * 100) / 100,
      flowScore: Math.round(flowScore * 100) / 100,
      signal,
      trendPhase: technicals
        ? classifyTrendPhase(etfs.map((e) => e.ticker), technicals)
        : undefined,
    });
  }

  // Sort by flow score descending
  flows.sort((a, b) => b.flowScore - a.flowScore);
  return flows;
}

// ---------------------------------------------------------------------------
// 5. Trend Phase Classification
// ---------------------------------------------------------------------------

/**
 * Classify the trend maturity for an asset class based on SMA distances.
 * Uses averaged SMA20/50/200 distances across the asset class's ETFs.
 *
 * Logic:
 *   - Price vs SMA50 determines primary trend direction
 *   - SMA200 confirms whether trend is established
 *   - SMA20 identifies short-term divergences (pullbacks/bounces)
 *   - Magnitude of SMA distances identifies extension
 */
export function classifyTrendPhase(
  tickers: string[],
  technicals: Map<string, TechnicalData>
): TrendPhase {
  const data = tickers
    .map((t) => technicals.get(t))
    .filter((d): d is TechnicalData => d !== undefined);

  if (data.length === 0) return "NEUTRAL";

  const n = data.length;
  const avgSMA20 = data.reduce((s, d) => s + d.sma20, 0) / n;
  const avgSMA50 = data.reduce((s, d) => s + d.sma50, 0) / n;
  const avgSMA200 = data.reduce((s, d) => s + d.sma200, 0) / n;
  const avgRSI = data.reduce((s, d) => s + d.rsi, 0) / n;

  // Thresholds (% distance)
  const EXTENDED_THRESHOLD = 10;  // >10% above SMA50 = overextended
  const NEAR_ZERO = 2;            // within ±2% = "near" the MA

  // --- Uptrend scenarios ---
  if (avgSMA50 > NEAR_ZERO) {
    // Price is above SMA50
    if (avgSMA50 > EXTENDED_THRESHOLD && avgSMA200 > EXTENDED_THRESHOLD) {
      // Far above both — late/extended, RSI likely overbought
      return "EXTENDED";
    }
    if (avgSMA200 > NEAR_ZERO) {
      // Above both SMA50 and SMA200 — confirmed uptrend
      return "ESTABLISHED_UPTREND";
    }
    // Above SMA50 but SMA200 still near zero or below — early stages
    return "EARLY_UPTREND";
  }

  // --- Downtrend scenarios ---
  if (avgSMA50 < -NEAR_ZERO) {
    // Price is below SMA50
    if (avgSMA200 < -NEAR_ZERO) {
      // Below both — confirmed downtrend
      return "ESTABLISHED_DOWNTREND";
    }
    // Below SMA50 but SMA200 still near/above — early decline
    return "EARLY_DOWNTREND";
  }

  // --- Near SMA50 (within ±2%) — check for pullbacks/bounces ---
  if (avgSMA20 > NEAR_ZERO && avgSMA200 < -NEAR_ZERO) {
    // Short-term bounce (above SMA20) in a longer-term downtrend (below SMA200)
    return "COUNTER_TREND_BOUNCE";
  }
  if (avgSMA20 < -NEAR_ZERO && avgSMA200 > NEAR_ZERO) {
    // Short-term dip (below SMA20) in a longer-term uptrend (above SMA200)
    return "PULLBACK_IN_UPTREND";
  }

  return "NEUTRAL";
}

/**
 * Classify trend phase for a single ETF's technical data.
 */
export function classifySingleTrend(d: TechnicalData): TrendPhase {
  const EXTENDED_THRESHOLD = 10;
  const NEAR_ZERO = 2;

  if (d.sma50 > NEAR_ZERO) {
    if (d.sma50 > EXTENDED_THRESHOLD && d.sma200 > EXTENDED_THRESHOLD) {
      return "EXTENDED";
    }
    if (d.sma200 > NEAR_ZERO) return "ESTABLISHED_UPTREND";
    return "EARLY_UPTREND";
  }

  if (d.sma50 < -NEAR_ZERO) {
    if (d.sma200 < -NEAR_ZERO) return "ESTABLISHED_DOWNTREND";
    return "EARLY_DOWNTREND";
  }

  if (d.sma20 > NEAR_ZERO && d.sma200 < -NEAR_ZERO) return "COUNTER_TREND_BOUNCE";
  if (d.sma20 < -NEAR_ZERO && d.sma200 > NEAR_ZERO) return "PULLBACK_IN_UPTREND";

  return "NEUTRAL";
}

// ---------------------------------------------------------------------------
// 6. Per-ETF Trend Breakdown (sectors + individual asset class ETFs)
// ---------------------------------------------------------------------------

/**
 * Build per-ETF trend details for sector ETFs and asset class ETFs.
 */
export function buildETFTrendDetails(
  sectorETFs: SectorETF[],
  assetClassETFs: AssetClassETF[],
  technicals: Map<string, TechnicalData>
): { sectorTrends: ETFTrendDetail[]; assetClassTrends: ETFTrendDetail[] } {
  const sectorTrends: ETFTrendDetail[] = [];
  for (const etf of sectorETFs) {
    const tech = technicals.get(etf.ticker);
    if (!tech) continue;
    sectorTrends.push({
      ticker: etf.ticker,
      label: etf.sector,
      sma20: tech.sma20,
      sma50: tech.sma50,
      sma200: tech.sma200,
      rsi: tech.rsi,
      trendPhase: classifySingleTrend(tech),
    });
  }

  const assetClassTrends: ETFTrendDetail[] = [];
  for (const etf of assetClassETFs) {
    const tech = technicals.get(etf.ticker);
    if (!tech) continue;
    assetClassTrends.push({
      ticker: etf.ticker,
      label: etf.label,
      sma20: tech.sma20,
      sma50: tech.sma50,
      sma200: tech.sma200,
      rsi: tech.rsi,
      trendPhase: classifySingleTrend(tech),
    });
  }

  // Sort by SMA50 descending (strongest uptrend first)
  sectorTrends.sort((a, b) => b.sma50 - a.sma50);
  assetClassTrends.sort((a, b) => b.sma50 - a.sma50);

  return { sectorTrends, assetClassTrends };
}

// ---------------------------------------------------------------------------
// 7. Action Signals — BUY / SELL / HOLD / TRIM
// ---------------------------------------------------------------------------

interface SignalContext {
  etf: ETFTrendDetail;
  flow?: AssetClassFlow;
  rotation?: RotationSignal;
  allAligned: boolean;  // all MAs bullish
  allNeg: boolean;      // all MAs bearish
}

/** Traditional Chinese display names for trend phases (user-facing). Codes stay English. */
const TREND_PHASE_ZH: Record<TrendPhase, string> = {
  EARLY_UPTREND: "早期升勢",
  ESTABLISHED_UPTREND: "升勢確立",
  EXTENDED: "過熱",
  EARLY_DOWNTREND: "早期跌勢",
  ESTABLISHED_DOWNTREND: "跌勢確立",
  COUNTER_TREND_BOUNCE: "逆勢反彈",
  PULLBACK_IN_UPTREND: "升勢回調",
  NEUTRAL: "中性",
};

/**
 * Generate actionable recommendations with dual-mode system:
 *
 * Capital modes:
 *   DEPLOY — fresh cash to invest. Cares about absolute entry quality.
 *           "Should I buy this at all?" Cash is a valid position.
 *   ROTATE — rebalancing existing portfolio. Cares about relative attractiveness.
 *           "Should I shift weight from X to Y?" Always fully invested.
 *
 * Strategies:
 *   MOMENTUM  — follow trends + flows. Buy strength, sell weakness.
 *   CONTRARIAN — fade extremes. Buy oversold/hated, sell overbought/loved.
 *   ROTATION  — follow rank changes. Buy improving, sell deteriorating.
 */
export function generateActionSignals(
  trendDetails: ETFTrendDetail[],
  flowMap: Map<string, AssetClassFlow>,
  rotationSignals?: RotationSignal[],
  mode: InvestingMode = { capital: "deploy", strategy: "momentum" }
): ActionRecommendation[] {
  const recommendations: ActionRecommendation[] = [];

  for (const etf of trendDetails) {
    const factors: string[] = [];
    const { trendPhase, rsi, sma20, sma50, sma200 } = etf;

    // Find corresponding flow
    let flow: AssetClassFlow | undefined;
    for (const [, f] of flowMap) {
      if (f.tickers.includes(etf.ticker) || f.assetClass === etf.label) {
        flow = f;
        break;
      }
    }

    // Find rotation signal for sector ETFs
    const rotation = rotationSignals?.find((r) => r.sector === etf.label);

    // --- Collect factors (shared across all modes) ---
    factors.push(`趨勢：${TREND_PHASE_ZH[trendPhase]}`);

    if (rsi >= 70) factors.push(`RSI ${rsi.toFixed(0)}（超買）`);
    else if (rsi >= 60) factors.push(`RSI ${rsi.toFixed(0)}（偏高）`);
    else if (rsi <= 30) factors.push(`RSI ${rsi.toFixed(0)}（超賣）`);
    else if (rsi <= 40) factors.push(`RSI ${rsi.toFixed(0)}（偏弱）`);
    else factors.push(`RSI ${rsi.toFixed(0)}（中性）`);

    if (flow) {
      factors.push(`資金流：${flow.signal}（評分 ${flow.flowScore.toFixed(1)}）`);
    }
    if (rotation) {
      factors.push(`輪動：${rotation.signal}（排名變動：${rotation.rankShift > 0 ? "+" : ""}${rotation.rankShift}）`);
    }

    const allAligned = sma20 > 0 && sma50 > 0 && sma200 > 0;
    const allNeg = sma20 < 0 && sma50 < 0 && sma200 < 0;
    if (allAligned) factors.push("均線多頭排列（20>50>200）");
    if (allNeg) factors.push("均線空頭排列（價格低於所有均線）");

    const ctx: SignalContext = { etf, flow, rotation, allAligned, allNeg };

    // --- Pick strategy ---
    let result: { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] };

    if (mode.strategy === "contrarian") {
      result = contrarianStrategy(ctx);
    } else if (mode.strategy === "rotation") {
      result = rotationStrategy(ctx);
    } else {
      result = momentumStrategy(ctx);
    }

    // --- Apply capital mode modifier ---
    if (mode.capital === "rotate") {
      result = applyRotateModifier(result, ctx);
    }

    if (result.extraFactors) {
      factors.push(...result.extraFactors);
    }

    recommendations.push({
      ticker: etf.ticker,
      label: etf.label,
      action: result.action,
      confidence: result.confidence,
      rationale: result.rationale,
      factors,
    });
  }

  // Sort: BUY first (highest confidence), then HOLD, TRIM, SELL
  const actionOrder: Record<ActionSignal, number> = {
    BUY: 0, HOLD: 1, TRIM: 2, SELL: 3,
  };
  recommendations.sort((a, b) => {
    const orderDiff = actionOrder[a.action] - actionOrder[b.action];
    if (orderDiff !== 0) return orderDiff;
    return b.confidence - a.confidence;
  });

  return recommendations;
}

// ---------------------------------------------------------------------------
// Strategy: Momentum — follow trends and flows
// ---------------------------------------------------------------------------

function momentumStrategy(ctx: SignalContext) {
  const { etf, flow, rotation } = ctx;
  const { trendPhase, rsi, sma20 } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  if (trendPhase === "EARLY_UPTREND") {
    if (rsi < 70 && (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW")) {
      action = "BUY"; confidence = 75;
      rationale = "新升勢形成，獲資金流入確認";
    } else if (rsi < 70) {
      action = "BUY"; confidence = 60;
      rationale = "早期升勢 — 高於 SMA50，等待資金流確認";
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "早期升勢但 RSI 偏高 — 等回調再入場";
    }
  } else if (trendPhase === "PULLBACK_IN_UPTREND") {
    if (rsi <= 50) {
      action = "BUY"; confidence = 70;
      rationale = "升勢回調兼 RSI 偏弱 — 均值回歸入場";
    } else {
      action = "BUY"; confidence = 55;
      rationale = "升勢中回落 — 若支持位守得住可加倉";
    }
  } else if (trendPhase === "ESTABLISHED_UPTREND") {
    if (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW") {
      if (sma20 < -1) {
        action = "BUY"; confidence = 80;
        rationale = `偵測到短線回調 — 升勢確立兼有資金流入，價格低於 SMA20 ${sma20.toFixed(1)}%`;
        extraFactors.push("價格低於 20 天線 ＝ 強勢中嘅短線回調");
      } else if (sma20 < 1 && rsi < 55) {
        action = "BUY"; confidence = 70;
        rationale = "接近 SMA20，RSI 降溫，升勢確立 — 短線回調形成中";
        extraFactors.push("價格接近 20 天線支持位");
      } else {
        action = "HOLD"; confidence = 60;
        rationale = `升勢確立兼有資金流入，但暫未見回調（高於 SMA20 ${sma20.toFixed(1)}%）— 等回調再加倉`;
        extraFactors.push("未見回調：價格仍高於 20 天線");
      }
    } else if (rsi >= 68) {
      action = "TRIM"; confidence = 55;
      rationale = "升勢未破但 RSI 過熱 — 減倉";
    } else {
      action = "HOLD"; confidence = 60;
      rationale = "升勢確立 — 維持倉位，無需急於加倉";
    }
  } else if (trendPhase === "EXTENDED") {
    if (rsi >= 65) {
      action = "TRIM"; confidence = 70;
      rationale = "高於兩條均線兼 RSI 偏高，升勢過熱 — 獲利了結";
    } else if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 65;
      rationale = "升勢過熱兼資金流出 — 可能進入派發階段";
    } else {
      action = "TRIM"; confidence = 55;
      rationale = "遠離均線 — 減低持倉，均值回歸風險上升";
    }
  } else if (trendPhase === "EARLY_DOWNTREND") {
    if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 75;
      rationale = "跌穿 SMA50 兼資金流出 — 趨勢轉壞";
    } else {
      action = "SELL"; confidence = 60;
      rationale = "跌穿 SMA50 — 趨勢轉壞，趁早離場";
    }
  } else if (trendPhase === "ESTABLISHED_DOWNTREND") {
    action = "SELL"; confidence = 80;
    rationale = "低於 SMA50 及 SMA200 — 跌勢確立，避開";
    if (rsi <= 30) {
      extraFactors.push("超賣但趨勢向下 — 反彈料短暫");
    }
  } else if (trendPhase === "COUNTER_TREND_BOUNCE") {
    if (flow?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 70;
      rationale = "跌勢中反彈兼資金流出 — 唔好追呢轉反彈";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "反彈緊但大趨勢向下 — 唔好追，等確認";
    }
  } else {
    if (flow?.signal === "INFLOW" && rsi < 60) {
      action = "BUY"; confidence = 45;
      rationale = "趨勢未明但有資金流入 — 可建小倉";
    } else if (flow?.signal === "OUTFLOW") {
      action = "HOLD"; confidence = 40;
      rationale = "方向未明兼資金流出 — 保持觀望，等訊號";
    } else {
      action = "HOLD"; confidence = 35;
      rationale = "訊號未明 — 等趨勢形成";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Strategy: Contrarian — fade extremes, buy fear, sell greed
// ---------------------------------------------------------------------------

function contrarianStrategy(ctx: SignalContext) {
  const { etf, flow, rotation, allNeg, allAligned } = ctx;
  const { trendPhase, rsi, sma20, sma50, sma200 } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  // Contrarian inverts the logic: oversold + outflow = opportunity, overbought + inflow = danger

  if (trendPhase === "ESTABLISHED_DOWNTREND") {
    if (rsi <= 30) {
      action = "BUY"; confidence = 75;
      rationale = `投降式拋售訊號 — RSI ${rsi.toFixed(0)} 超賣，低於 SMA200 ${sma200.toFixed(1)}%`;
      extraFactors.push("遠低於長期平均 ＝ 均值回歸機會");
      if (flow?.signal === "OUTFLOW") {
        confidence = 80;
        extraFactors.push("資金流出 ＝ 恐慌拋售 — 逆勢買入區");
      }
    } else if (rsi <= 40 && allNeg) {
      action = "BUY"; confidence = 65;
      rationale = "低於所有均線兼 RSI 偏弱 — 吸納區";
      extraFactors.push("價格已洗倉 — 精明資金常喺呢度吸納");
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "跌勢未夠超賣 — 等投降式拋售";
    }
  } else if (trendPhase === "EARLY_DOWNTREND") {
    if (rsi <= 35) {
      action = "BUY"; confidence = 60;
      rationale = "初跌兼 RSI 超賣 — 若支持守得住可逆勢入場";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "破位向下但未超賣 — 逆勢入場言之尚早";
    }
  } else if (trendPhase === "COUNTER_TREND_BOUNCE") {
    if (rsi <= 45 && sma200 < -5) {
      action = "BUY"; confidence = 55;
      rationale = "由深度折讓開始反彈 — 潛在早期反轉";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "反彈緊但未夠平 — 逆勢信心不足";
    }
  } else if (trendPhase === "EXTENDED") {
    if (rsi >= 70) {
      action = "SELL"; confidence = 80;
      rationale = `亢奮區 — RSI ${rsi.toFixed(0)} 超買，高於 SMA200 ${sma200.toFixed(1)}%`;
      extraFactors.push("遠高於均線 ＝ 回歸風險高");
      if (flow?.signal === "INFLOW") {
        extraFactors.push("資金流入 ＝ FOMO 追入 — 逆勢賣出區");
      }
    } else if (rsi >= 60 && allAligned) {
      action = "TRIM"; confidence = 70;
      rationale = "交易過度擠擁 — 人人睇好，均值回歸前先減倉";
      extraFactors.push("均線全部向好兼 RSI 偏高 ＝ 共識過強");
    } else {
      action = "TRIM"; confidence = 55;
      rationale = "升勢過熱 — 逆勢操作宜獲利了結";
    }
  } else if (trendPhase === "ESTABLISHED_UPTREND") {
    if (rsi >= 70 && flow?.signal === "INFLOW") {
      action = "TRIM"; confidence = 65;
      rationale = "共識太強兼超買 — 逆勢操作趁強減倉";
      extraFactors.push("資金流入兼 RSI 高企 ＝ 後知後覺買家入場");
    } else if (sma20 < -1 && rsi < 45) {
      action = "BUY"; confidence = 60;
      rationale = "升勢回調兼 RSI 降溫 — 逆勢操作趁恐慌加倉";
    } else {
      action = "HOLD"; confidence = 50;
      rationale = "升勢未破 — 無逆勢優勢，等極端情況";
    }
  } else if (trendPhase === "PULLBACK_IN_UPTREND") {
    if (rsi <= 40) {
      action = "BUY"; confidence = 75;
      rationale = "升勢中出現恐慌 — 逆勢入場最佳時機";
      extraFactors.push("長期升勢中嘅短線恐慌 ＝ 反轉機會大");
    } else {
      action = "BUY"; confidence = 55;
      rationale = "回調但 RSI 未洗夠 — 可作部分逆勢入場";
    }
  } else if (trendPhase === "EARLY_UPTREND") {
    if (rsi >= 70) {
      action = "HOLD"; confidence = 40;
      rationale = "新升勢但已超買 — 逆勢入場太遲";
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "趨勢形成中 — 逆勢操作寧願等更深折讓";
    }
  } else {
    // NEUTRAL
    if (rsi <= 35) {
      action = "BUY"; confidence = 50;
      rationale = "無趨勢但超賣 — 逆勢小注試下";
    } else if (rsi >= 65) {
      action = "TRIM"; confidence = 50;
      rationale = "無趨勢但超買 — 逆勢減倉";
    } else {
      action = "HOLD"; confidence = 35;
      rationale = "無極端情況 — 逆勢操作無優勢";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Strategy: Rotation — follow rank changes and turning points
// ---------------------------------------------------------------------------

function rotationStrategy(ctx: SignalContext) {
  const { etf, flow, rotation } = ctx;
  const { trendPhase, rsi } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  // Rotation strategy is driven by rank shift — is this sector gaining or losing relative position?
  const rankShift = rotation?.rankShift ?? 0;
  const rotScore = rotation?.rotationScore ?? 0;
  const rotSignal = rotation?.signal;

  // For asset class ETFs without rotation data, fall back to flow-based relative signal
  const hasRotation = rotation !== undefined;
  const improving = hasRotation ? rankShift > 2 : flow?.signal === "INFLOW";
  const deteriorating = hasRotation ? rankShift < -2 : flow?.signal === "OUTFLOW";
  const stronglyImproving = hasRotation ? rankShift > 4 : (flow?.flowScore ?? 0) > 6;
  const stronglyDeteriorating = hasRotation ? rankShift < -4 : (flow?.flowScore ?? 0) < -6;

  if (stronglyImproving) {
    if (trendPhase === "EARLY_UPTREND" || trendPhase === "PULLBACK_IN_UPTREND") {
      action = "BUY"; confidence = 80;
      rationale = `強勁輪動入場（排名變動：+${rankShift}），趨勢出現轉折 — 高信心入場`;
    } else if (rsi < 65) {
      action = "BUY"; confidence = 70;
      rationale = `相對排名快速改善（+${rankShift}）— 正輪動成領頭板塊`;
    } else {
      action = "BUY"; confidence = 55;
      rationale = `排名改善（+${rankShift}）但 RSI 偏高 — 有回調先入場`;
    }
    extraFactors.push(`排名變動：+${rankShift}（向榜首進發）`);
  } else if (improving) {
    if (rsi < 60) {
      action = "BUY"; confidence = 60;
      rationale = `相對排名改善（排名變動：+${rankShift}），仲有上升空間`;
    } else {
      action = "HOLD"; confidence = 50;
      rationale = `排名改善（+${rankShift}），等更好入場位`;
    }
  } else if (stronglyDeteriorating) {
    if (trendPhase === "EARLY_DOWNTREND" || trendPhase === "ESTABLISHED_DOWNTREND") {
      action = "SELL"; confidence = 80;
      rationale = `資金快速輪動出（排名變動：${rankShift}），趨勢破壞 — 離場`;
    } else {
      action = "SELL"; confidence = 65;
      rationale = `由領頭位置跌落（排名變動：${rankShift}）— 資金輪動去其他板塊`;
    }
    extraFactors.push(`排名變動：${rankShift}（由領頭位置跌落）`);
  } else if (deteriorating) {
    if (trendPhase === "EXTENDED" || rsi >= 65) {
      action = "TRIM"; confidence = 60;
      rationale = `相對排名下跌（變動：${rankShift}）兼升勢過熱 — 輪動出`;
    } else {
      action = "HOLD"; confidence = 45;
      rationale = `排名輕微轉差（變動：${rankShift}）— 留意會否加速`;
    }
  } else {
    // Stable rank — no rotation signal
    if (trendPhase === "ESTABLISHED_UPTREND" && rsi < 60) {
      action = "HOLD"; confidence = 55;
      rationale = "相對排名穩定，處於升勢 — 維持比重";
    } else if (trendPhase === "ESTABLISHED_DOWNTREND") {
      action = "SELL"; confidence = 55;
      rationale = "排名穩定但包尾 — 無催化劑輪動入";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "排名無明顯變化 — 無輪動訊號";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Capital mode modifier: Rotate (rebalance existing portfolio)
// ---------------------------------------------------------------------------

/**
 * Adjusts recommendations for the "rotate" capital mode.
 * Key differences from "deploy":
 *   - HOLD means "keep current weight" not "keep cash"
 *   - BUY means "overweight" (shift funds from underperformers)
 *   - SELL means "underweight" (shift funds to outperformers)
 *   - Confidence is tempered — rotation has transaction costs
 *   - No "keep cash" option — always fully invested
 */
function applyRotateModifier(
  result: { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] },
  ctx: SignalContext
): { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] } {
  const extraFactors = [...(result.extraFactors ?? [])];
  let { action, confidence, rationale } = result;

  // In rotate mode, lower confidence to account for switching costs
  // (selling one position to buy another has friction)
  if (action === "BUY" || action === "SELL") {
    confidence = Math.max(confidence - 5, 30);
  }

  // Reframe the language
  if (action === "BUY") {
    rationale = `增持 — ${rationale}`;
    extraFactors.push("輪動模式：將比重由落後者轉入呢隻");
  } else if (action === "SELL") {
    rationale = `減持 — ${rationale}`;
    extraFactors.push("輪動模式：將比重由呢隻轉去領先者");
  } else if (action === "TRIM") {
    rationale = `減低比重 — ${rationale}`;
    extraFactors.push("輪動模式：減倉以調配資金去增持部位");
  } else {
    // HOLD
    rationale = `維持比重 — ${rationale}`;
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Sector Diagnostics — transparent phase detection with evidence
// ---------------------------------------------------------------------------

const ETF_SECTOR_MAP_DIAG: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financial",
  XLE: "Energy",
  XLV: "Healthcare",
  XLY: "Consumer Cyclical",
  XLP: "Consumer Defensive",
  XLI: "Industrials",
  XLB: "Basic Materials",
  XLC: "Communication Services",
  XLRE: "Real Estate",
  XLU: "Utilities",
};

const SECTOR_TO_TICKER_DIAG: Record<string, string> = Object.fromEntries(
  Object.entries(ETF_SECTOR_MAP_DIAG).map(([t, s]) => [s, t])
);

export function computeSectorDiagnostics(
  sectorPerfs: SectorPerformance[],
  signals: RotationSignal[],
  fundFlows: ETFFundFlow[],
  darkPoolTrends: DarkPoolTrend[],
  optionsData: OptionsData[]
): SectorDiagnostic[] {
  const n = sectorPerfs.length;
  const flowMap = new Map(fundFlows.map(f => [f.sector, f]));
  const dpMap = new Map(darkPoolTrends.map(d => [d.ticker, d]));
  const optMap = new Map(optionsData.map(o => [o.ticker, o]));

  return sectorPerfs.map(sp => {
    const sig = signals.find(s => s.sector === sp.sector);
    const flow = flowMap.get(sp.sector);
    const ticker = SECTOR_TO_TICKER_DIAG[sp.sector] || '';
    const dp = dpMap.get(ticker);
    const opt = optMap.get(ticker);

    // --- Momentum regime ---
    const perf1W = sp.mcw1W;
    const perf1WAnnualized = perf1W * 52;
    const perf3MAnnualized = sp.mcw3M * 4;
    let momentumRegime: SectorDiagnostic["momentumRegime"];
    const accelThreshold = 10; // annualized % diff to call it accelerating
    if (perf1WAnnualized - perf3MAnnualized > accelThreshold) momentumRegime = "ACCELERATING";
    else if (perf3MAnnualized - perf1WAnnualized > accelThreshold) momentumRegime = "DECELERATING";
    else momentumRegime = "STEADY";

    // --- Breadth direction ---
    const breadth1W = sp.breadth1W;
    const breadth3M = sp.breadth3M;
    const breadthDiff = breadth1W - breadth3M;
    let breadthDirection: SectorDiagnostic["breadthDirection"];
    if (breadthDiff > 5) breadthDirection = "BROADENING";
    else if (breadthDiff < -5) breadthDirection = "NARROWING";
    else breadthDirection = "STABLE";

    // --- Size leadership ---
    const mcw1W = sp.mcw1W;
    const ew1W = sp.ew1W;
    const sizeSpread = mcw1W - ew1W;
    let sizeLeadership: SectorDiagnostic["sizeLeadership"];
    if (sizeSpread > 0.5) sizeLeadership = "LARGE_CAP_LED";
    else if (sizeSpread < -0.5) sizeLeadership = "SMALL_CAP_LED";
    else sizeLeadership = "BROAD_BASED";

    // --- Flow-price alignment ---
    const sharesPctChange = flow?.sharesPct5Day ?? 0;
    const priceChange = perf1W;
    let flowPriceSignal: SectorDiagnostic["flowPriceSignal"];
    if (sharesPctChange > 0.1 && priceChange < -0.5) flowPriceSignal = "ACCUMULATION";
    else if (sharesPctChange < -0.1 && priceChange > 0.5) flowPriceSignal = "DISTRIBUTION";
    else if (sharesPctChange > 0.1 && priceChange > 0.5) flowPriceSignal = "CONFIRMED_BULL";
    else if (sharesPctChange < -0.1 && priceChange < -0.5) flowPriceSignal = "CONFIRMED_BEAR";
    else flowPriceSignal = "NEUTRAL";

    // --- Rank velocity ---
    const rank1W = sig?.rank1W ?? n;
    const rank3M = sig?.rank3M ?? n;
    const rankVelocity = rank3M - rank1W; // positive = improving
    let rankSignal: SectorDiagnostic["rankSignal"];
    if (rankVelocity >= 4) rankSignal = "RAPID_ASCENT";
    else if (rankVelocity >= 2) rankSignal = "RISING";
    else if (rankVelocity <= -4) rankSignal = "RAPID_DESCENT";
    else if (rankVelocity <= -2) rankSignal = "FALLING";
    else rankSignal = "STABLE";

    // --- Dark pool signal (with trend) ---
    const darkPoolShortRatio = dp?.shortRatio1d ?? 0;
    const darkPoolShortRatio5d = dp?.shortRatio5d ?? 0;
    const darkPoolShortRatio20d = dp?.shortRatio20d ?? 0;
    const darkPoolTrend = dp?.trend ?? "STABLE" as SectorDiagnostic["darkPoolTrend"];
    // Signal based on 5d average (smoothed, not noisy single-day)
    const dpLevel = darkPoolShortRatio5d || darkPoolShortRatio; // fallback to 1d if no history
    let darkPoolSignal: SectorDiagnostic["darkPoolSignal"];
    if (dpLevel >= 0.6) darkPoolSignal = "HEAVY_SHORTING";
    else if (dpLevel >= 0.5) darkPoolSignal = "ELEVATED_SHORTING";
    else if (dpLevel > 0 && dpLevel < 0.35) darkPoolSignal = "LOW_SHORTING";
    else darkPoolSignal = "NEUTRAL_DP";

    // --- Options signal ---
    const putCallRatio = opt?.putCallRatio ?? 0;
    const putCallOIRatio = opt?.putCallOIRatio ?? 0;
    const impliedVolatility = opt?.impliedVolatility ?? 0;
    let optionsSignal: SectorDiagnostic["optionsSignal"];
    if (putCallRatio >= 2.0 || putCallOIRatio >= 2.0) optionsSignal = "EXTREME_FEAR";
    else if (putCallRatio >= 1.3) optionsSignal = "HEAVY_PUT_BUYING";
    else if (putCallRatio >= 1.0) optionsSignal = "ELEVATED_PUTS";
    else if (putCallRatio > 0 && putCallRatio < 0.5) optionsSignal = "CALL_HEAVY";
    else optionsSignal = "NEUTRAL_OPT";

    // --- Build evidence strings with raw numbers ---
    const evidence: string[] = [];

    if (momentumRegime === "ACCELERATING") {
      evidence.push(`動量加速：1週年化 ${perf1WAnnualized > 0 ? '+' : ''}${perf1WAnnualized.toFixed(0)}% 對 3個月年化 ${perf3MAnnualized > 0 ? '+' : ''}${perf3MAnnualized.toFixed(0)}%`);
    } else if (momentumRegime === "DECELERATING") {
      evidence.push(`動量減速：1週年化 ${perf1WAnnualized > 0 ? '+' : ''}${perf1WAnnualized.toFixed(0)}% 對 3個月年化 ${perf3MAnnualized > 0 ? '+' : ''}${perf3MAnnualized.toFixed(0)}%`);
    }

    if (breadthDirection === "BROADENING") {
      evidence.push(`廣度擴闊：本週 ${breadth1W.toFixed(0)}% 上升，對比 3個月 ${breadth3M.toFixed(0)}%`);
    } else if (breadthDirection === "NARROWING") {
      evidence.push(`廣度收窄：本週 ${breadth1W.toFixed(0)}% 上升，對比 3個月 ${breadth3M.toFixed(0)}%`);
    }

    if (sizeLeadership === "LARGE_CAP_LED") {
      evidence.push(`大盤股領漲：市值加權 ${mcw1W > 0 ? '+' : ''}${mcw1W.toFixed(2)}% 對 等權重 ${ew1W > 0 ? '+' : ''}${ew1W.toFixed(2)}%`);
    } else if (sizeLeadership === "SMALL_CAP_LED") {
      evidence.push(`小盤股領漲：等權重 ${ew1W > 0 ? '+' : ''}${ew1W.toFixed(2)}% 對 市值加權 ${mcw1W > 0 ? '+' : ''}${mcw1W.toFixed(2)}%`);
    }

    if (flowPriceSignal === "ACCUMULATION") {
      evidence.push(`吸納：股數 +${(sharesPctChange * 100).toFixed(2)}% 但價格 ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "DISTRIBUTION") {
      evidence.push(`派發：股數 ${(sharesPctChange * 100).toFixed(2)}% 但價格 +${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "CONFIRMED_BULL") {
      evidence.push(`確認升勢：股數 +${(sharesPctChange * 100).toFixed(2)}% 且價格 +${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "CONFIRMED_BEAR") {
      evidence.push(`確認跌勢：股數 ${(sharesPctChange * 100).toFixed(2)}% 且價格 ${priceChange.toFixed(2)}%`);
    }

    if (rankSignal === "RAPID_ASCENT") {
      evidence.push(`快速攀升：現排名 #${rank1W}，3個月排名 #${rank3M}`);
    } else if (rankSignal === "RAPID_DESCENT") {
      evidence.push(`快速下跌：現排名 #${rank1W}，3個月排名 #${rank3M}`);
    } else if (rankSignal === "RISING") {
      evidence.push(`排名上升：現 #${rank1W}，3個月前 #${rank3M}`);
    } else if (rankSignal === "FALLING") {
      evidence.push(`排名下跌：現 #${rank1W}，3個月前 #${rank3M}`);
    }

    if (darkPoolSignal === "HEAVY_SHORTING") {
      const trendNote = darkPoolTrend === "INCREASING" ? "（↑ 按週上升）" : darkPoolTrend === "DECREASING" ? "（↓ 放緩）" : "";
      evidence.push(`暗盤重倉沽空：5天平均 ${(darkPoolShortRatio5d * 100).toFixed(0)}%，20天平均 ${(darkPoolShortRatio20d * 100).toFixed(0)}%${trendNote}`);
    } else if (darkPoolSignal === "ELEVATED_SHORTING") {
      const trendNote = darkPoolTrend === "INCREASING" ? "（↑ 上升中）" : darkPoolTrend === "DECREASING" ? "（↓ 回落中）" : "";
      evidence.push(`暗盤沽空偏高：5天平均 ${(darkPoolShortRatio5d * 100).toFixed(0)}%，20天平均 ${(darkPoolShortRatio20d * 100).toFixed(0)}%${trendNote}`);
    } else if (darkPoolSignal === "LOW_SHORTING") {
      const trendNote = darkPoolTrend === "DECREASING" ? "（↓ 持續回落＝利好）" : "";
      evidence.push(`暗盤沽空偏低：5天平均 ${(darkPoolShortRatio5d * 100).toFixed(0)}%（利好）${trendNote}`);
    }

    if (optionsSignal === "EXTREME_FEAR") {
      evidence.push(`期權市場極度恐慌：P/C 比率 ${putCallRatio.toFixed(2)}，未平倉 P/C ${putCallOIRatio.toFixed(2)}，IV ${(impliedVolatility * 100).toFixed(0)}%`);
    } else if (optionsSignal === "HEAVY_PUT_BUYING") {
      evidence.push(`重倉買入認沽期權：P/C 比率 ${putCallRatio.toFixed(2)}，IV ${(impliedVolatility * 100).toFixed(0)}%`);
    } else if (optionsSignal === "ELEVATED_PUTS") {
      evidence.push(`認沽期權偏高：P/C 比率 ${putCallRatio.toFixed(2)}，IV ${(impliedVolatility * 100).toFixed(0)}%`);
    } else if (optionsSignal === "CALL_HEAVY") {
      evidence.push(`認購期權主導：P/C 比率 ${putCallRatio.toFixed(2)}（利好部署），IV ${(impliedVolatility * 100).toFixed(0)}%`);
    }

    // --- Institutional Intent (DPSV + Momentum + Options Overlay) ---
    // Decodes WHY market makers are acting by cross-referencing dark pool
    // short volume with options positioning and momentum regime.
    let institutionalIntent: SectorDiagnostic["institutionalIntent"] = "NONE";
    let intentEvidence = "";

    // IV thresholds: >30% = aggressive/panicked buying; <20% = sellers in control
    const highIV = impliedVolatility >= 0.30;
    const lowIV = impliedVolatility > 0 && impliedVolatility < 0.20;
    const hasOptionsData = putCallRatio > 0 || impliedVolatility > 0;
    const highDPSV = dpLevel >= 0.55;
    const lowDPSV = dpLevel > 0 && dpLevel < 0.40;
    const highPutVol = putCallRatio >= 1.0;
    const highCallVol = putCallRatio > 0 && putCallRatio < 0.6;

    if (hasOptionsData && highDPSV && momentumRegime === "ACCELERATING" && highCallVol && highIV) {
      // Aggressive Breakout: High DPSV + Accel Momentum + High Call Vol + Spiking IV
      // MMs shorting to hedge calls they sold → forced buying drives breakout
      institutionalIntent = "AGGRESSIVE_BREAKOUT";
      intentEvidence = `Gamma 逼空：暗盤沽空 ${(dpLevel * 100).toFixed(0)}%（莊家對沖沽出嘅認購期權）＋ 認購主導 P/C ${putCallRatio.toFixed(2)} ＋ IV ${(impliedVolatility * 100).toFixed(0)}%（進取買入認購期權）`;
    } else if (hasOptionsData && highDPSV && momentumRegime === "ACCELERATING" && highPutVol && highIV) {
      // Hedged Momentum: buying shares AND protective puts (belt-and-suspenders)
      institutionalIntent = "HEDGED_MOMENTUM";
      intentEvidence = `對沖式突破：暗盤沽空 ${(dpLevel * 100).toFixed(0)}% ＋ 動量加速 ＋ 保護性認沽 P/C ${putCallRatio.toFixed(2)} ＋ IV ${(impliedVolatility * 100).toFixed(0)}%`;
    } else if (hasOptionsData && highDPSV && momentumRegime !== "ACCELERATING" && highPutVol && lowIV) {
      // Dark Accumulation: High DPSV + Flat/Decel Momentum + High Put Vol + Falling IV
      // Institutions writing puts to acquire stock; MMs short to hedge purchased puts
      institutionalIntent = "DARK_ACCUMULATION";
      intentEvidence = `機構沽出認沽期權：暗盤沽空 ${(dpLevel * 100).toFixed(0)}%（莊家對沖買入嘅認沽期權）＋ P/C ${putCallRatio.toFixed(2)} ＋ IV ${(impliedVolatility * 100).toFixed(0)}%（期權金賣方主導）`;
    } else if (hasOptionsData && lowDPSV && momentumRegime === "DECELERATING" && highPutVol && highIV) {
      // True Distribution: Low DPSV + Decel Momentum + High Put Vol + Spiking IV
      // Institutions dumping in lit market + panic-buying protective puts
      institutionalIntent = "TRUE_DISTRIBUTION";
      intentEvidence = `機構離場：暗盤沽空偏低 ${(dpLevel * 100).toFixed(0)}%（喺公開市場沽貨）＋ 認沽 P/C ${putCallRatio.toFixed(2)} ＋ IV ${(impliedVolatility * 100).toFixed(0)}%（恐慌性對沖）`;
    } else if (hasOptionsData && highDPSV && momentumRegime === "DECELERATING" && highPutVol && highIV) {
      // High DPSV + Decel + High puts + High IV = true distribution
      institutionalIntent = "TRUE_DISTRIBUTION";
      intentEvidence = `機構離場：暗盤沽空 ${(dpLevel * 100).toFixed(0)}% ＋ 動量減速 ＋ 恐慌性認沽 P/C ${putCallRatio.toFixed(2)} ＋ IV ${(impliedVolatility * 100).toFixed(0)}%`;
    }

    if (institutionalIntent !== "NONE") {
      evidence.push(`🔍 意圖：${intentEvidence}`);
    }

    // --- Phase from evidence pattern ---
    // Dark pool trends + options now influence phase detection.
    // Institutional intent overrides ambiguous signals when detected.
    // Trend matters more than level: sustained increasing shorting = institutional conviction.
    let phase: SectorDiagnostic["phase"] = "NEUTRAL";

    if (breadthDirection === "BROADENING" && sharesPctChange > 0 && priceChange < 1) {
      phase = "EARLY_ACCUMULATION";
    } else if (darkPoolSignal === "LOW_SHORTING" && darkPoolTrend === "DECREASING" && sharesPctChange > 0) {
      // Shorting declining week-over-week + share creation = stealth accumulation
      phase = "EARLY_ACCUMULATION";
    } else if (darkPoolSignal === "LOW_SHORTING" && sharesPctChange > 0 && priceChange < 1) {
      // Low shorting level + share creation + flat price = accumulation
      phase = "EARLY_ACCUMULATION";
    } else if (momentumRegime === "ACCELERATING" && flowPriceSignal === "CONFIRMED_BULL") {
      phase = "CONFIRMED_UPTREND";
    } else if (momentumRegime === "ACCELERATING" && breadthDirection === "BROADENING") {
      phase = "CONFIRMED_UPTREND";
    } else if (momentumRegime === "ACCELERATING" && optionsSignal === "CALL_HEAVY" && darkPoolTrend !== "INCREASING") {
      // Accelerating + call-heavy + not increasing DP shorting = confirmed bullish
      phase = "CONFIRMED_UPTREND";
    } else if (perf1W > 0 && breadthDirection === "NARROWING" && sharesPctChange > 0) {
      phase = "LATE_STAGE";
    } else if (perf1W > 0 && darkPoolSignal === "HEAVY_SHORTING" && darkPoolTrend === "INCREASING") {
      // Price up but dark pool shorting escalating week-over-week = late stage
      phase = "LATE_STAGE";
    } else if (perf1W > 0 && darkPoolSignal === "HEAVY_SHORTING" && optionsSignal !== "CALL_HEAVY") {
      // Price up + heavy shorting level (even stable) = late stage
      phase = "LATE_STAGE";
    } else if (flowPriceSignal === "DISTRIBUTION") {
      phase = "DISTRIBUTION";
    } else if (darkPoolSignal === "HEAVY_SHORTING" && darkPoolTrend === "INCREASING" && sharesPctChange < 0) {
      // Shorting increasing + share redemption = confirmed distribution
      phase = "DISTRIBUTION";
    } else if (darkPoolSignal === "HEAVY_SHORTING" && priceChange > 0.5 && sharesPctChange < 0) {
      // Heavy shorting + rising price + share redemption = smart money distributing
      phase = "DISTRIBUTION";
    } else if (momentumRegime === "DECELERATING" && breadthDirection === "NARROWING") {
      phase = "EARLY_DECLINE";
    } else if (momentumRegime === "DECELERATING" && (optionsSignal === "HEAVY_PUT_BUYING" || optionsSignal === "EXTREME_FEAR")) {
      // Decelerating + heavy puts = early decline with hedging
      phase = "EARLY_DECLINE";
    } else if (darkPoolTrend === "INCREASING" && optionsSignal === "ELEVATED_PUTS" && priceChange < 0) {
      // Rising DP shorting + elevated puts + price down = early decline
      phase = "EARLY_DECLINE";
    } else if (momentumRegime === "DECELERATING" && flowPriceSignal === "CONFIRMED_BEAR") {
      phase = "CONFIRMED_DOWNTREND";
    } else if (momentumRegime === "DECELERATING" && sharesPctChange < -0.1) {
      phase = "CONFIRMED_DOWNTREND";
    } else if (optionsSignal === "EXTREME_FEAR" && darkPoolSignal === "HEAVY_SHORTING" && darkPoolTrend === "INCREASING") {
      // Both options + sustained/escalating dark pool shorting = confirmed downtrend
      phase = "CONFIRMED_DOWNTREND";
    }

    if (phase === "NEUTRAL") {
      if (momentumRegime === "ACCELERATING") phase = "CONFIRMED_UPTREND";
      else if (momentumRegime === "DECELERATING") phase = "EARLY_DECLINE";
    }

    // Institutional intent can upgrade/override phase when signals are strong
    if (institutionalIntent === "AGGRESSIVE_BREAKOUT" && phase !== "CONFIRMED_DOWNTREND") {
      phase = "CONFIRMED_UPTREND";
    } else if (institutionalIntent === "DARK_ACCUMULATION" && (phase === "NEUTRAL" || phase === "EARLY_DECLINE")) {
      phase = "EARLY_ACCUMULATION";
    } else if (institutionalIntent === "TRUE_DISTRIBUTION" && phase !== "CONFIRMED_DOWNTREND") {
      if (phase === "NEUTRAL" || phase === "LATE_STAGE") phase = "DISTRIBUTION";
      else if (phase === "EARLY_DECLINE") phase = "CONFIRMED_DOWNTREND";
    }

    return {
      sector: sp.sector,
      ticker,
      perf1W,
      perf1WAnnualized,
      perf3MAnnualized,
      momentumRegime,
      breadth1W,
      breadth3M,
      breadthDirection,
      mcw1W,
      ew1W,
      sizeSpread,
      sizeLeadership,
      sharesPctChange,
      priceChange,
      flowPriceSignal,
      rank1W,
      rank3M,
      rankVelocity,
      rankSignal,
      darkPoolShortRatio,
      darkPoolShortRatio5d,
      darkPoolShortRatio20d,
      darkPoolTrend,
      darkPoolSignal,
      putCallRatio,
      putCallOIRatio,
      impliedVolatility,
      optionsSignal,
      institutionalIntent,
      intentEvidence,
      phase,
      evidence,
    };
  }).sort((a, b) => {
    const phaseOrder: Record<string, number> = {
      EARLY_ACCUMULATION: 0,
      CONFIRMED_UPTREND: 1,
      LATE_STAGE: 2,
      NEUTRAL: 3,
      DISTRIBUTION: 4,
      EARLY_DECLINE: 5,
      CONFIRMED_DOWNTREND: 6,
    };
    return (phaseOrder[a.phase] ?? 3) - (phaseOrder[b.phase] ?? 3);
  });
}
