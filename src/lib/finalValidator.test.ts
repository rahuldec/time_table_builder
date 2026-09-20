import { describe, it, expect } from "vitest";
import { validateGeneratedTimetable, type FinalValidationInput } from "./finalValidator";
import { generateTimetable } from "./generator";
import { effectiveWeeklyCapacity, validateTeacherCapacity } from "./feasibility";
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

function entry(overrides: Partial<TimetableEntry> & { day: string; period: number }): TimetableEntry {
  return { classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", ...overrides };
}

function baseInput(overrides: Partial<FinalValidationInput> = {}): FinalValidationInput {
  return {
    school: school(),
    teachers: [teacher("teacher-1")],
    requirements: [req({ id: "r1", periodsPerWeek: 1 })],
    entries: [],
    unplaced: [],
    searchBudgetExceeded: false,
    ...overrides,
  };
}

describe("validateGeneratedTimetable — catches every hard-constraint violation independently", () => {
  // Case 1
  it("catches teacher double-booking", () => {
    const requirements = [
      req({ id: "r1", classSectionId: "class-1", teacherId: "teacher-1" }),
      req({ id: "r2", classSectionId: "class-2", teacherId: "teacher-1" }),
    ];
    const entries = [
      entry({ day: "Mon", period: 1, classSectionId: "class-1", teacherId: "teacher-1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-2", teacherId: "teacher-1" }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "teacher_double_booking")).toBe(true);
  });

  // Case 2
  it("catches class double-booking", () => {
    const requirements = [
      req({ id: "r1", classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1" }),
      req({ id: "r2", classSectionId: "class-1", subjectId: "subj-2", teacherId: "teacher-2" }),
    ];
    const entries = [
      entry({ day: "Mon", period: 1, classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-1", subjectId: "subj-2", teacherId: "teacher-2" }),
    ];
    const report = validateGeneratedTimetable(
      baseInput({ teachers: [teacher("teacher-1"), teacher("teacher-2")], requirements, entries })
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "class_double_booking")).toBe(true);
  });

  // Case 3
  it("catches room double-booking", () => {
    const requirements = [
      req({ id: "r1", classSectionId: "class-1", teacherId: "teacher-1", roomId: "room-1" }),
      req({ id: "r2", classSectionId: "class-2", teacherId: "teacher-2", roomId: "room-1" }),
    ];
    const entries = [
      entry({ day: "Mon", period: 1, classSectionId: "class-1", teacherId: "teacher-1", roomId: "room-1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-2", teacherId: "teacher-2", roomId: "room-1" }),
    ];
    const report = validateGeneratedTimetable(
      baseInput({ teachers: [teacher("teacher-1"), teacher("teacher-2")], requirements, entries })
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "room_double_booking")).toBe(true);
  });

  // Case 4
  it("catches a no-repeat-same-day violation", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 2, allowRepeatSameDay: false })];
    const entries = [
      entry({ day: "Mon", period: 1 }),
      entry({ day: "Mon", period: 2 }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "no_repeat_violation")).toBe(true);
  });

  // Case 5
  it("catches a fixed-day violation", () => {
    const requirements = [req({ id: "r1", fixedDays: ["Mon"] })];
    const entries = [entry({ day: "Tue", period: 1 })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "fixed_day_violation")).toBe(true);
  });

  // Case 6
  it("catches placement on a non-working day", () => {
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Sat", period: 1 })]; // school() only works Mon-Fri
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "non_working_day")).toBe(true);
  });

  // Case 7
  it("catches a teacher-unavailable-period violation", () => {
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Mon", period: 1 })];
    const teachers = [teacher("teacher-1", { unavailable: [{ day: "Mon", period: 1 }] })];
    const report = validateGeneratedTimetable(baseInput({ teachers, requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "teacher_unavailable")).toBe(true);
  });

  // Case 8
  it("catches an incorrect required-period count when the run claims completeness", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 3 })];
    const entries = [entry({ day: "Mon", period: 1 })]; // only 1 of 3 placed
    const report = validateGeneratedTimetable(
      baseInput({ requirements, entries, unplaced: [], searchBudgetExceeded: false })
    );
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "required_period_count_mismatch")).toBe(true);
  });

  it("does NOT flag a period-count shortfall when the generator honestly reports it as incomplete/exhausted", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 3 })];
    const entries = [entry({ day: "Mon", period: 1 })];
    const report = validateGeneratedTimetable(
      baseInput({
        requirements,
        entries,
        unplaced: [{ lessonRequirementId: "r1", classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", reason: "x" }],
        searchBudgetExceeded: true,
      })
    );
    expect(report.issues.some((i) => i.kind === "required_period_count_mismatch")).toBe(false);
  });

  it("always flags over-placement, even when the run claims completeness", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 1 })];
    const entries = [entry({ day: "Mon", period: 1 }), entry({ day: "Tue", period: 1 })]; // 2 placed, 1 required
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "required_period_count_mismatch")).toBe(true);
  });

  // Case 9
  it("catches a broken double-period (continuity) violation", () => {
    const requirements = [
      req({ id: "r1", periodsPerWeek: 2, isLab: true, allowRepeatSameDay: true }),
    ];
    // Two periods on the same day, but NOT consecutive — should be one
    // adjacent block, not two isolated singles.
    const entries = [entry({ day: "Mon", period: 1 }), entry({ day: "Mon", period: 3 })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "double_period_continuity_violation")).toBe(true);
  });

  it("does not flag a properly consecutive double period", () => {
    const requirements = [
      req({ id: "r1", periodsPerWeek: 2, isLab: true, allowRepeatSameDay: true }),
    ];
    const entries = [entry({ day: "Mon", period: 1 }), entry({ day: "Mon", period: 2 })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.issues.some((i) => i.kind === "double_period_continuity_violation")).toBe(false);
  });

  // Case 10
  it("a genuinely valid timetable passes final validation with zero issues", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: false })];
    const entries = [
      entry({ day: "Mon", period: 1 }),
      entry({ day: "Tue", period: 1 }),
      entry({ day: "Wed", period: 1 }),
      entry({ day: "Thu", period: 1 }),
      entry({ day: "Fri", period: 1 }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });
});

describe("effective teacher capacity — physical vs. explicit cap", () => {
  // Case 12
  it("a teacher with no explicit max still gets physical-capacity validation", () => {
    const s = school(); // 5 days * 8 periods = 40 physical slots
    const t = teacher("t1");
    expect(effectiveWeeklyCapacity(t, s)).toBe(40);
  });

  // Case 13
  it("an explicit max GREATER than physical capacity is overridden by physical capacity", () => {
    const s = school();
    const t = teacher("t1", { maxPeriodsPerWeek: 100 });
    expect(effectiveWeeklyCapacity(t, s)).toBe(40);
  });

  // Case 14
  it("an explicit max LOWER than physical capacity is respected as the tighter limit", () => {
    const s = school();
    const t = teacher("t1", { maxPeriodsPerWeek: 20 });
    expect(effectiveWeeklyCapacity(t, s)).toBe(20);
  });
});

describe("teacher over-subscription reporting", () => {
  // Case 15
  it("reports every overloaded teacher, not just the first", () => {
    const s = school(); // physical capacity 40/week
    const teachers = [teacher("t1"), teacher("t2"), teacher("t3")];
    const requirements = [
      req({ id: "r1", teacherId: "t1", classSectionId: "c1", periodsPerWeek: 45 }),
      req({ id: "r2", teacherId: "t2", classSectionId: "c2", periodsPerWeek: 60 }),
      req({ id: "r3", teacherId: "t3", classSectionId: "c3", periodsPerWeek: 35 }), // within capacity
    ];
    const issues = validateTeacherCapacity(requirements, teachers, s);
    const flaggedTeacherIds = issues
      .filter((i) => i.kind === "teacher_capacity_exceeded")
      .map((i) => (i.kind === "teacher_capacity_exceeded" ? i.teacherId : ""));
    expect(flaggedTeacherIds).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(flaggedTeacherIds).not.toContain("t3");
  });
});

describe("independence proof: the final validator does not just trust the generator's own bookkeeping", () => {
  it("a real generated-then-corrupted timetable is caught even though the generator itself never saw the corruption", () => {
    const s = school({ workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], periodsPerDay: 8 });
    const requirements = [
      req({ id: "r1", classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", periodsPerWeek: 5, allowRepeatSameDay: false }),
      req({ id: "r2", classSectionId: "class-2", subjectId: "subj-2", teacherId: "teacher-2", periodsPerWeek: 5, allowRepeatSameDay: false }),
    ];
    const teachers = [teacher("teacher-1"), teacher("teacher-2")];

    const result = generateTimetable({ school: s, teachers, classSections: [], lessons: requirements, attempts: 5 });
    expect(result.unplaced).toHaveLength(0);

    // Sanity check: the generator's own honest output is independently valid.
    const cleanReport = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements,
      entries: result.entries,
      unplaced: result.unplaced,
      searchBudgetExceeded: result.searchBudgetExceeded,
    });
    expect(cleanReport.valid).toBe(true);

    // Now corrupt it directly, bypassing the generator entirely — this
    // simulates a bug elsewhere (or manual tampering) that the generator
    // never had a chance to prevent. Move a class-2 entry's teacher to
    // collide with a class-1 entry at the exact same slot.
    const class1Entry = result.entries.find((e) => e.classSectionId === "class-1")!;
    const corrupted: TimetableEntry[] = result.entries.map((e) =>
      e.classSectionId === "class-2" && e.day === class1Entry.day && e.period === class1Entry.period
        ? { ...e, teacherId: class1Entry.teacherId }
        : e
    );
    // If no class-2 entry happened to land on that exact slot, force one so
    // the corruption is guaranteed to exist regardless of which slots the
    // backtracking search happened to choose.
    const alreadyCorrupted = corrupted.some(
      (e) => e.classSectionId === "class-2" && e.day === class1Entry.day && e.period === class1Entry.period && e.teacherId === class1Entry.teacherId
    );
    const finalEntries = alreadyCorrupted
      ? corrupted
      : corrupted.map((e, i) =>
          i === corrupted.findIndex((x) => x.classSectionId === "class-2")
            ? { ...e, day: class1Entry.day, period: class1Entry.period, teacherId: class1Entry.teacherId }
            : e
        );

    const corruptedReport = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements,
      entries: finalEntries,
      unplaced: result.unplaced,
      searchBudgetExceeded: result.searchBudgetExceeded,
    });

    expect(corruptedReport.valid).toBe(false);
    expect(corruptedReport.issues.some((i) => i.kind === "teacher_double_booking")).toBe(true);
  });

  it("a second corruption style is also caught: forcing a repeat when no-repeat is hard", () => {
    const s = school({ workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], periodsPerDay: 8 });
    const requirements = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: false })];
    const teachers = [teacher("teacher-1")];

    const result = generateTimetable({ school: s, teachers, classSections: [], lessons: requirements, attempts: 5 });
    expect(result.unplaced).toHaveLength(0);

    // Force two of the honestly-generated entries onto the same day —
    // the generator would never do this itself (it's the exact rule under
    // test), so this proves the validator isn't just re-reading the
    // generator's own "I respected no-repeat" assumption.
    const corrupted = result.entries.map((e, i) => (i === 1 ? { ...e, day: result.entries[0].day, period: result.entries[0].period + 1 } : e));

    const report = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements,
      entries: corrupted,
      unplaced: result.unplaced,
      searchBudgetExceeded: result.searchBudgetExceeded,
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "no_repeat_violation")).toBe(true);
  });
});
