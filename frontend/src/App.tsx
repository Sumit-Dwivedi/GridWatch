import { Routes, Route, Navigate } from 'react-router-dom';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={
        <div className="flex items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">Login Page — Phase 11</h1>
        </div>
      } />
      <Route path="/dashboard" element={
        <div className="flex items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">Dashboard — Phase 11</h1>
        </div>
      } />
      <Route path="/alerts" element={
        <div className="flex items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">Alerts — Phase 11</h1>
        </div>
      } />
      <Route path="/sensors/:id" element={
        <div className="flex items-center justify-center min-h-screen">
          <h1 className="text-2xl font-bold">Sensor Detail — Phase 11</h1>
        </div>
      } />
    </Routes>
  );
}

export default App;
