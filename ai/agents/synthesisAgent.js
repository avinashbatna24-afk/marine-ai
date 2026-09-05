import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYNTHESIS_SYSTEM_PROMPT } from "../prompts.js";

dotenv.config();

/**
 * Marine Safety Override
 *
 * Deterministic safety logic always has priority over
 * an AI-generated optimistic recommendation.
 *
 * Priority:
 * 1. DO_NOT_SAIL hazards / conditions
 * 2. HIGH / EXTREME risk
 * 3. CAUTION hazards / MODERATE-HIGH risk
 * 4. SAFE_TO_SAIL only when no safety hazard requires caution
 */
function applySafetyOverride(recommendation, toolResults = {}) {
  // Unified marine analysis result
  const marine = toolResults.analyzeMarine?.data;

  const weather =
    marine?.weather ??
    toolResults.getWeatherForecast?.data ??
    toolResults.getWeather?.data;

  const ocean =
    marine?.ocean ??
    toolResults.getMarineForecast?.data ??
    toolResults.getOceanConditions?.data;

  const warnings = marine?.warning ?? toolResults.getWarnings?.data;

  const risk =
    marine?.risk ??
    toolResults.calculateRisk?.data?.risk ??
    toolResults.calculateRisk?.data;

  const geofence = marine?.geofence ?? toolResults.checkGeofence?.data;

  // Alerts and hazards from the unified Marine Analyze API
  const hazards = marine?.alerts?.hazards || [];

  // ==================================================
  // HIGHEST PRIORITY: DO NOT SAIL
  // ==================================================

  // Backend safety decision
  if (marine?.safety?.status === "DO_NOT_SAIL") {
    return "DO_NOT_SAIL";
  }

  // Any detected hazard explicitly requiring DO_NOT_SAIL
  if (
    hazards.some(
      (hazard) => hazard.recommendation === "DO_NOT_SAIL"
    )
  ) {
    return "DO_NOT_SAIL";
  }

  // Extreme risk
  if (marine?.safety?.riskLevel === "EXTREME") {
    return "DO_NOT_SAIL";
  }

  // Restricted geofence must never allow safe sailing
  if (marine?.geofence?.insideRestrictedZone === true) {
    return "DO_NOT_SAIL";
  }

  // High IMD warning
  if (marine?.warning?.level === "HIGH") {
    return "DO_NOT_SAIL";
  }

  // Individual tool fallback
  if (warnings?.level === "HIGH") {
    return "DO_NOT_SAIL";
  }

  if (
    warnings?.warning === true &&
    warnings?.level === "HIGH"
  ) {
    return "DO_NOT_SAIL";
  }

  if (risk?.level === "EXTREME") {
    return "DO_NOT_SAIL";
  }

  // ==================================================
  // SECOND PRIORITY: CAUTION
  // ==================================================

  // Unified marine risk
  if (marine?.safety?.riskLevel === "HIGH") {
    return "PROCEED_WITH_CAUTION";
  }

  if (marine?.safety?.riskLevel === "MODERATE") {
    return "PROCEED_WITH_CAUTION";
  }

  // Any detected hazard requiring caution
  if (
    hazards.some(
      (hazard) => hazard.recommendation === "CAUTION"
    )
  ) {
    return "PROCEED_WITH_CAUTION";
  }

  // Individual risk tool fallback
  if (risk?.level === "HIGH") {
    return "PROCEED_WITH_CAUTION";
  }

  if (risk?.level === "MODERATE") {
    return "PROCEED_WITH_CAUTION";
  }

  // ==================================================
  // NO SAFETY OVERRIDE REQUIRED
  // ==================================================

  return recommendation;
}

/**
 * Response & Advisory Synthesis Agent
 */
export async function synthesizeResponse(
  intentResult,
  planResult,
  toolResults,
  userQuery = "",
  context = {},
) {
  const apiKey = process.env.GEMINI_API_KEY;
  const lang = intentResult.language || "en";

  if (
    apiKey &&
    apiKey.trim() !== "" &&
    apiKey !== "your_gemini_api_key_here"
  ) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);

      const model = genAI.getGenerativeModel({
        model:
          process.env.MODEL_NAME ||
          "gemini-2.5-flash",

        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const payload = `${SYNTHESIS_SYSTEM_PROMPT}

IMPORTANT SAFETY RULE:
Official IMD warnings have priority over general environmental conditions.
Never state that it is safe to sail if the IMD warning level is HIGH.
Never ignore a detected DO_NOT_SAIL hazard.
If a detected hazard has recommendation CAUTION, do not return SAFE_TO_SAIL.
Never invent cyclone status, geofence status, distances, route names, or measurements.

PFZ RESPONSE RULES:

- For PFZ_SEARCH queries asking for the nearest PFZ, identify the PFZ with the smallest distanceKm.
- Never call a PFZ "strongest", "best", or "highest scoring" unless a valid numeric pfz_score is actually available and the user asks for the best/strongest PFZ.
- Never display null, undefined, NaN, or missing values to the user.
- If SST, chlorophyll, confidence, or PFZ score is unavailable, say "unavailable" instead.
- Do not invent missing PFZ measurements.
- Clearly distinguish LIVE data from unavailable or fallback data.

User Query: "${userQuery}"
Detected Intent: "${intentResult.intent}"
Detected Language: "${lang}"
Conversation Context: ${JSON.stringify(context)}
Tool Execution Results: ${JSON.stringify(toolResults)}`;

      const response = await model.generateContent(payload);

      const text = response.response.text();
      const parsed = JSON.parse(text);

      if (
        parsed &&
        parsed.answer &&
        parsed.recommendation &&
        parsed.evidence
      ) {
        // Apply deterministic safety override AFTER LLM generation.
        parsed.recommendation = applySafetyOverride(
          parsed.recommendation,
          toolResults,
        );

        // Prevent contradictory natural-language answers.
        parsed.answer = enforceSafetyAnswer(
          parsed.answer,
          parsed.recommendation,
          toolResults,
          lang,
        );

        return parsed;
      }
    } catch (err) {
      console.warn(
        "  [SynthesisAgent] LLM API call failed. Using deterministic synthesizer fallback. Error:",
        err.message,
      );
    }
  }

  return fallbackSynthesizeResponse(
    intentResult,
    planResult,
    toolResults,
    userQuery,
    context,
  );
}

/**
 * Prevent contradictory natural-language answers after
 * the safety override has been applied.
 */
function enforceSafetyAnswer(
  answer,
  recommendation,
  toolResults,
  lang,
) {
  const marine = toolResults.analyzeMarine?.data;

  const warnings =
    marine?.warning ??
    toolResults.getWarnings?.data;

  const hazards =
    marine?.alerts?.hazards || [];

  // ==================================================
  // DO NOT SAIL
  // ==================================================

  if (recommendation === "DO_NOT_SAIL") {
    const doNotSailHazards = hazards
      .filter(
        (hazard) =>
          hazard.recommendation ===
          "DO_NOT_SAIL"
      )
      .map(
        (hazard) =>
          hazard.title
      );

    const hazardText =
      doNotSailHazards.length > 0
        ? doNotSailHazards.join(", ")
        : "high-risk marine conditions";

    if (lang === "te") {
      return `ప్రస్తుతం సముద్రంలోకి వేటకు వెళ్లడం సురక్షితం కాదు. ${
        warnings?.level === "HIGH"
          ? "IMD నుండి HIGH స్థాయి సముద్ర హెచ్చరిక ఉంది."
          : ""
      } గుర్తించిన ప్రమాదాలు: ${hazardText}.`;
    }

    return `Do not venture into the sea at this time. ${
      warnings?.level === "HIGH"
        ? "IMD has issued a HIGH marine warning for the reported area. "
        : ""
    }Detected hazards: ${hazardText}.`;
  }

  // ==================================================
  // CAUTION
  // ==================================================

  if (
    recommendation ===
    "PROCEED_WITH_CAUTION"
  ) {
    const cautionHazards = hazards
      .filter(
        (hazard) =>
          hazard.recommendation ===
          "CAUTION"
      )
      .map(
        (hazard) =>
          hazard.title
      );

    const hazardText =
      cautionHazards.length > 0
        ? cautionHazards.join(", ")
        : "elevated marine conditions";

    if (lang === "te") {
      return `సముద్ర పరిస్థితుల్లో జాగ్రత్త అవసరం. గుర్తించిన పరిస్థితులు: ${hazardText}. సముద్రంలోకి వెళ్లే ముందు తాజా వాతావరణం మరియు అధికారిక హెచ్చరికలను పరిశీలించండి.`;
    }

    return `Proceed only with caution. Detected conditions include: ${hazardText}. Check the latest weather and official marine warnings before entering the sea.`;
  }

  return answer;
}

/**
 * Deterministic fallback synthesizer.
 */
function fallbackSynthesizeResponse(
  intentResult,
  planResult,
  toolResults,
  userQuery,
  context,
) {
  const intent = intentResult.intent;
  const lang = intentResult.language || "en";
  const timestamp =
    new Date().toISOString();

  const sources = new Set();
  const parametersUsed = [];
  const riskFactors = [];

  Object.entries(
    toolResults || {},
  ).forEach(([toolName, res]) => {
    if (res?.source) {
      sources.add(res.source);
    }

    if (res?.data?.source) {
      sources.add(res.data.source);
    }
  });

  const sourceStr =
    sources.size > 0
      ? Array.from(sources).join(" | ")
      : "[DEMO_MOCK] Marine Advisory Engine";

  let recommendation = "INFORMATIONAL";
  let answerText = "";

  // ==================================================
  // PFZ SEARCH
  // ==================================================
  if (intent === "PFZ_SEARCH") {
    /*
     * PFZ_SEARCH can use two different tools:
     *
     * 1. getNearbyPFZ -> finds the nearest PFZ
     * 2. rankPFZs -> finds the best/suitable PFZs using
     *    AI-derived suitability scoring
     */

    const rankedData = toolResults.rankPFZs?.data;
    const nearbyData = toolResults.getNearbyPFZ?.data;

    const rankedPFZs = Array.isArray(rankedData?.pfzs) ? rankedData.pfzs : [];

    const nearbyPFZs = Array.isArray(nearbyData?.pfzs) ? nearbyData.pfzs : [];

    /*
     * Detect whether this is a "best/suitable" request.
     */
    const query = String(userQuery || "").toLowerCase();

    const isBestPFZQuery =
      query.includes("best") ||
      query.includes("highest") ||
      query.includes("suitable") ||
      query.includes("good fishing") ||
      query.includes("productive") ||
      query.includes("మంచి చేపలు") ||
      query.includes("మంచి ఫిషింగ్");

    /*
     * For best PFZ requests, use rankPFZs.
     * Otherwise use getNearbyPFZ.
     */
    const pfzs = isBestPFZQuery ? rankedPFZs : nearbyPFZs;

    /*
     * Explicitly choose the best PFZ according to the
     * AI-derived suitability score.
     */
    const selectedPFZ = isBestPFZQuery
      ? [...pfzs].sort(
          (a, b) =>
            Number(b.aiSuitabilityScore ?? -Infinity) -
            Number(a.aiSuitabilityScore ?? -Infinity),
        )[0]
      : [...pfzs].sort(
          (a, b) =>
            Number(a.distanceKm ?? Infinity) - Number(b.distanceKm ?? Infinity),
        )[0];

    parametersUsed.push("Distance", "Sea Surface Temperature", "Chlorophyll");

    if (isBestPFZQuery) {
      parametersUsed.push("AI Suitability Score");
    }

    recommendation = "INFORMATIONAL";

    if (selectedPFZ) {
      const name = selectedPFZ.name || "Unnamed Potential Fishing Zone";

      const distance = Number.isFinite(Number(selectedPFZ.distanceKm))
        ? `${Number(selectedPFZ.distanceKm).toFixed(2)} km`
        : "distance unavailable";

      const sst =
        selectedPFZ.sst !== null &&
        selectedPFZ.sst !== undefined &&
        Number.isFinite(Number(selectedPFZ.sst))
          ? `${Number(selectedPFZ.sst).toFixed(2)}°C`
          : "unavailable";

      const chlorophyll =
        selectedPFZ.chlorophyll !== null &&
        selectedPFZ.chlorophyll !== undefined &&
        Number.isFinite(Number(selectedPFZ.chlorophyll))
          ? `${Number(selectedPFZ.chlorophyll).toFixed(4)} mg/m³`
          : "unavailable";

      const source =
        selectedPFZ.source || selectedPFZ.category || "PFZ service";

      const sourceStatus = selectedPFZ.sourceStatus || "UNKNOWN";

      /*
       * AI suitability score is our derived score.
       * It must NOT be presented as an official INCOIS score.
       */
      const aiScore =
        selectedPFZ.aiSuitabilityScore !== null &&
        selectedPFZ.aiSuitabilityScore !== undefined &&
        Number.isFinite(Number(selectedPFZ.aiSuitabilityScore))
          ? Number(selectedPFZ.aiSuitabilityScore).toFixed(2)
          : null;

      if (isBestPFZQuery) {
        /*
         * Explain why this PFZ was ranked highly.
         *
         * IMPORTANT:
         * If no AI suitability score exists, we must NOT
         * claim that the PFZ was AI-ranked.
         */
        const reasons = [];

        if (
          selectedPFZ.chlorophyll !== null &&
          selectedPFZ.chlorophyll !== undefined &&
          Number.isFinite(Number(selectedPFZ.chlorophyll))
        ) {
          reasons.push(
            `live chlorophyll ${Number(selectedPFZ.chlorophyll).toFixed(
              4,
            )} mg/m³`,
          );
        }

        if (
          selectedPFZ.sst !== null &&
          selectedPFZ.sst !== undefined &&
          Number.isFinite(Number(selectedPFZ.sst))
        ) {
          const sstValue = Number(selectedPFZ.sst);

          if (sstValue >= 26 && sstValue <= 30) {
            reasons.push(`suitable SST of ${sstValue.toFixed(2)}°C`);
          } else {
            reasons.push(`SST of ${sstValue.toFixed(2)}°C`);
          }
        }

        if (Number.isFinite(Number(selectedPFZ.distanceKm))) {
          reasons.push(
            `distance of ${Number(selectedPFZ.distanceKm).toFixed(2)} km`,
          );
        }

        /*
         * Determine whether an actual AI suitability score
         * was calculated.
         */
        const hasAIScore =
          selectedPFZ.aiSuitabilityScore !== null &&
          selectedPFZ.aiSuitabilityScore !== undefined &&
          Number.isFinite(Number(selectedPFZ.aiSuitabilityScore));

        if (lang === "te") {
          if (hasAIScore) {
            answerText =
              `మీ ప్రస్తుత స్థానానికి అందుబాటులో ఉన్న ఉత్తమ ` +
              `Potential Fishing Zone ${name}. ` +
              `ఇది సుమారు ${distance} దూరంలో ఉంది. ` +
              `AI-derived suitability score ${aiScore}. ` +
              `సముద్ర ఉపరితల ఉష్ణోగ్రత ${sst}, ` +
              `క్లోరోఫిల్ ${chlorophyll}. ` +
              `ర్యాంకింగ్ ఆధారాలు: ${reasons.join(", ")}. ` +
              `డేటా మూలం: ${source}.`;
          } else {
            answerText =
              `మీ ప్రస్తుత స్థానానికి అందుబాటులో ఉన్న ` +
              `సమీపంలోని live Potential Fishing Zone ${name}. ` +
              `ఇది సుమారు ${distance} దూరంలో ఉంది. ` +
              `AI suitability score అందుబాటులో లేదు, ` +
              `ఎందుకంటే అవసరమైన ర్యాంకింగ్ డేటాలో కొన్ని ` +
              `పారామీటర్లు అందుబాటులో లేవు. ` +
              `సముద్ర ఉపరితల ఉష్ణోగ్రత ${sst}, ` +
              `క్లోరోఫిల్ ${chlorophyll}. ` +
              `డేటా మూలం: ${source}.`;
          }
        } else {
          if (hasAIScore) {
            answerText =
              `The best available Potential Fishing Zone is ${name}. ` +
              `It is approximately ${distance} from your current location. ` +
              `Its AI-derived suitability score is ${aiScore}. ` +
              `Sea surface temperature is ${sst}, ` +
              `and chlorophyll concentration is ${chlorophyll}. ` +
              `It was ranked highly using ${reasons.join(", ")}. ` +
              `Data source: ${source}.`;
          } else {
            answerText =
              `The closest available live Potential Fishing Zone is ${name}. ` +
              `It is approximately ${distance} from your current location. ` +
              `An AI suitability score is currently unavailable ` +
              `because some required ranking parameters are unavailable. ` +
              `Sea surface temperature is ${sst}, ` +
              `and chlorophyll concentration is ${chlorophyll}. ` +
              `Available evidence includes ${reasons.join(", ")}. ` +
              `Data source: ${source}.`;
          }
        }
      } else {
        if (lang === "te") {
          answerText =
            `మీ ప్రస్తుత స్థానానికి సమీపంలో ఉన్న Potential Fishing Zone ${name}. ` +
            `ఇది సుమారు ${distance} దూరంలో ఉంది. ` +
            `సముద్ర ఉపరితల ఉష్ణోగ్రత ${sst}, ` +
            `క్లోరోఫిల్ ${chlorophyll}. ` +
            `డేటా మూలం: ${source}.`;
        } else {
          answerText =
            `The nearest available Potential Fishing Zone is ${name}. ` +
            `It is approximately ${distance} from your current location. ` +
            `Sea surface temperature is ${sst}, ` +
            `and chlorophyll concentration is ${chlorophyll}. ` +
            `Data source: ${source}.`;
        }
      }

      /*
       * Evidence / live-data status.
       */
      if (sourceStatus === "LIVE") {
        riskFactors.push("PFZ data sourced from live INCOIS service");
      } else {
        riskFactors.push("PFZ live status unavailable");
      }

      if (selectedPFZ.sstStatus === "LIVE" && selectedPFZ.sstSource) {
        riskFactors.push(`SST sourced from ${selectedPFZ.sstSource}`);
      }

      if (
        selectedPFZ.chlorophyllStatus === "LIVE" &&
        selectedPFZ.chlorophyllSource
      ) {
        riskFactors.push(
          `Chlorophyll sourced from ${selectedPFZ.chlorophyllSource}`,
        );
      }

      if (isBestPFZQuery) {
        const hasAIScore =
          selectedPFZ.aiSuitabilityScore !== null &&
          selectedPFZ.aiSuitabilityScore !== undefined &&
          Number.isFinite(Number(selectedPFZ.aiSuitabilityScore));

        if (hasAIScore) {
          riskFactors.push("PFZ ranking uses AI-derived suitability scoring");
        } else {
          riskFactors.push(
            "AI suitability score unavailable because some ranking parameters were unavailable",
          );
        }
      }
    } else {
      if (lang === "te") {
        answerText = "ప్రస్తుతం అందుబాటులో ఉన్న PFZ సమాచారం లేదు.";
      } else {
        answerText = "No PFZ information is currently available.";
      }

      if (isBestPFZQuery) {
        riskFactors.push("Live PFZ ranking data unavailable");
      } else {
        riskFactors.push("Live PFZ data unavailable");
      }
    }
  }

  // ==================================================
  // MARINE SAFETY
  // ==================================================

  else if (
    intent === "MARINE_SAFETY"
  ) {
    const marine =
      toolResults.analyzeMarine?.data;

    const weather =
      marine?.weather ??
      toolResults.getWeather?.data;

    const ocean =
      marine?.ocean ??
      toolResults.getMarineForecast?.data ??
      toolResults.getOceanConditions?.data;

    const warnings = marine?.warning ?? toolResults.getWarnings?.data;

    const risk = marine?.safety
      ? {
          level:
            marine.safety.riskLevel,
          score:
            marine.safety.riskScore,
          factors:
            marine.safety.factors ||
            [],
        }
      : toolResults.calculateRisk
          ?.data?.risk;

    const geofence =
      marine?.geofence ??
      toolResults.checkGeofence?.data;

    const hazards =
      marine?.alerts?.hazards ||
      [];

    const wind =
      weather?.windSpeed ?? 0;

    const waves =
      ocean?.waveHeight ?? 0;

    const rain =
      weather?.precipitationProbability ??
      0;

    parametersUsed.push(
      `Wind Speed: ${weather?.windSpeed ?? "N/A"} km/h`,
      `Wave Height: ${ocean?.waveHeight ?? "N/A"} m`,
      `Rain Probability: ${weather?.precipitationProbability ?? "N/A"}%`,
    );

    if (risk?.level) {
      parametersUsed.push(
        `Environmental Risk Score: ${risk.score}`,
        `Environmental Risk Level: ${risk.level}`,
      );
    }

    if (warnings?.level) {
      parametersUsed.push(`Official Warning Level: ${warnings.level}`);
    }

    parametersUsed.push("Final Safety Decision: DO_NOT_SAIL");

    if (warnings?.factors?.length) {
      riskFactors.push(
        ...warnings.factors,
      );
    }

    if (risk?.factors?.length) {
      riskFactors.push(
        ...risk.factors,
      );
    }

    // Add detected hazard information
    if (hazards.length > 0) {
      hazards.forEach((hazard) => {
        if (hazard.evidence?.length) {
          riskFactors.push(
            ...hazard.evidence,
          );
        }
      });
    }

    const isForecast =
      marine?.dataMode === "FORECAST" ||
      weather?.status === "FORECAST" ||
      ocean?.status === "FORECAST";

    if (lang === "te") {
      if (recommendation === "DO_NOT_SAIL") {
        answerText = isForecast
          ? `రేపటి సముద్ర పరిస్థితుల అంచనా ఆధారంగా సముద్రంలోకి వెళ్లడం సిఫార్సు చేయబడదు. IMD హెచ్చరిక స్థాయి: ${
              warnings?.level || "HIGH"
            }. అంచనా గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`
          : `ప్రస్తుతం సముద్రంలోకి వేటకు వెళ్లడం సిఫార్సు చేయబడదు. IMD హెచ్చరిక స్థాయి: ${
              warnings?.level || "HIGH"
            }. గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`;
      } else if (recommendation === "PROCEED_WITH_CAUTION") {
        answerText = isForecast
          ? `రేపటి సముద్ర పరిస్థితుల అంచనా ప్రకారం జాగ్రత్తగా వెళ్లాలి. గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`
          : `ప్రస్తుత సముద్ర పరిస్థితుల్లో జాగ్రత్త అవసరం. గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`;
      } else {
        answerText = isForecast
          ? `రేపటి సముద్ర పరిస్థితుల అంచనా ప్రకారం ప్రమాదం తక్కువగా కనిపిస్తోంది. గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`
          : `ప్రస్తుత డేటా ఆధారంగా సముద్ర పరిస్థితులు తక్కువ ప్రమాదంగా కనిపిస్తున్నాయి. గాలి వేగం ${wind} km/h, అలల ఎత్తు ${waves} m, వర్షం సంభావ్యత ${rain}%.`;
      }
    } else {
      const isForecast =
        marine?.dataMode === "FORECAST" ||
        weather?.status === "FORECAST" ||
        ocean?.status === "FORECAST";

      const conditionLabel = isForecast
        ? "Tomorrow's forecast"
        : "Current conditions";

      if (recommendation === "DO_NOT_SAIL") {
        answerText = isForecast
          ? `Do not plan to venture into the sea based on tomorrow's forecast. IMD warning level is ${
              warnings?.level || "HIGH"
            }. Forecast wind speed is ${wind} km/h, wave height is ${waves} m, and precipitation probability is ${rain}%.`
          : `Do not venture into the sea at this time. IMD warning level is ${
              warnings?.level || "HIGH"
            }. Current wind speed is ${wind} km/h, wave height is ${waves} m, and precipitation probability is ${rain}%.`;
      } else if (recommendation === "PROCEED_WITH_CAUTION") {
        answerText = `${conditionLabel} indicate that you should proceed only with caution. Wind speed is ${wind} km/h, wave height is ${waves} m, and precipitation probability is ${rain}%.`;
      } else {
        answerText = `${conditionLabel} appear relatively low risk based on the available data. Wind speed is ${wind} km/h, wave height is ${waves} m, and precipitation probability is ${rain}%.`;
      }
    }
  }

  // ==================================================
  // SAFE ROUTE
  // ==================================================

  else if (
    intent === "SAFE_ROUTE"
  ) {
    const route =
      toolResults.findSafeRoute?.data;

    const warnings =
      route?.marineWarning;

    const risk = route?.risk;

    parametersUsed.push(
      "A* Route Optimization",
      "Marine Risk",
      "Restricted Cells",
      "Hazard Avoidance",
    );

    recommendation =
      "NAVIGATION_ADVISORY";

    if (
      warnings?.level === "HIGH"
    ) {
      recommendation =
        "DO_NOT_SAIL";
    }

    if (risk?.factors) {
      riskFactors.push(
        ...risk.factors,
      );
    }

    if (
      route?.avoidedHazards?.length
    ) {
      riskFactors.push(
        `Avoided hazards: ${route.avoidedHazards.length}`,
      );
    }

    const distance =
      route?.distance ??
      "unavailable";

    if (lang === "te") {
      answerText =
        recommendation ===
        "DO_NOT_SAIL"
          ? `IMD నుండి HIGH స్థాయి హెచ్చరిక ఉన్నందున మార్గం లెక్కించినప్పటికీ ప్రస్తుతం సముద్రంలోకి వెళ్లడం సిఫార్సు చేయబడదు. లెక్కించిన మార్గ దూరం ${distance}.`
          : `ప్రమాద కణాలను తప్పించుకునే సురక్షిత మార్గం లెక్కించబడింది. మార్గ దూరం ${distance}.`;
    } else {
      answerText =
        recommendation ===
        "DO_NOT_SAIL"
          ? `A route was calculated, but an IMD HIGH warning is active. Do not venture into the sea at this time. Calculated route distance: ${distance}.`
          : `A risk-aware route was calculated while avoiding restricted and high-risk cells. Calculated route distance: ${distance}.`;
    }
  }

  // ==================================================
  // MARINE CONDITIONS
  // ==================================================

  else if (
    intent ===
    "MARINE_CONDITIONS"
  ) {
    const weather =
      toolResults.getWeather?.data;

    const ocean =
      toolResults.getOceanConditions?.data;

    const warnings =
      toolResults.getWarnings?.data;

    recommendation =
      "INFORMATIONAL";

    parametersUsed.push(
      "Wind Speed",
      "Wave Height",
      "Sea Surface Temperature",
      "Wave Period",
    );

    if (
      warnings?.level === "HIGH"
    ) {
      riskFactors.push(
        ...(warnings.factors || []),
      );
    }

    if (lang === "te") {
      answerText = `రేపటి అంచనా సముద్ర పరిస్థితులు: గాలి వేగం ${weather?.windSpeed ?? "N/A"} km/h, అలల ఎత్తు ${ocean?.waveHeight ?? "N/A"} m, అలల వ్యవధి ${ocean?.wavePeriod ?? "N/A"} s, సముద్ర ఉపరితల ఉష్ణోగ్రత ${ocean?.sst ?? "N/A"}°C.`;
    } else {
      answerText = `Tomorrow's forecasted sea conditions: wind speed ${weather?.windSpeed ?? "N/A"} km/h, wave height ${ocean?.waveHeight ?? "N/A"} m, wave period ${ocean?.wavePeriod ?? "N/A"} s, and sea surface temperature ${ocean?.sst ?? "N/A"}°C.`;
    }
  }

  // ==================================================
  // HAZARD ALERT
  // ==================================================

  else if (
    intent === "HAZARD_ALERT"
  ) {
    const marine =
      toolResults.analyzeMarine?.data;

    const warnings =
      marine?.warning ??
      toolResults.getWarnings?.data;

    const risk =
      marine?.safety
        ? {
            level:
              marine.safety.riskLevel,
            factors:
              marine.safety.factors ||
              [],
          }
        : toolResults.calculateRisk
            ?.data?.risk;

    const hazards =
      marine?.alerts?.hazards ||
      [];

    parametersUsed.push(
      "IMD Warning",
      "Risk Level",
      "Lightning Warning",
      "Strong Wind Warning",
      "Squall Warning",
    );

    if (
      warnings?.level === "HIGH"
    ) {
      recommendation =
        "DO_NOT_SAIL";

      riskFactors.push(
        ...(warnings.factors || []),
      );
    } else if (
      hazards.some(
        (hazard) =>
          hazard.recommendation ===
          "DO_NOT_SAIL",
      )
    ) {
      recommendation =
        "DO_NOT_SAIL";
    } else if (
      risk?.level === "HIGH" ||
      risk?.level === "EXTREME"
    ) {
      recommendation =
        "DO_NOT_SAIL";

      riskFactors.push(
        ...(risk.factors || []),
      );
    } else if (
      hazards.some(
        (hazard) =>
          hazard.recommendation ===
          "CAUTION",
      ) ||
      risk?.level === "MODERATE"
    ) {
      recommendation =
        "PROCEED_WITH_CAUTION";
    } else {
      recommendation =
        "INFORMATIONAL";
    }

    if (lang === "te") {
      answerText = `ప్రమాద హెచ్చరిక స్థాయి: ${
        warnings?.level ||
        "UNKNOWN"
      }. ${
        warnings?.warning
          ? "IMD హెచ్చరికలు సక్రియంగా ఉన్నాయి."
          : "ప్రస్తుతం గుర్తించిన IMD హెచ్చరిక లేదు."
      }`;
    } else {
      answerText = `Marine hazard status: ${
        warnings?.level ||
        "UNKNOWN"
      }. ${
        warnings?.warning
          ? "Active IMD warnings are present."
          : "No active IMD warning was detected by the current parser."
      }`;
    }
  }

  // ==================================================
  // GEOFENCE
  // ==================================================

  else if (
    intent ===
    "GEOFENCE_CHECK"
  ) {
    const geofence =
      toolResults.checkGeofence?.data;

    parametersUsed.push(
      "IMBL Proximity",
      "Restricted Zones",
      "Protected Zones",
      "Geofence Status",
    );

    // Geofence service unavailable
    if (
      !geofence ||
      geofence.status ===
        "NOT_CHECKED"
    ) {
      recommendation =
        "NAVIGATION_ADVISORY";

      answerText =
        lang === "te"
          ? "జియోఫెన్స్ తనిఖీ ప్రస్తుతం అందుబాటులో లేదు. కాబట్టి ప్రదేశం సురక్షితం అని నిర్ధారించలేము."
          : "The geofence check is currently unavailable. The vessel location cannot be confirmed as outside restricted or protected zones.";

      riskFactors.push(
        "Geofence status unavailable",
      );
    }

    // Vessel is inside one or more zones
    else if (
      geofence.insideRestrictedZone ===
        true &&
      geofence.zonesInside?.length >
        0
    ) {
      const zones =
        geofence.zonesInside;

      const zoneNames = zones
        .map(
          (zone) =>
            `${zone.name} (${zone.severity})`,
        )
        .join(", ");

      const hasCriticalZone =
        zones.some(
          (zone) =>
            zone.severity ===
            "CRITICAL",
        );

      recommendation =
        hasCriticalZone
          ? "DO_NOT_ENTER"
          : "NAVIGATION_ADVISORY";

      riskFactors.push(
        ...zones.map(
          (zone) =>
            `Inside ${zone.type}: ${zone.name} (${zone.severity})`,
        ),
      );

      if (lang === "te") {
        answerText =
          hasCriticalZone
            ? `⚠️ జియోఫెన్స్ హెచ్చరిక: ప్రస్తుత స్థానం ${zoneNames} ప్రాంతంలో ఉంది. ఇది పరిమిత ప్రాంతం. అనుమతి లేకుండా ఈ ప్రాంతంలోకి ప్రవేశించవద్దు.`
            : `⚠️ జియోఫెన్స్ హెచ్చరిక: ప్రస్తుత స్థానం ${zoneNames} ప్రాంతంలో ఉంది. ఇది రక్షిత లేదా పరిమిత ప్రాంతం. అనుమతి లేకుండా ఇక్కడ కార్యకలాపాలు నిర్వహించవద్దు.`;
      } else {
        answerText =
          hasCriticalZone
            ? `⚠️ Geofence alert: the current vessel location is inside ${zoneNames}. This is a restricted area. Do not enter without appropriate authorization.`
            : `⚠️ Geofence alert: the current vessel location is inside ${zoneNames}. This is a protected or restricted area. Avoid operating in this zone unless legally authorized.`;
      }
    }

    // Vessel is outside zones but close to one
    else if (
      geofence.nearestZone
    ) {
      const nearest =
        geofence.nearestZone;

      if (
        geofence.status ===
        "CAUTION"
      ) {
        recommendation =
          "NAVIGATION_ADVISORY";

        riskFactors.push(
          `Near ${nearest.name}`,
          `Distance: ${nearest.distanceKm} km`,
        );

        if (lang === "te") {
          answerText =
            `⚠️ జాగ్రత్త: సమీప జియోఫెన్స్ ప్రాంతం ${nearest.name}. దూరం సుమారు ${nearest.distanceKm} కి.మీ. ఈ ప్రాంతానికి దగ్గరగా ప్రయాణించేటప్పుడు జాగ్రత్త వహించండి.`;
        } else {
          answerText =
            `⚠️ Geofence caution: the nearest monitored zone is ${nearest.name}, approximately ${nearest.distanceKm} km away. Maintain caution while operating near this zone.`;
        }
      } else {
        recommendation =
          "INFORMATIONAL";

        if (lang === "te") {
          answerText =
            `జియోఫెన్స్ స్థితి CLEAR. సమీపంలోని పర్యవేక్షించబడిన ప్రాంతం ${nearest.name}, దూరం సుమారు ${nearest.distanceKm} కి.మీ.`;
        } else {
          answerText =
            `Geofence status is CLEAR. The nearest monitored zone is ${nearest.name}, approximately ${nearest.distanceKm} km away.`;
        }
      }
    }

    // No monitored zone information
    else {
      recommendation =
        "INFORMATIONAL";

      if (lang === "te") {
        answerText =
          "ప్రస్తుత స్థానానికి సమీపంలో పర్యవేక్షించబడిన పరిమిత లేదా రక్షిత జియోఫెన్స్ ప్రాంతం గుర్తించబడలేదు.";
      } else {
        answerText =
          "No monitored restricted or protected geofence was detected near the current vessel location.";
      }
    }
  }

  // ==================================================
  // GENERAL QUERY
  // ==================================================

  else {
    recommendation =
      "INFORMATIONAL";

    parametersUsed.push(
      "General Inquiry",
    );

    riskFactors.push("None");

    answerText =
      lang === "te"
        ? "నమస్కారం! నేను Marine Advisory AI. PFZ ప్రాంతాలు, సముద్ర పరిస్థితులు, భద్రతా ప్రమాదాలు, సురక్షిత మార్గాలు మరియు సముద్ర హెచ్చరికలను పరిశీలించడంలో సహాయపడగలను."
        : "Hello! I am your Marine Advisory AI. I can help you find Potential Fishing Zones, evaluate sea conditions and safety, generate risk-aware routes, and check marine warnings.";
  }

  // ==================================================
  // FINAL DETERMINISTIC SAFETY OVERRIDE
  // ==================================================

  recommendation =
    applySafetyOverride(
      recommendation,
      toolResults,
    );

  // Make sure the answer cannot contradict
  // the final safety recommendation.
  answerText =
    enforceSafetyAnswer(
      answerText,
      recommendation,
      toolResults,
      lang,
    );

  // Extract rich Phase 8 explainability objects from tool results
  const marine = toolResults.analyzeMarine?.data;
  const pfzTool = toolResults.getNearbyPFZ?.data;
  const routeTool = toolResults.findSafeRoute?.data;
  const riskTool = toolResults.calculateRisk?.data;

  const topPFZ = marine?.pfz?.recommendedZone || (Array.isArray(pfzTool?.zones) ? pfzTool.zones[0] : null);
  const confidenceScore = marine?.confidenceScore || topPFZ?.confidenceScore || 85;

  const whyPFZSelected = topPFZ?.selectionExplanation || (topPFZ ? [
    `✓ Close distance: ${topPFZ.distanceKm || topPFZ.distance || "N/A"} km`,
    `✓ Chlorophyll: ${topPFZ.chlorophyll ? `${topPFZ.chlorophyll} mg/m³` : "N/A"}`,
    `✓ SST: ${topPFZ.sst ? `${topPFZ.sst}°C` : "N/A"}`,
    `✓ Data source: ${topPFZ.source || "INCOIS PFZ Dataset"}`
  ] : []);

  const rejectedAlternatives = marine?.explainability?.pfzSelection?.rejectedAlternatives || [];

  const whyAlertTriggered = (marine?.alerts?.hazards || []).map((h) => ({
    id: h.id,
    title: h.title,
    triggerExplanation: h.triggerExplanation || `Triggered: ${h.title}`,
  }));

  const whyRouteSelected = routeTool?.routeExplanation?.whySelected || (routeTool?.explanation ? [routeTool.explanation] : []);

  const explainabilityObj = {
    confidenceScore,
    overallSuitability: topPFZ ? `${topPFZ.aiSuitabilityScore || 85}/100` : null,
    whyPFZSelected,
    rejectedAlternatives,
    perFactorBreakdown: topPFZ?.perFactorBreakdown || marine?.safety?.perFactorBreakdown || {},
    whyRouteSelected,
    whyAlertTriggered,
    missingDataDisclosure: topPFZ?.missingDataDisclosure || marine?.dataQuality?.missingDataDisclosures?.[0] || null,
  };

  return {
    answer: answerText,
    recommendation,
    evidence: {
      source: sourceStr,
      timestamp,
      parametersUsed,
      riskFactors,
      confidenceScore,
      explainability: explainabilityObj,
    },
  };
}