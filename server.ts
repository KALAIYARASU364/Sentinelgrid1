import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { INITIAL_SYSTEM_DATA, computeZoneRisk, SIMULATED_START_TIME } from './src/riskEngine';
import { SystemData } from './src/types';

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory state store for the plant simulation
let currentSystemData: SystemData = JSON.parse(JSON.stringify(INITIAL_SYSTEM_DATA));
let currentSimulatedTime: string = SIMULATED_START_TIME;

// Lazy-loaded Gemini AI client to prevent crash on startup if key is missing
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY environment variable is not set. Please add it in Settings > Secrets.");
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// API Routes

// 1. GET Current state of plant and calculated risk scores
app.get('/api/state', (req, res) => {
  try {
    const calculatedRisks = currentSystemData.zones.map(zone => {
      return computeZoneRisk(zone, currentSystemData, currentSimulatedTime);
    });

    res.json({
      system_data: currentSystemData,
      simulated_time: currentSimulatedTime,
      risks: calculatedRisks
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to retrieve state' });
  }
});

// 2. POST Update state (e.g. adjust readings, toggle permits)
app.post('/api/state', (req, res) => {
  try {
    const { system_data, simulated_time } = req.body;
    if (system_data) {
      currentSystemData = system_data;
    }
    if (simulated_time) {
      currentSimulatedTime = simulated_time;
    }

    const calculatedRisks = currentSystemData.zones.map(zone => {
      return computeZoneRisk(zone, currentSystemData, currentSimulatedTime);
    });

    res.json({
      system_data: currentSystemData,
      simulated_time: currentSimulatedTime,
      risks: calculatedRisks
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update state' });
  }
});

// 3. POST Trigger AI safety audit
app.post('/api/audit', async (req, res) => {
  try {
    const { zone_id, zone_data, risk_data, system_data_snapshot } = req.body;

    if (!zone_id) {
      return res.status(400).json({ error: 'zone_id is required' });
    }

    // Attempt to instantiate Gemini client
    let ai;
    try {
      ai = getGeminiClient();
    } catch (e: any) {
      return res.status(400).json({
        error: "Gemini Key Missing",
        details: e.message
      });
    }

    const prompt = `
You are SentinelGrid, an expert AI safety auditor certified under OISD, OSHA, and Indian Factory Act safety standards.
Analyze the following industrial plant hazard data for Zone: "${zone_data.name}" (ID: ${zone_id}).

CONCURRENT RISK MATRIX FOR ZONE:
- Risk Score: ${risk_data.risk_score} / 100
- Hazard Classification: ${zone_data.hazard_class}
- Process Pressure: ${zone_data.process_pressure_psi} PSI
- Process Temperature: ${zone_data.process_temp_celsius}°C
- Active Permits: ${JSON.stringify(system_data_snapshot.permits.filter((p: any) => p.zone_id === zone_id && p.status === 'Active'))}
- Gas Sensors in Zone: ${JSON.stringify(system_data_snapshot.gas_sensors.filter((s: any) => s.zone_id === zone_id))}
- Active Maintenance: ${JSON.stringify(system_data_snapshot.maintenance.filter((m: any) => m.zone_id === zone_id))}
- Personnel Present in Zone: ${system_data_snapshot.worker_location.filter((w: any) => w.zone_id === zone_id).length} workers + maintenance crew

Matched Co-occurrence Rules:
${JSON.stringify(risk_data.rule_matches)}

Computed Contributing Factors:
${JSON.stringify(risk_data.contributing_factors)}

Local Recommended Actions:
- "${risk_data.recommended_action}"

Cited Regulation:
- "${risk_data.regulatory_reference}"

Task:
Generate a comprehensive, formal, and structured Industrial Safety Audit Report in beautiful markdown.
Do not use generic warnings. Address the precise co-occurrence of independent parameters that formed this risk score.

Please use the following outline format:
# SENTINELGRID ADVANCED RISK ASSESSMENT REPORT
**Zone Identifier:** ${zone_data.name} [ID: ${zone_id}]
**Safety Security Score:** ${100 - risk_data.risk_score}% / Risk Index: ${risk_data.risk_score}%

### 1. DETAILED CO-OCCURRENCE HAZARD DIAGNOSTIC
Provide a deep technical explanation of how these independent data streams (sensors, active permit types, maintenance task categories, worker locations, and shift handover timelines) co-occurred to form this specific risk. Discuss why isolated sensors failed to trigger warnings, but combined they present high risk.

### 2. LEAD-TIME ESTIMATION & ESCALATION PATHWAY
Define the estimated lead-time (${risk_data.lead_time_estimate}) and detail a logical chronological progression of what could happen if work continues unchecked (e.g., ignition, physical rupture, toxic gas inhalation).

### 3. STATUTORY COMPLIANCE & AUDIT TRAIL
Reference the cited standard: "${risk_data.regulatory_reference}". Explain the exact legal duties, the penalties for non-compliance, and the audit trail requirements for safety officers under this regulatory framework. Cite any specific OISD, OSHA, or Factory Act rules that are violated by this co-occurrence.

### 4. MULTI-BARRIER MITIGATION & ACTION PLAN
Provide a 3-step actionable strategy:
1. Immediate isolation/stabilization action (0-5 minutes).
2. Procedural correction/permit re-verification action (5-30 minutes).
3. Long-term administrative/engineering barrier recommendation.

Ensure the tone is objective, technical, and urgent. Do not include introductory or congratulatory remarks, start directly with the title.
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    res.json({
      audit_report: response.text,
      model: 'gemini-3.5-flash'
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to generate audit report' });
  }
});

// Vite Middleware & Static Serving Integration

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SentinelGrid custom Express server listening on http://localhost:${PORT}`);
  });
}

startServer();
