import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { supabase } from '../lib/supabaseClient';
import { logActivity } from '../lib/auditLog';

const emptyForm = () => ({ name: '', email: '', password: '', confirmPassword: '', assigned_sports: [], assigned_batches: [], can_view_contact: false, can_export: false });

export default function UsersPage() {
  const { academyId, appUser } = useAuth();
  const { sports, batches } = useAcademyData();
  const [users, setUsers] = useState([]);
  const [view, setView] = useState('staff'); // 'staff' | 'admin' — staff opens by default
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null); // app_users.id being edited, or null
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!academyId) return;
    const { data } = await supabase.from('app_users').select('*').eq('academy_id', academyId);
    setUsers(data || []);
  };
  useEffect(() => { load(); }, [academyId]);

  const toggleMulti = (field, value) => {
    setForm(prev => {
      const set = new Set(prev[field]);
      set.has(value) ? set.delete(value) : set.add(value);
      return { ...prev, [field]: Array.from(set) };
    });
  };

  // Staff only — the Admins tab is view-only, so this modal never creates or edits an admin.
  const openAdd = () => { setForm(emptyForm()); setEditingId(null); setError(''); setShowModal(true); };

  const openEdit = (u) => {
    setForm({
      name: u.name || '', email: u.email || '', password: '',
      assigned_sports: u.assigned_sports || [], assigned_batches: u.assigned_batches || [],
      can_view_contact: !!u.can_view_contact, can_export: !!u.can_export,
    });
    setEditingId(u.id);
    setError('');
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setEditingId(null); setError(''); };

  const saveUser = async () => {
    if (!form.name.trim() || !form.email.trim()) { setError('Name and email are required.'); return; }
    if (form.assigned_sports.length === 0) { setError('Please assign at least one sport.'); return; }
    if (form.assigned_batches.length === 0) { setError('Please assign at least one batch.'); return; }
    setError('');
    setSaving(true);
    try {
      if (editingId) {
        // Editing an existing account only updates the profile row — a Supabase
        // Auth user's password can't be changed from the client with the anon
        // key, so there's no password field here.
        const { error: err } = await supabase.from('app_users').update({
          email: form.email.trim().toLowerCase(), name: form.name.trim(), role: 'staff',
          assigned_sports: form.assigned_sports, assigned_batches: form.assigned_batches,
          can_view_contact: form.can_view_contact, can_export: form.can_export,
        }).eq('id', editingId);
        if (err) throw err;
        logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Edited staff user ${form.name.trim()}` });
      } else {
        if (!form.password || form.password.length < 6) throw new Error('Password must be at least 6 characters.');
        if (form.password !== form.confirmPassword) throw new Error('Passwords do not match.');
        // Creating a new login requires the service-role key, which can't run
        // in the browser — the 'create-user' Edge Function does the actual
        // Supabase Auth signup + app_users row server-side.
        const { data, error: err } = await supabase.functions.invoke('create-user', {
          body: {
            email: form.email.trim().toLowerCase(), password: form.password, name: form.name.trim(),
            role: 'staff', academy_id: academyId,
            assigned_sports: form.assigned_sports, assigned_batches: form.assigned_batches,
            can_view_contact: form.can_view_contact, can_export: form.can_export,
          },
        });
        if (err) {
          let msg = err.message || 'Failed to create user';
          if (err.context && typeof err.context.json === 'function') {
            try { const body = await err.context.json(); if (body?.error) msg = body.error; } catch { /* not JSON */ }
          }
          throw new Error(msg);
        }
        if (data?.error) throw new Error(data.error);
        logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Added new staff user ${form.name.trim()}` });
      }
      closeModal();
      load();
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async (u) => {
    if (!confirm(`Permanently delete "${u.name || u.email}"? Their login and access will be removed. This cannot be undone.`)) return;
    try {
      const { data, error: err } = await supabase.functions.invoke('delete-user', { body: { uid: u.id, id: u.id, login_id: u.id, email: u.email } });
      if (err) {
        let msg = err.message || 'Delete failed';
        if (err.context && typeof err.context.json === 'function') {
          try { const body = await err.context.json(); if (body?.error) msg = body.error; } catch { /* not JSON */ }
        }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Removed staff user ${u.name || u.email}` });
      load();
      if (data?.warning) alert(data.warning);
    } catch (e) {
      // Fallback: remove the profile row only — the login may linger until
      // cleaned up from the Supabase dashboard, same as the HTML app's fallback.
      await supabase.from('app_users').delete().eq('id', u.id);
      logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Removed staff user ${u.name || u.email} (profile only)` });
      load();
      alert('Removed profile. Note: ' + (e.message || 'login may remain — check the Supabase dashboard.'));
    }
  };

  const toggleContactAccess = async (u) => {
    const next = !u.can_view_contact;
    await supabase.from('app_users').update({ can_view_contact: next }).eq('id', u.id);
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, can_view_contact: next } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `${next ? 'Granted' : 'Revoked'} contact-number view access for ${u.name || u.email}` });
  };

  const toggleExportAccess = async (u) => {
    const next = !u.can_export;
    await supabase.from('app_users').update({ can_export: next }).eq('id', u.id);
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, can_export: next } : x));
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `${next ? 'Granted' : 'Revoked'} export access for ${u.name || u.email}` });
  };

  const admins = users.filter(u => u.role === 'admin');
  const staff = users.filter(u => u.role !== 'admin');
  const filtered = view === 'admin' ? admins : staff;

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 90 }}>
      <Link to="/profile" style={{ fontSize: 12, color: 'var(--accent2)', marginBottom: 10, display: 'inline-block' }}>← Back to Profile</Link>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>👤 User Management</div>
        {view === 'staff' && <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add</button>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexShrink: 0 }}>
        <button
          className={'btn btn-sm ' + (view === 'staff' ? 'btn-primary' : 'btn-outline')}
          style={{ flex: 1 }}
          onClick={() => setView('staff')}
        >Staff ({staff.length})</button>
        <button
          className={'btn btn-sm ' + (view === 'admin' ? 'btn-primary' : 'btn-outline')}
          style={{ flex: 1 }}
          onClick={() => setView('admin')}
        >Admins ({admins.length})</button>
      </div>

      {filtered.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--gray)', textAlign: 'center', padding: 24 }}>
          No {view === 'admin' ? 'admins' : 'staff'} yet.
        </div>
      )}

      {view === 'admin' ? (
        // Admins tab is strictly view-only — no add, no edit, no delete,
        // for any admin (including your own account) from this screen.
        filtered.map(u => (
          <div key={u.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ fontWeight: 700 }}>{u.name}</div>
            <div style={{ fontSize: 12, color: 'var(--gray)' }}>{u.email}</div>
          </div>
        ))
      ) : (
        filtered.map(u => (
          <div key={u.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700 }}>{u.name}</div>
              <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 700, textTransform: 'capitalize' }}>{u.role}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--gray)' }}>{u.email}</div>
            <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 4 }}>
              Sports: {(u.assigned_sports || []).join(', ') || '—'}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, marginTop: 6 }}>
              <input type="checkbox" checked={!!u.can_view_contact} onChange={() => toggleContactAccess(u)} />
              📞 Can view student contact numbers
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, marginTop: 6 }}>
              <input type="checkbox" checked={!!u.can_export} onChange={() => toggleExportAccess(u)} />
              ⬇️ Can download/export lists
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-xs" onClick={() => openEdit(u)}>✏️ Edit</button>
              <button className="btn btn-xs" style={{ background: 'var(--red)', color: '#fff', border: 'none' }} onClick={() => removeUser(u)}>Remove</button>
            </div>
          </div>
        ))
      )}

      {showModal && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'flex-end' }} onClick={closeModal}>
          <div className="card" style={{ width: '100%', maxWidth: 480, margin: '0 auto', maxHeight: '88vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>{editingId ? '✏️ Edit Staff' : '👤 New Staff Member'}</div>
            {error && <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>⚠️ {error}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input className="form-input" placeholder="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              <input className="form-input" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={!!editingId} />
              {!editingId && (
                <>
                  <input className="form-input" type="password" placeholder="Password (min 6 characters)" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
                  <input
                    className="form-input"
                    type="password"
                    placeholder="Re-enter password"
                    value={form.confirmPassword}
                    onChange={e => setForm({ ...form, confirmPassword: e.target.value })}
                    style={form.confirmPassword && form.confirmPassword !== form.password ? { borderColor: '#dc2626' } : undefined}
                  />
                  {form.confirmPassword && form.confirmPassword !== form.password && (
                    <div style={{ fontSize: 11.5, color: '#dc2626', marginTop: -4 }}>Passwords don't match yet.</div>
                  )}
                </>
              )}
              <div style={{ fontSize: 12, fontWeight: 600 }}>Assigned Sports</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {sports.map(s => (
                  <button key={s.id} type="button"
                    className={'btn btn-xs ' + (form.assigned_sports.includes(s.name) ? 'btn-primary' : 'btn-outline')}
                    onClick={() => toggleMulti('assigned_sports', s.name)}>{s.name}</button>
                ))}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Assigned Batches</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {batches.map(b => (
                  <button key={b.id} type="button"
                    className={'btn btn-xs ' + (form.assigned_batches.includes(b.name) ? 'btn-primary' : 'btn-outline')}
                    onClick={() => toggleMulti('assigned_batches', b.name)}>{b.batchLabel}</button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                <input type="checkbox" checked={form.can_view_contact}
                  onChange={e => setForm({ ...form, can_view_contact: e.target.checked })} />
                📞 Allow viewing student contact numbers
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                <input type="checkbox" checked={form.can_export}
                  onChange={e => setForm({ ...form, can_export: e.target.checked })} />
                ⬇️ Allow downloading/exporting lists
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={closeModal}>Cancel</button>
                <button className="btn btn-primary btn-sm" style={{ flex: 1.4 }} disabled={saving} onClick={saveUser}>
                  {saving ? 'Saving…' : editingId ? '💾 Save Changes' : '💾 Create Staff'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
