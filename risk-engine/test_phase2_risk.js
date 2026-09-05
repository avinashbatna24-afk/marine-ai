const { calculateRisk, calculatePFZRisk, calculateRiskTrend } = require("./riskCalculator");
const { getBestFishingZones } = require("../backend/services/pfzRecommendationService");

async function runPhase2Tests() {
  console.log("====================================================");
  console.log("🧪 RUNNING PHASE 2 RISK MANAGEMENT ENGINE TESTS");
  console.log("====================================================\n");

  let passed = 0;
  let total = 0;

  function assert(condition, title) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${title}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${title}`);
    }
  }

  // Test 1: Multi-source risk calculation
  const risk1 = calculateRisk({
    wind: 28,
    windGust: 38,
    waveHeight: 2.8,
    rainProbability: 70,
    officialWarning: "MODERATE"
  });

  assert(risk1.score >= 60, "Multi-source risk score calculation (Score >= 60)");
  assert(risk1.level === "HIGH" || risk1.level === "EXTREME", `Risk level classification (Level: ${risk1.level})`);
  assert(risk1.factors.length >= 3, `Identified multiple risk factors (${risk1.factors.join(", ")})`);

  // Test 2: Geofence violation penalty
  const riskGeofence = calculateRisk({
    wind: 10,
    waveHeight: 1.0,
    geofence: { insideRestrictedZone: true, warningMessage: "IMBL Violation" }
  });

  assert(riskGeofence.level === "EXTREME", "Inside restricted geofence forces EXTREME risk");
  assert(riskGeofence.recommendation === "DO_NOT_SAIL", "Restricted geofence forces DO_NOT_SAIL recommendation");

  // Test 3: Risk Trend Calculation
  const trend = calculateRiskTrend(
    { wind: 15, waveHeight: 1.2 },
    { wind: 36, waveHeight: 3.5 }
  );

  assert(trend.trend === "WORSENING", `Calculated risk trend WORSENING (Current: ${trend.currentRiskLevel} -> Forecast: ${trend.forecastRiskLevel})`);

  // Test 4: Per-PFZ Risk Evaluation
  const pfzSample = { id: "PFZ-TEST-1", name: "Visakhapatnam Deep", latitude: 17.39, longitude: 83.27, category: "VERY_HIGH" };
  const pfzRisk = calculatePFZRisk(pfzSample, { wind: 20, waveHeight: 2.0 });

  assert(pfzRisk.pfzId === "PFZ-TEST-1", "Evaluated per-PFZ risk structure");
  assert(typeof pfzRisk.safetyScore === "number", "Calculated PFZ safety score");

  // Test 5: Risk-Aware PFZ Ranking
  const rankedResult = await getBestFishingZones({ latitude: 17.39, longitude: 83.27, maxDistance: 100 });
  assert(rankedResult.success === true, "Risk-aware PFZ ranking execution");
  assert(rankedResult.recommendedZone && rankedResult.recommendedZone.safetyScore !== undefined, "Recommended PFZ contains safety score & marine risk");

  console.log("\n====================================================");
  console.log(`📊 PHASE 2 TEST RESULTS: ${passed}/${total} PASSED (${Math.round((passed/total)*100)}%)`);
  console.log("====================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runPhase2Tests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
