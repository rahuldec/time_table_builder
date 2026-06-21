import { useEffect, useState, useCallback } from "react";
import { supabase } from "./supabase";

// A small generic helper so every "manage list of X" page doesn't repeat
// the same fetch/add/delete code. Works against any Supabase table.
export function useTable<T extends { id: string }>(
  table: string,
  select: string = "*",
  filter?: Record<string, string>
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filterKey = JSON.stringify(filter ?? {});

  const refresh = useCallback(async () => {
    setLoading(true);
    let query = supabase.from(table).select(select);
    if (filter) {
      for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
    }
    const { data, error } = await query;
    if (error) setError(error.message);
    else {
      setError(null);
      setData((data as unknown as T[]) ?? []);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, select, filterKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async (row: Record<string, unknown>) => {
    const { error } = await supabase.from(table).insert(row);
    if (error) throw new Error(error.message);
    await refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw new Error(error.message);
    await refresh();
  };

  return { data, loading, error, refresh, add, remove };
}
