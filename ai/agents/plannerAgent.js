import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PLANNER_SYSTEM_PROMPT } from "../prompts.js";
import { AVAILABLE_TOOLS } from "../tools.js";

dotenv.config();

/**
 * Converts Intent into a sequence of tool tasks.
 *
 * Returns structured JSON:
 * {
 *   intent: string,
 *   tasks: string[],
 *   reasoning?: string
 * }
 */
export async function createPlan(intentResult, userQuery = "") {
  const intent =
    typeof intentResult === "string" ? intentResult : intentResult.intent;

  const apiKey = process.env.GEMINI_API_KEY;

  /*
   * Try Gemini planner first when API key is available.
   */
  if (apiKey && apiKey.trim() !== "" && apiKey !== "your_gemini_api_key_here") {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);

      const model = genAI.getGenerativeModel({
        model: process.env.MODEL_NAME || "gemini-2.5-flash",
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const promptPayload = `${PLANNER_SYSTEM_PROMPT}

Intent: "${intent}"

User Query: "${userQuery}"

Available Tools: ${JSON.stringify(AVAILABLE_TOOLS)}
`;

      const response = await model.generateContent(promptPayload);

      const text = response.response.text();
      const parsed = JSON.parse(text);

      if (parsed && Array.isArray(parsed.tasks)) {
        // Validate all returned tasks are valid tools
        const validTasks = parsed.tasks.filter((task) =>
          AVAILABLE_TOOLS.includes(task),
        );

        return {
          intent: intent,
          tasks: validTasks,
          reasoning: parsed.reasoning || "Generated task plan via Gemini LLM",
        };
      }
    } catch (err) {
      console.warn(
        "[PlannerAgent] LLM API call failed or key invalid. Switching to deterministic planner. Error:",
        err.message,
      );
    }
  }

  /*
   * Deterministic Planner Mapping
   */
  return fallbackCreatePlan(intent, userQuery);
}

/**
 * Deterministic mapping rule table for intent -> tool task sequence.
 *
 * PFZ_SEARCH:
 * - "nearest fishing zone" -> getNearbyPFZ
 * - "best fishing zones" -> rankPFZs
 *
 * MARINE_CONDITIONS:
 * - Current queries -> live weather/ocean APIs
 * - Tomorrow/రేపు queries -> forecast APIs
 * - IMD warnings are also retrieved.
 */
function fallbackCreatePlan(intent, userQuery) {
  const query = String(userQuery || "").toLowerCase();

  const isTomorrow = query.includes("tomorrow") || query.includes("రేపు");

  let tasks = [];

  if (query.includes("compare") || query.includes("why is this pfz better")) {
    tasks = ["comparePFZs"];
  } else if (query.includes("chlorophyll")) {
    tasks = ["getChlorophyllRanking"];
  } else if (query.includes("within") || query.includes("100 km") || query.includes("50 km") || (query.includes("productive") && query.includes("risk"))) {
    tasks = ["evaluateConstraintPFZ"];
  } else if (query.includes("route") && (query.includes("safest") || query.includes("best pfz"))) {
    tasks = ["getNearbyPFZ", "findOptimizedSafeRoute"];
  } else if (intent === "PFZ_SEARCH") {
    tasks = query.includes("best") || query.includes("suitable") || query.includes("productive")
      ? ["rankPFZs"]
      : ["getNearbyPFZ"];
  } else if (intent === "MARINE_SAFETY") {
    tasks = isTomorrow
      ? ["getWeatherForecast", "getMarineForecast", "getWarnings", "calculateRisk"]
      : ["getWeather", "getOceanConditions", "getWarnings", "calculateRisk"];
  } else if (intent === "SAFE_ROUTE") {
    tasks = ["getNearbyPFZ", "getRiskMap", "checkGeofence", "findSafeRoute"];
  } else if (intent === "MARINE_CONDITIONS") {
    tasks = isTomorrow
      ? ["getWeatherForecast", "getMarineForecast", "getWarnings"]
      : ["getWeather", "getOceanConditions", "getWarnings"];
  } else if (intent === "GEOFENCE_CHECK") {
    tasks = ["checkGeofence"];
  } else if (intent === "HAZARD_ALERT") {
    tasks = ["getWarnings", "calculateRisk"];
  } else {
    tasks = ["getNearbyPFZ"];
  }

  return {
    intent: intent,
    tasks: tasks,
    reasoning: `Mapped intent '${intent}' to ${
      isTomorrow ? "forecast" : "current"
    } execution sequence: [${tasks.join(", ")}]`,
  };
}
