import { useEffect, useState, useCallback } from "react";
import { localDb } from "./localDb";

// A small generic helper so every "manage list of X" page doesn't repeat
// the same fetch/add/delete code. Works against any table in localDb —
// relations are embedded automatically by FK column, no select string needed.
export function useTable<T extends { id: string }>(
  table: string,
  filter?: Record<string, string>
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error] = useState<string | null>(null);

  const filterKey = JSON.stringify(filter ?? {});

  const refresh = useCallback(async () => {
    setLoading(true);
    setData(localDb.select(table, filter) as unknown as T[]);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filterKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async (row: Record<string, unknown>) => {
    localDb.insert(table, row);
    await refresh();
  };

  const remove = async (id: string) => {
    localDb.remove(table, id);
    await refresh();
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    localDb.update(table, id, patch);
    await refresh();
  };

  return { data, loading, error, refresh, add, remove, update };
}
