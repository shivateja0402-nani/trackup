import React, { useState } from 'react';
import {
  ArrowLeft, Linkedin, Plus, Sparkles, Copy, Check, Trash2, Loader2, ExternalLink, X,
  ThumbsUp, ThumbsDown, Lightbulb, Clock, MessageSquare,
  MapPin, Users, UserPlus, Activity, BadgeCheck,
} from 'lucide-react';
import { useLeads } from './useLeads';
import { Lead, LeadProfile, LeadStatus, OutreachFlow } from './types';
import { supabase } from '../../lib/supabase';
import { loadAIConfig } from '../../lib/aiConfig';
import { loadUserContext, contextToPrompt } from '../../lib/userContext';

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New', requested: 'Requested', connected: 'Connected', replied: 'Replied', meeting: 'Meeting',
};
const STATUS_ORDER: LeadStatus[] = ['new', 'requested', 'connected', 'replied', 'meeting'];

// `gapDays` counts from when the PREVIOUS step actually went out — opener
// anchors on accepting (status → connected), since that's the real event that
// starts the clock; everything after it anchors on the prior step's own sent
// timestamp, not a fixed offset from acceptance. That way a late opener pushes
// value/cta/bump's dates with it instead of leaving them all stuck "overdue"
// the moment they were computed. The connection request itself has no date —
// it goes out before there's anything to anchor on.
const SEQUENCE: { key: keyof OutreachFlow; title: string; gapDays: number | null }[] = [
  { key: 'connection_note', title: '1 · Connection request', gapDays: null },
  { key: 'opener', title: '2 · Opener (after they accept)', gapDays: 0 },
  { key: 'value', title: '3 · Value', gapDays: 2 },
  { key: 'cta', title: '4 · Call to action', gapDays: 2 },
  { key: 'bump', title: '5 · Bump (no reply)', gapDays: 3 },
];

// The reply branches get due dates too. They anchor on `replied_at` once a reply
// is logged — answer within a day — and fall back to the connection anchor before
// that, so every step in the flow always carries a date.
const REPLY_DUE_AFTER_DAYS = 1;

// --- Due dates ---------------------------------------------------------------

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const dueDateFor = (acceptedAt: string, offsetDays: number): Date =>
  new Date(new Date(acceptedAt).getTime() + offsetDays * DAY_MS);

/** Whole calendar days from today until `date`. Negative means overdue. */
const daysUntil = (date: Date): number =>
  Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / DAY_MS);

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

type DueTone = 'overdue' | 'today' | 'upcoming';

const describeDue = (date: Date): { label: string; tone: DueTone } => {
  const diff = daysUntil(date);
  if (diff < 0) return { label: `Overdue ${-diff}d · ${shortDate(date)}`, tone: 'overdue' };
  if (diff === 0) return { label: `Due today · ${shortDate(date)}`, tone: 'today' };
  if (diff === 1) return { label: `Due tomorrow · ${shortDate(date)}`, tone: 'upcoming' };
  return { label: `Due in ${diff}d · ${shortDate(date)}`, tone: 'upcoming' };
};

type SentSteps = Record<string, string>;

/**
 * `sent_steps` used to be a plain string[] (sent, but no record of when).
 * Legacy rows in that shape fall back to `accepted_at` as their sent time —
 * the best guess available, and what the old fixed-offset logic assumed
 * anyway — so they don't suddenly show every downstream step as "waiting".
 */
const normalizeSentSteps = (raw: Lead['sent_steps'], acceptedAt: string | null | undefined): SentSteps => {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const at = acceptedAt ?? new Date().toISOString();
    return Object.fromEntries(raw.map((key) => [key, at]));
  }
  return raw;
};

type StepSchedule = { due: Date | null; blockedByTitle: string | null };

/**
 * Chains each step's due date off the previous step's ACTUAL sent timestamp
 * (opener chains off `accepted_at` instead, since that's a real event too).
 * A step with no computable anchor yet — its predecessor hasn't been sent —
 * comes back with `due: null` and the predecessor's title, so the UI can show
 * "waiting on X" instead of a stale, already-overdue date.
 */
const computeSequenceSchedule = (lead: Lead, sentSteps: SentSteps): Record<string, StepSchedule> => {
  const schedule: Record<string, StepSchedule> = {};
  for (let i = 0; i < SEQUENCE.length; i++) {
    const step = SEQUENCE[i];
    if (step.gapDays === null) { schedule[step.key] = { due: null, blockedByTitle: null }; continue; }
    const prev = SEQUENCE[i - 1];
    const anchor = i === 1 ? lead.accepted_at ?? null : prev ? sentSteps[prev.key] ?? null : null;
    schedule[step.key] = anchor
      ? { due: dueDateFor(anchor, step.gapDays), blockedByTitle: null }
      : { due: null, blockedByTitle: i === 1 ? null : prev?.title.replace(/^\d+ · /, '') ?? null };
  }
  return schedule;
};

/** The earliest unsent step that has a due date, for the list summary. */
const nextDueStep = (lead: Lead): { title: string; due: Date | null; blockedByTitle: string | null } | null => {
  if (!lead.outreach || !lead.accepted_at) return null;
  const sentSteps = normalizeSentSteps(lead.sent_steps, lead.accepted_at);
  const schedule = computeSequenceSchedule(lead, sentSteps);
  for (const step of SEQUENCE) {
    if (step.gapDays === null || sentSteps[step.key]) continue;
    if (!lead.outreach[step.key]) continue;
    return { title: step.title.replace(/^\d+ · /, ''), ...schedule[step.key] };
  }
  return null;
};

const DUE_BADGE_CLASS: Record<DueTone, string> = {
  overdue: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  today: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  upcoming: 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300',
};

// --- Profile snapshot --------------------------------------------------------

const compactNumber = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);

/**
 * The scraped LinkedIn signals, as chips. Only renders what LinkedIn actually
 * exposed — a missing follower count shows nothing rather than a zero.
 */
const ProfileChips: React.FC<{ profile: LeadProfile }> = ({ profile }) => {
  const chips: { key: string; label: string; icon: React.ReactNode; strong?: boolean }[] = [];

  if (profile.city_location) {
    chips.push({ key: 'loc', label: profile.city_location, icon: <MapPin className="w-3 h-3" /> });
  }
  if (typeof profile.connections === 'number') {
    chips.push({ key: 'conn', label: `${compactNumber(profile.connections)} connections`, icon: <Users className="w-3 h-3" /> });
  }
  if (typeof profile.followers === 'number') {
    chips.push({ key: 'foll', label: `${compactNumber(profile.followers)} followers`, icon: <UserPlus className="w-3 h-3" /> });
  }
  if (profile.recently_active) {
    chips.push({ key: 'active', label: 'Recently active', icon: <Activity className="w-3 h-3" />, strong: true });
  }
  if (profile.is_decision_maker) {
    chips.push({ key: 'dm', label: 'Decision-maker', icon: <BadgeCheck className="w-3 h-3" />, strong: true });
  }

  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
      {chips.map((c) => (
        <span
          key={c.key}
          className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
            c.strong
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300'
          }`}
        >
          {c.icon}
          {c.label}
        </span>
      ))}
    </div>
  );
};

export const LinkedInApp: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const { leads, loading, addLead, updateLead, deleteLead } = useLeads();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<LeadStatus | null>(null);
  const selected = leads.find((l) => l.id === selectedId) ?? null;

  const counts = STATUS_ORDER.reduce(
    (acc, s) => ({ ...acc, [s]: leads.filter((l) => l.status === s).length }),
    {} as Record<LeadStatus, number>,
  );
  const visibleLeads = filter ? leads.filter((l) => l.status === filter) : leads;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-linkedin-50/50 to-white dark:from-gray-900 dark:to-gray-950">
      <header className="border-b border-linkedin-100 dark:border-gray-800 bg-white/70 dark:bg-gray-900/70 backdrop-blur-md flex-shrink-0">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={onExit} className="flex items-center text-sm font-semibold text-gray-600 dark:text-gray-300 hover:text-linkedin-600">
              <ArrowLeft className="w-4 h-4 mr-1.5" /> All apps
            </button>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-linkedin-500 flex items-center justify-center">
                <Linkedin className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-gray-900 dark:text-white">LinkedIn DM Generator</span>
            </div>
          </div>
          <button onClick={() => setShowAdd(true)} className="inline-flex items-center px-4 py-2 rounded-xl text-sm font-semibold text-white bg-linkedin-600 hover:bg-linkedin-700 shadow-sm">
            <Plus className="w-4 h-4 mr-1.5" /> Add lead
          </button>
        </div>
      </header>

      <div className="flex-1 max-w-6xl w-full mx-auto px-6 py-6 grid lg:grid-cols-[320px_1fr] gap-6 overflow-hidden">
        <div className="overflow-y-auto pr-1">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Leads ({leads.length})</h2>
            {filter && (
              <button onClick={() => setFilter(null)} className="text-[11px] font-semibold text-linkedin-600 hover:text-linkedin-700">
                Clear filter
              </button>
            )}
          </div>

          {/* Pipeline at a glance. Click a stage to filter, click again to clear. */}
          {leads.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {STATUS_ORDER.map((s) => {
                const active = filter === s;
                return (
                  <button
                    key={s}
                    onClick={() => setFilter(active ? null : s)}
                    aria-pressed={active}
                    title={`${counts[s]} ${STATUS_LABELS[s].toLowerCase()}`}
                    className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg border transition-colors ${
                      active
                        ? 'bg-linkedin-600 border-linkedin-600 text-white'
                        : counts[s] === 0
                          ? 'bg-transparent border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600'
                          : 'bg-white dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-linkedin-300'
                    }`}
                  >
                    {STATUS_LABELS[s]}
                    <span className={active ? 'text-white' : 'text-gray-900 dark:text-white font-bold'}>{counts[s]}</span>
                  </button>
                );
              })}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 p-4">Loading…</div>
          ) : leads.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 card-modern p-6 text-center">
              No leads yet. Click <span className="font-semibold">Add lead</span>.
            </div>
          ) : visibleLeads.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 card-modern p-6 text-center">
              No leads in <span className="font-semibold">{STATUS_LABELS[filter as LeadStatus]}</span>.
            </div>
          ) : (
            <div className="space-y-2">
              {visibleLeads.map((lead) => (
                <button
                  key={lead.id}
                  onClick={() => setSelectedId(lead.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    selectedId === lead.id
                      ? 'border-linkedin-400 bg-linkedin-50 dark:bg-linkedin-900/20'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 hover:border-linkedin-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-gray-900 dark:text-white truncate">{lead.name}</span>
                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-linkedin-100 text-linkedin-700 dark:bg-linkedin-900/40 dark:text-linkedin-300">
                      {STATUS_LABELS[lead.status]}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {[lead.job_title, lead.company_name].filter(Boolean).join(' · ') || lead.linkedin_url}
                  </p>
                  {lead.outreach && (() => {
                    const next = nextDueStep(lead);
                    if (!next) {
                      return (
                        <p className="text-[11px] text-linkedin-600 dark:text-linkedin-400 mt-1 flex items-center">
                          <Sparkles className="w-3 h-3 mr-1" /> Flow ready
                        </p>
                      );
                    }
                    if (!next.due) {
                      return (
                        <p className="text-[11px] mt-1 flex items-center gap-1.5">
                          <Clock className="w-3 h-3 flex-shrink-0 text-gray-400" />
                          <span className="font-semibold text-gray-500 dark:text-gray-400">{next.title}</span>
                          <span className="text-gray-400 dark:text-gray-500 truncate">
                            waiting on {next.blockedByTitle ?? 'a prior step'}
                          </span>
                        </p>
                      );
                    }
                    const { label, tone } = describeDue(next.due);
                    return (
                      <p className="text-[11px] mt-1 flex items-center gap-1.5">
                        <Clock className={`w-3 h-3 flex-shrink-0 ${tone === 'overdue' ? 'text-red-500' : tone === 'today' ? 'text-amber-500' : 'text-gray-400'}`} />
                        <span className={`font-semibold ${tone === 'overdue' ? 'text-red-600 dark:text-red-400' : tone === 'today' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
                          {next.title}
                        </span>
                        <span className="text-gray-400 dark:text-gray-500 truncate">{label}</span>
                      </p>
                    );
                  })()}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-y-auto">
          {selected ? (
            <LeadDetail
              key={selected.id}
              lead={selected}
              onUpdate={updateLead}
              onDelete={async (id) => { await deleteLead(id); setSelectedId(null); }}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-center text-gray-400 card-modern p-10">
              <div>
                <Linkedin className="w-10 h-10 mx-auto mb-3 text-linkedin-300" />
                <p>Select a lead to generate and manage their outreach flow.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showAdd && <AddLeadModal onClose={() => setShowAdd(false)} onAdd={addLead} />}
    </div>
  );
};

// --- Lead detail + flow ------------------------------------------------------

const LeadDetail: React.FC<{
  lead: Lead;
  onUpdate: (id: string, updates: Partial<Lead>) => void;
  onDelete: (id: string) => void;
}> = ({ lead, onUpdate, onDelete }) => {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const flow = lead.outreach;
  const sentSteps = normalizeSentSteps(lead.sent_steps, lead.accepted_at);
  const sequenceSchedule = computeSequenceSchedule(lead, sentSteps);

  const copy = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /* */ }
  };

  // Recording exactly when a step went out is what lets the next step's date
  // shift with it — toggling off clears that step's timestamp again.
  const toggleSent = (key: string) => {
    const next = { ...sentSteps };
    if (next[key]) delete next[key];
    else next[key] = new Date().toISOString();
    onUpdate(lead.id, { sent_steps: next });
  };

  // Moving to `connected` starts the clock. Moving back to new/requested means
  // they hadn't actually accepted, so the anchor is cleared. `replied` and
  // `meeting` keep it — they are further along, not backwards.
  const handleStatusChange = (status: LeadStatus) => {
    const now = new Date().toISOString();
    const updates: Partial<Lead> = { status };

    if (status === 'connected' && !lead.accepted_at) updates.accepted_at = now;
    else if (status === 'new' || status === 'requested') updates.accepted_at = null;

    // A reply implies they accepted, so backfill the connection anchor if the
    // lead jumped straight to `replied` without passing through `connected`.
    if ((status === 'replied' || status === 'meeting') && !lead.replied_at) updates.replied_at = now;
    else if (status !== 'replied' && status !== 'meeting') updates.replied_at = null;
    if (updates.replied_at && !lead.accepted_at) updates.accepted_at = now;

    onUpdate(lead.id, updates);
  };

  // Reply branches count from the reply once there is one; before that they sit
  // on the connection timeline so they still show a date.
  const replyAnchor = lead.replied_at ?? lead.accepted_at;

  const handleGenerate = async () => {
    const cfg = loadAIConfig();
    if (!cfg) {
      setError('Add your AI provider and key first (Settings, top-right on the Ember home screen).');
      return;
    }
    setError('');
    setGenerating(true);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<OutreachFlow>('generate-outreach', {
        body: {
          lead: {
            name: lead.name, job_title: lead.job_title, company_name: lead.company_name,
            industry: lead.industry, linkedin_url: lead.linkedin_url,
            company_website: lead.company_website, potential_services: lead.potential_services,
            profile: lead.profile ?? undefined,
          },
          context: contextToPrompt(loadUserContext()),
          provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey,
        },
      });
      if (fnError) {
        let message = fnError.message;
        const ctx = (fnError as { context?: Response }).context;
        if (ctx?.json) { const b = await ctx.json().catch(() => null); if (b?.error) message = b.error; }
        throw new Error(message);
      }
      if (!data) throw new Error('No response from the generator.');
      onUpdate(lead.id, { outreach: data });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate outreach.');
    } finally {
      setGenerating(false);
    }
  };

  // `hasSchedule` false = no date at all (only the connection request, which
  // goes out before there's anything to anchor on). `due`/`blockedByTitle`
  // come precomputed from computeSequenceSchedule so this only renders them.
  const Step: React.FC<{
    id: string; title: string; text: string;
    track?: boolean; tone?: 'positive' | 'objection';
    hasSchedule?: boolean; due?: Date | null; blockedByTitle?: string | null; awaitingReply?: boolean;
  }> = ({ id, title, text, track = true, tone, hasSchedule = false, due = null, blockedByTitle = null, awaitingReply = false }) => {
    const isSent = Boolean(sentSteps[id]);

    const schedule = (() => {
      if (!hasSchedule) return null;
      if (isSent) {
        return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">Sent</span>;
      }
      if (blockedByTitle) {
        return <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500">Waiting on {blockedByTitle}</span>;
      }
      if (!due) {
        return <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500">Scheduled once they accept</span>;
      }
      const { label, tone: dueTone } = describeDue(due);
      return (
        <span className="inline-flex items-center gap-1.5">
          {awaitingReply && (
            <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 inline-flex items-center">
              <MessageSquare className="w-3 h-3 mr-1" /> if they reply
            </span>
          )}
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${DUE_BADGE_CLASS[dueTone]}`}>{label}</span>
        </span>
      );
    })();

    return (
      <div className={`card-modern p-4 ${tone === 'positive' ? 'border-l-4 border-l-green-400' : tone === 'objection' ? 'border-l-4 border-l-amber-400' : ''}`}>
        <div className="flex items-center justify-between mb-2 gap-3">
          <h4 className="font-semibold text-sm text-gray-900 dark:text-white flex items-center min-w-0">
            {tone === 'positive' && <ThumbsUp className="w-4 h-4 mr-1.5 flex-shrink-0 text-green-500" />}
            {tone === 'objection' && <ThumbsDown className="w-4 h-4 mr-1.5 flex-shrink-0 text-amber-500" />}
            <span className="truncate">{title}</span>
          </h4>
          <div className="flex items-center gap-3 flex-shrink-0">
            {schedule}
            {track && (
              <label className="flex items-center text-xs text-gray-500 cursor-pointer select-none">
                <input type="checkbox" className="mr-1.5 accent-linkedin-600" checked={isSent} onChange={() => toggleSent(id)} />
                Sent
              </label>
            )}
            {text && (
              <button onClick={() => copy(text, id)} className="text-xs font-medium text-linkedin-600 hover:text-linkedin-700 inline-flex items-center">
                {copied === id ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                {copied === id ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{text}</p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="card-modern p-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">{lead.name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">{[lead.job_title, lead.company_name].filter(Boolean).join(' · ')}</p>
            <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-xs font-medium text-linkedin-600 hover:text-linkedin-700 mt-2">
              <ExternalLink className="w-3.5 h-3.5 mr-1" /> LinkedIn profile
            </a>
            {lead.profile && <ProfileChips profile={lead.profile} />}
          </div>
          <button onClick={() => onDelete(lead.id)} className="p-2 text-gray-400 hover:text-red-500" aria-label="Delete lead">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <select value={lead.status} onChange={(e) => handleStatusChange(e.target.value as LeadStatus)} className="input-modern !py-2 !w-auto text-sm">
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <button onClick={handleGenerate} disabled={generating} className="inline-flex items-center px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-linkedin-500 to-linkedin-700 hover:from-linkedin-600 hover:to-linkedin-800 shadow-sm disabled:opacity-50">
            {generating ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1.5" />}
            {generating ? 'Generating…' : flow ? 'Regenerate flow' : 'Generate outreach flow'}
          </button>
        </div>
        {lead.accepted_at && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 flex items-center">
            <Clock className="w-3.5 h-3.5 mr-1.5 text-linkedin-500" />
            Accepted {shortDate(new Date(lead.accepted_at))} — each step's date counts from when the one before it was actually sent.
          </p>
        )}
        {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">{error}</div>}
      </div>

      {flow ? (
        <>
          {flow.blank_strategy && (
            <div className="flex items-start text-sm bg-linkedin-50 dark:bg-linkedin-900/20 border border-linkedin-200 dark:border-linkedin-800 rounded-xl p-4 text-linkedin-800 dark:text-linkedin-200">
              <Lightbulb className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
              <span><span className="font-semibold">Strategy:</span> {flow.blank_strategy}</span>
            </div>
          )}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide pt-1">Sequence</h3>
          {SEQUENCE.map((s) => (
            <Step
              key={s.key} id={s.key} title={s.title} text={flow[s.key]}
              hasSchedule={s.gapDays !== null}
              due={sequenceSchedule[s.key].due} blockedByTitle={sequenceSchedule[s.key].blockedByTitle}
            />
          ))}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide pt-1">If they reply</h3>
          <Step
            id="reply_positive" title="Positive / interested" text={flow.reply_positive}
            tone="positive" track={false}
            hasSchedule due={replyAnchor ? dueDateFor(replyAnchor, REPLY_DUE_AFTER_DAYS) : null}
            awaitingReply={!lead.replied_at}
          />
          <Step
            id="reply_objection" title="Objection / not now" text={flow.reply_objection}
            tone="objection" track={false}
            hasSchedule due={replyAnchor ? dueDateFor(replyAnchor, REPLY_DUE_AFTER_DAYS) : null}
            awaitingReply={!lead.replied_at}
          />
        </>
      ) : (
        <div className="card-modern p-8 text-center text-gray-400">
          <Sparkles className="w-8 h-8 mx-auto mb-2 text-linkedin-300" />
          <p>No flow yet — click <span className="font-semibold">Generate outreach flow</span>.</p>
        </div>
      )}
    </div>
  );
};

// --- Add lead modal ----------------------------------------------------------

const AddLeadModal: React.FC<{ onClose: () => void; onAdd: (lead: Partial<Lead>) => Promise<{ error?: string }> }> = ({ onClose, onAdd }) => {
  const [form, setForm] = useState<Partial<Lead>>({ status: 'new' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof Lead, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name?.trim() || !form.linkedin_url?.trim()) { setError('Name and LinkedIn URL are required.'); return; }
    setSaving(true);
    const { error: err } = await onAdd(form);
    setSaving(false);
    if (err) setError(err); else onClose();
  };

  const field = (k: keyof Lead, label: string, type = 'text') => (
    <div>
      <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5">{label}</label>
      <input type={type} value={(form[k] as string) ?? ''} onChange={(e) => set(k, e.target.value)} className="input-modern" />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white">Add lead</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5">Name *</label><input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} className="input-modern" /></div>
            {field('job_title', 'Job title')}
          </div>
          <div><label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5">LinkedIn URL *</label><input type="url" value={form.linkedin_url ?? ''} onChange={(e) => set('linkedin_url', e.target.value)} className="input-modern" /></div>
          <div className="grid grid-cols-2 gap-4">
            {field('company_name', 'Company')}
            {field('industry', 'Industry')}
          </div>
          {field('company_website', 'Company website', 'url')}
          <div>
            <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1.5">Services you could offer them</label>
            <textarea value={form.potential_services ?? ''} onChange={(e) => set('potential_services', e.target.value)} rows={2} className="input-modern resize-none" />
          </div>
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          <button type="submit" disabled={saving} className="w-full px-6 py-3 rounded-xl font-semibold text-white bg-linkedin-600 hover:bg-linkedin-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Add lead'}
          </button>
        </form>
      </div>
    </div>
  );
};
