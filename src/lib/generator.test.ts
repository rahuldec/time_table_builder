import { describe, it, expect } from "vitest";
import { generateTimetable, classifyGenerationStatus } from "./generator";
import { validateGeneratedTimetable } from "./finalValidator";
import type { SchoolConfig, Teacher, LessonRequirement, TimetableEntry } from "./types";

function school(overrides: Partial<SchoolConfig> = {}): SchoolConfig {
  return {
    workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    periodsPerDay: 8,
    blockedPeriods: [],
    ...overrides,
  };
}

function teacher(id: string, overrides: Partial<Teacher> = {}): Teacher {
  return { id, name: id, ...overrides };
}

function req(overrides: Partial<LessonRequirement> & { id: string }): LessonRequirement {
  return {
    classSectionId: "class-1",
    subjectId: "subj-1",
    teacherId: "teacher-1",
    periodsPerWeek: 1,
    ...overrides,
  };
}

// Hard-constraint sanity check reused across tests: a VALID timetable must
// never double-book a class, teacher, or room in the same day/period.
function assertNoDoubleBooking(entries: TimetableEntry[]) {
  const classSlots = new Set<string>();
  const teacherSlots = new Set<string>();
  const roomSlots = new Set<string>();
  for (const e of entries) {
    const slot = `${e.day}#${e.period}`;
    const classKey = `${e.classSectionId}@${slot}`;
    expect(classSlots.has(classKey), `class double-booked at ${classKey}`).toBe(false);
    classSlots.add(classKey);

    const teacherKey = `${e.teacherId}@${slot}`;
    expect(teacherSlots.has(teacherKey), `teacher double-booked at ${teacherKey}`).toBe(false);
    teacherSlots.add(teacherKey);

    if (e.roomId) {
      const roomKey = `${e.roomId}@${slot}`;
      expect(roomSlots.has(roomKey), `room double-booked at ${roomKey}`).toBe(false);
      roomSlots.add(roomKey);
    }
  }
}

describe("hard constraints are never violated", () => {
  // Case 5
  it("two classes cannot use the same teacher at the same time", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 1 }); // exactly one slot exists, total
    const lessons = [
      req({ id: "r1", classSectionId: "class-A", teacherId: "teacher-1" }),
      req({ id: "r2", classSectionId: "class-B", teacherId: "teacher-1" }),
    ];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 3,
    });
    assertNoDoubleBooking(result.entries);
    // only one of the two can physically fit in the one slot that exists
    expect(result.entries.length).toBe(1);
    expect(result.unplaced.length).toBe(1);
  });

  // Case 6
  it("two classes cannot use the same room at the same time", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 1 });
    const lessons = [
      req({ id: "r1", classSectionId: "class-A", teacherId: "teacher-1", roomId: "room-1" }),
      req({ id: "r2", classSectionId: "class-B", teacherId: "teacher-2", roomId: "room-1" }),
    ];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1"), teacher("teacher-2")],
      classSections: [],
      lessons,
      attempts: 3,
    });
    assertNoDoubleBooking(result.entries);
    expect(result.entries.length).toBe(1);
    expect(result.unplaced.length).toBe(1);
  });

  // Cases 7 & 8
  it("a double period stays consecutive and never crosses a blocked period", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 4, blockedPeriods: [2] });
    const lessons = [req({ id: "r1", periodsPerWeek: 2, isLab: true })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 5,
    });
    expect(result.unplaced).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    const periods = result.entries.map((e) => e.period).sort((a, b) => a - b);
    expect(periods[1] - periods[0]).toBe(1); // consecutive
    expect(periods).not.toContain(2); // never touches the blocked period
    // period 1 can't pair with blocked period 2, so the only legal double is [3,4]
    expect(periods).toEqual([3, 4]);
  });

  // Case 9
  it("a teacher-unavailable period is never used", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 2 });
    const t = teacher("teacher-1", { unavailable: [{ day: "Mon", period: 1 }] });
    const lessons = [req({ id: "r1" })];
    const result = generateTimetable({ school: s, teachers: [t], classSections: [], lessons, attempts: 3 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].period).toBe(2);
  });

  // Case 10
  it("a blocked period is never used for any class", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 3, blockedPeriods: [2] });
    const lessons = [req({ id: "r1", periodsPerWeek: 3, allowRepeatSameDay: true })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 3,
    });
    expect(result.entries.some((e) => e.period === 2)).toBe(false);
    // only periods 1 and 3 exist, so at most 2 of the 3 requested periods fit
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  // Case 15
  it("a busier, more realistic scenario never contains a hard-constraint violation", () => {
    const s = school();
    const lessons: LessonRequirement[] = [];
    for (let c = 0; c < 5; c++) {
      for (let sub = 0; sub < 4; sub++) {
        lessons.push(
          req({
            id: `r-${c}-${sub}`,
            classSectionId: `class-${c}`,
            subjectId: `subj-${sub}`,
            teacherId: `teacher-${sub}`, // each subject's teacher is shared across all 5 classes
            periodsPerWeek: 4,
          })
        );
      }
    }
    const teachers = [0, 1, 2, 3].map((i) => teacher(`teacher-${i}`));
    const result = generateTimetable({ school: s, teachers, classSections: [], lessons, attempts: 5 });
    assertNoDoubleBooking(result.entries);
  });
});

describe("no-repeat-same-day is a hard rule, not a soft one, when configured", () => {
  // Case 3 / acceptance B & C combined
  it("5 periods across exactly 5 working days -> one per day, none unplaced", () => {
    const s = school(); // Mon-Fri
    const lessons = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: false })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 5,
    });
    expect(result.entries).toHaveLength(5);
    expect(result.unplaced).toHaveLength(0);
    const days = result.entries.map((e) => e.day);
    expect(new Set(days).size).toBe(5); // every entry on its own distinct day
  });

  it("never doubles a subject onto one day to fit everything in — leaves the excess unplaced instead", () => {
    // 6 required, but only 5 working days and no-repeat: a hard cap of 5.
    const s = school();
    const lessons = [req({ id: "r1", periodsPerWeek: 6, allowRepeatSameDay: false })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 5,
    });
    const days = result.entries.map((e) => e.day);
    expect(new Set(days).size).toBe(days.length); // no day appears twice
    expect(result.entries.length).toBe(5);
    expect(result.unplaced.length).toBe(1);
    // This is a hard rule — breaking it is never an option, so it must never
    // show up as a "soft violation" either.
    expect(result.softViolations).toHaveLength(0);
  });
});

// Case 11 / acceptance criterion B
describe("a genuinely feasible requirement generates successfully", () => {
  it("5-period subject across 5 working days places all periods with VALID status", () => {
    const s = school();
    const lessons = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: false })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 5,
    });
    expect(result.unplaced).toHaveLength(0);
    const teachers = [teacher("teacher-1")];
    const finalReport = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements: lessons,
      entries: result.entries,
    });
    expect(finalReport.valid).toBe(true);
    expect(classifyGenerationStatus(result, finalReport)).toBe("valid");
  });
});

// Case 14
describe("a soft-preference violation keeps the result VALID_WITH_WARNINGS, not invalid", () => {
  it("avoid-first-period broken out of necessity still counts as fully placed", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 1 }); // the only period IS the first period
    const lessons = [req({ id: "r1", avoidFirstPeriod: true })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 3,
    });
    expect(result.unplaced).toHaveLength(0);
    expect(result.softViolations.length).toBeGreaterThan(0);
    const teachers = [teacher("teacher-1")];
    const finalReport = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements: lessons,
      entries: result.entries,
    });
    expect(finalReport.valid).toBe(true);
    expect(classifyGenerationStatus(result, finalReport)).toBe("valid_with_warnings");
  });
});

// Case 12
describe("backtracking recovers from a dead end a pure greedy-first-fit would miss", () => {
  it("reassigns an earlier unit's slot so a later, more constrained unit still fits — regardless of processing order", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 2 });
    const flexibleTeacher = teacher("teacher-1"); // free both periods
    const pinnedTeacher = teacher("teacher-2", { unavailable: [{ day: "Mon", period: 2 }] }); // only free at period 1
    const lessons = [
      // avoidLastPeriod makes this unit's *preferred* (lowest-score) choice
      // period 1 — the same period the other unit is hard-pinned to. A
      // naive greedy-first-fit that commits to period 1 here and never
      // reconsiders would strand the second requirement.
      req({ id: "r1", subjectId: "subj-1", teacherId: "teacher-1", avoidLastPeriod: true }),
      req({ id: "r2", subjectId: "subj-2", teacherId: "teacher-2" }),
    ];

    // Exercise every individual seed (not just the best-of-many `attempts`
    // wrapper) so this genuinely tests both possible processing orders,
    // including the one that requires undoing r1's preferred placement.
    for (let seed = 0; seed < 20; seed++) {
      const result = generateTimetable({
        school: s,
        teachers: [flexibleTeacher, pinnedTeacher],
        classSections: [],
        lessons,
        attempts: 1,
        seed,
      });
      expect(result.unplaced, `seed ${seed}`).toHaveLength(0);
      assertNoDoubleBooking(result.entries);
      const periodByTeacher = Object.fromEntries(result.entries.map((e) => [e.teacherId, e.period]));
      expect(periodByTeacher["teacher-2"], `seed ${seed}`).toBe(1);
    }
  });
});

describe("teacher daily/weekly caps are hard", () => {
  it("never exceeds a teacher's max periods/day", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 4 });
    const t = teacher("teacher-1", { maxPeriodsPerDay: 2 });
    const lessons = [req({ id: "r1", periodsPerWeek: 4, allowRepeatSameDay: true })];
    const result = generateTimetable({ school: s, teachers: [t], classSections: [], lessons, attempts: 3 });
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  it("never exceeds a teacher's max periods/week", () => {
    const s = school({ periodsPerDay: 8 }); // Mon-Fri
    const t = teacher("teacher-1", { maxPeriodsPerWeek: 3 });
    const lessons = [req({ id: "r1", periodsPerWeek: 10, allowRepeatSameDay: true })];
    const result = generateTimetable({ school: s, teachers: [t], classSections: [], lessons, attempts: 3 });
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });
});

describe("fixed days are always intersected with working days", () => {
  it("a fixed day outside the working week places nothing on it — the unit is left unplaced, not scheduled anyway", () => {
    const s = school({ workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] });
    const lessons = [req({ id: "r1", fixedDays: ["Sat"] })];
    const result = generateTimetable({
      school: s,
      teachers: [teacher("teacher-1")],
      classSections: [],
      lessons,
      attempts: 3,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.unplaced).toHaveLength(1);
    expect(result.entries.some((e) => e.day === "Sat")).toBe(false);
  });
});

describe("SEARCH_EXHAUSTED is distinct from INCOMPLETE and never claims impossibility", () => {
  // classifyGenerationStatus no longer looks at result.unplaced at all — the
  // only source of truth for "is this run genuinely short of periods" is
  // finalValidation's own independently-derived "under" mismatch issues.
  // `result.searchBudgetExceeded` is consulted ONLY to pick which honest
  // label (INCOMPLETE vs SEARCH_EXHAUSTED) describes an
  // already-independently-confirmed shortfall.
  const shortfallReport = {
    valid: false,
    issues: [
      {
        kind: "required_period_count_mismatch" as const,
        lessonRequirementId: "r1",
        classSectionId: "c1",
        subjectId: "s1",
        teacherId: "t1",
        direction: "under" as const,
        reason: "Requires 5 period(s)/week but the timetable has 3.",
      },
    ],
  };

  it("a run that hit its search budget with a genuine shortfall classifies as search_exhausted, not incomplete", () => {
    const result = { softViolations: [], searchBudgetExceeded: true };
    expect(classifyGenerationStatus(result, shortfallReport)).toBe("search_exhausted");
  });

  it("a run with a genuine shortfall but NO budget exhaustion classifies as incomplete, not search_exhausted", () => {
    const result = { softViolations: [], searchBudgetExceeded: false };
    expect(classifyGenerationStatus(result, shortfallReport)).toBe("incomplete");
  });

  it("search_exhausted is never reported as invalid_configuration — that status is reserved for feasibility.ts, pre-generation", () => {
    const result = { softViolations: [], searchBudgetExceeded: true };
    const status = classifyGenerationStatus(result, shortfallReport);
    expect(status).not.toBe("invalid_configuration");
    expect(status).not.toBe("incomplete");
  });

  it("searchBudgetExceeded alone, with NO independently-confirmed shortfall, does not force search_exhausted", () => {
    // Proves the classifier isn't just echoing the flag — a clean final
    // report (no shortfall found) means there's nothing to label as
    // exhausted or incomplete, regardless of what searchBudgetExceeded says.
    const result = { softViolations: [], searchBudgetExceeded: true };
    const cleanReport = { valid: true, issues: [] };
    expect(classifyGenerationStatus(result, cleanReport)).toBe("valid");
  });
});
