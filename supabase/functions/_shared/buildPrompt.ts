// Server-side equivalent of src/lib/method/forChannel.ts's buildChannelPrompt,
// for the one channel a server caller needs today: 'linkedin'.
//
// This is the piece that lets generate-outreach build its OWN prompt instead of
// only forwarding one the caller already composed — the fix for the
// prompt-drift bug between the app (which built the full doctrine prompt
// client-side) and n8n's "Generate DM Sequences A/B/C" workflows (which
// hardcoded an old, different prompt). Both now go through this function and
// the modules it calls under supabase/functions/_shared/.
//
// Deliberately narrower than forChannel.buildChannelPrompt:
//   - Only 'linkedin' is wired, because the linkedin pack is the only one
//     ported into _shared/method/packs/ so far. coldEmail and upwork would be
//     ported the same way (copy verbatim, add .ts to relative imports) the
//     day something server-side needs them.
//   - Reads from the database instead of localStorage/React state, because a
//     server process invoked by n8n has neither. Each read below names the
//     client-side source it replaces.
//   - Takes a ready-made Supabase client. The caller (index.ts) decides
//     whether that client holds the service-role key (the n8n path) or an
//     end-user's own JWT (a future authenticated-server-call path); this
//     function does not care, it only reads rows scoped to the user_id it is
//     given.
//
// `buildChannelPrompt`'s qualification handling differs from this one by
// necessity: the app runs the QualifyPanel's live input through `qualify()`
// every render. Here there is no live input, only whatever the panel already
// saved to `leads.qualification` (a QualificationInput), which is run through
// the same pure `qualify()` to get the same QualificationResult the app would
// show for that lead right now.

import { linkedinPack } from './method/packs/linkedin.ts';
import { composeSystemPrompt } from './method/compose.ts';
import { subjectKey } from './method/types.ts';
import type { MethodPack, StructureStep } from './method/types.ts';
import { rankCases, selectBest } from './proof/select.ts';
import { renderProof } from './proof/render.ts';
import type { CaseStudy, ScoredCase, Target } from './proof/types.ts';
import { qualify } from './qualify/score.ts';
import { renderQualification } from './qualify/render.ts';
import type { QualificationInput } from './qualify/types.ts';
import { renderBrief } from './vertical/render.ts';
import { DEFAULT_MODE } from './vertical/types.ts';
import type { IndustryEvidence, LoadedBrief, VerticalBrief, VerticalMode } from './vertical/types.ts';

/** Mirrors src/lib/method/forChannel.ts's OutputStep / outputSteps. */
export interface OutputStep {
  key: string;
  label: string;
  purpose: string;
  maxChars?: number;
  constraints: string[];
}

export const outputSteps = (pack: MethodPack): OutputStep[] =>
  pack.structure.flatMap(({ key, label, purpose, maxChars, constraints, subject }: StructureStep) => {
    const body: OutputStep = { key, label, purpose, maxChars, constraints };
    if (!subject) return [body];
    return [
      {
        key: subjectKey(key),
        label: `${label} — subject line`,
        purpose: subject.purpose,
        maxChars: subject.maxChars,
        constraints: subject.constraints,
      },
      body,
    ];
  });

export interface ServerLeadInput {
  id?: string;
  name?: string;
  job_title?: string;
  company_name?: string;
  industry?: string;
  linkedin_url?: string;
  company_website?: string;
  potential_services?: string;
}

export interface BuildServerPromptResult {
  pack: MethodPack;
  systemPrompt: string;
  steps: OutputStep[];
  /** The case study chosen, with its score — mirrors forChannel.ts's `chosen`. */
  chosen: ScoredCase | null;
  /** Runners-up, so the caller can show the pick and let the user swap. */
  alternatives: ScoredCase[];
  evidence: IndustryEvidence[];
  proofEmpty: boolean;
  /** True when there is genuinely nothing to write from. See forChannel.ts. */
  nothingToWriteFrom: boolean;
  /** True when the copy would lean on researched figures rather than the sender's own. */
  industryOnly: boolean;
  /** True when proof might exist but could not be read. Never say "you have none". */
  proofUnknown: boolean;
  /** True when the screen (qualification) declined this lead. */
  declined: boolean;
  /** Which vertical mode was actually used. */
  verticalMode: VerticalMode;
  /** True only when a brief was actually rendered into the prompt. */
  usingBrief: boolean;
}

/**
 * Optional overrides for the browser's buildOnly call, mirroring the matching
 * fields on forChannel.ts's `BuildOptions`. Every field is optional and
 * defaults to the same behaviour buildServerLinkedinPrompt already had: read
 * the lead's saved qualification, use the channel's default vertical mode,
 * pick the best-matching case study, and carry no per-user prompt override
 * (since that lives only in localStorage, with no DB mirror yet).
 */
export interface BuildServerPromptOptions {
  /** Force a specific case study, e.g. because the user overrode the pick. */
  forceCaseId?: string;
  /** Whether this generation should use the vertical brief. Defaults to the channel default. */
  verticalMode?: VerticalMode;
  /**
   * The live (possibly unsaved) qualification answers for this lead. Overrides
   * the `leads.qualification` row when provided, exactly as the browser's own
   * live `qual` state overrides whatever was last saved.
   */
  qualificationInput?: QualificationInput | null;
  /** The sender's own editable "outreach" prompt override (src/lib/prompts.ts on the browser). */
  userPrompt?: string;
  /** Set when the vault could not be READ, which must never be treated as "empty vault". */
  vaultUnavailable?: boolean;
}

/**
 * Builds the LinkedIn system prompt for a lead, reading everything the client
 * build (`buildChannelPrompt`) would otherwise have been handed by the browser.
 *
 * `userId` scopes every read. It is NOT derived from a JWT here — the caller
 * (index.ts) is responsible for deciding whose data this request may read,
 * whether that's "the signed-in caller" or "the user_id n8n supplied, because
 * the request carried a verified service-role key". This function trusts that
 * decision and just reads.
 */
export async function buildServerLinkedinPrompt(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  lead: ServerLeadInput,
  options: BuildServerPromptOptions = {},
): Promise<BuildServerPromptResult> {
  const pack = linkedinPack;

  // --- who the sender is. Replaces loadUserContext()'s localStorage read,
  // against the users.about/wins/testimonials columns that read mirrors.
  const { data: userRow } = await supabase
    .from('users')
    .select('about, wins, testimonials')
    .eq('id', userId)
    .maybeSingle();
  const about = (userRow?.about ?? '').trim();
  const wins = (userRow?.wins ?? '').trim();
  const testimonials = (userRow?.testimonials ?? '').trim();

  // --- the proof vault. Replaces the `cases` prop the app's useCaseStudies()
  // hook supplies from its own live query against the same table.
  const { data: caseRows } = await supabase
    .from('case_studies')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true);
  const cases = (caseRows ?? []) as CaseStudy[];

  const target: Target = {
    industry: lead.industry ?? null,
    buyer_role: lead.job_title ?? null,
    notes: [lead.company_name, lead.industry, lead.potential_services].filter(Boolean).join(' · '),
  };

  // Mirrors forChannel.ts's `buildChannelPrompt`: rank every active case study
  // against this lead, honour a forced pick if the caller sent one, and keep
  // the runners-up so the caller can show the pick and let the user swap.
  let chosen: ScoredCase | null = null;
  let alternatives: ScoredCase[] = [];
  let proof = '';
  if (cases.length) {
    const ranked = rankCases(cases, target);
    chosen = options.forceCaseId
      ? ranked.find((r) => r.caseStudy.id === options.forceCaseId) ?? null
      : selectBest(cases, target, 'direct');
    alternatives = ranked.filter((r) => r.caseStudy.id !== chosen?.caseStudy.id).slice(0, 4);
    if (chosen) proof = renderProof([chosen.caseStudy], 'direct');
  }
  // Fall back to the legacy free-text fields exactly as buildChannelPrompt does.
  if (!proof) {
    const legacy = [wins, testimonials].filter(Boolean).join('\n\n');
    if (legacy) {
      proof = `${legacy}\n\nUse at most one of these per message. Never state a number that does not appear above.`;
    }
  }
  // A vault that could not be READ is not an empty vault; same distinction
  // forChannel.ts's `proofEmpty` makes.
  const proofEmpty = !proof && !options.vaultUnavailable;

  // --- qualification. Replaces the QualifyPanel's live `verdict`.
  //
  // `options.qualificationInput` carries the live (possibly unsaved) answers
  // exactly as the browser's own `qual` state would, and takes priority over
  // the saved row when the caller sent the field at all — including sending
  // it as `null`, which means "the screen has been cleared", not "unset".
  // Only when the caller omitted the field entirely do we fall back to
  // reading `leads.qualification`, which is the no-override behaviour this
  // function already had.
  let qualification = '';
  let declined = false;
  {
    let input: QualificationInput | null;
    if ('qualificationInput' in options) {
      input = options.qualificationInput ?? null;
    } else if (lead.id) {
      // Scoped by user_id too, not just id: defense in depth against a
      // malformed or mismatched request reading another user's lead through
      // the service-role client, which bypasses RLS entirely.
      const { data: leadRow } = await supabase
        .from('leads')
        .select('qualification')
        .eq('id', lead.id)
        .eq('user_id', userId)
        .maybeSingle();
      input = (leadRow?.qualification ?? null) as QualificationInput | null;
    } else {
      input = null;
    }
    if (input) {
      const verdict = qualify(input);
      qualification = renderQualification(verdict);
      declined = verdict.verdict === 'decline';
    }
  }

  // --- the vertical brief. Replaces useVerticalBrief()/useVerticalMode(),
  // defaulting to the channel's DEFAULT_MODE ('vertical' for linkedin) exactly
  // as the app does when the member has not overridden it. Generic is the
  // safe default when nothing was chosen, same as forChannel.ts.
  const mode: VerticalMode = options.verticalMode ?? DEFAULT_MODE.linkedin ?? 'generic';
  let vertical = '';
  let evidence: IndustryEvidence[] = [];
  let usingBrief = false;
  if (mode === 'vertical') {
    const { data: briefRow } = await supabase
      .from('vertical_briefs')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle();
    if (briefRow) {
      const { data: evidenceRows } = await supabase
        .from('industry_evidence')
        .select('*')
        .eq('brief_id', (briefRow as VerticalBrief).id)
        .eq('active', true);
      const loaded: LoadedBrief = { brief: briefRow as VerticalBrief, evidence: (evidenceRows ?? []) as IndustryEvidence[] };
      vertical = renderBrief(loaded);
      evidence = loaded.evidence;
      usingBrief = true;
    }
  }

  const systemPrompt = composeSystemPrompt({
    pack,
    qualification,
    context: about ? `About the sender:\n${about}` : '',
    vertical,
    proof,
    // The user's own editable "outreach" prompt slot (src/lib/prompts.ts).
    // lives in localStorage only, with no DB mirror, so the buildOnly caller
    // sends it directly in the request. A server caller that does not send
    // one (e.g. n8n) gets the doctrine without it, which is a graceful
    // degradation: composeSystemPrompt treats an empty userPrompt exactly
    // like one the user never set.
    userPrompt: options.userPrompt ?? '',
  });

  return {
    pack,
    systemPrompt,
    steps: outputSteps(pack),
    chosen,
    alternatives,
    evidence,
    proofEmpty,
    // A sourced industry figure is something to write from; see forChannel.ts.
    nothingToWriteFrom: proofEmpty && evidence.length === 0,
    industryOnly: proofEmpty && evidence.length > 0,
    proofUnknown: Boolean(options.vaultUnavailable),
    declined,
    verticalMode: mode,
    usingBrief,
  };
}
