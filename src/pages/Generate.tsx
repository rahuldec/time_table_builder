import { useState } from "react";
import { supabase } from "../lib/supabase";
import { generateTimetable } from "../lib/generator";
import type { SchoolConfig, Teacher, LessonRequirement, TeacherPair } from "../lib/types";

interface Status {
  kind: "idle" | "working" | "done" | "error";
  message?: string;
  placed?: number;
  unplaced?: number;
  ruleViolations?: number;
}

export default function Generate() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const runGeneration = async () => {
    setStatus({ kind: "working", message: "Reading school setup..." });
    try {
      // 1. Load the school
      const { data: school, error: schoolErr } = await supabase
        .from("schools")
        .select("*")
        .limit(1)
        .maybeSingle();
      if (schoolErr || !school) throw new Error("No school found. Finish the Setup page first.");

      // 2. Load teachers (+ unavailability)
      const { data: teacherRows, error: teacherErr } = await supabase
        .from("teachers")
        .select("*, teacher_unavailability(day, period)")
        .eq("school_id", school.id);
      if (teacherErr) throw new Error(teacherErr.message);

      // 3. Load subjects (for the rule flags: avoid first/last period, allow repeat same day)
      const { data: subjectRows, error: subjectErr } = await supabase
        .from("subjects")
        .select("id, avoid_first_period, avoid_last_period, allow_repeat_same_day")
        .eq("school_id", school.id);
      if (subjectErr) throw new Error(subjectErr.message);
      const subjectMap = new Map(
        (subjectRows ?? []).map((s) => [
          s.id,
          {
            avoidFirstPeriod: !!s.avoid_first_period,
            avoidLastPeriod: !!s.avoid_last_period,
            allowRepeatSameDay: !!s.allow_repeat_same_day,
          },
        ])
      );

      // 4. Load lesson requirements
      const { data: lessonRows, error: lessonErr } = await supabase
        .from("lesson_requirements")
        .select("*")
        .eq("school_id", school.id);
      if (lessonErr) throw new Error(lessonErr.message);

      if (!lessonRows || lessonRows.length === 0) {
        throw new Error("No lesson requirements found. Add them on the Setup page first.");
      }

      // 5. Load teacher pairs that should never be back-to-back for the same class
      const { data: pairRows, error: pairErr } = await supabase
        .from("avoid_adjacent_teacher_pairs")
        .select("teacher_a_id, teacher_b_id")
        .eq("school_id", school.id);
      if (pairErr) throw new Error(pairErr.message);
      const avoidAdjacentTeacherPairs: TeacherPair[] = (pairRows ?? []).map((p) => ({
        teacherAId: p.teacher_a_id,
        teacherBId: p.teacher_b_id,
      }));

      setStatus({ kind: "working", message: "Building the timetable (this can take a few seconds)..." });

      const schoolConfig: SchoolConfig = {
        workingDays: school.working_days,
        periodsPerDay: school.periods_per_day,
        blockedPeriods: school.blocked_periods ?? [],
      };

      const teachers: Teacher[] = (teacherRows ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        maxPeriodsPerDay: t.max_periods_per_day ?? undefined,
        maxPeriodsPerWeek: t.max_periods_per_week ?? undefined,
        unavailable: (t.teacher_unavailability ?? []).map((u: { day: string; period: number }) => ({
          day: u.day,
          period: u.period,
        })),
      }));

      const lessons: LessonRequirement[] = (lessonRows ?? []).map((l) => {
        const subjFlags = subjectMap.get(l.subject_id);
        return {
          id: l.id,
          classSectionId: l.class_section_id,
          subjectId: l.subject_id,
          teacherId: l.teacher_id,
          periodsPerWeek: l.periods_per_week,
          roomId: l.room_id ?? undefined,
          isLab: l.is_lab,
          avoidFirstPeriod: subjFlags?.avoidFirstPeriod ?? false,
          avoidLastPeriod: subjFlags?.avoidLastPeriod ?? false,
          allowRepeatSameDay: subjFlags?.allowRepeatSameDay ?? false,
        };
      });

      const result = generateTimetable({
        school: schoolConfig,
        teachers,
        classSections: [], // not needed by the algorithm itself
        lessons,
        avoidAdjacentTeacherPairs,
        attempts: 60,
      });

      setStatus({ kind: "working", message: "Saving the timetable..." });

      // 6. Work out the next version number, so old timetables aren't lost
      const { data: maxVersionRow } = await supabase
        .from("timetable_entries")
        .select("version")
        .eq("school_id", school.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextVersion = (maxVersionRow?.version ?? 0) + 1;

      const rowsToInsert = result.entries.map((e) => ({
        school_id: school.id,
        class_section_id: e.classSectionId,
        subject_id: e.subjectId,
        teacher_id: e.teacherId,
        room_id: e.roomId ?? null,
        day: e.day,
        period: e.period,
        version: nextVersion,
      }));

      const { error: insertErr } = await supabase.from("timetable_entries").insert(rowsToInsert);
      if (insertErr) throw new Error(insertErr.message);

      let message: string;
      if (result.unplaced.length > 0) {
        message = `Done, but ${result.unplaced.length} period(s) couldn't be placed — usually means a teacher is overloaded or a room is double-booked. Check the list below.`;
      } else if (result.ruleViolations > 0) {
        message = `Done! Every period was placed, but ${result.ruleViolations} rule(s) (e.g. no-repeat-in-day, avoid first/last period, or teacher adjacency) had to be relaxed slightly to fit everything in.`;
      } else {
        message = "Done! Every period was placed with no clashes, and every rule was respected.";
      }

      setStatus({
        kind: "done",
        placed: result.entries.length,
        unplaced: result.unplaced.length,
        ruleViolations: result.ruleViolations,
        message,
      });

      if (result.unplaced.length > 0) {
        console.log("Unplaced items:", result.unplaced);
      }
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6">
      <div className="card space-y-3">
        <h2 className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Generate the timetable
        </h2>
        <p className="text-sm text-gray-600">
          This reads everything you entered on the Setup page and builds a full draft timetable
          automatically — making sure no teacher, class, or room is double-booked, and respecting
          the rules you've set (teacher unavailability, no-repeat-in-day, avoid first/last period,
          and teacher adjacency). You can review and tweak it afterwards on the View Timetable page.
        </p>
        <button className="btn-primary" onClick={runGeneration} disabled={status.kind === "working"}>
          {status.kind === "working" ? "Working..." : "Generate timetable"}
        </button>
      </div>

      {status.kind !== "idle" && (
        <div
          className={`card text-sm ${
            status.kind === "error" ? "border-red-300 text-red-700" : ""
          }`}
        >
          <p>{status.message}</p>
          {status.kind === "done" && (
            <p className="mt-1 text-gray-600">
              Placed: {status.placed} periods · Unplaced: {status.unplaced} · Rules relaxed: {status.ruleViolations}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
