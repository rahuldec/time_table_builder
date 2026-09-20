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

// lessonRequirementId is a REQUIRED override (not defaulted) — every call
// site must say explicitly which requirement this entry belongs to, so a
// test can never accidentally rely on composite-key guesswork.
function entry(
  overrides: Partial<TimetableEntry> & { day: string; period: number; lessonRequirementId: string }
): TimetableEntry {
  return { classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", ...overrides };
}

function baseInput(overrides: Partial<FinalValidationInput> = {}): FinalValidationInput {
  return {
    school: school(),
    teachers: [teacher("teacher-1")],
    requirements: [req({ id: "r1", periodsPerWeek: 1 })],
    entries: [],
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
      entry({ day: "Mon", period: 1, classSectionId: "class-1", teacherId: "teacher-1", lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-2", teacherId: "teacher-1", lessonRequirementId: "r2" }),
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
      entry({ day: "Mon", period: 1, classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-1", subjectId: "subj-2", teacherId: "teacher-2", lessonRequirementId: "r2" }),
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
      entry({ day: "Mon", period: 1, classSectionId: "class-1", teacherId: "teacher-1", roomId: "room-1", lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 1, classSectionId: "class-2", teacherId: "teacher-2", roomId: "room-1", lessonRequirementId: "r2" }),
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
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 2, lessonRequirementId: "r1" }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "no_repeat_violation")).toBe(true);
  });

  // Case 5
  it("catches a fixed-day violation", () => {
    const requirements = [req({ id: "r1", fixedDays: ["Mon"] })];
    const entries = [entry({ day: "Tue", period: 1, lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "fixed_day_violation")).toBe(true);
  });

  // Case 6
  it("catches placement on a non-working day", () => {
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Sat", period: 1, lessonRequirementId: "r1" })]; // school() only works Mon-Fri
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "non_working_day")).toBe(true);
  });

  // Case 7
  it("catches a teacher-unavailable-period violation", () => {
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })];
    const teachers = [teacher("teacher-1", { unavailable: [{ day: "Mon", period: 1 }] })];
    const report = validateGeneratedTimetable(baseInput({ teachers, requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "teacher_unavailable")).toBe(true);
  });

  // Case 8
  it("catches an incorrect required-period count — computed purely from entries vs. requirements, no generator flags involved", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 3 })];
    const entries = [entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })]; // only 1 of 3 placed
    // Note: FinalValidationInput has no `unplaced`/`searchBudgetExceeded`
    // fields at all — this call can't lean on them even if it wanted to.
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    const issue = report.issues.find((i) => i.kind === "required_period_count_mismatch");
    expect(issue).toBeDefined();
    expect(issue?.direction).toBe("under");
  });

  it("flags a period-count shortfall unconditionally — every time, with no notion of an 'acceptable' shortfall", () => {
    // Same shortfall as above, called twice with identical inputs: the
    // result must be identical every time, since there is no generator
    // context this function could possibly consult to vary its answer.
    const requirements = [req({ id: "r1", periodsPerWeek: 3 })];
    const entries = [entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })];
    const reportA = validateGeneratedTimetable(baseInput({ requirements, entries }));
    const reportB = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(reportA.issues.some((i) => i.kind === "required_period_count_mismatch")).toBe(true);
    expect(reportB.issues.some((i) => i.kind === "required_period_count_mismatch")).toBe(true);
  });

  it("always flags over-placement, tagged with direction 'over'", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 1 })];
    const entries = [
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Tue", period: 1, lessonRequirementId: "r1" }),
    ]; // 2 placed, 1 required
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    const issue = report.issues.find((i) => i.kind === "required_period_count_mismatch");
    expect(issue).toBeDefined();
    expect(issue?.direction).toBe("over");
  });

  // Case 9
  it("catches a broken double-period (continuity) violation", () => {
    const requirements = [
      req({ id: "r1", periodsPerWeek: 2, isLab: true, allowRepeatSameDay: true }),
    ];
    // Two periods on the same day, but NOT consecutive — should be one
    // adjacent block, not two isolated singles.
    const entries = [
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 3, lessonRequirementId: "r1" }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "double_period_continuity_violation")).toBe(true);
  });

  it("does not flag a properly consecutive double period", () => {
    const requirements = [
      req({ id: "r1", periodsPerWeek: 2, isLab: true, allowRepeatSameDay: true }),
    ];
    const entries = [
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 2, lessonRequirementId: "r1" }),
    ];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.issues.some((i) => i.kind === "double_period_continuity_violation")).toBe(false);
  });

  // Case 10
  it("a genuinely valid timetable passes final validation with zero issues", () => {
    const requirements = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: false })];
    const entries = [
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Tue", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Wed", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Thu", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Fri", period: 1, lessonRequirementId: "r1" }),
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

  it("teacher-specific unavailable slots reduce physical capacity: 5x8=40 minus 10 valid unavailable slots = 30", () => {
    const s = school(); // Mon-Fri, 8 periods/day, none blocked -> 40 total slots
    const unavailable = [];
    for (let p = 1; p <= 8; p++) unavailable.push({ day: "Mon", period: p }); // 8 slots
    unavailable.push({ day: "Tue", period: 1 }, { day: "Tue", period: 2 }); // +2 slots = 10
    const t = teacher("t1", { unavailable });
    expect(effectiveWeeklyCapacity(t, s)).toBe(30);
  });

  it("unavailable slots on a non-working day don't reduce capacity — that slot was never available anyway", () => {
    const s = school(); // Mon-Fri only
    const t = teacher("t1", { unavailable: [{ day: "Sat", period: 1 }] });
    expect(effectiveWeeklyCapacity(t, s)).toBe(40);
  });

  it("unavailable slots on a blocked period don't reduce capacity", () => {
    const s = school({ blockedPeriods: [4] });
    const t = teacher("t1", { unavailable: [{ day: "Mon", period: 4 }] }); // period 4 already excluded from the 35 available
    // physical = 5 days * 7 available periods/day = 35; the unavailable entry duplicates an already-excluded slot
    expect(effectiveWeeklyCapacity(t, s)).toBe(35);
  });

  it("unavailable slots with an out-of-range period don't reduce capacity", () => {
    const s = school({ periodsPerDay: 8 });
    const t = teacher("t1", { unavailable: [{ day: "Mon", period: 0 }, { day: "Mon", period: 99 }] });
    expect(effectiveWeeklyCapacity(t, s)).toBe(40);
  });

  it("duplicate unavailable entries for the same slot are only counted once", () => {
    const s = school();
    const t = teacher("t1", { unavailable: [{ day: "Mon", period: 1 }, { day: "Mon", period: 1 }, { day: "Mon", period: 1 }] });
    expect(effectiveWeeklyCapacity(t, s)).toBe(39); // one slot removed, not three
  });

  it("teacher-unavailable-driven physical capacity still combines with an explicit cap via min()", () => {
    const s = school(); // 40 total slots
    const unavailable = [];
    for (let p = 1; p <= 8; p++) unavailable.push({ day: "Mon", period: p }); // 8 unavailable -> physical = 32
    const looseCap = teacher("t1", { unavailable, maxPeriodsPerWeek: 35 }); // explicit cap looser than physical(32)
    expect(effectiveWeeklyCapacity(looseCap, s)).toBe(32);
    const tightCap = teacher("t2", { unavailable, maxPeriodsPerWeek: 10 }); // explicit cap tighter than physical(32)
    expect(effectiveWeeklyCapacity(tightCap, s)).toBe(10);
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

  it("teacher_weekly_max_exceeded in the final validator honors teacher-unavailable-adjusted capacity, not just the raw school physical cap", () => {
    const s = school({ workingDays: ["Mon"], periodsPerDay: 8 }); // 8 total slots/week
    // Unavailable for periods 5-8 -> physical capacity drops to 4.
    const t = teacher("teacher-1", {
      unavailable: [{ day: "Mon", period: 5 }, { day: "Mon", period: 6 }, { day: "Mon", period: 7 }, { day: "Mon", period: 8 }],
    });
    const requirements = [req({ id: "r1", periodsPerWeek: 4, allowRepeatSameDay: true })];
    // 5 entries placed, one of which (period 4) pushes weekly count to 5 > effective cap of 4.
    const entries = [
      entry({ day: "Mon", period: 1, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 2, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 3, lessonRequirementId: "r1" }),
      entry({ day: "Mon", period: 4, lessonRequirementId: "r1" }),
    ];
    // First confirm 4 placed against 4 required passes cleanly at the reduced cap...
    const cleanReport = validateGeneratedTimetable({ school: s, teachers: [t], requirements, entries });
    expect(cleanReport.issues.some((i) => i.kind === "teacher_weekly_max_exceeded")).toBe(false);

    // ...then confirm a 5th (still within the raw school capacity of 8, but
    // over the teacher's unavailability-adjusted capacity of 4) is caught.
    const req5 = [req({ id: "r1", periodsPerWeek: 5, allowRepeatSameDay: true })];
    const entries5 = [...entries, entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })];
    const overloadedReport = validateGeneratedTimetable({ school: s, teachers: [t], requirements: req5, entries: entries5 });
    expect(overloadedReport.issues.some((i) => i.kind === "teacher_weekly_max_exceeded")).toBe(true);
  });
});

describe("room validation — finalValidator independently checks requirement.roomId", () => {
  it("a correct room produces no room_mismatch issue", () => {
    const requirements = [req({ id: "r1", roomId: "room-A" })];
    const entries = [entry({ day: "Mon", period: 1, roomId: "room-A", lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.issues.some((i) => i.kind === "room_mismatch")).toBe(false);
  });

  it("a wrong room is caught as room_mismatch", () => {
    const requirements = [req({ id: "r1", roomId: "room-A" })];
    const entries = [entry({ day: "Mon", period: 1, roomId: "room-B", lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    const issue = report.issues.find((i) => i.kind === "room_mismatch");
    expect(issue).toBeDefined();
    expect(issue?.roomId).toBe("room-B");
  });

  it("a missing room (entry has no room at all) is caught as room_mismatch when one is required", () => {
    const requirements = [req({ id: "r1", roomId: "room-A" })];
    const entries = [entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })]; // no roomId set
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "room_mismatch")).toBe(true);
  });

  it("a requirement with NO roomId set accepts any room, or none — unchanged behavior", () => {
    const requirements = [req({ id: "r1" })]; // no roomId
    const withRoom = [entry({ day: "Mon", period: 1, roomId: "any-room", lessonRequirementId: "r1" })];
    const withoutRoom = [entry({ day: "Mon", period: 1, lessonRequirementId: "r1" })];
    expect(
      validateGeneratedTimetable(baseInput({ requirements, entries: withRoom })).issues.some((i) => i.kind === "room_mismatch")
    ).toBe(false);
    expect(
      validateGeneratedTimetable(baseInput({ requirements, entries: withoutRoom })).issues.some((i) => i.kind === "room_mismatch")
    ).toBe(false);
  });
});

describe("period range validation", () => {
  it("catches period 0 as out of range", () => {
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Mon", period: 0, lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "period_out_of_range")).toBe(true);
  });

  it("catches a period greater than periodsPerDay as out of range", () => {
    const s = school({ periodsPerDay: 8 });
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Mon", period: 9, lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ school: s, requirements, entries }));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "period_out_of_range")).toBe(true);
  });

  it("does not flag a period within range", () => {
    const s = school({ periodsPerDay: 8 });
    const requirements = [req({ id: "r1" })];
    const entries = [entry({ day: "Mon", period: 8, lessonRequirementId: "r1" })];
    const report = validateGeneratedTimetable(baseInput({ school: s, requirements, entries }));
    expect(report.issues.some((i) => i.kind === "period_out_of_range")).toBe(false);
  });
});

describe("requirement disambiguation — same class+subject+teacher, different room/day, must not merge", () => {
  it("R1 (Room A, Monday) and R2 (Room B, Wednesday) are each independently validated against their own configuration", () => {
    const requirements = [
      req({ id: "R1", classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", roomId: "Room A", fixedDays: ["Mon"], periodsPerWeek: 1 }),
      req({ id: "R2", classSectionId: "class-1", subjectId: "subj-1", teacherId: "teacher-1", roomId: "Room B", fixedDays: ["Wed"], periodsPerWeek: 1 }),
    ];
    // Correctly-placed entries: R1 in Room A on Monday, R2 in Room B on Wednesday.
    const correctEntries = [
      entry({ day: "Mon", period: 1, roomId: "Room A", lessonRequirementId: "R1" }),
      entry({ day: "Wed", period: 2, roomId: "Room B", lessonRequirementId: "R2" }),
    ];
    const cleanReport = validateGeneratedTimetable(baseInput({ requirements, entries: correctEntries }));
    // A composite class+subject+teacher key would have merged these two
    // requirements into one bucket; if that were still happening, checking
    // R2's entry (Wed, Room B) against whichever requirement won the key
    // collision would spuriously fail either the room or the fixed-day
    // check. Zero issues proves each entry was checked against its own
    // true originating requirement.
    expect(cleanReport.valid).toBe(true);
    expect(cleanReport.issues).toHaveLength(0);

    // Now swap which requirement each entry claims to belong to: the
    // Room-A/Monday entry claims to be R2 (which requires Room B, Wed) and
    // vice versa. Both should now be caught, independently, with the
    // correct requirement blamed for each.
    const swappedEntries = [
      entry({ day: "Mon", period: 1, roomId: "Room A", lessonRequirementId: "R2" }), // wrong room AND wrong day for R2
      entry({ day: "Wed", period: 2, roomId: "Room B", lessonRequirementId: "R1" }), // wrong room AND wrong day for R1
    ];
    const swappedReport = validateGeneratedTimetable(baseInput({ requirements, entries: swappedEntries }));
    expect(swappedReport.valid).toBe(false);
    const roomIssues = swappedReport.issues.filter((i) => i.kind === "room_mismatch");
    const dayIssues = swappedReport.issues.filter((i) => i.kind === "fixed_day_violation");
    expect(roomIssues.map((i) => i.lessonRequirementId).sort()).toEqual(["R1", "R2"]);
    expect(dayIssues.map((i) => i.lessonRequirementId).sort()).toEqual(["R1", "R2"]);
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
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "no_repeat_violation")).toBe(true);
  });
});

describe("black-box timetable audit — end to end, using only the raw output + configuration + requirements", () => {
  it("generates a realistic multi-class/teacher/room timetable, then independently audits every hard constraint from scratch", () => {
    const s = school({ workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], periodsPerDay: 8 });

    const teachers = [
      teacher("t1", { unavailable: [{ day: "Mon", period: 1 }] }),
      teacher("t2"),
    ];

    const requirements: LessonRequirement[] = [
      // Regular subject, tightly pinned to exactly as many fixed days as
      // periods required (zero slack — a real stress test of the fixed-day
      // and no-repeat checks together).
      req({ id: "math-c1", classSectionId: "c1", subjectId: "math", teacherId: "t1", periodsPerWeek: 3, fixedDays: ["Mon", "Wed", "Fri"], allowRepeatSameDay: false }),
      req({ id: "math-c2", classSectionId: "c2", subjectId: "math", teacherId: "t1", periodsPerWeek: 2, fixedDays: ["Tue", "Thu"], allowRepeatSameDay: false }),
      // Unrestricted regular subject.
      req({ id: "math-c3", classSectionId: "c3", subjectId: "math", teacherId: "t1", periodsPerWeek: 5, allowRepeatSameDay: false }),
      // Lab subject sharing ONE room across three different classes — a
      // real test of independently-verified room double-booking freedom.
      req({ id: "sci-c1", classSectionId: "c1", subjectId: "sci", teacherId: "t2", periodsPerWeek: 4, isLab: true, roomId: "room1", allowRepeatSameDay: false }),
      req({ id: "sci-c2", classSectionId: "c2", subjectId: "sci", teacherId: "t2", periodsPerWeek: 2, isLab: true, roomId: "room1", allowRepeatSameDay: false }),
      req({ id: "sci-c3", classSectionId: "c3", subjectId: "sci", teacherId: "t2", periodsPerWeek: 2, isLab: true, roomId: "room1", allowRepeatSameDay: false }),
    ];

    const result = generateTimetable({ school: s, teachers, classSections: [], lessons: requirements, attempts: 10 });
    expect(result.unplaced).toHaveLength(0); // sanity: this scenario is genuinely feasible

    // The audit: ONLY school + teachers + requirements + the raw entries.
    // No `result.unplaced`, no `result.searchBudgetExceeded`, no generator
    // object of any kind is passed in.
    const report = validateGeneratedTimetable({
      school: s,
      teachers,
      requirements,
      entries: result.entries,
    });

    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);

    // Explicit per-check assertions, so a regression in any ONE check can't
    // hide behind an aggregate `issues.length === 0`.
    const kinds = new Set(report.issues.map((i) => i.kind));
    expect(kinds.has("required_period_count_mismatch")).toBe(false); // every required period count matches
    expect(kinds.has("class_double_booking")).toBe(false);
    expect(kinds.has("teacher_double_booking")).toBe(false);
    expect(kinds.has("room_double_booking")).toBe(false);
    expect(kinds.has("fixed_day_violation")).toBe(false);
    expect(kinds.has("non_working_day")).toBe(false);
    expect(kinds.has("no_repeat_violation")).toBe(false);
    expect(kinds.has("teacher_unavailable")).toBe(false);
    expect(kinds.has("teacher_daily_max_exceeded")).toBe(false);
    expect(kinds.has("teacher_weekly_max_exceeded")).toBe(false);
    expect(kinds.has("double_period_continuity_violation")).toBe(false);

    // And a direct, independent recount for one requirement, proving the
    // audit isn't just trusting `report.valid` — it's re-deriving the
    // actual placed count itself.
    const c3MathPlaced = result.entries.filter((e) => e.classSectionId === "c3" && e.subjectId === "math").length;
    expect(c3MathPlaced).toBe(5);
  });
});
