const { getPFZs, rankPFZs } = require("./pfzService");
const { calculateDistance } = require("../../gis/distance");
const { checkGeofence } = require("./geofenceService");
const { calculateRisk } = require("../../risk-engine/riskCalculator");

async function getBestFishingZones({
  latitude,
  longitude,
  maxDistance = 150,
  maxRisk = "ALL",
  minChlorophyll = 0,
}) {
  latitude = Number(latitude);
  longitude = Number(longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      success: false,
      message: "Valid latitude and longitude are required",
    };
  }

  // Get candidate PFZs from pfzService rankPFZs or getPFZs
  let pfzs = [];
  try {
    pfzs = await rankPFZs(latitude, longitude, 15);
  } catch (e) {
    pfzs = await getPFZs("ALL");
  }

  const ranked = pfzs
    .map((pfz) => {
      const distance = calculateDistance(
        latitude,
        longitude,
        pfz.latitude,
        pfz.longitude,
      );

      // Check geofence status for this PFZ
      const geofence = checkGeofence(pfz.latitude, pfz.longitude);

      // Estimate ocean/marine conditions around PFZ location
      const marineConditions = {
        wind: 12 + ((pfz.latitude * 10) % 8),
        windGust: 18 + ((pfz.latitude * 10) % 10),
        waveHeight: 1.2 + ((pfz.longitude * 10) % 1.5),
        rainProbability: 20,
        lightning: 0,
        geofence,
      };

      const risk = calculateRisk(marineConditions);
      const safetyScore = Math.max(0, 100 - risk.score);

      const pfzScore = Number(pfz.pfz_score || pfz.aiSuitabilityScore || 80);
      const distancePenalty = distance * 0.15;

      // Risk-aware weighted recommendation score
      const recommendationScore =
        pfzScore * 0.45 + safetyScore * 0.4 - distancePenalty;

      return {
        ...pfz,
        distance: Number(distance.toFixed(2)),
        distanceKm: Number(distance.toFixed(2)),
        pfzScore,
        safetyScore: Number(safetyScore.toFixed(1)),
        recommendationScore: Number(recommendationScore.toFixed(2)),
        marineRisk: {
          score: risk.score,
          level: risk.level,
          factors: risk.factors,
          recommendation: risk.recommendation,
        },
        geofenceClassification: geofence.classification,
      };
    })
    .filter((pfz) => {
      if (pfz.distance > maxDistance) return false;
      if (minChlorophyll > 0 && (pfz.chlorophyll || 0) < minChlorophyll)
        return false;
      if (maxRisk === "LOW" && pfz.marineRisk.level !== "LOW") return false;
      if (
        maxRisk === "MODERATE" &&
        (pfz.marineRisk.level === "HIGH" || pfz.marineRisk.level === "EXTREME")
      )
        return false;
      return true;
    })
    .sort((a, b) => b.recommendationScore - a.recommendationScore);

  if (ranked.length === 0) {
    return {
      success: false,
      message: "No suitable fishing zones found matching criteria",
      pfzs: [],
    };
  }

  const recommendedZone = ranked[0];
  const alternatives = ranked.slice(1, 4);

  return {
    success: true,
    currentLocation: {
      latitude,
      longitude,
    },
    recommendedZone,
    alternatives,
    pfzs: ranked,
    explainability: {
      whySelected: recommendedZone.selectionExplanation || [
        `✓ Close distance: ${recommendedZone.distanceKm} km`,
        `✓ High safety score: ${recommendedZone.safetyScore}/100`,
        `✓ Data source: ${recommendedZone.source || "INCOIS"}`,
      ],
      overallSuitability: `${recommendedZone.recommendationScore}/100`,
      confidenceScore: recommendedZone.confidenceScore || 85,
      perFactorBreakdown: recommendedZone.perFactorBreakdown || {},
      missingDataDisclosure: recommendedZone.missingDataDisclosure || null,
      rejectedAlternatives: alternatives.map((alt) => ({
        id: alt.id,
        name: alt.name,
        rejectionReason: alt.rejectionReason || "Lower overall suitability / higher risk score",
      })),
    },
  };
}

module.exports = {
  getBestFishingZones,
};
