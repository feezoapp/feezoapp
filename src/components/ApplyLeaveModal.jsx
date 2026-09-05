import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { logActivity } from '../lib/auditLog';
import { todayIso } from '../lib/calendarDate';
import PanelWindow from './PanelWindow';

// Self-apply (any staff/admin applying for their own leave) always goes in
// as 'pending' — nobody can approve their own leave (see LeaveListModal).
// An admin picking a DIFFERENT staff member from the dropdown is recording
// leave administratively, so that path skips the pending queue, goes in
// pre-approved, and — like the approve flow in LeaveListModal — offers to
// reassign that staff's conflicting tasks for the day right away.
export default function ApplyLeaveModal({ academyId, userId, userName, isAdmin, staffList, tasks, onClose, onSubmitted }) {
  const [targetStaffId, setTargetStaffId] = useState(userId);
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reassignTo, setReassignTo] = useState('');
  const [showReassignStep, setShowReassignStep] = useState(false);

  const actingForOther = isAdmin && targetStaffId !== userId;
  const targetName = actingForOther ? (staffList.find(u => u.id === targetStaffId)?.name || targetStaffId) : userName;

  const tasksForTarget = useMemo(
    () => (tasks || []).filter(t => t.staff_id === targetStaffId),
    [tasks, targetStaffId]
  );
  const conflicts = tasksForTarget.filter(t => t.date === date && t.status !== 'done' && t.status !== 'cancelled');

  // Earliest scheduled start time today for the target — self-apply only,
  // so a staff member can't sneak in leave once their day already started.
  // Doesn't apply when an admin is recording leave for someone else.
  const earliestTodayStart = tasksForTarget
    .filter(t => t.date === todayIso() && t.in_time && t.status !== 'done' && t.status !== 'cancelled')
    .map(t => t.in_time)
    .sort()[0];

  const resetReassignStep = () => { setShowReassignStep(false); setReassignTo(''); };

  const finalizeSubmit = async () => {
    setSaving(true);
    try {
      const dupStatuses = actingForOther ? ['pending', 'approved'] : ['pending'];
      const { data: existing } = await supabase.from('leave_requests').select('id')
        .eq('academy_id', academyId).eq('staff_id', targetStaffId).eq('date', date).in('status', dupStatuses).maybeSingle();
      if (existing) { setError(`${actingForOther ? targetName : 'You'} already ${actingForOther ? 'has' : 'have'} a ${dupStatuses.join('/')} leave request for this date`); setSaving(false); return; }

      if (actingForOther && reassignTo) {
        const ids = conflicts.map(t => t.id);
        if (ids.length) {
          const { error: taskErr } = await supabase.from('week_schedules').update({ staff_id: reassignTo }).in('id', ids);
          if (taskErr) throw taskErr;
          logActivity({ academyId, actorId: userId, actorName: userName, message: `Reassigned ${ids.length} task(s) from ${targetName} to ${staffList.find(u => u.id === reassignTo)?.name || reassignTo} on ${date}` });
        }
      }

      const now = new Date().toISOString();
      const row = {
        id: crypto.randomUUID(),
        academy_id: academyId, staff_id: targetStaffId, staff_name: targetName, date,
        reason: reason.trim(), applied_at: now,
        status: actingForOther ? 'approved' : 'pending',
      };
      if (actingForOther) { row.reviewed_by = userName; row.reviewed_at = now; }

      const { error: err } = await supabase.from('leave_requests').insert(row);
      if (err) throw err;

      logActivity({
        academyId, actorId: userId, actorName: userName,
        message: actingForOther
          ? `Recorded leave for ${targetName} on ${date}`
          : `Applied for leave on ${date}`,
      });
      onSubmitted();
    } catch (err) {
      setError(err.message || 'Failed to submit');
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    setError('');
    if (!date) { setError('Please select a date'); return; }
    if (!reason.trim()) { setError('Please enter a reason'); return; }

    if (!actingForOther) {
      const today = todayIso();
      if (date < today) { setError('Cannot apply for leave on a past date'); return; }
      if (date === today && earliestTodayStart) {
        const now = new Date();
        const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (nowHM >= earliestTodayStart) {
          setError(`Cannot apply for leave today — your task at ${earliestTodayStart} has already started`);
          return;
        }
      }
    }

    // Admin recording leave for someone else with conflicting tasks that day:
    // offer reassignment before writing anything, same UX as approving from
    // the Leave Requests list.
    if (actingForOther && conflicts.length > 0 && !showReassignStep) {
      setShowReassignStep(true);
      return;
    }

    finalizeSubmit();
  };

  return (
    <PanelWindow onClose={onClose}>
      <div
        className="modal"
        style={{ width: '100%', maxWidth: 400, height: '100%', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        <div className="modal-title" style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', margin: 0 }}>
          <span>🏖️ {isAdmin ? 'Apply / Record Leave' : 'Apply for Leave'}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px', minHeight: 0 }}>
          {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

          {isAdmin && (
            <div className="form-group">
              <label className="form-label">Leave For</label>
              <select
                className="form-select"
                value={targetStaffId}
                onChange={e => { setTargetStaffId(e.target.value); resetReassignStep(); }}
              >
                <option value={userId}>{userName} (You)</option>
                {staffList.filter(u => u.id !== userId).map(u => (
                  <option key={u.id} value={u.id}>{u.name || u.id}</option>
                ))}
              </select>
              {actingForOther && (
                <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 3 }}>Recorded directly as approved — no separate review needed.</div>
              )}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Leave Date</label>
            <input
              type="date" className="form-input" value={date}
              min={!actingForOther ? todayIso() : undefined}
              onChange={e => { setDate(e.target.value); resetReassignStep(); }}
            />
            {!actingForOther && date === todayIso() && earliestTodayStart && (
              <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 3 }}>Must be applied before {earliestTodayStart} today</div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Reason</label>
            <textarea className="form-input" rows={3} style={{ resize: 'none' }} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Personal work, medical appointment…" />
          </div>

          {conflicts.length > 0 && !showReassignStep && (
            <div style={{ background: '#f59e0b18', border: '1px solid #f59e0b44', borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: '#b45309' }}>
              ⚠️ {actingForOther ? targetName : 'You'} {actingForOther ? 'has' : 'have'} <b>{conflicts.length} task{conflicts.length > 1 ? 's' : ''}</b> scheduled on this day.{' '}
              {actingForOther ? "You'll be asked to reassign them next." : 'Admin will be notified to reassign.'}
            </div>
          )}

          {showReassignStep && (
            <div style={{ background: '#f59e0b18', border: '1px solid #f59e0b44', borderRadius: 10, padding: 10, marginBottom: 12 }}>
              <div style={{ fontSize: 11.5, color: '#b45309', marginBottom: 7 }}>
                ⚠️ {targetName} has {conflicts.length} task(s) on {date}. Reassign to:
              </div>
              <select className="form-select" style={{ width: '100%', fontSize: 12, marginBottom: 7 }} value={reassignTo} onChange={e => setReassignTo(e.target.value)}>
                <option value="">Leave as is / handle later</option>
                {staffList.filter(u => u.id !== targetStaffId).map(u => <option key={u.id} value={u.id}>{u.name || u.id}</option>)}
              </select>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '14px 20px', flexShrink: 0, borderTop: '1px solid var(--border)' }}>
          <button className="btn" style={{ flex: 1, background: 'var(--card2)' }} onClick={showReassignStep ? resetReassignStep : onClose}>
            {showReassignStep ? 'Back' : 'Cancel'}
          </button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : showReassignStep ? '✅ Confirm & Add Leave' : actingForOther ? '➕ Add Leave' : '📤 Submit Request'}
          </button>
        </div>
      </div>
    </PanelWindow>
  );
}
