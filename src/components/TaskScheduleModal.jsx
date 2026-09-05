import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { expandDates, isoToDisplay, todayIso } from '../lib/calendarDate';
import PanelWindow from './PanelWindow';

const DAY_CHIPS = [
  { v: 0, l: 'Sun' }, { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' },
];

const DATE_MODES = [
  { v: 'single', l: '📆 Single Date' },
  { v: 'multiple', l: '🗓️ Multiple Dates' },
  { v: 'recurring', l: '🔁 Recurring' },
];

// Shared compact sizing applied to every field box in this modal — every
// box except the Note textarea, per request.
const compact = { padding: '6px 10px', fontSize: 13 };

// ---- 12-hour time helpers ----
// Internal state stays "HH:MM" 24h (matches DB column / previous behavior).
// These only convert for display in the picker.
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => i);

function to12h(hhmm) {
  if (!hhmm) return { h: '', m: '', ampm: 'AM' };
  const [hStr, mStr] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return { h: String(h), m: String(m).padStart(2, '0'), ampm };
}

function to24h(h, m, ampm) {
  if (h === '' || m === '') return '';
  let hh = parseInt(h, 10) % 12;
  if (ampm === 'PM') hh += 12;
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function TimePicker12({ label, value, onChange }) {
  const { h, m, ampm } = to12h(value);

  const update = (nh, nm, nampm) => {
    if (nh === '' || nm === '') { onChange(''); return; }
    onChange(to24h(nh, nm, nampm));
  };

  return (
    <div>
      <label className="form-label">{label}</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <select
          className="form-select"
          style={{ flex: 1, ...compact }}
          value={h}
          onChange={e => update(e.target.value, m || '00', ampm)}
        >
          <option value="">--</option>
          {HOURS_12.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select
          className="form-select"
          style={{ flex: 1, ...compact }}
          value={m}
          onChange={e => update(h || '12', e.target.value, ampm)}
        >
          <option value="">--</option>
          {MINUTES_60.map(v => <option key={v} value={String(v).padStart(2, '0')}>{String(v).padStart(2, '0')}</option>)}
        </select>
        <select
          className="form-select"
          style={{ flex: 1, ...compact }}
          value={ampm}
          onChange={e => update(h || '12', m || '00', e.target.value)}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </div>
    </div>
  );
}

export default function TaskScheduleModal({ academyId, userId, sports, batches, staff, editTask, onClose, onSaved }) {
  const isEdit = !!editTask;
  const [task, setTask] = useState(editTask?.task || '');
  const [location, setLocation] = useState(editTask?.location || '');
  const [sport, setSport] = useState(editTask?.sport || '');
  const [batch, setBatch] = useState(editTask?.batch || '');

  // Date mode: 'single' | 'multiple' | 'recurring'. Editing always targets
  // the one existing row, so the picker is locked to 'single' for edits
  // (the selector itself is hidden below when isEdit).
  const [dateMode, setDateMode] = useState('single');
  const [dateFrom, setDateFrom] = useState(editTask?.date || todayIso());
  const [dateTo, setDateTo] = useState('');
  const [recurDays, setRecurDays] = useState([]);
  const [multiDates, setMultiDates] = useState([]);
  const [pickDate, setPickDate] = useState('');
  const [inTime, setInTime] = useState(editTask?.in_time || '');
  const [outTime, setOutTime] = useState(editTask?.out_time || '');
  const [note, setNote] = useState(editTask?.note || '');
  const [staffIds, setStaffIds] = useState(editTask ? [editTask.staff_id] : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const batchOptions = useMemo(() => sport ? batches.filter(b => b.sport === sport) : batches, [sport, batches]);

  useEffect(() => {
    // reset batch if it no longer matches the chosen sport
    if (sport && batch) {
      const b = batches.find(x => x.name === batch);
      if (b && b.sport !== sport) setBatch('');
    }
  }, [sport]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMultiDate = () => {
    if (!pickDate) return;
    setMultiDates(prev => prev.includes(pickDate) ? prev : [...prev, pickDate].sort());
    setPickDate('');
  };
  const removeMultiDate = (d) => setMultiDates(prev => prev.filter(x => x !== d));

  const previewDates = useMemo(() => {
    if (dateMode === 'single') return dateFrom ? [dateFrom] : [];
    if (dateMode === 'multiple') return multiDates;
    if (!dateFrom || !dateTo || dateTo <= dateFrom) return [];
    return expandDates(dateFrom, dateTo, recurDays);
  }, [dateMode, dateFrom, dateTo, recurDays, multiDates]);

  const toggleDay = (v) => setRecurDays(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  const toggleStaff = (id) => setStaffIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // New assignments only: today or later, and if it's for today the in-time
  // must still be ahead of the clock. Editing an existing (possibly
  // already-past) task is left alone — that's exactly what the missed-entry
  // warning flow is for.
  const validateNewAssignmentDates = () => {
    const today = todayIso();

    if (dateMode === 'single') {
      if (dateFrom && dateFrom < today) return 'Cannot assign tasks for past dates';
    } else if (dateMode === 'multiple') {
      if (!multiDates.length) return 'Please add at least one date';
      if (multiDates.some(d => d < today)) return 'Cannot assign tasks for past dates';
    } else {
      if (!dateFrom || !dateTo) return 'Please pick both From and To dates for a recurring task';
      if (dateFrom < today || dateTo < today) return 'Cannot assign tasks for past dates';
      if (!recurDays.length) return 'Please select at least one day to repeat on';
    }

    const includesToday = dateMode === 'multiple' ? multiDates.includes(today) : dateFrom === today;
    if (includesToday && inTime) {
      const now = new Date();
      const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (inTime <= nowHM) return 'In Time must be later than the current time for a task assigned today';
    }
    return '';
  };

  const save = async () => {
    setError('');
    if (!task.trim()) { setError('Please enter a task description'); return; }
    if (dateMode === 'single' && !dateFrom) { setError('Please pick a date'); return; }
    if (!staffIds.length) { setError('Please select at least one staff member'); return; }
    if (!isEdit) {
      const dateErr = validateNewAssignmentDates();
      if (dateErr) { setError(dateErr); return; }
    }

    let dates;
    if (isEdit || dateMode === 'single') dates = [dateFrom];
    else if (dateMode === 'multiple') dates = multiDates;
    else {
      dates = expandDates(dateFrom, dateTo, recurDays);
      if (!dates.length) { setError('No matching dates in range for selected days'); return; }
    }

    setSaving(true);
    try {
      if (isEdit) {
        const updRow = {
          task: task.trim(), location: location.trim(), sport, batch,
          date: dateFrom, in_time: inTime || null, out_time: outTime || null, note: note.trim(),
          staff_id: staffIds[0], updated_by: userId, updated_at: new Date().toISOString(),
        };
        const { error: err } = await supabase.from('week_schedules').update(updRow).eq('id', editTask.id);
        if (err) throw err;

        // Extra staff picked while editing → create as new rows
        const extraStaff = staffIds.slice(1);
        if (extraStaff.length) {
          const rows = extraStaff.map(sid => ({
            id: crypto.randomUUID(),
            academy_id: academyId, staff_id: sid, date: dateFrom,
            task: task.trim(), location: location.trim(), sport, batch,
            in_time: inTime || null, out_time: outTime || null, note: note.trim(),
            status: 'scheduled', created_by: userId, created_at: new Date().toISOString(),
          }));
          const { error: e2 } = await supabase.from('week_schedules').insert(rows);
          if (e2) throw e2;
        }
      } else {
        const rows = [];
        dates.forEach(date => {
          staffIds.forEach(sid => {
            rows.push({
              id: crypto.randomUUID(),
              academy_id: academyId, staff_id: sid, date,
              task: task.trim(), location: location.trim(), sport, batch,
              in_time: inTime || null, out_time: outTime || null, note: note.trim(),
              recur_days: dateMode === 'recurring' && recurDays.length ? recurDays : null,
              status: 'scheduled', created_by: userId, created_at: new Date().toISOString(),
            });
          });
        });
        // insert in chunks of 100
        for (let i = 0; i < rows.length; i += 100) {
          const { error: err } = await supabase.from('week_schedules').insert(rows.slice(i, i + 100));
          if (err) throw err;
        }
      }
      onSaved();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelWindow onClose={onClose}>
      <div
        className="modal"
        style={{
          width: '100%',
          maxWidth: 520,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
        }}
      >
        {/* Sticky header */}
        <div className="modal-title" style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', margin: 0 }}>
          <span>{isEdit ? '✏️ Edit Task' : '📅 Assign New Task'}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px', minHeight: 0 }}>
          {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

          <div className="form-group">
            <label className="form-label">Task / Activity *</label>
            <input className="form-input" style={compact} value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. Morning Silambam Training" />
          </div>

          <div style={{ display: 'flex', gap: 8 }} className="form-group">
            <div style={{ flex: 1 }}>
              <label className="form-label">Sport</label>
              <select className="form-select" style={compact} value={sport} onChange={e => setSport(e.target.value)}>
                <option value="">— Any sport —</option>
                {sports.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label">Batch / Class</label>
              <select className="form-select" style={compact} value={batch} onChange={e => setBatch(e.target.value)}>
                <option value="">— Any batch —</option>
                {batchOptions.map(b => <option key={b.id} value={b.name}>{b.batchLabel}</option>)}
              </select>
            </div>
          </div>

          {!isEdit && (
            <div className="form-group">
              <label className="form-label">Date Type</label>
              <select className="form-select" style={compact} value={dateMode} onChange={e => setDateMode(e.target.value)}>
                {DATE_MODES.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
              </select>
            </div>
          )}

          {(isEdit || dateMode === 'single') && (
            <div className="form-group">
              <label className="form-label">Date *</label>
              <input type="date" className="form-input" style={compact} value={dateFrom} min={!isEdit ? todayIso() : undefined} onChange={e => setDateFrom(e.target.value)} />
            </div>
          )}

          {!isEdit && dateMode === 'multiple' && (
            <div className="form-group">
              <label className="form-label">Dates *</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="date" className="form-input" style={{ ...compact, flex: 1 }} value={pickDate} min={todayIso()} onChange={e => setPickDate(e.target.value)} />
                <button type="button" className="btn btn-outline btn-sm" onClick={addMultiDate}>+ Add</button>
              </div>
              {multiDates.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {multiDates.map(d => (
                    <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 16, background: 'var(--card2)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--offwhite)' }}>
                      {isoToDisplay(d)}
                      <button type="button" onClick={() => removeMultiDate(d)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isEdit && dateMode === 'recurring' && (
            <>
              <div style={{ display: 'flex', gap: 8 }} className="form-group">
                <div style={{ flex: 1 }}>
                  <label className="form-label">From Date *</label>
                  <input type="date" className="form-input" style={compact} value={dateFrom} min={todayIso()} onChange={e => setDateFrom(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="form-label">To Date *</label>
                  <input type="date" className="form-input" style={compact} value={dateTo} min={dateFrom || todayIso()} onChange={e => setDateTo(e.target.value)} />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Repeat on days *</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {DAY_CHIPS.map(c => (
                    <label key={c.v} className="ts-day-chip" style={recurDays.includes(c.v) ? { background: 'var(--accent2)', borderColor: 'var(--accent2)', color: '#fff' } : undefined}>
                      <input type="checkbox" checked={recurDays.includes(c.v)} onChange={() => toggleDay(c.v)} style={{ display: 'none' }} />
                      {c.l}
                    </label>
                  ))}
                </div>
                {dateFrom && dateTo && recurDays.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 5 }}>
                    {previewDates.length} occurrence(s) between {isoToDisplay(dateFrom)} and {isoToDisplay(dateTo)}
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8 }} className="form-group">
            <div style={{ flex: 1 }}>
              <TimePicker12 label="In Time" value={inTime} onChange={setInTime} />
              {!isEdit && previewDates.includes(todayIso()) && (
                <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 3 }}>Must be later than the current time</div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <TimePicker12 label="Out Time" value={outTime} onChange={setOutTime} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Location / Venue</label>
            <input className="form-input" style={compact} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Main Hall" />
          </div>

          <div className="form-group">
            <label className="form-label">Assign To * <span style={{ fontSize: 10, color: 'var(--gray)' }}>(multiple staff/admins can share one class)</span></label>
            <div style={{ maxHeight: 160, overflowY: 'auto' }}>
              {staff.length === 0 && <div style={{ fontSize: 12, color: 'var(--gray)' }}>No staff members found. Add staff from Profile → Staff Users.</div>}
              {staff.map(u => (
                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', background: 'var(--card2)', border: '1px solid var(--border)', marginBottom: 5 }}>
                  <input type="checkbox" checked={staffIds.includes(u.id)} onChange={() => toggleStaff(u.id)} style={{ width: 16, height: 16, accentColor: 'var(--accent2)' }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--offwhite)' }}>{u.name || u.id}{u.role === 'admin' ? ' · Admin' : ''}</div>
                    <div style={{ fontSize: 10, color: 'var(--gray)' }}>{u.email || ''}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Note / Instructions</label>
            <textarea className="form-input" rows={2} style={{ resize: 'none' }} value={note} onChange={e => setNote(e.target.value)} placeholder="Any special instructions…" />
          </div>

          {previewDates.length > 0 && staffIds.length > 0 && (
            <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12, color: 'var(--offwhite)' }}>
              Will create <strong>{previewDates.length * staffIds.length}</strong> task record(s):{' '}
              <strong>{previewDates.length}</strong> date(s) × <strong>{staffIds.length}</strong> staff
            </div>
          )}
        </div>

        {/* Sticky footer */}
        <div style={{ display: 'flex', gap: 8, padding: '14px 20px', flexShrink: 0, borderTop: '1px solid var(--border)' }}>
          <button className="btn" style={{ flex: 1, background: 'var(--card2)' }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : '💾 Save'}
          </button>
        </div>
      </div>
    </PanelWindow>
  );
}
