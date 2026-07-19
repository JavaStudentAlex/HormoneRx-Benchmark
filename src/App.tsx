import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import AnalyzeCase from './pages/AnalyzeCase';
import EvidenceLibrary from './pages/EvidenceLibrary';
import Benchmark from './pages/Benchmark';
import About from './pages/About';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="analyze" element={<AnalyzeCase />} />
        <Route path="evidence" element={<EvidenceLibrary />} />
        <Route path="benchmark" element={<Benchmark />} />
        <Route path="about" element={<About />} />
      </Route>
    </Routes>
  );
}
