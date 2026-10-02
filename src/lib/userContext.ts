// User / agency context, woven into every generation so proposals and DMs are
// grounded in the user's real background. Stored in the browser (like the AI key)
// AND, since the `users.about/wins/testimonials` migration, mirrored to the
// database row for the signed-in user.
//
// Why both: the browser copy is what `loadUserContext` reads, so the UI is
// unaffected and instant, exactly as before. The database copy exists because a
// second caller now needs this same context with no browser in the loop at
// all — n8n's "Generate DM Sequences A/B/C" workflows call the
// `generate-outreach` edge function directly, server-to-server, and a server
// process has no localStorage to read. Without a DB copy, that function could
// never build the prompt the app builds, which is the prompt-drift bug this
// migration exists to end.

import { supabase } from './supabase';

export interface UserContext {
  about: string; // who you are / your agency / what you do
  wins: string; // results, metrics, case studies
  testimonials: string; // social proof
}

const STORAGE_KEY = 'ember.userContext';

const EMPTY: UserContext = { about: '', wins: '', testimonials: '' };

export const loadUserContext = (): UserContext => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<UserContext>;
    return {
      about: parsed.about ?? '',
      wins: parsed.wins ?? '',
      testimonials: parsed.testimonials ?? '',
    };
  } catch {
    return EMPTY;
  }
};

/**
 * The localStorage write is synchronous and this function's contract does not
 * change: callers that do not await it keep working exactly as before, and the
 * UI (Settings.tsx) still sees the save as instant.
 *
 * The database write is best-effort and deliberately not awaited by callers
 * that do not want to: a failure here must never block or roll back the
 * localStorage save, because the browser copy is still the thing the app's own
 * UI reads. A signed-out caller (no Supabase session, or no project connected
 * yet) silently skips the DB write, which is correct: there is no `users` row
 * to write to yet.
 */
export const saveUserContext = (context: UserContext): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(context));

  void syncUserContextToDb(context);
};

async function syncUserContextToDb(context: UserContext): Promise<void> {
  try {
    if (!supabase) return;
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData?.user) return;

    const { error } = await supabase
      .from('users')
      .update({
        about: context.about ?? '',
        wins: context.wins ?? '',
        testimonials: context.testimonials ?? '',
      })
      .eq('id', authData.user.id);

    if (error) {
      // Non-fatal: the localStorage save already succeeded and is what the
      // app's own UI reads. Logged so a persistent failure is discoverable
      // without surfacing a disruptive error for what is, from the signed-in
      // user's point of view, a background sync.
      console.error('Could not sync user context to the database:', error);
    }
  } catch (err) {
    console.error('Could not sync user context to the database:', err);
  }
}

/**
 * Who the sender is, and nothing else. This is what generators may be given.
 *
 * `contextToPrompt` must never reach a generator that also receives proof from
 * the vault. It carries wins and testimonials as a free-text blob labelled "use
 * specifics where relevant", which lands in the user prompt while the system
 * prompt is telling the model to use exactly one matched case study and to never
 * state a number that is not on record. The model gets both, and the blob wins
 * because it is closer to the task — so a number nobody vetted, attributed to a
 * client who was never cleared for naming, ends up in the copy.
 *
 * The vault's own empty-vault fallback in `forChannel` already handles the user
 * who has wins and no case studies, and it applies the cap and the framing.
 */
export const senderAbout = (c: UserContext): string => c.about?.trim() ?? '';

/**
 * The full flattened context, including wins and testimonials.
 *
 * Only for callers with no proof pipeline of their own. Prefer `senderAbout`.
 */
export const contextToPrompt = (c: UserContext): string => {
  const parts: string[] = [];
  if (c.about?.trim()) parts.push(`About the sender:\n${c.about.trim()}`);
  if (c.wins?.trim()) parts.push(`My wins & results (use specifics where relevant):\n${c.wins.trim()}`);
  if (c.testimonials?.trim()) parts.push(`Testimonials / social proof:\n${c.testimonials.trim()}`);
  return parts.join('\n\n');
};

export const hasUserContext = (c: UserContext): boolean =>
  Boolean(c.about?.trim() || c.wins?.trim() || c.testimonials?.trim());
