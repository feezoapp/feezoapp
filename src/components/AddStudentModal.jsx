import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { logActivity } from '../lib/auditLog';
import { buildBatchKey } from '../lib/batchKey';
import { generateRollNumber } from '../lib/rollNumber';
import { normalizePhone, isValidPhone } from '../lib/phone';
import AchievementPicker from './AchievementPicker';
import AchievementsSection from './AchievementsSection';

function calcAge(dobIso) {
  if (!dobIso) return '';
  const d = new Date(dobIso);
  if (isNaN(d)) return '';
  const today = new Date();
  if (d > today) return '';
  let age = today.getFullYear() - d.getFullYear();
  const mDiff = today.getMonth() - d.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function calcBMI(heightCm, weightKg) {
  const h = parseFloat(heightCm);
  const w = parseFloat(weightKg);
  if (!h || !w || h <= 0 || w <= 0) return '';
  const m = h / 100;
  return (w / (m * m)).toFixed(1);
}

function Field({ label, required, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', marginBottom: 5, letterSpacing: '.2px' }}>
        {label}{required && <span style={{ color: '#dc2626' }}> *</span>}
      </label>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent2)', textTransform: 'uppercase', letterSpacing: '.6px', margin: '4px 0 2px' }}>
      {children}
    </div>
  );
}

// Pass `student` to edit an existing row instead of creating a new one.
// Pass `initial` (add-mode only) to pre-fill a new student's form, e.g. when
// converting an enquiry — a new row is still created, unlike `student`.
export default function AddStudentModal({ academyId, sports, batches, student, initial, existingStudents = [], onClose, onSaved }) {
  const { appUser } = useAuth();
  const { applyStudentSave, applyEnrollmentSave } = useAcademyData();
  const isEdit = !!student;
  const [form, setForm] = useState(() => isEdit ? {
    roll_no: student.roll_no || '', name: student.name || '', dob: student.dob || '', gender: student.gender || '',
    height: student.height || '', weight: student.weight || '',
    parent: student.parent || '', contact: student.contact || '', contact2: student.contact2 || '',
    address: student.address || '', join_date: student.join_date || todayIso(),
    enrollments: [{ sport: student.sport || sports[0]?.name || '', batch: student.batchLabel || '' }],
  } : {
    roll_no: '', name: initial?.name || '', dob: '', gender: '', height: '', weight: '', parent: initial?.parent || '',
    contact: initial?.contact || '', contact2: '', address: '',
    join_date: todayIso(), enrollments: [{ sport: initial?.sport || sports[0]?.name || '', batch: '' }],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pendingAchievements, setPendingAchievements] = useState([]); // add-mode only, staged until student is saved
  const rollNoTouched = useRef(isEdit); // once user hand-edits roll_no, stop auto-filling it

  // In edit mode, load the student's real sport/batch enrollments from the
  // `enrollments` table (a student can be enrolled in several). Falls back
  // to the single sport/batch already on the row if none exist yet.
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('enrollments').select('sport, batch')
        .eq('student_id', student.id).eq('academy_id', academyId).order('created_at');
      if (cancelled) return;
      if (data && data.length > 0) {
        setForm(f => ({ ...f, enrollments: data.map(e => ({ sport: e.sport || '', batch: e.batch || '' })) }));
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, student, academyId]);

  const age = calcAge(form.dob);
  const bmi = calcBMI(form.height, form.weight);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const primaryEnrollment = form.enrollments[0] || { sport: '', batch: '' };

  const updateEnrollment = (idx, key, value) => {
    setForm(f => {
      const next = f.enrollments.map((en, i) => {
        if (i !== idx) return en;
        if (key === 'sport') return { sport: value, batch: '' }; // batch resets when sport changes
        return { ...en, [key]: value };
      });
      return { ...f, enrollments: next };
    });
  };

  const addEnrollmentRow = () => {
    setForm(f => ({ ...f, enrollments: [...f.enrollments, { sport: sports[0]?.name || '', batch: '' }] }));
  };

  const removeEnrollmentRow = (idx) => {
    setForm(f => ({ ...f, enrollments: f.enrollments.length > 1 ? f.enrollments.filter((_, i) => i !== idx) : f.enrollments }));
  };

  // Auto-fill roll number as (Sport initial)(Batch initial) + next 2-digit sequence,
  // e.g. Silambam + Morning Batch -> SM01. Based on the student's first/primary
  // sport-batch. Stops once the user types a custom roll no.
  useEffect(() => {
    if (isEdit || rollNoTouched.current) return;
    if (!primaryEnrollment.sport || !primaryEnrollment.batch) return;
    const existingRolls = existingStudents.map(s => s.roll_no).filter(Boolean);
    const auto = generateRollNumber(primaryEnrollment.sport, primaryEnrollment.batch, existingRolls);
    setForm(f => ({ ...f, roll_no: auto }));
  }, [primaryEnrollment.sport, primaryEnrollment.batch, isEdit, existingStudents]);

  const onRollNoChange = (e) => {
    rollNoTouched.current = true;
    setForm(f => ({ ...f, roll_no: e.target.value }));
  };

  const save = async () => {
    if (!form.name || !form.contact) { setError('Full name and Contact Number 1 are required.'); return; }
    if (!isValidPhone(form.contact)) { setError('Contact Number 1 must be a 10-digit number (no +91 needed).'); return; }
    if (form.contact2 && !isValidPhone(form.contact2)) { setError('Contact Number 2 must be a 10-digit number (no +91 needed).'); return; }
    if (form.roll_no) {
      const dupe = existingStudents.find(s =>
        s.roll_no && s.roll_no.toUpperCase() === form.roll_no.toUpperCase() && (!isEdit || s.id !== student.id)
      );
      if (dupe) { setError(`Roll number "${form.roll_no}" is already used by ${dupe.name}.`); return; }
    }
    const validEnrollments = form.enrollments.filter(en => en.sport && en.batch);
    if (validEnrollments.length === 0) { setError('Select at least one sport and batch.'); return; }
    const seenPairs = new Set();
    for (const en of validEnrollments) {
      const key = `${en.sport}||${en.batch}`;
      if (seenPairs.has(key)) { setError(`"${en.sport} · ${en.batch}" is selected more than once.`); return; }
      seenPairs.add(key);
    }
    setSaving(true);
    setError('');
    const primary = validEnrollments[0];
    const payload = {
      roll_no: form.roll_no || null,
      name: form.name,
      dob: form.dob || null,
      age: age ? String(age) : null,
      gender: form.gender || null,
      height: form.height ? String(form.height) : null,
      weight: form.weight ? String(form.weight) : null,
      bmi: bmi || null,
      parent: form.parent || null,
      contact: normalizePhone(form.contact),
      contact2: form.contact2 ? normalizePhone(form.contact2) : null,
      address: form.address || null,
      join_date: form.join_date || null,
      batch: buildBatchKey(primary.sport, primary.batch), // legacy mirror of the primary sport/batch
    };
    const { data: savedRow, error: err } = isEdit
      ? await supabase.from('students').update(payload).eq('id', student.id).select().single()
      : await supabase.from('students').insert({ ...payload, academy_id: academyId }).select().single();
    if (err) {
      setSaving(false);
      setError(err.code === '23505' ? `Roll number "${form.roll_no}" was just taken by another entry — please choose a different one.` : err.message);
      return;
    }

    applyStudentSave(savedRow); // merge immediately — don't wait on the realtime event

    const studentId = isEdit ? student.id : savedRow.id;
    const enrollRows = validEnrollments.map(en => ({
      academy_id: academyId, student_id: studentId, sport: en.sport, batch: en.batch,
      join_date: form.join_date || null, active: true,
    }));
    let toDeleteIds = [];
    if (isEdit) {
      // Diff against what's actually in the DB rather than delete-everything:
      // only remove enrollments for sport+batch pairs no longer in the form,
      // then upsert on (student_id, sport, batch) — a student can now hold
      // multiple batches of the same sport, so batch is part of the key too.
      const { data: existing, error: fetchErr } = await supabase.from('enrollments')
        .select('id, sport, batch').eq('student_id', studentId).eq('academy_id', academyId);
      if (fetchErr) { setSaving(false); setError(fetchErr.message); return; }
      const keepKeys = new Set(validEnrollments.map(en => `${en.sport}||${en.batch}`));
      toDeleteIds = (existing || [])
        .filter(e => !keepKeys.has(`${e.sport}||${e.batch}`))
        .map(e => e.id);
      if (toDeleteIds.length > 0) {
        const { error: delErr } = await supabase.from('enrollments').delete().in('id', toDeleteIds);
        if (delErr) { setSaving(false); setError(delErr.message); return; }
      }
    }
    const { data: savedEnrollRows, error: enrollErr } = await supabase.from('enrollments')
      .upsert(enrollRows, { onConflict: 'student_id,sport,batch' })
      .select();
    setSaving(false);
    if (enrollErr) { setError(enrollErr.message); return; }
    applyEnrollmentSave(savedEnrollRows, toDeleteIds); // merge immediately — don't wait on the realtime event

    if (!isEdit && pendingAchievements.length > 0 && savedRow) {
      const rows = pendingAchievements.map(({ _tmpId, ...a }) => ({ ...a, student_id: savedRow.id, academy_id: academyId }));
      await supabase.from('achievements').insert(rows);
    }
    logActivity({
      academyId, actorId: appUser?.id, actorName: appUser?.name,
      message: isEdit ? `Edited student ${form.name}` : `Added new student ${form.name}`,
    });
    onSaved();
  };

  const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 };

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
            <span style={{ fontSize: 18 }}>{isEdit ? '✏️' : '👤'}</span>
            <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--offwhite)' }}>{isEdit ? 'Edit Student' : 'Add Student'}</span>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 15, color: 'var(--gray)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px' }}>
              ⚠️ {error}
            </div>
          )}

          <div>
            <SectionLabel>Basic Details</SectionLabel>
            <div style={{ ...gridStyle, marginTop: 6 }}>
              <Field label="Roll Number">
                <input className="form-input" placeholder="Auto-assigned" value={form.roll_no} onChange={onRollNoChange} />
              </Field>
              <Field label="Full Name" required>
                <input className="form-input" placeholder="Student full name" value={form.name} onChange={set('name')} />
              </Field>
            </div>

            <div style={{ ...gridStyle, marginTop: 10 }}>
              <Field label="Contact Number 1" required>
                <input className="form-input" placeholder="00000-00000" value={form.contact}
                  maxLength={10} onChange={e => setForm(f => ({ ...f, contact: normalizePhone(e.target.value).slice(0, 10) }))} />
              </Field>
              <Field label="Contact Number 2">
                <input className="form-input" placeholder="00000-00000" value={form.contact2}
                  maxLength={10} onChange={e => setForm(f => ({ ...f, contact2: normalizePhone(e.target.value).slice(0, 10) }))} />
              </Field>
            </div>

            <div style={{ marginTop: 10 }}>
              <Field label="Joining Date" required>
                <input className="form-input" type="date" value={form.join_date} onChange={set('join_date')} />
              </Field>
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.enrollments.map((en, idx) => {
                const batchOptions = batches.filter(b => b.sport === en.sport);
                return (
                  <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Field label={idx === 0 ? 'Sport' : `Sport ${idx + 1}`}>
                        <select className="form-select" value={en.sport} onChange={e => updateEnrollment(idx, 'sport', e.target.value)}>
                          {sports.length === 0 && <option value="">No sports added yet</option>}
                          {sports.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                        </select>
                      </Field>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Field label={idx === 0 ? 'Batch' : `Batch ${idx + 1}`}>
                        <select className="form-select" value={en.batch} onChange={e => updateEnrollment(idx, 'batch', e.target.value)}>
                          <option value="">Select batch</option>
                          {batchOptions.map(b => <option key={b.id} value={b.batchLabel}>{b.batchLabel}</option>)}
                        </select>
                      </Field>
                    </div>
                    {form.enrollments.length > 1 && (
                      <button type="button" onClick={() => removeEnrollmentRow(idx)} aria-label="Remove sport/batch"
                        style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card2)', color: 'var(--gray)', cursor: 'pointer', flexShrink: 0, fontSize: 14 }}>
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
              <button type="button" onClick={addEnrollmentRow}
                style={{ alignSelf: 'flex-start', fontSize: 12, fontWeight: 700, color: 'var(--accent2)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
                + Add another sport / batch
              </button>
            </div>

            <div style={{ ...gridStyle, marginTop: 10 }}>
              <Field label="Date of Birth">
                <input className="form-input" type="date" value={form.dob} onChange={set('dob')} />
              </Field>
              <Field label="Age">
                <input className="form-input" value={age} placeholder="Auto" disabled style={{ opacity: .65, cursor: 'not-allowed' }} />
              </Field>
            </div>
            <div style={{ marginTop: 10 }}>
              <Field label="Gender">
                <select className="form-select" value={form.gender} onChange={set('gender')}>
                  <option value="">Select</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </Field>
            </div>
            <div style={{ marginTop: 10 }}>
              <Field label="Parent / Guardian Name">
                <input className="form-input" placeholder="Parent name" value={form.parent} onChange={set('parent')} />
              </Field>
            </div>
            <div style={{ marginTop: 10 }}>
              <Field label="School Name">
                <input className="form-input" placeholder="School / College name" value={form.address} onChange={set('address')} />
              </Field>
            </div>
            <div style={{ ...gridStyle, marginTop: 10 }}>
              <Field label="Height (cm)">
                <input className="form-input" type="number" inputMode="decimal" placeholder="e.g. 150"
                  value={form.height} onChange={set('height')} />
              </Field>
              <Field label="Weight (kg)">
                <input className="form-input" type="number" inputMode="decimal" placeholder="e.g. 45"
                  value={form.weight} onChange={set('weight')} />
              </Field>
              <Field label="BMI">
                <input className="form-input" value={bmi} placeholder="Auto" disabled style={{ opacity: .65, cursor: 'not-allowed' }} />
              </Field>
            </div>
          </div>

          <div>
            {isEdit
              ? <AchievementsSection studentId={student.id} academyId={academyId} canEdit={true} />
              : <AchievementPicker items={pendingAchievements} setItems={setPendingAchievements} />}
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
            {saving ? 'Saving…' : isEdit ? '💾 Save Changes' : '💾 Save Student'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
