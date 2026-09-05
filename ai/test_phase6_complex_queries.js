import { processQuery } from "./orchestrator.js";
import { detectIntent } from "./agents/intentAgent.js";
import { createPlan } from "./agents/plannerAgent.js";

async function runPhase6Tests() {
  console.log("====================================================");
  console.log("🧪 RUNNING PHASE 6 AGENTIC AI & COMPLEX QUERIES TESTS");
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

  const testQueries = [
    { query: "What is the safest fishing zone?", expectedIntent: "PFZ_SEARCH" },
    { query: "Find the most productive zone near me.", expectedIntent: "PFZ_SEARCH" },
    { query: "Which PFZ has the highest chlorophyll?", expectedIntent: "PFZ_SEARCH" },
    { query: "Is it safe to fish tomorrow?", expectedIntent: "MARINE_SAFETY" },
    { query: "Which zone should I avoid?", expectedIntent: "HAZARD_ALERT" },
    { query: "Find the safest route to the best PFZ.", expectedIntent: "SAFE_ROUTE" },
    { query: "Why is this PFZ better?", expectedIntent: "PFZ_SEARCH" },
    { query: "Compare these three PFZs.", expectedIntent: "PFZ_SEARCH" },
    { query: "What changed since yesterday?", expectedIntent: "MARINE_CONDITIONS" },
    { query: "Is the weather getting worse?", expectedIntent: "MARINE_SAFETY" },
    { query: "Find PFZs that are productive and safe.", expectedIntent: "PFZ_SEARCH" },
    { query: "Find a PFZ within 50 km.", expectedIntent: "PFZ_SEARCH" },
    { query: "Find a productive PFZ within 100 km with low risk.", expectedIntent: "PFZ_SEARCH" }
  ];

  console.log("🔍 1. Intent Agent & Planner DAG Decomposition Tests:");
  for (const t of testQueries) {
    const intentRes = await detectIntent(t.query, {});
    const planRes = await createPlan(intentRes, t.query);

    assert(intentRes.intent !== undefined && planRes.tasks.length > 0,
      `Decomposed query: "${t.query}" -> Intent: ${intentRes.intent} -> Tasks: [${planRes.tasks.join(", ")}]`
    );
  }

  console.log("\n⚡ 2. End-to-End Orchestrated Pipeline & Synthesis Execution Tests:");

  // Test Multi-tool DAG Execution for Query 13 (Constraint Reasoning)
  const q13 = "Find a productive PFZ within 100 km with low risk.";
  const res13 = await processQuery(q13, { executeTools: true, verbose: false });

  assert(res13.tasks !== undefined && res13.tasks.length >= 1, `Executed multi-tool DAG task sequence: [${res13.tasks?.join(", ")}]`);
  assert(typeof res13.answer === "string" && res13.answer.length > 20, "Synthesized evidence-based response");

  // Test Telugu Language Response Synthesis for Complex Query
  const qTe = "రేపు చేపలు పట్టడం సురక్షితమేనా మరియు దగ్గరలో మంచి జోన్ ఏది?";
  const resTe = await processQuery(qTe, { executeTools: true, verbose: false }, { language: "te" });

  assert(resTe.language === "te", "Detected Telugu language context");
  console.log("[DEBUG resTe.answer]:", resTe.answer);
  assert(typeof resTe.answer === "string" && (resTe.answer || "").length > 0, "Generated Telugu evidence response");

  console.log("\n====================================================");
  console.log(`📊 PHASE 6 TEST RESULTS: ${passed}/${total} PASSED (${Math.round((passed/total)*100)}%)`);
  console.log("====================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runPhase6Tests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
