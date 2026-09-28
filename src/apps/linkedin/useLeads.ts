import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Lead } from './types';

export const useLeads = () => {
  const { user } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    // PostgREST caps a single response at its max_rows setting (1000 by
    // default), so a lone select() silently truncates once leads pass that
    // count. Page through with .range() until a page comes back short.
    const PAGE_SIZE = 1000;
    const all: Lead[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error('Error fetching leads:', error);
        break;
      }
      all.push(...((data as Lead[]) ?? []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    setLeads(all);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const addLead = async (lead: Partial<Lead>): Promise<{ error?: string }> => {
    if (!user) return { error: 'You must be signed in.' };
    const { error } = await supabase.from('leads').insert({ ...lead, user_id: user.id });
    if (error) return { error: error.message };
    await fetchLeads();
    return {};
  };

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    // optimistic
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...updates } : l)));
    const { error } = await supabase
      .from('leads')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      console.error('Error updating lead:', error);
      await fetchLeads();
    }
  };

  const deleteLead = async (id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    const { error } = await supabase.from('leads').delete().eq('id', id);
    if (error) {
      console.error('Error deleting lead:', error);
      await fetchLeads();
    }
  };

  return { leads, loading, fetchLeads, addLead, updateLead, deleteLead };
};
