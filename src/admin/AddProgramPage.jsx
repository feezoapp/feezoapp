import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { supabase } from '../lib/supabaseClient';

const FREQUENCIES = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'custom', label: 'Custom' },
];

const WEEKDAYS = [
  { v: 0, l: 'Sun' }, { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' },
];

function todayIso() { return new Date().toISOString().slice(0, 10); }

export default function AddProgramPage() {
  const { academyId, isAdmin, user, appUser } = useAuth();
  const { visibleSports } = useAcademyData();
  const navigate = useNavigate();

  const [sport, setSport] = useState(visibleSports[0]?.name || '');
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState('weekly');
  const [customDays, setCustomDays] = useState([]);
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState('');

  const [attendanceWeight, setAttendanceWeight] = useState(50);
  const [attendanceInput, setAttendanceInput] = useState('50');
  const [programInput, setProgramInput] = useState('50');

  const [challengeList, setChallengeList] = useState([]); // [{ name, points }]
  const [chName, setChName] = useState('');
  const [chPoints, setChPoints] = useState('');

  const [busy, setBusy] = useState(false);

  // staff should never reach this route — nav/route guards keep it hidden,
  // this is just a safety net matching ProgramManagerModal's old check
  if (!isAdmin) return null;

  const toggleDay = (v) => {
    setCustomDays(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  };

  const commitAttendance = () => {
    if (attendanceInput === '') { setAttendanceInput(String(attendanceWeight)); return; }
    const clamped = Math.max(0, Math.min(100, Number(attendanceInput)));
    setAttendanceWeight(clamped);
    setAttendanceInput(String(clamped));
    setProgramInput(String(100 - clamped));
  };
  const commitProgram = () => {
    if (programInput === '') { setProgramInput(String(100 - attendanceWeight)); return; }
    const clamped = Math.max(0, Math.min(100, Number(programInput)));
    setAttendanceWeight(100 - clamped);
    setAttendanceInput(String(100 - clamped));
    setProgramInput(String(clamped));
  };

  const addChallengeRow = () => {
    if (!chName.trim() || !chPoints) return;
    setChallengeList(list => [...list, { name: chName.trim(), points: Number(chPoints) }]);
    setChName(''); setChPoints('');
  };
  const removeChallengeRow = (i) => setChallengeList(list => list.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!name.trim() || !sport) { alert('Sport and program name are required.'); return; }
    if (frequency === 'custom' && customDays.length === 0) { alert('Select at least one entry day for a custom schedule.'); return; }
    if (toDate && fromDate && toDate < fromDate) { alert('End date must be after the start date.'); return; }

    setBusy(true);
    // Wrapped so any unexpected failure (network blip, an exception that
    // isn't a plain Supabase {error} response) always surfaces as an alert
    // and always clears `busy` — without this, a thrown error here silently
    // aborts the function: no error shown, no navigation, and the button
    // could get stuck or reset with nothing visibly happening.
    try {
      const { data: prog, error } = await supabase.from('programs').insert({
        academy_id: academyId,
        sport,
        name: name.trim(),
        frequency,
        custom_days: frequency === 'custom' ? customDays : null,
        from_date: fromDate || null,
        to_date: toDate || null,
        attendance_weight: attendanceWeight,
        created_by_id: user?.id,
        created_by_name: appUser?.name || user?.email,
      }).select().single();

      if (error) { alert('Failed to save program: ' + error.message); return; }

      if (challengeList.length) {
        const rows = challengeList.map(c => ({
          program_id: prog.id, academy_id: academyId, sport,
          name: c.name, total_points: c.points, created_by_id: user?.id,
        }));
        const { error: chErr } = await supabase.from('program_challenges').insert(rows);
        if (chErr) {
          alert('Program saved, but challenges failed to save: ' + chErr.message);
          navigate('/admin/performance/programs');
          return;
        }
      }
      navigate('/admin/performance/programs');
    } catch (e) {
      alert('Failed to save program: ' + (e?.message || 'Something went wrong — check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page active" style={{ paddingBottom: 90 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>+ Add Program</div>
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/admin/performance')}>Cancel</button>
      </div>

      {/* sport + name + frequency — one row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <select className="form-select" style={{ flex: '1 1 90px', fontSize: 12 }} value={sport} onChange={e => setSport(e.target.value)}>
          {visibleSports.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <input className="form-input" style={{ flex: '2 1 140px', fontSize: 12 }} placeholder="Program name (e.g. Level 1 Basics)"
          value={name} onChange={e => setName(e.target.value)} />
        <select className="form-select" style={{ flex: '1 1 100px', fontSize: 12 }} value={frequency} onChange={e => setFrequency(e.target.value)}>
          {FREQUENCIES.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>

      {frequency === 'custom' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>ENTRY DAYS</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {WEEKDAYS.map(d => (
              <button key={d.v} type="button"
                onClick={() => toggleDay(d.v)}
                className={`btn btn-sm ${customDays.includes(d.v) ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontSize: 11, padding: '5px 9px' }}
              >{d.l}</button>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>PROGRAM DATES</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
        <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }} value={fromDate} onChange={e => setFromDate(e.target.value)} />
        <span style={{ fontSize: 11, color: 'var(--gray)' }}>–</span>
        <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }} value={toDate} onChange={e => setToDate(e.target.value)} />
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>SCORE SPLIT (%)</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--gray)', marginBottom: 3 }}>Attendance</div>
          <input type="number" min={0} max={100} className="form-input" style={{ width: '100%', fontSize: 12, padding: '7px 8px' }}
            value={attendanceInput} onChange={e => setAttendanceInput(e.target.value)} onBlur={commitAttendance} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--gray)', marginBottom: 3 }}>Program</div>
          <input type="number" min={0} max={100} className="form-input" style={{ width: '100%', fontSize: 12, padding: '7px 8px' }}
            value={programInput} onChange={e => setProgramInput(e.target.value)} onBlur={commitProgram} />
        </div>
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>CHALLENGES</div>
      {challengeList.map((c, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--card2)', borderRadius: 7, padding: '8px 10px', marginBottom: 6 }}>
          <div style={{ fontSize: 12 }}>{c.name} <span style={{ color: 'var(--gray)' }}>· {c.points} pts</span></div>
          <button onClick={() => removeChallengeRow(i)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 13, cursor: 'pointer' }}>✕</button>
        </div>
      ))}
      {challengeList.length === 0 && <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 8 }}>No challenges added yet.</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        <input className="form-input" style={{ flex: 2, fontSize: 12 }} placeholder="Challenge name" value={chName} onChange={e => setChName(e.target.value)} />
        <input type="number" className="form-input" style={{ flex: 1, fontSize: 12 }} placeholder="Points" value={chPoints} onChange={e => setChPoints(e.target.value)} />
        <button className="btn btn-outline btn-sm" onClick={addChallengeRow}>+</button>
      </div>

      <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !name.trim() || !sport} onClick={save}>
        {busy ? 'Saving…' : 'Save Program'}
      </button>
    </div>
  );
}
