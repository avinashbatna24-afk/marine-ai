const { findOptimizedSafeRoute } = require("./routeOptimizationService");

async function runPhase4Tests() {
  console.log("====================================================");
  console.log("🧪 RUNNING PHASE 4 SAFE ROUTE ENGINE TESTS");
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

  // Test 1: Route Optimization Execution
  const res = await findOptimizedSafeRoute({
    origin: { latitude: 17.68, longitude: 83.21 }, // Visakhapatnam Harbor
    destination: { latitude: 17.39, longitude: 83.27 }, // Visakhapatnam Deep PFZ
    vesselSpeedKnots: 12
  });

  assert(res.success === true, "Route optimization executed successfully");
  assert(res.selectedRoute && res.candidateRoutes.length >= 3, "Generated at least 3 candidate routes (Direct, Bypass, Alternative)");

  // Test 2: Distance & Travel Time Calculation
  const route = res.selectedRoute;
  assert(route.totalDistanceKm > 0, `Calculated total route distance (${route.totalDistanceKm} km)`);
  assert(route.estimatedTravelTimeHours > 0, `Calculated estimated travel time (${route.estimatedTravelTimeHours} hours @ 12 knots)`);

  // Test 3: Segment Multi-Hazard Evaluation
  assert(Array.isArray(route.segments) && route.segments.length > 0, "Route contains evaluated waypoints & segments");
  assert(route.segments[0].riskScore !== undefined, `Calculated segment risk score (${route.segments[0].riskScore})`);

  // Test 4: Safest Route Selection & Restricted Area Avoidance
  assert(route.crossesRestricted === false, "Selected route avoids all restricted marine geofence zones");
  assert(route.safetyScore >= 50, `Route safety score calculation (Safety Score: ${route.safetyScore}/100)`);

  // Test 5: Route Comparison Explanation
  assert(typeof res.comparisonExplanation === "string" && res.comparisonExplanation.length > 20, `Generated explainable route comparison text ("${res.comparisonExplanation.slice(0, 60)}...")`);

  console.log("\n====================================================");
  console.log(`📊 PHASE 4 TEST RESULTS: ${passed}/${total} PASSED (${Math.round((passed/total)*100)}%)`);
  console.log("====================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runPhase4Tests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
