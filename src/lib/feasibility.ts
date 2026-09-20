// ===========================================================
// Pre-generation feasibility validation.
//
// Runs BEFORE the scheduler ever attempts a placement. Its job is to catch
// requirements that are mathematically impossible to satisfy given the
// school's own configuration — 5 periods/week pinned to a single day with
// no-repeat, a teacher assigned more periods than their weekly cap, a fixed
// day that isn't even a working day, a dangling reference to a deleted
// class/subject/teacher/room — and report them precisely instead of letting
// the generator either violate a hard rule to "make it work" or silently
// drop the excess into an unexplained "unplaced" pile.
//
// This is a NECESSARY-condition check, not a full CSP solver: it proves a
// configuration is *infeasible* whenever the numbers can't possibly add up
// (that's the whole point — those cases must never reach generation at
// all), but passing these checks does not *guarantee* the backtracking
// search in generator.ts will find a slot for every period, because slot
// contention between requirements (two different subjects fighting over the
// same teacher/room/day) can only be discovered by actually attempting
// placement. That remaining gap is exactly what generator.ts's
// "incomplete" status (as opposed to "invalid_configuration") is for.
// ===========================================================

import type {
  SchoolConfig,
  Teacher,
  LessonRequirement,
  ConfigurationIssue,
  FeasibilityReport,
} from "./types";

function isBlocked(school: SchoolConfig, period: number): boolean {
  return !!school.blockedPeriods?.includes(period);
}

export function availablePeriodsPerDay(school: SchoolConfig): number {
  let count = 0;
  for (let p = 1; p <= school.periodsPerDay; p++) {
    if (!isBlocked(school, p)) count++;
  }
  return count;
}

// number of period p where [p, p+1] are both free and in range — i.e. how
// many double-period slots exist in a day
function availableDoubleSlotsPerDay(school: SchoolConfig): number {
  let count = 0;
  for (let p = 1; p <= school.periodsPerDay - 1; p++) {
    if (!isBlocked(school, p) && !isBlocked(school, p + 1)) count++;
  }
  return count;
}

/** fixedDays ∩ workingDays — the ONLY set of days a pinned requirement may ever use. */
export function allowedDaysFor(req: LessonRequirement, school: SchoolConfig): string[] {
  if (req.fixedDays && req.fixedDays.length > 0) {
    return req.fixedDays.filter((d) => school.workingDays.includes(d));
  }
  return school.workingDays;
}

/**
 * Upper bound on how many periods/week this requirement could ever occupy,
 * given its allowed days, whether it's a double-period (lab) requirement,
 * and whether repeating the subject on the same day is allowed. This is a
 * necessary-condition ceiling (see module doc) — required > max is a hard
 * proof of infeasibility; required <= max does not by itself prove a valid
 * arrangement exists once other requirements are competing for the same
 * teacher/room/slots.
 */
export function maxPossiblePeriods(req: LessonRequirement, school: SchoolConfig): number {
  const allowedDays = allowedDaysFor(req, school);
  if (allowedDays.length === 0) return 0;

  const allowRepeat = !!req.allowRepeatSameDay;

  if (!req.isLab) {
    if (!allowRepeat) return allowedDays.length; // one occurrence per allowed day, full stop
    return allowedDays.length * availablePeriodsPerDay(school);
  }

  // Double-period (lab) requirement: each occurrence is a 2-period block.
  if (!allowRepeat) return allowedDays.length * 2; // one double-block per allowed day
  return allowedDays.length * availableDoubleSlotsPerDay(school) * 2;
}

export function validateSchoolConfig(school: SchoolConfig): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (!school.workingDays || school.workingDays.length === 0) {
    issues.push({
      kind: "school_config_invalid",
      reason: "No working days are configured — nothing can ever be scheduled.",
    });
  }
  if (!Number.isInteger(school.periodsPerDay) || school.periodsPerDay < 1) {
    issues.push({
      kind: "school_config_invalid",
      reason: "periodsPerDay must be a whole number of at least 1.",
    });
  }
  return issues;
}

export function validateFixedDays(
  req: LessonRequirement,
  school: SchoolConfig
): ConfigurationIssue[] {
  if (!req.fixedDays || req.fixedDays.length === 0) return [];
  const invalidDays = req.fixedDays.filter((d) => !school.workingDays.includes(d));
  if (invalidDays.length === 0) return [];
  return [
    {
      kind: "fixed_day_not_working",
      lessonRequirementId: req.id,
      invalidDays,
      workingDays: school.workingDays,
      reason: `${invalidDays.join(", ")} not a working day — the school works ${school.workingDays.join(", ")}.`,
    },
  ];
}

export function checkRequirementFeasibility(
  req: LessonRequirement,
  school: SchoolConfig
): ConfigurationIssue | null {
  const allowedDays = allowedDaysFor(req, school);
  const max = maxPossiblePeriods(req, school);
  if (req.periodsPerWeek <= max) return null;
  return {
    kind: "requirement_infeasible",
    lessonRequirementId: req.id,
    classSectionId: req.classSectionId,
    subjectId: req.subjectId,
    teacherId: req.teacherId,
    required: req.periodsPerWeek,
    maxPossible: max,
    allowedDays,
    reason:
      allowedDays.length === 0
        ? "No allowed day remains once fixed days are restricted to the school's working days."
        : `Required ${req.periodsPerWeek} periods/week, but ${
            req.allowRepeatSameDay ? "" : "no-repeat-per-day plus "
          }${allowedDays.length} allowed day(s) cap this at ${max}.`,
  };
}

// A person can never occupy two slots at once, no matter what cap (if any)
// is configured on their record — so the school's own weekly/daily slot
// count is an absolute, implicit ceiling every teacher is bound by. The
// *effective* cap actually in force is always the tighter of the two: an
// explicit configured cap only matters when it's stricter than what's
// physically possible, and physical reality wins whenever nobody bothered
// to configure a cap at all (or configured one looser than reality).
export function physicalWeeklyCapacity(school: SchoolConfig): number {
  return availablePeriodsPerDay(school) * school.workingDays.length;
}

// A teacher's OWN physical capacity is the school's total weekly slots
// minus whichever of their declared-unavailable slots actually fall on a
// real, schedulable slot (a working day, an in-range and non-blocked
// period). An unavailable entry pointing at a slot that could never be
// scheduled anyway (a non-working day, a blocked period, an out-of-range
// period) doesn't reduce capacity further — it wasn't available regardless.
// Duplicate unavailable entries for the same slot are only counted once.
export function teacherPhysicalWeeklyCapacity(teacher: Teacher, school: SchoolConfig): number {
  const totalSlots = physicalWeeklyCapacity(school);
  const validUnavailableSlots = new Set(
    (teacher.unavailable ?? [])
      .filter(
        (s) =>
          school.workingDays.includes(s.day) &&
          s.period >= 1 &&
          s.period <= school.periodsPerDay &&
          !isBlocked(school, s.period)
      )
      .map((s) => `${s.day}#${s.period}`)
  );
  return Math.max(0, totalSlots - validUnavailableSlots.size);
}

export function effectiveWeeklyCapacity(teacher: Teacher, school: SchoolConfig): number {
  const physical = teacherPhysicalWeeklyCapacity(teacher, school);
  return teacher.maxPeriodsPerWeek != null ? Math.min(teacher.maxPeriodsPerWeek, physical) : physical;
}

export function effectiveDailyCapacity(teacher: Teacher, school: SchoolConfig): number {
  const physical = availablePeriodsPerDay(school);
  return teacher.maxPeriodsPerDay != null ? Math.min(teacher.maxPeriodsPerDay, physical) : physical;
}

export function validateTeacherCapacity(
  requirements: LessonRequirement[],
  teachers: Teacher[],
  school: SchoolConfig
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const weeklyByTeacher = new Map<string, number>();
  const breakdownByTeacher = new Map<string, { classSectionId: string; subjectId: string; periodsPerWeek: number }[]>();
  for (const req of requirements) {
    weeklyByTeacher.set(req.teacherId, (weeklyByTeacher.get(req.teacherId) ?? 0) + req.periodsPerWeek);
    if (!breakdownByTeacher.has(req.teacherId)) breakdownByTeacher.set(req.teacherId, []);
    breakdownByTeacher.get(req.teacherId)!.push({
      classSectionId: req.classSectionId,
      subjectId: req.subjectId,
      periodsPerWeek: req.periodsPerWeek,
    });
  }

  const implicitWeeklyCeiling = physicalWeeklyCapacity(school);

  for (const t of teachers) {
    const required = weeklyByTeacher.get(t.id) ?? 0;
    if (required === 0) continue;
    const breakdown = breakdownByTeacher.get(t.id) ?? [];

    let flagged = false;

    if (t.maxPeriodsPerWeek != null && required > t.maxPeriodsPerWeek) {
      issues.push({
        kind: "teacher_capacity_exceeded",
        teacherId: t.id,
        required,
        maximum: t.maxPeriodsPerWeek,
        shortage: required - t.maxPeriodsPerWeek,
        scope: "week",
        reason: `Teacher requires ${required} periods/week but is capped at ${t.maxPeriodsPerWeek}/week.`,
        breakdown,
      });
      flagged = true;
    }

    // A daily cap implies a weekly ceiling of cap × working days, regardless
    // of how the periods end up distributed — a necessary condition check,
    // same reasoning as maxPossiblePeriods above.
    if (t.maxPeriodsPerDay != null) {
      const impliedWeeklyCeiling = t.maxPeriodsPerDay * school.workingDays.length;
      if (required > impliedWeeklyCeiling) {
        issues.push({
          kind: "teacher_capacity_exceeded",
          teacherId: t.id,
          required,
          maximum: t.maxPeriodsPerDay,
          shortage: required - impliedWeeklyCeiling,
          scope: "day",
          reason: `Teacher requires ${required} periods/week, which can't fit within a ${t.maxPeriodsPerDay}/day cap across ${school.workingDays.length} working day(s) (max ${impliedWeeklyCeiling}/week).`,
          breakdown,
        });
        flagged = true;
      }
    }

    // Only report the implicit physical ceiling if no explicit, more
    // specific cap already caught this teacher — avoids redundant issues
    // when an admin-configured cap is already the tighter/relevant one.
    if (!flagged && required > implicitWeeklyCeiling) {
      issues.push({
        kind: "teacher_capacity_exceeded",
        teacherId: t.id,
        required,
        maximum: implicitWeeklyCeiling,
        shortage: required - implicitWeeklyCeiling,
        scope: "week",
        reason: `Teacher requires ${required} periods/week, but the school week only has ${implicitWeeklyCeiling} periods total (${school.workingDays.length} day(s) × ${availablePeriodsPerDay(school)} period(s)/day) — no single teacher can be scheduled for more than that, regardless of any configured cap.`,
        breakdown,
      });
    }
  }

  return issues;
}

export interface ReferenceSets {
  classSectionIds: Set<string>;
  subjectIds: Set<string>;
  teacherIds: Set<string>;
  roomIds: Set<string>;
}

export function validateReferences(
  requirements: LessonRequirement[],
  ids: ReferenceSets
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const req of requirements) {
    const missing: ("classSectionId" | "subjectId" | "teacherId" | "roomId")[] = [];
    if (!ids.classSectionIds.has(req.classSectionId)) missing.push("classSectionId");
    if (!ids.subjectIds.has(req.subjectId)) missing.push("subjectId");
    if (!ids.teacherIds.has(req.teacherId)) missing.push("teacherId");
    if (req.roomId && !ids.roomIds.has(req.roomId)) missing.push("roomId");
    if (missing.length > 0) {
      issues.push({
        kind: "invalid_reference",
        lessonRequirementId: req.id,
        missing,
        reason: `References a deleted ${missing.join(", ")}.`,
      });
    }
  }
  return issues;
}

export interface FeasibilityInput {
  school: SchoolConfig;
  teachers: Teacher[];
  requirements: LessonRequirement[];
  /** Omit to skip reference validation (e.g. in tests using synthetic ids that are known-good). */
  referenceIds?: ReferenceSets;
}

export function runFeasibilityChecks(input: FeasibilityInput): FeasibilityReport {
  const issues: ConfigurationIssue[] = [];

  issues.push(...validateSchoolConfig(input.school));

  let requirements = input.requirements;
  if (input.referenceIds) {
    const refIssues = validateReferences(requirements, input.referenceIds);
    issues.push(...refIssues);
    const brokenIds = new Set(refIssues.map((i) => (i.kind === "invalid_reference" ? i.lessonRequirementId : "")));
    requirements = requirements.filter((r) => !brokenIds.has(r.id));
  }

  const schoolConfigOk =
    input.school.workingDays.length > 0 &&
    Number.isInteger(input.school.periodsPerDay) &&
    input.school.periodsPerDay >= 1;

  for (const req of requirements) {
    issues.push(...validateFixedDays(req, input.school));
  }

  if (schoolConfigOk) {
    for (const req of requirements) {
      const issue = checkRequirementFeasibility(req, input.school);
      if (issue) issues.push(issue);
    }
    issues.push(...validateTeacherCapacity(requirements, input.teachers, input.school));
  }

  return { valid: issues.length === 0, issues };
}
