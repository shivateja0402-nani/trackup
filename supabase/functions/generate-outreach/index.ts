// Supabase Edge Function: generate-outreach
//
// Generates a complete LinkedIn outreach FLOW for a lead, grounded in the user's
// own context. BYOK (Gemini / OpenAI / Anthropic). Deploy with verify_jwt OFF.
//
// The SHAPE of that flow is not decided here. The caller sends `steps`, derived
// from the method pack, and this function asks the model for exactly those keys.
//
// That indirection is the fix for a real defect: this function used to hardcode
// its own eight-key JSON shape while the pack described twelve differently-named
// steps. The model was told two different structures, and the validator then
// graded the response against keys nobody had asked for — reporting every step
// as "came back empty. Regenerate." on top of perfectly good copy. One contract,
// derived from the doctrine, is the only way that stays fixed.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildServerLinkedinPrompt, type BuildServerPromptOptions } from '../_shared/buildPrompt.ts';

/**
 * Origins allowed to call this function.
 *
 * Set ALLOWED_ORIGINS as a comma-separated list of your deployed app's origins
 * to lock this down. Left unset it allows any origin, which is safe enough only
 * because requireUser below rejects anyone without a valid session for THIS
 * project — but setting it is worth the thirty seconds.
 */
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);

const corsFor = (req: Request) => {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED.length === 0 ? '*' : ALLOWED.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
};

/**
 * Identify the caller and REQUIRE either a real signed-in user, OR a trusted
 * server-to-server caller presenting this project's own service-role key.
 *
 * These functions deploy with verify_jwt off, because the browser calls them
 * with the anon key. The platform therefore performs no auth at all and this is
 * the only gate. Without it the function is an open relay: anyone who finds the
 * URL can post an arbitrary provider, key and prompt and have someone else's
 * project make the outbound call, burning their invocation quota and lending
 * their domain to whatever the caller is doing.
 *
 * Two paths, and the second is additive — it does not weaken the first:
 *
 *   1. Browser path (unchanged). The Authorization header carries the
 *      end-user's own JWT, verified via supabase-js against the project's
 *      anon key. The acting user is whoever that JWT says it is. `bodyUserId`
 *      is IGNORED on this path, so a browser caller cannot impersonate anyone
 *      else by adding a `user_id` to the request body.
 *   2. Server path (new). The Authorization header carries THIS project's
 *      service-role key, checked by comparing against `SUPABASE_SERVICE_ROLE_KEY`
 *      at request time, not a hardcoded string, so this holds in every
 *      deployment of this function without being re-typed anywhere. That env
 *      var is injected automatically into every Supabase Edge Function's
 *      runtime; nothing needs to be configured for this comparison to work.
 *      Only a caller already holding the single most privileged secret in the
 *      project can take this path, so it is trusted to say who it is acting
 *      for, via `bodyUserId`. This is the path n8n's server-to-server calls use.
 *
 * Deliberately duplicated rather than shared with the sibling functions: the
 * setup wizard hands these sources to the user as copy-paste text, so a
 * cross-file import would not survive the install.
 */
async function requireUser(req: Request, bodyUserId?: string): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (serviceRoleKey && bearer && bearer === serviceRoleKey) {
    const uid = (bodyUserId ?? '').trim();
    return uid || null;
  }

  try {
    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data } = await client.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether this request authenticated via the service-role path above, rather
 * than a real end-user JWT.
 *
 * `buildOnly` (below) exists for the browser, which always carries its own
 * signed-in user's JWT. n8n's server-to-server calls carry the service-role
 * key instead, and must never be able to request a build "as" an arbitrary
 * `user_id` through this mode — that would let a holder of the service-role
 * key read any user's case studies, qualification and vertical brief through
 * a response intended only for the signed-in owner of that data. `requireUser`
 * already resolves a `userId` for both paths; this is the one extra bit it
 * does not expose, kept as its own tiny check rather than changing that
 * function's return shape and risking the n8n (promptOnly) path it already
 * serves correctly.
 */
function isServiceRoleBearer(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return Boolean(serviceRoleKey && bearer && bearer === serviceRoleKey);
}



/**
 * The deployed-code version.
 *
 * These functions are pasted into someone's own Supabase project, so the app has
 * no way to know which revision is actually running — and "did you redeploy?"
 * is unanswerable by looking at the screen. A response that does not carry this
 * marker is an old deployment, and the app now says so instead of leaving the
 * user to interpret a blank result.
 */
const CONTRACT = 5;

type Provider = 'gemini' | 'openai' | 'anthropic' | 'openrouter';

/** OpenRouter speaks the OpenAI wire format, so only the base URL differs. */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Optional attribution headers. OpenRouter uses them for its public model
 * rankings and shows the title in the user's own activity log, which is how
 * someone tells an Ember generation apart from everything else on the key.
 */
const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/mani-kanasani/trackup-latest',
  'X-Title': 'Ember',
};

/**
 * Ask Anthropic for JSON without prefilling the assistant turn.
 *
 * The prefill trick ("{" as a trailing assistant message) returns a hard 400 on
 * Claude 4.6-generation models and later, which includes claude-sonnet-5 and
 * claude-opus-5. Structured outputs are the supported replacement and work on
 * every model we offer, so there is one code path rather than a per-model
 * branch.
 */
const jsonSchemaFor = (keys: string[]) => ({
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
    required: keys,
    // Required by the API on every object in the schema.
    additionalProperties: false,
  },
});

/**
 * The text out of a Messages response.
 *
 * Never index `content` positionally. Thinking is on by default on Opus 5 and
 * Sonnet 5, so content[0] is a thinking block and `content[0].text` is
 * undefined. Worse, thinking is adaptive: the model skips it on simple requests,
 * so positional access fails INTERMITTENTLY and reads as a flaky model rather
 * than a client bug. Finding the block by type is also forward-safe against
 * tool_use blocks appearing later.
 */
const textFrom = (data: { content?: { type: string; text?: string }[]; stop_reason?: string }): string => {
  // Truncation first, and before checking for text at all.
  //
  // Thinking tokens count toward max_tokens on Claude 5, and this app sends a
  // 19,000-character doctrine prompt, so the model can spend the entire budget
  // reasoning and emit no text whatsoever. When it does emit some, the JSON is
  // cut mid-object and the parser reports "not usable JSON", which points the
  // user at the model when the real cause is a cap set too low.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      'The model ran out of output budget before finishing. This is a cap, not a bad response: ' +
        'the request asks for a lot and thinking tokens count toward the same budget. Try again, ' +
        'or pick a faster model in Settings.',
    );
  }
  const block = (data.content ?? []).find((b) => b.type === 'text');
  if (!block?.text) {
    throw new Error(`The model returned no text. stop_reason: ${data.stop_reason ?? 'unknown'}.`);
  }
  return block.text;
};


/**
 * The sentence out of a provider error, rather than the whole JSON body.
 *
 * Providers bury the useful line at different depths, and dumping the raw body
 * at the user means they read
 *   {"type":"error","error":{"type":"invalid_request_error","message":"..."}}
 * when the only part that matters is the message.
 */
async function readProviderError(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const body = JSON.parse(raw);
    const msg = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof msg === 'string' && msg) return `${res.status}: ${msg}`;
  } catch {
    // Not JSON. The raw body still beats the status alone.
  }
  return `${res.status}: ${raw.slice(0, 200) || 'no detail returned'}`;
}


interface LeadInput {
  /**
   * The lead's row id in `leads`. Optional because the browser path (which
   * already sends a fully-composed systemPrompt + steps) never needed it.
   * Required for the server-build path below, which uses it to read
   * `leads.qualification` so the generated prompt carries the same tier
   * ceiling and buying-ladder instruction the app would show for this lead.
   */
  id?: string;
  name?: string;
  job_title?: string;
  company_name?: string;
  industry?: string;
  linkedin_url?: string;
  company_website?: string;
  potential_services?: string;
}

/** One key the model must return, sent by the caller from the method pack. */
interface OutputStep {
  key: string;
  label: string;
  purpose: string;
  maxChars?: number;
  constraints?: string[];
}

interface RequestInput {
  lead?: LeadInput;
  context?: string;
  systemPrompt?: string;
  /** The output contract, derived from the pack. */
  steps?: OutputStep[];
  provider?: Provider;
  model?: string;
  apiKey?: string;
  /**
   * Which method pack to build server-side when the caller sends neither a
   * `systemPrompt` nor `steps`. Only `'linkedin'` is wired today (see
   * ../_shared/buildPrompt.ts). The browser's own LinkedInApp.tsx still
   * builds and sends its own systemPrompt + steps, so it never needs this
   * field and this branch never fires for it; it exists for callers with no
   * method-engine code of their own, i.e. n8n.
   */
  channel?: 'linkedin';
  /**
   * Whose data to build the prompt from, and whose case studies/qualification/
   * vertical brief/context to read. Required on the service-role auth path
   * (see requireUser above), where there is no end-user JWT to derive it from.
   * Ignored on the browser's own JWT path.
   */
  user_id?: string;
  /**
   * Build the prompt and stop. No provider, model or apiKey is required or
   * used, and no outbound LLM call is made or quota spent.
   *
   * Exists for n8n's "Generate DM Sequences A/B/C" workflows: each of them
   * keeps its OWN Gemini HTTP node, credential and key completely untouched
   * (n8n has no way to move a credential's secret value into a request body,
   * by design, and this project's n8n license does not have the Variables
   * feature that the original plan would otherwise have leaned on). So this
   * function's job for n8n shrinks to exactly the one thing a server caller
   * cannot do for itself: build the doctrine-correct prompt. n8n's own
   * Gemini node then sends `systemPrompt` + `prompt` to Gemini exactly as it
   * already does today, under its own key.
   */
  promptOnly?: boolean;
  /**
   * Build the LinkedIn prompt and stop, same as `promptOnly`, but for the
   * browser rather than n8n: returns the FULL build result (chosen case
   * study and alternatives, the empty/industry-only/unknown-proof banners,
   * the qualification verdict's `declined`, and which vertical mode was
   * used) instead of just `{ systemPrompt, prompt }`, and no outbound LLM
   * call is made here either.
   *
   * Requires a real signed-in end-user JWT — see `isServiceRoleBearer`
   * below. n8n has no use for this mode (it has no UI to show the extra
   * fields to), and is blocked from it on purpose: a service-role caller
   * supplying an arbitrary `user_id` must never be able to read that user's
   * case studies, qualification or vertical brief back out through this
   * response.
   */
  buildOnly?: boolean;
  /** Force a specific case study, e.g. because the user overrode the pick. Only used with `buildOnly`. */
  forceCaseId?: string;
  /** Whether this generation should use the vertical brief. Only used with `buildOnly`. */
  verticalMode?: 'vertical' | 'generic';
  /**
   * The live (possibly unsaved) qualification answers for this lead. Only
   * used with `buildOnly`. Sending the key at all, including as `null`,
   * overrides the saved `leads.qualification` row; omitting it falls back
   * to that row, same as before this field existed.
   */
  qualificationInput?: BuildServerPromptOptions['qualificationInput'];
  /** The sender's own prompt override (src/lib/prompts.ts). Only used with `buildOnly`. */
  userPrompt?: string;
  /** Set when the browser's case-study vault could not be read. Only used with `buildOnly`. */
  vaultUnavailable?: boolean;
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

/** Kept alongside the pack's steps: tactical advice, not a message to send. */
const STRATEGY_KEY = 'blank_strategy';
const STRATEGY_SPEC =
  'One sentence of advice. Blank connection requests, with no note, often accept at a higher rate. ' +
  'Say whether to send blank for this specific person, and how to open if so.';

/**
 * Turns the pack's steps into the JSON contract.
 *
 * Each key carries its own purpose, character ceiling and constraints, so the
 * model is told what every field is FOR rather than being handed one blob and
 * a word count.
 */
const shapeFromSteps = (steps: OutputStep[]): string => {
  const lines = steps.map((s) => {
    const cap = s.maxChars ? ` MAX ${s.maxChars} characters.` : '';
    const cons = s.constraints?.length ? ` ${s.constraints.join(' ')}` : '';
    return `  ${JSON.stringify(s.key)}: ${JSON.stringify(`${s.label}. ${s.purpose}${cap}${cons}`)}`;
  });
  lines.push(`  ${JSON.stringify(STRATEGY_KEY)}: ${JSON.stringify(STRATEGY_SPEC)}`);
  return `{\n${lines.join(',\n')}\n}`;
};

const buildPrompt = (lead: LeadInput, context: string, steps: OutputStep[]): string =>
  `Design a complete LinkedIn outreach FLOW for this lead.
${context ? `\nBackground about me / my agency (use for credibility, proof and specifics):\n${context}\n` : ''}
Lead details:
- Name: ${lead.name ?? ''}
- Job title: ${lead.job_title ?? ''}
- Company: ${lead.company_name ?? ''}
- Industry: ${lead.industry ?? ''}
- Company website: ${lead.company_website ?? ''}
- Services I could offer them: ${lead.potential_services ?? ''}

Return ONLY a JSON object with exactly these keys, and every one of them:
${shapeFromSteps(steps)}

Every key must be present and non-empty. Be specific to THIS lead and sound human.
Avoid generic openers like "I came across your profile".`;

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  useJsonMode: boolean,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  // Two things a newer model can reject: response_format, and temperature at
  // all. Both are dropped on retry rather than assumed unsupported, so an older
  // model keeps the settings and a newer one still works.
  const send = (jsonMode: boolean, withTemperature: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    // Reasoning models reject temperature outright, so it is skipped rather
    // than sent and retried: a wasted round trip on every single call.
    if (withTemperature && !/^(o\d|gpt-5)/.test(model)) body.temperature = 0.8;
    if (jsonMode) body.response_format = { type: 'json_object' };
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  };

  // Retry drops TEMPERATURE, never response_format.
  //
  // The old fallback stripped both together. Since the usual cause is a
  // reasoning model rejecting temperature, the retry then succeeded with no JSON
  // enforcement at all: a 200 carrying prose or fenced markdown, which parses to
  // garbage downstream. A silent corruption is worse than the error it replaced.
  let res = await send(useJsonMode, true);
  if (!res.ok) res = await send(useJsonMode, false);
  if (!res.ok) throw new Error(`Provider request failed. ${await readProviderError(res)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(apiKey: string, model: string, system: string, prompt: string, jsonKeys: string[]): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // Generous on purpose. max_tokens is a CEILING, not a spend, so headroom is
      // free. Thinking tokens count toward it on Claude 5 and the doctrine prompt is
      // 19,000 characters, so at 8000 the model spent the entire budget reasoning.
      max_tokens: 64000,
      // No temperature. The Claude 5 models reject it outright:
      //   400 invalid_request_error: `temperature` is deprecated for this model.
      // Sending it is a hard failure on current models and buys almost nothing on
      // older ones, since the prefill and the pack constrain the output far more
      // than a sampling parameter does.
      system: system,
      // No assistant prefill. It returns a hard 400 on Claude 4.6-generation
      // models and later, which is both Claude 5 presets including the default,
      // so the trick that was meant to guarantee JSON would have failed every
      // request. Structured outputs do the same job and are supported on every
      // model we offer, so this is one path rather than a per-model branch.
      output_config: { format: jsonSchemaFor(jsonKeys) },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic request failed. ${await readProviderError(res)}`);
  return textFrom(await res.json());
}

function parseFlow(raw: string, steps: OutputStep[]): Record<string, string> {
  let text = (raw ?? '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) text = text.slice(first, last + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      // The raw reply, trimmed. Without it "not valid JSON" is unactionable:
      // a refusal, a preamble and a truncation all look identical from outside.
      `The model did not return usable JSON. It replied with: ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`,
    );
  }
  const out: Record<string, string> = {};
  let filled = 0;
  for (const step of steps) {
    const v = String(parsed[step.key] ?? '').trim();
    out[step.key] = v;
    if (v) filled++;
  }
  out[STRATEGY_KEY] = String(parsed[STRATEGY_KEY] ?? '');

  // A response that parses but carries none of the requested keys is a failure,
  // and it used to be saved as a full set of empty strings — which the app then
  // reported as twelve separate things to fix, with no hint that the real problem
  // was upstream. Say what actually came back instead.
  if (filled === 0) {
    const got = Object.keys(parsed).slice(0, 8).join(', ') || 'nothing';
    throw new Error(
      `The model replied but used none of the requested fields. It returned: ${got}. ` +
        'This usually means the response was cut short or the model ignored the format. ' +
        'Try again, or pick a stronger model in Settings.',
    );
  }
  // A partial response is worth keeping, but the user should know it is partial
  // rather than discover it as a list of empty steps.
  if (filled < steps.length) {
    out.__partial = `${filled} of ${steps.length} steps came back. The rest were left empty by the model.`;
  }
  return out;
}

/**
 * Every response carries the deployed version, including errors.
 *
 * Stamping only the success path meant a function could only be identified by
 * generating successfully, which is exactly what you cannot do when something is
 * wrong. Now a 400 answers "which revision is live?" just as well as a 200, so
 * the app can check all three functions without spending a single token.
 */
const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(
    JSON.stringify(
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), __contract: CONTRACT }
        : body,
    ),
    { status, headers: { ...cors, 'Content-Type': 'application/json' } },
  );

Deno.serve(async (req: Request) => {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

  // Body is parsed before auth now (it used to be parsed inside the try block
  // below, after auth): the service-role auth path needs `user_id` out of the
  // body to know who it is acting for, so the body has to exist first.
  let input: RequestInput;
  try {
    input = (await req.json()) as RequestInput;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, cors);
  }

  const userId = await requireUser(req, input.user_id);
  if (!userId) return json({ error: 'Sign in before generating outreach.' }, 401, cors);

  try {
    const lead = input.lead ?? {};
    const provider = input.provider;
    const apiKey = (input.apiKey ?? '').trim();
    const promptOnly = input.promptOnly === true;
    const buildOnly = input.buildOnly === true;

    if (!lead.name || !lead.linkedin_url) {
      return json({ error: 'Lead name and LinkedIn URL are required.' }, 400, cors);
    }

    // buildOnly: the browser's own build, standing in for the local
    // buildChannelPrompt() call LinkedInApp.tsx used to make. Resolved and
    // returned before any of the promptOnly/provider logic below, because it
    // shares none of it: no provider/apiKey, no `steps`/`systemPrompt`
    // override from the caller, and a response shape promptOnly callers
    // (n8n) have no use for.
    if (buildOnly) {
      // The one check promptOnly does not need: buildOnly hands back
      // user-owned data (case studies, qualification, vertical brief), so it
      // must only run for the user who actually owns that data, never for a
      // service-role caller asserting an arbitrary `user_id`.
      if (isServiceRoleBearer(req)) {
        return json({ error: 'buildOnly is for a signed-in browser session, not a server-to-server call.' }, 403, cors);
      }
      const serviceClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const buildOptions: BuildServerPromptOptions = {};
      if (input.forceCaseId) buildOptions.forceCaseId = input.forceCaseId;
      if (input.verticalMode) buildOptions.verticalMode = input.verticalMode;
      // Presence, not truthiness: sending `qualificationInput: null` means
      // "the screen was cleared", which must override the saved row the same
      // way a real answer would, not be treated as "field not sent".
      if ('qualificationInput' in input) buildOptions.qualificationInput = input.qualificationInput ?? null;
      if (input.userPrompt) buildOptions.userPrompt = input.userPrompt;
      if (input.vaultUnavailable) buildOptions.vaultUnavailable = true;

      const built = await buildServerLinkedinPrompt(serviceClient, userId, lead, buildOptions);
      // Shaped explicitly rather than `json(built, ...)`: `built.pack` carries
      // live RegExp values in `banned[].pattern`, which JSON.stringify turns
      // into `{}`. The browser already has the real pack locally (it calls
      // `getPack('linkedin')` itself for the same reasons it always has), so
      // sending the id and version — the two pack facts that are not already
      // on screen — is both what the caller needs and honest about what
      // crossed the wire.
      return json(
        {
          systemPrompt: built.systemPrompt,
          steps: built.steps,
          chosen: built.chosen,
          alternatives: built.alternatives,
          nothingToWriteFrom: built.nothingToWriteFrom,
          industryOnly: built.industryOnly,
          proofUnknown: built.proofUnknown,
          proofEmpty: built.proofEmpty,
          declined: built.declined,
          usingBrief: built.usingBrief,
          verticalMode: built.verticalMode,
          evidence: built.evidence,
          packId: built.pack.id,
          packVersion: built.pack.version,
        },
        200,
        cors,
      );
    }

    // promptOnly makes no outbound LLM call, so none of provider/model/apiKey
    // is needed and n8n's request never sends them. Every other check below
    // (steps resolved, server build succeeds) still applies unchanged.
    if (!promptOnly) {
      if (provider !== 'gemini' && provider !== 'openai' && provider !== 'anthropic' && provider !== 'openrouter') {
        return json({ error: 'A valid provider (gemini, openai, anthropic) is required.' }, 400, cors);
      }
      if (!apiKey) return json({ error: 'An API key is required. Add one in Settings.' }, 400, cors);
    }

    // The contract comes from the caller's method pack. Without it there is no
    // honest shape to ask for, and guessing one is what produced the drift this
    // parameter exists to end.
    let steps = (input.steps ?? []).filter((s) => s && typeof s.key === 'string' && s.key);
    let systemPromptOverride = (input.systemPrompt ?? '').trim();

    // Server-side prompt build: the caller named a channel and sent neither a
    // systemPrompt nor a step contract of its own, which is exactly the shape
    // of a caller with no method-engine code — n8n's "Generate DM Sequences
    // A/B/C" workflows. The browser's own LinkedInApp.tsx always sends both
    // today, so this branch never fires for it and that path is unchanged.
    if (input.channel === 'linkedin' && !systemPromptOverride && !steps.length) {
      // Service-role client, NOT the per-request auth client used above: this
      // reads case_studies / users / leads / vertical_briefs / industry_evidence
      // for `userId` regardless of which auth path produced it, including the
      // browser-JWT path (unused today, since the browser never hits this
      // branch, but kept correct rather than assuming). Row Level Security
      // would otherwise block every one of these reads for a caller with no
      // JWT at all, which is exactly the n8n case. `SUPABASE_SERVICE_ROLE_KEY`
      // is injected automatically into every Edge Function; nothing to configure.
      const serviceClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const built = await buildServerLinkedinPrompt(serviceClient, userId, lead);
      systemPromptOverride = built.systemPrompt;
      steps = built.steps;
    }

    if (!steps.length) {
      return json(
        { error: 'No output steps were supplied. Update the app so it sends the method pack structure.' },
        400,
        cors,
      );
    }

    const system =
      (systemPromptOverride || SYSTEM_PROMPT) +
      ' Always reply with a single valid JSON object and nothing else.';
    const prompt = buildPrompt(lead, (input.context ?? '').trim(), steps);

    // promptOnly stops here: the two strings an LLM call would otherwise have
    // received, and nothing else. No provider/model/apiKey was required above,
    // and no outbound call happens below this point for this request.
    if (promptOnly) {
      return json({ systemPrompt: system, prompt }, 200, cors);
    }

    // provider is guaranteed valid at this point: the promptOnly branch above
    // already returned for every request that skipped the provider/apiKey
    // checks, so every request reaching here took the `!promptOnly` branch
    // where that validation ran.
    const model = (input.model ?? '').trim() || DEFAULT_MODEL[provider as Provider];

    let raw: string;
    if (provider === 'anthropic') {
      raw = await callAnthropic(apiKey, model, system, prompt, [...steps.map((st) => st.key), STRATEGY_KEY]);
    } else if (provider === 'gemini') {
      raw = await callOpenAICompatible(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey,
        model,
        system,
        prompt,
        true,
      );
    } else if (provider === 'openrouter') {
      // An explicit branch, not a fallthrough. Letting an unmatched provider
      // land on the OpenAI base URL would send an OpenRouter key to OpenAI and
      // report the result as an authentication problem with the user's key.
      raw = await callOpenAICompatible(OPENROUTER_BASE, apiKey, model, system, prompt, true, OPENROUTER_HEADERS);
    } else {
      raw = await callOpenAICompatible('https://api.openai.com/v1', apiKey, model, system, prompt, true);
    }

    return json(parseFlow(raw, steps), 200, cors);
  } catch (err) {
    console.error('generate-outreach failed:', err);
    const message = err instanceof Error ? err.message : 'Unexpected error generating outreach.';
    return json({ error: message }, 500, cors);
  }
});
