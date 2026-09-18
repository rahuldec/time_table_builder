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
  class_sections: { class_name: string; section_name: string } | null;
  subjects: { name: string } | null;
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

  const toggleDay = (d: string) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    setSaving(true);
    const blocked = blockedPeriods
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    const payload = { name, working_days: days, periods_per_day: periodsPerDay, blocked_periods: blocked };
    if (school) {
      localDb.update("schools", school.id, payload);
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
function AcademicImportCard({ schoolId, onImported }: { schoolId: string; onImported: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [entityId, setEntityId] = useState(DEFAULT_ENTITY_ID);
  const [defaultPeriodsPerWeek, setDefaultPeriodsPerWeek] = useState("5");
  const lastFetchedRef = useRef<string | null>(null);
  const periodsRef = useRef(defaultPeriodsPerWeek);
  useEffect(() => {
    periodsRef.current = defaultPeriodsPerWeek;
  }, [defaultPeriodsPerWeek]);

  const runImport = async (idOverride?: string) => {
    const id = (idOverride ?? entityId).trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const mappings = await fetchAllSubjectCourseMappings(id);
      const result = await importAcademicMappings(
        schoolId,
        mappings,
        parseInt(periodsRef.current, 10) || 5
      );
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
        <p className="text-sm text-gray-600">
          Paste the entity ID below and it fetches automatically — pulling every class, section,
          subject and their assigned teachers from that entity's ERP. Safe to run again later (for
          this or a different entity) — it skips what's already here. New lesson requirements are
          created with the periods/week below; open "Advanced" further down to edit an individual
          count afterwards if a subject needs something different.
        </p>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <label className="text-sm">Entity ID</label>
        <input
          className="input w-64"
          placeholder="e.g. 63edbf8a79c11c4fac7d760b"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
        <label className="text-sm">Default periods/week for new subjects</label>
        <input
          type="number"
          className="input w-24"
          value={defaultPeriodsPerWeek}
          onChange={(e) => setDefaultPeriodsPerWeek(e.target.value)}
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
          {summary.multiTeacherSubjects > 0 && (
            <>
              {" "}
              {summary.multiTeacherSubjects} subject(s) had more than one teacher assigned — only
              the first was imported; add the others manually under "Advanced" further down.
            </>
          )}
        </p>
      )}
    </div>
  );
}

// =====================================================================
// Class Sections
// =====================================================================
function ClassSectionsCard({ schoolId, refreshKey }: { schoolId: string; refreshKey: number }) {
  const [className, setClassName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const { data, loading, add, remove } = useTable<ClassSection>("class_sections", { school_id: schoolId });

  const submit = async () => {
    if (!className.trim() || !sectionName.trim()) return;
    await add({ school_id: schoolId, class_name: className.trim(), section_name: sectionName.trim() });
    setClassName("");
    setSectionName("");
  };

  return (
    <div className="card space-y-4" key={refreshKey}>
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Classes & sections
        </h2>
        <p className="text-sm text-gray-600">e.g. Class "Grade 6", Section "Ganges"</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Class (e.g. Grade 6)" value={className} onChange={(e) => setClassName(e.target.value)} />
        <input className="input" placeholder="Section (e.g. Ganges)" value={sectionName} onChange={(e) => setSectionName(e.target.value)} />
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-1">
          {data.map((c) => (
            <li key={c.id} className="flex justify-between border-b border-gray-100 py-1">
              <span>{c.class_name} — {c.section_name}</span>
              <button className="text-red-500 hover:underline text-xs" onClick={() => remove(c.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Subjects
// =====================================================================
function SubjectsCard({ schoolId }: { schoolId: string }) {
  const [name, setName] = useState("");
  const [isLab, setIsLab] = useState(false);
  const [avoidFirst, setAvoidFirst] = useState(false);
  const [avoidLast, setAvoidLast] = useState(false);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const { data, loading, add, remove, update } = useTable<Subject>("subjects", { school_id: schoolId });

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

      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-1">
          {data.map((s) => (
            <li key={s.id} className="flex justify-between items-center border-b border-gray-100 py-1">
              <span>
                {s.name}{" "}
                {s.is_lab && <span className="text-xs text-[var(--marigold-dark)]">(Lab)</span>}{" "}
                {s.avoid_first_period && <span className="text-xs text-gray-400">· no 1st period</span>}{" "}
                {s.avoid_last_period && <span className="text-xs text-gray-400">· no last period</span>}{" "}
                {s.allow_repeat_same_day && <span className="text-xs text-gray-400">· repeats allowed</span>}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={s.included !== false}
                    onChange={(e) => update(s.id, { included: e.target.checked })}
                  />
                  In timetable
                </label>
                <button className="text-red-500 hover:underline text-xs" onClick={() => remove(s.id)}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Teacher unavailability — nested under each teacher (collapsible)
// =====================================================================
function TeacherUnavailabilityEditor({ teacherId }: { teacherId: string }) {
  const { data, loading, add, remove } = useTable<TeacherUnavailability>(
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
function TeachersCard({ schoolId }: { schoolId: string }) {
  const [name, setName] = useState("");
  const [maxDay, setMaxDay] = useState("");
  const [maxWeek, setMaxWeek] = useState("");
  const { data, loading, add, remove } = useTable<Teacher>("teachers", { school_id: schoolId });

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
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-2">
          {data.map((t) => (
            <li key={t.id} className="border-b border-gray-100 py-1">
              <div className="flex justify-between">
                <span>{t.name} {t.max_periods_per_day ? `· max ${t.max_periods_per_day}/day` : ""} {t.max_periods_per_week ? `· max ${t.max_periods_per_week}/week` : ""}</span>
                <button className="text-red-500 hover:underline text-xs" onClick={() => remove(t.id)}>Remove</button>
              </div>
              <TeacherUnavailabilityEditor teacherId={t.id} />
            </li>
          ))}
        </ul>
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
function LessonRequirementsCard({ schoolId }: { schoolId: string }) {
  const { data: sections } = useTable<ClassSection>("class_sections", { school_id: schoolId });
  const { data: subjects } = useTable<Subject>("subjects", { school_id: schoolId });
  const { data: teachers } = useTable<Teacher>("teachers", { school_id: schoolId });
  const { data: rooms } = useTable<Room>("rooms", { school_id: schoolId });

  const { data, loading, remove, refresh } = useTable<LessonRequirementRow>(
    "lesson_requirements",
    { school_id: schoolId }
  );

  const [classSectionId, setClassSectionId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [periodsPerWeek, setPeriodsPerWeek] = useState("5");
  const [isLab, setIsLab] = useState(false);

  const submit = async () => {
    if (!classSectionId || !subjectId || !teacherId || !periodsPerWeek) return;
    localDb.insert("lesson_requirements", {
      school_id: schoolId,
      class_section_id: classSectionId,
      subject_id: subjectId,
      teacher_id: teacherId,
      room_id: roomId || null,
      periods_per_week: parseInt(periodsPerWeek, 10),
      is_lab: isLab,
    });
    setClassSectionId(""); setSubjectId(""); setTeacherId(""); setRoomId(""); setPeriodsPerWeek("5"); setIsLab(false);
    refresh();
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          What each class needs to study
        </h2>
        <p className="text-sm text-gray-600">
          One row = "this class needs this subject, taught by this teacher, this many times a week."
          This is what gets turned into the actual timetable.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <select className="input" value={classSectionId} onChange={(e) => setClassSectionId(e.target.value)}>
          <option value="">Class - Section</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>{s.class_name} - {s.section_name}</option>
          ))}
        </select>
        <select className="input" value={subjectId} onChange={(e) => {
          setSubjectId(e.target.value);
          const subj = subjects.find((s) => s.id === e.target.value);
          if (subj) setIsLab(subj.is_lab);
        }}>
          <option value="">Subject</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select className="input" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
          <option value="">Teacher</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">Room (optional)</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <input className="input" type="number" placeholder="Periods / week" value={periodsPerWeek} onChange={(e) => setPeriodsPerWeek(e.target.value)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={isLab} onChange={(e) => setIsLab(e.target.checked)} />
          Schedule as double periods
        </label>
      </div>
      <button className="btn-marigold" onClick={submit}>Add requirement</button>

      {loading ? <p className="text-sm text-gray-500">Loading...</p> : data.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing added yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-gray-200 text-gray-500">
              <th className="py-1 pr-4">Class</th>
              <th className="py-1 pr-4">Subject</th>
              <th className="py-1 pr-4">Teacher</th>
              <th className="py-1 pr-4">Room</th>
              <th className="py-1 pr-4">Periods/wk</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.id} className="border-b border-gray-100">
                <td className="py-2 pr-4">{row.class_sections ? `${row.class_sections.class_name} - ${row.class_sections.section_name}` : "—"}</td>
                <td className="py-2 pr-4">{row.subjects?.name ?? "—"}</td>
                <td className="py-2 pr-4">{row.teachers?.name ?? "—"}</td>
                <td className="py-2 pr-4">{row.rooms?.name ?? "—"}</td>
                <td className="py-2 pr-4">{row.periods_per_week}{row.is_lab ? " (double)" : ""}</td>
                <td className="py-2 text-right">
                  <button className="text-red-500 hover:underline text-xs" onClick={() => remove(row.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

  if (loadingSchool || !school) return <p className="p-6 text-sm text-gray-500">Loading...</p>;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      {/* ---- The everyday path: import, confirm subjects, generate. ---- */}
      <AcademicImportCard
        schoolId={school.id}
        onImported={() => setDataRefreshKey((k) => k + 1)}
      />
      <SchoolSettings school={school} onSaved={loadSchool} />
      <div key={dataRefreshKey}>
        <SubjectsCard schoolId={school.id} />
      </div>

      <div className="card flex items-center justify-between gap-4 flex-wrap" style={{ background: "var(--ink-teal-light)" }}>
        <div>
          <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
            Ready?
          </h2>
          <p className="text-sm text-gray-600">
            Once the subjects above look right, build the timetable.
          </p>
        </div>
        <Link to="/generate" className="btn-primary whitespace-nowrap">
          Generate timetable →
        </Link>
      </div>

      {/* ---- Everything below is populated automatically by the import ----
          above; most schools never need to open this. It's here for manual
          fixes: adding a class the ERP doesn't have yet, capping a
          teacher's load, keeping two teachers apart, shared rooms, or
          tweaking an individual periods/week count. */}
      <details className="card" key={`${dataRefreshKey}-advanced`}>
        <summary className="font-bold text-lg cursor-pointer select-none" style={{ color: "var(--ink-teal)" }}>
          Advanced: edit classes, teachers, rooms & requirements manually
        </summary>
        <div className="space-y-6 mt-4">
          <ClassSectionsCard schoolId={school.id} refreshKey={0} />
          <TeachersCard schoolId={school.id} />
          <AvoidAdjacentTeachersCard schoolId={school.id} />
          <RoomsCard schoolId={school.id} />
          <LessonRequirementsCard schoolId={school.id} />
        </div>
      </details>
    </div>
  );
}
