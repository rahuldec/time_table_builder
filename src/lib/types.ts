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
}

export interface TimetableEntry {
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

export interface GenerationResult {
  entries: TimetableEntry[];
  unplaced: UnplacedItem[];
  score: number; // lower is better - used to pick best of N random restarts
}
