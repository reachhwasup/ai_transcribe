import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ProjectEditor from './pages/ProjectEditor';
import TranscribeToast from './components/TranscribeToast';
import AudioGenerateToast from './components/AudioGenerateToast';

export default function App() {
  return (
    <BrowserRouter>
      <TranscribeToast />
      <AudioGenerateToast />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/project/:id" element={<ProjectEditor />} />
      </Routes>
    </BrowserRouter>
  );
}
