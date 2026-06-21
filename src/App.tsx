import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import Setup from "./pages/Setup";
import Generate from "./pages/Generate";
import Timetable from "./pages/Timetable";

export default function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Setup />} />
        <Route path="/generate" element={<Generate />} />
        <Route path="/timetable" element={<Timetable />} />
      </Routes>
    </BrowserRouter>
  );
}
