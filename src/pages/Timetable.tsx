import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

interface School {
  id: string;
  working_days: string[];
  periods_per_day: number;
  blocked_periods: number[];
}
interface Option {
  id: string;
  label: string;
}
interface EntryRow {
  day: string;
  period: number;
  subjects: { name: string } | null;
  teachers: { name: string } | null;
  class_sections: { class_name: string; section_name: string } | null;
  rooms: { name: string } | null;
}

type ViewMode = "class" | "teacher" | "room";

export default function Timetable() {
  const [school, setSchool] = useState<School | null>(null);
  const [mode, setMode] = useState<ViewMode>("class");
  const [options, setOptions] = useState<Option[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [noData, setNoData] = useState(false);

  // load school + the list of classes/teachers/rooms to choose from
  useEffect(() => {
    (async () => {
      const { data: schoolRow } = await supabase.from("schools").select("*").limit(1).maybeSingle();
      if (!schoolRow) return;
      setSchool(schoolRow as School);

      const table = mode === "class" ? "class_sections" : mode === "teacher" ? "teachers" : "rooms";
      const { data } = await supabase.from(table).select("*").eq("school_id", schoolRow.id);
      const opts: Option[] = (data ?? []).map((row: any) =>
        mode === "class"
          ? { id: row.id, label: `${row.class_name} - ${row.section_name}` }
          : { id: row.id, label: row.name }
      );
      setOptions(opts);
      setSelectedId(opts[0]?.id ?? "");
    })();
  }, [mode]);

  // load the latest-version timetable entries for whichever item is selected
  useEffect(() => {
    if (!school || !selectedId) return;
    (async () => {
      setLoading(true);
      setNoData(false);

      const { data: maxVersionRow } = await supabase
        .from("timetable_entries")
        .select("version")
        .eq("school_id", school.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!maxVersionRow) {
        setEntries([]);
        setNoData(true);
        setLoading(false);
        return;
      }

      const filterCol = mode === "class" ? "class_section_id" : mode === "teacher" ? "teacher_id" : "room_id";
      const { data, error } = await supabase
        .from("timetable_entries")
        .select("day, period, subjects(name), teachers(name), class_sections(class_name,section_name), rooms(name)")
        .eq("school_id", school.id)
        .eq("version", maxVersionRow.version)
        .eq(filterCol, selectedId);

      if (!error) setEntries((data as unknown as EntryRow[]) ?? []);
      setLoading(false);
    })();
  }, [school, selectedId, mode]);

  if (!school) return <p className="p-6 text-sm text-gray-500">Loading...</p>;

  const grid: Record<string, Record<number, EntryRow>> = {};
  for (const day of school.working_days) grid[day] = {};
  for (const e of entries) grid[e.day][e.period] = e;

  const cellLabel = (e: EntryRow | undefined) => {
    if (!e) return null;
    if (mode === "class") return `${e.subjects?.name ?? ""} · ${e.teachers?.name ?? ""}`;
    if (mode === "teacher")
      return `${e.subjects?.name ?? ""} · ${e.class_sections ? `${e.class_sections.class_name}-${e.class_sections.section_name}` : ""}`;
    return `${e.subjects?.name ?? ""} · ${e.class_sections ? `${e.class_sections.class_name}-${e.class_sections.section_name}` : ""}`;
  };

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="card space-y-3">
        <div className="flex gap-2 flex-wrap items-center">
          <div className="flex gap-1">
            {(["class", "teacher", "room"] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 rounded-full text-sm border capitalize ${
                  mode === m ? "bg-[var(--ink-teal)] text-white border-[var(--ink-teal)]" : "border-gray-300"
                }`}
              >
                {m} view
              </button>
            ))}
          </div>
          <select className="input ml-auto" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading timetable...</p>
      ) : noData ? (
        <p className="text-sm text-gray-500">No timetable has been generated yet — go to the Generate page first.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="p-2 text-left text-gray-500">Day</th>
                {Array.from({ length: school.periods_per_day }, (_, i) => i + 1).map((p) => (
                  <th key={p} className="p-2 text-gray-500">
                    {school.blocked_periods?.includes(p) ? `Break` : `P${p}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {school.working_days.map((day) => (
                <tr key={day} className="border-t border-gray-100">
                  <td className="p-2 font-semibold" style={{ color: "var(--ink-teal)" }}>{day}</td>
                  {Array.from({ length: school.periods_per_day }, (_, i) => i + 1).map((p) => {
                    const isBreak = school.blocked_periods?.includes(p);
                    const entry = grid[day]?.[p];
                    return (
                      <td
                        key={p}
                        className={`p-2 text-center align-top ${isBreak ? "bg-gray-50 text-gray-300" : ""}`}
                      >
                        {isBreak ? "—" : entry ? (
                          <div className="rounded-md px-1 py-1" style={{ background: "var(--ink-teal-light)" }}>
                            {cellLabel(entry)}
                          </div>
                        ) : (
                          <span className="text-gray-300">free</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
