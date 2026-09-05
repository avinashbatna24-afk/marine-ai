const { planMarineRoute } = require("../../services/marineRouteService");
const { findOptimizedSafeRoute } = require("../../services/routeOptimizationService");

function planRoute(req, res) {
  try {
    const {
      rows = 5,
      cols = 5,
      start,
      goal,
      marineConditions,
      hazardCells = [],
      restrictedCells = [],
    } = req.body;

    if (!start || !goal) {
      return res.status(400).json({
        success: false,
        message: "Start and goal are required",
      });
    }

    if (!marineConditions) {
      return res.status(400).json({
        success: false,
        message: "Marine conditions are required",
      });
    }

    const result = planMarineRoute({
      rows,
      cols,
      start,
      goal,
      marineConditions,
      hazardCells,
      restrictedCells,
    });

    return res.json(result);
  } catch (error) {
    console.error("Marine route controller error:", error);

    return res.status(500).json({
      success: false,
      message: "Marine route planning failed",
      error: error.message,
    });
  }
}

async function optimizeSafeRoute(req, res) {
  try {
    const { origin, destination, vesselSpeedKnots, marineConditions } = req.body;

    const result = await findOptimizedSafeRoute({
      origin,
      destination,
      vesselSpeedKnots,
      marineConditions,
    });

    return res.json(result);
  } catch (error) {
    console.error("Optimize safe route controller error:", error);

    return res.status(500).json({
      success: false,
      message: "Safe route optimization failed",
      error: error.message,
    });
  }
}

module.exports = {
  planRoute,
  optimizeSafeRoute,
};
