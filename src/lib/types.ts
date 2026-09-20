// ===== Core domain types =====

export interface SchoolConfig {
  workingDays: string[];       // e.g. ["Mon","Tue","Wed","Thu","Fri","Sat"]
  periodsPerDay: number;       // e.g. 8
  // periods that are breaks/lunch and should never be scheduled (0-indexed period numbers)
  blockedPeriods?: number[];
}

export interface Slot {
  day: string;
  period: number; // 1-indexed
}

export interface Teacher {
  id: string;
  name: string;
  maxPeriodsPerDay?: number;     // optional cap
  maxPeriodsPerWeek?: number;    // optional cap
  unavailable?: Slot[];          // slots this teacher can never teach
}

export interface Room {
  id: string;
  name: string;
}

export interface ClassSection {
  id: string;
  name: string; // e.g. "Grade 6 - Ganges"
}

export interface Subject {
  id: string;
  name: string;
  isLab?: boolean; // if true, periods are scheduled as consecutive double-periods where possible
}

// One row = "this class needs this subject taught by this teacher, N times/week"
export interface LessonRequirement {
  id: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  periodsPerWeek: number;
  roomId?: string; // required room (e.g. a specific lab) - omit for regular classroom subjects
  isLab?: boolean; // overrides subject.isLab if set
  fixedDays?: string[]; // if non-empty, every period of this requirement must land on one of these days (hard constraint)

  // ----- rule flags, copied from the subject at generation time -----
  avoidFirstPeriod?: boolean;   // never place this subject in the day's first teaching period (soft)
  avoidLastPeriod?: boolean;    // never place this subject in the day's last teaching period (soft)
  // Hard constraint (default false = no repeat). When false, the same
  // subject may occur at most once per class-section per day — full stop,
  // never relaxed. When true, repeats are allowed with no penalty.
  allowRepeatSameDay?: boolean;
}

// A pair of teachers who should never teach back-to-back for the same class
export interface TeacherPair {
  teacherAId: string;
  teacherBId: string;
}

export interface TimetableEntry {
  // The originating requirement, unambiguously. Required — never derive a
  // requirement/entry association from class+subject+teacher alone, since
  // two distinct requirements can legitimately share all three (different
  // room, different fixed days).
  lessonRequirementId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  roomId?: string;
  day: string;
  period: number;
}

export interface UnplacedItem {
  lessonRequirementId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  reason: string;
}

// A soft (never hard) rule that had to be broken to fit a unit in, reported
// individually rather than as a bare count.
export interface SoftViolation {
  lessonRequirementId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  day: string;
  period: number;
  reason: string; // e.g. "avoid-first-period", "avoid-last-period", "teacher-adjacency"
}

export interface GenerationResult {
  entries: TimetableEntry[];
  unplaced: UnplacedItem[];
  score: number; // lower is better - used to pick best of N attempts
  /** @deprecated count form of softViolations.length, kept for existing callers */
  ruleViolations: number;
  softViolations: SoftViolation[];
  // true if the backtracking search hit its step/time budget before
  // exhausting the search space for one or more units — the resulting
  // "unplaced" list for those units is not a proof of infeasibility, just
  // as far as the search got in the time allowed.
  searchBudgetExceeded: boolean;
}

// ===== Pre-generation feasibility / validation =====

export type GenerationStatus =
  | "valid" // every period placed, zero hard constraints violated, zero soft violations
  | "valid_with_warnings" // every period placed, zero hard constraints violated, some soft preferences relaxed
  | "incomplete" // search completed (did not hit its budget) but some periods could not be placed
  | "invalid_configuration" // the requirements are mathematically contradictory — generation was not attempted
  | "search_exhausted" // the search hit its step/time budget before finishing — NOT proof the configuration is impossible
  | "validation_failed"; // the independent final check found a structural hard-constraint violation the generator itself didn't report — never a normal outcome, never to be shown as incomplete/exhausted

export interface RequirementFeasibilityIssue {
  kind: "requirement_infeasible";
  lessonRequirementId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  required: number;
  maxPossible: number;
  allowedDays: string[];
  reason: string;
}

export interface FixedDayIssue {
  kind: "fixed_day_not_working";
  lessonRequirementId: string;
  invalidDays: string[]; // entries in fixedDays that aren't in workingDays
  workingDays: string[];
  reason: string;
}

export interface TeacherCapacityIssue {
  kind: "teacher_capacity_exceeded";
  teacherId: string;
  required: number;
  maximum: number;
  shortage: number;
  scope: "week" | "day";
  day?: string; // present when scope === "day"
  reason: string;
  // Per class/subject contribution to `required`, so a curriculum/import
  // problem (e.g. one teacher assigned to far too many classes) can be told
  // apart from a genuinely overloaded configuration at a glance.
  breakdown: { classSectionId: string; subjectId: string; periodsPerWeek: number }[];
}

export interface ReferenceIssue {
  kind: "invalid_reference";
  lessonRequirementId: string;
  missing: ("classSectionId" | "subjectId" | "teacherId" | "roomId")[];
  reason: string;
}

export interface SchoolConfigIssue {
  kind: "school_config_invalid";
  reason: string;
}

export type ConfigurationIssue =
  | RequirementFeasibilityIssue
  | FixedDayIssue
  | TeacherCapacityIssue
  | ReferenceIssue
  | SchoolConfigIssue;

export interface FeasibilityReport {
  valid: boolean;
  issues: ConfigurationIssue[];
}

// ===== Final (post-generation) validation =====
//
// Independently re-derives hard-constraint compliance from the raw
// TimetableEntry[] a generation run produced, WITHOUT trusting any of the
// generator's own bookkeeping (grids, counters, "unplaced" list). This is
// the last line of defense: a generator bug that let a hard rule slip
// through must be caught here, or the app must never say VALID.

export type FinalValidationIssueKind =
  | "class_double_booking"
  | "teacher_double_booking"
  | "room_double_booking"
  | "non_working_day"
  | "fixed_day_violation"
  | "no_repeat_violation"
  | "teacher_unavailable"
  | "room_unavailable"
  | "blocked_period"
  | "teacher_daily_max_exceeded"
  | "teacher_weekly_max_exceeded"
  | "required_period_count_mismatch"
  | "double_period_continuity_violation"
  | "duplicate_entry"
  | "room_mismatch"
  | "period_out_of_range";

export interface FinalValidationIssue {
  kind: FinalValidationIssueKind;
  reason: string;
  lessonRequirementId?: string;
  classSectionId?: string;
  subjectId?: string;
  teacherId?: string;
  roomId?: string;
  day?: string;
  period?: number;
  // Only present for kind === "required_period_count_mismatch": "under"
  // means fewer periods were placed than required (expected whenever a run
  // is genuinely incomplete), "over" means more were placed than required
  // (never legitimate, under any circumstance).
  direction?: "under" | "over";
}

export interface FinalValidationReport {
  valid: boolean;
  issues: FinalValidationIssue[];
}
