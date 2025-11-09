// api/replyv2.js — Assistants v2 (runtime Node), robuste aux "null"/conv_id manquants

// --- Runtime en Node (pas Edge) ---
export const config = { runtime: 'nodejs18.x' };

// Env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || process.env.OPENAI_KEY;
const UNIBOT_ASSISTANT_ID = process.env.UNIBOT_ASSISTANT_ID;
const DEBUG = String(process.env.DEBUG_LOGS || '').toLowerCase() === 'true';

// Petits utilitaires
function log(...a) { if (DEBUG) console.log('[replyv2]', ...a); }
function j(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// Nettoyages
function sanitize(v) {
  if (v == null) return '';
  const t = String(v).trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (low === 'null' || low === 'undefined') return '';
  return t;
}

function extractMessage(body) {
  const cands = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ];
  for (const c of cands) {
    const s = sanitize(c);
    if (s) return s;
  }
  return '';
}

function normalizeThreadId(raw) {
  const s = sanitize(raw);
  if (!s) return '';
  return s.startsWith('thread_') ? s : '';
}

// Appel OpenAI v1 (Assistants v2)
async function openai(path, init) {
  const url = `https://api.openai.com/v1/${path}`;
  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
  const resp = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${text || resp.statusText}`);
  }
  try { return JSON.parse(text); } catch (e) { return {}; }
}

async function ensureThreadId(incomingThreadId) {
  const valid = normalizeThreadId(incomingThreadId);
  if (valid) return valid;
  const t = await openai('threads', { method: 'POST', body: JSON.stringify({}) });
  return t.id;
}

async function postUserMessage(threadId, message) {
  if (!message) return; // amorçage de thread sans message : ok
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

  // Polling simple
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 800));
    const cur = await openai(`threads/${threadId}/runs/${run.id}`, { method: 'GET' });
    if (cur.status === 'completed' || cur.status === 'requires_action') return cur;
    if (cur.status === 'failed' || cur.status === 'cancelled' || cur.status === 'expired') {
      throw new Error(`Run ended with status: ${cur.status}`);
    }
  }
  throw new Error('Run polling timeout');
}

async function getLastAssistantText(threadId) {
  const data = await openai(`threads/${threadId}/messages?limit=10`, { method: 'GET' });
  for (const msg of (data.data || [])) {
    if (msg.role !== 'assistant') continue;
    const parts = (msg.content || []).filter(p => p.type === 'text');
    if (parts.length) {
      return parts.map(p => p.text?.value || '').filter(Boolean).join('\n\n').trim();
    }
  }
  return '';
}

// Handler
export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return j({ reply: 'Not allowed' }, 405);
    }

    if (!OPENAI_API_KEY || !UNIBOT_ASSISTANT_ID) {
      log('Missing env', { hasKey: !!OPENAI_API_KEY, hasAssistant: !!UNIBOT_ASSISTANT_ID });
      return j({ reply: 'Config manquante: OPENAI_API_KEY ou UNIBOT_ASSISTANT_ID', conv_id: null, version: 'assistant_v10' }, 500);
    }

    let body = {};
    try {
      // supporte header incorrect / payload texte
      const text = await req.text();
      try { body = JSON.parse(text || '{}'); }
      catch { body = {}; }
    } catch { body = {}; }

    const userId = sanitize(body.user_id || body.userId || body.uid);
    const message = extractMessage(body);
    const convIdIn = sanitize(body.conv_id || body.thread_id || body.convId);

    log('input', { userId, message, convIdIn });

    // 1) conv_id garanti
    const threadId = await ensureThreadId(convIdIn);
    log('thread', threadId);

    // 2) message éventuel
    await postUserMessage(threadId, message);

    // 3) run
    const run = await runAssistant(threadId, UNIBOT_ASSISTANT_ID);
    log('runStatus', run.status);

    // 4) réponse
    let reply = await getLastAssistantText(threadId);
    if (!reply) reply = "Je n’ai pas bien compris. Peux-tu reformuler en une phrase ?";

    return j({ reply, conv_id: threadId, version: 'assistant_v10' });
  } catch (err) {
    log('fatal', err?.stack || String(err));
    return j({ reply: `Erreur: ${String(err?.message || err)}`, conv_id: null, version: 'assistant_v10' }, 500);
  }
}
