import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import BatchToasts from './components/BatchToasts';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const ProjectEditor = lazy(() => import('./pages/ProjectEditor'));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/project/:id" element={<ProjectEditor />} />
      </Routes>
      </Suspense>
      {/* background batches report here, on any page */}
      <BatchToasts />
    </BrowserRouter>
  );
}
