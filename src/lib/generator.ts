import type {
  SchoolConfig,
  Teacher,
  ClassSection,
  LessonRequirement,
  TimetableEntry,
  UnplacedItem,
  GenerationResult,
  TeacherPair,
} from "./types";

// ---------- helpers ----------

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

// A "unit" is one placeable block: a single period, or a double-period (consecutive) for labs
interface Unit {
  lessonId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  roomId?: string;
  isDouble: boolean;
  avoidFirstPeriod: boolean;
  avoidLastPeriod: boolean;
  allowRepeatSameDay: boolean;
}

function expandToUnits(lessons: LessonRequirement[]): Unit[] {
  const units: Unit[] = [];
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
  return units;
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

// ---------- single attempt ----------

function runOneAttempt(
  school: SchoolConfig,
  teachers: Map<string, Teacher>,
  lessons: LessonRequirement[],
  avoidPairKeys: Set<string>,
  rng: () => number
): GenerationResult {
  const classGrid = new Map<string, Set<string>>(); // classId -> set of slotKeys used
  const teacherGrid = new Map<string, Set<string>>(); // teacherId -> set of slotKeys used
  const roomGrid = new Map<string, Set<string>>(); // roomId -> set of slotKeys used
  const teacherDailyCount = new Map<string, Map<string, number>>(); // teacherId -> day -> count
  const teacherWeeklyCount = new Map<string, number>();
  // classId -> subjectId -> day -> count (for spreading across the week + no-repeat rule)
  const subjectDaySpread = new Map<string, Map<string, Map<string, number>>>();
  // classId -> slotKey -> teacherId, so we can check adjacency
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

  const entries: TimetableEntry[] = [];
  const unplaced: UnplacedItem[] = [];
  let penalty = 0;
  let ruleViolations = 0;

  // order: most constrained lessons first (fewer teacher-available slots, higher periodsPerWeek),
  // with randomization for restart diversity
  const lessonsOrdered = shuffle(lessons, rng).sort((a, b) => b.periodsPerWeek - a.periodsPerWeek);

  let units = expandToUnits(lessonsOrdered);
  units = shuffle(units, rng);
  // keep double-periods earlier since they're harder to place
  units.sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0));

  for (const unit of units) {
    const teacher = teachers.get(unit.teacherId);
    const candidates: { day: string; period: number; score: number; violations: number }[] = [];

    for (const day of school.workingDays) {
      const maxPeriod = unit.isDouble ? school.periodsPerDay - 1 : school.periodsPerDay;
      for (let period = 1; period <= maxPeriod; period++) {
        if (isBlocked(school, period)) continue;
        if (unit.isDouble && isBlocked(school, period + 1)) continue;

        const periodsToCheck = unit.isDouble ? [period, period + 1] : [period];

        // ---- hard constraints (never relaxed) ----
        let ok = true;
        for (const p of periodsToCheck) {
          const sk = slotKey(day, p);
          if (ensureSet(classGrid, unit.classSectionId).has(sk)) { ok = false; break; }
          if (ensureSet(teacherGrid, unit.teacherId).has(sk)) { ok = false; break; }
          if (unit.roomId && ensureSet(roomGrid, unit.roomId).has(sk)) { ok = false; break; }
          if (teacher && isTeacherUnavailable(teacher, day, p)) { ok = false; break; }
        }
        if (!ok) continue;

        // teacher load caps (also hard)
        if (teacher?.maxPeriodsPerDay) {
          const dayMap = teacherDailyCount.get(unit.teacherId);
          const used = dayMap?.get(day) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerDay) continue;
        }
        if (teacher?.maxPeriodsPerWeek) {
          const used = teacherWeeklyCount.get(unit.teacherId) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerWeek) continue;
        }

        // ---- soft-hard rules: preferred, but relaxed if a unit truly can't be placed otherwise ----
        let violations = 0;

        // Rule: no same subject twice in one day for this class
        const classMap = subjectDaySpread.get(unit.classSectionId);
        const subjMap = classMap?.get(unit.subjectId);
        const sameDayCount = subjMap?.get(day) ?? 0;
        if (!unit.allowRepeatSameDay && sameDayCount > 0) violations += 1;

        // Rule: avoid first / last teaching period of the day
        const startP = Math.min(...periodsToCheck);
        const endP = Math.max(...periodsToCheck);
        if (unit.avoidFirstPeriod && startP === firstPeriod) violations += 1;
        if (unit.avoidLastPeriod && endP === lastPeriod) violations += 1;

        // Rule: this teacher shouldn't be immediately adjacent (same class) to a teacher they're paired against
        if (avoidPairKeys.size > 0) {
          const teacherSlots = ensureTeacherSlotMap(unit.classSectionId);
          const prevSlot = teacherSlots.get(slotKey(day, startP - 1));
          const nextSlot = teacherSlots.get(slotKey(day, endP + 1));
          if (prevSlot && avoidPairKeys.has(pairKey(unit.teacherId, prevSlot))) violations += 1;
          if (nextSlot && avoidPairKeys.has(pairKey(unit.teacherId, nextSlot))) violations += 1;
        }

        // small random jitter to break ties + existing day-spread soft preference
        const score = sameDayCount * 10 + rng();

        candidates.push({ day, period, score, violations });
      }
    }

    if (candidates.length === 0) {
      unplaced.push({
        lessonRequirementId: unit.lessonId,
        classSectionId: unit.classSectionId,
        subjectId: unit.subjectId,
        teacherId: unit.teacherId,
        reason: "No free slot satisfies teacher/class/room/load constraints",
      });
      penalty += 1000;
      continue;
    }

    // prefer zero-violation candidates; among those, prefer lower (soft) score
    candidates.sort((a, b) => a.violations - b.violations || a.score - b.score);
    const chosen = candidates[0];
    penalty += Math.floor(chosen.score) + chosen.violations * 500;
    if (chosen.violations > 0) ruleViolations += chosen.violations;

    const periodsToPlace = unit.isDouble ? [chosen.period, chosen.period + 1] : [chosen.period];
    for (const p of periodsToPlace) {
      const sk = slotKey(chosen.day, p);
      ensureSet(classGrid, unit.classSectionId).add(sk);
      ensureSet(teacherGrid, unit.teacherId).add(sk);
      if (unit.roomId) ensureSet(roomGrid, unit.roomId).add(sk);
      ensureTeacherSlotMap(unit.classSectionId).set(sk, unit.teacherId);

      entries.push({
        classSectionId: unit.classSectionId,
        subjectId: unit.subjectId,
        teacherId: unit.teacherId,
        roomId: unit.roomId,
        day: chosen.day,
        period: p,
      });
    }

    // update bookkeeping
    if (!teacherDailyCount.has(unit.teacherId)) teacherDailyCount.set(unit.teacherId, new Map());
    const dMap = teacherDailyCount.get(unit.teacherId)!;
    dMap.set(chosen.day, (dMap.get(chosen.day) ?? 0) + periodsToPlace.length);
    teacherWeeklyCount.set(unit.teacherId, (teacherWeeklyCount.get(unit.teacherId) ?? 0) + periodsToPlace.length);

    if (!subjectDaySpread.has(unit.classSectionId)) subjectDaySpread.set(unit.classSectionId, new Map());
    const cMap = subjectDaySpread.get(unit.classSectionId)!;
    if (!cMap.has(unit.subjectId)) cMap.set(unit.subjectId, new Map());
    const sMap = cMap.get(unit.subjectId)!;
    sMap.set(chosen.day, (sMap.get(chosen.day) ?? 0) + 1);
  }

  return { entries, unplaced, score: penalty, ruleViolations };
}

// ---------- public API ----------

export interface GenerateOptions {
  school: SchoolConfig;
  teachers: Teacher[];
  classSections: ClassSection[];
  lessons: LessonRequirement[];
  avoidAdjacentTeacherPairs?: TeacherPair[];
  attempts?: number; // number of random restarts, default 40
  seed?: number;
}

export function generateTimetable(opts: GenerateOptions): GenerationResult {
  const teacherMap = new Map(opts.teachers.map((t) => [t.id, t]));
  const attempts = opts.attempts ?? 40;
  const baseSeed = opts.seed ?? 42;

  const avoidPairKeys = new Set(
    (opts.avoidAdjacentTeacherPairs ?? []).map((p) => pairKey(p.teacherAId, p.teacherBId))
  );

  let best: GenerationResult | null = null;
  for (let i = 0; i < attempts; i++) {
    const rng = makeRng(baseSeed + i * 9973);
    const result = runOneAttempt(opts.school, teacherMap, opts.lessons, avoidPairKeys, rng);
    if (!best || result.score < best.score) {
      best = result;
    }
    if (best.unplaced.length === 0 && best.score === 0) break; // perfect, stop early
  }
  return best!;
}
