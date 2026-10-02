/*
  # User context columns: give "About you / Wins / Testimonials" a database home

  1. Why this exists

     The LinkedIn/cold-email/Upwork generators have always been grounded in the
     user's own context (`src/lib/userContext.ts`), but that context lived ONLY
     in the browser's localStorage. That was fine while the only thing that ever
     built a generation prompt was the browser itself.

     It stops being fine the moment a second caller needs to build the same
     prompt: n8n's "Generate DM Sequences A/B/C" workflows call the
     `generate-outreach` edge function directly, server-to-server, with no
     browser and therefore no localStorage. Without a DB-side copy of this
     context, the edge function cannot build the same prompt the app builds,
     and the two paths drift — which is the exact bug this migration exists to
     end.

  2. Why these three columns, and why nullable

     `about`, `wins`, `testimonials` mirror `UserContext` in
     `src/lib/userContext.ts` exactly. All three stay nullable: a user who has
     never opened Settings has written nothing, and that is a normal, common
     state, not a defect to enforce against.

  3. What this migration does NOT do

     It does not change where the browser reads from. `loadUserContext` keeps
     reading localStorage, unchanged, so the existing UI behaves exactly as
     before. `saveUserContext` is updated (in application code, not here) to
     ALSO write these columns, so the browser's localStorage write becomes the
     instant client cache and this table becomes the thing a server process can
     read.

  No RLS changes: these columns inherit the existing owner-scoped policies on
  `users`.

  Idempotent, safe to run more than once.
*/

ALTER TABLE users ADD COLUMN IF NOT EXISTS about text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wins text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS testimonials text;

COMMENT ON COLUMN users.about IS
  'Mirrors UserContext.about from src/lib/userContext.ts. The browser localStorage copy remains the source the UI reads; this column exists so a server-side caller (the generate-outreach edge function, called directly by n8n) can build the same prompt the app builds.';
COMMENT ON COLUMN users.wins IS
  'Mirrors UserContext.wins from src/lib/userContext.ts. See the comment on users.about.';
COMMENT ON COLUMN users.testimonials IS
  'Mirrors UserContext.testimonials from src/lib/userContext.ts. See the comment on users.about.';
