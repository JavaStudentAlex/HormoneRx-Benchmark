import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import LiveConsultation from './pages/LiveConsultation';
import EvidenceLibrary from './pages/EvidenceLibrary';
import Benchmark from './pages/Benchmark';
import About from './pages/About';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="live" element={<LiveConsultation />} />
        {/* Old bookmark compatibility: Analyze Case became the text tab of Live Consultation. */}
        <Route path="analyze" element={<Navigate to="/live?tab=text" replace />} />
        <Route path="evidence" element={<EvidenceLibrary />} />
        <Route path="benchmark" element={<Benchmark />} />
        <Route path="about" element={<About />} />
      </Route>
    </Routes>
  );
}
