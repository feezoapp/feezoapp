import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { supabase } from '../lib/supabaseClient';
import { logActivity } from '../lib/auditLog';
import {
  addDays, addMonths, dayName, fmt24to12, getMonday, isoToDisplay, isTaskMissed,
  monthLabel, SCHED_COLORS, SCHED_LABELS, shortDate, todayIso, urgencyFor,
} from '../lib/calendarDate';
import TaskScheduleModal from '../components/TaskScheduleModal';
import ViewTaskModal from '../components/ViewTaskModal';
import ApplyLeaveModal from '../components/ApplyLeaveModal';
import LeaveListModal from '../components/LeaveListModal';

// Same centered popup used by StudentsTab's / AttendanceTab's / HomeTab's /
// FeesTab's / EnquiryTab's / ClassLogPage's filters — a dark overlay + a
// card of radio rows, closing itself on selection.
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

function TaskCard({ t, isAdmin, staffName, onView, onStart, onDone }) {
  const color = SCHED_COLORS[t.status] || SCHED_COLORS.scheduled;
  const label = SCHED_LABELS[t.status] || SCHED_LABELS.scheduled;
  const urgency = urgencyFor(t);
  const borderColor = urgency ? urgency.color : color;
  return (
    <div className="card" style={{ marginBottom: 8, padding: '13px 14px', borderLeft: `4px solid ${borderColor}`, cursor: 'pointer' }} onClick={() => onView(t)}>
      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--offwhite)', marginBottom: 4 }}>{t.task || 'Untitled Task'}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        {t.sport && (
          <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--accent2)22', color: 'var(--accent2)', border: '1px solid var(--accent2)44', padding: '2px 7px', borderRadius: 6 }}>
            🏅 {t.sport}{t.batch ? ` · ${t.batch}` : ''}
          </span>
        )}
        {t.in_time && (
          <span style={{ fontSize: 11, fontWeight: 700, color }}>
            ⏰ {fmt24to12(t.in_time)}{t.out_time ? ` – ${fmt24to12(t.out_time)}` : ''}
          </span>
        )}
        {t.date && <span style={{ fontSize: 11, color: 'var(--gray)' }}>📆 {isoToDisplay(t.date)}</span>}
        {t.location && <span style={{ fontSize: 11, color: 'var(--gray)' }}>📍 {t.location}</span>}
      </div>
      {t.note && <div style={{ fontSize: 12, color: 'var(--gray)', fontStyle: 'italic', marginBottom: 6 }}>{t.note}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {isAdmin && (
          <span style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700, color: 'var(--offwhite)' }}>
            👤 {staffName(t.staff_id)}
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}22`, border: `1px solid ${color}44`, padding: '3px 8px', borderRadius: 6 }}>{label}</span>
        {urgency && (
          <span style={{ fontSize: 11, fontWeight: 700, color: urgency.color, background: `${urgency.color}22`, border: `1px solid ${urgency.color}44`, padding: '3px 8px', borderRadius: 6 }}>{urgency.label}</span>
        )}
      </div>
      {!isAdmin && (t.status === 'scheduled' || t.status === 'pending') && (
        <div style={{ marginTop: 10 }}>
          <button className="btn" style={{ width: '100%', fontSize: 12, padding: 9, background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44', fontWeight: 700 }}
            onClick={e => { e.stopPropagation(); onStart(t); }}>▶️ Start — Check In</button>
        </div>
      )}
      {!isAdmin && t.status === 'in_progress' && (
        <div style={{ marginTop: 10 }}>
          <button className="btn" style={{ width: '100%', fontSize: 12, padding: 9, background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', fontWeight: 700 }}
            onClick={e => { e.stopPropagation(); onDone(t); }}>✅ Done — Check Out</button>
        </div>
      )}
    </div>
  );
}

export default function CalendarTab() {
  const { isAdmin, academyId, user, appUser } = useAuth();
  const { sports, batches } = useAcademyData();

  const [view, setView] = useState('month'); // 'month' | 'day' | 'list'
  const [monthAnchor, setMonthAnchor] = useState(todayIso());
  const [dayDate, setDayDate] = useState(todayIso());
  const [listFrom, setListFrom] = useState(todayIso());
  const [listTo, setListTo] = useState(todayIso());
  const [staffFilter, setStaffFilter] = useState('ALL');
  const [popup, setPopup] = useState(null); // 'staff' | null

  const [tasks, setTasks] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showAssign, setShowAssign] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [viewTask, setViewTask] = useState(null);
  const [showLeave, setShowLeave] = useState(false);
  const [showLeaveList, setShowLeaveList] = useState(false);

  const load = async () => {
    if (!academyId) return;
    setLoading(true);
    const [ts, us] = await Promise.all([
      supabase.from('week_schedules').select('*').eq('academy_id', academyId),
      supabase.from('app_users').select('*').eq('academy_id', academyId),
    ]);
    setTasks(ts.data || []);
    setAllUsers(us.data || []);
    setStaffList((us.data || []).filter(u => {
      const roles = (u.role || '').split(',').map(r => r.trim());
      return roles.includes('staff') || roles.includes('admin');
    }));
    setLoading(false);
  };
  useEffect(() => { load(); }, [academyId]);

  const staffName = (id) => allUsers.find(u => u.id === id)?.name || id;

  // Visibility scope: admins see everyone, staff only see their own tasks. Latest first.
  const scopedTasks = useMemo(() => {
    let list = tasks;
    if (!isAdmin) list = list.filter(t => t.staff_id === user?.id);
    else if (staffFilter !== 'ALL') list = list.filter(t => t.staff_id === staffFilter);
    return [...list].sort((a, b) => (b.date + (b.in_time || '')).localeCompare(a.date + (a.in_time || '')));
  }, [tasks, isAdmin, staffFilter, user]);

  const countByDate = useMemo(() => {
    const map = {};
    scopedTasks.forEach(t => { map[t.date] = (map[t.date] || 0) + 1; });
    return map;
  }, [scopedTasks]);

  const dayTasks = scopedTasks.filter(t => t.date === dayDate);

  const listTasks = useMemo(() => {
    if (!listFrom && !listTo) return scopedTasks;
    return scopedTasks.filter(t => (!listFrom || t.date >= listFrom) && (!listTo || t.date <= listTo));
  }, [scopedTasks, listFrom, listTo]);

  const listByDate = useMemo(() => {
    const map = {};
    listTasks.forEach(t => { (map[t.date] = map[t.date] || []).push(t); });
    return map;
  }, [listTasks]);

  // ---- actions ----
  const markStarted = async (t) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('week_schedules').update({ status: 'in_progress', started_at: now, started_by: user?.id }).eq('id', t.id);
    if (error) { alert('Failed: ' + error.message); return; }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: 'in_progress', started_at: now, started_by: user?.id } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Checked in for task "${t.task || 'Untitled Task'}" (${t.date})` });
  };
  const markDone = async (t) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('week_schedules').update({ status: 'done', completed_at: now, completed_by: user?.id }).eq('id', t.id);
    if (error) { alert('Failed: ' + error.message); return; }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: 'done', completed_at: now, completed_by: user?.id } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Checked out for task "${t.task || 'Untitled Task'}" (${t.date})` });
  };
  const deleteTask = async (t) => {
    if (!confirm('Delete this task assignment?')) return;
    const { error } = await supabase.from('week_schedules').delete().eq('id', t.id);
    if (error) { alert('Delete failed: ' + error.message); return; }
    setTasks(prev => prev.filter(x => x.id !== t.id));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Deleted task "${t.task || 'Untitled Task'}" for ${staffName(t.staff_id)} (${t.date})` });
  };
  const reportMissed = async (t, reason) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('week_schedules')
      .update({ missed_reason: reason, missed_reported_at: now, missed_reported_by: user?.id })
      .eq('id', t.id);
    if (error) { alert('Failed to send: ' + error.message); return; }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, missed_reason: reason, missed_reported_at: now, missed_reported_by: user?.id } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Reported missed check-in for task "${t.task || 'Untitled Task'}" (${t.date}): ${reason}` });
  };
  const reviewMissed = async (t) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('week_schedules')
      .update({ reviewed_at: now, reviewed_by: user?.id })
      .eq('id', t.id);
    if (error) { alert('Failed: ' + error.message); return; }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, reviewed_at: now, reviewed_by: user?.id } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Reviewed missed check-in for ${staffName(t.staff_id)} — "${t.task || 'Untitled Task'}" (${t.date})` });
  };

  // ---- Month grid ----
  const monthGrid = useMemo(() => {
    const [y, m] = monthAnchor.split('-').map(Number);
    const firstOfMonth = `${y}-${String(m).padStart(2, '0')}-01`;
    const gridStart = getMonday(firstOfMonth);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      cells.push({ d, inMonth: Number(d.slice(5, 7)) === m });
    }
    return cells;
  }, [monthAnchor]);

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 90 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>📅 Calendar</div>
        {isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => { setEditTask(null); setShowAssign(true); }}>+ Assign Task</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn btn-outline btn-sm" onClick={() => setShowLeave(true)}>🏖️ Apply Leave</button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowLeaveList(true)}>🌴 Leave</button>
        {isAdmin && (
          <Link to="/calendar/leave" className="btn btn-outline btn-sm">📊 Leave Count</Link>
        )}
        {isAdmin && (
          <Link to="/calendar/staff-report" className="btn btn-outline btn-sm">📈 Staff Report</Link>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {['month', 'day', 'list'].map(v => (
          <button key={v} className={'freq-day-btn' + (view === v ? ' active' : '')} style={{ flex: 1 }} onClick={() => setView(v)}>
            {v === 'month' ? '🗓️ Month' : v === 'day' ? '📆 Day' : '📋 List'}
          </button>
        ))}
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 8 }}>
          <button className="btn btn-outline btn-sm" style={{ width: '100%', fontSize: 12, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('staff')}>
            {staffFilter === 'ALL' ? 'All Staff' : (staffList.find(u => u.id === staffFilter)?.name || staffFilter)}
          </button>
        </div>
      )}

      {popup === 'staff' && isAdmin && (
        <FilterPopup title="Filter by Staff" onClose={() => setPopup(null)}>
          <RadioRow name="staffsel" checked={staffFilter === 'ALL'} onChange={() => { setStaffFilter('ALL'); setPopup(null); }} label="All Staff" />
          {staffList.map(u => (
            <RadioRow key={u.id} name="staffsel" checked={staffFilter === u.id} onChange={() => { setStaffFilter(u.id); setPopup(null); }} label={u.name || u.id} />
          ))}
        </FilterPopup>
      )}
      {view === 'list' && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 10, alignItems: 'center', flexWrap: 'nowrap' }}>
          <input type="date" className="form-input" style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '8px 6px' }} value={listFrom} onChange={e => setListFrom(e.target.value)} />
          <span style={{ fontSize: 11, color: 'var(--gray)', flexShrink: 0 }}>–</span>
          <input type="date" className="form-input" style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '8px 6px' }} value={listTo} onChange={e => setListTo(e.target.value)} />
          {(listFrom || listTo) && (
            <button className="btn btn-outline btn-sm" style={{ flexShrink: 0, padding: '6px 9px' }} onClick={() => { setListFrom(''); setListTo(''); }}>✕</button>
          )}
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20 }}>Loading…</div>}

      {!loading && view === 'month' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button className="btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setMonthAnchor(addMonths(monthAnchor, -1))}>‹</button>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--offwhite)' }}>{monthLabel(monthAnchor)}</div>
            <button className="btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setMonthAnchor(addMonths(monthAnchor, 1))}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 6 }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--gray)', textTransform: 'uppercase' }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
            {monthGrid.map(({ d, inMonth }) => {
              const isToday = d === todayIso();
              const count = countByDate[d] || 0;
              return (
                <div key={d} onClick={() => { setDayDate(d); setView('day'); }}
                  style={{
                    aspectRatio: '1', minHeight: 44, borderRadius: 8, cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                    background: isToday ? 'var(--accent2)' : 'var(--card2)', opacity: inMonth ? 1 : 0.35,
                  }}>
                  <div style={{ fontSize: 12, fontWeight: isToday ? 800 : 600, color: isToday ? '#fff' : 'var(--offwhite)' }}>{Number(d.slice(8, 10))}</div>
                  {count > 0 && (
                    <div style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 99, background: isToday ? 'rgba(255,255,255,.3)' : 'var(--accent2)', color: '#fff' }}>{count}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--gray)', textAlign: 'center', marginTop: 8 }}>Use arrows to change month</div>
        </>
      )}

      {!loading && view === 'day' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
            <button className="btn" style={{ padding: '5px 16px', fontSize: 16, minWidth: 44, flexShrink: 0 }} onClick={() => setDayDate(addDays(dayDate, -1))}>‹</button>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--offwhite)', textAlign: 'center', flex: 1 }}>{dayName(dayDate)}, {shortDate(dayDate)}</div>
            <button className="btn" style={{ padding: '5px 16px', fontSize: 16, minWidth: 44, flexShrink: 0 }} onClick={() => setDayDate(addDays(dayDate, 1))}>›</button>
          </div>
          {dayTasks.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--gray)' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
              <div style={{ fontSize: 13 }}>No tasks scheduled for this day</div>
            </div>
          ) : dayTasks.map(t => (
            <TaskCard key={t.id} t={t} isAdmin={isAdmin} staffName={staffName} onView={setViewTask} onStart={markStarted} onDone={markDone} />
          ))}
        </>
      )}

      {!loading && view === 'list' && (
        listTasks.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--gray)' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 13 }}>{isAdmin ? 'No scheduled tasks found. Try adjusting filters.' : 'No tasks assigned to you yet.'}</div>
          </div>
        ) : Object.keys(listByDate).sort().reverse().map(date => (
          <div key={date} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent2)', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{dayName(date)}, {shortDate(date)}</span>
              {date === todayIso() && <span style={{ fontSize: 9, background: 'var(--accent2)', color: '#fff', padding: '2px 7px', borderRadius: 99 }}>TODAY</span>}
            </div>
            {listByDate[date].map(t => (
              <TaskCard key={t.id} t={t} isAdmin={isAdmin} staffName={staffName} onView={setViewTask} onStart={markStarted} onDone={markDone} />
            ))}
          </div>
        ))
      )}

      {showAssign && (
        <TaskScheduleModal
          academyId={academyId}
          userId={user?.id}
          sports={sports}
          batches={batches}
          staff={staffList}
          editTask={editTask}
          onClose={() => { setShowAssign(false); setEditTask(null); }}
          onSaved={() => { setShowAssign(false); setEditTask(null); load(); }}
        />
      )}

      {viewTask && (
        <ViewTaskModal
          task={viewTask}
          isAdmin={isAdmin}
          userId={user?.id}
          staffName={staffName}
          onClose={() => setViewTask(null)}
          onEdit={(t) => { setEditTask(t); setShowAssign(true); }}
          onDelete={deleteTask}
          onStart={markStarted}
          onDone={markDone}
          onReportMissed={reportMissed}
          onReviewMissed={reviewMissed}
        />
      )}

      {showLeave && (
        <ApplyLeaveModal
          academyId={academyId}
          userId={user?.id}
          userName={appUser?.name || user?.email}
          isAdmin={isAdmin}
          staffList={staffList}
          tasks={tasks}
          onClose={() => setShowLeave(false)}
          onSubmitted={() => { setShowLeave(false); load(); }}
        />
      )}

      {showLeaveList && (
        <LeaveListModal
          academyId={academyId}
          isAdmin={isAdmin}
          userId={user?.id}
          reviewerName={appUser?.name || user?.email}
          tasks={tasks}
          staffList={staffList}
          onClose={() => setShowLeaveList(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}
