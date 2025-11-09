// api/replyv2.js
// Mini passerelle Chatfuel → OpenAI Responses API (assistants v2)
// Requis en variables d'env : OPENAI_API_KEY, OPENAI_MODEL
// Optionnel : DEBUG_LOGS ("1"), UNIBOT_ASSISTANT_ID, UNIBOT_KNOWLEDGE

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL          = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEBUG          = process.env.DEBUG_LOGS === '1';
const UNIBOT_ASSISTANT_ID = process.env.UNIBOT_ASSISTANT_ID || '';
const UNIBOT_KNOWLEDGE    = process.env.UNIBOT_KNOWLEDGE || '';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function log(...args) {
  if (DEBUG) console.log(...args);
}

async function readJson(req) {
  try {
    if (typeof req.body === 'object') return req.body;
    const txt = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => (data += c));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    return {};
  }
}

function pickMessage(body) {
  // Chatfuel peut envoyer divers champs ; on priorise explicitement
  const candidates = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ].filter(Boolean);

  if (candidates.length === 0) return '';
  return String(candidates[0]).trim();
}

function normalizeConvId(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // OpenAI exige un id commençant par "conv_"
  if (s.startsWith('conv_')) return s;
  return '';
}

/* ------------------------------------------------------------------ */
/* OpenAI Responses API v2                                            */
/* ------------------------------------------------------------------ */

async function askOpenAI({ message, convId }) {
  // On construit un "system prompt" léger, + éventuelle mémo-knowledge
  const SYSTEM_PROMPT = [
    "Tu es Unibot, l’assistant WhatsApp d’Uniloan.",
    "Réponds en français, clair et concis.",
    "Si on te demande un prix ou une information produit, utilise les infos internes si présentes.",
    UNIBOT_ASSISTANT_ID ? `assistant_id=${UNIBOT_ASSISTANT_ID}` : '',
    UNIBOT_KNOWLEDGE ? `Mémo produits : ${UNIBOT_KNOWLEDGE}` : '',
  ].filter(Boolean).join('\n');

  const body = {
    model: MODEL, // <-- OBLIGATOIRE
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: message },
    ],
  };

  if (convId) body.conversation = convId;

  log('[replyv2:openai_request]', { model: MODEL, hasConv: !!convId });

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      // indispensable pour v2
      'OpenAI-Beta': 'assistants=v2',
    },
    body: JSON.stringify(body),
  });

  const json = await r.json();

  if (!r.ok) {
    const errMsg = `OpenAI ${r.status}: ${JSON.stringify(json, null, 2)}`;
    throw new Error(errMsg);
  }

  // Texte de sortie
  const reply =
    json?.output?.[0]?.content?.[0]?.text?.value ??
    json?.output_text ??
    '';

  const newConvId = json?.conversation || convId || null;

  return { reply: reply || "Désolé, pas de réponse.", convId: newConvId };
}

/* ------------------------------------------------------------------ */
/* Vercel/Node handler                                                */
/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  const start = Date.now();
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ reply: 'Method Not Allowed' });
    }

    log('[replyv2:start]', { method: req.method, url: req.url });

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }
    if (!MODEL) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_MODEL" });
    }

    const body = await readJson(req);
    const userId = String(body.user_id || body.whatsapp_user_id || '').trim();
    const convId = normalizeConvId(body.conv_id);
    const message = pickMessage(body);

    if (DEBUG) {
      log('[replyv2:input]', {
        userId,
        message,
        convId_in: body.conv_id || null,
        convId_used: convId || null,
      });

      function sanitizeField(v) {
  if (v == null) return '';
  const t = String(v).trim();
  if (t === '' || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return '';
  return t;
}

function pickMessage(body) {
  const candidates = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ];
  for (const c of candidates) {
    const s = sanitizeField(c);
    if (s) return s;
  }
  return '';
}

function normalizeConvId(raw) {
  const s = sanitizeField(raw);
  if (!s) return '';
  return s.startsWith('conv_') ? s : '';
}
    }

    if (!message) {
      return res.status(200).json({
        reply: "Il semble que votre message soit vide. Que puis-je faire pour vous aujourd'hui ?",
        conv_id: convId || null,
        version: 'assistant_v9',
      });
    }

    // Appel OpenAI
    const { reply, convId: finalConv } = await askOpenAI({ message, convId });

    log('[replyv2:outgoing]', { ms: Date.now() - start, convId: finalConv });

    return res.status(200).json({
      reply,
      conv_id: finalConv || null,
      version: 'assistant_v9',
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    log('[replyv2:openai_error]', { error: msg });
    return res.status(200).json({
      reply: `Erreur: ${msg}`,
      conv_id: null,
      version: 'assistant_v9',
    });
  }
}
