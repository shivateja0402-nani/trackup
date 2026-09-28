// Checks generated output against a MethodPack.
//
// Generation is probabilistic; doctrine is not. A model told "never put a link
// in a cold email" will still occasionally put a link in a cold email. This is
// the layer that catches it, so the user sees the violation instead of sending it.

import { subjectKey } from './types';
import { checkAttribution } from '../vertical/attribution';
import type { IndustryEvidence } from '../vertical/types';
import type { MethodPack, StructureStep, ValidationResult, Violation } from './types';

/** Output keyed by structure step: { opener: "...", value: "..." }. */
export type GeneratedOutput = Record<string, string>;

const EXCERPT_PAD = 28;

const excerptAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - EXCERPT_PAD);
  const end = Math.min(text.length, index + length + EXCERPT_PAD);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

const checkBanned = (pack: MethodPack, stepKey: string, text: string): Violation[] => {
  const out: Violation[] = [];
  for (const b of pack.banned) {
    // Regexes are shared across calls; reset lastIndex so /g patterns behave.
    const re = new RegExp(b.pattern.source, b.pattern.flags.includes('g') ? b.pattern.flags : `${b.pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({
        stepKey,
        patternId: b.id,
        level: b.level,
        message: `${b.label}. ${b.because}`,
        excerpt: excerptAround(text, m.index, m[0].length),
      });
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
      break; // one report per pattern per step is enough to act on
    }
  }
  return out;
};

/*
  Every violation carries an id, because an id is the whole of what gets
  recorded.

  The apps log `patternId ?? lawId ?? 'empty-step'` and nothing else — the
  excerpt is the member's own copy and does not belong in a log. Length and
  structural failures had neither id, so all three fell through to the same
  fallback: an over-long step, a missing subject line and a step that came
  back empty were recorded as the same thing. Any count built from that says
  "empty step" for a member whose real problem is that they write long.
*/
const checkLength = (step: StructureStep, text: string): Violation[] => {
  if (!step.maxChars || text.length <= step.maxChars) return [];
  return [
    {
      stepKey: step.key,
      patternId: 'over-length',
      level: 'soft',
      message: `${step.label} is ${text.length} characters against a ${step.maxChars} ceiling. Shorter converts better; cut to the single idea this step is for.`,
    },
  ];
};

/**
 * A number attached to a result, with nothing behind it.
 *
 * `checkAttribution` only catches a REAL figure — one that is actually in the
 * evidence vault — appearing without its source. It has no way to catch a
 * number that is not real at all, because there is nothing to compare it
 * against. That gap shipped a fabricated "18 new patient bookings" and an
 * invented "$500 to $1500 per month" past every existing check, on a lead
 * whose case-study vault and evidence were both deliberately empty.
 *
 * So: when the caller confirms there is no real proof behind this generation
 * (`hasProof: false`), any number shaped like a business result is a hard
 * violation, full stop. `substantiateOrCut` already says this in the prompt —
 * "if you cannot [substantiate], delete the claim" — but a prompt is a
 * request, not a guarantee. This is the mechanical version of the same rule.
 *
 * Deliberately excludes bare durations ("15-minute call", "a 2pm slot") —
 * those describe the ask, not a claimed outcome, and flagging them would
 * bury the real violations under noise.
 */
const FIGURE_CLAIM = /\$\s?\d[\d,.]*\b|\b\d[\d,.]*\s?%|\b\d[\d,]*\+?\s+(?:\w+\s+){0,2}(?:patients?|bookings?|appointments?|clients?|customers?|leads?|calls?|reviews?|sign-?ups?|sales|deals?|meetings?|replies?|responses?|conversions?)\b/gi;

const checkUnsubstantiatedFigures = (stepKey: string, text: string): Violation[] => {
  const out: Violation[] = [];
  const re = new RegExp(FIGURE_CLAIM.source, FIGURE_CLAIM.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      stepKey,
      patternId: 'unsubstantiated-figure',
      level: 'hard',
      message:
        `"${m[0]}" claims a specific result with nothing behind it — there is no case study or ` +
        `industry evidence for this generation. Delete the number, or add real proof in Settings and regenerate.`,
      excerpt: excerptAround(text, m.index, m[0].length),
    });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
};

/**
 * Pricing, in any form, mentioned in outreach.
 *
 * Not conditional on proof — the doctrine bans this outright ("Names and
 * shapes only. Pricing does not belong in outreach"), whether or not the
 * number behind it is real.
 *
 * Any dollar figure is banned outright rather than only ones next to "per
 * month" — a live generation phrased its invented pricing as "500 to 1,500
 * dollars monthly" with no `$` and no "per", which the first version of this
 * pattern missed entirely. Caught retroactively; broadened so the next
 * rephrasing doesn't get the same free pass.
 */
const PRICING_MENTION = /\$\s?\d[\d,.]*|\b\d[\d,.]*\s*(?:dollars?|usd)\b|\b(?:per|\/|a)\s*(?:month|year|mo|yr)\b|\bmonthly\b|\byearly\b|\bpricing\s+(?:ranges?|starts?|is)\b|\bstarting\s+at\s+\$/i;

/** Extra material the output must be graded against, beyond the pack itself. */
export interface ValidateOptions {
  /**
   * The industry evidence sent with this prompt.
   *
   * Passed in rather than read from storage so the validator grades what was
   * ACTUALLY sent. Grading against whatever the vault holds now would flag copy
   * generated before a row was added, and miss copy generated before one was
   * deleted.
   */
  evidence?: IndustryEvidence[];
  /**
   * Whether this generation had a real case study, industry evidence, or
   * legacy wins/testimonials text behind it — i.e. `!proofEmpty` from
   * `buildChannelPrompt`. Required, not defaulted true, because the safe
   * assumption when a caller does not say is that nothing backs this copy.
   */
  hasProof: boolean;
}

export const validateOutput = (
  pack: MethodPack,
  output: GeneratedOutput,
  options: ValidateOptions = { hasProof: true },
): ValidationResult => {
  const violations: Violation[] = [];

  for (const step of pack.structure) {
    const text = (output[step.key] ?? '').trim();
    if (!text) {
      violations.push({
        stepKey: step.key,
        patternId: 'empty-step',
        level: 'hard',
        message: `${step.label} came back empty. Regenerate.`,
      });
      continue;
    }
    violations.push(...checkBanned(pack, step.key, text));
    violations.push(...checkLength(step, text));
    violations.push(...checkAttribution(step.key, text, options.evidence ?? []));
    if (!options.hasProof) violations.push(...checkUnsubstantiatedFigures(step.key, text));

    // Subjects are graded too, and against the same banned patterns.
    //
    // Two of those patterns exist specifically for this field — the fabricated
    // 'Re:' and "quick question" — and both were written to match a bare
    // subject with no "subject:" prefix. Skipping the key here would leave the
    // one field they were designed for as the only one nothing checks.
    if (!step.subject) continue;
    const sKey = subjectKey(step.key);
    const subject = (output[sKey] ?? '').trim();
    if (!subject) {
      violations.push({
        stepKey: sKey,
        patternId: 'empty-subject',
        level: 'hard',
        message: `${step.label} came back with no subject line. Regenerate.`,
      });
      continue;
    }
    violations.push(...checkBanned(pack, sKey, subject));
    violations.push(...checkAttribution(sKey, subject, options.evidence ?? []));
    if (!options.hasProof) violations.push(...checkUnsubstantiatedFigures(sKey, subject));
    violations.push(
      ...checkLength(
        { ...step, key: sKey, label: `${step.label} subject`, maxChars: step.subject.maxChars },
        subject,
      ),
    );
  }

  const hardCount = violations.filter((v) => v.level === 'hard').length;
  const softCount = violations.length - hardCount;
  return { ok: hardCount === 0, hardCount, softCount, violations };
};

/**
 * Patterns every channel bans, merged into each pack. These come from the
 * outreach doctrine in the playbooks and hold regardless of channel.
 */
export const UNIVERSAL_BANNED = [
  {
    id: 'em-dash',
    label: 'Em dash or en dash',
    pattern: /[—–]/,
    because: 'Reads as machine-written to anyone who has seen AI copy. Use a comma, a period or a colon.',
    level: 'hard' as const,
  },
  {
    id: 'hedging',
    label: 'Hedging or supplication',
    pattern: /\b(?:just checking in|hope this finds you well|sorry to bother|worth 30 seconds|hope this isn'?t weird|quick question)\b/i,
    because: 'A sophisticated buyer reads hedging as insecurity and discounts you. Write with a flat, confident spine.',
    level: 'hard' as const,
  },
  {
    id: 'negative-plant',
    label: 'Negated negative',
    pattern: /\b(?:not (?:pitching|selling|trying to sell)|no fluff|not a sales)\b/i,
    because: 'The mind drops the "not" and keeps the noun. Saying "not pitching" makes them think pitch. Rewrite positively.',
    level: 'hard' as const,
  },
  {
    id: 'ai-tell',
    label: 'Generic AI phrasing',
    pattern: /\b(?:in today'?s fast-paced|leverage synergies|I hope this email finds you|delve into|it'?s worth noting that)\b/i,
    because: 'Filler that signals a template. Every sentence should carry something only this sender could write.',
    level: 'soft' as const,
  },
  {
    id: 'emoji',
    label: 'Emoji',
    pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    because: 'Wrong register for a senior B2B buyer, and a spam signal in cold email.',
    level: 'soft' as const,
  },
  {
    id: 'pricing-mention',
    label: 'Pricing mentioned',
    pattern: PRICING_MENTION,
    because: 'Names and shapes only — pricing does not belong in outreach, whether or not the figure is real.',
    level: 'hard' as const,
  },
];
