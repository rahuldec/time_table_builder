import type {
  SchoolConfig,
  Teacher,
  ClassSection,
  LessonRequirement,
  TimetableEntry,
  UnplacedItem,
  GenerationResult,
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

// A "unit" is one placeable block: a single period, or a double-period (consecutive) for labs
interface Unit {
  lessonId: string;
  classSectionId: string;
  subjectId: string;
  teacherId: string;
  roomId?: string;
  isDouble: boolean;
}

function expandToUnits(lessons: LessonRequirement[]): Unit[] {
  const units: Unit[] = [];
  for (const lesson of lessons) {
    const isLab = !!lesson.isLab;
    let remaining = lesson.periodsPerWeek;
    if (isLab) {
      // group into double periods, with a trailing single if odd
      while (remaining >= 2) {
        units.push({
          lessonId: lesson.id,
          classSectionId: lesson.classSectionId,
          subjectId: lesson.subjectId,
          teacherId: lesson.teacherId,
          roomId: lesson.roomId,
          isDouble: true,
        });
        remaining -= 2;
      }
      if (remaining === 1) {
        units.push({
          lessonId: lesson.id,
          classSectionId: lesson.classSectionId,
          subjectId: lesson.subjectId,
          teacherId: lesson.teacherId,
          roomId: lesson.roomId,
          isDouble: false,
        });
      }
    } else {
      for (let i = 0; i < remaining; i++) {
        units.push({
          lessonId: lesson.id,
          classSectionId: lesson.classSectionId,
          subjectId: lesson.subjectId,
          teacherId: lesson.teacherId,
          roomId: lesson.roomId,
          isDouble: false,
        });
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

// ---------- single attempt ----------

function runOneAttempt(
  school: SchoolConfig,
  teachers: Map<string, Teacher>,
  lessons: LessonRequirement[],
  rng: () => number
): GenerationResult {
  const classGrid = new Map<string, Set<string>>(); // classId -> set of slotKeys used
  const teacherGrid = new Map<string, Set<string>>(); // teacherId -> set of slotKeys used
  const roomGrid = new Map<string, Set<string>>(); // roomId -> set of slotKeys used
  const teacherDailyCount = new Map<string, Map<string, number>>(); // teacherId -> day -> count
  const teacherWeeklyCount = new Map<string, number>();
  // classId -> subjectId -> day -> count (for spreading across the week)
  const subjectDaySpread = new Map<string, Map<string, Map<string, number>>>();

  const ensureSet = (map: Map<string, Set<string>>, key: string) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key)!;
  };

  const entries: TimetableEntry[] = [];
  const unplaced: UnplacedItem[] = [];
  let penalty = 0;

  // order: most constrained lessons first (fewer teacher-available slots, higher periodsPerWeek),
  // with randomization for restart diversity
  const lessonsOrdered = shuffle(lessons, rng).sort((a, b) => b.periodsPerWeek - a.periodsPerWeek);

  let units = expandToUnits(lessonsOrdered);
  units = shuffle(units, rng);
  // keep double-periods earlier since they're harder to place
  units.sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0));

  for (const unit of units) {
    const teacher = teachers.get(unit.teacherId);
    const candidates: { day: string; period: number; score: number }[] = [];

    for (const day of school.workingDays) {
      const maxPeriod = unit.isDouble ? school.periodsPerDay - 1 : school.periodsPerDay;
      for (let period = 1; period <= maxPeriod; period++) {
        if (isBlocked(school, period)) continue;
        if (unit.isDouble && isBlocked(school, period + 1)) continue;

        const periodsToCheck = unit.isDouble ? [period, period + 1] : [period];

        // hard constraints
        let ok = true;
        for (const p of periodsToCheck) {
          const sk = slotKey(day, p);
          if (ensureSet(classGrid, unit.classSectionId).has(sk)) { ok = false; break; }
          if (ensureSet(teacherGrid, unit.teacherId).has(sk)) { ok = false; break; }
          if (unit.roomId && ensureSet(roomGrid, unit.roomId).has(sk)) { ok = false; break; }
          if (teacher && isTeacherUnavailable(teacher, day, p)) { ok = false; break; }
        }
        if (!ok) continue;

        // teacher load caps
        if (teacher?.maxPeriodsPerDay) {
          const dayMap = teacherDailyCount.get(unit.teacherId);
          const used = dayMap?.get(day) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerDay) continue;
        }
        if (teacher?.maxPeriodsPerWeek) {
          const used = teacherWeeklyCount.get(unit.teacherId) ?? 0;
          if (used + periodsToCheck.length > teacher.maxPeriodsPerWeek) continue;
        }

        // soft scoring: prefer spreading the same subject across different days for this class
        const classMap = subjectDaySpread.get(unit.classSectionId);
        const subjMap = classMap?.get(unit.subjectId);
        const sameDayCount = subjMap?.get(day) ?? 0;
        const score = sameDayCount * 10 + rng(); // small random jitter to break ties

        candidates.push({ day, period, score });
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

    candidates.sort((a, b) => a.score - b.score);
    const chosen = candidates[0];
    penalty += Math.floor(chosen.score);

    const periodsToPlace = unit.isDouble ? [chosen.period, chosen.period + 1] : [chosen.period];
    for (const p of periodsToPlace) {
      const sk = slotKey(chosen.day, p);
      ensureSet(classGrid, unit.classSectionId).add(sk);
      ensureSet(teacherGrid, unit.teacherId).add(sk);
      if (unit.roomId) ensureSet(roomGrid, unit.roomId).add(sk);

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

  return { entries, unplaced, score: penalty };
}

// ---------- public API ----------

export interface GenerateOptions {
  school: SchoolConfig;
  teachers: Teacher[];
  classSections: ClassSection[];
  lessons: LessonRequirement[];
  attempts?: number; // number of random restarts, default 40
  seed?: number;
}

export function generateTimetable(opts: GenerateOptions): GenerationResult {
  const teacherMap = new Map(opts.teachers.map((t) => [t.id, t]));
  const attempts = opts.attempts ?? 40;
  const baseSeed = opts.seed ?? 42;

  let best: GenerationResult | null = null;
  for (let i = 0; i < attempts; i++) {
    const rng = makeRng(baseSeed + i * 9973);
    const result = runOneAttempt(opts.school, teacherMap, opts.lessons, rng);
    if (!best || result.score < best.score) {
      best = result;
    }
    if (best.unplaced.length === 0 && best.score === 0) break; // perfect, stop early
  }
  return best!;
}
