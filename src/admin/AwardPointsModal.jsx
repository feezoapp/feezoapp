import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import PanelWindow from '../components/PanelWindow';

function todayIso() { return new Date().toISOString().slice(0, 10); }

// Buckets a chosen date into the "period" that a program's frequency
// awards points against — one row per period per student per challenge,
// instead of one row ever. Daily/Custom programs use the exact date;
// Weekly buckets to that week's Sunday; Monthly buckets to the 1st of
// the month. This must match the identical helper in PerformancePage.jsx
// so the leaderboard's period count and this modal's period bucketing
// never disagree about what counts as "one period".
function periodStartFor(frequency, dateIso) {
  const d = new Date(dateIso + 'T00:00:00');
  if (frequency === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  if (frequency === 'weekly') {
    const sunday = new Date(d);
    sunday.setDate(d.getDate() - d.getDay());
    return sunday.toISOString().slice(0, 10);
  }
  return dateIso; // daily & custom — one period per calendar date
}

function periodLabelFor(frequency, periodStart) {
  const start = new Date(periodStart + 'T00:00:00');
  if (frequency === 'monthly') {
    return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  if (frequency === 'weekly') {
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return `Week of ${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
  }
  return start.toLocaleDateString();
}

// The period right after the one currently selected — shown so staff know
// when the next entry window opens for Weekly/Monthly programs, instead of
// guessing whether "this week" is done and it's safe to move on.
function nextPeriodStartFor(frequency, periodStart) {
  const d = new Date(periodStart + 'T00:00:00');
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default function AwardPointsModal({ row, academyId, userId, userName, programs, challenges, existingPoints, programFilter, onClose, onChanged }) {
  const visiblePrograms = programFilter ? programs.filter(p => p.id === programFilter) : programs;
  const visibleChallenges = programFilter ? challenges.filter(c => c.program_id === programFilter) : challenges;

  // Which day this award applies to — defaults to today, but staff can
  // backdate it (e.g. entering yesterday's points a day late). Every
  // challenge shown gets bucketed into a period computed from this date
  // and its own program's frequency.
  const [date, setDate] = useState(todayIso());
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);

  const programById = (id) => programs.find(p => p.id === id);

  // Recompute which value shows in each box whenever the selected date
  // changes — a different date can land in a different period, which may
  // already have its own saved score (or none yet).
  useEffect(() => {
    const map = {};
    visibleChallenges.forEach(c => {
      const prog = programById(c.program_id);
      const period = periodStartFor(prog?.frequency, date);
      const existing = existingPoints.find(p => p.challenge_id === c.id && p.period_start === period);
      map[c.id] = existing ? String(existing.points_awarded) : '';
    });
    setValues(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const setVal = (challengeId, val, maxPoints) => {
    if (val === '') { setValues(prev => ({ ...prev, [challengeId]: '' })); return; }
    let num = Number(val);
    if (Number.isNaN(num)) return;
    if (num < 0) num = 0;
    if (num > maxPoints) num = maxPoints;
    setValues(prev => ({ ...prev, [challengeId]: String(num) }));
  };

  const saveAll = async () => {
    if (date > todayIso()) { alert("You can't award points for a future date — that period hasn't opened yet."); return; }
    setBusy(true);
    try {
      const rowsToUpsert = visibleChallenges
        .filter(c => values[c.id] !== '' && values[c.id] != null)
        .map(c => {
          const prog = programById(c.program_id);
          return {
            academy_id: academyId,
            student_id: row.student.id,
            challenge_id: c.id,
            sport: c.sport,
            period_start: periodStartFor(prog?.frequency, date),
            points_awarded: Math.min(Number(values[c.id]), c.total_points),
            awarded_by_id: userId,
            awarded_by_name: userName,
            awarded_at: new Date().toISOString(),
          };
        });
      if (rowsToUpsert.length === 0) { onClose(); return; }
      const { error } = await supabase.from('student_challenge_points').upsert(rowsToUpsert, { onConflict: 'student_id,challenge_id,period_start' });
      if (error) throw error;
      onChanged?.();
      onClose();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelWindow onClose={onClose}>
      <div className="modal" style={{ width: '100%', maxWidth: '100%', height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 0, margin: 0 }}>
        <div className="modal-title">
          <span>🏆 Award Points</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>{row.student.name}</div>
          <div style={{ fontSize: 12, color: 'var(--gray)' }}>{row.sport} · {row.batchLabel}</div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 5 }}>AWARDING FOR</div>
          <input type="date" className="form-input" style={{ width: '100%', fontSize: 12, padding: '7px 8px' }}
            value={date} max={todayIso()}
            onChange={e => setDate(e.target.value > todayIso() ? todayIso() : e.target.value)} />
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {visiblePrograms.map(p => {
            const progChallenges = visibleChallenges.filter(c => c.program_id === p.id);
            if (progChallenges.length === 0) return null;
            const period = periodStartFor(p.frequency, date);
            return (
              <div key={p.id} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent2)' }}>{p.name}</div>
                <div style={{ fontSize: 10, color: 'var(--gray)', marginBottom: 6 }}>
                  {periodLabelFor(p.frequency, period)}
                  {(p.frequency === 'weekly' || p.frequency === 'monthly') && (
                    <> · Next: {periodLabelFor(p.frequency, nextPeriodStartFor(p.frequency, period))}</>
                  )}
                </div>
                {progChallenges.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ flex: 1, fontSize: 12 }}>{c.name} <span style={{ color: 'var(--gray)' }}>/ {c.total_points}</span></div>
                    <input
                      type="number" min={0} max={c.total_points}
                      className="form-input" style={{ width: 70, fontSize: 12, padding: '6px 8px' }}
                      placeholder="0"
                      value={values[c.id] ?? ''}
                      onChange={e => setVal(c.id, e.target.value, c.total_points)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
          {visibleChallenges.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20, fontSize: 12 }}>
              No programs/challenges set up for {row.sport} yet.
            </div>
          )}
        </div>

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy} onClick={saveAll}>
          {busy ? 'Saving…' : 'Save Points'}
        </button>
      </div>
    </PanelWindow>
  );
}
