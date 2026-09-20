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

interface Wanted {
  // The ERP's stable identity for this record — subject.code for subjects,
  // employee.employee (the person's real id, NOT the per-assignment `_id`
  // or the human-readable `employeeId`) for teachers. Absent for
  // class_sections, which have no reliable per-record ERP id (a mapping
  // row's own `_id` turned out to vary for the *same* class when it's
  // split by stream/group, so name-based matching is what's actually
  // stable there).
  externalKey?: string;
  fields: Record<string, unknown>;
}

// Matches by externalKey first (so re-imports land on the exact same
// record even if the display name changes), falling back to matching by
// `matchColumns` for rows written before externalKey existed, or for
// class_sections which never have one. Newly-created rows always get an
// externalKey stamped on so later imports can match them directly.
function getOrCreateIdMap(
  table: "class_sections" | "subjects" | "teachers",
  schoolId: string,
  matchColumns: string[],
  wanted: Map<string, Wanted>
): { idByKey: Map<string, string>; addedCount: number } {
  const existing = localDb.select(table, { school_id: schoolId });

  const idByExternalKey = new Map<string, string>();
  const idByNameKey = new Map<string, string>();
  for (const row of existing) {
    if (row.external_key) idByExternalKey.set(row.external_key as string, row.id);
    idByNameKey.set(matchColumns.map((col) => row[col]).join("::"), row.id);
  }

  const idByKey = new Map<string, string>();
  const toInsert: { key: string; wanted: Wanted }[] = [];

  for (const [key, w] of wanted) {
    const nameKey = matchColumns.map((col) => w.fields[col]).join("::");
    const existingId =
      (w.externalKey && idByExternalKey.get(w.externalKey)) ?? idByNameKey.get(nameKey);
    if (existingId) {
      idByKey.set(key, existingId);
    } else {
      toInsert.push({ key, wanted: w });
    }
  }

  if (toInsert.length > 0) {
    const inserted = localDb.insert(
      table,
      toInsert.map((r) => ({
        school_id: schoolId,
        ...r.wanted.fields,
        external_key: r.wanted.externalKey ?? null,
      }))
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
  const classSectionNames = new Map<string, Wanted>();
  const subjectByKey = new Map<string, Wanted>();
  const teacherByKey = new Map<string, Wanted>();

  for (const row of mappings) {
    const csKey = `${row.course}::${sectionName(row)}`;
    classSectionNames.set(csKey, {
      fields: { class_name: row.course, section_name: sectionName(row) },
    });

    for (const subject of row.subjects) {
      // `code` is the ERP's stable identity for a subject — unlike its
      // `_id` here, which is per class-assignment (the same subject shows
      // up under dozens of different `_id`s across classes). Falls back to
      // name if a subject genuinely has no code.
      const subjectKey = subject.code || subject.name;
      const isScholastic = subject.assessmentModel === "scholastic";
      const prior = subjectByKey.get(subjectKey);
      if (prior) {
        // A subject can show up with an inconsistent assessmentModel across
        // different classes (data entry inconsistency on the ERP side).
        // Default to including it if *any* occurrence says scholastic,
        // rather than letting whichever class happened to import first
        // silently decide — better to schedule something you didn't need
        // than to never notice a subject went missing.
        prior.fields.included = (prior.fields.included as boolean) || isScholastic;
      } else {
        subjectByKey.set(subjectKey, {
          externalKey: subjectKey,
          fields: { name: subject.name, included: isScholastic },
        });
      }

      // A subject can have more than one teacher assigned for the same
      // class (e.g. theory + practical, or a co-taught session) — import
      // every one of them, not just the first.
      for (const teacher of subject.employees) {
        // `employee` is the person's actual id. Two different real
        // teachers can share a display name (confirmed in this school's
        // own data — two different "SUNAINA"s) — matching by name alone
        // would silently merge them into one. `employeeId` (a short human
        // code) would also work but `employee` is the ERP's own foreign
        // key, so it's the safer bet. Falls back to name only if `employee`
        // is somehow missing.
        const teacherKey = teacher.employee || teacher.employeeName;
        if (!teacherByKey.has(teacherKey)) {
          teacherByKey.set(teacherKey, {
            externalKey: teacherKey,
            fields: { name: teacher.employeeName },
          });
        }
      }
    }
  }

  const classSections = getOrCreateIdMap(
    "class_sections",
    schoolId,
    ["class_name", "section_name"],
    classSectionNames
  );
  const subjects = getOrCreateIdMap("subjects", schoolId, ["name"], subjectByKey);
  const teachers = getOrCreateIdMap("teachers", schoolId, ["name"], teacherByKey);

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
      const subjectKey = subject.code || subject.name;
      const subjectId = subjects.idByKey.get(subjectKey);
      if (!subjectId) continue;

      // One requirement row per teacher assigned to this subject for this
      // class — a subject with two teachers (theory + practical, say)
      // becomes two rows, not one.
      for (const teacher of subject.employees) {
        const teacherKey = teacher.employee || teacher.employeeName;
        const teacherId = teachers.idByKey.get(teacherKey);
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
          // The ERP mapping has no real periods/week value — this is a
          // guessed default, not curriculum data. Flagged so Setup can show
          // it as unverified until a human confirms or edits it.
          periods_per_week_is_default: true,
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
