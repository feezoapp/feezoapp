import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { usePlan } from '../context/PlanContext';
import { supabase } from '../lib/supabaseClient';
import { normalizePhone, isValidPhone } from '../lib/phone';
import AddStudentModal from '../components/AddStudentModal';

const todayIso = () => new Date().toISOString().slice(0, 10);
const tomorrowIso = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const CONVERSION_OPTIONS = [
  { value: 'High', label: '🔥 High' },
  { value: 'Medium', label: '⚡ Medium' },
  { value: 'Low', label: '❄️ Low' },
];
const CONVERSION_BADGE = {
  High: { bg: '#16a34a22', color: '#22c55e', icon: '🔥' },
  Medium: { bg: '#d9770622', color: '#fb923c', icon: '⚡' },
  Low: { bg: 'var(--card2)', color: 'var(--gray)', icon: '❄️' },
};

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

// Same centered popup used by StudentsTab's / AttendanceTab's / HomeTab's /
// FeesTab's Sport/Batch/Sort filters — a dark overlay + a card of radio
// rows, closing itself on selection.
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

function ConversionBadge({ ratio }) {
  if (!ratio) return null;
  const b = CONVERSION_BADGE[ratio] || CONVERSION_BADGE.Low;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, background: b.bg, color: b.color, borderRadius: 5, padding: '2px 6px' }}>
      {b.icon} {ratio}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

export default function EnquiryTab({ isActive = true }) {
  const { academyId, isAdmin, appUser } = useAuth();
  const { visibleSports, visibleBatches } = useAcademyData();
  const { isAtLimit, limits, plan, nextPlanForLimit } = usePlan();
  const [enquiries, setEnquiries] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(false);

  // Authoritative count straight from the DB (not derived from `enquiries`,
  // which may later be paginated/filtered). Archived rows are intentionally
  // included — the plan limit is on total enquiries ever created, not just
  // the active ones.
  const [enquiryCount, setEnquiryCount] = useState(0);
  const atEnquiryLimit = isAtLimit('enquiries', enquiryCount);

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', phone: '', query: '', location: '', sport: '', conversionRatio: '', reminderDate: '', assignedTo: '' });
  const [addError, setAddError] = useState('');

  const [detail, setDetail] = useState(null); // the enquiry row being viewed
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');

  const [search, setSearch] = useState('');
  const [filterConv, setFilterConv] = useState('');
  const [filterSport, setFilterSport] = useState('');
  const [filterStaff, setFilterStaff] = useState('');
  const [filterReminder, setFilterReminder] = useState('');
  const [view, setView] = useState('active'); // 'active' | 'archive' (admin only)
  const [popup, setPopup] = useState(null); // 'conv' | 'sport' | 'staff' | null
  const [panelOpen, setPanelOpen] = useState(false); // filter panel: collapsed by default, matching AttendanceTab

  const [convertPrefill, setConvertPrefill] = useState(null);
  const [convertingEnqId, setConvertingEnqId] = useState(null);

  const notesScrollRef = useRef(null);
  const nameInputRef = useRef(null);

  const createdByName = appUser?.name || appUser?.id || 'Staff';

  const load = async () => {
    if (!academyId) return;
    setLoading(true);
    const [enqRes, countRes, usersRes] = await Promise.all([
      supabase.from('enquiries').select('*').eq('academy_id', academyId).order('created_at', { ascending: false }),
      // head:true → no rows returned, just the count. No `archived` filter,
      // so this counts active + archived together.
      supabase.from('enquiries').select('*', { count: 'exact', head: true }).eq('academy_id', academyId),
      isAdmin ? supabase.from('app_users').select('*').eq('academy_id', academyId) : Promise.resolve({ data: [] }),
    ]);
    setEnquiries(enqRes.data || []);
    setEnquiryCount(countRes.count ?? (enqRes.data || []).length);
    setStaffList(usersRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [academyId]);

  // This tab stays mounted (display:none) when the user swipes away, but its
  // FAB/modals are createPortal'd straight to document.body — that ignores
  // the display:none, so they'd otherwise keep floating over other tabs.
  // Closing everything on deactivate keeps this tab's overlays out of sight
  // (and out of the way) whenever it isn't the one showing.
  useEffect(() => {
    if (!isActive) {
      setShowAdd(false);
      setDetail(null);
      setEditing(false);
      setPopup(null);
    }
  }, [isActive]);

  // ---- Realtime sync ----
  // Mirrors FeesTab's pattern: a dedicated channel on `enquiries` patches
  // local state as rows change on any device, so the list (and any open
  // detail card) stays live without a manual refetch after every action.
  useEffect(() => {
    if (!academyId) return;

    const channel = supabase
      .channel(`enquiries-${academyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'enquiries', filter: `academy_id=eq.${academyId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old;
            if (!oldRow) return;
            setEnquiries(prev => prev.filter(q => q.id !== oldRow.id));
            setDetail(d => (d && d.id === oldRow.id ? null : d));
            setEnquiryCount(c => Math.max(0, c - 1));
          } else {
            const row = payload.new;
            if (!row) return;
            setEnquiries(prev => {
              const idx = prev.findIndex(q => q.id === row.id);
              if (idx === -1) return [row, ...prev];
              const next = prev.slice();
              next[idx] = row;
              return next;
            });
            setDetail(d => (d && d.id === row.id ? { ...d, ...row } : d));
            if (payload.eventType === 'INSERT') setEnquiryCount(c => c + 1);
          }
        })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [academyId]);

  const logEnquiry = async (message) => {
    try {
      const { error } = await supabase.from('audit_log').insert({
        academy_id: academyId, user_id: createdByName, role: isAdmin ? 'admin' : 'staff', action: message, detail: message,
      });
      if (error) console.error('audit_log insert failed (enquiry):', error);
    } catch (e) { console.error('audit_log insert threw (enquiry):', e); }
  };

  const staffScopedSports = useMemo(() => visibleSports.map(s => s.name), [visibleSports]);

  const activeFilterCount = [filterConv, filterSport, filterReminder, isAdmin ? filterStaff : ''].filter(Boolean).length;

  const filtered = useMemo(() => {
    let list = enquiries.filter(q => (view === 'archive' ? q.archived : !q.archived));

    if (!isAdmin) {
      list = list.filter(q => q.assigned_to === appUser?.id || q.created_by === createdByName || q.created_by === appUser?.id);
    }

    const s = search.trim().toLowerCase();
    if (s) list = list.filter(q => (q.name || '').toLowerCase().includes(s) || (q.phone || '').toLowerCase().includes(s));
    if (filterConv) list = list.filter(q => q.conversion_ratio === filterConv);
    if (filterSport) list = list.filter(q => (q.sport || '') === filterSport);
    if (filterReminder) list = list.filter(q => q.reminder_date === filterReminder);
    if (isAdmin && filterStaff) {
      list = filterStaff === '__UNASSIGNED__'
        ? list.filter(q => !q.assigned_to)
        : list.filter(q => q.assigned_to === filterStaff);
    }

    return [...list].sort((a, b) => {
      const ar = a.reminder_date || '', br = b.reminder_date || '';
      if (ar && !br) return -1;
      if (!ar && br) return 1;
      if (ar && br) return ar.localeCompare(br);
      return 0;
    });
  }, [enquiries, view, isAdmin, appUser, createdByName, search, filterConv, filterSport, filterReminder, filterStaff]);

  // ---- Add ----
  const openAdd = () => {
    if (atEnquiryLimit) return;
    setAddForm({ name: '', phone: '', query: '', location: '', sport: '', conversionRatio: '', reminderDate: '', assignedTo: '' });
    setAddError('');
    setShowAdd(true);
  };

  // Focus the Name field (opens the keyboard on mobile) once the add form has mounted
  useEffect(() => {
    if (showAdd) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [showAdd]);

  const saveEnquiry = async () => {
    if (atEnquiryLimit) {
      setAddError(`Limit reached (${limits.enquiries} enquiries) on your ${plan?.name || 'current'} plan.`);
      return;
    }
    if (!addForm.name.trim()) { setAddError('Name is required.'); return; }
    if (addForm.phone && !isValidPhone(addForm.phone)) { setAddError('Phone must be a 10-digit number.'); return; }
    setAddError('');
    const row = {
      academy_id: academyId,
      name: addForm.name.trim(),
      phone: addForm.phone ? normalizePhone(addForm.phone) : '',
      query: addForm.query || '',
      location: addForm.location || '',
      conversion_ratio: addForm.conversionRatio || '',
      sport: addForm.sport || '',
      reminder_date: addForm.reminderDate || null,
      assigned_to: addForm.assignedTo || '',
      created_by: createdByName,
      archived: false,
      edit_history: [],
      staff_notes: [],
    };
    const { error } = await supabase.from('enquiries').insert(row);
    if (error) { setAddError(error.message); return; }
    logEnquiry(`Added query for ${row.name}`);
    setShowAdd(false);
  };

  // ---- Detail / edit ----
  const openDetail = (q) => { setDetail(q); setEditing(false); setNoteDraft(''); };
  const closeDetail = () => { setDetail(null); setEditing(false); };

  // Keep the notes window pinned to the latest note whenever the detail opens or notes change
  useEffect(() => {
    if (detail && notesScrollRef.current) {
      notesScrollRef.current.scrollTop = notesScrollRef.current.scrollHeight;
    }
  }, [detail?.id, detail?.staff_notes]);

  const startEdit = () => {
    setEditForm({
      name: detail.name || '', phone: detail.phone || '', query: detail.query || '',
      location: detail.location || '', conversionRatio: detail.conversion_ratio || '',
      sport: detail.sport || '', assignedTo: detail.assigned_to || '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editForm.name.trim()) return;
    if (editForm.phone && !isValidPhone(editForm.phone)) { window.alert('Phone must be a 10-digit number.'); return; }
    const history = Array.isArray(detail.edit_history) ? detail.edit_history : [];
    const patch = {
      name: editForm.name.trim(), phone: editForm.phone ? normalizePhone(editForm.phone) : '',
      query: editForm.query, location: editForm.location, conversion_ratio: editForm.conversionRatio,
      sport: editForm.sport, assigned_to: isAdmin ? editForm.assignedTo : detail.assigned_to,
      edit_history: [...history, { by: createdByName, at: new Date().toISOString() }],
    };
    const { error } = await supabase.from('enquiries').update(patch).eq('id', detail.id);
    if (error) { window.alert(error.message); return; }
    logEnquiry(`Edited query for ${patch.name}`);
    setEditing(false);
    setDetail(d => ({ ...d, ...patch }));
  };

  const saveReminder = async (newDate) => {
    await supabase.from('enquiries').update({ reminder_date: newDate || null }).eq('id', detail.id);
    logEnquiry(`Reminder date updated for ${detail.name}${newDate ? ` → ${newDate}` : ' (cleared)'}`);
    setDetail(d => ({ ...d, reminder_date: newDate || null }));
  };

  const saveNote = async () => {
    const note = noteDraft.trim();
    if (!note) return;
    const notes = Array.isArray(detail.staff_notes) ? detail.staff_notes : [];
    const updated = [...notes, { by: createdByName, at: new Date().toISOString(), note }];
    await supabase.from('enquiries').update({ staff_notes: updated }).eq('id', detail.id);
    logEnquiry(`Note added to query for ${detail.name} by ${createdByName}`);
    setDetail(d => ({ ...d, staff_notes: updated }));
    setNoteDraft('');
  };

  const toggleArchive = async () => {
    const goingToArchive = !detail.archived;
    await supabase.from('enquiries').update({ archived: goingToArchive, archived_at: goingToArchive ? new Date().toISOString() : null }).eq('id', detail.id);
    logEnquiry(`${goingToArchive ? 'Archived' : 'Restored'} query for ${detail.name}`);
    closeDetail();
  };

  const removeEnquiry = async () => {
    if (!window.confirm(`Delete this query for ${detail.name}? This cannot be undone.`)) return;
    const id = detail.id;
    await supabase.from('enquiries').delete().eq('id', id);
    logEnquiry(`Deleted query for ${detail.name}`);
    // Don't wait on the realtime round-trip for our own delete — remove it
    // locally right away. Realtime will just re-confirm (or no-op) for us,
    // and still handles it for other open tabs/devices.
    setEnquiries(prev => prev.filter(q => q.id !== id));
    setEnquiryCount(c => Math.max(0, c - 1));
    closeDetail();
  };

  const startConvert = () => {
    setConvertingEnqId(detail.id);
    setConvertPrefill({ name: detail.name, contact: detail.phone, parent: detail.name, sport: detail.sport });
    closeDetail();
  };

  const onConverted = async () => {
    const id = convertingEnqId;
    setConvertPrefill(null);
    setConvertingEnqId(null);
    if (id) {
      const q = enquiries.find(e => e.id === id);
      await supabase.from('enquiries').delete().eq('id', id);
      logEnquiry(`Converted query to student: "${q?.name || ''}"`);
      setEnquiries(prev => prev.filter(e => e.id !== id));
      setEnquiryCount(c => Math.max(0, c - 1));
    }
  };

  const assignedName = (userId) => {
    const u = staffList.find(x => x.id === userId);
    return u ? (u.name || u.id) : '';
  };

  const inputStyle = 'form-input';

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>💬 Enquiries</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
            <button
              onClick={() => setView('active')}
              style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: view === 'active' ? 'var(--accent2)' : 'transparent', color: view === 'active' ? '#fff' : 'var(--gray)' }}
            >Active</button>
            <button
              onClick={() => setView('archive')}
              style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: view === 'archive' ? 'var(--accent2)' : 'transparent', color: view === 'archive' ? '#fff' : 'var(--gray)' }}
            >🗄️ Archive</button>
          </div>
        </div>
      </div>

      {atEnquiryLimit && (
        <div style={{ fontSize: 11.5, color: '#dc2626', background: '#dc262622', border: '1px solid #dc262644', borderRadius: 8, padding: '7px 10px', marginBottom: 8 }}>
          Limit reached ({limits.enquiries} enquiries) on your <strong>{plan?.name}</strong> plan.
          {(() => { const t = nextPlanForLimit('enquiries'); return t ? <> Upgrade to <strong>{t.name}</strong> for more.</> : null; })()}
        </div>
      )}

      {/* Filter panel — collapsible card, matching AttendanceTab's date/filter panel */}
      <div className="card" style={{ padding: 10, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setPanelOpen(p => !p)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>🔍 Filters</span>
            {activeFilterCount > 0 && (
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'var(--accent2)', color: '#fff' }}>{activeFilterCount}</span>
            )}
          </div>
          <button className="arrow-btn" style={{ width: 24, height: 24, fontSize: 11 }}
            onClick={(e) => { e.stopPropagation(); setPanelOpen(p => !p); }}>
            {panelOpen ? '▲' : '▼'}
          </button>
        </div>

        {panelOpen && (
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className="btn btn-outline btn-sm" style={{ fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('conv')}>
              {CONVERSION_OPTIONS.find(o => o.value === filterConv)?.label || 'All Conversion'}
            </button>
            <button className="btn btn-outline btn-sm" style={{ fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sport')}>
              {filterSport || 'All Sports'}
            </button>
            {isAdmin && (
              <button className="btn btn-outline btn-sm" style={{ fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('staff')}>
                {filterStaff === '__UNASSIGNED__' ? '— Unassigned —' : (staffList.find(u => u.id === filterStaff)?.name || staffList.find(u => u.id === filterStaff)?.id) || '👥 Assigned to: All'}
              </button>
            )}
            <input type="date" className="form-input" style={{ fontSize: 12, padding: '7px 9px' }} value={filterReminder} onChange={e => setFilterReminder(e.target.value)} />
          </div>
        )}
      </div>

      {popup === 'conv' && (
        <FilterPopup title="Filter by Conversion" onClose={() => setPopup(null)}>
          <RadioRow name="convsel" checked={!filterConv} onChange={() => { setFilterConv(''); setPopup(null); }} label="All Conversion" />
          {CONVERSION_OPTIONS.map(o => (
            <RadioRow key={o.value} name="convsel" checked={filterConv === o.value} onChange={() => { setFilterConv(o.value); setPopup(null); }} label={o.label} />
          ))}
        </FilterPopup>
      )}

      {popup === 'sport' && (
        <FilterPopup title="Filter by Sport" onClose={() => setPopup(null)}>
          <RadioRow name="sportsel" checked={!filterSport} onChange={() => { setFilterSport(''); setPopup(null); }} label="All Sports" />
          {(isAdmin ? visibleSports.map(s => s.name) : staffScopedSports).map(sp => (
            <RadioRow key={sp} name="sportsel" checked={filterSport === sp} onChange={() => { setFilterSport(sp); setPopup(null); }} label={sp} />
          ))}
        </FilterPopup>
      )}

      {popup === 'staff' && isAdmin && (
        <FilterPopup title="Filter by Assigned Staff" onClose={() => setPopup(null)}>
          <RadioRow name="staffsel" checked={!filterStaff} onChange={() => { setFilterStaff(''); setPopup(null); }} label="👥 Assigned to: All" />
          {staffList.slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map(u => (
            <RadioRow key={u.id} name="staffsel" checked={filterStaff === u.id} onChange={() => { setFilterStaff(u.id); setPopup(null); }} label={`${u.name || u.id}${u.role?.includes('admin') ? ' (Admin)' : ''}`} />
          ))}
          <RadioRow name="staffsel" checked={filterStaff === '__UNASSIGNED__'} onChange={() => { setFilterStaff('__UNASSIGNED__'); setPopup(null); }} label="— Unassigned —" />
        </FilterPopup>
      )}

      <div className="search-wrap" style={{ marginBottom: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input type="text" className="search-input" placeholder="Search by name or phone…" value={search} onChange={e => setSearch(e.target.value)} />
        {search && <button type="button" className="search-clear-btn" onClick={() => setSearch('')} aria-label="Clear search">✕</button>}
      </div>


      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 90 }}>
        {loading && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 20, fontSize: 12 }}>Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30, fontSize: 13 }}>
            {view === 'archive' ? '🗄️ No archived queries.' : (isAdmin ? <>No queries match your filters.<br />Tap <b>+ Add</b> to record one.</> : 'No queries assigned to you yet.')}
          </div>
        )}
        {filtered.map(q => {
          const today = todayIso();
          const isOverdue = q.reminder_date && q.reminder_date < today;
          const noteCount = (q.staff_notes || []).length;
          return (
            <div key={q.id} onClick={() => openDetail(q)} className="card hover-lift"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', marginBottom: 7, cursor: 'pointer', border: `1px solid ${isOverdue ? '#ef444455' : 'var(--border)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: 1 }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--accent2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                  {(q.name || '?').charAt(0).toUpperCase()}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    {q.name} <ConversionBadge ratio={q.conversion_ratio} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--accent2)' }}>📞 {q.phone || '—'}</div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 3 }}>
                    {q.reminder_date && (
                      <span style={{ fontSize: 10, fontWeight: isOverdue ? 700 : 500, color: isOverdue ? '#f87171' : 'var(--gold)' }}>
                        ⏰ {q.reminder_date}{isOverdue ? ' (overdue)' : ''}
                      </span>
                    )}
                    {q.assigned_to
                      ? <span style={{ fontSize: 10, background: 'var(--card2)', color: 'var(--accent2)', borderRadius: 5, padding: '2px 6px' }}>👤 {assignedName(q.assigned_to)}</span>
                      : (isAdmin && <span style={{ fontSize: 10, background: 'var(--card2)', color: 'var(--gray)', borderRadius: 5, padding: '2px 6px' }}>Unassigned</span>)}
                    {noteCount > 0 && <span style={{ fontSize: 10, background: 'var(--card2)', color: 'var(--gold)', borderRadius: 5, padding: '2px 6px' }}>📝 {noteCount} note{noteCount > 1 ? 's' : ''}</span>}
                    {isAdmin && q.created_by && <span style={{ fontSize: 10, background: 'var(--card2)', color: 'var(--gray)', borderRadius: 5, padding: '2px 6px' }}>✍️ {q.created_by}</span>}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--gray)', flexShrink: 0, whiteSpace: 'nowrap' }}>{relTime(q.created_at)}</div>
            </div>
          );
        })}
      </div>

      {isActive && !showAdd && !detail && createPortal(
        <button
          onClick={openAdd}
          disabled={atEnquiryLimit}
          aria-label={atEnquiryLimit ? 'Enquiry limit reached' : 'Add enquiry'}
          title={atEnquiryLimit ? `Limit reached (${limits.enquiries} enquiries) on ${plan?.name} plan` : undefined}
          style={{
            position: 'fixed',
            right: 18,
            bottom: 76,
            width: 54,
            height: 54,
            borderRadius: '50%',
            background: atEnquiryLimit ? 'var(--gray)' : 'var(--accent2)',
            color: '#fff',
            border: 'none',
            fontSize: 26,
            fontWeight: 600,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 6px 16px rgba(0,0,0,.28)',
            cursor: atEnquiryLimit ? 'not-allowed' : 'pointer',
            opacity: atEnquiryLimit ? 0.6 : 1,
            zIndex: 500,
          }}
        >
          +
        </button>,
        document.body
      )}

      {isActive && showAdd && createPortal(
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 62, background: 'rgba(10,20,40,.55)', zIndex: 250, display: 'flex', alignItems: 'flex-end' }} onClick={() => setShowAdd(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 480, margin: '0 auto', maxHeight: '85vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>💬 New Query</div>
            {addError && <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>⚠️ {addError}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Field label="Name *"><input ref={nameInputRef} className={inputStyle} value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} /></Field>
              <Field label="Phone"><input className={inputStyle} maxLength={10} value={addForm.phone} onChange={e => setAddForm(f => ({ ...f, phone: normalizePhone(e.target.value).slice(0, 10) }))} placeholder="10-digit mobile number" /></Field>
              <Field label="Location / Area"><input className={inputStyle} value={addForm.location} onChange={e => setAddForm(f => ({ ...f, location: e.target.value }))} /></Field>
              <div style={{ display: 'grid', gridTemplateColumns: isAdmin ? '1fr 1fr' : '1fr', gap: 10 }}>
                {isAdmin && (
                  <Field label="👤 Assign to Staff">
                    <select className="form-select" value={addForm.assignedTo} onChange={e => setAddForm(f => ({ ...f, assignedTo: e.target.value }))}>
                      <option value="">— Unassigned —</option>
                      {staffList.map(u => <option key={u.id} value={u.id}>{u.name || u.id}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Sport of interest">
                  <select className="form-select" value={addForm.sport} onChange={e => setAddForm(f => ({ ...f, sport: e.target.value }))}>
                    <option value="">Not specified</option>
                    {visibleSports.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Conversion Ratio">
                  <select className="form-select" value={addForm.conversionRatio} onChange={e => setAddForm(f => ({ ...f, conversionRatio: e.target.value }))}>
                    <option value="">Select…</option>
                    {CONVERSION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="📅 Next Reminder Date"><input type="date" className={inputStyle} value={addForm.reminderDate} onChange={e => setAddForm(f => ({ ...f, reminderDate: e.target.value }))} /></Field>
              </div>
              <Field label="Query / Interest"><textarea className={inputStyle} rows={3} style={{ resize: 'none' }} value={addForm.query} onChange={e => setAddForm(f => ({ ...f, query: e.target.value }))} placeholder="What are they enquiring about?" /></Field>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowAdd(false)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={saveEnquiry}>💾 Save Query</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isActive && detail && createPortal(
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 62, background: 'rgba(10,20,40,.55)', zIndex: 250, display: 'flex', alignItems: 'flex-end' }} onClick={closeDetail}>
          <div className="card" style={{ width: '100%', maxWidth: 480, margin: '0 auto', maxHeight: '85vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            {!editing ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 17, display: 'flex', alignItems: 'center', gap: 6 }}>{detail.name} <ConversionBadge ratio={detail.conversion_ratio} /></div>
                    {detail.phone && <a href={`tel:${detail.phone}`} style={{ fontSize: 13, color: 'var(--accent2)', textDecoration: 'none' }}>📞 {detail.phone}</a>}
                  </div>
                  <button onClick={closeDetail} style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
                </div>

                {detail.query && <div style={{ fontSize: 13, background: 'var(--card2)', borderRadius: 8, padding: 10, marginBottom: 10 }}>{detail.query}</div>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, marginBottom: 12 }}>
                  {detail.location && <div><span style={{ color: 'var(--gray)' }}>📍 Location: </span>{detail.location}</div>}
                  {detail.sport && <div><span style={{ color: 'var(--gray)' }}>🏅 Sport: </span>{detail.sport}</div>}
                  {isAdmin && <div><span style={{ color: 'var(--gray)' }}>👤 Assigned to: </span>{detail.assigned_to ? assignedName(detail.assigned_to) : 'Unassigned'}</div>}
                  {detail.created_by && <div><span style={{ color: 'var(--gray)' }}>✍️ Added by: </span>{detail.created_by}</div>}
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', marginBottom: 5 }}>📅 Next Reminder Date</label>
                  <input type="date" className="form-input" defaultValue={detail.reminder_date || ''} onBlur={e => { if (e.target.value !== (detail.reminder_date || '')) saveReminder(e.target.value); }} />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', marginBottom: 5 }}>
                    📝 Staff Notes {(detail.staff_notes || []).length > 0 && `(${detail.staff_notes.length})`}
                  </label>
                  {(detail.staff_notes || []).length > 0 && (
                    <div
                      ref={notesScrollRef}
                      style={{
                        maxHeight: 160,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                        marginBottom: 8,
                        padding: 2,
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                      }}
                    >
                      {detail.staff_notes.map((n, i) => (
                        <div key={i} style={{ fontSize: 12, background: 'var(--card2)', borderRadius: 6, padding: '6px 9px' }}>
                          <div>{n.note}</div>
                          <div style={{ fontSize: 10, color: 'var(--gray)', marginTop: 2 }}>{n.by} · {relTime(n.at)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="form-input" style={{ flex: 1 }} placeholder="Add a note…" value={noteDraft} onChange={e => setNoteDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveNote(); }} />
                    <button className="btn btn-outline btn-sm" onClick={saveNote}>Add</button>
                  </div>
                </div>

                {isAdmin && (detail.edit_history || []).length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--gray)', marginBottom: 12 }}>
                    Last edited by {detail.edit_history[detail.edit_history.length - 1].by} · {relTime(detail.edit_history[detail.edit_history.length - 1].at)}
                  </div>
                )}

                {isAdmin && !detail.archived && (
                  <button className="btn btn-success" style={{ width: '100%', padding: 11, marginBottom: 8 }} onClick={startConvert}>👥 Convert to Student</button>
                )}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={startEdit}>✏️ Edit</button>
                  <button className="btn btn-outline btn-sm" style={{ flex: 1 }} onClick={toggleArchive}>{detail.archived ? '♻️ Restore' : '🗄️ Archive'}</button>
                </div>
                {isAdmin && (
                  <button className="btn btn-sm" style={{ width: '100%', background: 'var(--red, #dc2626)', color: '#fff', border: 'none' }} onClick={removeEnquiry}>🗑️ Delete Query</button>
                )}
              </>
            ) : (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>✏️ Edit Query</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Field label="Name"><input className={inputStyle} value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} /></Field>
                  <Field label="Phone"><input className={inputStyle} maxLength={10} value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: normalizePhone(e.target.value).slice(0, 10) }))} /></Field>
                  <Field label="Query / Interest"><textarea className={inputStyle} rows={3} style={{ resize: 'none' }} value={editForm.query} onChange={e => setEditForm(f => ({ ...f, query: e.target.value }))} /></Field>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Field label="Location"><input className={inputStyle} value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} /></Field>
                    <Field label="Conversion Ratio">
                      <select className="form-select" value={editForm.conversionRatio} onChange={e => setEditForm(f => ({ ...f, conversionRatio: e.target.value }))}>
                        <option value="">Select…</option>
                        {CONVERSION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </Field>
                  </div>
                  <Field label="Sport">
                    <select className="form-select" value={editForm.sport} onChange={e => setEditForm(f => ({ ...f, sport: e.target.value }))}>
                      <option value="">Not specified</option>
                      {visibleSports.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                    </select>
                  </Field>
                  {isAdmin && (
                    <Field label="Assign to Staff">
                      <select className="form-select" value={editForm.assignedTo} onChange={e => setEditForm(f => ({ ...f, assignedTo: e.target.value }))}>
                        <option value="">— Unassigned —</option>
                        {staffList.map(u => <option key={u.id} value={u.id}>{u.name || u.id}</option>)}
                      </select>
                    </Field>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setEditing(false)}>Cancel</button>
                    <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={saveEdit}>💾 Save Changes</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {convertPrefill && (
        <AddStudentModal
          academyId={academyId}
          sports={visibleSports}
          batches={visibleBatches}
          initial={convertPrefill}
          existingStudents={[]}
          onClose={() => { setConvertPrefill(null); setConvertingEnqId(null); }}
          onSaved={onConverted}
        />
      )}
    </div>
  );
}
