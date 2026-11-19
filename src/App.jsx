import React, { useState } from 'react';
import StudentView from './StudentView';
import AdminView from './AdminView';

export default function App() {
  const [isAdminPage, setIsAdminPage] = useState(false);

  return isAdminPage ? (
    <AdminView onBackToStudent={() => setIsAdminPage(false)} />
  ) : (
    <StudentView onSwitchToAdmin={() => setIsAdminPage(true)} />
  );
}