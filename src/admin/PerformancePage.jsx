import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { supabase } from '../lib/supabaseClient';
import AwardPointsModal from './AwardPointsModal';
import StudentChartsModal from './StudentChartsModal';
import StudentHistoryModal from './StudentHistoryModal';
import FeatureGate from './FeatureGate';

const PRESENT_STATUS = 'P'; // adjust here if attendance uses a different code for "present"

function todayIso() { return new Date().toISOString().slice(0, 10); }
function monthStartIso() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }
function isCompleted(p) { return !!p.to_date && p.to_date < todayIso(); }

// How many award periods a program has had so far — points now accumulate
// one entry per period (see AwardPointsModal's periodStartFor, which this
// must stay in sync with), so the "possible points so far" denominator has
// to grow with elapsed periods too, or a Daily program would sail past
// 100% after just a few days of stacking entries.
function countPeriods(program, todayIsoStr) {
  if (!program?.from_date) return 1;
  const start = new Date(program.from_date + 'T00:00:00');
  const capEndIso = program.to_date && program.to_date < todayIsoStr ? program.to_date : todayIsoStr;
  const end = new Date(capEndIso + 'T00:00:00');
  if (end < start) return 0;

  if (program.frequency === 'monthly') {
    return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  }
  if (program.frequency === 'weekly') {
    const startSun = new Date(start); startSun.setDate(start.getDate() - start.getDay());
    const endSun = new Date(end); endSun.setDate(end.getDate() - end.getDay());
    return Math.round((endSun - startSun) / (7 * 24 * 60 * 60 * 1000)) + 1;
  }
  if (program.frequency === 'custom' && Array.isArray(program.custom_days) && program.custom_days.length) {
    let count = 0;
    const cur = new Date(start);
    while (cur <= end) {
      if (program.custom_days.includes(cur.getDay())) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count || 1;
  }
  // daily (default)
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function PerformancePageContent() {
  const { academyId, isAdmin, user, appUser } = useAuth();
  const { visibleStudents, visibleSports } = useAcademyData();
  const navigate = useNavigate();

  const [attendance, setAttendance] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [challenges, setChallenges] = useState([]);
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);

  const [dateFrom, setDateFrom] = useState(monthStartIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [search, setSearch] = useState('');
  const [selectedSport, setSelectedSport] = useState('');
  const [selectedProgramId, setSelectedProgramId] = useState('');
  const [sortDir, setSortDir] = useState('desc'); // 'desc' = high to low
  const [filtersOpen, setFiltersOpen] = useState(false); // collapse bar
  const [popup, setPopup] = useState(null); // 'sport' | 'program' | 'sort' | null

  const [awardFor, setAwardFor] = useState(null); // row currently awarding points for
  const [chartsFor, setChartsFor] = useState(null); // row currently viewing charts for
  const [historyFor, setHistoryFor] = useState(null); // row currently viewing history for

  // default: first visible sport, once loaded
  useEffect(() => {
    if (visibleSports.length && !selectedSport) {
      setSelectedSport(visibleSports[0].name);
    }
  }, [visibleSports]); // eslint-disable-line

  // active (non-completed) programs for the currently selected sport
  const programsForSport = useMemo(
    () => programs.filter(p => p.sport === selectedSport && !isCompleted(p)),
    [programs, selectedSport]
  );

  // default: first active program for the selected sport — resets whenever
  // the sport changes or the current selection no longer exists/is completed
  useEffect(() => {
    if (programsForSport.length === 0) { setSelectedProgramId(''); return; }
    if (!programsForSport.some(p => p.id === selectedProgramId)) {
      setSelectedProgramId(programsForSport[0].id);
    }
  }, [programsForSport]); // eslint-disable-line

  const selectedProgram = useMemo(
    () => programs.find(p => p.id === selectedProgramId) || null,
    [programs, selectedProgramId]
  );

  const load = async () => {
    if (!academyId) return;
    setLoading(true);
    const [att, prog, chal, pts] = await Promise.all([
      supabase.from('attendance').select('student_id, sport, status, date').eq('academy_id', academyId).gte('date', dateFrom).lte('date', dateTo),
      supabase.from('programs').select('*').eq('academy_id', academyId),
      supabase.from('program_challenges').select('*').eq('academy_id', academyId),
      supabase.from('student_challenge_points').select('*').eq('academy_id', academyId),
    ]);
    setAttendance(att.data || []);
    setPrograms(prog.data || []);
    setChallenges(chal.data || []);
    setPoints(pts.data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [academyId, dateFrom, dateTo]); // eslint-disable-line

  const attendanceWeight = selectedProgram?.attendance_weight ?? 50;
  const courseWeight = 100 - attendanceWeight;

  // attendance % per student+sport — denominator is every distinct session
  // date recorded for that sport (across all students) in the date range, not
  // just this student's own rows. So a day another student was marked but
  // this student has no row for at all correctly counts against them as
  // absent, instead of being silently excluded and inflating their %.
  const attendancePct = useMemo(() => {
    const sessionDatesBySport = {};
    attendance.forEach(a => {
      sessionDatesBySport[a.sport] = sessionDatesBySport[a.sport] || new Set();
      sessionDatesBySport[a.sport].add(a.date);
    });

    // distinct present DATES per student+sport — using a Set (not a raw row
    // count) so a duplicate row on the same date (e.g. the student is in more
    // than one batch and got marked once per batch) doesn't double-count and
    // push the percentage over 100%.
    const presentDates = {};
    const studentSportKeys = new Set();
    attendance.forEach(a => {
      const key = `${a.student_id}|${a.sport}`;
      studentSportKeys.add(key);
      if ((a.status || '').toUpperCase() === PRESENT_STATUS) {
        presentDates[key] = presentDates[key] || new Set();
        presentDates[key].add(a.date);
      }
    });

    const out = {};
    studentSportKeys.forEach(key => {
      const sport = key.split('|')[1];
      const totalDays = sessionDatesBySport[sport]?.size || 0;
      const present = presentDates[key]?.size || 0;
      out[key] = totalDays ? Math.min(100, (present / totalDays) * 100) : 0;
    });
    return out;
  }, [attendance]);

  // total possible points for the SELECTED PROGRAM so far — the per-period
  // max (sum of its challenges) times how many periods have elapsed, since
  // points now accumulate one entry per period instead of just once ever.
  const totalPointsForProgram = useMemo(() => {
    if (!selectedProgramId || !selectedProgram) return 0;
    const perPeriodMax = challenges.filter(c => c.program_id === selectedProgramId).reduce((sum, c) => sum + (c.total_points || 0), 0);
    const periods = countPeriods(selectedProgram, todayIso());
    return perPeriodMax * periods;
  }, [challenges, selectedProgramId, selectedProgram]);

  // points earned per student — scoped to the selected program's challenges only
  const earnedPointsByStudent = useMemo(() => {
    if (!selectedProgramId) return {};
    const challengeIds = new Set(challenges.filter(c => c.program_id === selectedProgramId).map(c => c.id));
    const out = {};
    points.forEach(p => {
      if (!challengeIds.has(p.challenge_id)) return;
      out[p.student_id] = (out[p.student_id] || 0) + Number(p.points_awarded || 0);
    });
    return out;
  }, [points, challenges, selectedProgramId]);

  // build one row per student enrolled in the SELECTED sport — batches within
  // that sport are merged into a single entry
  const rows = useMemo(() => {
    const bySportStudent = new Map();
    visibleStudents.forEach(s => {
      (s.enrollments || []).forEach(en => {
        if (en.sport !== selectedSport) return;
        const key = `${s.id}|${en.sport}`;
        if (!bySportStudent.has(key)) {
          bySportStudent.set(key, { student: s, sport: en.sport, batchLabels: [], batchKeys: [] });
        }
        const entry = bySportStudent.get(key);
        if (!entry.batchKeys.includes(en.batch)) {
          entry.batchKeys.push(en.batch);
          entry.batchLabels.push(en.batchLabel);
        }
      });
    });
    const out = [];
    bySportStudent.forEach((entry, key) => {
      const attPct = attendancePct[key] ?? 0;
      const earnedPts = earnedPointsByStudent[entry.student.id] || 0;
      const coursePct = totalPointsForProgram ? Math.min(100, (earnedPts / totalPointsForProgram) * 100) : 0;
      const finalScore = attPct * (attendanceWeight / 100) + coursePct * (courseWeight / 100);
      out.push({
        key,
        student: entry.student,
        sport: entry.sport,
        batchLabel: entry.batchLabels.join(', '),
        batchKey: entry.batchKeys.join(','),
        attendancePct: attPct,
        coursePct,
        finalScore,
      });
    });
    return out;
  }, [visibleStudents, selectedSport, attendancePct, totalPointsForProgram, earnedPointsByStudent, attendanceWeight, courseWeight]);

  const filteredRows = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r => (r.student.name || '').toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => sortDir === 'desc' ? b.finalScore - a.finalScore : a.finalScore - b.finalScore);
    return list;
  }, [rows, search, sortDir]);
  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 90 }}>
      {chartsFor ? (
        <StudentChartsModal
          row={chartsFor}
          academyId={academyId}
          userId={user?.id}
          userName={appUser?.name || user?.email}
          canEdit={isAdmin}
          totalPoints={totalPointsForProgram}
          earnedPoints={earnedPointsByStudent[chartsFor.student.id] || 0}
          pointsRecords={points.filter(p => p.student_id === chartsFor.student.id)}
          challenges={challenges.filter(c => c.program_id === selectedProgramId)}
          programs={selectedProgram ? [selectedProgram] : []}
          attendanceRecords={attendance.filter(a => a.student_id === chartsFor.student.id && a.sport === chartsFor.sport)}
          sportAttendanceRecords={attendance.filter(a => a.sport === chartsFor.sport)}
          onClose={() => setChartsFor(null)}
        />
      ) : historyFor ? (
        <StudentHistoryModal
          row={historyFor}
          programs={programs.filter(p => p.sport === historyFor.sport)}
          pointsRecords={points.filter(p => p.student_id === historyFor.student.id)}
          challenges={challenges.filter(c => c.sport === historyFor.sport)}
          onClose={() => setHistoryFor(null)}
          onAddPoints={(programId) => setAwardFor({ ...historyFor, programFilter: programId })}
        />
      ) : (
      <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>🏆 Performance Leaderboard</div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 5 }}>
            <button className="btn btn-outline btn-sm" style={{ fontSize: 11, padding: '5px 9px' }} onClick={() => navigate('/admin/performance/programs')}>List</button>
            <button className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '5px 9px' }} onClick={() => navigate('/admin/performance/add')}>+ Add</button>
          </div>
        )}
      </div>

      {/* search with clear button */}
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <input
          className="form-input"
          style={{ width: '100%', fontSize: 13, padding: '9px 30px 9px 10px' }}
          placeholder="Search student…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--gray)', fontSize: 15, cursor: 'pointer', padding: 2 }}
          >✕</button>
        )}
      </div>

      {/* collapse bar */}
      <button
        onClick={() => setFiltersOpen(o => !o)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 12, fontWeight: 700, color: 'var(--offwhite)', marginBottom: filtersOpen ? 8 : 12, cursor: 'pointer' }}
      >
        <span>Filters &amp; Sort</span>
        <span style={{ color: 'var(--gray)' }}>{filtersOpen ? '▲' : '▼'}</span>
      </button>

      {filtersOpen && (
        <div style={{ background: 'var(--card2)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
          {/* date range for attendance calculation */}
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>DATE RANGE</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
            <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <span style={{ fontSize: 11, color: 'var(--gray)' }}>–</span>
            <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>

          {/* program / sport / sort — single row, open popup on click */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('program')}>
              {selectedProgram?.name || 'Program'}
            </button>
            <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11 }} onClick={() => setPopup('sport')}>
              {selectedSport || 'Sport'}
            </button>
            <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11 }} onClick={() => setPopup('sort')}>
              Sort
            </button>
          </div>
        </div>
      )}

      {/* popups */}
      {popup && (
        <div
          onClick={() => setPopup(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: 12, padding: 14, width: '85%', maxWidth: 320, maxHeight: '70vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>
                {popup === 'sport' ? 'Select Sport' : popup === 'program' ? 'Select Program' : 'Sort By'}
              </div>
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--gray)', cursor: 'pointer' }}>×</button>
            </div>

            {popup === 'sport' && visibleSports.map(s => (
              <label key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '7px 2px', cursor: 'pointer' }}>
                <input type="radio" name="sportsel" checked={selectedSport === s.name} onChange={() => { setSelectedSport(s.name); setPopup(null); }} />
                {s.name}
              </label>
            ))}

            {popup === 'program' && programsForSport.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--gray)', padding: '8px 2px' }}>No active programs for {selectedSport}.</div>
            )}
            {popup === 'program' && programsForSport.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '7px 2px', cursor: 'pointer' }}>
                <input type="radio" name="programsel" checked={selectedProgramId === p.id} onChange={() => { setSelectedProgramId(p.id); setPopup(null); }} />
                {p.name}
              </label>
            ))}

            {popup === 'sort' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[{ v: 'desc', l: 'High to Low' }, { v: 'asc', l: 'Low to High' }].map(o => (
                  <label key={o.v} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '7px 2px', cursor: 'pointer' }}>
                    <input type="radio" name="sortdir" checked={sortDir === o.v} onChange={() => { setSortDir(o.v); setPopup(null); }} />
                    {o.l}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20 }}>Loading…</div>}

      {!loading && !selectedProgram && (
        <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 40, fontSize: 13 }}>
          No program created{selectedSport ? ` for ${selectedSport}` : ''}.
          {isAdmin && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/admin/performance/add')}>+ Add Program</button>
            </div>
          )}
        </div>
      )}

      {!loading && selectedProgram && filteredRows.map((r, i) => (
        <div key={r.key} className="card" style={{ padding: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          onClick={() => setHistoryFor(r)}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent2)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
            {i + 1}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{r.student.name}</div>
            <div style={{ fontSize: 11, color: 'var(--gray)' }}>{r.sport} · {r.batchLabel}</div>
            <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 2 }}>
              📆 {r.attendancePct.toFixed(0)}% · 🏆 {r.coursePct.toFixed(0)}%
            </div>
          </div>
          {/* chart icon column — fixed width so it lines up in a straight column
              across every row, right next to the total-points column */}
          <div style={{ width: 30, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <span
              onClick={(e) => { e.stopPropagation(); setChartsFor(r); }}
              title="View charts"
              role="button"
              style={{
                display: 'inline-block', width: 20, height: 20, borderRadius: '50%', cursor: 'pointer', position: 'relative', flexShrink: 0,
                background: 'conic-gradient(#f4695f 0deg 60deg, #f8c559 60deg 120deg, #1a9e4c 120deg 180deg, #5b9bd9 180deg 240deg, #1976d2 240deg 300deg, #b04a4a 300deg 360deg)',
              }}
            >
              <span style={{ position: 'absolute', inset: 4.5, borderRadius: '50%', background: 'var(--card)' }} />
            </span>
          </div>
          <div style={{ width: 44, textAlign: 'right', fontWeight: 800, color: 'var(--accent2)', fontSize: 15, flexShrink: 0 }}>{r.finalScore.toFixed(0)}</div>
        </div>
      ))}
      {!loading && selectedProgram && filteredRows.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No students match the current filters.</div>
      )}

      </>
      )}

      {awardFor && (
        <AwardPointsModal
          row={awardFor}
          academyId={academyId}
          userId={user?.id}
          userName={appUser?.name || user?.email}
          programs={programs.filter(p => p.sport === awardFor.sport)}
          challenges={challenges.filter(c => c.sport === awardFor.sport)}
          existingPoints={points.filter(p => p.student_id === awardFor.student.id)}
          programFilter={awardFor.programFilter}
          onClose={() => setAwardFor(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

export default function PerformancePage() {
  return (
    <FeatureGate feature="has_performance">
      <PerformancePageContent />
    </FeatureGate>
  );
}
