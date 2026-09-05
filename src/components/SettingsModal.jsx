import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { takeSnapshot, parseRetentionDays, pruneOldSnapshots } from '../lib/snapshot';

const THEME_KEY = 'feezo-theme';

function applyTheme(theme) {
  document.body.classList.toggle('dark-theme', theme === 'dark');
}

// Apply the saved theme as soon as this module loads (i.e. as soon as the
// app's JS bundle runs) — not only when SettingsModal happens to mount.
// This fixes the theme resetting to default on a hard page refresh, when
// the modal isn't open yet to apply it via its own useEffect below.
applyTheme(localStorage.getItem(THEME_KEY) || 'light');

const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export default function SettingsModal({ onClose }) {
  const { isAdmin, academyId } = useAuth();
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
  const [showPass, setShowPass] = useState(false);
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [passMsg, setPassMsg] = useState('');
  const [passSaving, setPassSaving] = useState(false);

  const [snapshots, setSnapshots] = useState([]);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [restoringId, setRestoringId] = useState(null); // snapshot id currently restoring
  const [restoreResult, setRestoreResult] = useState(null); // { snapshot_date, completed, rejected, results }

  useEffect(() => { applyTheme(theme); }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  const changePassword = async () => {
    setPassMsg('');
    if (newPass.length < 6) { setPassMsg('Password must be at least 6 characters'); return; }
    if (newPass !== confirmPass) { setPassMsg('Passwords do not match'); return; }
    setPassSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPass });
    setPassSaving(false);
    if (error) { setPassMsg(error.message); return; }
    setPassMsg('✅ Password updated');
    setNewPass('');
    setConfirmPass('');
    setTimeout(() => setShowPass(false), 1200);
  };

  const closePasswordModal = () => {
    setShowPass(false);
    setNewPass('');
    setConfirmPass('');
    setPassMsg('');
  };

  const passwordsMatch = newPass.length > 0 && newPass === confirmPass;

  // Looks up the academy's plan, then that plan's snapshot retention window
  // (parsed from its features array, e.g. "snapshots_7day" -> 7 days).
  // Falls back to the most conservative window (7 days) if the plan code
  // isn't found in the plans table (e.g. a 'trial' plan not listed there).
  const loadRetentionDays = async () => {
    const { data: academy } = await supabase.from('academies').select('plan').eq('id', academyId).single();
    const planCode = academy?.plan || 'basic';
    const { data: planRow } = await supabase.from('plans').select('features').eq('code', planCode).single();
    return planRow ? parseRetentionDays(planRow.features) : 7;
  };

  const loadSnapshots = async () => {
    if (!academyId) return;
    setSnapLoading(true);
    const days = await loadRetentionDays();
    await pruneOldSnapshots(academyId, days);
    const { data } = await supabase.from('snapshots').select('id,snap_key,label,created_at')
      .eq('academy_id', academyId).order('created_at', { ascending: false });
    setSnapshots(data || []);
    setSnapLoading(false);
  };
  useEffect(() => { if (isAdmin) loadSnapshots(); }, [isAdmin, academyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSnapNow = async () => {
    setSnapping(true);
    try {
      await takeSnapshot(academyId, 'manual');
      await loadSnapshots();
    } catch (e) {
      alert('Snapshot failed: ' + e.message);
    } finally {
      setSnapping(false);
    }
  };

  const deleteSnapshot = async (id) => {
    if (!confirm('Delete this snapshot? This cannot be undone.')) return;
    const { error } = await supabase.from('snapshots').delete().eq('id', id);
    if (error) { alert('Delete failed: ' + error.message); return; }
    setSnapshots(prev => prev.filter(s => s.id !== id));
  };

  // Two required warnings before any data is touched:
  //  1. States the actual date/time of the snapshot being restored.
  //  2. A final "are you sure" confirmation.
  // Only after both are accepted does the restore Edge Function get called.
  const restoreSnapshot = async (snap) => {
    const when = fmtDateTime(snap.created_at);

    const ack1 = confirm(`This will restore your data to how it was on ${when}. Anything changed since then will be overwritten.`);
    if (!ack1) return;

    const ack2 = confirm('Confirm: proceed with restoring this snapshot? This cannot be undone.');
    if (!ack2) return;

    setRestoringId(snap.id);
    try {
      const { data, error: err } = await supabase.functions.invoke('restore-snapshot', {
        body: { snapshot_id: snap.id },
      });
      if (err) {
        let msg = err.message || 'Restore failed';
        if (err.context && typeof err.context.json === 'function') {
          try { const body = await err.context.json(); if (body?.error) msg = body.error; } catch { /* not JSON */ }
        }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setRestoreResult(data); // triggers the results popup
    } catch (e) {
      alert('Restore failed: ' + e.message);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="modal-overlay active" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-title">
          <span>⚙️ Settings</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Appearance */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ fontSize: 13, marginBottom: 8 }}>🎨 Appearance</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--royal2)', borderRadius: 8, padding: '11px 12px' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--offwhite)' }}>Theme</span>
            <button className="btn btn-outline btn-sm" onClick={toggleTheme}>{theme === 'dark' ? '🌙 Dark' : '☀️ Light'}</button>
          </div>
        </div>

        {/* Account */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ fontSize: 13, marginBottom: 8 }}>🔐 Account</div>
          <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={() => setShowPass(true)}>🔑 Change My Password</button>
        </div>

        {isAdmin && (
          <div>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 16px' }} />

            {/* Snapshots */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div className="section-title" style={{ marginBottom: 0, fontSize: 13 }}>📸 Daily Snapshots</div>
                <button className="btn btn-primary btn-xs" onClick={handleSnapNow} disabled={snapping}>{snapping ? 'Saving…' : '📸 Snap Now'}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 10, lineHeight: 1.6 }}>
                Saves a full restore point of this academy: profile, students, fees, batches, sports, enquiries, staff, attendance, class logs, courses, leave requests, achievements, schedules, message logs & activity log. Older snapshots are automatically removed once they fall outside your plan's retention window.
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {snapLoading && <div style={{ padding: 14, fontSize: 12, color: 'var(--gray)' }}>Loading…</div>}
                {!snapLoading && snapshots.length === 0 && <div style={{ padding: 14, fontSize: 12, color: 'var(--gray)' }}>No snapshots yet. Tap 📸 Snap Now to create one.</div>}
                {snapshots.map(s => {
                  const d = new Date(s.created_at);
                  const isManual = s.label === 'manual';
                  const isRestoringThis = restoringId === s.id;
                  return (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border)', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: isManual ? 'var(--accent2)' : 'var(--gold)' }}>{isManual ? '🖐 Manual' : '🕛 Auto'}</div>
                        <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 2 }}>
                          {d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn btn-outline btn-xs"
                          onClick={() => restoreSnapshot(s)}
                          disabled={restoringId !== null}
                        >
                          {isRestoringThis ? 'Restoring…' : '♻️ Restore'}
                        </button>
                        <button className="btn btn-danger btn-xs" onClick={() => deleteSnapshot(s.id)} disabled={restoringId !== null}>🗑️</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: 'var(--graydk)', marginTop: 8 }}>
                Restoring overwrites current data with the snapshot's data — this cannot be undone.
              </div>
            </div>
          </div>
        )}
      </div>

      {showPass && (
        <div className="modal-overlay active" style={{ zIndex: 1100 }} onClick={e => e.target === e.currentTarget && closePasswordModal()}>
          <div className="modal" style={{ maxWidth: 340 }}>
            <div className="modal-title">
              <span>🔑 Change Password</span>
              <button className="modal-close" onClick={closePasswordModal}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                type="password"
                className="form-input"
                placeholder="New password (min 6 chars)"
                value={newPass}
                onChange={e => setNewPass(e.target.value)}
                autoFocus
              />
              <input
                type="password"
                className="form-input"
                placeholder="Confirm new password"
                value={confirmPass}
                onChange={e => setConfirmPass(e.target.value)}
              />
              {passMsg && (
                <div style={{ fontSize: 12, color: passMsg.startsWith('✅') ? 'var(--green)' : 'var(--red)' }}>
                  {passMsg}
                </div>
              )}
              {!passMsg && confirmPass.length > 0 && (
                <div style={{ fontSize: 12, color: passwordsMatch ? 'var(--green)' : 'var(--red)' }}>
                  {passwordsMatch ? '✅ Passwords match' : '❌ Passwords do not match'}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={closePasswordModal}>Cancel</button>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ flex: 1 }}
                  onClick={changePassword}
                  disabled={passSaving || !passwordsMatch}
                >
                  {passSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Restore results popup: how many tables completed vs rejected */}
      {restoreResult && (
        <div className="modal-overlay active" style={{ zIndex: 1200 }} onClick={e => e.target === e.currentTarget && setRestoreResult(null)}>
          <div className="modal" style={{ maxWidth: 360 }}>
            <div className="modal-title">
              <span>♻️ Restore Complete</span>
              <button className="modal-close" onClick={() => setRestoreResult(null)}>×</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 10 }}>
              Restored to: {fmtDateTime(restoreResult.snapshot_date)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1, background: 'var(--royal2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)' }}>{restoreResult.completed}</div>
                <div style={{ fontSize: 11, color: 'var(--gray)' }}>Completed</div>
              </div>
              <div style={{ flex: 1, background: 'var(--royal2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: restoreResult.rejected > 0 ? 'var(--red)' : 'var(--gray)' }}>{restoreResult.rejected}</div>
                <div style={{ fontSize: 11, color: 'var(--gray)' }}>Rejected</div>
              </div>
            </div>
            {restoreResult.rejected > 0 && (
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12 }}>
                {restoreResult.results.filter(r => r.status === 'rejected').map(r => (
                  <div key={r.table} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)' }}>{r.table}</div>
                    <div style={{ fontSize: 11, color: 'var(--gray)' }}>{r.error}</div>
                  </div>
                ))}
              </div>
            )}
            <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={() => setRestoreResult(null)}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}
