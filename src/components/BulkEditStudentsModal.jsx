import { useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabaseClient';
import { buildBatchKey } from '../lib/batchKey';
import { rollPrefix, nextRollNumbers } from '../lib/rollNumber';

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', marginBottom: 5 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// Bulk-edit School, Sport, Batch (and optionally re-number roll numbers) for a
// selected set of students. Leave a field blank/unchecked to leave it unchanged.
export default function BulkEditStudentsModal({ students, selectedIds, allStudents, sports, batches, academyId, mode = 'active', onClose, onSaved }) {
  const isDroppedMode = mode === 'dropped';
  const selected = students.filter(s => selectedIds.has(s.id));
  const [changeSchool, setChangeSchool] = useState(false);
  const [school, setSchool] = useState('');
  const [changeSportBatch, setChangeSportBatch] = useState(false);
  const [sport, setSport] = useState(sports[0]?.name || '');
  const [batchLabel, setBatchLabel] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [regenerateRoll, setRegenerateRoll] = useState(false);
  // In active mode this checkbox drops the selected students; in dropped
  // mode it restores them back to active instead.
  const [changeStatus, setChangeStatus] = useState(isDroppedMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const batchOptions = batches.filter(b => b.sport === sport);
  const previewPrefix = changeSportBatch && sport && batchLabel ? rollPrefix(sport, batchLabel) : null;

  const save = async () => {
    if (changeSportBatch && (!sport || !batchLabel)) { setError('Pick both Sport and Batch, or turn that section off.'); return; }
    if (changeSportBatch && !changeReason.trim()) { setError('Please provide a reason for the sport/batch change.'); return; }
    if (!changeSchool && !changeSportBatch && !changeStatus) { setError('Turn on at least one option to apply.'); return; }
    setSaving(true);
    setError('');

    let rollAssignments = {}; // student.id -> new roll_no
    if (changeSportBatch && regenerateRoll) {
      const prefix = rollPrefix(sport, batchLabel);
      const existingRolls = allStudents.map(s => s.roll_no).filter(Boolean);
      const fresh = nextRollNumbers(prefix, existingRolls, selected.length);
      selected.forEach((s, i) => { rollAssignments[s.id] = fresh[i]; });
    }

    // Fetch every selected student's current enrollments up front (one query)
    // so the per-student loop below can diff against them without a
    // round-trip per student.
    let existingEnrollments = [];
    if (changeSportBatch) {
      const { data, error: fetchErr } = await supabase.from('enrollments')
        .select('id, student_id, sport, batch, active')
        .in('student_id', selected.map(s => s.id)).eq('academy_id', academyId);
      if (fetchErr) { setError(fetchErr.message); setSaving(false); return; }
      existingEnrollments = data || [];
    }

    try {
      for (const s of selected) {
        const payload = {};
        if (changeSchool) payload.address = school || null;
        if (changeSportBatch) payload.batch = buildBatchKey(sport, batchLabel);
        if (rollAssignments[s.id]) payload.roll_no = rollAssignments[s.id];
        if (changeStatus) {
          if (isDroppedMode) { payload.banned = false; payload.banned_on = null; }
          else { payload.banned = true; payload.banned_on = new Date().toISOString(); }
        }
        if (Object.keys(payload).length > 0) {
          const { error: err } = await supabase.from('students').update(payload).eq('id', s.id);
          if (err) throw err;
        }

        if (changeSportBatch) {
          // Bulk "Change Sport/Batch" moves the student to exactly one new
          // sport+batch: deactivate whatever else was active for them (kept
          // as history, not deleted) and upsert the new one as active —
          // same pattern as AddStudentModal's single-student edit.
          const mine = existingEnrollments.filter(e => e.student_id === s.id);
          const staysActive = mine.find(e => e.active && e.sport === sport && e.batch === batchLabel);
          const toDeactivate = mine.filter(e => e.active && !(e.sport === sport && e.batch === batchLabel)).map(e => e.id);
          if (toDeactivate.length > 0) {
            const { error: deactErr } = await supabase.from('enrollments')
              .update({ active: false, left_date: new Date().toISOString().slice(0, 10), end_reason: changeReason.trim() })
              .in('id', toDeactivate);
            if (deactErr) throw deactErr;
          }
          if (!staysActive) {
            const { error: enrollErr } = await supabase.from('enrollments').upsert({
              academy_id: academyId, student_id: s.id, sport, batch: batchLabel,
              join_date: new Date().toISOString().slice(0, 10), active: true,
            }, { onConflict: 'student_id,sport,batch' });
            if (enrollErr) throw enrollErr;
          }
        }
      }
      onSaved();
    } catch (e) {
      setError(e.message || 'Bulk update failed.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999 }}>
      <div style={{
        background: 'var(--card)', width: '100%', maxWidth: 480, margin: '0 auto',
        height: '100%', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          background: 'var(--card2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>{isDroppedMode ? '↩️' : '✏️'}</span>
            <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--offwhite)' }}>{isDroppedMode ? 'Restore' : 'Bulk Edit'} ({selected.length})</span>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 15, color: 'var(--gray)' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px' }}>
              ⚠️ {error}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--gray)' }}>
            Applies to {selected.length} selected student{selected.length === 1 ? '' : 's'}. Turn on only the fields you want to change.
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              <input type="checkbox" checked={changeSchool} onChange={e => setChangeSchool(e.target.checked)} />
              🏫 Change School
            </label>
            {changeSchool && (
              <Field label="School Name">
                <input className="form-input" placeholder="School / College name" value={school} onChange={e => setSchool(e.target.value)} />
              </Field>
            )}
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              <input type="checkbox" checked={changeSportBatch} onChange={e => setChangeSportBatch(e.target.checked)} />
              🏆 Change Sport / Batch
            </label>
            {changeSportBatch && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label="Sport">
                    <select className="form-select" value={sport} onChange={e => { setSport(e.target.value); setBatchLabel(''); }}>
                      {sports.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Batch">
                    <select className="form-select" value={batchLabel} onChange={e => setBatchLabel(e.target.value)}>
                      <option value="">Select batch</option>
                      {batchOptions.map(b => <option key={b.id} value={b.batchLabel}>{b.batchLabel}</option>)}
                    </select>
                  </Field>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                  <input type="checkbox" checked={regenerateRoll} onChange={e => setRegenerateRoll(e.target.checked)} />
                  Re-assign roll numbers to match new batch{previewPrefix ? ` (${previewPrefix}01, ${previewPrefix}02…)` : ''}
                </label>
                <Field label="Reason for sport/batch change" required>
                  <input className="form-input" placeholder="e.g. Term restructuring — merged into one batch"
                    value={changeReason} onChange={e => setChangeReason(e.target.value)} />
                </Field>
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: isDroppedMode ? '#22c55e' : '#ef4444' }}>
              <input type="checkbox" checked={changeStatus} onChange={e => setChangeStatus(e.target.checked)} />
              {isDroppedMode ? '↩️ Move to Active' : '🚫 Move to Dropped / Blocked'}
            </label>
            {changeStatus && (
              <div style={{ fontSize: 11.5, color: 'var(--gray)', marginTop: 6 }}>
                {isDroppedMode
                  ? `These ${selected.length} student${selected.length === 1 ? '' : 's'} will be restored and moved back to the Active Students section.`
                  : `These ${selected.length} student${selected.length === 1 ? '' : 's'} will be marked as Dropout and moved to the Dropped Students section.`}
              </div>
            )}
          </div>
        </div>

        <div style={{
          display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)',
          flexShrink: 0, background: 'var(--card2)', boxShadow: '0 -4px 12px rgba(0,0,0,.04)',
        }}>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center', padding: '10px 0' }} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" style={{ flex: 1.4, justifyContent: 'center', padding: '10px 0' }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : changeStatus && !changeSchool && !changeSportBatch
              ? (isDroppedMode ? `↩️ Restore ${selected.length}` : `🚫 Drop ${selected.length}`)
              : `💾 Apply to ${selected.length}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
