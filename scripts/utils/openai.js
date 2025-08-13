import 'dotenv/config';
import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('[OpenAI] Missing OPENAI_API_KEY in environment.');
}

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

export const openai = new OpenAI({ apiKey });

const FALLBACK_MODELS = [
  OPENAI_MODEL,
  'gpt-4o',
  'gpt-4.1',
  'gpt-4o-mini',
];

export async function generateJSON({ system, user, schema }) {
  // Use Chat Completions with JSON mode for stable JSON outputs.
  let lastError = null;
  for (const model of FALLBACK_MODELS) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });
      const content = response.choices?.[0]?.message?.content || '{}';
      try {
        const parsed = JSON.parse(content);
        return parsed;
      } catch (e) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          return JSON.parse(match[0]);
        }
        throw e;
      }
    } catch (e) {
      lastError = e;
      // try next model on invalid_model or not found
      if (String(e?.message || '').toLowerCase().includes('invalid') || String(e?.message || '').toLowerCase().includes('not found')) {
        console.warn(`[OpenAI] Model ${model} failed, trying fallback...`);
        continue;
      }
      // For rate limits/transient errors, also try next
      if (String(e?.message || '').toLowerCase().includes('rate') || String(e?.message || '').toLowerCase().includes('tempor')) {
        console.warn(`[OpenAI] Transient error with ${model}, trying fallback...`);
        continue;
      }
      // Otherwise break early
      break;
    }
  }
  throw lastError || new Error('Failed to generate JSON from model');
}
