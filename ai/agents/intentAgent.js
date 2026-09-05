import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { INTENT_SYSTEM_PROMPT } from "../prompts.js";

dotenv.config();

/**
 * Classifies user intent and outputs structured JSON metadata.
 * Supports Multi-Turn Reference & Pronoun Resolution + Telugu Script.
 */
export async function detectIntent(userQuery, context = {}) {
  if (!userQuery || typeof userQuery !== "string" || userQuery.trim() === "") {
    return {
      intent: "GENERAL_QUERY",
      locationRequired: false,
      timeRequired: false,
      destinationRequired: false,
      language: context?.language || "en",
      confidence: 1.0,
      reasoning: "Empty or invalid user query provided.",
    };
  }

  const detectedLang = detectLanguage(userQuery);
  const activeLanguage = detectedLang !== "en" ? detectedLang : (context?.language || "en");
  const query = userQuery.toLowerCase().trim();

  // =====================================================
  // MULTI-TURN CONTEXT-AWARE FOLLOW-UP RESOLUTION
  // =====================================================

  // 1. Ordinal/Closest PFZ follow-up ("which one is closest?", "the second one", "2nd zone")
  if (Array.isArray(context?.pfzList) && context.pfzList.length > 0) {
    if (
      query.includes("closest") ||
      query.includes("nearest") ||
      query.includes("which one is closest") ||
      query.includes("సమీప") ||
      query.includes("మొదటిది")
    ) {
      return {
        intent: "PFZ_SEARCH",
        locationRequired: true,
        timeRequired: false,
        destinationRequired: false,
        language: activeLanguage,
        confidence: 0.99,
        resolvedPFZ: context.pfzList[0],
        reasoning: "Follow-up query requesting closest PFZ from previous result set.",
      };
    }

    if (
      query.includes("second") ||
      query.includes("2nd") ||
      query.includes("రెండోది") ||
      query.includes("రెండవది")
    ) {
      const selected = context.pfzList[1] || context.pfzList[0];
      return {
        intent: "PFZ_SEARCH",
        locationRequired: true,
        timeRequired: false,
        destinationRequired: false,
        language: activeLanguage,
        confidence: 0.99,
        resolvedPFZ: selected,
        reasoning: `Follow-up query requesting 2nd PFZ: ${selected.id || selected.name}.`,
      };
    }
  }

  // 2. Reference to previously selected PFZ ("there", "that zone", "that place", "is it safe tomorrow?")
  if (context?.selectedPFZ || context?.pfzList?.length > 0) {
    const activePFZ = context.selectedPFZ || context.pfzList[0];

    const refersToPFZ =
      query.includes("there") ||
      query.includes("that zone") ||
      query.includes("that place") ||
      query.includes("this zone") ||
      query.includes("is it safe") ||
      query.includes("can i go") ||
      query.includes("tomorrow") ||
      query.includes("ఆ ప్రాంతం") ||
      query.includes("అక్కడ") ||
      query.includes("రేపు") ||
      query.includes("వెళ్లవచ్చా");

    if (refersToPFZ) {
      // Check Route FIRST so "safest route" matches SAFE_ROUTE before general safe check
      if (
        query.includes("route") ||
        query.includes("path") ||
        query.includes("way to") ||
        query.includes("navigation") ||
        query.includes("దోవ") ||
        query.includes("రహదారి") ||
        query.includes("మార్గాలు")
      ) {
        return {
          intent: "SAFE_ROUTE",
          locationRequired: true,
          timeRequired: false,
          destinationRequired: true,
          language: activeLanguage,
          confidence: 0.99,
          resolvedPFZ: activePFZ,
          reasoning: `Multi-turn route follow-up referring to PFZ: ${activePFZ.name || activePFZ.id}.`,
        };
      }

      // Safety follow-up
      if (
        query.includes("safe") ||
        query.includes("risk") ||
        query.includes("danger") ||
        query.includes("can i go") ||
        query.includes("should i go") ||
        query.includes("go fishing") ||
        query.includes("వేటకు వెళ్ళవచ్చా") ||
        query.includes("సురక్షితమేనా") ||
        query.includes("ప్రమాదమా")
      ) {
        return {
          intent: "MARINE_SAFETY",
          locationRequired: true,
          timeRequired: true,
          destinationRequired: false,
          language: activeLanguage,
          confidence: 0.99,
          resolvedPFZ: activePFZ,
          reasoning: `Multi-turn safety follow-up referring to PFZ: ${activePFZ.name || activePFZ.id}.`,
        };
      }

      // Conditions follow-up
      if (
        query.includes("condition") ||
        query.includes("weather") ||
        query.includes("wave") ||
        query.includes("wind") ||
        query.includes("temperature") ||
        query.includes(" sea") ||
        query.includes("వాతావరణం") ||
        query.includes("అలలు")
      ) {
        return {
          intent: "MARINE_CONDITIONS",
          locationRequired: true,
          timeRequired: true,
          destinationRequired: false,
          language: activeLanguage,
          confidence: 0.99,
          resolvedPFZ: activePFZ,
          reasoning: `Multi-turn weather conditions follow-up referring to PFZ: ${activePFZ.name || activePFZ.id}.`,
        };
      }
    }
  }

  // LLM Intent Classification if API key exists
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey && apiKey.trim() !== "" && apiKey !== "your_gemini_api_key_here") {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: process.env.MODEL_NAME || "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" },
      });

      const response = await model.generateContent(
        `${INTENT_SYSTEM_PROMPT}

User Query: "${userQuery}"
Context Language: "${activeLanguage}"`
      );
      const text = response.response.text();
      const parsed = JSON.parse(text);

      if (parsed && parsed.intent) {
        return {
          intent: parsed.intent,
          locationRequired: Boolean(parsed.locationRequired),
          timeRequired: Boolean(parsed.timeRequired),
          destinationRequired: Boolean(parsed.destinationRequired),
          language: parsed.language || activeLanguage,
          confidence: parsed.confidence || 0.95,
          reasoning: parsed.reasoning || "Classified via Gemini LLM",
        };
      }
    } catch (err) {
      console.warn("  [IntentAgent] LLM API call failed. Using deterministic classifier.");
    }
  }

  // Fallback rule-based classifier
  return fallbackDetectIntent(userQuery, activeLanguage);
}

function detectLanguage(text) {
  if (/[\u0C00-\u0C7F]/.test(text)) return "te"; // Telugu
  if (/[\u0900-\u097F]/.test(text)) return "hi"; // Hindi
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta"; // Tamil
  return "en";
}

function fallbackDetectIntent(userQuery, activeLanguage = "en") {
  const query = userQuery.toLowerCase();
  const lang = activeLanguage || detectLanguage(userQuery);

  // 1. HAZARD_ALERT & GEOFENCE_CHECK
  if (
    query.includes("avoid") ||
    query.includes("prohibited") ||
    query.includes("restricted") ||
    query.includes("alert") ||
    query.includes("warning") ||
    query.includes("cyclone") ||
    query.includes("storm") ||
    query.includes("ప్రమాదం") ||
    query.includes("హెచ్చరిక")
  ) {
    return {
      intent: query.includes("avoid") || query.includes("restricted") ? "GEOFENCE_CHECK" : "HAZARD_ALERT",
      locationRequired: true,
      timeRequired: true,
      destinationRequired: false,
      language: lang,
      confidence: 0.97,
      reasoning: "Query asks about restricted zones or weather warnings.",
    };
  }

  // 2. SAFE_ROUTE
  if (
    query.includes("route") ||
    query.includes("path") ||
    query.includes("navigation") ||
    query.includes("way to") ||
    query.includes("దోవ") ||
    query.includes("రహదారి") ||
    query.includes("మార్గాలు")
  ) {
    return {
      intent: "SAFE_ROUTE",
      locationRequired: true,
      timeRequired: false,
      destinationRequired: true,
      language: lang,
      confidence: 0.98,
      reasoning: "Query requests safe route navigation instructions.",
    };
  }

  // 3. PFZ_SEARCH (Includes complex constraint reasoning queries)
  if (
    query.includes("pfz") ||
    query.includes("fishing zone") ||
    query.includes("nearest pfz") ||
    query.includes("productive") ||
    query.includes("chlorophyll") ||
    query.includes("compare") ||
    query.includes("better") ||
    query.includes("safest fishing zone") ||
    query.includes("within") ||
    query.includes("km") ||
    query.includes("near me") ||
    query.includes("where is the nearest") ||
    query.includes("catch fish") ||
    query.includes("చేపల మండలం") ||
    query.includes("చేపలు")
  ) {
    return {
      intent: "PFZ_SEARCH",
      locationRequired: true,
      timeRequired: false,
      destinationRequired: false,
      language: lang,
      confidence: 0.99,
      reasoning: "Query asks for Potential Fishing Zone discovery or comparison.",
    };
  }

  // 4. MARINE_SAFETY
  if (
    query.includes("safe") ||
    query.includes("can i go") ||
    query.includes("should i go") ||
    query.includes("fishing tomorrow") ||
    query.includes("risk") ||
    query.includes("danger") ||
    query.includes("go fishing") ||
    query.includes("వేటకు వెళ్ళవచ్చా") ||
    query.includes("సురక్షితమేనా")
  ) {
    return {
      intent: "MARINE_SAFETY",
      locationRequired: true,
      timeRequired: true,
      destinationRequired: false,
      language: lang,
      confidence: 0.96,
      reasoning: "Query asks about marine safety or fishing trip feasibility.",
    };
  }

  // 5. MARINE_CONDITIONS
  if (
    query.includes("weather") ||
    query.includes("wave") ||
    query.includes("wind") ||
    query.includes("temperature") ||
    query.includes("changed") ||
    query.includes("yesterday") ||
    query.includes("getting worse") ||
    query.includes("trend") ||
    query.includes("వాతావరణం")
  ) {
    return {
      intent: "MARINE_CONDITIONS",
      locationRequired: true,
      timeRequired: false,
      destinationRequired: false,
      language: lang,
      confidence: 0.95,
      reasoning: "Query asks about marine weather conditions or trends.",
    };
  }

  // 6. GEOFENCE_CHECK
  if (
    query.includes("border") ||
    query.includes("geofence") ||
    query.includes("restricted") ||
    query.includes("imbl") ||
    query.includes("హద్దు")
  ) {
    return {
      intent: "GEOFENCE_CHECK",
      locationRequired: true,
      timeRequired: false,
      destinationRequired: false,
      language: lang,
      confidence: 0.96,
      reasoning: "Query asks about boundary limits or restricted zones.",
    };
  }

  // 7. GENERAL_QUERY
  return {
    intent: "GENERAL_QUERY",
    locationRequired: false,
    timeRequired: false,
    destinationRequired: false,
    language: lang,
    confidence: 0.85,
    reasoning: "General query or non-maritime inquiry.",
  };
}
