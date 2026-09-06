import { useMemo, useState } from 'react';
import { isDue, getDueDate, missingPeriodsFor } from '../lib/scheduleUtils';

export default function StudentHistoryModal({
  row, programs, challenges, pointsRecords, onClose, onAddPoints,
}) {
  const [expandedProgram, setExpandedProgram] = useState(null); // program id whose history list is open

  const challengeById = useMemo(() => {
    const m = {};
    challenges.forEach(c => { m[c.id] = c; });
    return m;
  }, [challenges]);

  // points, mapped with challenge + program info, newest first
  const pointsList = useMemo(() => {
    return pointsRecords
      .filter(p => challengeById[p.challenge_id])
      .map(p => ({
        id: p.id,
        challengeId: p.challenge_id,
        programId: challengeById[p.challenge_id]?.program_id,
        challengeName: challengeById[p.challenge_id]?.name || 'Challenge',
        points: Number(p.points_awarded || 0),
        date: p.awarded_at || p.created_at,
        by: p.awarded_by_name || 'Unknown',
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [pointsRecords, challengeById]);

  // per-program: challenge count, last entry, due state, and any missing
  // (skipped) periods — canAdd covers both "the latest period is due" and
  // "an earlier period was never filled in", since isDue() alone only ever
  // looks at the most recent entry and would otherwise hide older gaps.
  const programCards = useMemo(() => {
    return programs.map(p => {
      const progChallengeIds = new Set(challenges.filter(c => c.program_id === p.id).map(c => c.id));
      const progPoints = pointsList.filter(pt => progChallengeIds.has(pt.challengeId));
      const lastEntry = progPoints[0] || null;
      const due = isDue(p, lastEntry?.date);
      const dueDate = getDueDate(p, lastEntry?.date);
      const missing = missingPeriodsFor(p, challenges, pointsRecords);
      return {
        program: p,
        challengeCount: progChallengeIds.size,
        lastEntry,
        history: progPoints,
        due,
        dueDate,
        missing,
        canAdd: due || missing.length > 0,
      };
    }).filter(pc => pc.challengeCount > 0);
  }, [programs, challenges, pointsList, pointsRecords]);

  return (
    // Rendered in-flow as page content, same pattern as the charts page.
    <div style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--gray)', cursor: 'pointer', padding: 4 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{row.student.name}</div>
          <div style={{ fontSize: 11, color: 'var(--gray)' }}>{row.sport} · {row.batchLabel}</div>
        </div>
      </div>

      {programCards.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 24 }}>
          No programs set up for {row.sport} yet.
        </div>
      )}

      {programCards.map(pc => {
        const isOpen = expandedProgram === pc.program.id;
        return (
          <div key={pc.program.id} className="card" style={{ padding: 14, borderRadius: 14, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{pc.program.name}</div>
                <div style={{ fontSize: 11, color: 'var(--gray)', textTransform: 'capitalize' }}>{pc.program.frequency || 'weekly'} entry</div>
                {pc.missing.length > 0 && (
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#ef4444', marginTop: 2 }}>
                    {pc.missing.length} missing
                  </div>
                )}
              </div>
              <button
                onClick={() => pc.canAdd && onAddPoints(pc.program.id)}
                disabled={!pc.canAdd}
                className="btn btn-sm"
                style={{
                  background: pc.canAdd ? 'var(--accent2)' : 'var(--card2)',
                  color: pc.canAdd ? '#fff' : 'var(--gray)',
                  border: 'none', fontSize: 11, fontWeight: 700,
                  opacity: pc.canAdd ? 1 : 0.5,
                  cursor: pc.canAdd ? 'pointer' : 'not-allowed',
                }}
              >
                ➕ Add Points
              </button>
            </div>

            {/* last entry */}
            {pc.lastEntry ? (
              <div
                onClick={() => setExpandedProgram(isOpen ? null : pc.program.id)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{pc.lastEntry.challengeName}</div>
                  <div style={{ fontSize: 10, color: 'var(--gray)' }}>
                    {(pc.lastEntry.date || '').slice(0, 10)} · by {pc.lastEntry.by}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <b style={{ color: 'var(--accent2)' }}>+{pc.lastEntry.points}</b>
                  <span style={{ fontSize: 12, color: 'var(--gray)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--gray)', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                No entries yet — due now.
              </div>
            )}

            {!pc.due && (
              <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 2 }}>
                Next entry opens {pc.dueDate.toISOString().slice(0, 10)}
              </div>
            )}

            {/* history list — tap last entry to expand */}
            {isOpen && pc.history.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 6 }}>PREVIOUS ENTRIES</div>
                {pc.history.map(h => (
                  <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 11, borderTop: '1px solid var(--border)' }}>
                    <span>{h.challengeName} <span style={{ color: 'var(--gray)' }}>· by {h.by}</span></span>
                    <span style={{ display: 'flex', gap: 8 }}>
                      <span style={{ color: 'var(--gray)' }}>{(h.date || '').slice(0, 10)}</span>
                      <b style={{ color: 'var(--accent2)' }}>+{h.points}</b>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
