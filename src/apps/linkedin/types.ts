export type LeadStatus = 'new' | 'requested' | 'connected' | 'replied' | 'meeting';

/**
 * Scraped LinkedIn signals for a lead, written by the sourcing pipeline.
 * Kept separate from `outreach` — that column is the generated copy, and a
 * profile snapshot written there reads as an empty flow. Every field is
 * optional because LinkedIn does not always expose them.
 */
export interface LeadProfile {
  city_location?: string;
  connections?: number;
  followers?: number;
  recently_active?: boolean;
  is_decision_maker?: boolean;
  qualification_passed?: boolean;
  source?: string;
}

export interface OutreachFlow {
  connection_note: string;
  blank_strategy: string;
  opener: string;
  value: string;
  cta: string;
  bump: string;
  reply_positive: string;
  reply_objection: string;
}

export interface Lead {
  id: string;
  user_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  company_name?: string | null;
  industry?: string | null;
  linkedin_url: string;
  company_linkedin_url?: string | null;
  company_website?: string | null;
  potential_services?: string | null;
  outreach?: OutreachFlow | null;
  profile?: LeadProfile | null;
  /**
   * Which sequence steps have been sent. Stored as { stepKey: isoTimestamp }
   * so later steps can be scheduled from when the previous one actually went
   * out. Older rows may still hold the legacy `string[]` shape (sent, but no
   * timestamp) — normalizeSentSteps() in LinkedInApp.tsx handles both.
   */
  sent_steps?: Record<string, string> | string[] | null;
  status: LeadStatus;
  /** When they accepted the connection request. Anchors the sequence due dates. */
  accepted_at?: string | null;
  /** When they replied. Re-anchors the two reply-branch due dates. */
  replied_at?: string | null;
  created_at: string;
  updated_at: string;
}
