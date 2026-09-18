// Local, browser-only data store. This app has no backend — everything you
// enter in Setup and every generated timetable lives in this browser's
// localStorage. It doesn't sync across devices/browsers, and clearing site
// data wipes it, but it means the whole app is a static site with no
// database to provision.

export type Row = Record<string, unknown> & { id: string };

const STORAGE_KEY = "timetable_builder_db_v1";

// row_id -> embed alias, resolved against the table named by the FK's
// referenced table. Covers every relation Setup/Generate/Timetable read.
const FK_EMBEDS: { column: string; table: string; as: string }[] = [
  { column: "class_section_id", table: "class_sections", as: "class_sections" },
  { column: "subject_id", table: "subjects", as: "subjects" },
  { column: "teacher_id", table: "teachers", as: "teachers" },
  { column: "room_id", table: "rooms", as: "rooms" },
  { column: "teacher_a_id", table: "teachers", as: "teacher_a" },
  { column: "teacher_b_id", table: "teachers", as: "teacher_b" },
];

function readStore(): Record<string, Row[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Row[]>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function embed(store: Record<string, Row[]>, row: Row): Row {
  let out = row;
  for (const { column, table, as } of FK_EMBEDS) {
    if (column in row) {
      const refId = row[column];
      const found = (store[table] ?? []).find((r) => r.id === refId) ?? null;
      out = { ...out, [as]: found };
    }
  }
  return out;
}

export const localDb = {
  select(table: string, filter?: Record<string, string>): Row[] {
    const store = readStore();
    let rows = store[table] ?? [];
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        rows = rows.filter((r) => String(r[k]) === v);
      }
    }
    return rows.map((r) => embed(store, r));
  },

  insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]): Row[] {
    const store = readStore();
    const list = Array.isArray(rows) ? rows : [rows];
    const inserted: Row[] = list.map((r) => ({
      created_at: new Date().toISOString(),
      ...r,
      id: crypto.randomUUID(),
    }));
    store[table] = [...(store[table] ?? []), ...inserted];
    writeStore(store);
    return inserted.map((r) => embed(store, r));
  },

  update(table: string, id: string, patch: Record<string, unknown>): Row | null {
    const store = readStore();
    const rows = store[table] ?? [];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    store[table] = rows;
    writeStore(store);
    return embed(store, rows[idx]);
  },

  remove(table: string, id: string) {
    const store = readStore();
    store[table] = (store[table] ?? []).filter((r) => r.id !== id);
    writeStore(store);
  },

  removeWhere(table: string, filter: Record<string, string>) {
    const store = readStore();
    store[table] = (store[table] ?? []).filter(
      (r) => !Object.entries(filter).every(([k, v]) => String(r[k]) === v)
    );
    writeStore(store);
  },

  maxValue(table: string, column: string, filter?: Record<string, string>): number {
    return this.select(table, filter).reduce((max, r) => Math.max(max, Number(r[column] ?? 0)), 0);
  },
};
