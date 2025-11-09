// /api/replyv2.js
// Mini backend Chatfuel → OpenAI Assistants v2

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID;
const DEBUG          = process.env.DEBUG_LOGS === '1';

const log = (stage, data) => {
  if (!DEBUG) return;
  try {
    console.log(`[replyv2:${stage}] ${JSON.stringify(data)}`);
  } catch {
    console.log(`[replyv2:${stage}]`, data);
  }
};

// --- util: lecture body JSON robuste ---
async function readBody(req) {
  try {
    if (req.body && typeof req.body === 'object') return req.body;
    const txt = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw || '{}'));
      req.on('error', reject);
    });
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

// --- util: création conversation conv_* ---
async function createConversation() {
  const r = await fetch('https://api.openai.com/v1/conversations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    const t = await safeText(r);
    throw new Error(`Create conv failed ${r.status}: ${t}`);
  }
  const j = await r.json();
  // j.id = "conv_..."
  return j.id;
}

// --- util: appel /v1/responses (Assistants v2) ---
async function runAssistant({ conv_id, message }) {
  const payload = {
    assistant_id: ASSISTANT_ID,
    conversation: conv_id,
    input: [
      {
        role: 'user',
        content: [{ type: 'text', text: message || '' }],
      },
    ],
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await safeText(r);
    throw new Error(`OpenAI ${r.status}: ${t}`);
  }

  const j = await r.json();
  // On récupère le premier bloc "output_text"
  let reply = 'Oups, je n’ai pas compris.';
  try {
    // j.output est un tableau de "items" (messages, tool_outputs, etc.)
    // Nous concaténons les segments textuels.
    const texts = [];
    if (Array.isArray(j.output)) {
      for (const item of j.output) {
        // item?.content: tableau de segments {type:'output_text', text: {value:''}}
        if (Array.isArray(item?.content)) {
          for (const seg of item.content) {
            if (seg.type === 'output_text' && seg.text?.value) {
              texts.push(seg.text.value);
            }
          }
        }
      }
    }
    if (texts.length) reply = texts.join('\n\n');
  } catch (e) {
    // garde le fallback
  }
  return reply;
}

async function safeText(r) {
  try {
    return await r.text();
  } catch {
    return '(no-body)';
  }
}

function normalizeConvId(conv_id) {
  if (typeof conv_id !== 'string' || !conv_id.trim()) return null;
  const v = conv_id.trim();
  if (!v.startsWith('conv_')) return null;
  // OpenAI exige [a-zA-Z0-9_-] → conv_* respecte déjà
  return v;
}

export default async function handler(req, res) {
  log('start', { method: req.method, url: req.url });

  if (req.method !== 'POST') {
    return res.status(405).json({ reply: 'Method Not Allowed' });
  }
  if (!OPENAI_API_KEY || !ASSISTANT_ID) {
    return res
      .status(500)
      .json({ reply: 'Config manquante: OPENAI_API_KEY / OPENAI_ASSISTANT_ID' });
  }

  const body = await readBody(req);
  log('incoming', body);

  const user_id = (body.user_id || '').toString();
  const message = (body.message || '').toString().trim();
  let conv_id = normalizeConvId(body.conv_id);

  // Premier message: pas de conv_id → on crée
  if (!conv_id) {
    try {
      conv_id = await createConversation();
      log('created_conv', { conv_id });
    } catch (e) {
      log('error_create_conv', { error: String(e) });
      return res.status(500).json({
        reply: `Erreur: ${String(e).slice(0, 400)}`,
        conv_id: null,
        version: 'assistant_v10',
      });
    }
  }

  // Sécurité: message vide → courte invite
  if (!message) {
    return res.status(200).json({
      reply:
        "Il semble que ton message soit vide. Peux-tu préciser ta question ?",
      conv_id,
      version: 'assistant_v10',
    });
  }

  // Appel OpenAI
  let reply = 'Oups, une erreur est survenue.';
  try {
    reply = await runAssistant({ conv_id, message });
  } catch (e) {
    log('openai_error', { error: String(e) });
    return res.status(200).json({
      reply: `Erreur: ${String(e).slice(0, 400)}`,
      conv_id,
      version: 'assistant_v10',
    });
  }

  log('outgoing', { reply: reply.slice(0, 200), conv_id });
  return res.status(200).json({
    reply,
    conv_id,
    version: 'assistant_v10',
  });
}
