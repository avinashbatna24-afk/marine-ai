const express = require("express");
const { planRoute, optimizeSafeRoute } = require("../src/controllers/marineRouteController");

const router = express.Router();

router.post("/marine", planRoute);
router.post("/optimize", optimizeSafeRoute);

module.exports = router;
