import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { localDb } from "../lib/localDb";
import { useTable } from "../lib/useTable";
import { fetchAllSubjectCourseMappings, DEFAULT_ENTITY_ID } from "../lib/academicApi";
import { importAcademicMappings, type ImportSummary } from "../lib/academicImport";

// ===== Types just for what this page reads/writes =====
interface School {
  id: string;
  name: string;
  working_days: string[];
  periods_per_day: number;
  blocked_periods: number[];
}
interface ClassSection {
  id: string;
  class_name: string;
  section_name: string;
}
interface Subject {
  id: string;
  name: string;
  is_lab: boolean;
  included: boolean; // whether this subject is scheduled in the timetable at all
  avoid_first_period: boolean;
  avoid_last_period: boolean;
  allow_repeat_same_day: boolean;
}
interface Teacher {
  id: string;
  name: string;
  max_periods_per_day: number | null;
  max_periods_per_week: number | null;
}
interface TeacherUnavailability {
  id: string;
  teacher_id: string;
  day: string;
  period: number;
}
interface Room {
  id: string;
  name: string;
  room_type: string;
}
interface LessonRequirementRow {
  id: string;
  periods_per_week: number;
  is_lab: boolean;
  days?: string[]; // if non-empty, every period of this requirement must land on one of these days
  day?: string | null; // legacy single-day field, read as a fallback if `days` isn't present
  class_sections: { class_name: string; section_name: string } | null;
  subjects: { name: string; allow_repeat_same_day: boolean } | null;
  teachers: { name: string } | null;
  rooms: { name: string } | null;
}
interface AvoidAdjacentPairRow {
  id: string;
  teacher_a_id: string;
  teacher_b_id: string;
  teacher_a: { name: string } | null;
  teacher_b: { name: string } | null;
}

const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// =====================================================================
// School settings — there is exactly one row in `schools` for now.
// =====================================================================
function SchoolSettings({ school, onSaved }: { school: School | null; onSaved: () => void }) {
  const [name, setName] = useState(school?.name ?? "");
  const [days, setDays] = useState<string[]>(school?.working_days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  const [periodsPerDay, setPeriodsPerDay] = useState(school?.periods_per_day ?? 8);
  const [blockedPeriods, setBlockedPeriods] = useState(
    (school?.blocked_periods ?? []).join(", ")
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDay = (d: string) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    // Without at least one working day and at least one period/day, there's
    // no slot the generator could ever place anything into — it would just
    // run and report everything unplaced, with no clue why. Catch it here
    // instead.
    if (days.length === 0) {
      setError("Pick at least one working day — with none selected, nothing can ever be scheduled.");
      return;
    }
    if (!Number.isInteger(periodsPerDay) || periodsPerDay < 1) {
      setError("Periods per day must be a whole number of at least 1.");
      return;
    }

    // Out-of-range break periods aren't as destructive as the two checks
    // above (they just don't do anything, rather than breaking generation
    // entirely), so this one clamps and saves rather than blocking — but
    // still says so, since a silently-ignored typo is confusing.
    const requested = blockedPeriods
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    const outOfRange = requested.filter((n) => n < 1 || n > periodsPerDay);
    const blocked = requested.filter((n) => n >= 1 && n <= periodsPerDay);
    setError(
      outOfRange.length > 0
        ? `Break period(s) ${outOfRange.join(", ")} are outside 1–${periodsPerDay} (periods per day) and were dropped when saving.`
        : null
    );

    setSaving(true);
    const payload = { name, working_days: days, periods_per_day: periodsPerDay, blocked_periods: blocked };
    if (school) {
      localDb.update("schools", school.id, payload);
      // A requirement pinned to a day that's just been dropped from the
      // working week (e.g. switching Sat off) would otherwise sit there as
      // a dead, unusable pin — generator.ts already guards against actually
      // scheduling it, but there's no reason to leave stale days lying
      // around for someone to be confused by later.
      const reqs = localDb.select("lesson_requirements", { school_id: school.id });
      for (const r of reqs) {
        const currentDays = (r.days as string[] | undefined) ?? [];
        const pruned = currentDays.filter((d) => days.includes(d));
        if (pruned.length !== currentDays.length) {
          localDb.update("lesson_requirements", r.id, { days: pruned });
        }
      }
    } else {
      localDb.insert("schools", payload);
    }
    setSaving(false);
    onSaved();
  };

  return (
    <div className="card space-y-4">
      <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
        School settings
      </h2>
      <p className="text-sm text-gray-600">
        This is set up once. It controls how many days a week and how many periods a day the
        whole timetable works with.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1">School name</label>
        <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Working days</label>
        <div className="flex gap-2 flex-wrap">
          {ALL_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={`px-3 py-1 rounded-full text-sm border ${
                days.includes(d) ? "bg-[var(--ink-teal)] text-white border-[var(--ink-teal)]" : "border-gray-300"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Periods per day</label>
        <input
          type="number"
          className="input w-32"
          value={periodsPerDay}
          onChange={(e) => setPeriodsPerDay(parseInt(e.target.value, 10) || 0)}
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Break / lunch periods (e.g. "4" or "4, 7" — these slots are never scheduled)
        </label>
        <input
          className="input w-full"
          value={blockedPeriods}
          onChange={(e) => setBlockedPeriods(e.target.value)}
          placeholder="e.g. 4"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn-primary" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save school settings"}
      </button>
    </div>
  );
}

// =====================================================================
// Import from OD3 Academic API — pulls course/section/subject/teacher
// mappings already set up in the school's ERP, so Setup doesn't need to be
// re-typed by hand.
// =====================================================================
// New lesson requirements created by an import all start at this many
// periods/week — the ERP data doesn't carry a count, so it's just a
// reasonable starting point. Adjust individual ones in "Requirements".
const DEFAULT_PERIODS_PER_WEEK = 5;

function AcademicImportCard({ schoolId, onImported }: { schoolId: string; onImported: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [entityId, setEntityId] = useState(DEFAULT_ENTITY_ID);
  const lastFetchedRef = useRef<string | null>(null);

  const runImport = async (idOverride?: string) => {
    const id = (idOverride ?? entityId).trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const mappings = await fetchAllSubjectCourseMappings(id);
      const result = await importAcademicMappings(schoolId, mappings, DEFAULT_PERIODS_PER_WEEK);
      setSummary(result);
      lastFetchedRef.current = id;
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch once a full, valid-looking entity id (a 24-character Mongo
  // ObjectId) has been typed/pasted in — no need to click the button.
  useEffect(() => {
    const id = entityId.trim();
    if (!/^[a-f0-9]{24}$/i.test(id) || id === lastFetchedRef.current) return;
    const timer = setTimeout(() => runImport(id), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, schoolId]);

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Import from Academic API (OD3)
        </h2>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <label className="text-sm">Entity ID</label>
        <input
          className="input w-64"
          placeholder="e.g. 63edbf8a79c11c4fac7d760b"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
        <button className="btn-primary" onClick={() => runImport()} disabled={loading || !entityId.trim()}>
          {loading ? "Importing..." : "Fetch & import"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {summary && (
        <p className="text-sm text-gray-700">
          Added {summary.classSectionsAdded} class section(s), {summary.subjectsAdded} subject(s),{" "}
          {summary.teachersAdded} teacher(s), {summary.lessonRequirementsAdded} lesson
          requirement(s). Skipped {summary.lessonRequirementsSkipped} already-imported
          requirement(s).
        </p>
      )}
    </div>
  );
}

// =====================================================================
// Class picker — the one place classes live now. Add/remove classes here,
// and pick one or more to focus Subjects/Teachers on just what those
// classes study instead of the school's full lists. The selection is
// purely a filter: toggling a subject or teacher on Subjects/Teachers
// still affects it everywhere it's used, not just the selected classes.
// No classes selected = "All classes" = show everything.
// =====================================================================
function ClassSelectorCard({
  schoolId,
  selectedClassIds,
  onChange,
}: {
  schoolId: string;
  selectedClassIds: string[];
  // Accepts a plain array or a React-style updater — always use the
  // updater form when the next value depends on the previous one (see
  // `toggle` below). Passed straight through from a useState setter,
  // which guarantees each call sees the true latest state even when
  // several toggles fire in the same tick (e.g. clicking two chips fast).
  onChange: (value: string[] | ((prev: string[]) => string[])) => void;
}) {
  const [className, setClassName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const { data, loading, add, remove } = useTable<ClassSection>("class_sections", { school_id: schoolId });
  const sorted = [...data].sort(
    (a, b) =>
      a.class_name.localeCompare(b.class_name, undefined, { numeric: true }) ||
      a.section_name.localeCompare(b.section_name, undefined, { numeric: true })
  );

  const submit = async () => {
    if (!className.trim() || !sectionName.trim()) return;
    await add({ school_id: schoolId, class_name: className.trim(), section_name: sectionName.trim() });
    setClassName("");
    setSectionName("");
  };

  const toggle = (id: string) => {
    onChange((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const allSelected = selectedClassIds.length === 0;

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Class
        </h2>
        <p className="text-sm text-gray-600">
          Pick one or more classes to make the Subjects and Teachers sections show just what those
          classes study, instead of the school's full lists. Click "All classes" to clear the
          selection and see everything again.
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Class (e.g. Grade 6)" value={className} onChange={(e) => setClassName(e.target.value)} />
        <input className="input" placeholder="Section (e.g. Ganges)" value={sectionName} onChange={(e) => setSectionName(e.target.value)} />
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-gray-500">No classes yet — import from the Academic API, or add one above.</p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onChange([])}
              className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                allSelected
                  ? "bg-[var(--ink-teal)] text-white border-[var(--ink-teal)]"
                  : "border-gray-300 text-gray-600 hover:border-[var(--ink-teal)]"
              }`}
            >
              All classes
            </button>
            {!allSelected && (
              <span className="text-xs text-gray-400">
                {selectedClassIds.length} selected
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {sorted.map((c) => {
              const selected = selectedClassIds.includes(c.id);
              return (
                <div
                  key={c.id}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    selected ? "border-[var(--ink-teal)]" : "border-gray-200"
                  }`}
                  style={selected ? { background: "var(--ink-teal-light)" } : undefined}
                >
                  <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                    <input type="checkbox" checked={selected} onChange={() => toggle(c.id)} />
                    <span className="truncate">{c.class_name} — {c.section_name}</span>
                  </label>
                  <button
                    className="text-red-400 hover:text-red-600 text-xs shrink-0"
                    title="Remove"
                    onClick={() => {
                      remove(c.id);
                      onChange((prev) => prev.filter((x) => x !== c.id));
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================
// Subjects
// =====================================================================
function SubjectsCard({ schoolId, classSectionIds }: { schoolId: string; classSectionIds?: string[] }) {
  const [name, setName] = useState("");
  const [isLab, setIsLab] = useState(false);
  const [avoidFirst, setAvoidFirst] = useState(false);
  const [avoidLast, setAvoidLast] = useState(false);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const { data: allData, loading, add, remove, update } = useTable<Subject>("subjects", { school_id: schoolId });

  // When one or more classes are picked (section 3), only show subjects
  // actually taught to at least one of them — i.e. ones with a matching
  // lesson requirement.
  const hasClassFilter = !!classSectionIds && classSectionIds.length > 0;
  const allowedSubjectIds = hasClassFilter
    ? new Set(
        localDb
          .select("lesson_requirements", { school_id: schoolId })
          .filter((r) => classSectionIds!.includes(r.class_section_id as string))
          .map((r) => r.subject_id)
      )
    : null;
  const data = allowedSubjectIds ? allData.filter((s) => allowedSubjectIds.has(s.id)) : allData;

  const submit = async () => {
    if (!name.trim()) return;
    await add({
      school_id: schoolId,
      name: name.trim(),
      is_lab: isLab,
      included: true,
      avoid_first_period: avoidFirst,
      avoid_last_period: avoidLast,
      allow_repeat_same_day: allowRepeat,
    });
    setName("");
    setIsLab(false);
    setAvoidFirst(false);
    setAvoidLast(false);
    setAllowRepeat(false);
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Subjects
        </h2>
        <p className="text-sm text-gray-600">
          Tick "Lab" for subjects that need two periods back-to-back (e.g. Computer, Science Lab).
          The other three checkboxes are scheduling rules for this subject. Use "In timetable" to
          decide whether a subject actually gets scheduled — off by default for anything pulled in
          as co-scholastic/discipline via the Academic API import.
        </p>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <input className="input" placeholder="Subject name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={isLab} onChange={(e) => setIsLab(e.target.checked)} />
          Lab (double period)
        </label>
      </div>
      <div className="flex gap-4 flex-wrap text-sm text-gray-700">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={avoidFirst} onChange={(e) => setAvoidFirst(e.target.checked)} />
          Never in first period
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={avoidLast} onChange={(e) => setAvoidLast(e.target.checked)} />
          Never in last period
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={allowRepeat} onChange={(e) => setAllowRepeat(e.target.checked)} />
          Allow twice in one day for the same class
        </label>
      </div>
      <button className="btn-marigold" onClick={submit}>Add</button>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-500">
          {hasClassFilter
            ? "These classes have no subjects yet — add them in the Requirements section, or pick \"All classes\" in the Class section to see the full list."
            : "Nothing added yet."}
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-400">
            {data.length} subject{data.length === 1 ? "" : "s"}
            {hasClassFilter ? " for the selected class(es)" : ""} · unchecked ones are skipped when
            generating
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {[...data]
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
              .map((s) => {
                const badges = [
                  s.is_lab && "Lab",
                  s.avoid_first_period && "no 1st",
                  s.avoid_last_period && "no last",
                  s.allow_repeat_same_day && "repeats",
                ]
                  .filter(Boolean)
                  .join(" · ");
                const included = s.included !== false;
                return (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                      included ? "border-gray-200" : "border-gray-100 bg-gray-50 text-gray-400"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate">{s.name}</div>
                      {badges && <div className="text-xs text-gray-400 truncate">{badges}</div>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="checkbox"
                        title="In timetable"
                        checked={included}
                        onChange={(e) => update(s.id, { included: e.target.checked })}
                      />
                      <button
                        className="text-red-400 hover:text-red-600 text-xs"
                        title="Remove"
                        onClick={() => remove(s.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================
// Teacher unavailability — nested under each teacher (collapsible)
// =====================================================================
function TeacherUnavailabilityEditor({ schoolId, teacherId }: { schoolId: string; teacherId: string }) {
  const { data, loading, add, remove, refresh } = useTable<TeacherUnavailability>(
    "teacher_unavailability",
    { teacher_id: teacherId }
  );
  const [day, setDay] = useState(ALL_DAYS[0]);
  const [period, setPeriod] = useState("");

  const submit = async () => {
    const p = parseInt(period, 10);
    if (isNaN(p)) return;
    await add({ teacher_id: teacherId, day, period: p });
    setPeriod("");
  };

  // Blocks every period of the selected day in one go — for staff who are
  // off that day entirely, instead of adding each period one at a time.
  const markDayOff = () => {
    const school = localDb.select("schools", { id: schoolId })[0];
    const periodsPerDay = (school?.periods_per_day as number | undefined) ?? 8;
    const alreadyBlocked = new Set(data.filter((u) => u.day === day).map((u) => u.period));
    const rows = [];
    for (let p = 1; p <= periodsPerDay; p++) {
      if (!alreadyBlocked.has(p)) rows.push({ teacher_id: teacherId, day, period: p });
    }
    if (rows.length > 0) localDb.insert("teacher_unavailability", rows);
    refresh();
  };

  const dayFullyBlocked = (() => {
    const school = localDb.select("schools", { id: schoolId })[0];
    const periodsPerDay = (school?.periods_per_day as number | undefined) ?? 8;
    const blockedForDay = data.filter((u) => u.day === day).length;
    return blockedForDay >= periodsPerDay;
  })();

  return (
    <details className="mt-1 ml-4">
      <summary className="text-xs text-[var(--ink-teal-mid)] cursor-pointer">
        Unavailable slots {data.length > 0 ? `(${data.length})` : ""}
      </summary>
      <div className="mt-2 flex gap-2 items-center flex-wrap">
        <select className="input text-xs py-1" value={day} onChange={(e) => setDay(e.target.value)}>
          {ALL_DAYS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <input
          className="input text-xs py-1 w-20"
          placeholder="Period #"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
        <button className="btn-marigold text-xs py-1 px-2" onClick={submit}>Add</button>
        <button
          className="text-xs py-1 px-2 rounded-md border border-gray-300 text-gray-600 hover:border-[var(--ink-teal)] disabled:opacity-50"
          onClick={markDayOff}
          disabled={dayFullyBlocked}
          title={`Block every period on ${day}`}
        >
          {dayFullyBlocked ? `${day} fully off` : `Mark all of ${day} off`}
        </button>
      </div>
      {!loading && data.length > 0 && (
        <ul className="mt-1 text-xs space-y-0.5">
          {data.map((u) => (
            <li key={u.id} className="flex justify-between">
              <span>{u.day} · period {u.period}</span>
              <button className="text-red-500 hover:underline" onClick={() => remove(u.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// =====================================================================
// Teachers
// =====================================================================
function TeachersCard({ schoolId, classSectionIds }: { schoolId: string; classSectionIds?: string[] }) {
  const [name, setName] = useState("");
  const [maxDay, setMaxDay] = useState("");
  const [maxWeek, setMaxWeek] = useState("");
  const { data: allData, loading, add, remove } = useTable<Teacher>("teachers", { school_id: schoolId });

  // Same class-based filter as Subjects: only teachers actually assigned to
  // at least one of the picked classes via a lesson requirement.
  const hasClassFilter = !!classSectionIds && classSectionIds.length > 0;
  const allowedTeacherIds = hasClassFilter
    ? new Set(
        localDb
          .select("lesson_requirements", { school_id: schoolId })
          .filter((r) => classSectionIds!.includes(r.class_section_id as string))
          .map((r) => r.teacher_id)
      )
    : null;
  const data = allowedTeacherIds ? allData.filter((t) => allowedTeacherIds.has(t.id)) : allData;

  const submit = async () => {
    if (!name.trim()) return;
    await add({
      school_id: schoolId,
      name: name.trim(),
      max_periods_per_day: maxDay ? parseInt(maxDay, 10) : null,
      max_periods_per_week: maxWeek ? parseInt(maxWeek, 10) : null,
    });
    setName(""); setMaxDay(""); setMaxWeek("");
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Teachers
        </h2>
        <p className="text-sm text-gray-600">
          Max periods/day and max periods/week are optional — leave blank for no limit. Click
          "Unavailable slots" under a teacher to block off specific day/period combinations
          (e.g. part-time staff).
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Teacher name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input w-36" placeholder="Max / day" value={maxDay} onChange={(e) => setMaxDay(e.target.value)} />
        <input className="input w-36" placeholder="Max / week" value={maxWeek} onChange={(e) => setMaxWeek(e.target.value)} />
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-500">
          {hasClassFilter
            ? "No teacher is assigned to these classes yet — add one in the Requirements section, or pick \"All classes\" in the Class section to see the full list."
            : "Nothing added yet."}
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-400">
            {data.length} teacher{data.length === 1 ? "" : "s"}{hasClassFilter ? " for the selected class(es)" : ""}
          </p>
          <ul className="text-sm divide-y divide-gray-100">
            {[...data]
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
              .map((t) => (
                <li key={t.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {t.name}
                      {t.max_periods_per_day ? ` · max ${t.max_periods_per_day}/day` : ""}
                      {t.max_periods_per_week ? ` · max ${t.max_periods_per_week}/week` : ""}
                    </span>
                    <button className="text-red-400 hover:text-red-600 text-xs shrink-0" title="Remove" onClick={() => remove(t.id)}>✕</button>
                  </div>
                  <TeacherUnavailabilityEditor schoolId={schoolId} teacherId={t.id} />
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

// =====================================================================
// Teachers that should never be back-to-back for the same class
// =====================================================================
function AvoidAdjacentTeachersCard({ schoolId }: { schoolId: string }) {
  const { data: teachers } = useTable<Teacher>("teachers", { school_id: schoolId });
  const { data, loading, remove, refresh } = useTable<AvoidAdjacentPairRow>(
    "avoid_adjacent_teacher_pairs",
    { school_id: schoolId }
  );

  const [teacherAId, setTeacherAId] = useState("");
  const [teacherBId, setTeacherBId] = useState("");

  const submit = async () => {
    if (!teacherAId || !teacherBId || teacherAId === teacherBId) return;
    localDb.insert("avoid_adjacent_teacher_pairs", {
      school_id: schoolId,
      teacher_a_id: teacherAId,
      teacher_b_id: teacherBId,
    });
    setTeacherAId("");
    setTeacherBId("");
    refresh();
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Teachers that should never be back-to-back
        </h2>
        <p className="text-sm text-gray-600">
          For the same class, these two teachers' periods will be kept apart wherever possible
          (e.g. avoiding a tiring subject combo, or a handover that needs a gap).
        </p>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <select className="input" value={teacherAId} onChange={(e) => setTeacherAId(e.target.value)}>
          <option value="">Teacher A</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <select className="input" value={teacherBId} onChange={(e) => setTeacherBId(e.target.value)}>
          <option value="">Teacher B</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : data.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing added yet.</p>
      ) : (
        <ul className="text-sm space-y-1">
          {data.map((p) => (
            <li key={p.id} className="flex justify-between border-b border-gray-100 py-1">
              <span>{p.teacher_a?.name ?? "—"} ↔ {p.teacher_b?.name ?? "—"}</span>
              <button className="text-red-500 hover:underline text-xs" onClick={() => remove(p.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Rooms
// =====================================================================
function RoomsCard({ schoolId }: { schoolId: string }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("regular");
  const { data, loading, add, remove } = useTable<Room>("rooms", { school_id: schoolId });

  const submit = async () => {
    if (!name.trim()) return;
    await add({ school_id: schoolId, name: name.trim(), room_type: type });
    setName("");
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Rooms (optional)
        </h2>
        <p className="text-sm text-gray-600">Only needed for labs/special rooms that can get double-booked.</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Room name (e.g. Computer Lab 1)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="regular">Regular</option>
          <option value="lab">Lab</option>
          <option value="computer">Computer Lab</option>
          <option value="other">Other</option>
        </select>
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-1">
          {data.map((r) => (
            <li key={r.id} className="flex justify-between border-b border-gray-100 py-1">
              <span>{r.name} <span className="text-xs text-gray-400">({r.room_type})</span></span>
              <button className="text-red-500 hover:underline text-xs" onClick={() => remove(r.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Lesson requirements — "this class needs this subject from this teacher,
// N times a week". This is the data the generator actually reads.
// =====================================================================
function LessonRequirementsCard({ schoolId, workingDays }: { schoolId: string; workingDays: string[] }) {
  const { data, loading, remove, update } = useTable<LessonRequirementRow>(
    "lesson_requirements",
    { school_id: schoolId }
  );

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          What each class needs to study
        </h2>
        <p className="text-sm text-gray-600">
          One row = "this class needs this subject, taught by this teacher, this many times a week."
          This is what gets turned into the actual timetable — populated by the Academic API
          import. Edit "Periods/wk" directly, and optionally tap day letters under "Day" if a
          subject must always land on specific days (e.g. Assembly on Mon, or PE on Tue + Thu);
          leave none selected ("Any") to let Generate pick freely, same as before.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing here yet — run the Academic API import, or this list will stay empty since
          there's no manual "add" form here anymore.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-gray-200 text-gray-500">
                <th className="py-1 pr-4">Class</th>
                <th className="py-1 pr-4">Subject</th>
                <th className="py-1 pr-4">Teacher</th>
                <th className="py-1 pr-4">Room</th>
                <th className="py-1 pr-4">Periods/wk</th>
                <th className="py-1 pr-4">Day</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 whitespace-nowrap">{row.class_sections ? `${row.class_sections.class_name} - ${row.class_sections.section_name}` : "—"}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{row.subjects?.name ?? "—"}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{row.teachers?.name ?? "—"}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{row.rooms?.name ?? "—"}{row.is_lab ? " (double)" : ""}</td>
                  <td className="py-2 pr-4">
                    <input
                      type="number"
                      min={1}
                      className="input w-16 py-1"
                      value={row.periods_per_week}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n > 0) update(row.id, { periods_per_week: n });
                      }}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    {(() => {
                      // Falls back to the old single-day field for any row
                      // written before "days" existed.
                      const selectedDays = row.days ?? (row.day ? [row.day] : []);
                      // Reads the current value straight from localDb rather
                      // than the (possibly stale) row prop above — clicking
                      // two day-letters quickly both fire before this
                      // component re-renders, so building the next array
                      // from `selectedDays` would silently drop the first
                      // click (same bug already fixed for the Class picker).
                      const toggle = (d: string) => {
                        const current = localDb.select("lesson_requirements", { id: row.id })[0];
                        const currentDays =
                          (current?.days as string[] | undefined) ??
                          (current?.day ? [current.day as string] : []);
                        update(row.id, {
                          days: currentDays.includes(d)
                            ? currentDays.filter((x) => x !== d)
                            : [...currentDays, d],
                        });
                      };
                      return (
                        <div className="flex gap-1 flex-nowrap">
                          {/* Only offer days the school actually works — picking a day
                              that isn't a working day would create a requirement Generate
                              can never place there anyway (and the school could still be
                              mid-transition after a working-days change, until it's saved). */}
                          {ALL_DAYS.filter((d) => workingDays.includes(d)).map((d) => (
                            <button
                              key={d}
                              type="button"
                              title={d}
                              onClick={() => toggle(d)}
                              className={`w-7 h-7 shrink-0 rounded-full text-[10px] font-medium border transition-colors ${
                                selectedDays.includes(d)
                                  ? "bg-[var(--ink-teal)] text-white border-[var(--ink-teal)]"
                                  : "border-gray-300 text-gray-500 hover:border-[var(--ink-teal)]"
                              }`}
                            >
                              {d.slice(0, 2)}
                            </button>
                          ))}
                          {selectedDays.length === 0 && (
                            <span className="text-xs text-gray-400 self-center ml-1">Any</span>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const selectedDays = row.days ?? (row.day ? [row.day] : []);
                      const allowRepeat = row.subjects?.allow_repeat_same_day ?? false;
                      // Pinning to fewer days than periods/week forces the
                      // same subject to repeat on a day — fine if "Allow
                      // twice in one day" is on for the subject, otherwise
                      // it's a rule violation the generator will silently
                      // relax rather than leave unplaced. Flag it here so
                      // it's not a surprise after Generate runs.
                      if (selectedDays.length === 0 || allowRepeat || row.periods_per_week <= selectedDays.length) {
                        return null;
                      }
                      return (
                        <p className="text-[10px] text-amber-600 mt-1">
                          ⚠ {row.periods_per_week} periods but {selectedDays.length} day(s) picked —
                          will repeat same day
                        </p>
                      );
                    })()}
                  </td>
                  <td className="py-2 text-right">
                    <button className="text-red-500 hover:underline text-xs" onClick={() => remove(row.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Page
// =====================================================================
export default function Setup() {
  const [school, setSchool] = useState<School | null>(null);
  const [loadingSchool, setLoadingSchool] = useState(true);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0); // mirrors activeIndex without waiting for a re-render
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [selectedClassIds, setSelectedClassIds] = useState<string[]>([]); // [] = all classes

  // A school record always exists after this runs — there's no "save
  // school settings to unlock the rest" gate. If none exists yet (first
  // visit in this browser), a blank draft is created so the Academic API
  // import (and everything else) is usable immediately; School settings
  // further down still defaults to Mon–Sat / 8 periods and can be edited
  // any time.
  const loadSchool = async () => {
    setLoadingSchool(true);
    let rows = localDb.select("schools");
    if (rows.length === 0) {
      rows = localDb.insert("schools", {
        name: "",
        working_days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        periods_per_day: 8,
        blocked_periods: [],
      });
    }
    setSchool(rows[0] as unknown as School);
    setLoadingSchool(false);
  };

  useEffect(() => {
    loadSchool();
  }, []);

  // Bumps dataRefreshKey, which remounts just the data-listing panels
  // (Subjects, Classes, Teachers, ...) so they re-fetch and show what was
  // just imported. The Import panel itself is deliberately NOT remounted —
  // otherwise it would wipe its own success message and the entity ID
  // field the instant the import finished, before you could ever see them.
  const handleImported = () => {
    setDataRefreshKey((k) => k + 1);
  };

  const scrollToIndex = (i: number) => {
    const el = scrollerRef.current?.children[i] as HTMLElement | undefined;
    // "instant" (not "smooth") deliberately — smooth scroll animations
    // depend on the compositor actually ticking frames, which some
    // browser/automation contexts skip, silently leaving the scroll
    // half-finished. Instant is a hard guarantee it lands correctly.
    el?.scrollIntoView({ behavior: "instant", inline: "start", block: "nearest" });
    // Set directly rather than relying solely on the scroll listener below
    // to infer it afterwards — we already know exactly which index this is.
    // The ref updates synchronously (state doesn't, until the next render),
    // so back-to-back clicks — e.g. mashing "next" — each see the true
    // current index instead of one stale from before the first click.
    activeIndexRef.current = i;
    setActiveIndex(i);
  };

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let closest = 0;
    let closestDist = Infinity;
    Array.from(scroller.children).forEach((c, i) => {
      const dist = Math.abs((c as HTMLElement).offsetLeft - scroller.scrollLeft);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    });
    activeIndexRef.current = closest;
    setActiveIndex(closest);
  };

  if (loadingSchool || !school) return <p className="p-6 text-sm text-gray-500">Loading...</p>;

  const sections = [
    {
      id: "import",
      label: "Import",
      remountOnImport: false,
      content: (
        <AcademicImportCard schoolId={school.id} onImported={handleImported} />
      ),
    },
    {
      id: "school",
      label: "School settings",
      remountOnImport: false,
      content: <SchoolSettings school={school} onSaved={loadSchool} />,
    },
    {
      id: "class-picker",
      label: "Class",
      remountOnImport: true,
      content: (
        <ClassSelectorCard schoolId={school.id} selectedClassIds={selectedClassIds} onChange={setSelectedClassIds} />
      ),
    },
    {
      id: "subjects",
      label: "Subjects",
      remountOnImport: true,
      content: <SubjectsCard schoolId={school.id} classSectionIds={selectedClassIds} />,
    },
    {
      id: "teachers",
      label: "Teachers",
      remountOnImport: true,
      content: <TeachersCard schoolId={school.id} classSectionIds={selectedClassIds} />,
    },
    {
      id: "pairs",
      label: "Avoid back-to-back",
      remountOnImport: true,
      content: <AvoidAdjacentTeachersCard schoolId={school.id} />,
    },
    { id: "rooms", label: "Rooms", remountOnImport: true, content: <RoomsCard schoolId={school.id} /> },
    {
      id: "requirements",
      label: "Requirements",
      remountOnImport: true,
      content: <LessonRequirementsCard schoolId={school.id} workingDays={school.working_days} />,
    },
  ];

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      {/* ---- step pills: click to jump to any section ---- */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {sections.map((s, i) => (
          <button
            key={s.id}
            onClick={() => scrollToIndex(i)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              activeIndex === i
                ? "bg-[var(--ink-teal)] text-white border-[var(--ink-teal)]"
                : "border-gray-300 text-gray-600 hover:border-[var(--ink-teal)]"
            }`}
          >
            {i + 1}. {s.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 -mt-2">Swipe, scroll, or use ‹ › to move between sections.</p>

      {/* ---- the sections themselves, one screen-width panel each ---- */}
      <div className="relative">
        <button
          onClick={() => scrollToIndex(Math.max(0, activeIndexRef.current - 1))}
          disabled={activeIndex === 0}
          aria-label="Previous section"
          className="hidden sm:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 w-9 h-9 rounded-full bg-white border border-gray-300 shadow items-center justify-center text-lg disabled:opacity-0 disabled:pointer-events-none"
        >
          ‹
        </button>

        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          className="flex overflow-x-auto snap-x snap-proximity scroll-smooth"
        >
          {sections.map((s) => (
            <div key={s.id} className="snap-start shrink-0 w-full px-1">
              <div
                key={s.remountOnImport ? `${s.id}-${dataRefreshKey}` : s.id}
                className="max-h-[65vh] overflow-y-auto pr-1"
              >
                {s.content}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => scrollToIndex(Math.min(sections.length - 1, activeIndexRef.current + 1))}
          disabled={activeIndex === sections.length - 1}
          aria-label="Next section"
          className="hidden sm:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-9 h-9 rounded-full bg-white border border-gray-300 shadow items-center justify-center text-lg disabled:opacity-0 disabled:pointer-events-none"
        >
          ›
        </button>
      </div>

      {/* ---- always-visible, regardless of which section is in view ---- */}
      <div className="card flex items-center justify-between gap-4 flex-wrap" style={{ background: "var(--ink-teal-light)" }}>
        <div>
          <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
            Ready?
          </h2>
          <p className="text-sm text-gray-600">
            Once the subjects look right, build the timetable.
          </p>
        </div>
        <Link to="/generate" className="btn-primary whitespace-nowrap">
          Generate timetable →
        </Link>
      </div>
    </div>
  );
}
