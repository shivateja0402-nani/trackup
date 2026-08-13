/*
  # Lead acceptance timestamp

  Records when a lead accepted the LinkedIn connection request. This is the
  anchor the outreach sequence counts from:

    opener  same day  ·  value  +2d  ·  cta  +4d  ·  bump  +7d

  Set by the app the first time a lead's status moves to `connected`, and
  cleared if the lead is moved back to `new` / `requested` (i.e. they had not
  actually accepted). The reply branches are reactive and have no due date.

  Idempotent.
*/

ALTER TABLE leads ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

COMMENT ON COLUMN leads.accepted_at IS
  'When the lead accepted the connection request. Anchor for outreach step due dates.';
