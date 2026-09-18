// Client for the OD3 academic API — used to pull subject/course/teacher
// mappings set up in the school's ERP instead of re-entering them by hand in
// Setup. The actual call goes through /api/academic-subject-course-mapping
// (a Vercel serverless function) so the bearer token never reaches the
// browser — it lives only in server-side env vars, not VITE_-prefixed ones.

// Entity id is not a secret — it's just an identifier, safe to expose and to
// let the caller (Setup page) override per import.
export const DEFAULT_ENTITY_ID = (import.meta.env.VITE_ACADEMIC_ENTITY_ID as string) ?? "";

export interface AcademicEmployee {
  _id: string;
  employee: string;
  employeeId: string;
  employeeName: string;
}

export interface AcademicSubject {
  _id: string;
  name: string;
  code: string;
  subjectType: string;
  mode: string;
  sequenceNo: number;
  employees: AcademicEmployee[];
  // "scholastic" | "co-scholastic" | "discipline"
  assessmentModel: string;
}

export interface AcademicCourseMapping {
  _id: string;
  course: string;
  stream: string;
  batch: string;
  section: string;
  status: boolean;
  subjects: AcademicSubject[];
}

interface SubjectCourseMappingResponse {
  count: number;
  data: AcademicCourseMapping[];
}

async function fetchSubjectCourseMappingPage(
  entityId: string,
  pageNumber: number,
  pageSize: number
): Promise<SubjectCourseMappingResponse> {
  const res = await fetch("/api/academic-subject-course-mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity: entityId, pageNumber, pageSize }),
  });
  if (!res.ok) {
    throw new Error(`Academic API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Pages through the full result set and returns every course/section/subject
// mapping for the given entity (school), using the configured session.
export async function fetchAllSubjectCourseMappings(
  entityId: string
): Promise<AcademicCourseMapping[]> {
  if (!entityId.trim()) throw new Error("Entity ID is required.");
  const pageSize = 50;
  const first = await fetchSubjectCourseMappingPage(entityId, 1, pageSize);
  const all = [...first.data];
  const totalPages = Math.ceil(first.count / pageSize);
  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchSubjectCourseMappingPage(entityId, page, pageSize);
    all.push(...next.data);
  }
  return all;
}
