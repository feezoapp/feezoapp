import { useEffect, useMemo, useRef, useState } from 'react';
import { useAcademyData } from '../context/AcademyDataContext';
import { useAuth } from '../context/AuthContext';
import { usePlan } from '../context/PlanContext';
import { supabase } from '../lib/supabaseClient';
import { exportGenericPdf, exportGenericXlsx } from '../lib/exporters';
import ImportAttendanceModal from '../components/ImportAttendanceModal';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SORT_OPTIONS = [
  { v: 'roll_asc', l: 'Roll No ↑' },
  { v: 'roll_desc', l: 'Roll No ↓' },
  { v: 'name_az', l: 'Name A→Z' },
  { v: 'name_za', l: 'Name Z→A' },
  { v: 'present_first', l: '✅ Present first' },
  { v: 'absent_first', l: '❌ Absent first' },
  { v: 'unmarked_first', l: '⏳ Unmarked first' },
];

const STATUS_OPTIONS = [
  { v: 'all', l: 'All' },
  { v: 'present', l: 'Present' },
  { v: 'absent', l: 'Absent' },
];

// IMPORTANT: build the YYYY-MM-DD string from local date parts, never via
// toISOString() — that converts to UTC first, which silently shifts the
// date by a day for any timezone ahead of UTC (e.g. IST) and is what made
// the ‹ › navigation arrows appear broken.
const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => toIso(new Date());
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Supabase/PostgREST caps any single .select() at 1000 rows by default.
// Year (and, for a busy academy, even Month) view can easily have more
// attendance rows than that in range, so a plain query silently truncates —
// this was confirmed to undercount real months' P/A totals. Page through
// in 1000-row chunks instead of trusting one request to return everything.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// A student can now hold multiple enrollments (same or different sports) —
// attendance is tracked per enrollment, not per student, so every state map
// below is keyed by this composite key rather than bare student_id.
// Trimmed + lowercased so a stray space or casing drift between what's
// stored on an old attendance row and the student's *current* enrollment
// text (e.g. a renamed batch) doesn't silently break the lookup — this was
// causing month view (which matches per sport+batch) to show 0P/0A while
// year view (which only matches by student_id) still showed real totals.
const norm = (v) => (v || '').toString().trim().toLowerCase();
const keyFor = (studentId, sport, batchLabel) => `${studentId}::${norm(sport)}::${norm(batchLabel)}`;

// Key for dayStatusMap (register-closed lookups), independent of student.
// '*' is the batch value used for rows written before attendance_day_status
// had a `batch` column — those closes covered every batch of that sport, so
// they're checked as a fallback anywhere a specific batch key is missed.
const dsKey = (sport, batch) => `${norm(sport)}::${norm(batch)}`;

// A student shouldn't appear (or be markable/bulk-markable) for any date
// before they actually joined — matches the enrolledBy check FeesTab uses,
// so a student excluded from a month's fee list because of their join_date
// is excluded from that same period here too, instead of showing up in
// Attendance but silently vanishing from Fees.
const isEnrolledByRef = (joinDate, refDateIso) => !joinDate || joinDate <= refDateIso;

// A banned student still keeps their attendance history for periods before
// they were banned — same principle as an ended enrollment still showing its
// old sport/batch for the days it was active (enrollmentOverlapsPeriod
// below). This only tells you whether a REFERENCE date/period-start falls
// on or after the ban, not whether every day in a range is post-ban — so a
// period straddling the ban date still surfaces the pre-ban days.
const bannedByRef = (s, refDateIso) => !!s.banned && (!s.banned_on || s.banned_on <= refDateIso);

// An enrollment counts for a single date if it had started by then and,
// if it's since ended, hadn't ended yet.
const enrollmentActiveOn = (en, dateIso) =>
  (!en.join_date || en.join_date <= dateIso) && (!en.left_date || en.left_date >= dateIso);

// An enrollment counts for a period [from, to] if it was active for any
// part of it — so an already-ended enrollment still surfaces its old
// sport/batch (and the attendance recorded against it) in Month/Year
// views covering when it was actually active, instead of disappearing
// the moment it's superseded by a newer enrollment.
const enrollmentOverlapsPeriod = (en, fromIso, toIso) =>
  (!en.join_date || en.join_date <= toIso) && (!en.left_date || en.left_date >= fromIso);

function RollBadge({ rollNo }) {
  return (
    <div style={{
      minWidth: 30, height: 30, padding: '0 4px', borderRadius: '50%',
      background: 'var(--accent2, #4a6cf7)', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: rollNo && String(rollNo).length > 2 ? 10 : 12, fontWeight: 800, flexShrink: 0,
    }}>
      {rollNo || '—'}
    </div>
  );
}

// Same centered popup used by StudentsTab's Program/Sport/Sort filters —
// a dark overlay + a card of radio rows, closing itself on selection.
function FilterPopup({ title, onClose, children }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: 12, padding: 14, width: '85%', maxWidth: 320, maxHeight: '70vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--gray)', cursor: 'pointer' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RadioRow({ name, checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '7px 2px', cursor: 'pointer' }}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

export default function AttendanceTab() {
  const { visibleStudents, visibleSports, visibleBatches, refresh } = useAcademyData();
  const { isAdmin, academyId, user, appUser, canExport } = useAuth();
  const { hasFeature, cheapestPlanWithFeature } = usePlan();
  // Matches the `marked_by` text column in Supabase — real name lives on
  // appUser (the app_users row), not the raw Supabase auth `user`.
  const markedBy = appUser?.name || user?.email || (isAdmin ? 'Admin' : 'Staff');

  const [date, setDate] = useState(todayStr());
  const [viewMode, setViewMode] = useState('day'); // 'day' | 'month' | 'year'
  const [panelOpen, setPanelOpen] = useState(false); // date picker sub-panel: collapsed by default
  const [search, setSearch] = useState('');
  const [sportFilter, setSportFilter] = useState('');
  const [batchFilter, setBatchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'present' | 'absent' — day view only
  const [sortBy, setSortBy] = useState('roll_asc');
  const [popup, setPopup] = useState(null); // 'sport' | 'batch' | 'status' | 'sort' | 'day' | 'month' | 'year' | null
  const [records, setRecords] = useState({}); // student_id -> 'P' | 'A'  (day mode only, matches db status codes)
  const [lateMap, setLateMap] = useState({}); // student_id -> bool, marked Present after that sport's register closed
  const [periodRows, setPeriodRows] = useState({}); // student_id -> { present, absent }  (month mode)
  const [yearSummary, setYearSummary] = useState({}); // monthIndex(0-11) -> { days:Set<string>, p, a }  (year mode)
  const [dayStatusMap, setDayStatusMap] = useState({}); // sport -> completed bool, for the selected date
  const [completing, setCompleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showScrollArrow, setShowScrollArrow] = useState(false);
  const listScrollRef = useRef(null);
  // Tracks which date `dayStatusMap` was last built for, so a same-date
  // refetch can only ever ADD a confirmed-closed sport, never remove one —
  // closing a register is one-way, so a flaky read should never silently
  // reopen it. Switching to a different date still resets it properly.
  const dayStatusDateRef = useRef(date);

  const dateObj = new Date(date + 'T00:00:00');
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  const day = dateObj.getDate();
  const isFutureDate = date > todayStr();

  const setDay = (d) => setDate(toIso(new Date(year, month, d)));
  const setMonth = (m) => setDate(toIso(new Date(year, m, Math.min(day, daysInMonth(year, m)))));
  const setYear = (y) => setDate(toIso(new Date(y, month, Math.min(day, daysInMonth(y, month)))));
  const shiftDay = (delta) => setDate(toIso(new Date(year, month, day + delta)));
  const shiftMonth = (delta) => setDate(toIso(new Date(year, month + delta, Math.min(day, daysInMonth(year, month + delta)))));
  const shiftYear = (delta) => setYear(year + delta);

  // The reference date range a student's enrollment history is checked
  // against — the period currently being viewed. Day view uses a single
  // date; Month/Year view use the full [start, end] range, so an
  // enrollment that was active for only PART of the period (e.g. a student
  // switched sport/batch mid-month) still surfaces its old sport/batch —
  // and the attendance recorded against it — for that period, instead of
  // disappearing the moment it's superseded by a newer enrollment.
  const periodStart = useMemo(() => {
    if (viewMode === 'day') return date;
    if (viewMode === 'month') return toIso(new Date(year, month, 1));
    return toIso(new Date(year, 0, 1));
  }, [viewMode, date, year, month]);

  const periodEnd = useMemo(() => {
    if (viewMode === 'day') return date;
    if (viewMode === 'month') return toIso(new Date(year, month + 1, 0));
    return toIso(new Date(year, 11, 31));
  }, [viewMode, date, year, month]);

  const students = useMemo(() => {
    // Built from each student's full enrollment HISTORY (not just the
    // currently-active enrollment), keeping any enrollment that overlapped
    // the period being viewed. This is what makes Month/Year view still
    // show a student's old sport/batch (and its attendance) for the
    // period they were actually in it, even after they've since switched
    // to a different sport/batch.
    const rows = [];
    visibleStudents.forEach(s => {
      if (!isEnrolledByRef(s.join_date, periodEnd)) return;
      if (bannedByRef(s, periodStart)) return;
      const history = (s.enrollmentHistory && s.enrollmentHistory.length > 0)
        ? s.enrollmentHistory
        : [{ sport: s.sport, batchLabel: s.batchLabel, join_date: s.join_date, left_date: null }];
      const seen = new Set();
      history.forEach(en => {
        if (!en.sport) return;
        if (!enrollmentOverlapsPeriod(en, periodStart, periodEnd)) return;
        const key = keyFor(s.id, en.sport, en.batchLabel);
        if (seen.has(key)) return; // rejoined the same sport/batch twice — one row is enough
        seen.add(key);
        rows.push({ student: s, sport: en.sport, batchLabel: en.batchLabel, key });
      });
    });
    let list = rows.filter(r => {
      if (sportFilter && r.sport !== sportFilter) return false;
      if (batchFilter && r.batchLabel !== batchFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(r.student.name?.toLowerCase().includes(q) || r.student.roll_no?.toLowerCase?.().includes(q))) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'roll_desc': return (b.student.roll_no || '').localeCompare(a.student.roll_no || '');
        case 'name_az': return (a.student.name || '').localeCompare(b.student.name || '');
        case 'name_za': return (b.student.name || '').localeCompare(a.student.name || '');
        default: return (a.student.roll_no || '').localeCompare(b.student.roll_no || '');
      }
    });
    return list;
  }, [visibleStudents, sportFilter, batchFilter, search, sortBy, periodStart, periodEnd]);

  // "Mark All" and the P/A summary counts intentionally ignore the search box —
  // they operate on the full sport+batch scoped roster, matching the HTML app.
  const bulkTargets = useMemo(() => {
    const rows = [];
    visibleStudents.forEach(s => {
      if (!isEnrolledByRef(s.join_date, date)) return;
      if (bannedByRef(s, date)) return;
      const history = (s.enrollmentHistory && s.enrollmentHistory.length > 0)
        ? s.enrollmentHistory
        : [{ sport: s.sport, batchLabel: s.batchLabel, join_date: s.join_date, left_date: null }];
      const seen = new Set();
      history.forEach(en => {
        if (!en.sport) return;
        if (!enrollmentActiveOn(en, date)) return;
        if (sportFilter && en.sport !== sportFilter) return;
        if (batchFilter && en.batchLabel !== batchFilter) return;
        const key = keyFor(s.id, en.sport, en.batchLabel);
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ student: s, sport: en.sport, batchLabel: en.batchLabel, key });
      });
    });
    return rows;
  }, [visibleStudents, sportFilter, batchFilter, date]);

  // Day-view-only re-sort (present/absent first) and status filter — applied on
  // top of `students` since both depend on the fetched records for the date.
  const dayStudents = useMemo(() => {
    if (viewMode !== 'day') return students;
    let list = students;
    if (sortBy === 'present_first' || sortBy === 'absent_first' || sortBy === 'unmarked_first') {
      const rank = (r) => {
        const v = records[r.key];
        if (sortBy === 'present_first') return v === 'P' ? 0 : v === 'A' ? 2 : 1;
        if (sortBy === 'absent_first') return v === 'A' ? 0 : v === 'P' ? 2 : 1;
        return v ? 1 : 0; // unmarked_first: unmarked → marked
      };
      list = [...list].sort((a, b) => rank(a) - rank(b) || (a.student.roll_no || '').localeCompare(b.student.roll_no || ''));
    }
    if (statusFilter !== 'all') {
      list = list.filter(r => (statusFilter === 'present' ? records[r.key] === 'P' : records[r.key] === 'A'));
    }
    return list;
  }, [viewMode, students, sortBy, statusFilter, records]);

  const batchesForSport = visibleBatches.filter(b => !sportFilter || b.sport === sportFilter);

  // A day only counts as a "class day" if someone was actually marked. Shown as
  // a 🏖️ holiday badge otherwise. Scoped by sportFilter only (not batch/search),
  // matching the HTML app's isClassDay check.
  const classDayRows = useMemo(() => {
    return sportFilter ? bulkTargets.filter(r => r.sport === sportFilter) : bulkTargets;
  }, [bulkTargets, sportFilter]);
  const classDay = useMemo(() => {
    const keys = new Set(classDayRows.map(r => r.key));
    return Object.keys(records).some(k => keys.has(k) && (records[k] === 'P' || records[k] === 'A'));
  }, [records, classDayRows]);

  // Best-effort activity log, matching the columns admin/ActivityPage.jsx
  // actually reads (actor_name, then action || description). Written to both
  // action and description so it shows up regardless of which one it prefers.
  // Never blocks the UI if the insert fails.
  // Best-effort activity log. `audit_log` only has the legacy columns —
  // user_id, role, action, detail — no actor_id/actor_name/description.
  const logAttendance = async (message) => {
    try {
      const { error } = await supabase.from('audit_log').insert({
        academy_id: academyId,
        user_id: markedBy,
        role: isAdmin ? 'admin' : 'staff',
        action: message,
        detail: message,
      });
      if (error) console.error('audit_log insert failed (attendance):', error);
    } catch (e) { console.error('audit_log insert threw (attendance):', e); }
  };

  // ---- Fetch attendance for the current view ----
  useEffect(() => {
    (async () => {
      if (!academyId) return;
      setLoading(true);
      try {
      if (viewMode === 'day') {
        const { data } = await supabase.from('attendance').select('*')
          .eq('academy_id', academyId).eq('date', date);
        const map = {};
        const late = {};
        (data || []).forEach(r => {
          const k = keyFor(r.student_id, r.sport, r.batch);
          map[k] = r.status; late[k] = !!r.is_latecomer;
        });
        setRecords(map);
        setLateMap(late);

        // Optional table, scoped per (academy, date, sport) — requires a `sport`
        // text column and a unique constraint on (academy_id, date, sport).
        // Falls back to a single whole-day flag (applies to every sport) if
        // that column hasn't been migrated in yet — matches the write-side
        // fallback in markAllDone, so close-state stays consistent either way.
        // Merged (never downgraded) against the previous same-date state —
        // closing a register is one-way, so a flaky read must never silently
        // reopen one we already confirmed closed locally.
        const applyDayStatus = (dmap) => {
          const isNewDate = dayStatusDateRef.current !== date;
          dayStatusDateRef.current = date;
          setDayStatusMap(prev => {
            const base = isNewDate ? {} : prev;
            const merged = { ...base };
            Object.keys(dmap).forEach(k => { merged[k] = merged[k] || dmap[k]; });
            return merged;
          });
        };
        try {
          const { data: statusRows, error: statusErr } = await supabase.from('attendance_day_status')
            .select('sport,batch,completed').eq('academy_id', academyId).eq('date', date);
          if (statusErr) throw statusErr;
          const dmap = {};
          (statusRows || []).forEach(r => { dmap[dsKey(r.sport, r.batch || '*')] = !!r.completed; });
          applyDayStatus(dmap);
        } catch {
          try {
            // `batch` column not migrated in yet — fall back to sport-only
            // granularity (pre-batch-lock behavior) via the '*' sentinel.
            const { data: sportRows, error: sportErr } = await supabase.from('attendance_day_status')
              .select('sport,completed').eq('academy_id', academyId).eq('date', date);
            if (sportErr) throw sportErr;
            const dmap = {};
            (sportRows || []).forEach(r => { dmap[dsKey(r.sport, '*')] = !!r.completed; });
            applyDayStatus(dmap);
          } catch {
            try {
              const { data: legacyRows } = await supabase.from('attendance_day_status')
                .select('completed').eq('academy_id', academyId).eq('date', date);
              const wholeDayDone = (legacyRows || []).some(r => r.completed);
              const dmap = {};
              if (wholeDayDone) visibleSports.forEach(sp => { dmap[dsKey(sp.name, '*')] = true; });
              applyDayStatus(dmap);
            } catch {
              applyDayStatus({});
            }
          }
        }
      } else if (viewMode === 'month') {
        const from = toIso(new Date(year, month, 1));
        const to = toIso(new Date(year, month + 1, 0));
        const buildMonthQuery = () => {
          let q = supabase.from('attendance').select('student_id,sport,batch,status')
            .eq('academy_id', academyId).gte('date', from).lte('date', to);
          if (sportFilter) q = q.eq('sport', sportFilter);
          if (sportFilter && batchFilter) q = q.eq('batch', batchFilter);
          return q;
        };
        const data = await fetchAllRows(buildMonthQuery);
        const agg = {};
        (data || []).forEach(r => {
          const k = keyFor(r.student_id, r.sport, r.batch);
          if (!agg[k]) agg[k] = { present: 0, absent: 0 };
          if (r.status === 'P') agg[k].present++;
          else if (r.status === 'A') agg[k].absent++;
        });
        setPeriodRows(agg);
      } else {
        // Year view — monthly breakdown (class days + P/A totals), scoped to the
        // currently filtered roster, matching the HTML app's year view. When no
        // sport/batch filter is set this totals across ALL of a student's
        // enrollments (not split per-enrollment) — the year view only ever
        // showed monthly totals, not a per-enrollment breakdown.
        const from = toIso(new Date(year, 0, 1));
        const to = toIso(new Date(year, 11, 31));
        const buildYearQuery = () => {
          let q = supabase.from('attendance').select('date,student_id,status')
            .eq('academy_id', academyId).gte('date', from).lte('date', to);
          if (sportFilter) q = q.eq('sport', sportFilter);
          if (sportFilter && batchFilter) q = q.eq('batch', batchFilter);
          return q;
        };
        const data = await fetchAllRows(buildYearQuery);
        const idSet = new Set(students.map(r => r.student.id));
        const byMonth = {};
        for (let i = 0; i < 12; i++) byMonth[i] = { days: new Set(), p: 0, a: 0 };
        (data || []).forEach(r => {
          if (!idSet.has(r.student_id)) return;
          const mo = parseInt(r.date.slice(5, 7), 10) - 1;
          if (!byMonth[mo]) return;
          byMonth[mo].days.add(r.date);
          if (r.status === 'P') byMonth[mo].p++;
          else if (r.status === 'A') byMonth[mo].a++;
        });
        setYearSummary(byMonth);
      }
      } catch (err) {
        console.error('Attendance fetch failed:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [academyId, date, viewMode, year, month, reloadKey, students, visibleSports]);

  // ---- Realtime sync ----
  // AcademyDataContext already keeps sports/batches/students/enrollments live;
  // `attendance` and `attendance_day_status` aren't loaded there (they're
  // view-scoped — day/month/year — so a bare upsert-into-context wouldn't
  // know which aggregate to update). Instead: for the day view, merge each
  // changed attendance row directly into `records`/`lateMap` (cheap, matches
  // what's already on screen). For month/year, a single row only ever moves
  // one cell of a pre-computed aggregate, so it's simpler and still cheap to
  // debounce a re-fetch via the existing effect above (bumping `reloadKey`)
  // rather than duplicate its aggregation logic here.
  const reloadDebounceRef = useRef(null);
  const scheduleReload = () => {
    clearTimeout(reloadDebounceRef.current);
    reloadDebounceRef.current = setTimeout(() => setReloadKey(k => k + 1), 400);
  };

  // `visibleSports` is a derived array from AcademyDataContext and gets a new
  // reference on renders even when its contents haven't changed. It used to
  // sit in the channel effect's dependency array below, which meant this
  // effect — and the channel it opens — was tearing down and rebuilding on
  // nearly every render, never giving the subscription a stable window to
  // actually receive events. Read the latest value through a ref instead so
  // the closure inside the handler stays fresh without forcing a resubscribe.
  const visibleSportsRef = useRef(visibleSports);
  useEffect(() => { visibleSportsRef.current = visibleSports; }, [visibleSports]);

  useEffect(() => {
    if (!academyId) return;

    const channel = supabase
      .channel(`attendance-${academyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance', filter: `academy_id=eq.${academyId}` },
        (payload) => {
          const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
          if (!row) return;
          if (viewMode !== 'day') { scheduleReload(); return; }
          if (row.date !== date) return; // different day being viewed — nothing on screen changes
          const k = keyFor(row.student_id, row.sport, row.batch);
          if (payload.eventType === 'DELETE') {
            setRecords(prev => { const next = { ...prev }; delete next[k]; return next; });
            setLateMap(prev => { const next = { ...prev }; delete next[k]; return next; });
          } else {
            setRecords(prev => ({ ...prev, [k]: row.status }));
            setLateMap(prev => ({ ...prev, [k]: !!row.is_latecomer }));
          }
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_day_status', filter: `academy_id=eq.${academyId}` },
        (payload) => {
          if (viewMode !== 'day') return;
          // DELETE = an admin unlock (see unlockRegister). This is the one
          // case allowed to remove a lock rather than only ever adding one.
          if (payload.eventType === 'DELETE') {
            const row = payload.old;
            if (!row || row.date !== date || !row.sport) return;
            setDayStatusMap(m => {
              const next = { ...m };
              delete next[dsKey(row.sport, row.batch || '*')];
              return next;
            });
            return;
          }
          const row = payload.new;
          if (!row || row.date !== date) return;
          // Closing is otherwise one-way, so it's safe to only ever flip
          // these true — matches the merge-never-downgrades rule used for
          // the initial fetch above.
          if (row.sport && row.batch) {
            setDayStatusMap(m => (m[dsKey(row.sport, row.batch)] ? m : { ...m, [dsKey(row.sport, row.batch)]: !!row.completed }));
          } else if (row.sport) {
            setDayStatusMap(m => (m[dsKey(row.sport, '*')] ? m : { ...m, [dsKey(row.sport, '*')]: !!row.completed }));
          } else if (row.completed) {
            setDayStatusMap(m => {
              const merged = { ...m };
              visibleSportsRef.current.forEach(sp => { merged[dsKey(sp.name, '*')] = true; });
              return merged;
            });
          }
        })
      .subscribe();

    return () => { clearTimeout(reloadDebounceRef.current); supabase.removeChannel(channel); };
  }, [academyId, date, viewMode]);

  // Tapping P/A. Behavior depends on whether that student's sport register is
  // closed for the day (dayStatusMap[sport]):
  //  - Open register: normal mark / change (with confirm) / clear (tap again).
  //  - Closed register: existing marks are locked, EXCEPT a latecomer Present
  //    mark can still be flipped to Absent. Unmarked students can still be
  //    marked — Absent normally, or Present as a flagged "latecomer".
  // Closed if this exact sport+batch was closed, OR if a legacy (pre-batch)
  // whole-sport close covers it via the '*' sentinel.
  const isRegisterClosed = (sport, batch) => !!dayStatusMap[dsKey(sport, batch)] || !!dayStatusMap[dsKey(sport, '*')];

  const setStatus = (row, status) => {
    if (isFutureDate) { window.alert('Cannot mark attendance for future dates.'); return; }
    const sp = row.sport;
    const done = isRegisterClosed(sp, row.batchLabel);
    const existing = records[row.key];
    const isLate = !!lateMap[row.key];
    const student = row.student;

    if (done) {
      if (existing === 'A') {
        if (status === 'A') return; // already absent, no-op
        const ok = window.confirm(`Register is closed. Change ${student.name} from Absent → latecomer Present?`);
        if (!ok) return;
        applyStatus(row, 'P', true);
        logAttendance(`${student.name} → latecomer Present from Absent (${sp}) on ${date}`);
        return;
      }
      if (existing === 'P' && !isLate) { window.alert('Register is closed for this day — already marked, cannot change.'); return; }
      if (existing === 'P' && isLate && status === 'A') {
        const ok = window.confirm(`Change ${student.name} from Latecomer → Absent (${sp}) on ${date}?`);
        if (!ok) return;
        applyStatus(row, 'A', false);
        logAttendance(`${student.name} → Absent from latecomer (${sp}) on ${date}`);
        return;
      }
      if (existing === 'P' && isLate && status === 'P') return; // already marked, no-op
      // unmarked student, register closed
      if (status === 'A') {
        const ok = window.confirm(`Mark ${student.name} as Absent (${sp}) on ${date}?`);
        if (!ok) return;
        applyStatus(row, 'A', false);
        logAttendance(`${student.name} → Absent (${sp}) on ${date} [register closed]`);
        return;
      }
      const ok = window.confirm(`Register is closed. Mark ${student.name} as a latecomer (Present)?`);
      if (!ok) return;
      applyStatus(row, 'P', true);
      logAttendance(`${student.name} → latecomer Present (${sp}) on ${date}`);
      return;
    }

    // Register still open — normal flow
    if (existing === status) return; // tapping the same mark again is a no-op, not a clear
    if (existing) {
      const label = (v) => (v === 'P' ? 'Present' : 'Absent');
      const ok = window.confirm(`Change ${student.name}'s attendance from ${label(existing)} to ${label(status)}?`);
      if (!ok) return;
    }
    applyStatus(row, status, false);
    logAttendance(`${student.name} → ${status === 'P' ? 'Present' : 'Absent'} (${sp}) on ${date}`);
  };

  const applyStatus = (row, status, isLate) => {
    setRecords(p => ({ ...p, [row.key]: status }));
    setLateMap(p => ({ ...p, [row.key]: !!isLate }));
    persistStatus(row, status, isLate);
  };

  // True once we learn (from a failed request) that `is_latecomer` doesn't
  // exist yet in Supabase — avoids retrying every single call for nothing.
  const missingLatecomerCol = useRef(false);

  // Writes a single enrollment's mark straight to Supabase so nothing depends
  // on a separate "Save" step. Uses the `is_latecomer` boolean column on
  // `attendance` when available, and transparently falls back to writing
  // without it if that column hasn't been migrated in yet — so marking never
  // breaks, it just can't flag latecomers until the column exists.
  const persistStatus = async (row, status, isLate) => {
    const dbRow = { academy_id: academyId, student_id: row.student.id, date, status, sport: row.sport, batch: row.batchLabel, marked_by: markedBy };
    if (!missingLatecomerCol.current) dbRow.is_latecomer = !!isLate;
    try {
      const { error } = await supabase.from('attendance').upsert(dbRow, { onConflict: 'academy_id,student_id,date,sport,batch' });
      if (error) throw error;
    } catch (err) {
      if (!missingLatecomerCol.current && /is_latecomer/i.test(err.message || '')) {
        missingLatecomerCol.current = true;
        return persistStatus(row, status, isLate); // retry once, without the column
      }
      window.alert(`Couldn't save ${row.student.name}'s attendance: ${err.message}`);
    }
  };

  const allPChecked = bulkTargets.length > 0 && bulkTargets.every(r => records[r.key] === 'P');
  const allAChecked = bulkTargets.length > 0 && bulkTargets.every(r => records[r.key] === 'A');

  const markAll = async (status) => {
    if (isFutureDate) { window.alert('Cannot mark attendance for future dates.'); return; }
    if (!sportFilter || !batchFilter) { window.alert('Pick a specific sport and batch above to use Mark All.'); return; }
    const targets = bulkTargets;
    if (!targets.length) return;
    const label = status === 'P' ? 'Present' : 'Absent';
    const alreadyAll = targets.every(r => records[r.key] === status);

    if (!alreadyAll) {
      const ok = window.confirm(`Mark all ${targets.length} ${sportFilter} student(s) as ${label} on ${date}?`);
      if (!ok) return;
      setRecords(prev => { const next = { ...prev }; targets.forEach(r => { next[r.key] = status; }); return next; });
      setLateMap(prev => { const next = { ...prev }; targets.forEach(r => { next[r.key] = false; }); return next; });
      const makeRows = () => targets.map(r => {
        const row = { academy_id: academyId, student_id: r.student.id, date, status, sport: r.sport, batch: r.batchLabel, marked_by: markedBy };
        if (!missingLatecomerCol.current) row.is_latecomer = false;
        return row;
      });
      let { error } = await supabase.from('attendance').upsert(makeRows(), { onConflict: 'academy_id,student_id,date,sport,batch' });
      if (error && !missingLatecomerCol.current && /is_latecomer/i.test(error.message || '')) {
        missingLatecomerCol.current = true;
        ({ error } = await supabase.from('attendance').upsert(makeRows(), { onConflict: 'academy_id,student_id,date,sport,batch' }));
      }
      if (error) { window.alert(`Couldn't save attendance: ${error.message}`); return; }
      logAttendance(`All ${sportFilter} students → ${label} on ${date}`);
    } else {
      const ok = window.confirm(`Remove ${label} mark for all ${sportFilter} students on ${date}?`);
      if (!ok) return;
      const clearedKeys = targets.map(r => r.key);
      setRecords(prev => { const next = { ...prev }; clearedKeys.forEach(k => { delete next[k]; }); return next; });
      // Deleted per-row (not a single bulk .in) since a student may have
      // another untouched enrollment on the same date that must survive.
      for (const r of targets) {
        const { error } = await supabase.from('attendance').delete()
          .eq('academy_id', academyId).eq('date', date).eq('student_id', r.student.id).eq('sport', r.sport).eq('batch', r.batchLabel);
        if (error) { window.alert(`Couldn't clear attendance for ${r.student.name}: ${error.message}`); return; }
      }
      logAttendance(`All ${label} cleared for ${sportFilter} on ${date}`);
    }
  };

  const dayCompleted = (sportFilter && batchFilter) ? isRegisterClosed(sportFilter, batchFilter) : false;

  const markAllDone = async () => {
    if (!sportFilter || !batchFilter) { window.alert('Pick a specific sport and batch above to close its register.'); return; }
    if (!students.length || dayCompleted || isFutureDate) return;
    const ok = window.confirm(
      `Close the ${sportFilter} / ${batchFilter} attendance register for ${date}?\n\nMarked students will be locked. Anyone marked Present afterward will be flagged as a latecomer. An admin can reopen it later if needed.`
    );
    if (!ok) return;
    setCompleting(true);
    try {
      let { error } = await supabase.from('attendance_day_status').upsert(
        { academy_id: academyId, date, sport: sportFilter, batch: batchFilter, completed: true, completed_at: new Date().toISOString() },
        { onConflict: 'academy_id,date,sport,batch' }
      );
      if (error && /batch|onConflict|constraint/i.test(error.message || '')) {
        // `batch` column/constraint not migrated in yet — fall back to the
        // older sport-only lock (still correct, just coarser-grained).
        ({ error } = await supabase.from('attendance_day_status').upsert(
          { academy_id: academyId, date, sport: sportFilter, completed: true, completed_at: new Date().toISOString() },
          { onConflict: 'academy_id,date,sport' }
        ));
      }
      if (error && /sport|onConflict|constraint/i.test(error.message || '')) {
        // Falls back further to the original whole-day lock if even the
        // sport column/constraint isn't there yet.
        ({ error } = await supabase.from('attendance_day_status').upsert(
          { academy_id: academyId, date, completed: true, completed_at: new Date().toISOString() },
          { onConflict: 'academy_id,date' }
        ));
      }
      if (error) throw error;
    } catch (err) {
      window.alert(`Couldn't close the register: ${err.message}`);
      setCompleting(false);
      return;
    }
    setDayStatusMap(m => ({ ...m, [dsKey(sportFilter, batchFilter)]: true }));
    setCompleting(false);
    logAttendance(`Register closed (${sportFilter} / ${batchFilter}) for ${date}`);
    setReloadKey(k => k + 1);
  };

  // Admin-only: reopen a closed register. Requires a reason, which is written
  // to attendance_register_unlocks for the audit trail before the lock itself
  // is removed. Deletes rather than flips `completed` back to false, so a
  // re-close later is a clean upsert and there's no stray "reopened" row
  // shape to special-case elsewhere.
  const [unlocking, setUnlocking] = useState(false);
  const unlockRegister = async () => {
    if (!isAdmin || !sportFilter || !batchFilter || !dayCompleted) return;
    const reason = window.prompt(
      `Reason for reopening ${sportFilter} / ${batchFilter} on ${date}?\n(required — this is logged in the audit trail)`
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) { window.alert('A reason is required to reopen the register.'); return; }
    setUnlocking(true);
    try {
      const { error: delErr } = await supabase.from('attendance_day_status').delete()
        .eq('academy_id', academyId).eq('date', date).eq('sport', sportFilter).eq('batch', batchFilter);
      if (delErr) throw delErr;
      const { error: logErr } = await supabase.from('attendance_register_unlocks').insert({
        academy_id: academyId, date, sport: sportFilter, batch: batchFilter,
        unlocked_by_id: appUser?.id || user?.id || null,
        unlocked_by_name: markedBy,
        reason: reason.trim(),
      });
      // A failed audit-log insert shouldn't trap the register in a closed
      // state that the delete above already opened — surface it, don't revert.
      if (logErr) console.error('Unlock audit log failed:', logErr);
    } catch (err) {
      window.alert(`Couldn't reopen the register: ${err.message}`);
      setUnlocking(false);
      return;
    }
    setDayStatusMap(m => {
      const next = { ...m };
      delete next[dsKey(sportFilter, batchFilter)];
      return next;
    });
    setUnlocking(false);
    logAttendance(`Register reopened (${sportFilter} / ${batchFilter}) for ${date} — reason: ${reason.trim()}`);
    setReloadKey(k => k + 1);
  };

  const presentCount = students.filter(r => records[r.key] === 'P').length;
  const absentCount = students.filter(r => records[r.key] === 'A').length;
  const notMarkedCount = students.length - presentCount - absentCount;

  const dateLabel = `${day} ${WEEKDAYS[dateObj.getDay()]}, ${MONTHS[month]} ${year}`;

  // ---- Export ----
  // exportGenericPdf(title, columns, rows[][], filename) and
  // exportGenericXlsx(rowObjects[], filename, sheetName) — real signatures
  // from src/lib/exporters.js (xlsx needs objects, not parallel arrays).
  const doExport = (kind) => {
    if (viewMode === 'day') {
      const columns = ['Roll No', 'Name', 'Sport', 'Batch', 'Status'];
      const rowObjs = students.map(r => ({
        'Roll No': r.student.roll_no, Name: r.student.name, Sport: r.sport, Batch: r.batchLabel,
        Status: records[r.key] === 'P' ? (lateMap[r.key] ? 'Present (Late)' : 'Present') : records[r.key] === 'A' ? 'Absent' : 'Not Marked',
      }));
      const title = `Attendance — ${dateLabel}`;
      const fname = `attendance_${date}`;
      if (kind === 'pdf') exportGenericPdf(title, columns, rowObjs.map(Object.values), `${fname}.pdf`);
      else exportGenericXlsx(rowObjs, `${fname}.xlsx`, 'Attendance');
    } else if (viewMode === 'month') {
      const columns = ['Roll No', 'Name', 'Sport', 'Batch', 'Present', 'Absent', '%'];
      const rowObjs = students.map(r => {
        const agg = periodRows[r.key] || { present: 0, absent: 0 };
        const total = agg.present + agg.absent;
        const pct = total ? Math.round((agg.present / total) * 100) : 0;
        return { 'Roll No': r.student.roll_no, Name: r.student.name, Sport: r.sport, Batch: r.batchLabel, Present: agg.present, Absent: agg.absent, '%': `${pct}%` };
      });
      const title = `Attendance Summary — ${MONTHS[month]} ${year}`;
      const fname = `attendance_${year}-${String(month + 1).padStart(2, '0')}`;
      if (kind === 'pdf') exportGenericPdf(title, columns, rowObjs.map(Object.values), `${fname}.pdf`);
      else exportGenericXlsx(rowObjs, `${fname}.xlsx`, 'Attendance');
    } else {
      const columns = ['Month', 'Class Days', 'Present', 'Absent'];
      const rowObjs = MONTHS
        .map((mLabel, i) => {
          const row = yearSummary[i] || { days: new Set(), p: 0, a: 0 };
          return { Month: mLabel, 'Class Days': row.days.size, Present: row.p, Absent: row.a };
        })
        .filter(r => r['Class Days'] > 0);
      const title = `Attendance Summary — ${year}`;
      const fname = `attendance_${year}`;
      if (kind === 'pdf') exportGenericPdf(title, columns, rowObjs.map(Object.values), `${fname}.pdf`);
      else exportGenericXlsx(rowObjs, `${fname}.xlsx`, 'Attendance');
    }
  };


  // ---- Scroll-driven show/hide of the sport/batch/status/sort row only —
  // the search box, date card, and summary row stay put, matching the HTML app. ----
  const updateScrollArrow = (el) => {
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight > 8;
    // Generous tolerance (~one row) so the arrow reliably disappears before
    // the last item — it was staying visible a few px short of true bottom
    // on real devices and physically blocking taps on whatever sits there
    // (e.g. the Done button), since it's a fixed-position overlay.
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    setShowScrollArrow(scrollable && !atBottom);
  };

  const handleScroll = (e) => {
    const el = e.currentTarget;
    updateScrollArrow(el);
  };

  // Re-check arrow visibility whenever the rendered content changes size
  // (view switch, data load, filtering) — not just on manual scroll.
  useEffect(() => {
    updateScrollArrow(listScrollRef.current);
  }, [dayStudents, periodRows, yearSummary, loading, viewMode]);

  const scrollToBottom = () => {
    const el = listScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' }); // instant, not smooth
  };

  const DateArrowGroup = ({ onPrev, onNext, children }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 30%', minWidth: 92 }}>
      <button className="arrow-btn" style={{ width: 24, height: 24, fontSize: 12 }} onClick={onPrev}>‹</button>
      {children}
      <button className="arrow-btn" style={{ width: 24, height: 24, fontSize: 12 }} onClick={onNext}>›</button>
    </div>
  );

  const yearHasData = Object.values(yearSummary).some(r => (r?.days?.size || 0) > 0);

  const statusLabel = STATUS_OPTIONS.find(o => o.v === statusFilter)?.l;
  const sortLabel = SORT_OPTIONS.find(o => o.v === sortBy)?.l;

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>🗓️ Attendance</div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canExport && hasFeature('has_reports') && (
            <>
              <button className="btn btn-gold btn-sm" style={{ padding: '5px 9px', fontSize: 11 }} onClick={() => doExport('pdf')}>PDF</button>
              <button className="btn btn-success btn-sm" style={{ padding: '5px 9px', fontSize: 11 }} onClick={() => doExport('xlsx')}>XL</button>
            </>
          )}
          {canExport && !hasFeature('has_reports') && (() => {
            const target = cheapestPlanWithFeature('has_reports');
            return (
              <button
                className="btn btn-outline btn-sm"
                style={{ padding: '5px 9px', fontSize: 11, opacity: 0.5, cursor: 'not-allowed' }}
                disabled
                title={target ? `Upgrade to ${target.name} to unlock exports` : 'Not available on your plan'}
              >
                PDF/XL
              </button>
            );
          })()}
          {hasFeature('has_bulk_import') && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowImport(true)}>⬆️ Import</button>
          )}
          {!hasFeature('has_bulk_import') && (() => {
            const target = cheapestPlanWithFeature('has_bulk_import');
            return (
              <button
                className="btn btn-outline btn-sm"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
                disabled
                title={target ? `Upgrade to ${target.name} to unlock bulk import` : 'Not available on your plan'}
              >
                ⬆️ Import
              </button>
            );
          })()}
        </div>
      </div>

      {/* Date navigator — houses the Sport/Batch/Status/Sort filters plus the
          date arrows and view-mode buttons, all folded into the collapsible
          panel (panelOpen). The header row itself stays visible, doesn't hide
          on scroll. Sits above the search box. */}
      <div className="card" style={{ padding: 10, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setPanelOpen(p => !p)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>🗓️ {viewMode === 'year' ? year : viewMode === 'month' ? `${MONTHS[month]} ${year}` : dateLabel}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'var(--accent2)', color: '#fff', textTransform: 'capitalize' }}>{viewMode}</span>
          </div>
          <button className="arrow-btn" style={{ width: 24, height: 24, fontSize: 11 }}
            onClick={(e) => { e.stopPropagation(); setPanelOpen(p => !p); }}>
            {panelOpen ? '▲' : '▼'}
          </button>
        </div>

        {panelOpen && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Sport | Batch | Status | Sort — button + popup style, matching StudentsTab */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sport')}>
                {sportFilter || 'All Sports'}
              </button>
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('batch')}>
                {batchFilter || 'All Batches'}
              </button>
              {viewMode === 'day' && (
                <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('status')}>
                  {statusFilter === 'all' ? 'Status' : statusLabel}
                </button>
              )}
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sort')}>
                {sortLabel || 'Sort'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <DateArrowGroup onPrev={() => shiftDay(-1)} onNext={() => shiftDay(1)}>
                <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, padding: '5px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('day')}>
                  {day} {WEEKDAYS[dateObj.getDay()]}
                </button>
              </DateArrowGroup>
              <DateArrowGroup onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)}>
                <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, padding: '5px 4px' }} onClick={() => setPopup('month')}>
                  {MONTHS[month]}
                </button>
              </DateArrowGroup>
              <DateArrowGroup onPrev={() => shiftYear(-1)} onNext={() => shiftYear(1)}>
                <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, padding: '5px 4px' }} onClick={() => setPopup('year')}>
                  {year}
                </button>
              </DateArrowGroup>
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              {['day', 'month', 'year'].map(m => (
                <button key={m} className={'freq-day-btn' + (viewMode === m ? ' active' : '')}
                  style={{ flex: 1 }} onClick={() => setViewMode(m)}>
                  🗓️ {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {popup === 'sport' && (
        <FilterPopup title="Select Sport" onClose={() => setPopup(null)}>
          <RadioRow name="sportsel" checked={!sportFilter} onChange={() => { setSportFilter(''); setBatchFilter(''); setPopup(null); }} label="All Sports" />
          {visibleSports.map(s => (
            <RadioRow key={s.id} name="sportsel" checked={sportFilter === s.name} onChange={() => { setSportFilter(s.name); setBatchFilter(''); setPopup(null); }} label={s.name} />
          ))}
        </FilterPopup>
      )}

      {popup === 'batch' && (
        <FilterPopup title="Select Batch" onClose={() => setPopup(null)}>
          <RadioRow name="batchsel" checked={!batchFilter} onChange={() => { setBatchFilter(''); setPopup(null); }} label="All Batches" />
          {batchesForSport.map(b => (
            <RadioRow key={b.id} name="batchsel" checked={batchFilter === b.batchLabel} onChange={() => { setBatchFilter(b.batchLabel); setPopup(null); }} label={b.batchLabel} />
          ))}
        </FilterPopup>
      )}

      {popup === 'status' && (
        <FilterPopup title="Filter by Status" onClose={() => setPopup(null)}>
          {STATUS_OPTIONS.map(o => (
            <RadioRow key={o.v} name="statussel" checked={statusFilter === o.v} onChange={() => { setStatusFilter(o.v); setPopup(null); }} label={o.l} />
          ))}
        </FilterPopup>
      )}

      {popup === 'sort' && (
        <FilterPopup title="Sort By" onClose={() => setPopup(null)}>
          {SORT_OPTIONS.map(o => (
            <RadioRow key={o.v} name="sortsel" checked={sortBy === o.v} onChange={() => { setSortBy(o.v); setPopup(null); }} label={o.l} />
          ))}
        </FilterPopup>
      )}

      {popup === 'day' && (
        <FilterPopup title="Select Day" onClose={() => setPopup(null)}>
          {Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1).map(d => (
            <RadioRow key={d} name="daysel" checked={day === d} onChange={() => { setDay(d); setPopup(null); }} label={`${d} ${WEEKDAYS[new Date(year, month, d).getDay()]}`} />
          ))}
        </FilterPopup>
      )}

      {popup === 'month' && (
        <FilterPopup title="Select Month" onClose={() => setPopup(null)}>
          {MONTHS.map((m, i) => (
            <RadioRow key={m} name="monthsel" checked={month === i} onChange={() => { setMonth(i); setPopup(null); }} label={m} />
          ))}
        </FilterPopup>
      )}

      {popup === 'year' && (
        <FilterPopup title="Select Year" onClose={() => setPopup(null)}>
          {Array.from({ length: 8 }, (_, i) => year - 4 + i).map(y => (
            <RadioRow key={y} name="yearsel" checked={year === y} onChange={() => { setYear(y); setPopup(null); }} label={String(y)} />
          ))}
        </FilterPopup>
      )}

      {/* Search box — always visible, never hides on scroll */}
      <div className="search-wrap" style={{ marginBottom: 7 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input type="text" className="search-input" placeholder="Search by name or roll number…"
          value={search} onChange={e => setSearch(e.target.value)} />
        {search && <button type="button" className="search-clear-btn" onClick={() => setSearch('')} aria-label="Clear search">✕</button>}
      </div>

      {/* Summary row — always visible, doesn't hide on scroll */}
      {viewMode === 'day' ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8, fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color: '#4ade80', fontWeight: 700 }}>✅ {presentCount}</span>
            <span style={{ color: '#f87171', fontWeight: 700 }}>❌ {absentCount}</span>
            <span style={{ color: 'var(--gray)', fontWeight: 700 }}>⏳ {notMarkedCount}</span>
            {!classDay && <span style={{ color: 'var(--gold)' }} title="No one marked yet — likely a holiday">🏖️</span>}
          </div>
          {!isFutureDate && (
            <div style={{ display: 'flex', gap: 12, fontWeight: 600 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title={(!sportFilter || !batchFilter) ? 'Pick a specific sport and batch to use Mark All' : undefined}>
                <input type="checkbox" checked={allPChecked} onChange={() => markAll('P')} /> All P
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title={(!sportFilter || !batchFilter) ? 'Pick a specific sport and batch to use Mark All' : undefined}>
                <input type="checkbox" checked={allAChecked} onChange={() => markAll('A')} /> All A
              </label>
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 8 }}>
          {students.length} student(s) · showing {viewMode === 'month' ? `${MONTHS[month]} ${year}` : `${year}`} summary
        </div>
      )}

      <div ref={listScrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: 60, marginTop: 4, overscrollBehavior: 'contain' }} onScroll={handleScroll}>
        {loading && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20 }}>Loading…</div>}

        {!loading && viewMode === 'day' && isFutureDate && (
          <div style={{ background: '#f59e0b18', border: '1px solid #f59e0b55', borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🔒</span>
            <div style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>Future date — attendance cannot be marked yet.</div>
          </div>
        )}

        {!loading && viewMode === 'day' && !isFutureDate && dayStudents.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No students found.</div>
        )}
        {!loading && viewMode !== 'day' && students.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No students found.</div>
        )}

        {!loading && viewMode === 'day' && !isFutureDate && dayStudents.map(r => {
          const status = records[r.key];
          const isLate = status === 'P' && !!lateMap[r.key];
          const rowDone = !!dayStatusMap[r.sport];
          const locked = rowDone && (status === 'A' || (status === 'P' && !isLate));
          const pClass = 'att-btn ' + (status === 'P' ? (isLate ? 'present late' : 'present') : 'inactive');
          const aClass = 'att-btn ' + (status === 'A' ? 'absent' : 'inactive');
          const pTitle = locked ? 'Locked — register closed' : (status === 'P' ? 'Click to clear' : (rowDone ? 'Mark as latecomer (Present)' : 'Mark Present'));
          const aTitle = locked ? 'Locked — register closed' : (status === 'A' ? 'Click to clear' : 'Mark Absent');
          return (
            <div key={r.key} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8 }}>
              <RollBadge rollNo={r.student.roll_no} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                  {r.student.name}
                  {isLate && (
                    <span style={{ background: '#f9731622', color: '#fb923c', border: '1px solid #f9731655', borderRadius: 5, fontSize: 9, fontWeight: 800, padding: '1px 5px', marginLeft: 5 }}>LATE</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                  {sportFilter ? r.batchLabel : `${r.sport} · ${r.batchLabel}`}
                </div>
              </div>
              <div className="att-btns">
                <button className={pClass} title={pTitle} onClick={() => setStatus(r, 'P')}>P</button>
                <button className={aClass} title={aTitle} onClick={() => setStatus(r, 'A')}>A</button>
              </div>
            </div>
          );
        })}

        {!loading && viewMode === 'month' && students.map(r => {
          const agg = periodRows[r.key] || { present: 0, absent: 0 };
          const total = agg.present + agg.absent;
          const pct = total ? Math.round((agg.present / total) * 100) : 0;
          return (
            <div key={r.key} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8 }}>
              <RollBadge rollNo={r.student.roll_no} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{r.student.name}</div>
                <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                  {sportFilter ? r.batchLabel : `${r.sport} · ${r.batchLabel}`}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12 }}>
                <div><span style={{ color: '#16a34a', fontWeight: 700 }}>{agg.present}P</span> · <span style={{ color: '#dc2626', fontWeight: 700 }}>{agg.absent}A</span></div>
                <div style={{ color: 'var(--gray)' }}>{pct}%</div>
              </div>
            </div>
          );
        })}

        {!loading && viewMode === 'year' && !yearHasData && (
          <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No attendance records for {year}.</div>
        )}
        {!loading && viewMode === 'year' && MONTHS.map((mLabel, i) => {
          const row = yearSummary[i];
          if (!row || row.days.size === 0) return null;
          return (
            <div key={mLabel} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8 }}>
              <div style={{ width: 46, fontWeight: 800, color: 'var(--gold)', fontSize: 13, flexShrink: 0 }}>{mLabel}</div>
              <div style={{ flex: 1, fontSize: 12, color: 'var(--gray)' }}>{row.days.size} class day{row.days.size === 1 ? '' : 's'}</div>
              <div style={{ display: 'flex', gap: 10, fontSize: 12, fontWeight: 700 }}>
                <span style={{ color: '#4ade80' }}>✅ {row.p}</span>
                <span style={{ color: '#f87171' }}>❌ {row.a}</span>
              </div>
            </div>
          );
        })}

        {!loading && isAdmin && viewMode === 'day' && !isFutureDate && students.length > 0 && (
          !sportFilter || !batchFilter ? (
            <div style={{ fontSize: 11, color: 'var(--graydk)', marginTop: 10, padding: '8px 10px', background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 8 }}>
              👉 Pick a specific <b>sport</b> and <b>batch</b> above to close its register (Done) and flag latecomers.
            </div>
          ) : dayCompleted ? (
            <>
              <button className="btn" disabled style={{ width: '100%', marginTop: 10, padding: 12, background: 'var(--card2)', color: 'var(--gray)', border: '1px solid var(--border)', cursor: 'not-allowed', fontWeight: 800 }}>
                🔒 Register Closed
              </button>
              <div style={{ fontSize: 11, color: 'var(--graydk)', marginTop: 5, padding: '0 4px' }}>
                Closed for {sportFilter} / {batchFilter}. Marked students are locked; new Present marks show as latecomers.
              </div>
              {isAdmin && (
                <button
                  className="btn"
                  onClick={unlockRegister}
                  disabled={unlocking}
                  style={{ width: '100%', marginTop: 8, padding: 10, background: 'transparent', color: '#f87171', border: '1px solid #f8717155', fontWeight: 700, fontSize: 12 }}
                >
                  {unlocking ? 'Reopening…' : '🔓 Reopen Register (requires reason)'}
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn btn-primary" style={{ width: '100%', marginTop: 10, padding: 12, fontWeight: 800 }} onClick={markAllDone} disabled={completing}>
                {completing ? 'Marking…' : '✅ Done — Close Register'}
              </button>
              <div style={{ fontSize: 11, color: 'var(--graydk)', marginTop: 5, padding: '0 4px' }}>
                Tap P/A again to clear a mark. Closing locks in {sportFilter}'s attendance for the day.
              </div>
            </>
          )
        )}
      </div>

      <button
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
        style={{
          position: 'absolute', left: '50%', bottom: 78, transform: 'translateX(-50%)', zIndex: 20,
          width: 34, height: 34, borderRadius: '50%', padding: 0,
          background: 'var(--card)', color: 'var(--accent2)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 10px rgba(0,0,0,.18)', cursor: 'pointer',
          opacity: showScrollArrow ? 1 : 0, pointerEvents: showScrollArrow ? 'auto' : 'none',
          transition: 'opacity .2s',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {showImport && (
        <ImportAttendanceModal
          academyId={academyId}
          existingStudents={visibleStudents}
          sportFilter={sportFilter}
          batchFilter={batchFilter}
          markedBy={markedBy}
          onClose={() => setShowImport(false)}
          onImported={() => { refresh(); setReloadKey(k => k + 1); }}
        />
      )}
    </div>
  );
}
