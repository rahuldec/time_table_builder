import { localDb } from "./localDb";
import type { AcademicCourseMapping } from "./academicApi";

export interface ImportSummary {
  classSectionsAdded: number;
  subjectsAdded: number;
  teachersAdded: number;
  lessonRequirementsAdded: number;
  lessonRequirementsSkipped: number; // already existed, left untouched
}

function sectionName(row: AcademicCourseMapping): string {
  return row.batch && row.batch !== "NA" ? `${row.section} (${row.batch})` : row.section;
}

function getOrCreateIdMap(
  table: "class_sections" | "subjects" | "teachers",
  schoolId: string,
  matchColumns: string[],
  wanted: Map<string, Record<string, unknown>>
): { idByKey: Map<string, string>; addedCount: number } {
  const existing = localDb.select(table, { school_id: schoolId });

  const idByKey = new Map<string, string>();
  const existingKeys = new Set<string>();
  for (const row of existing) {
    const key = matchColumns.map((col) => row[col]).join("::");
    existingKeys.add(key);
    idByKey.set(key, row.id);
  }

  const toInsert: { key: string; fields: Record<string, unknown> }[] = [];
  for (const [key, fields] of wanted) {
    if (!existingKeys.has(key)) toInsert.push({ key, fields });
  }

  if (toInsert.length > 0) {
    const inserted = localDb.insert(
      table,
      toInsert.map((r) => ({ school_id: schoolId, ...r.fields }))
    );
    inserted.forEach((row, i) => idByKey.set(toInsert[i].key, row.id));
  }

  return { idByKey, addedCount: toInsert.length };
}

export function importAcademicMappings(
  schoolId: string,
  mappings: AcademicCourseMapping[],
  defaultPeriodsPerWeek: number
): ImportSummary {
  // ---- collect unique class sections, subjects, teachers seen in this pull ----
  const classSectionNames = new Map<string, Record<string, unknown>>();
  const subjectNames = new Map<string, Record<string, unknown>>();
  const teacherNames = new Map<string, Record<string, unknown>>();

  for (const row of mappings) {
    const csKey = `${row.course}::${sectionName(row)}`;
    classSectionNames.set(csKey, { class_name: row.course, section_name: sectionName(row) });

    for (const subject of row.subjects) {
      // Scholastic subjects go into the timetable by default; co-scholastic
      // and discipline periods (Art, Discipline, Work Ed, etc.) start off
      // toggled out — the user can flip them on in section 3 if they want
      // them scheduled too.
      if (!subjectNames.has(subject.name)) {
        subjectNames.set(subject.name, {
          name: subject.name,
          included: subject.assessmentModel === "scholastic",
        });
      }
      // A subject can have more than one teacher assigned for the same
      // class (e.g. theory + practical, or a co-taught session) — import
      // every one of them, not just the first.
      for (const teacher of subject.employees) {
        teacherNames.set(teacher.employeeName, { name: teacher.employeeName });
      }
    }
  }

  const classSections = getOrCreateIdMap(
    "class_sections",
    schoolId,
    ["class_name", "section_name"],
    classSectionNames
  );
  const subjects = getOrCreateIdMap("subjects", schoolId, ["name"], subjectNames);
  const teachers = getOrCreateIdMap("teachers", schoolId, ["name"], teacherNames);

  // ---- figure out which lesson_requirements are genuinely new ----
  const existingReqs = localDb.select("lesson_requirements", { school_id: schoolId });
  const existingReqKeys = new Set(
    existingReqs.map((r) => `${r.class_section_id}::${r.subject_id}::${r.teacher_id}`)
  );

  const newRequirements: Record<string, unknown>[] = [];
  const seenThisImport = new Set<string>();
  let skipped = 0;

  for (const row of mappings) {
    const csKey = `${row.course}::${sectionName(row)}`;
    const classSectionId = classSections.idByKey.get(csKey);
    if (!classSectionId) continue;

    for (const subject of row.subjects) {
      const subjectId = subjects.idByKey.get(subject.name);
      if (!subjectId) continue;

      // One requirement row per teacher assigned to this subject for this
      // class — a subject with two teachers (theory + practical, say)
      // becomes two rows, not one.
      for (const teacher of subject.employees) {
        const teacherId = teachers.idByKey.get(teacher.employeeName);
        if (!teacherId) continue;

        const key = `${classSectionId}::${subjectId}::${teacherId}`;
        if (seenThisImport.has(key)) continue;
        seenThisImport.add(key);

        if (existingReqKeys.has(key)) {
          skipped++;
          continue;
        }

        newRequirements.push({
          school_id: schoolId,
          class_section_id: classSectionId,
          subject_id: subjectId,
          teacher_id: teacherId,
          periods_per_week: defaultPeriodsPerWeek,
          is_lab: false,
          days: [],
        });
      }
    }
  }

  if (newRequirements.length > 0) {
    localDb.insert("lesson_requirements", newRequirements);
  }

  return {
    classSectionsAdded: classSections.addedCount,
    subjectsAdded: subjects.addedCount,
    teachersAdded: teachers.addedCount,
    lessonRequirementsAdded: newRequirements.length,
    lessonRequirementsSkipped: skipped,
  };
}
