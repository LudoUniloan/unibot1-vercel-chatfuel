// api/replyv2.js — Assistants v2, robuste aux "null"/conv_id manquants
export const config = { runtime: 'edge' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const UNIBOT_ASSISTANT_ID = process.env.UNIBOT_ASSISTANT_ID;
const DEBUG = String(process.env.DEBUG_LOGS || '').toLowerCase() === 'true';

function log(...args) {
  if (DEBUG) console.log('[replyv2]', ...args);
}

function json(resObj, status = 200) {
  return new Response(JSON.stringify(resObj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// -- Helpers ---------------------------------------------------------------

function sanitize(v) {
  if (v == null) return '';
  const t = String(v).trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (low === 'null' || low === 'undefined') return '';
  return t;
}

function extractMessage(body) {
  // On accepte plusieurs variantes venues de Chatfuel
  const candidates = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ];
  for (const c of candidates) {
    const s = sanitize(c);
    if (s) return s;
  }
  return '';
}

function normalizeThreadId(raw) {
  const s = sanitize(raw);
  if (!s) return '';
  // Avec Assistants v2, les threads ressemblent à "thread_..."
  return s.startsWith('thread_') ? s : '';
}

async function openai(path, init) {
  const url = `https://api.openai.com/v1/${path}`;
  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    // Obligatoire pour Assistants v2 :
    'OpenAI-Beta': 'assistants=v2',
  };
  const resp = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${txt || resp.statusText}`);
  }
  return resp.json();
}

// -- Core -----------------------------------------------------------------

async function ensureThreadId(incomingThreadId) {
  const valid = normalizeThreadId(incomingThreadId);
  if (valid) return valid;
  // Créer un nouveau thread si rien à réutiliser
  const t = await openai('threads', { method: 'POST', body: JSON.stringify({}) });
  return t.id; // "thread_..."
}

async function postUserMessage(threadId, message) {
  if (!message) return; // on peut créer la conv sans message initial
  await openai(`threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: message }),
  });
}

async function runAssistant(threadId, assistantId) {
  const run = await openai(`threads/${threadId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ assistant_id: assistantId }),
  });

  // Polling basique jusqu’à "completed" / "requires_action" / "failed"
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 900));
    const r = await openai(`threads/${threadId}/runs/${run.id}`, { method: 'GET' });
    if (r.status === 'completed' || r.status === 'requires_action') return r;
    if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'expired') {
      throw new Error(`Run ended with status: ${r.status}`);
    }
  }
  throw new Error('Run polling timeout');
}

async function getLastAssistantText(threadId) {
  const data = await openai(`threads/${threadId}/messages?limit=10`, { method: 'GET' });
  // Parcourt du plus récent au plus ancien
  for (const msg of (data.data || [])) {
    if (msg.role !== 'assistant') continue;
    const parts = (msg.content || []).filter(p => p.type === 'text');
    if (parts.length) {
      return parts.map(p => p.text?.value || '').filter(Boolean).join('\n\n').trim();
    }
  }
  return '';
}

// -- Handler --------------------------------------------------------------

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return json({ reply: 'Not allowed' }, 405);
    }

    if (!OPENAI_API_KEY || !UNIBOT_ASSISTANT_ID) {
      return json({ reply: 'Config manquante: OPENAI_API_KEY ou UNIBOT_ASSISTANT_ID' }, 500);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const userId = sanitize(body.user_id);
    const message = extractMessage(body);
    const convIdIn = sanitize(body.conv_id);

    log(':input', { userId, message, convId_in: convIdIn });

    // 1) Toujours garantir un thread_id (conv_id)
    const threadId = await ensureThreadId(convIdIn);
    log(':thread', threadId);

    // 2) Poster le message seulement s’il y en a un
    await postUserMessage(threadId, message);

    // 3) Lancer le run
    const run = await runAssistant(threadId, UNIBOT_ASSISTANT_ID);
    log(':run', run.status);

    // 4) Récupérer la réponse
    let reply = await getLastAssistantText(threadId);
    if (!reply) {
      // filet de sécurité
      reply = "Je n’ai pas bien compris. Peux-tu reformuler en une phrase ?";
    }

    return json({
      reply,
      conv_id: threadId,      // <- TOUJOURS renvoyé
      version: 'assistant_v10'
    });
  } catch (err) {
    log(':error', String(err?.message || err));
    return json({
      reply: `Erreur: ${String(err?.message || err)}`,
      conv_id: null,
      version: 'assistant_v10'
    }, 500);
  }
}
