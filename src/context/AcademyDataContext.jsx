import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from './AuthContext';
import { parseBatchKey, buildBatchKey } from '../lib/batchKey';

const AcademyDataContext = createContext(null);

export function AcademyDataProvider({ children }) {
  const { academyId, isAdmin, assignedSports, assignedBatches } = useAuth();
  const [sports, setSports] = useState([]);
  const [rawBatches, setRawBatches] = useState([]);
  const [rawStudents, setRawStudents] = useState([]);
  const [rawEnrollments, setRawEnrollments] = useState([]);
  const [academy, setAcademy] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!academyId) return;
    setLoading(true);
    const [sp, bt, st, en] = await Promise.all([
      supabase.from('sports').select('*').eq('academy_id', academyId),
      supabase.from('batches').select('*').eq('academy_id', academyId),
      supabase.from('students').select('*').eq('academy_id', academyId),
      supabase.from('enrollments').select('*').eq('academy_id', academyId),
    ]);
    setSports(sp.data || []);
    setRawBatches(bt.data || []);
    setRawStudents(st.data || []);
    setRawEnrollments(en.data || []);
    setLoading(false);
  }, [academyId]);

  const refreshAcademy = useCallback(async () => {
    if (!academyId) return;
    const { data } = await supabase.from('academies').select('*').eq('id', academyId).single();
    setAcademy(data || null);
  }, [academyId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshAcademy(); }, [refreshAcademy]);

  // Merge helpers, pulled out of the realtime effect below so they have a
  // stable identity across renders and can be reused by anything that
  // already has a fresh row in hand — not just the realtime subscription.
  // A component that just did its own insert/update (see AddStudentModal)
  // can call applyStudentSave/applyEnrollmentSave to merge its own result
  // into shared state right away, instead of relying solely on the
  // websocket event to arrive (which can lag or, if realtime isn't enabled
  // for a table, RLS blocks the change feed, or the socket drops on a
  // mobile network switch/backgrounded tab, never arrive at all).
  const upsertRow = (setter) => (row) => setter(prev => {
    const idx = prev.findIndex(r => r.id === row.id);
    if (idx === -1) return [...prev, row];
    const next = prev.slice();
    next[idx] = row;
    return next;
  });
  const removeRow = (setter) => (row) => setter(prev => prev.filter(r => r.id !== row.id));
  const removeRowsByIds = (setter) => (ids) => setter(prev => prev.filter(r => !ids.includes(r.id)));

  const upsertSport = useCallback(upsertRow(setSports), []);
  const removeSport = useCallback(removeRow(setSports), []);
  const upsertBatch = useCallback(upsertRow(setRawBatches), []);
  const removeBatch = useCallback(removeRow(setRawBatches), []);
  const upsertStudent = useCallback(upsertRow(setRawStudents), []);
  const removeStudent = useCallback(removeRow(setRawStudents), []);
  const upsertEnrollment = useCallback(upsertRow(setRawEnrollments), []);
  const removeEnrollment = useCallback(removeRow(setRawEnrollments), []);
  const removeEnrollmentsByIds = useCallback(removeRowsByIds(setRawEnrollments), []);

  // Merge a just-saved student row into state immediately (add or edit).
  const applyStudentSave = useCallback((row) => { if (row) upsertStudent(row); }, [upsertStudent]);
  // Merge just-saved enrollment rows in, and drop any that were removed as
  // part of the same save (edit mode diffs enrollments against the DB).
  const applyEnrollmentSave = useCallback((rows, removedIds) => {
    if (removedIds && removedIds.length > 0) removeEnrollmentsByIds(removedIds);
    (rows || []).forEach(upsertEnrollment);
  }, [removeEnrollmentsByIds, upsertEnrollment]);

  // Realtime sync: instead of calling refresh() (which would re-fetch every
  // sport/batch/student/enrollment row on every single change from any
  // staff member — expensive with concurrent users), each event's payload
  // already carries the changed row, so we merge it directly into state.
  // One shared channel per academy covers all four tables to keep the
  // websocket connection count low. This is still the sync path for
  // picking up other users' changes — it's just no longer the *only* path
  // for a component's own save, see applyStudentSave/applyEnrollmentSave.
  useEffect(() => {
    if (!academyId) return;

    const handle = (upsertFn, removeFn) => (payload) => {
      if (payload.eventType === 'DELETE') removeFn(payload.old);
      else upsertFn(payload.new);
    };

    const channel = supabase
      .channel(`academy-data-${academyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sports', filter: `academy_id=eq.${academyId}` },
        handle(upsertSport, removeSport))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'batches', filter: `academy_id=eq.${academyId}` },
        handle(upsertBatch, removeBatch))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students', filter: `academy_id=eq.${academyId}` },
        handle(upsertStudent, removeStudent))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'enrollments', filter: `academy_id=eq.${academyId}` },
        handle(upsertEnrollment, removeEnrollment))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [academyId, upsertSport, removeSport, upsertBatch, removeBatch, upsertStudent, removeStudent, upsertEnrollment, removeEnrollment]);

  // batches.name and students.batch are stored as "Sport::BatchName" composite
  // keys (same batch label can exist under multiple sports), so derive a
  // usable `sport` + `batchLabel` on every row rather than assuming a
  // separate `sport` column exists.
  const batches = useMemo(() => rawBatches.map(b => {
    const { sport, label } = parseBatchKey(b.name);
    return { ...b, sport, batchLabel: label };
  }), [rawBatches]);

  const students = useMemo(() => {
    // Group enrollments by student so a student enrolled in several
    // sport/batch combinations carries the full list, not just the one
    // mirrored onto students.batch (the "primary" sport/batch).
    const enrollmentsByStudent = new Map();
    for (const en of rawEnrollments) {
      if (!en.sport || !en.batch) continue;
      const list = enrollmentsByStudent.get(en.student_id) || [];
      list.push({ sport: en.sport, batchLabel: en.batch, batch: buildBatchKey(en.sport, en.batch) });
      enrollmentsByStudent.set(en.student_id, list);
    }
    return rawStudents.map(s => {
      const { sport, label } = parseBatchKey(s.batch);
      const enrollments = enrollmentsByStudent.get(s.id);
      // Fall back to the single primary sport/batch for students that don't
      // have rows in `enrollments` yet (e.g. added before multi-sport support).
      return { ...s, sport, batchLabel: label, enrollments: enrollments && enrollments.length > 0 ? enrollments : [{ sport, batchLabel: label, batch: s.batch }] };
    });
  }, [rawStudents, rawEnrollments]);

  const visibleSports = useMemo(() => {
    if (isAdmin) return sports;
    return sports.filter(s => assignedSports.includes(s.name));
  }, [sports, isAdmin, assignedSports]);

  const visibleBatches = useMemo(() => {
    if (isAdmin) return batches;
    return batches.filter(b => assignedBatches.includes(b.name)); // b.name is the full composite key
  }, [batches, isAdmin, assignedBatches]);

  const visibleStudents = useMemo(() => {
    if (isAdmin) return students;
    const sportSet = new Set(assignedSports);
    const batchSet = new Set(assignedBatches);
    return students.filter(s => s.enrollments.some(en => sportSet.has(en.sport) || batchSet.has(en.batch)));
  }, [students, isAdmin, assignedSports, assignedBatches]);

  const value = {
    sports, batches, students, loading, refresh,
    visibleSports, visibleBatches, visibleStudents,
    academy, refreshAcademy,
    applyStudentSave, applyEnrollmentSave,
  };

  return <AcademyDataContext.Provider value={value}>{children}</AcademyDataContext.Provider>;
}

export function useAcademyData() {
  const ctx = useContext(AcademyDataContext);
  if (!ctx) throw new Error('useAcademyData must be used within AcademyDataProvider');
  return ctx;
}
