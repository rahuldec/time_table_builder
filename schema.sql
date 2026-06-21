-- ===========================================================
-- Timetable Builder - Supabase schema
-- ===========================================================

create extension if not exists "uuid-ossp";

-- A school using the tool (standalone product -> can have many schools, each isolated)
create table schools (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  working_days text[] not null default array['Mon','Tue','Wed','Thu','Fri','Sat'],
  periods_per_day int not null default 8,
  blocked_periods int[] not null default array[]::int[], -- e.g. lunch break period number
  created_at timestamptz not null default now()
);

create table class_sections (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  class_name text not null,      -- "Grade 6"
  section_name text not null,    -- "Ganges"
  created_at timestamptz not null default now()
);

create table subjects (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,
  is_lab boolean not null default false,
  created_at timestamptz not null default now()
);

create table teachers (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,
  max_periods_per_day int,
  max_periods_per_week int,
  created_at timestamptz not null default now()
);

-- specific slots a teacher can never teach (part-time, off-days, etc.)
create table teacher_unavailability (
  id uuid primary key default uuid_generate_v4(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  day text not null,
  period int not null
);

create table rooms (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  name text not null,       -- "Computer Lab 1"
  room_type text not null default 'regular' -- regular | lab | computer | other
);

-- the actual requirement: this class needs this subject, taught by this teacher, N times/week
create table lesson_requirements (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  class_section_id uuid not null references class_sections(id) on delete cascade,
  subject_id uuid not null references subjects(id) on delete cascade,
  teacher_id uuid not null references teachers(id) on delete cascade,
  room_id uuid references rooms(id),
  periods_per_week int not null,
  is_lab boolean not null default false,
  created_at timestamptz not null default now()
);

-- one row per (class, day, period) once the timetable is generated/edited
create table timetable_entries (
  id uuid primary key default uuid_generate_v4(),
  school_id uuid not null references schools(id) on delete cascade,
  class_section_id uuid not null references class_sections(id) on delete cascade,
  subject_id uuid not null references subjects(id) on delete cascade,
  teacher_id uuid not null references teachers(id) on delete cascade,
  room_id uuid references rooms(id),
  day text not null,
  period int not null,
  version int not null default 1, -- bump when admin regenerates, keeps history if needed
  created_at timestamptz not null default now(),
  unique (school_id, class_section_id, day, period, version),
  unique (school_id, teacher_id, day, period, version)
);

create index idx_timetable_entries_class on timetable_entries(class_section_id, version);
create index idx_timetable_entries_teacher on timetable_entries(teacher_id, version);
create index idx_lesson_req_class on lesson_requirements(class_section_id);

-- Row Level Security (enable + restrict to the school's own data once auth is wired up)
alter table schools enable row level security;
alter table class_sections enable row level security;
alter table subjects enable row level security;
alter table teachers enable row level security;
alter table teacher_unavailability enable row level security;
alter table rooms enable row level security;
alter table lesson_requirements enable row level security;
alter table timetable_entries enable row level security;

-- NOTE: add real policies once you decide on auth model (e.g. school_admin_id = auth.uid()).
-- Placeholder permissive policy for development - tighten before going live:
create policy "dev_allow_all" on schools for all using (true);
create policy "dev_allow_all" on class_sections for all using (true);
create policy "dev_allow_all" on subjects for all using (true);
create policy "dev_allow_all" on teachers for all using (true);
create policy "dev_allow_all" on teacher_unavailability for all using (true);
create policy "dev_allow_all" on rooms for all using (true);
create policy "dev_allow_all" on lesson_requirements for all using (true);
create policy "dev_allow_all" on timetable_entries for all using (true);
