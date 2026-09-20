// ===========================================================
// Independent final validation of a GENERATED timetable — a black-box
// audit. It takes ONLY the raw TimetableEntry[] a generation run produced
// plus the same LessonRequirement[]/Teacher[]/SchoolConfig inputs it was
// given, the same way a human double-checking the output by hand would.
// It has NO access to and takes NO input from the generator's own
// bookkeeping — no grids, no counters, no "unplaced" list, no
// "searchBudgetExceeded" flag. Every hard constraint, INCLUDING whether
// every requirement's periods-per-week was actually satisfied, is
// re-derived here from first principles.
//
// The whole point: a bug in generator.ts's placement bookkeeping — or in
// what it *claims* about its own completeness — must never be able to make
// an invalid or incomplete timetable look VALID. If this validator finds
// even one hard-constraint violation, the result can never be reported as
// VALID or VALID_WITH_WARNINGS, no matter what the generator itself claimed.
//
// This module makes no judgment about whether a period-count shortfall is
// "acceptable" (e.g. because the search legitimately ran out of budget) —
// that interpretation requires knowing about the search process itself,
// which is generator-internal information a black-box audit of the output
// can never have. It simply reports the fact: required N, placed M. The
// caller (generator.ts's classifyGenerationStatus) is the one place
// permitted to combine this fact with the generator's own
// searchBudgetExceeded flag, purely to choose between two honest labels for
// an already-independently-confirmed incompleteness (INCOMPLETE vs
// SEARCH_EXHAUSTED) — never to decide whether the shortfall itself is real.
//
// What this does NOT check: soft preferences (avoid first/last period,
// teacher adjacency) — those are, by definition, allowed to be violated and
// are reported separately as SoftViolation[], not hard-constraint failures.
// ===========================================================

import type {
  SchoolConfig,
  Teacher,
  LessonRequirement,
  TimetableEntry,
  FinalValidationIssue,
  FinalValidationReport,
} from "./types";
import { allowedDaysFor, effectiveWeeklyCapacity, effectiveDailyCapacity } from "./feasibility";

function slotKey(day: string, period: number): string {
  return `${day}#${period}`;
}
function entryKey(e: TimetableEntry): string {
  return `${e.classSectionId}::${e.subjectId}::${e.teacherId}::${e.roomId ?? ""}::${e.day}::${e.period}`;
}
function reqKey(classSectionId: string, subjectId: string, teacherId: string): string {
  return `${classSectionId}::${subjectId}::${teacherId}`;
}
function classSubjectKey(classSectionId: string, subjectId: string): string {
  return `${classSectionId}::${subjectId}`;
}

// The ONLY inputs this module accepts: the raw output entries, and the
// same configuration/requirements the generator was given. Deliberately no
// `unplaced` list, no `searchBudgetExceeded` flag, no generator result of
// any kind — see the module doc above for why.
export interface FinalValidationInput {
  school: SchoolConfig;
  teachers: Teacher[];
  requirements: LessonRequirement[];
  entries: TimetableEntry[];
}

function isBlocked(school: SchoolConfig, period: number): boolean {
  return !!school.blockedPeriods?.includes(period);
}

function isTeacherUnavailable(teacher: Teacher | undefined, day: string, period: number): boolean {
  return !!teacher?.unavailable?.some((s) => s.day === day && s.period === period);
}

// An "under" required_period_count_mismatch is the ONE issue kind that is
// expected and normal for a genuinely incomplete/exhausted run — it's not,
// by itself, proof of a bug. Every other issue kind (including an "over"
// mismatch) represents something that must never happen, regardless of how
// complete the run is. Callers that need to distinguish "the generator has
// a genuine, honest shortfall" from "something is actually broken" should
// use this, rather than re-deriving the distinction themselves.
export function isStructuralIssue(issue: FinalValidationIssue): boolean {
  return !(issue.kind === "required_period_count_mismatch" && issue.direction === "under");
}

export function validateGeneratedTimetable(input: FinalValidationInput): FinalValidationReport {
  const { school, entries, requirements } = input;
  const issues: FinalValidationIssue[] = [];
  const teacherById = new Map(input.teachers.map((t) => [t.id, t]));

  // ---- duplicate rows ----
  const seenEntryKeys = new Map<string, number>();
  for (const e of entries) {
    const k = entryKey(e);
    seenEntryKeys.set(k, (seenEntryKeys.get(k) ?? 0) + 1);
  }
  for (const [k, count] of seenEntryKeys) {
    if (count > 1) {
      const [classSectionId, subjectId, teacherId, , day, period] = k.split("::");
      issues.push({
        kind: "duplicate_entry",
        classSectionId,
        subjectId,
        teacherId,
        day,
        period: Number(period),
        reason: `The exact same timetable row appears ${count} times.`,
      });
    }
  }

  // ---- double-booking: class / teacher / room ----
  const bySlotClass = new Map<string, TimetableEntry[]>();
  const bySlotTeacher = new Map<string, TimetableEntry[]>();
  const bySlotRoom = new Map<string, TimetableEntry[]>();
  const pushInto = (map: Map<string, TimetableEntry[]>, key: string, e: TimetableEntry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  };
  for (const e of entries) {
    const sk = slotKey(e.day, e.period);
    pushInto(bySlotClass, `${e.classSectionId}@${sk}`, e);
    pushInto(bySlotTeacher, `${e.teacherId}@${sk}`, e);
    if (e.roomId) pushInto(bySlotRoom, `${e.roomId}@${sk}`, e);
  }
  for (const [, group] of bySlotClass) {
    if (group.length > 1) {
      const e = group[0];
      issues.push({
        kind: "class_double_booking",
        classSectionId: e.classSectionId,
        day: e.day,
        period: e.period,
        reason: `Class is booked into ${group.length} different lessons at ${e.day} period ${e.period}.`,
      });
    }
  }
  for (const [, group] of bySlotTeacher) {
    if (group.length > 1) {
      const e = group[0];
      issues.push({
        kind: "teacher_double_booking",
        teacherId: e.teacherId,
        day: e.day,
        period: e.period,
        reason: `Teacher is booked into ${group.length} different classes at ${e.day} period ${e.period}.`,
      });
    }
  }
  for (const [, group] of bySlotRoom) {
    if (group.length > 1) {
      const e = group[0];
      issues.push({
        kind: "room_double_booking",
        roomId: e.roomId,
        day: e.day,
        period: e.period,
        reason: `Room is booked into ${group.length} different lessons at ${e.day} period ${e.period}.`,
      });
    }
  }

  // ---- per-requirement checks: allowed days, teacher availability, blocked
  // periods, daily/weekly caps, required period counts ----
  const requirementByKey = new Map<string, LessonRequirement>();
  for (const r of requirements) requirementByKey.set(reqKey(r.classSectionId, r.subjectId, r.teacherId), r);

  const entriesByRequirement = new Map<string, TimetableEntry[]>();
  const orphanEntries: TimetableEntry[] = [];
  for (const e of entries) {
    const key = reqKey(e.classSectionId, e.subjectId, e.teacherId);
    if (!requirementByKey.has(key)) {
      orphanEntries.push(e);
      continue;
    }
    if (!entriesByRequirement.has(key)) entriesByRequirement.set(key, []);
    entriesByRequirement.get(key)!.push(e);
  }
  for (const e of orphanEntries) {
    issues.push({
      kind: "duplicate_entry",
      classSectionId: e.classSectionId,
      subjectId: e.subjectId,
      teacherId: e.teacherId,
      day: e.day,
      period: e.period,
      reason: "This timetable entry doesn't match any current lesson requirement (class/subject/teacher).",
    });
  }

  const teacherDailyCount = new Map<string, Map<string, number>>(); // teacherId -> day -> count
  const teacherWeeklyCount = new Map<string, number>();

  for (const req of requirements) {
    const key = reqKey(req.classSectionId, req.subjectId, req.teacherId);
    const reqEntries = entriesByRequirement.get(key) ?? [];
    const allowedDays = allowedDaysFor(req, school);
    const fixedDaysSet = req.fixedDays && req.fixedDays.length > 0;

    for (const e of reqEntries) {
      if (isBlocked(school, e.period)) {
        issues.push({
          kind: "blocked_period",
          lessonRequirementId: req.id,
          classSectionId: e.classSectionId,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          day: e.day,
          period: e.period,
          reason: `Period ${e.period} is a blocked (break/lunch) period.`,
        });
      }

      if (!school.workingDays.includes(e.day)) {
        issues.push({
          kind: "non_working_day",
          lessonRequirementId: req.id,
          classSectionId: e.classSectionId,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          day: e.day,
          period: e.period,
          reason: `${e.day} is not a working day.`,
        });
      } else if (!allowedDays.includes(e.day)) {
        issues.push({
          kind: fixedDaysSet ? "fixed_day_violation" : "non_working_day",
          lessonRequirementId: req.id,
          classSectionId: e.classSectionId,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          day: e.day,
          period: e.period,
          reason: fixedDaysSet
            ? `Placed on ${e.day}, which isn't one of this requirement's fixed days (${req.fixedDays!.join(", ")}).`
            : `${e.day} is not an allowed day for this requirement.`,
        });
      }

      const teacher = teacherById.get(req.teacherId);
      if (isTeacherUnavailable(teacher, e.day, e.period)) {
        issues.push({
          kind: "teacher_unavailable",
          lessonRequirementId: req.id,
          classSectionId: e.classSectionId,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          day: e.day,
          period: e.period,
          reason: `Teacher is marked unavailable at ${e.day} period ${e.period}.`,
        });
      }

      if (!teacherDailyCount.has(req.teacherId)) teacherDailyCount.set(req.teacherId, new Map());
      const dMap = teacherDailyCount.get(req.teacherId)!;
      dMap.set(e.day, (dMap.get(e.day) ?? 0) + 1);
      teacherWeeklyCount.set(req.teacherId, (teacherWeeklyCount.get(req.teacherId) ?? 0) + 1);
    }

    // Required period count: computed purely from the raw entries against
    // the requirement's own periodsPerWeek — no generator flag of any kind
    // is consulted here. Over-placement is never legitimate; under-
    // placement is reported as a plain fact every time it's found. It is
    // the CALLER's job (using isStructuralIssue / generator.ts's
    // classifyGenerationStatus) to decide what an "under" mismatch means —
    // this function makes no claim about whether it's acceptable.
    const placed = reqEntries.length;
    if (placed !== req.periodsPerWeek) {
      const direction = placed > req.periodsPerWeek ? "over" : "under";
      issues.push({
        kind: "required_period_count_mismatch",
        lessonRequirementId: req.id,
        classSectionId: req.classSectionId,
        subjectId: req.subjectId,
        teacherId: req.teacherId,
        direction,
        reason: `Requires ${req.periodsPerWeek} period(s)/week but the timetable has ${placed}.`,
      });
    }
  }

  // ---- teacher daily/weekly capacity (effective = min(explicit, physical)) ----
  for (const t of input.teachers) {
    const weekly = teacherWeeklyCount.get(t.id) ?? 0;
    const weeklyCap = effectiveWeeklyCapacity(t, school);
    if (weekly > weeklyCap) {
      issues.push({
        kind: "teacher_weekly_max_exceeded",
        teacherId: t.id,
        reason: `Teacher has ${weekly} period(s) placed this week, exceeding the effective cap of ${weeklyCap}.`,
      });
    }
    const dailyCap = effectiveDailyCapacity(t, school);
    const dMap = teacherDailyCount.get(t.id);
    if (dMap) {
      for (const [day, count] of dMap) {
        if (count > dailyCap) {
          issues.push({
            kind: "teacher_daily_max_exceeded",
            teacherId: t.id,
            day,
            reason: `Teacher has ${count} period(s) placed on ${day}, exceeding the effective daily cap of ${dailyCap}.`,
          });
        }
      }
    }
  }

  // ---- no-repeat-same-day + double-period continuity, grouped by
  // (class, subject) — mirrors generator.ts's own grouping key exactly, so
  // this is a genuine independent re-check of the same intended rule ----
  const byClassSubject = new Map<string, LessonRequirement[]>();
  for (const r of requirements) {
    const k = classSubjectKey(r.classSectionId, r.subjectId);
    if (!byClassSubject.has(k)) byClassSubject.set(k, []);
    byClassSubject.get(k)!.push(r);
  }

  for (const [, reqsForGroup] of byClassSubject) {
    const { classSectionId, subjectId } = reqsForGroup[0];
    // Conservative: if ANY requirement sharing this class+subject disallows
    // repeats, the whole group is treated as hard no-repeat.
    const hardNoRepeat = reqsForGroup.some((r) => !r.allowRepeatSameDay);
    const isLab = !!reqsForGroup[0].isLab;

    const groupEntries = entries.filter(
      (e) => e.classSectionId === classSectionId && e.subjectId === subjectId
    );
    const byDay = new Map<string, number[]>();
    for (const e of groupEntries) {
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day)!.push(e.period);
    }

    let unpairedTotal = 0;
    for (const [day, periodsRaw] of byDay) {
      const periods = [...periodsRaw].sort((a, b) => a - b);

      // Occurrence count for this day: for a lab subject, a contiguous run
      // of periods is ONE occurrence (the double-period block), not two.
      let occurrences = 0;
      let i = 0;
      while (i < periods.length) {
        if (isLab && i + 1 < periods.length && periods[i + 1] === periods[i] + 1) {
          occurrences++;
          i += 2;
        } else {
          occurrences++;
          if (isLab) unpairedTotal++; // a lone period in a lab group — possibly the legitimate odd leftover
          i += 1;
        }
      }

      if (hardNoRepeat && occurrences > 1) {
        issues.push({
          kind: "no_repeat_violation",
          classSectionId,
          subjectId,
          day,
          reason: `${occurrences} separate occurrences of this subject on ${day}, but repeats are not allowed.`,
        });
      }
    }

    if (isLab) {
      // Exactly one unpaired (odd) period is legitimate only when the sum
      // of periodsPerWeek across this group is odd; anything else means a
      // double-period got split or an extra stray single crept in.
      const totalRequired = reqsForGroup.reduce((sum, r) => sum + r.periodsPerWeek, 0);
      const allowedUnpaired = totalRequired % 2 === 1 ? 1 : 0;
      if (unpairedTotal > allowedUnpaired) {
        issues.push({
          kind: "double_period_continuity_violation",
          classSectionId,
          subjectId,
          reason: `${unpairedTotal} single (non-consecutive) period(s) found for a double-period subject where at most ${allowedUnpaired} is expected.`,
        });
      }
    }
  }

  // ---- room_unavailable: no data source exists in the current data model
  // for per-room unavailability (Room only has {id, name}) — this check is
  // kept as a documented, always-empty no-op so it's already wired up the
  // moment that concept is added, rather than silently absent from the
  // validator's coverage. ----

  return { valid: issues.length === 0, issues };
}
