import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useTable } from "../lib/useTable";

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
}
interface Teacher {
  id: string;
  name: string;
  max_periods_per_day: number | null;
  max_periods_per_week: number | null;
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
      await supabase.from("schools").update(payload).eq("id", school.id);
    } else {
      await supabase.from("schools").insert(payload);
    }
    setSaving(false);
    onSaved();
  };

  return (
    <div className="card space-y-4">
      <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
        1. School settings
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
// Class Sections
// =====================================================================
function ClassSectionsCard({ schoolId, refreshKey }: { schoolId: string; refreshKey: number }) {
  const [className, setClassName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const { data, loading, add, remove } = useTable<ClassSection>("class_sections", "*", { school_id: schoolId });

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
          2. Classes & sections
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
  const { data, loading, add, remove } = useTable<Subject>("subjects", "*", { school_id: schoolId });

  const submit = async () => {
    if (!name.trim()) return;
    await add({ school_id: schoolId, name: name.trim(), is_lab: isLab });
    setName("");
    setIsLab(false);
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          3. Subjects
        </h2>
        <p className="text-sm text-gray-600">
          Tick "Lab" for subjects that need two periods back-to-back (e.g. Computer, Science Lab).
        </p>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <input className="input" placeholder="Subject name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={isLab} onChange={(e) => setIsLab(e.target.checked)} />
          Lab (double period)
        </label>
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-1">
          {data.map((s) => (
            <li key={s.id} className="flex justify-between border-b border-gray-100 py-1">
              <span>{s.name} {s.is_lab && <span className="text-xs text-[var(--marigold-dark)]">(Lab)</span>}</span>
              <button className="text-red-500 hover:underline text-xs" onClick={() => remove(s.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =====================================================================
// Teachers
// =====================================================================
function TeachersCard({ schoolId }: { schoolId: string }) {
  const [name, setName] = useState("");
  const [maxDay, setMaxDay] = useState("");
  const [maxWeek, setMaxWeek] = useState("");
  const { data, loading, add, remove } = useTable<Teacher>("teachers", "*", { school_id: schoolId });

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
          4. Teachers
        </h2>
        <p className="text-sm text-gray-600">
          Max periods/day and max periods/week are optional — leave blank for no limit.
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Teacher name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input w-36" placeholder="Max / day" value={maxDay} onChange={(e) => setMaxDay(e.target.value)} />
        <input className="input w-36" placeholder="Max / week" value={maxWeek} onChange={(e) => setMaxWeek(e.target.value)} />
        <button className="btn-marigold" onClick={submit}>Add</button>
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading...</p> : (
        <ul className="text-sm space-y-1">
          {data.map((t) => (
            <li key={t.id} className="flex justify-between border-b border-gray-100 py-1">
              <span>{t.name} {t.max_periods_per_day ? `· max ${t.max_periods_per_day}/day` : ""} {t.max_periods_per_week ? `· max ${t.max_periods_per_week}/week` : ""}</span>
              <button className="text-red-500 hover:underline text-xs" onClick={() => remove(t.id)}>Remove</button>
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
  const { data, loading, add, remove } = useTable<Room>("rooms", "*", { school_id: schoolId });

  const submit = async () => {
    if (!name.trim()) return;
    await add({ school_id: schoolId, name: name.trim(), room_type: type });
    setName("");
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          5. Rooms (optional)
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
  const { data: sections } = useTable<ClassSection>("class_sections", "*", { school_id: schoolId });
  const { data: subjects } = useTable<Subject>("subjects", "*", { school_id: schoolId });
  const { data: teachers } = useTable<Teacher>("teachers", "*", { school_id: schoolId });
  const { data: rooms } = useTable<Room>("rooms", "*", { school_id: schoolId });

  const select = "id, periods_per_week, is_lab, class_sections(class_name,section_name), subjects(name), teachers(name), rooms(name)";
  const { data, loading, remove, refresh } = useTable<LessonRequirementRow>(
    "lesson_requirements",
    select,
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
    const { error } = await supabase.from("lesson_requirements").insert({
      school_id: schoolId,
      class_section_id: classSectionId,
      subject_id: subjectId,
      teacher_id: teacherId,
      room_id: roomId || null,
      periods_per_week: parseInt(periodsPerWeek, 10),
      is_lab: isLab,
    });
    if (!error) {
      setClassSectionId(""); setSubjectId(""); setTeacherId(""); setRoomId(""); setPeriodsPerWeek("5"); setIsLab(false);
      refresh();
    }
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          6. What each class needs to study (the important part)
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

  const loadSchool = async () => {
    setLoadingSchool(true);
    const { data } = await supabase.from("schools").select("*").limit(1).maybeSingle();
    setSchool((data as School) ?? null);
    setLoadingSchool(false);
  };

  useEffect(() => {
    loadSchool();
  }, []);

  if (loadingSchool) return <p className="p-6 text-sm text-gray-500">Loading...</p>;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <SchoolSettings school={school} onSaved={loadSchool} />
      {school && (
        <>
          <ClassSectionsCard schoolId={school.id} refreshKey={0} />
          <SubjectsCard schoolId={school.id} />
          <TeachersCard schoolId={school.id} />
          <RoomsCard schoolId={school.id} />
          <LessonRequirementsCard schoolId={school.id} />
        </>
      )}
      {!school && (
        <p className="text-sm text-gray-500">Save your school settings above to unlock the rest of the setup.</p>
      )}
    </div>
  );
}
