import { createPortal } from 'react-dom';
import { useMemo, useState } from 'react';

// Wraps a CSV field in quotes and escapes internal quotes only when the
// value actually needs it (contains a comma, quote, or newline) — keeps
// plain values readable while staying safe for names with commas etc.
function csvCell(val) {
  const s = (val === undefined || val === null) ? '' : String(val).replace(/₹/g, 'Rs.');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(header, dataRows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of dataRows) lines.push(r.map(csvCell).join(','));
  return lines.join('\n');
}

function downloadCsv(filename, csvString) {
  // Leading BOM tells Excel/Sheets the file is UTF-8, otherwise ₹ and other
  // non-ASCII characters render as mojibake (e.g. "â‚¹") when opened.
  const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function StatDrilldownModal({ title, icon, students = [], rows, showContact = true, onClose }) {
  const isRowMode = Array.isArray(rows);
  const [sortField, setSortField] = useState('month');
  const [sortDir, setSortDir] = useState('asc');

  const sortedRows = useMemo(() => {
    if (!isRowMode) return [];
    const arr = [...rows];
    arr.sort((a, b) => {
      const cmp = sortField === 'name'
        ? (a.name || '').localeCompare(b.name || '')
        : (a.monthKey || '').localeCompare(b.monthKey || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortField, sortDir, isRowMode]);

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const list = isRowMode ? sortedRows : students;

  const handleExport = () => {
    let csv;
    if (isRowMode) {
      const header = ['Name', 'Month', ...(showContact ? ['Contact'] : []), 'Sport', 'Batch', 'Paid', 'Due', 'Remaining'];
      const dataRows = sortedRows.map(r => [
        r.name || '', r.monthShort || '',
        ...(showContact ? [r.contact || ''] : []),
        r.sport || '', r.batchLabel || '',
        r.partial ? r.paidSoFar : '', r.partial ? r.due : '', r.partial ? r.remaining : '',
      ]);
      csv = rowsToCsv(header, dataRows);
    } else {
      const header = ['Name', 'Sport', 'Batch', ...(showContact ? ['Contact'] : []), 'Extra'];
      const dataRows = students.map(s => [
        s.name || '', s.sport || '', s.batchLabel || '',
        ...(showContact ? [s.contact || ''] : []),
        s.extra || '',
      ]);
      csv = rowsToCsv(header, dataRows);
    }
    const safeTitle = (title || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    downloadCsv(`${safeTitle}.csv`, csv);
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--card)', width: '100%', maxWidth: 480, margin: '0 auto', maxHeight: '82vh', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>{icon}</span>
            <span style={{ fontWeight: 800, fontSize: 16 }}>{title}</span>
            <span style={{ fontSize: 12, color: 'var(--gray)', fontWeight: 600 }}>({list.length})</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {list.length > 0 && (
              <button onClick={handleExport} aria-label="Download CSV" title="Download CSV"
                style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 14, color: 'var(--gray)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⬇️</button>
            )}
            <button onClick={onClose} aria-label="Close"
              style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 15, color: 'var(--gray)' }}>✕</button>
          </div>
        </div>

        {isRowMode && (
          <div style={{ display: 'flex', gap: 6, padding: '10px 14px 0', flexShrink: 0 }}>
            <button onClick={() => toggleSort('name')}
              style={{
                fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 7,
                border: '1px solid var(--border)', cursor: 'pointer',
                background: sortField === 'name' ? 'var(--accent2)' : 'var(--card2)',
                color: sortField === 'name' ? '#fff' : 'var(--gray)',
              }}>
              Name {sortField === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
            <button onClick={() => toggleSort('month')}
              style={{
                fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 7,
                border: '1px solid var(--border)', cursor: 'pointer',
                background: sortField === 'month' ? 'var(--accent2)' : 'var(--card2)',
                color: sortField === 'month' ? '#fff' : 'var(--gray)',
              }}>
              Month {sortField === 'month' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {list.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 30 }}>No students in this category.</div>
          )}

          {isRowMode ? (
            sortedRows.map((r, i) => (
              <div key={r.id || i} className="card"
                style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', marginBottom: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--accent2)', flexShrink: 0, width: 32, textAlign: 'center' }}>
                    {r.monthShort}
                  </div>
                  {showContact ? (
                    r.contact ? (
                      <a href={`tel:${r.contact}`} onClick={e => e.stopPropagation()}
                        style={{ color: 'var(--gray)', fontSize: 12.5, fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}>
                        📞 {r.contact}
                      </a>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--gray)', flexShrink: 0 }}>No contact</span>
                    )
                  ) : null}
                </div>
                {(r.sport || r.partial) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gray)' }}>
                    {r.sport && <span>{r.sport}{r.batchLabel ? ` · ${r.batchLabel}` : ''}</span>}
                    {r.partial && (
                      <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#e0a020', background: 'rgba(230,160,20,0.14)', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                        ₹{r.paidSoFar}/₹{r.due} · ₹{r.remaining} left
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))
          ) : (
            students.map((s, i) => (
              <div key={s.id || i} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                    {s.sport && s.batchLabel ? `${s.sport} · ${s.batchLabel}` : ''}
                    {s.extra ? (s.sport ? ' · ' : '') + s.extra : ''}
                  </div>
                </div>
                {showContact ? (
                  s.contact ? (
                    <a href={`tel:${s.contact}`} onClick={e => e.stopPropagation()}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--accent2)', color: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, textDecoration: 'none', flexShrink: 0 }}>
                      📞 {s.contact}
                    </a>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--gray)' }}>No contact</span>
                  )
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
