import { useMemo, useState } from 'react';
import { useAcademyData } from '../context/AcademyDataContext';
import { useAuth } from '../context/AuthContext';
import { usePlan } from '../context/PlanContext';
import LimitGatedButton from '../components/LimitGatedButton';
import { supabase } from '../lib/supabaseClient';
import { logActivity } from '../lib/auditLog';
import AddStudentModal from '../components/AddStudentModal';
import StudentDetailModal from '../components/StudentDetailModal';
import ImportStudentsModal from '../components/ImportStudentsModal';
import BulkEditStudentsModal from '../components/BulkEditStudentsModal';
import { exportStudentsPdf, exportStudentsXlsx } from '../lib/exporters';

// Natural sort for roll numbers like "SM1", "SM2", "SM10" — plain string
// comparison would wrongly put "SM10" before "SM2". This splits into the
// letter prefix and numeric part and compares the number numerically.
function compareRollNo(a, b) {
  const ra = String(a || '');
  const rb = String(b || '');
  const pa = ra.match(/^(\D*)(\d*)/);
  const pb = rb.match(/^(\D*)(\d*)/);
  const prefixCmp = (pa[1] || '').localeCompare(pb[1] || '');
  if (prefixCmp !== 0) return prefixCmp;
  const na = pa[2] ? parseInt(pa[2], 10) : NaN;
  const nb = pb[2] ? parseInt(pb[2], 10) : NaN;
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return ra.localeCompare(rb);
}

const SORT_OPTIONS = [
  { v: 'roll_asc', l: 'Roll No ↑' },
  { v: 'roll_desc', l: 'Roll No ↓' },
  { v: 'name_az', l: 'Name A→Z' },
  { v: 'name_za', l: 'Name Z→A' },
];

function RollBadge({ rollNo }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 34, height: 24, padding: '0 8px', borderRadius: 8,
      background: 'var(--accent2)', color: '#fff', fontSize: 12, fontWeight: 800, flexShrink: 0,
    }}>
      {rollNo || '+Roll'}
    </span>
  );
}

// Same centered popup used by PerformancePage's Program/Sport/Sort filters —
// a dark overlay + a card of radio rows, closing itself on selection.
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

export default function StudentsTab() {
  const { visibleStudents, students, visibleSports, visibleBatches, refresh } = useAcademyData();
  const { isAdmin, academyId, appUser, canViewContact, canExport } = useAuth();
  const [search, setSearch] = useState('');
  const [sportFilter, setSportFilter] = useState('');
  const [batchFilter, setBatchFilter] = useState('');
  const [sortBy, setSortBy] = useState('roll_asc');
  const [popup, setPopup] = useState(null); // 'sport' | 'batch' | 'sort' | null
  const [selected, setSelected] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'active' | 'dropped' — toggled by the counter pills
  const [showImport, setShowImport] = useState(false);
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [detailStudent, setDetailStudent] = useState(null);
  const [editStudent, setEditStudent] = useState(null);

  const filtered = useMemo(() => {
    let list = visibleStudents.filter(s => {
      if (sportFilter && !s.enrollments.some(en => en.sport === sportFilter)) return false;
      if (batchFilter && !s.enrollments.some(en => en.batch === batchFilter)) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(s.name?.toLowerCase().includes(q) || s.roll_no?.toLowerCase?.().includes(q))) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'roll_desc': return compareRollNo(b.roll_no, a.roll_no);
        case 'name_az': return (a.name || '').localeCompare(b.name || '');
        case 'name_za': return (b.name || '').localeCompare(a.name || '');
        default: return compareRollNo(a.roll_no, b.roll_no);
      }
    });
    return list;
  }, [visibleStudents, sportFilter, batchFilter, search, sortBy]);

  // Dropped (banned) students sink to the bottom under their own section.
  const activeList = useMemo(() => filtered.filter(s => !s.banned), [filtered]);
  const droppedList = useMemo(() => filtered.filter(s => s.banned), [filtered]);

  const batchesForSport = visibleBatches.filter(b => !sportFilter || b.sport === sportFilter);

  const selectSport = (sportName) => {
    setSportFilter(sportName);
    const firstBatch = visibleBatches.find(b => b.sport === sportName);
    setBatchFilter(sportName ? (firstBatch ? firstBatch.name : '') : '');
    setPopup(null);
  };

  // Active and Dropped are selected as two separate groups — selecting a
  // checkbox in one group clears whatever was selected in the other, so
  // "select all" / bulk actions never mix active with dropped students.
  const activeIdSet = useMemo(() => new Set(activeList.map(s => s.id)), [activeList]);
  const droppedIdSet = useMemo(() => new Set(droppedList.map(s => s.id)), [droppedList]);
  const selectedGroup = useMemo(() => {
    if (selected.size === 0) return null;
    for (const id of selected) { if (droppedIdSet.has(id)) return 'dropped'; }
    return 'active';
  }, [selected, droppedIdSet]);

  const toggleSelect = (id, group) => {
    setSelected(prev => {
      // Switching groups mid-selection: start a fresh selection in the new group.
      if (prev.size > 0 && selectedGroup && selectedGroup !== group) {
        return new Set([id]);
      }
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const list = selectedGroup === 'dropped' ? droppedList : activeList;
    setSelected(new Set(list.map(s => s.id)));
  };

  const bulkDelete = async () => {
    if (!isAdmin) return; // UI already hides this from staff; guard kept in case of direct calls
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} student(s)?`)) return;
    const deletedNames = visibleStudents.filter(s => selected.has(s.id)).map(s => s.name || s.roll_no || s.id);
    await supabase.from('students').delete().in('id', Array.from(selected));
    setSelected(new Set());
    refresh();
    logActivity({
      academyId, actorId: appUser?.id, actorName: appUser?.name,
      message: `Deleted ${deletedNames.length} student(s): ${deletedNames.join(', ')}`,
    });
  };

  const restoreSelected = async () => {
    if (!selected.size) return;
    setRestoring(true);
    const bannedOn = null;
    const restoredNames = visibleStudents.filter(s => selected.has(s.id)).map(s => s.name || s.roll_no || s.id);
    await supabase.from('students')
      .update({ banned: false, banned_on: bannedOn })
      .in('id', Array.from(selected));
    setRestoring(false);
    setShowRestoreConfirm(false);
    setSelected(new Set());
    refresh();
    logActivity({
      academyId, actorId: appUser?.id, actorName: appUser?.name,
      message: `Restored ${restoredNames.length} dropped student(s): ${restoredNames.join(', ')}`,
    });
  };

  const selectedBatchLabel = batchesForSport.find(b => b.name === batchFilter)?.batchLabel;
  const selectedSortLabel = SORT_OPTIONS.find(o => o.v === sortBy)?.l;

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="section-title" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>👥 Students</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button
              onClick={() => setStatusFilter(f => f === 'active' ? 'all' : 'active')}
              style={{
                fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 10, cursor: 'pointer', lineHeight: 1.6,
                border: statusFilter === 'active' ? '1.5px solid var(--gray)' : '1.5px solid transparent',
                background: 'var(--card2)', color: 'var(--gray)',
              }}
            >
              {(sportFilter || batchFilter || search)
                ? `${activeList.length} active of ${visibleStudents.filter(s => !s.banned).length}`
                : `${visibleStudents.filter(s => !s.banned).length} active`}
            </button>
            {visibleStudents.some(s => s.banned) && (
              <button
                onClick={() => setStatusFilter(f => f === 'dropped' ? 'all' : 'dropped')}
                style={{
                  fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 10, cursor: 'pointer', lineHeight: 1.6,
                  border: statusFilter === 'dropped' ? '1.5px solid #ef4444' : '1.5px solid transparent',
                  background: 'rgba(220,38,38,.12)', color: '#ef4444',
                }}
              >
                {(sportFilter || batchFilter || search)
                  ? `${droppedList.length} dropped of ${visibleStudents.filter(s => s.banned).length}`
                  : `${visibleStudents.filter(s => s.banned).length} dropped`}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
          {canExport && <button className="btn btn-gold btn-sm" style={{ padding: '5px 8px', fontSize: 11 }} onClick={() => exportStudentsPdf(filtered)}>PDF</button>}
          {canExport && <button className="btn btn-success btn-sm" style={{ padding: '5px 8px', fontSize: 11 }} onClick={() => exportStudentsXlsx(filtered)}>XL</button>}
          <button className="btn btn-outline btn-sm" style={{ padding: '5px 8px', fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => setShowImport(true)}>⬆️ Import</button>
          <LimitGatedButton
            resource="students"
            currentCount={students.length}
            onClick={() => setShowAdd(true)}
            className="btn btn-primary btn-sm"
            style={{ padding: '5px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
          >
            + Add
          </LimitGatedButton>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 8 }}>
        <div className="search-wrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input type="text" className="search-input" placeholder="Search by name or roll number…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button type="button" className="search-clear-btn" onClick={() => setSearch('')} aria-label="Clear search">✕</button>}
        </div>
        {/* sport / batch / sort — single row, opens the same popup style as Performance's filters */}
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sport')}>
            {sportFilter || 'All Sports'}
          </button>
          <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('batch')}>
            {selectedBatchLabel || 'All Batches'}
          </button>
          <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sort')}>
            {selectedSortLabel || 'Sort'}
          </button>
        </div>
      </div>

      {popup === 'sport' && (
        <FilterPopup title="Select Sport" onClose={() => setPopup(null)}>
          <RadioRow name="sportsel" checked={!sportFilter} onChange={() => selectSport('')} label="All Sports" />
          {visibleSports.map(s => (
            <RadioRow key={s.id} name="sportsel" checked={sportFilter === s.name} onChange={() => selectSport(s.name)} label={s.name} />
          ))}
        </FilterPopup>
      )}

      {popup === 'batch' && (
        <FilterPopup title="Select Batch" onClose={() => setPopup(null)}>
          <RadioRow name="batchsel" checked={!batchFilter} onChange={() => { setBatchFilter(''); setPopup(null); }} label="All Batches" />
          {batchesForSport.map(b => (
            <RadioRow key={b.id} name="batchsel" checked={batchFilter === b.name} onChange={() => { setBatchFilter(b.name); setPopup(null); }} label={b.batchLabel} />
          ))}
        </FilterPopup>
      )}

      {popup === 'sort' && (
        <FilterPopup title="Sort By" onClose={() => setPopup(null)}>
          {SORT_OPTIONS.map(o => (
            <RadioRow key={o.v} name="sortsel" checked={sortBy === o.v} onChange={() => { setSortBy(o.v); setPopup(null); }} label={o.l} />
          ))}
        </FilterPopup>
      )}

      {selected.size > 0 && (
        <div style={{ background: 'var(--accent)', border: '1px solid var(--accent2)', borderRadius: 10, padding: '7px 8px', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>{selected.size} selected</div>
          <div style={{ display: 'grid', gridTemplateColumns: isAdmin ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: 4 }}>
            <button
              onClick={selectAll}
              disabled={selected.size === (selectedGroup === 'dropped' ? droppedList.length : activeList.length)}
              style={{ minWidth: 0, fontSize: 10, fontWeight: 700, padding: '6px 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', border: '1.5px solid #000', borderRadius: 6, background: '#fff', color: '#000', opacity: selected.size === (selectedGroup === 'dropped' ? droppedList.length : activeList.length) ? 0.5 : 1 }}
            >
              ☑ All
            </button>
            <button
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              style={{ minWidth: 0, fontSize: 10, fontWeight: 700, padding: '6px 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', border: '1.5px solid #000', borderRadius: 6, background: '#fff', color: '#000', opacity: selected.size === 0 ? 0.5 : 1 }}
            >
              ✕ None
            </button>
            <button
              onClick={() => selectedGroup === 'dropped' ? setShowRestoreConfirm(true) : setShowBulkEdit(true)}
              disabled={selected.size === 0}
              style={{ minWidth: 0, fontSize: 10, fontWeight: 700, padding: '6px 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', border: '1.5px solid #000', borderRadius: 6, background: 'var(--primary, #4f6bed)', color: '#fff', opacity: selected.size === 0 ? 0.5 : 1 }}
            >
              {selectedGroup === 'dropped' ? '↩️ Restore' : '✏️ Edit'}
            </button>
            {isAdmin && (
              <button
                onClick={bulkDelete}
                disabled={selected.size === 0}
                style={{ minWidth: 0, fontSize: 10, fontWeight: 700, padding: '6px 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', border: '1.5px solid #000', borderRadius: 6, background: 'var(--red)', color: '#fff', opacity: selected.size === 0 ? 0.5 : 1 }}
              >
                🗑️ Del
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 90, marginTop: 4 }}>
        {(statusFilter === 'active' ? activeList.length === 0
          : statusFilter === 'dropped' ? droppedList.length === 0
          : filtered.length === 0) && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No students found.</div>}
        {statusFilter !== 'dropped' && activeList.map(s => (
          <div key={s.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8, cursor: 'pointer' }}
            onClick={(e) => { if (e.target.type !== 'checkbox') setDetailStudent(s); }}>
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id, 'active')} onClick={e => e.stopPropagation()} />
            <RollBadge rollNo={s.roll_no} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
            </div>
            <span style={{ color: 'var(--gray)' }}>›</span>
          </div>
        ))}

        {statusFilter !== 'active' && droppedList.length > 0 && (
          <>
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: '.6px', margin: '18px 0 10px' }}>
              — Dropout / Banned Students —
            </div>
            {droppedList.map(s => (
              <div key={s.id} className="card" style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8, cursor: 'pointer',
                background: 'rgba(220,38,38,.05)', border: '1px solid rgba(220,38,38,.25)',
              }}
                onClick={(e) => { if (e.target.type !== 'checkbox') setDetailStudent(s); }}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id, 'dropped')} onClick={e => e.stopPropagation()} />
                <RollBadge rollNo={s.roll_no} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {s.name}
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: 'rgba(220,38,38,.12)', color: '#ef4444' }}>Dropout</span>
                  </div>
                </div>
                <span style={{ color: 'var(--gray)' }}>›</span>
              </div>
            ))}
          </>
        )}
      </div>

      {showAdd && (
        <AddStudentModal
          academyId={academyId}
          sports={visibleSports}
          batches={visibleBatches}
          existingStudents={visibleStudents}
          onClose={() => setShowAdd(false)}
          onSaved={() => setShowAdd(false)} /* single-row add/edit — AcademyDataContext's realtime subscription already merges it in, no full refetch needed */
        />
      )}

      {showRestoreConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--card)', width: '100%', maxWidth: 420, borderRadius: 16, boxShadow: 'var(--shadow)', padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 18 }}>↩️</span>
              <span style={{ fontWeight: 800, fontSize: 15 }}>Restore {selected.size} student{selected.size === 1 ? '' : 's'}?</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginBottom: 18 }}>
              {selected.size === 1 ? 'This student' : `These ${selected.size} students`} will be moved back to the Active list.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center', padding: '10px 0' }} onClick={() => setShowRestoreConfirm(false)} disabled={restoring}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 1.4, justifyContent: 'center', padding: '10px 0' }} onClick={restoreSelected} disabled={restoring}>
                {restoring ? 'Restoring…' : `↩️ Continue`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkEdit && (
        <BulkEditStudentsModal
          students={visibleStudents}
          selectedIds={selected}
          allStudents={visibleStudents}
          sports={visibleSports}
          batches={visibleBatches}
          academyId={academyId}
          mode={selectedGroup}
          onClose={() => setShowBulkEdit(false)}
          onSaved={() => { setShowBulkEdit(false); setSelected(new Set()); refresh(); }}
        />
      )}

      {showImport && (
        <ImportStudentsModal
          academyId={academyId}
          sports={visibleSports}
          batches={visibleBatches}
          existingStudents={visibleStudents}
          totalStudents={students.length}
          onClose={() => setShowImport(false)}
          onImported={refresh}
        />
      )}

      {detailStudent && (
        <StudentDetailModal
          student={detailStudent}
          academyId={academyId}
          isAdmin={isAdmin}
          canViewContact={canViewContact}
          canExport={canExport}
          onClose={() => setDetailStudent(null)}
          onEdit={(s) => setEditStudent(s)}
          onChanged={refresh}
        />
      )}

      {editStudent && (
        <AddStudentModal
          academyId={academyId}
          sports={visibleSports}
          batches={visibleBatches}
          student={editStudent}
          existingStudents={visibleStudents}
          onClose={() => setEditStudent(null)}
          onSaved={() => setEditStudent(null)} /* single-row edit — realtime handles the merge */
        />
      )}
    </div>
  );
}
