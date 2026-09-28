import React from 'react';
import { MapPin, Users, UserPlus, Activity, BadgeCheck } from 'lucide-react';
import type { LeadProfile } from '../../apps/linkedin/types';

const compactNumber = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);

/**
 * The scraped LinkedIn signals, as chips. Only renders what LinkedIn actually
 * exposed — a missing follower count shows nothing rather than a zero.
 */
export const ProfileChips: React.FC<{ profile: LeadProfile }> = ({ profile }) => {
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
