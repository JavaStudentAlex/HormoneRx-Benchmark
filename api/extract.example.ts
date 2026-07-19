/**
 * EXAMPLE server-side / serverless extraction endpoint for LIVE mode.
 * Rename to api/extract.ts and deploy on a platform that runs server functions
 * (e.g. Vercel). This file is NOT bundled into the browser build.
 *
 * SAFETY: this endpoint performs the ONLY model call in the system and must return an
 * ExtractionResult and nothing else. The model must never produce interactions,
 * consequences, citations, severity, or advice. Secrets are read only from env vars.
 */
import type { ExtractionResult } from '../src/lib/types';

// The system prompt boxes the model into structured extraction only.
const SYSTEM_PROMPT = `You extract structured context from a clinical consultation snippet.
Return ONLY JSON matching this TypeScript type and nothing else:

{
  "hormonalProduct": { "raw": string|null, "normalized": string|null, "status": "current"|"historical"|"planned"|"negated"|"uncertain"|"other_person"|null, "sourceSpan": string|null },
  "otherMedication": { "raw": string|null, "normalized": string|null, "status": "current"|"historical"|"planned"|"negated"|"uncertain"|"other_person"|null, "sourceSpan": string|null },
  "missingInformation": string[],
  "shouldSearchEvidence": boolean,
  "reason": string
}

Rules:
- Extract only: hormonal product, other medication, normalized names, status, explicitly stated dose/route, missing information, and whether a lookup should run.
- NEVER output interactions, consequences, mechanisms, evidence levels, citations, severity, or treatment/dosing advice.
- Mark negated, historical, planned, uncertain, or another person's medication with the appropriate status.
- Set shouldSearchEvidence true only when a hormonal product AND a current interacting medication are present.`;

export async function POST(request: Request): Promise<Response> {
  const { text } = (await request.json()) as { text?: string };
  if (!text || typeof text !== 'string') {
    return new Response(JSON.stringify({ error: 'text is required' }), { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'server not configured for live mode' }), { status: 503 });
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'model call failed' }), { status: 502 });
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: ExtractionResult;
  try {
    parsed = JSON.parse(content) as ExtractionResult;
  } catch {
    return new Response(JSON.stringify({ error: 'model returned invalid JSON' }), { status: 502 });
  }

  // Defensive: strip any unexpected keys so no non-extraction content can leak through.
  const safe: ExtractionResult = {
    hormonalProduct: parsed.hormonalProduct,
    otherMedication: parsed.otherMedication,
    missingInformation: Array.isArray(parsed.missingInformation) ? parsed.missingInformation : [],
    shouldSearchEvidence: Boolean(parsed.shouldSearchEvidence),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };

  return new Response(JSON.stringify(safe), { headers: { 'Content-Type': 'application/json' } });
}
