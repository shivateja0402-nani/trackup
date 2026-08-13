/*
  # Lead reply timestamp

  Records when a lead replied. The two reply branches (`reply_positive` /
  `reply_objection`) are due one day after this, so they get a real due date
  like every other step rather than an open-ended "when they reply".

  Before a reply lands they fall back to the `accepted_at` anchor, so every
  step in the flow always shows a date counted from the connection.

  Set by the app when a lead's status moves to `replied`, and cleared if the
  lead is moved back to an earlier status.

  Idempotent.
*/

ALTER TABLE leads ADD COLUMN IF NOT EXISTS replied_at timestamptz;

COMMENT ON COLUMN leads.replied_at IS
  'When the lead replied. Anchors the reply-branch due dates; falls back to accepted_at.';
