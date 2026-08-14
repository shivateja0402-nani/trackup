// Supabase Edge Function: generate-outreach
//
// Generates a complete LinkedIn outreach FLOW for a lead — connection note + a
// blank-request strategy, an opener/value/CTA DM sequence, a bump, and two
// conditional reply branches (positive vs objection) — grounded in the user's
// own context. BYOK (Gemini / OpenAI / Anthropic). Deploy with verify_jwt OFF.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Provider = 'gemini' | 'openai' | 'anthropic';

interface LeadProfileInput {
  city_location?: string;
  connections?: number;
  followers?: number;
  recently_active?: boolean;
  is_decision_maker?: boolean;
  source?: string;
}

interface LeadInput {
  name?: string;
  job_title?: string;
  company_name?: string;
  industry?: string;
  linkedin_url?: string;
  company_website?: string;
  potential_services?: string;
  profile?: LeadProfileInput;
}

interface RequestInput {
  lead?: LeadInput;
  context?: string;
  provider?: Provider;
  model?: string;
  apiKey?: string;
}

const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

const SYSTEM_PROMPT =
  'You are an expert B2B LinkedIn outreach strategist and copywriter. You write concise, human, ' +
  'specific, non-salesy messages that get replies, and you design smart multi-step flows with ' +
  'branches for how prospects respond. You always reply with a single valid JSON object and nothing else.';

/**
 * The LinkedIn profile signals, rendered for the prompt along with how to use
 * them. A heavily-followed active profile is buried in outreach and needs a
 * shorter, sharper message than a quiet one — same offer, different calibration.
 */
const buildProfileBlock = (p?: LeadProfileInput): string => {
  if (!p) return '';
  const lines: string[] = [];
  if (p.city_location) lines.push(`- Location: ${p.city_location}`);
  if (typeof p.connections === 'number') lines.push(`- Connections: ${p.connections}`);
  if (typeof p.followers === 'number') lines.push(`- Followers: ${p.followers}`);
  if (typeof p.recently_active === 'boolean') {
    lines.push(`- Posted or engaged in the last ~90 days: ${p.recently_active ? 'yes' : 'no'}`);
  }
  if (typeof p.is_decision_maker === 'boolean') {
    lines.push(`- Confirmed decision-maker: ${p.is_decision_maker ? 'yes' : 'no'}`);
  }
  if (!lines.length) return '';

  return `
Their LinkedIn presence:
${lines.join('\n')}

Calibrate to this presence:
- High reach (roughly 1000+ followers/connections) and recently active: they get
  a lot of outreach and their attention is expensive. Go shorter and sharper,
  lead with the single most specific thing, and you may reference that they are
  visibly active in their space. Never flatter them for being big.
- Modest reach or not recently active: their inbox is quiet, so a slightly
  warmer and more explanatory message lands fine. Do NOT reference their posting
  or activity — there may be none, and pretending otherwise is instantly obvious.
- Not a confirmed decision-maker: write so it still works if they have to
  forward it to whoever decides.
- Local specifics (their city, the local market) are fair game when they sharpen
  a line. Never use location as filler small talk.
`;
};

const buildPrompt = (lead: LeadInput, context: string): string =>
  `Design a complete LinkedIn outreach FLOW for this lead.
${context ? `\nBackground about me / my agency (use for credibility, proof and specifics):\n${context}\n` : ''}
Lead details:
- Name: ${lead.name ?? ''}
- Job title: ${lead.job_title ?? ''}
- Company: ${lead.company_name ?? ''}
- Industry: ${lead.industry ?? ''}
- Company website: ${lead.company_website ?? ''}
- Services I could offer them: ${lead.potential_services ?? ''}
${buildProfileBlock(lead.profile)}
Return ONLY a JSON object with exactly these keys:
{
  "connection_note": "Connection-request note, MAX 280 chars. Personal, specific to them, NO pitch. Never ask permission to send or share anything.",
  "blank_strategy": "One sentence of advice: blank (no-note) requests often accept higher — say whether to send blank for this person and how to open if so.",
  "opener": "First DM once they accept. References them, no pitch. Lead with the thing itself, not a greeting-then-pitch. 2-3 sentences.",
  "value": "Follow-up DM carrying EXACTLY ONE proof point — one number or one client example, never a stack of them. One metric with context reads as fact; three read as marketing. 2-4 sentences.",
  "cta": "Follow-up DM proposing an AUDIT CALL — a call where they leave with a read on their current situation whether or not they buy. Use the words 'audit call'. Never 'quick call', 'sales call', 'demo' or 'hop on a call'. 1-3 sentences.",
  "bump": "ONE short question and nothing else, e.g. 'Did you get a chance to look at this?'. No 'just bumping this', no restating the value, no apology for following up, no new pitch. Max 1 sentence.",
  "reply_positive": "What to send if they reply POSITIVELY. They already decided — do not re-qualify them in the thread. Acknowledge in one line, then offer the call/calendar. Qualify on the call, not here. Max 2 sentences.",
  "reply_objection": "What to send if they push back, hesitate, or say no. Acknowledge without folding, reframe with ONE number or ONE example, never discount, zero pressure. If the objection reveals a genuine non-fit, say so directly and close the loop kindly. 2-3 sentences."
}

HARD RULES for every message above:
- NO exclamation marks anywhere. They read as need, and neediness is the fastest
  way to kill a reply. Use full stops.
- Write at a calm, unhurried energy — like someone whose pipeline does not depend
  on this conversation. Never eager, never grateful for their attention.
- Do not ask permission to send something ("mind if I share…", "can I send you…").
  If you have something worth sending, just send it.
- Do not pitch before they have shown interest. Restraint is the differentiator —
  most of their inbox is automated pitching from message one.
- No emojis.
- Ban these AI tells: em dashes, "unlock", "elevate", "delve", "dive into",
  "game-changer", "landscape", "testament", "showcase", "leverage" as a verb,
  "I hope this finds you well", and "I came across your profile".
- Avoid perfectly parallel three-item lists, rhetorical questions used as
  transitions, and tidy moral-of-the-story endings. Slightly rough and specific
  beats smooth and generic.
- Attach a number to any claim about a problem or a result. No vague benefits.
- Write money as words: "9,240 dollars", "227K dollars" — never with a dollar
  symbol. Gemini parses $...$ as LaTeX maths and silently swallows the digits,
  so "$9,240" comes back as "240" or vanishes. The rule above asks for numbers,
  which makes this failure likely without this guard.

Be specific to THIS lead and sound like a real person typed it between meetings.`;

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  useJsonMode: boolean,
): Promise<string> {
  const send = (jsonMode: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  // Ask for strict JSON; if the model rejects response_format, retry without it.
  let res = await send(useJsonMode);
  if (!res.ok && useJsonMode) res = await send(false);
  if (!res.ok) throw new Error(`Provider request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0.8,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${prompt}\n\nRespond with ONLY the raw JSON object.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data?.content?.[0]?.text ?? '';
}

function parseFlow(raw: string): Record<string, string> {
  let text = (raw ?? '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The AI returned a response that was not valid JSON. Try again.');
  }
  const s = (k: string) => String(parsed[k] ?? '');
  return {
    connection_note: s('connection_note'),
    blank_strategy: s('blank_strategy'),
    opener: s('opener'),
    value: s('value'),
    cta: s('cta'),
    bump: s('bump'),
    reply_positive: s('reply_positive'),
    reply_objection: s('reply_objection'),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const input = (await req.json()) as RequestInput;
    const lead = input.lead ?? {};
    const provider = input.provider;
    const apiKey = (input.apiKey ?? '').trim();

    if (!lead.name || !lead.linkedin_url) {
      return json({ error: 'Lead name and LinkedIn URL are required.' }, 400);
    }
    if (provider !== 'gemini' && provider !== 'openai' && provider !== 'anthropic') {
      return json({ error: 'A valid provider (gemini, openai, anthropic) is required.' }, 400);
    }
    if (!apiKey) return json({ error: 'An API key is required. Add one in Settings.' }, 400);

    const model = (input.model ?? '').trim() || DEFAULT_MODEL[provider];
    const prompt = buildPrompt(lead, (input.context ?? '').trim());

    let raw: string;
    if (provider === 'anthropic') {
      raw = await callAnthropic(apiKey, model, prompt);
    } else if (provider === 'gemini') {
      raw = await callOpenAICompatible(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey,
        model,
        prompt,
        true,
      );
    } else {
      raw = await callOpenAICompatible('https://api.openai.com/v1', apiKey, model, prompt, true);
    }

    return json(parseFlow(raw));
  } catch (err) {
    console.error('generate-outreach failed:', err);
    const message = err instanceof Error ? err.message : 'Unexpected error generating outreach.';
    return json({ error: message }, 500);
  }
});
