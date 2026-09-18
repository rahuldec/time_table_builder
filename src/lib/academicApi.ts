// Client for the OD3 academic API (academic-api.odpay.in) — used to pull
// subject/course/teacher mappings set up in the school's ERP instead of
// re-entering them by hand in Setup.

const BASE_URL = import.meta.env.VITE_ACADEMIC_API_BASE_URL as string;
const TOKEN = import.meta.env.VITE_ACADEMIC_API_TOKEN as string;
const ENTITY_ID = import.meta.env.VITE_ACADEMIC_ENTITY_ID as string;
const SESSION = import.meta.env.VITE_ACADEMIC_SESSION as string;

if (!BASE_URL || !TOKEN || !ENTITY_ID || !SESSION) {
  console.error(
    "Missing Academic API env vars. Set VITE_ACADEMIC_API_BASE_URL, VITE_ACADEMIC_API_TOKEN, VITE_ACADEMIC_ENTITY_ID, VITE_ACADEMIC_SESSION."
  );
}

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
  pageNumber: number,
  pageSize: number
): Promise<SubjectCourseMappingResponse> {
  const res = await fetch(
    `${BASE_URL}/api/list/subjectCourseMapping?pageSize=${pageSize}&pageNumber=${pageNumber}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The API expects the raw JWT here, not a "Bearer " prefix.
        Authorization: TOKEN,
      },
      body: JSON.stringify({ entity: ENTITY_ID, session: SESSION }),
    }
  );
  if (!res.ok) {
    throw new Error(`Academic API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Pages through the full result set and returns every course/section/subject
// mapping for the configured entity + session.
export async function fetchAllSubjectCourseMappings(): Promise<AcademicCourseMapping[]> {
  const pageSize = 50;
  const first = await fetchSubjectCourseMappingPage(1, pageSize);
  const all = [...first.data];
  const totalPages = Math.ceil(first.count / pageSize);
  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchSubjectCourseMappingPage(page, pageSize);
    all.push(...next.data);
  }
  return all;
}
