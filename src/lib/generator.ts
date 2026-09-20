import type {
  SchoolConfig,
  Teacher,
  ClassSection,
  LessonRequirement,
  TimetableEntry,
  UnplacedItem,
  GenerationResult,
  TeacherPair,
  SoftViolation,
  GenerationStatus,
  FinalValidationReport,
} from "./types";
import { allowedDaysFor } from "./feasibility";
import { isStructuralIssue } from "./finalValidator";

// ===========================================================
// Constraint-aware scheduler with backtracking.
//
// HARD constraints (checked while building the candidate list for a slot —
// a candidate that fails any of these is simply never offered, so the
// search can never choose it):
//   - class / teacher / room not already occupied in that slot
//   - the day is one of the requirement's allowed days (fixedDays ∩
//     workingDays — see feasibility.ts; never just fixedDays alone)
//   - the period isn't a blocked (break/lunch) period
//   - a double-period's second period is available too, and not blocked
//   - the teacher isn't marked unavailable for that slot
//   - the teacher's daily/weekly period caps aren't exceeded
//   - no-repeat-same-day: when a requirement's allowRepeatSameDay is
//     false (the default), a class/subject that already has an occurrence
//     placed on a day is NEVER offered that day again for another
//     occurrence — this is a hard gate, not a scored preference. "Occurrence"
//     is checked once per UNIT (a double-period block counts as the one
//     occurrence it is, not two) — see expandToUnits.
//
// SOFT constraints (never filter a candidate out — only used to rank
// otherwise-equally-valid candidates, and recorded as an explicit
// SoftViolation when the chosen candidate doesn't satisfy them):
//   - avoid first / last teaching period of the day
//   - teacher-adjacency (two teachers who shouldn't teach back-to-back)
//   - spreading a repeatable subject's occurrences across different days
//
// SEARCH: true chronological backtracking, not greedy-with-relaxation. Units
// are tried in a fixed (MRV-ish: most constrained first) order. When a unit
// has no valid candidate left to try, the search backtracks to the
// immediately preceding unit, undoes its placement, and tries that unit's
// next candidate — repeating until either a full placement is found or the
// preceding unit itself runs out of candidates (in which case that one
// unit is reported unplaced and the search moves on). This means a unit
// that looked fine in isolation can still get its slot taken away and
// retried if it turns out to make a later unit impossible.
//
// This is bounded, not exhaustive: a step/time budget caps how much of the
// search space gets explored (see BACKTRACK_BUDGET / TIME_BUDGET_MS below).
// If the budget runs out before every unit is resolved, `searchBudgetExceeded`
// is set — the resulting unplaced list is "as far as the search got", not a
// mathematical proof those units are impossible. Genuine impossibility
// (required periods exceeding what fixedDays/repeat rules allow, teacher
// over capacity, etc.) is caught earlier and separately by
// feasibility.ts, which the caller is expected to run first and refuse to
// generate at all if it fails.
// ===========================================================

const BACKTRACK_BUDGET = 20_000; // max undo/retry steps per attempt
const TIME_BUDGET_MS = 4000; // wall-clock cap per attempt

function slotKey(day: string, period: number): string {
  return `${day}#${period}`;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// simple seeded RNG so runs are reproducible if needed
function makeRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// A "unit" is one placeable occurrence: a single period, or a double-period
// (consecutive) for labs. periodsPerWeek gets split into units up front;
// the search places (or fails to place) one whole unit at a time.
interface Unit {
  unitIndex: number; // set once expandToUnits' output is finalized
  lessonId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  roomId?: string;
  isDouble: boolean;
  avoidFirstPeriod: boolean;
  avoidLastPeriod: boolean;
  allowRepeatSameDay: boolean;
  allowedDays: string[]; // fixedDays ∩ workingDays, or all workingDays if unset
}

function expandToUnits(lessons: LessonRequirement[], school: SchoolConfig): Unit[] {
  const units: Omit<Unit, "unitIndex">[] = [];
  for (const lesson of lessons) {
    const isLab = !!lesson.isLab;
    const base = {
      lessonId: lesson.id,
      classSectionId: lesson.classSectionId,
      subjectId: lesson.subjectId,
      teacherId: lesson.teacherId,
      roomId: lesson.roomId,
      avoidFirstPeriod: !!lesson.avoidFirstPeriod,
      avoidLastPeriod: !!lesson.avoidLastPeriod,
      allowRepeatSameDay: !!lesson.allowRepeatSameDay,
      allowedDays: allowedDaysFor(lesson, school),
    };
    let remaining = lesson.periodsPerWeek;
    if (isLab) {
      // group into double periods, with a trailing single if odd
      while (remaining >= 2) {
        units.push({ ...base, isDouble: true });
        remaining -= 2;
      }
      if (remaining === 1) {
        units.push({ ...base, isDouble: false });
      }
    } else {
      for (let i = 0; i < remaining; i++) {
        units.push({ ...base, isDouble: false });
      }
    }
  }
  return units.map((u, i) => ({ ...u, unitIndex: i }));
}

function isBlocked(school: SchoolConfig, period: number): boolean {
  return !!school.blockedPeriods?.includes(period);
}

function isTeacherUnavailable(teacher: Teacher, day: string, period: number): boolean {
  return !!teacher.unavailable?.some((s) => s.day === day && s.period === period);
}

// the first and last *teaching* (non-break) periods of the day, given the school's config
function teachingBounds(school: SchoolConfig): { first: number; last: number } {
  const periods: number[] = [];
  for (let p = 1; p <= school.periodsPerDay; p++) {
    if (!isBlocked(school, p)) periods.push(p);
  }
  return { first: periods[0] ?? 1, last: periods[periods.length - 1] ?? school.periodsPerDay };
}

interface Candidate {
  day: string;
  period: number;
  periodsToPlace: number[];
  score: number; // lower = better; soft-preference tie-breaker only
  softReasons: string[]; // which soft rules this candidate breaks, if chosen
}

interface PlacementRecord {
  unitIndex: number;
  day: string;
  periods: number[];
  candidatePointerUsed: number;
  softReasons: string[];
}

// ---------- one backtracking attempt ----------

function runBacktrackingAttempt(
  school: SchoolConfig,
  teachers: Map<string, Teacher>,
  units: Unit[],
  avoidPairKeys: Set<string>,
  rng: () => number
): {
  entries: TimetableEntry[];
  unplaced: UnplacedItem[];
  softViolations: SoftViolation[];
  searchBudgetExceeded: boolean;
} {
  const classGrid = new Map<string, Set<string>>();
  const teacherGrid = new Map<string, Set<string>>();
  const roomGrid = new Map<string, Set<string>>();
  const teacherDailyCount = new Map<string, Map<string, number>>();
  const teacherWeeklyCount = new Map<string, number>();
  // classId -> subjectId -> day -> occurrence count (hard no-repeat gate +
  // soft day-spread scoring when repeats are allowed)
  const subjectDaySpread = new Map<string, Map<string, Map<string, number>>>();
  // classId -> slotKey -> teacherId, for the adjacency soft rule
  const classPeriodTeacher = new Map<string, Map<string, string>>();

  const { first: firstPeriod, last: lastPeriod } = teachingBounds(school);

  const ensureSet = (map: Map<string, Set<string>>, key: string) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key)!;
  };
  const ensureTeacherSlotMap = (classId: string) => {
    if (!classPeriodTeacher.has(classId)) classPeriodTeacher.set(classId, new Map());
    return classPeriodTeacher.get(classId)!;
  };
  const daySpreadCount = (classId: string, subjectId: string, day: string): number => {
    return subjectDaySpread.get(classId)?.get(subjectId)?.get(day) ?? 0;
  };

  function computeCandidates(unit: Unit): Candidate[] {
    const candidates: Candidate[] = [];
    for (const day of unit.allowedDays) {
      // HARD: no-repeat-same-day — this day is simply not offered at all
      // once an occurrence already exists there, unless repeats are allowed.
      if (!unit.allowRepeatSameDay && daySpreadCount(unit.classSectionId, unit.subjectId, day) > 0) {
        continue;
      }

      const maxPeriod = unit.isDouble ? school.periodsPerDay - 1 : school.periodsPerDay;
      for (let period = 1; period <= maxPeriod; period++) {
        if (isBlocked(school, period)) continue;
        if (unit.isDouble && isBlocked(school, period + 1)) continue;

        const periodsToCheck = unit.isDouble ? [period, period + 1] : [period];

        let ok = true;
        for (const p of periodsToCheck) {
          const sk = slotKey(day, p);
          if (ensureSet(classGrid, unit.classSectionId).has(sk)) { ok = false; break; }
          if (ensureSet(teacherGrid, unit.teacherId).has(sk)) { ok = false; break; }
          if (unit.roomId && ensureSet(roomGrid, unit.roomId).has(sk)) { ok = false; break; }
          const teacher = teachers.get(unit.teacherId);
          if (teacher && isTeacherUnavailable(teacher, day, p)) { ok = false; break; }
        }
        if (!ok) continue;

        const teacher = teachers.get(unit.teacherId);
        if (teacher?.maxPeriodsPerDay) {
          const used = teacherDailyCount.get(unit.teacherId)?.get(day) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerDay) continue;
        }
        if (teacher?.maxPeriodsPerWeek) {
          const used = teacherWeeklyCount.get(unit.teacherId) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerWeek) continue;
        }

        // ---- soft preferences: never exclude a candidate, only score it ----
        const softReasons: string[] = [];
        const startP = Math.min(...periodsToCheck);
        const endP = Math.max(...periodsToCheck);
        if (unit.avoidFirstPeriod && startP === firstPeriod) softReasons.push("avoid-first-period");
        if (unit.avoidLastPeriod && endP === lastPeriod) softReasons.push("avoid-last-period");

        if (avoidPairKeys.size > 0) {
          const teacherSlots = ensureTeacherSlotMap(unit.classSectionId);
          const prevSlot = teacherSlots.get(slotKey(day, startP - 1));
          const nextSlot = teacherSlots.get(slotKey(day, endP + 1));
          if (prevSlot && avoidPairKeys.has(pairKey(unit.teacherId, prevSlot))) softReasons.push("teacher-adjacency");
          if (nextSlot && avoidPairKeys.has(pairKey(unit.teacherId, nextSlot))) softReasons.push("teacher-adjacency");
        }

        const sameDayCount = daySpreadCount(unit.classSectionId, unit.subjectId, day);
        const score = sameDayCount * 10 + softReasons.length * 5 + rng();

        candidates.push({ day, period, periodsToPlace: periodsToCheck, score, softReasons });
      }
    }
    // Best (lowest score) first — the search always tries the most
    // preferable slot before less-preferable ones, and only falls back to
    // worse-scored candidates via backtracking.
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  function place(unit: Unit, c: Candidate) {
    for (const p of c.periodsToPlace) {
      const sk = slotKey(c.day, p);
      ensureSet(classGrid, unit.classSectionId).add(sk);
      ensureSet(teacherGrid, unit.teacherId).add(sk);
      if (unit.roomId) ensureSet(roomGrid, unit.roomId).add(sk);
      ensureTeacherSlotMap(unit.classSectionId).set(sk, unit.teacherId);
    }
    if (!teacherDailyCount.has(unit.teacherId)) teacherDailyCount.set(unit.teacherId, new Map());
    const dMap = teacherDailyCount.get(unit.teacherId)!;
    dMap.set(c.day, (dMap.get(c.day) ?? 0) + c.periodsToPlace.length);
    teacherWeeklyCount.set(unit.teacherId, (teacherWeeklyCount.get(unit.teacherId) ?? 0) + c.periodsToPlace.length);

    if (!subjectDaySpread.has(unit.classSectionId)) subjectDaySpread.set(unit.classSectionId, new Map());
    const cMap = subjectDaySpread.get(unit.classSectionId)!;
    if (!cMap.has(unit.subjectId)) cMap.set(unit.subjectId, new Map());
    const sMap = cMap.get(unit.subjectId)!;
    sMap.set(c.day, (sMap.get(c.day) ?? 0) + 1); // one occurrence, regardless of single/double
  }

  function undo(unit: Unit, rec: PlacementRecord) {
    for (const p of rec.periods) {
      const sk = slotKey(rec.day, p);
      classGrid.get(unit.classSectionId)?.delete(sk);
      teacherGrid.get(unit.teacherId)?.delete(sk);
      if (unit.roomId) roomGrid.get(unit.roomId)?.delete(sk);
      classPeriodTeacher.get(unit.classSectionId)?.delete(sk);
    }
    const dMap = teacherDailyCount.get(unit.teacherId);
    if (dMap) dMap.set(rec.day, (dMap.get(rec.day) ?? 0) - rec.periods.length);
    teacherWeeklyCount.set(unit.teacherId, (teacherWeeklyCount.get(unit.teacherId) ?? 0) - rec.periods.length);

    const sMap = subjectDaySpread.get(unit.classSectionId)?.get(unit.subjectId);
    if (sMap) sMap.set(rec.day, (sMap.get(rec.day) ?? 0) - 1);
  }

  const pointer: number[] = new Array(units.length).fill(0);
  const history: PlacementRecord[] = [];
  const permanentlyUnplaced = new Set<number>();

  const startTime = Date.now();
  let backtracks = 0;
  let searchBudgetExceeded = false;

  let index = 0;
  while (index < units.length) {
    if (Date.now() - startTime > TIME_BUDGET_MS || backtracks > BACKTRACK_BUDGET) {
      searchBudgetExceeded = true;
      break;
    }

    const unit = units[index];
    // Recomputed fresh every time we're at this index — the grid state can
    // be different than the last time we were here (an earlier unit may
    // have just been reassigned by a backtrack), so a cached candidate list
    // would go stale.
    const candidates = computeCandidates(unit);

    if (pointer[index] >= candidates.length) {
      if (history.length === 0) {
        // No prior commitment to undo — this unit has no valid slot no
        // matter what, full stop. Give up on it and move on to the rest.
        permanentlyUnplaced.add(index);
        pointer[index] = 0;
        index++;
        continue;
      }
      const last = history.pop()!;
      undo(units[last.unitIndex], last);
      pointer[last.unitIndex] = last.candidatePointerUsed + 1;
      index = last.unitIndex;
      backtracks++;
      continue;
    }

    const chosen = candidates[pointer[index]];
    place(unit, chosen);
    history.push({
      unitIndex: index,
      day: chosen.day,
      periods: chosen.periodsToPlace,
      candidatePointerUsed: pointer[index],
      softReasons: chosen.softReasons,
    });
    index++;
  }

  const entries: TimetableEntry[] = [];
  const softViolations: SoftViolation[] = [];
  for (const rec of history) {
    const unit = units[rec.unitIndex];
    for (const p of rec.periods) {
      entries.push({
        classSectionId: unit.classSectionId,
        subjectId: unit.subjectId,
        teacherId: unit.teacherId,
        roomId: unit.roomId,
        day: rec.day,
        period: p,
      });
    }
    for (const reason of rec.softReasons) {
      softViolations.push({
        lessonRequirementId: unit.lessonId,
        classSectionId: unit.classSectionId,
        subjectId: unit.subjectId,
        teacherId: unit.teacherId,
        day: rec.day,
        period: rec.periods[0],
        reason,
      });
    }
  }

  const unplaced: UnplacedItem[] = [];
  for (const idx of permanentlyUnplaced) {
    const unit = units[idx];
    unplaced.push({
      lessonRequirementId: unit.lessonId,
      classSectionId: unit.classSectionId,
      subjectId: unit.subjectId,
      teacherId: unit.teacherId,
      reason: "No slot satisfies hard constraints (teacher/class/room/day/load) no matter how earlier units were arranged.",
    });
  }
  if (searchBudgetExceeded) {
    for (let i = index; i < units.length; i++) {
      const unit = units[i];
      unplaced.push({
        lessonRequirementId: unit.lessonId,
        classSectionId: unit.classSectionId,
        subjectId: unit.subjectId,
        teacherId: unit.teacherId,
        reason: "Search budget exceeded before this unit was resolved — not a proof of infeasibility, just an unexplored part of the search space.",
      });
    }
  }

  return { entries, unplaced, softViolations, searchBudgetExceeded };
}

// ---------- public API ----------

export interface GenerateOptions {
  school: SchoolConfig;
  teachers: Teacher[];
  classSections: ClassSection[];
  lessons: LessonRequirement[];
  avoidAdjacentTeacherPairs?: TeacherPair[];
  attempts?: number; // number of independent backtracking attempts to compare, default 5
  seed?: number;
}

function scoreResult(r: {
  unplaced: UnplacedItem[];
  softViolations: SoftViolation[];
}): number {
  // fewest unplaced periods wins, then fewest soft violations
  return r.unplaced.length * 1000 + r.softViolations.length;
}

export function generateTimetable(opts: GenerateOptions): GenerationResult {
  const teacherMap = new Map(opts.teachers.map((t) => [t.id, t]));
  const attempts = opts.attempts ?? 5;
  const baseSeed = opts.seed ?? 42;

  const avoidPairKeys = new Set(
    (opts.avoidAdjacentTeacherPairs ?? []).map((p) => pairKey(p.teacherAId, p.teacherBId))
  );

  let best: ReturnType<typeof runBacktrackingAttempt> | null = null;
  for (let i = 0; i < attempts; i++) {
    const rng = makeRng(baseSeed + i * 9973);
    // Most-constrained-first static ordering (MRV heuristic): units with
    // fewer allowed days, and double-periods (harder to place), go first so
    // the search commits to their tightest choices before looser ones —
    // this is what keeps backtracking counts low in practice. Randomized
    // per attempt (within that priority) for variety across attempts.
    const lessonsOrdered = shuffle(opts.lessons, rng).sort(
      (a, b) =>
        allowedDaysFor(a, opts.school).length - allowedDaysFor(b, opts.school).length ||
        b.periodsPerWeek - a.periodsPerWeek
    );
    let units = expandToUnits(lessonsOrdered, opts.school);
    units = shuffle(units, rng);
    units.sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0));
    units = units.map((u, i2) => ({ ...u, unitIndex: i2 }));

    const result = runBacktrackingAttempt(opts.school, teacherMap, units, avoidPairKeys, rng);
    if (!best || scoreResult(result) < scoreResult(best)) {
      best = result;
    }
    if (best.unplaced.length === 0 && best.softViolations.length === 0) break; // perfect, stop early
  }

  const finalResult = best!;
  return {
    entries: finalResult.entries,
    unplaced: finalResult.unplaced,
    score: scoreResult(finalResult),
    ruleViolations: finalResult.softViolations.length,
    softViolations: finalResult.softViolations,
    searchBudgetExceeded: finalResult.searchBudgetExceeded,
  };
}

// Classifies a *post-generation* result. Does not cover "invalid_configuration"
// — that's decided by feasibility.ts's runFeasibilityChecks BEFORE generation
// is attempted at all, since it's a property of the input, not the output.
//
// `finalValidation` MUST come from finalValidator.ts's independent
// black-box audit of the actual entries — it never sees the generator's own
// "unplaced" list or "searchBudgetExceeded" flag, so its determination of
// WHETHER every requirement's periods were satisfied is fully independent.
// This function is the one place allowed to combine that independent fact
// with `result.searchBudgetExceeded` — but only to choose which of two
// honest labels (INCOMPLETE vs SEARCH_EXHAUSTED) describes an
// already-independently-confirmed shortfall, never to decide whether the
// shortfall itself is real.
//
// Any *structural* final-validation issue (double-booking, a fixed-day
// violation, an over-placement, etc. — anything other than an "under"
// required_period_count_mismatch) means something is genuinely broken and
// this can never return "valid" or "valid_with_warnings", regardless of
// what `result` itself claims.
export function classifyGenerationStatus(
  result: Pick<GenerationResult, "softViolations" | "searchBudgetExceeded">,
  finalValidation: FinalValidationReport
): GenerationStatus {
  if (finalValidation.issues.some(isStructuralIssue)) return "incomplete";

  const hasShortfall = finalValidation.issues.some(
    (i) => i.kind === "required_period_count_mismatch" && i.direction === "under"
  );
  if (hasShortfall) {
    return result.searchBudgetExceeded ? "search_exhausted" : "incomplete";
  }
  if (result.softViolations.length > 0) return "valid_with_warnings";
  return "valid";
}
