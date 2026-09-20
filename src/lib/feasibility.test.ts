import { describe, it, expect } from "vitest";
import {
  checkRequirementFeasibility,
  validateFixedDays,
  validateTeacherCapacity,
  validateReferences,
  validateSchoolConfig,
  runFeasibilityChecks,
} from "./feasibility";
import type { SchoolConfig, Teacher, LessonRequirement } from "./types";

function school(overrides: Partial<SchoolConfig> = {}): SchoolConfig {
  return {
    workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    periodsPerDay: 8,
    blockedPeriods: [],
    ...overrides,
  };
}

function requirement(overrides: Partial<LessonRequirement> = {}): LessonRequirement {
  return {
    id: "req-1",
    classSectionId: "class-1",
    subjectId: "subj-1",
    teacherId: "teacher-1",
    periodsPerWeek: 5,
    ...overrides,
  };
}

describe("checkRequirementFeasibility", () => {
  // Case 1
  it("5 periods/week + fixed to Monday only + no-repeat -> impossible (max 1)", () => {
    const req = requirement({ periodsPerWeek: 5, fixedDays: ["Mon"], allowRepeatSameDay: false });
    const issue = checkRequirementFeasibility(req, school());
    expect(issue).not.toBeNull();
    expect(issue?.kind).toBe("requirement_infeasible");
    if (issue?.kind === "requirement_infeasible") {
      expect(issue.maxPossible).toBe(1);
      expect(issue.required).toBe(5);
      expect(issue.allowedDays).toEqual(["Mon"]);
    }
  });

  // Case 3 / Acceptance criterion C
  it("6 periods/week + 5 working days + no-repeat -> impossible (max 5)", () => {
    const req = requirement({ periodsPerWeek: 6, allowRepeatSameDay: false });
    const issue = checkRequirementFeasibility(req, school());
    expect(issue).not.toBeNull();
    if (issue?.kind === "requirement_infeasible") {
      expect(issue.maxPossible).toBe(5);
    }
  });

  // Acceptance criterion B
  it("5 periods/week + 5 working days + no-repeat -> feasible", () => {
    const req = requirement({ periodsPerWeek: 5, allowRepeatSameDay: false });
    expect(checkRequirementFeasibility(req, school())).toBeNull();
  });

  it("repeats allowed -> bounded by total available periods across allowed days, not day count", () => {
    // 1 allowed day * 8 periods/day = 8 max, so 5 is feasible even pinned to one day
    const req = requirement({ periodsPerWeek: 5, fixedDays: ["Mon"], allowRepeatSameDay: true });
    expect(checkRequirementFeasibility(req, school())).toBeNull();
  });

  it("double-period (lab) requirement is capped at 2 periods per allowed day when no-repeat", () => {
    const req = requirement({ periodsPerWeek: 3, fixedDays: ["Mon"], isLab: true, allowRepeatSameDay: false });
    const issue = checkRequirementFeasibility(req, school());
    expect(issue).not.toBeNull(); // 1 day * 2 = max 2, required 3
    if (issue?.kind === "requirement_infeasible") {
      expect(issue.maxPossible).toBe(2);
    }
  });
});

describe("validateFixedDays", () => {
  // Case 2 / Acceptance criterion A's config half
  it("rejects a fixed day that is not a working day", () => {
    const req = requirement({ fixedDays: ["Sat"] }); // working days are Mon-Fri
    const issues = validateFixedDays(req, school());
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("fixed_day_not_working");
    if (issues[0].kind === "fixed_day_not_working") {
      expect(issues[0].invalidDays).toEqual(["Sat"]);
    }
  });

  it("does not flag a fixed day that IS a working day", () => {
    const req = requirement({ fixedDays: ["Mon"] });
    expect(validateFixedDays(req, school())).toHaveLength(0);
  });

  it("flags only the invalid subset when some fixed days are valid and some aren't", () => {
    const req = requirement({ fixedDays: ["Mon", "Sat"] });
    const issues = validateFixedDays(req, school());
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "fixed_day_not_working") {
      expect(issues[0].invalidDays).toEqual(["Sat"]);
    }
  });

  it("is silent when no fixed days are set at all", () => {
    const req = requirement({ fixedDays: [] });
    expect(validateFixedDays(req, school())).toHaveLength(0);
  });
});

describe("validateTeacherCapacity", () => {
  // Case 4 / Acceptance criterion D
  it("rejects when required weekly periods exceed the teacher's weekly maximum", () => {
    const teacher: Teacher = { id: "t1", name: "X", maxPeriodsPerWeek: 25 };
    const reqs = [requirement({ id: "r1", teacherId: "t1", periodsPerWeek: 30 })];
    const issues = validateTeacherCapacity(reqs, [teacher], school());
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "teacher_capacity_exceeded") {
      expect(issues[0].required).toBe(30);
      expect(issues[0].maximum).toBe(25);
      expect(issues[0].shortage).toBe(5);
      expect(issues[0].scope).toBe("week");
    }
  });

  it("sums periods/week across multiple requirements for the same teacher", () => {
    const teacher: Teacher = { id: "t1", name: "X", maxPeriodsPerWeek: 10 };
    const reqs = [
      requirement({ id: "r1", teacherId: "t1", periodsPerWeek: 6 }),
      requirement({ id: "r2", teacherId: "t1", periodsPerWeek: 6 }),
    ];
    expect(validateTeacherCapacity(reqs, [teacher], school())).toHaveLength(1);
  });

  it("passes when within capacity", () => {
    const teacher: Teacher = { id: "t1", name: "X", maxPeriodsPerWeek: 25 };
    const reqs = [requirement({ id: "r1", teacherId: "t1", periodsPerWeek: 20 })];
    expect(validateTeacherCapacity(reqs, [teacher], school())).toHaveLength(0);
  });

  it("flags an impossible daily cap even without a weekly cap set", () => {
    // 5 working days * 2/day = 10 max; 12 required is impossible regardless of distribution
    const teacher: Teacher = { id: "t1", name: "X", maxPeriodsPerDay: 2 };
    const reqs = [requirement({ id: "r1", teacherId: "t1", periodsPerWeek: 12 })];
    const issues = validateTeacherCapacity(reqs, [teacher], school());
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("teacher_capacity_exceeded");
  });

  it("flags a teacher over the school's total weekly slot count even with no cap configured at all", () => {
    // school() = 5 working days * 8 periods/day = 40 slots total in the week.
    // A single person cannot be required for more periods than physically exist.
    const teacher: Teacher = { id: "t1", name: "X" };
    const reqs = [
      requirement({ id: "r1", teacherId: "t1", classSectionId: "class-1", periodsPerWeek: 25 }),
      requirement({ id: "r2", teacherId: "t1", classSectionId: "class-2", periodsPerWeek: 20 }),
    ];
    const issues = validateTeacherCapacity(reqs, [teacher], school());
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "teacher_capacity_exceeded") {
      expect(issues[0].required).toBe(45);
      expect(issues[0].maximum).toBe(40);
      expect(issues[0].shortage).toBe(5);
      expect(issues[0].scope).toBe("week");
    }
  });

  it("does not double-report when an explicit cap already caught the over-subscription", () => {
    const teacher: Teacher = { id: "t1", name: "X", maxPeriodsPerWeek: 25 };
    const reqs = [requirement({ id: "r1", teacherId: "t1", periodsPerWeek: 45 })];
    const issues = validateTeacherCapacity(reqs, [teacher], school());
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "teacher_capacity_exceeded") {
      expect(issues[0].maximum).toBe(25);
    }
  });
});

describe("validateReferences", () => {
  // Case 13
  it("flags a requirement pointing at a deleted class/subject", () => {
    const req = requirement({ id: "r1", classSectionId: "ghost-class", subjectId: "ghost-subject" });
    const issues = validateReferences([req], {
      classSectionIds: new Set(["class-1"]),
      subjectIds: new Set(["subj-1"]),
      teacherIds: new Set(["teacher-1"]),
      roomIds: new Set(),
    });
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "invalid_reference") {
      expect(issues[0].missing).toEqual(expect.arrayContaining(["classSectionId", "subjectId"]));
    }
  });

  it("flags a deleted room only when a room is actually referenced", () => {
    const req = requirement({ id: "r1", roomId: "ghost-room" });
    const issues = validateReferences([req], {
      classSectionIds: new Set(["class-1"]),
      subjectIds: new Set(["subj-1"]),
      teacherIds: new Set(["teacher-1"]),
      roomIds: new Set(),
    });
    expect(issues).toHaveLength(1);
    if (issues[0].kind === "invalid_reference") {
      expect(issues[0].missing).toEqual(["roomId"]);
    }
  });

  it("passes when every reference resolves", () => {
    const req = requirement();
    const issues = validateReferences([req], {
      classSectionIds: new Set(["class-1"]),
      subjectIds: new Set(["subj-1"]),
      teacherIds: new Set(["teacher-1"]),
      roomIds: new Set(),
    });
    expect(issues).toHaveLength(0);
  });
});

describe("validateSchoolConfig", () => {
  it("rejects zero working days", () => {
    expect(validateSchoolConfig(school({ workingDays: [] }))).toHaveLength(1);
  });
  it("rejects periodsPerDay < 1", () => {
    expect(validateSchoolConfig(school({ periodsPerDay: 0 }))).toHaveLength(1);
  });
  it("passes a sane config", () => {
    expect(validateSchoolConfig(school())).toHaveLength(0);
  });
});

describe("runFeasibilityChecks (integration)", () => {
  it("acceptance A: Math 5/wk pinned to Monday only, no-repeat -> invalid_configuration", () => {
    const req = requirement({ periodsPerWeek: 5, fixedDays: ["Mon"], allowRepeatSameDay: false });
    const report = runFeasibilityChecks({
      school: school(),
      teachers: [{ id: "teacher-1", name: "T" }],
      requirements: [req],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.kind === "requirement_infeasible")).toBe(true);
  });

  it("acceptance B: Math 5/wk across Mon-Fri, no-repeat -> valid (feasible)", () => {
    const req = requirement({ periodsPerWeek: 5, allowRepeatSameDay: false });
    const report = runFeasibilityChecks({
      school: school(),
      teachers: [{ id: "teacher-1", name: "T" }],
      requirements: [req],
    });
    expect(report.valid).toBe(true);
  });

  it("acceptance C: Math 6/wk across Mon-Fri, no-repeat -> invalid_configuration", () => {
    const req = requirement({ periodsPerWeek: 6, allowRepeatSameDay: false });
    const report = runFeasibilityChecks({
      school: school(),
      teachers: [{ id: "teacher-1", name: "T" }],
      requirements: [req],
    });
    expect(report.valid).toBe(false);
  });

  it("acceptance D: teacher over weekly capacity -> invalid_configuration with a 5-period shortage", () => {
    const req = requirement({ periodsPerWeek: 30, teacherId: "teacher-1" });
    const report = runFeasibilityChecks({
      school: school(),
      teachers: [{ id: "teacher-1", name: "T", maxPeriodsPerWeek: 25 }],
      requirements: [req],
    });
    expect(report.valid).toBe(false);
    const issue = report.issues.find((i) => i.kind === "teacher_capacity_exceeded");
    expect(issue).toBeDefined();
    if (issue?.kind === "teacher_capacity_exceeded") {
      expect(issue.shortage).toBe(5);
    }
  });

  it("skips reference validation when referenceIds isn't provided (e.g. synthetic test data)", () => {
    const req = requirement();
    const report = runFeasibilityChecks({
      school: school(),
      teachers: [{ id: "teacher-1", name: "T" }],
      requirements: [req],
    });
    expect(report.issues.some((i) => i.kind === "invalid_reference")).toBe(false);
  });
});
