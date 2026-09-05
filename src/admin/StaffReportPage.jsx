import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { isTaskMissed } from '../lib/calendarDate';

function ProgressBar({ pct, color }) {
  return (
    <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 99, height: 8, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .3s ease' }} />
    </div>
  );
}

function StatChip({ label, value, color }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', background: 'var(--card2)', borderRadius: 8, padding: '7px 4px' }}>
      <div style={{ fontSize: 16, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 9.5, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: .3 }}>{label}</div>
    </div>
  );
}

export default function StaffReportPage() {
  const { isAdmin, academyId } = useAuth();
  const navigate = useNavigate();

  const [staffList, setStaffList] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!academyId) return;
    setLoading(true);
    const [us, ts, ls] = await Promise.all([
      supabase.from('app_users').select('*').eq('academy_id', academyId),
      supabase.from('week_schedules').select('*').eq('academy_id', academyId),
      supabase.from('leave_requests').select('*').eq('academy_id', academyId),
    ]);
    const users = (us.data || []).filter(u => {
      const roles = (u.role || '').split(',').map(r => r.trim());
      return roles.includes('staff') || roles.includes('admin');
    });
    setStaffList(users);
    setTasks(ts.data || []);
    setLeaves(ls.data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [academyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    return staffList.map(u => {
      const myTasks = tasks.filter(t => t.staff_id === u.id);
      const done = myTasks.filter(t => t.status === 'done').length;
      const missed = myTasks.filter(t => isTaskMissed(t)).length;
      const total = myTasks.length;
      const completionPct = total ? Math.round((done / total) * 100) : 0;

      const myLeaves = leaves.filter(l => l.staff_id === u.id);
      const approved = myLeaves.filter(l => l.status === 'approved').length;
      const pending = myLeaves.filter(l => l.status === 'pending').length;
      const rejected = myLeaves.filter(l => l.status === 'rejected').length;

      return { user: u, total, done, missed, completionPct, approved, pending, rejected };
    }).sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
  }, [staffList, tasks, leaves]);

  if (!isAdmin) {
    return (
      <div className="page active" style={{ padding: 20, textAlign: 'center', color: 'var(--gray)' }}>
        You don't have access to this page.
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/calendar')}>← Back to Calendar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 90 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/calendar')}>←</button>
        <div className="section-title" style={{ marginBottom: 0 }}>📈 Staff Report</div>
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20 }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 24 }}>No staff members found.</div>
      )}

      {!loading && rows.map(r => (
        <div key={r.user.id} className="card" style={{ padding: 13, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--offwhite)' }}>
                {r.user.name || r.user.id}{(r.user.role || '').includes('admin') ? ' · Admin' : ''}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--gray)' }}>{r.user.email || ''}</div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: r.completionPct >= 75 ? '#22c55e' : r.completionPct >= 40 ? '#f97316' : '#ef4444' }}>
              {r.completionPct}%
            </div>
          </div>

          <div style={{ marginBottom: 4, fontSize: 10.5, color: 'var(--gray)' }}>Task completion ({r.done}/{r.total} done{r.missed ? `, ${r.missed} missed` : ''})</div>
          <ProgressBar pct={r.completionPct} color={r.completionPct >= 75 ? '#22c55e' : r.completionPct >= 40 ? '#f97316' : '#ef4444'} />

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <StatChip label="Approved" value={r.approved} color="#22c55e" />
            <StatChip label="Pending" value={r.pending} color="var(--gray)" />
            <StatChip label="Rejected" value={r.rejected} color="#ef4444" />
            <StatChip label="Missed" value={r.missed} color="#ef4444" />
          </div>
        </div>
      ))}
    </div>
  );
}
