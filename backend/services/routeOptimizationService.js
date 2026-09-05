const { calculateDistance } = require("../../gis/distance");
const { checkGeofence } = require("./geofenceService");
const { checkRouteGeofence } = require("../../gis/geofence");
const { calculateRisk } = require("../../risk-engine/riskCalculator");

/**
 * Phase 4: Multi-Hazard Safe Route Optimization Service
 * Evaluates origin -> destination vessel navigation paths across candidate routes.
 */
async function findOptimizedSafeRoute({
  origin = { latitude: 17.68, longitude: 83.21 }, // Default Visakhapatnam Harbor
  destination = { latitude: 17.39, longitude: 83.27 }, // Default Target PFZ
  vesselSpeedKnots = 12, // Standard trawler speed ~ 22.2 km/h
  marineConditions = null
}) {
  const originLat = Number(origin.latitude ?? origin.lat ?? 17.68);
  const originLon = Number(origin.longitude ?? origin.lon ?? 83.21);
  const destLat = Number(destination.latitude ?? destination.lat ?? 17.39);
  const destLon = Number(destination.longitude ?? destination.lon ?? 83.27);

  const speedKmH = vesselSpeedKnots * 1.852;

  // 1. Generate 3 Candidate Routes (Direct, Wide Coastal Bypass, Alternative)
  const candidateRoutes = generateCandidateRoutes(originLat, originLon, destLat, destLon);

  // 2. Evaluate Each Candidate Route
  const evaluatedRoutes = candidateRoutes.map((candidate, index) => {
    return evaluateCandidateRoute(candidate, index + 1, speedKmH, marineConditions);
  });

  // 3. Filter Out Restricted Routes & Sort by Safety Score
  const validRoutes = evaluatedRoutes.filter(r => !r.crossesRestricted);
  const selectedRoute = validRoutes.length > 0
    ? validRoutes.sort((a, b) => b.safetyScore - a.safetyScore)[0]
    : evaluatedRoutes.sort((a, b) => a.totalRiskScore - b.totalRiskScore)[0]; // Fallback if all pass caution

  // 4. Generate Comparison Explanation
  const comparisonExplanation = generateRouteComparison(evaluatedRoutes, selectedRoute);

  return {
    success: true,
    origin: { latitude: originLat, longitude: originLon },
    destination: { latitude: destLat, longitude: destLon },
    selectedRoute,
    candidateRoutes: evaluatedRoutes,
    comparisonExplanation,
    recommendation: selectedRoute.crossesRestricted ? "DO_NOT_SAIL" : selectedRoute.safetyLevel
  };
}

/**
 * Generates Candidate Route Waypoints (Direct, Wide-Bypass, Alternative)
 */
function generateCandidateRoutes(oLat, oLon, dLat, dLon) {
  // Candidate 1: Direct Straight-Line Waypoints
  const directWaypoints = [
    { lat: oLat, lon: oLon, label: "Origin Harbor" },
    { lat: (oLat + dLat) / 2, lon: (oLon + dLon) / 2, label: "Midpoint Waypoint" },
    { lat: dLat, lon: dLon, label: "Destination PFZ" }
  ];

  // Candidate 2: Wide Coastal Bypass (Offset eastward/seaward by +0.15 deg lon)
  const bypassWaypoints = [
    { lat: oLat, lon: oLon, label: "Origin Harbor" },
    { lat: oLat + (dLat - oLat) * 0.3, lon: Math.max(oLon, dLon) + 0.12, label: "Seaward Buffer Waypoint" },
    { lat: oLat + (dLat - oLat) * 0.7, lon: Math.max(oLon, dLon) + 0.10, label: "Coastal Bypass Waypoint" },
    { lat: dLat, lon: dLon, label: "Destination PFZ" }
  ];

  // Candidate 3: Inshore Alternative (Offset westward by -0.10 deg lon)
  const altWaypoints = [
    { lat: oLat, lon: oLon, label: "Origin Harbor" },
    { lat: oLat + (dLat - oLat) * 0.5, lon: Math.min(oLon, dLon) - 0.08, label: "Inshore Channel Waypoint" },
    { lat: dLat, lon: dLon, label: "Destination PFZ" }
  ];

  return [
    { name: "Direct Route A", type: "DIRECT", waypoints: directWaypoints },
    { name: "Safe Wide Bypass Route B", type: "WIDE_BYPASS", waypoints: bypassWaypoints },
    { name: "Inshore Alternative Route C", type: "ALTERNATIVE", waypoints: altWaypoints }
  ];
}

/**
 * Evaluates waypoints for distance, travel time, multi-hazard risk, and geofences
 */
function evaluateCandidateRoute(candidate, routeNum, speedKmH, marineConditions) {
  const waypoints = candidate.waypoints;
  let totalDistanceKm = 0;
  const segments = [];
  let maxSegmentRiskScore = 0;
  let totalRiskScore = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];

    const dist = calculateDistance(p1.lat, p1.lon, p2.lat, p2.lon);
    totalDistanceKm += dist;

    const midLat = (p1.lat + p2.lat) / 2;
    const midLon = (p1.lon + p2.lon) / 2;

    const geofenceCheck = checkGeofence(midLat, midLon);

    const segmentConditions = {
      wind: (marineConditions?.wind ?? 14) + (i * 2),
      windGust: (marineConditions?.windGust ?? 20) + (i * 2),
      waveHeight: (marineConditions?.waveHeight ?? 1.5) + (i * 0.3),
      rainProbability: 25,
      lightning: 0,
      geofence: geofenceCheck
    };

    const segRisk = calculateRisk(segmentConditions);
    totalRiskScore += segRisk.score;
    if (segRisk.score > maxSegmentRiskScore) maxSegmentRiskScore = segRisk.score;

    segments.push({
      segmentIndex: i + 1,
      from: p1,
      to: p2,
      distanceKm: Number(dist.toFixed(2)),
      estimatedHours: Number((dist / speedKmH).toFixed(2)),
      riskScore: segRisk.score,
      riskLevel: segRisk.level,
      factors: segRisk.factors,
      geofenceStatus: geofenceCheck.status
    });
  }

  // Check complete route line against geofences
  const routeGeofence = checkRouteGeofence(waypoints);

  const estimatedTravelTimeHours = Number((totalDistanceKm / speedKmH).toFixed(2));
  const crossesRestricted = routeGeofence.crossesRestricted;
  const safetyScore = Math.max(0, 100 - (totalRiskScore / segments.length) - (crossesRestricted ? 100 : 0));

  let safetyLevel = "SAFE";
  if (crossesRestricted || maxSegmentRiskScore >= 80) {
    safetyLevel = "RESTRICTED";
  } else if (maxSegmentRiskScore >= 30) {
    safetyLevel = "CAUTION";
  }

  return {
    id: `ROUTE-${routeNum}`,
    name: candidate.name,
    type: candidate.type,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    estimatedTravelTimeHours,
    safetyScore: Number(safetyScore.toFixed(1)),
    safetyLevel,
    crossesRestricted,
    breachedZones: routeGeofence.breachedZones || [],
    segments,
    waypoints,
    geofenceExplanation: routeGeofence.explanation
  };
}

/**
 * Generates human-readable comparison explaining why Route A is safer than Route B
 */
function generateRouteComparison(candidateRoutes, selectedRoute) {
  const otherRoutes = candidateRoutes.filter(r => r.id !== selectedRoute.id);
  if (otherRoutes.length === 0) return "Single route evaluated.";

  const alt = otherRoutes[0];
  if (selectedRoute.crossesRestricted && !alt.crossesRestricted) {
    return `${alt.name} is recommended over ${selectedRoute.name} because ${selectedRoute.name} breaches a restricted marine boundary.`;
  }

  if (!selectedRoute.crossesRestricted && alt.crossesRestricted) {
    return `${selectedRoute.name} is selected because ${alt.name} crosses restricted zone (${alt.breachedZones[0]?.name || "Restricted Zone"}). ${selectedRoute.name} remains completely outside restricted boundaries.`;
  }

  const distDiff = (selectedRoute.totalDistanceKm - alt.totalDistanceKm).toFixed(1);
  if (distDiff > 0) {
    return `${selectedRoute.name} is selected over ${alt.name}. Although it is ${distDiff} km longer, it maintains a significantly higher safety score (${selectedRoute.safetyScore} vs ${alt.safetyScore}) by steering clear of higher wave swells and caution boundary buffers.`;
  } else {
    return `${selectedRoute.name} is selected because it is both shorter (${selectedRoute.totalDistanceKm} km vs ${alt.totalDistanceKm} km) and safer (Safety Score: ${selectedRoute.safetyScore}/100).`;
  }
}

module.exports = {
  findOptimizedSafeRoute
};
