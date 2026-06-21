import { NavLink } from "react-router-dom";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-lg font-medium text-sm transition-colors ${
    isActive
      ? "bg-[var(--ink-teal)] text-white"
      : "text-[var(--ink-text)] hover:bg-[var(--ink-teal-light)]"
  }`;

export function Nav() {
  return (
    <header className="border-b border-[#e5e0d4] bg-white">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="font-bold text-lg" style={{ color: "var(--ink-teal)" }}>
          Timetable Builder
        </div>
        <nav className="flex gap-2">
          <NavLink to="/" className={linkClass} end>
            Setup
          </NavLink>
          <NavLink to="/generate" className={linkClass}>
            Generate
          </NavLink>
          <NavLink to="/timetable" className={linkClass}>
            View Timetable
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
