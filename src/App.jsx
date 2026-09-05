import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { AcademyDataProvider, useAcademyData } from './context/AcademyDataContext';
import { PlanProvider } from './context/PlanContext';
import { LoadingProvider } from './components/LoadingContext';
import GlobalLoaderOverlay from './components/GlobalLoaderOverlay';
import CircularLoader from './components/CircularLoader';
import useSwipeNav, { SWIPE_TABS } from './hooks/useSwipeNav';
import LoginScreen from './pages/LoginScreen';
import SignupScreen from './pages/SignupScreen';
import SignupSuccessScreen from './pages/SignupSuccessScreen';
import TopBar from './components/TopBar';
import BottomNav from './components/BottomNav';
import NavDrawer from './components/NavDrawer';
import HomeTab from './tabs/HomeTab';
import StudentsTab from './tabs/StudentsTab';
import AttendanceTab from './tabs/AttendanceTab';
import FeesTab from './tabs/FeesTab';
import EnquiryTab from './tabs/EnquiryTab';
import ProfileTab from './tabs/ProfileTab';
import CalendarTab from './tabs/CalendarTab';
import SportsBatchesPage from './admin/SportsBatchesPage';
import UsersPage from './admin/UsersPage';
import CoursesPage from './admin/CoursesPage';
import SchedulesPage from './admin/SchedulesPage';
import PerformancePage from './admin/PerformancePage';
import AddProgramPage from './admin/AddProgramPage';
import ProgramListPage from './admin/ProgramListPage';
import ClassLogPage from './admin/ClassLogPage';
import ActivityPage from './admin/ActivityPage';
import LeaveCountPage from './admin/LeaveCountPage';
import StaffLeavePage from './admin/StaffLeavePage';
import StaffReportPage from './admin/StaffReportPage';

// Apply the saved theme as soon as the app's JS loads, before anything renders.
const savedTheme = localStorage.getItem('feezo-theme') || 'dark';
document.body.classList.toggle('dark-theme', savedTheme === 'dark');

// Main swipeable tabs — these stay mounted once visited instead of being
// destroyed/recreated on every switch. Each one fetches + subscribes to
// realtime exactly once per session; switching away just hides it (CSS),
// switching back shows it instantly with whatever it already has, kept
// live the whole time by its own realtime channel. Fixes the "percentage
// loading screen on every tab switch" issue (each unmount/remount used to
// refetch from Supabase and re-trigger the global loader).
const MAIN_TABS = [
  { path: '/home', Component: HomeTab },
  { path: '/students', Component: StudentsTab },
  { path: '/attendance', Component: AttendanceTab },
  { path: '/fees', Component: FeesTab },
  { path: '/enquiry', Component: EnquiryTab },
  { path: '/calendar', Component: CalendarTab },
  { path: '/profile', Component: ProfileTab },
];
const MAIN_TAB_PATHS = MAIN_TABS.map(t => t.path);

// Renders every main tab that has EVER been visited this session, all
// stacked in the same spot; only the active one is display:block, the
// rest are display:none (not unmounted). A tab is added to `visited` the
// first time its path is hit, so tabs the user never opens are never
// mounted/fetched at all.
function MainTabsHost({ pathname, animClass }) {
  const [visited, setVisited] = useState(() => new Set([pathname]));
  useEffect(() => {
    setVisited(prev => (prev.has(pathname) ? prev : new Set(prev).add(pathname)));
  }, [pathname]);

  return (
    <>
      {MAIN_TABS.filter(t => visited.has(t.path)).map(({ path, Component }) => (
        <div
          key={path}
          className={path === pathname ? animClass : ''}
          style={{ position: 'absolute', inset: 0, display: path === pathname ? 'block' : 'none' }}
        >
          <Component isActive={path === pathname} />
        </div>
      ))}
    </>
  );
}

function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { academy } = useAcademyData();
  const viewportRef = useRef(null);
  useSwipeNav(viewportRef);

  // Directional slide+fade whenever the active tab changes (swipe or bottom-nav tap).
  const location = useLocation();
  const prevIndexRef = useRef(SWIPE_TABS.indexOf(location.pathname));
  const [animClass, setAnimClass] = useState('');
  useEffect(() => {
    const idx = SWIPE_TABS.indexOf(location.pathname);
    const prevIdx = prevIndexRef.current;
    setAnimClass(idx !== -1 && prevIdx !== -1 && idx !== prevIdx ? (idx > prevIdx ? 'tab-enter-right' : 'tab-enter-left') : '');
    prevIndexRef.current = idx;
  }, [location.pathname]);

  return (
    <div id="app" className="active">
      <TopBar
        academyName={academy?.name || 'Academy'}
        logoUrl={academy?.logo_url}
        greeting="Welcome back"
        onToggleMenu={() => setMenuOpen(v => !v)}
        onToggleNotif={() => {}}
        hasNotif={false}
      />
      <div className="content pages-viewport" ref={viewportRef} style={{ padding: '10px 14px', position: 'relative' }}>
        {MAIN_TAB_PATHS.includes(location.pathname) ? (
          // Swipeable main tabs — kept alive, never remounted after first visit.
          <MainTabsHost pathname={location.pathname} animClass={animClass} />
        ) : (
          // Everything else (admin pages, staff leave) keeps the old
          // mount-per-visit behavior — these are visited far less often,
          // so there's no benefit to keeping them alive in memory.
          <div key={location.pathname} className={animClass} style={{ position: 'absolute', inset: 0 }}>
            <Routes>
              <Route path="/calendar/leave" element={<StaffLeavePage />} />
              <Route path="/calendar/staff-report" element={<StaffReportPage />} />
              <Route path="/admin/sports-batches" element={<SportsBatchesPage />} />
              <Route path="/admin/users" element={<UsersPage />} />
              <Route path="/admin/courses" element={<CoursesPage />} />
              <Route path="/admin/schedules" element={<SchedulesPage />} />
              <Route path="/admin/performance" element={<PerformancePage />} />
              <Route path="/admin/performance/add" element={<AddProgramPage />} />
              <Route path="/admin/performance/programs" element={<ProgramListPage />} />
              <Route path="/admin/activity" element={<ActivityPage />} />
              <Route path="/admin/class-log" element={<ClassLogPage />} />
              <Route path="/admin/leave-count" element={<LeaveCountPage />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </div>
        )}
      </div>
      <BottomNav />
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="app-copyright">© 2026 FeeZo Solutions · v3</div>
      <GlobalLoaderOverlay />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <CircularLoader label="Signing you in..." />
      </div>
    );
  }

  if (!user) {
    // Signup flow (academy details -> password -> success) is only ever
    // seen while logged out. Any other path — including the old bare "/"
    // behavior — still falls through to LoginScreen, same as before.
    return (
      <Routes>
        <Route path="/signup" element={<SignupScreen />} />
        <Route path="/signup/password" element={<Navigate to="/signup" replace />} />
        <Route path="/signup/success" element={<SignupSuccessScreen />} />
        <Route path="*" element={<LoginScreen />} />
      </Routes>
    );
  }

  return (
    <AcademyDataProvider>
      <PlanProvider>
        <LoadingProvider>
          <AppShell />
        </LoadingProvider>
      </PlanProvider>
    </AcademyDataProvider>
  );
}
