import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, signIn, signOut } from '../lib/supabaseClient';
import { maybeAutoSnapshot } from '../lib/snapshot';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [academyId, setAcademyId] = useState(null);
  const [appUser, setAppUser] = useState(null); // row from app_users (role, permissions, assigned sports/batches)
  const [loading, setLoading] = useState(true);

  const loadAppUser = useCallback(async (authUser) => {
    if (!authUser) { setAppUser(null); setAcademyId(null); return; }
    const { data, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle();
    if (!error && data) {
      setAppUser(data);
      setAcademyId(data.academy_id);

      // Auto-backup: if this is an admin, make sure today's snapshot exists.
      // maybeAutoSnapshot no-ops if one was already taken since local midnight,
      // so this is safe to call on every session load / token refresh, not
      // just a fresh login.
      const roles = (data.role || '').split(',').map(r => r.trim());
      if (roles.includes('admin') && data.academy_id) {
        maybeAutoSnapshot(data.academy_id).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session ? data.session.user : null;
      setUser(u);
      // Realtime authenticates its websocket once at connect time using
      // whatever token is current then. On the very first load, sync it
      // explicitly so a long-open tab doesn't start life on a token that's
      // about to expire.
      if (data.session?.access_token) {
        supabase.realtime.setAuth(data.session.access_token);
      }
      loadAppUser(u).finally(() => setLoading(false));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session ? session.user : null;
      setUser(u);
      // Supabase silently rotates the access token roughly every hour.
      // The realtime client does NOT pick that up on its own — without this,
      // an open tab's websocket keeps using the old JWT to evaluate RLS on
      // incoming broadcasts, and once that JWT expires the tab stops
      // receiving realtime events (its own writes still work, since those
      // go through a fresh REST call, not the socket). This is why it looked
      // like only "receiving" broke, not "sending", and why a refresh fixed
      // it — a refresh reconnects the socket with a fresh token.
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
      loadAppUser(u);
    });
    return () => sub.subscription.unsubscribe();
  }, [loadAppUser]);

  const login = async (rawId, password) => {
    const id = rawId.trim().toLowerCase();
    const email = id.includes('@') ? id : id + '@gmail.com';
    const { data, error } = await signIn(email, password);
    if (error) throw error;
    return data;
  };

  const logout = async () => {
    await signOut();
    setUser(null);
    setAppUser(null);
    setAcademyId(null);
  };

  // Permission helper: admin sees everything, staff restricted to assigned sports/batches
  const roles = (appUser?.role || '').split(',').map(r => r.trim());
  const isAdmin = roles.includes('admin');
  const assignedSports = appUser?.assigned_sports || [];
  const assignedBatches = appUser?.assigned_batches || [];
  // Admins always see contact info; staff need the toggle explicitly granted in Staff Users.
  const canViewContact = isAdmin || !!appUser?.can_view_contact;
  // Admins can always export PDF/XL; staff need the toggle explicitly granted in Staff Users.
  const canExport = isAdmin || !!appUser?.can_export;
  // Admins can always import students; staff need the toggle explicitly granted in Staff Users.
  const canImport = isAdmin || !!appUser?.can_import;
  // Per-tab access: admins always see all four tabs; staff see only the
  // tabs an admin has explicitly granted them in Staff Users. Same
  // grant-required pattern as canExport/canImport/canViewContact above —
  // a brand-new staff account starts with none of these until an admin
  // turns them on.
  const canViewHome = isAdmin || !!appUser?.can_view_home;
  const canViewStudents = isAdmin || !!appUser?.can_view_students;
  const canViewAttendance = isAdmin || !!appUser?.can_view_attendance;
  const canViewFees = isAdmin || !!appUser?.can_view_fees;

  const value = {
    user, appUser, academyId, loading,
    isAdmin, assignedSports, assignedBatches, canViewContact, canExport, canImport,
    canViewHome, canViewStudents, canViewAttendance, canViewFees,
    login, logout, refreshAppUser: () => loadAppUser(user),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
