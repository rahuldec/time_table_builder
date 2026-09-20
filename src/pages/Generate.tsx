import { useState } from "react";
import { localDb } from "../lib/localDb";
import { generateTimetable, classifyGenerationStatus } from "../lib/generator";
import { runFeasibilityChecks } from "../lib/feasibility";
import type {
  SchoolConfig,
  Teacher,
  LessonRequirement,
  TeacherPair,
  ConfigurationIssue,
  UnplacedItem,
  SoftViolation,
  GenerationStatus,
} from "../lib/types";

interface NameMaps {
  classSection: Map<string, string>;
  subject: Map<string, string>;
  teacher: Map<string, string>;
}

interface Status {
  kind: "idle" | "working" | "invalid_configuration" | "done" | "error";
  message?: string;
  issues?: ConfigurationIssue[];
  names?: NameMaps;
  generationStatus?: GenerationStatus;
  placed?: number;
  unplaced?: UnplacedItem[];
  softViolations?: SoftViolation[];
  searchBudgetExceeded?: boolean;
}

function classLabel(id: string, names: NameMaps): string {
  return names.classSection.get(id) ?? "(deleted class)";
}
function subjectLabel(id: string, names: NameMaps): string {
  return names.subject.get(id) ?? "(deleted subject)";
}
function teacherLabel(id: string, names: NameMaps): string {
  return names.teacher.get(id) ?? "(deleted teacher)";
}

function describeIssue(issue: ConfigurationIssue, names: NameMaps): string {
  switch (issue.kind) {
    case "requirement_infeasible":
      return `${subjectLabel(issue.subjectId, names)} — ${classLabel(issue.classSectionId, names)}: needs ${issue.required}/week but at most ${issue.maxPossible} is possible. ${issue.reason}`;
    case "fixed_day_not_working":
      return `A requirement is pinned to ${issue.invalidDays.join(", ")}, which ${issue.invalidDays.length > 1 ? "aren't" : "isn't"} a working day (working days: ${issue.workingDays.join(", ")}).`;
    case "teacher_capacity_exceeded":
      return `${teacherLabel(issue.teacherId, names)}: needs ${issue.required} periods/${issue.scope} but only ${issue.maximum} ${issue.scope === "week" ? "are" : "per day are"} available — short by ${issue.shortage}.`;
    case "invalid_reference":
      return `A requirement points at a deleted ${issue.missing.join(" / ")} — remove or fix it on the Setup page.`;
    case "school_config_invalid":
      return issue.reason;
  }
}

export default function Generate() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const runGeneration = async () => {
    setStatus({ kind: "working", message: "Reading school setup..." });
    try {
      // 1. Load the school
      const school = localDb.select("schools")[0];
      if (!school) throw new Error("No school found. Finish the Setup page first.");

      // 2. Load teachers (+ unavailability)
      const teacherRows = localDb.select("teachers", { school_id: school.id as string });

      // 3. Load subjects (for the rule flags: avoid first/last period, allow repeat same day,
      // and whether this subject is toggled on for the timetable at all)
      const subjectRows = localDb.select("subjects", { school_id: school.id as string });
      const subjectMap = new Map(
        subjectRows.map((s) => [
          s.id,
          {
            included: s.included !== false,
            avoidFirstPeriod: !!s.avoid_first_period,
            avoidLastPeriod: !!s.avoid_last_period,
            allowRepeatSameDay: !!s.allow_repeat_same_day,
          },
        ])
      );

      // 4. Load class sections and rooms (for name lookups and reference validation)
      const classSectionRows = localDb.select("class_sections", { school_id: school.id as string });
      const roomRows = localDb.select("rooms", { school_id: school.id as string });

      const names: NameMaps = {
        classSection: new Map(
          classSectionRows.map((c) => [c.id, `${c.class_name as string} - ${c.section_name as string}`])
        ),
        subject: new Map(subjectRows.map((s) => [s.id, s.name as string])),
        teacher: new Map(teacherRows.map((t) => [t.id, t.name as string])),
      };

      // 5. Load lesson requirements, keeping only those whose subject is toggled
      // on. Broken references (pointing at a deleted class/subject/teacher/room)
      // are NOT filtered out here — runFeasibilityChecks below validates them
      // and reports a clear configuration error instead of silently skipping them.
      const allLessonRows = localDb.select("lesson_requirements", { school_id: school.id as string });
      const lessonRows = allLessonRows.filter((l) => subjectMap.get(l.subject_id as string)?.included !== false);

      if (lessonRows.length === 0) {
        throw new Error(
          "No lesson requirements to schedule. Add them on the Setup page first, and make sure at least one subject is toggled on."
        );
      }

      // 6. Load teacher pairs that should never be back-to-back for the same class
      const pairRows = localDb.select("avoid_adjacent_teacher_pairs", { school_id: school.id as string });
      const avoidAdjacentTeacherPairs: TeacherPair[] = pairRows.map((p) => ({
        teacherAId: p.teacher_a_id as string,
        teacherBId: p.teacher_b_id as string,
      }));

      const schoolConfig: SchoolConfig = {
        workingDays: school.working_days as string[],
        periodsPerDay: school.periods_per_day as number,
        blockedPeriods: (school.blocked_periods as number[] | undefined) ?? [],
      };

      const teachers: Teacher[] = teacherRows.map((t) => ({
        id: t.id,
        name: t.name as string,
        maxPeriodsPerDay: (t.max_periods_per_day as number | null) ?? undefined,
        maxPeriodsPerWeek: (t.max_periods_per_week as number | null) ?? undefined,
        unavailable: localDb.select("teacher_unavailability", { teacher_id: t.id }).map((u) => ({
          day: u.day as string,
          period: u.period as number,
        })),
      }));

      const lessons: LessonRequirement[] = lessonRows.map((l) => {
        const subjFlags = subjectMap.get(l.subject_id as string);
        return {
          id: l.id,
          classSectionId: l.class_section_id as string,
          subjectId: l.subject_id as string,
          teacherId: l.teacher_id as string,
          periodsPerWeek: l.periods_per_week as number,
          roomId: (l.room_id as string | null) ?? undefined,
          isLab: l.is_lab as boolean,
          avoidFirstPeriod: subjFlags?.avoidFirstPeriod ?? false,
          avoidLastPeriod: subjFlags?.avoidLastPeriod ?? false,
          allowRepeatSameDay: subjFlags?.allowRepeatSameDay ?? false,
          fixedDays: (l.days as string[] | undefined) ?? [],
        };
      });

      // 7. Pre-generation feasibility validation. This must catch every
      // mathematically-impossible configuration BEFORE the scheduler ever
      // runs — never generate something that only looks valid.
      setStatus({ kind: "working", message: "Checking the configuration for conflicts..." });

      const feasibility = runFeasibilityChecks({
        school: schoolConfig,
        teachers,
        requirements: lessons,
        referenceIds: {
          classSectionIds: new Set(classSectionRows.map((c) => c.id)),
          subjectIds: new Set(subjectRows.map((s) => s.id)),
          teacherIds: new Set(teacherRows.map((t) => t.id)),
          roomIds: new Set(roomRows.map((r) => r.id)),
        },
      });

      if (!feasibility.valid) {
        setStatus({
          kind: "invalid_configuration",
          message: `${feasibility.issues.length} conflict(s) must be fixed before a timetable can be generated:`,
          issues: feasibility.issues,
          names,
        });
        return;
      }

      // 8. Generate. Requirements with a dangling reference were already
      // caught above, so every requirement here is safe to schedule.
      setStatus({ kind: "working", message: "Building the timetable (this can take a few seconds)..." });

      const result = generateTimetable({
        school: schoolConfig,
        teachers,
        classSections: [], // not needed by the algorithm itself
        lessons,
        avoidAdjacentTeacherPairs,
        attempts: 60,
      });

      setStatus({ kind: "working", message: "Saving the timetable..." });

      // 9. Work out the next version number, so old timetables aren't lost
      const nextVersion =
        localDb.maxValue("timetable_entries", "version", { school_id: school.id as string }) + 1;

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

      localDb.insert("timetable_entries", rowsToInsert);

      const generationStatus = classifyGenerationStatus(result);
      let message: string;
      if (generationStatus === "incomplete") {
        message = `Incomplete — ${result.unplaced.length} period(s) could not be placed even though the configuration passed feasibility checks. This means two or more requirements are fighting over the same teacher/room/day combination. See the list below.`;
      } else if (generationStatus === "valid_with_warnings") {
        message = `Valid, with warnings — every period was placed and no hard rule was broken, but ${result.softViolations.length} soft preference(s) (e.g. avoid first/last period, teacher adjacency) couldn't be honored. See the list below.`;
      } else {
        message = "Valid — every period was placed with no clashes, and every hard and soft rule was respected.";
      }
      if (result.searchBudgetExceeded) {
        message += " The search hit its time/step budget, so the unplaced list above is not proof those periods are impossible — just as far as this run got.";
      }

      setStatus({
        kind: "done",
        generationStatus,
        placed: result.entries.length,
        unplaced: result.unplaced,
        softViolations: result.softViolations,
        searchBudgetExceeded: result.searchBudgetExceeded,
        names,
        message,
      });
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
          This reads everything you entered on the Setup page, checks it for conflicts, and — only if
          the configuration is actually possible — builds a full draft timetable automatically, making
          sure no teacher, class, or room is double-booked and no hard rule is ever broken. You can
          review and tweak it afterwards on the View Timetable page.
        </p>
        <button className="btn-primary" onClick={runGeneration} disabled={status.kind === "working"}>
          {status.kind === "working" ? "Working..." : "Generate timetable"}
        </button>
      </div>

      {status.kind !== "idle" && (
        <div
          className={`card text-sm space-y-2 ${
            status.kind === "error" || status.kind === "invalid_configuration" ? "border-red-300 text-red-700" : ""
          }`}
        >
          <p className="font-medium">{status.message}</p>

          {status.kind === "invalid_configuration" && status.issues && status.names && (
            <ul className="list-disc pl-5 space-y-1 text-red-700">
              {status.issues.map((issue, i) => (
                <li key={i}>{describeIssue(issue, status.names!)}</li>
              ))}
            </ul>
          )}

          {status.kind === "done" && (
            <>
              <p className="text-gray-600">
                Status: <span className="font-medium">{status.generationStatus}</span> · Placed:{" "}
                {status.placed} · Unplaced: {status.unplaced?.length ?? 0} · Soft warnings:{" "}
                {status.softViolations?.length ?? 0}
              </p>

              {status.unplaced && status.unplaced.length > 0 && status.names && (
                <div>
                  <p className="font-medium text-gray-700 mt-2">Unplaced periods:</p>
                  <ul className="list-disc pl-5 space-y-1 text-gray-600">
                    {status.unplaced.map((u, i) => (
                      <li key={i}>
                        {subjectLabel(u.subjectId, status.names!)} — {classLabel(u.classSectionId, status.names!)}{" "}
                        ({teacherLabel(u.teacherId, status.names!)}): {u.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {status.softViolations && status.softViolations.length > 0 && status.names && (
                <div>
                  <p className="font-medium text-gray-700 mt-2">Soft preferences not honored:</p>
                  <ul className="list-disc pl-5 space-y-1 text-gray-600">
                    {status.softViolations.map((v, i) => (
                      <li key={i}>
                        {subjectLabel(v.subjectId, status.names!)} — {classLabel(v.classSectionId, status.names!)} —{" "}
                        {v.day} period {v.period}: {v.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
