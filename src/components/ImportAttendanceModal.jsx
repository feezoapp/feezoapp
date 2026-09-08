import { useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabaseClient';

const HEADER_MAP = {
  name: 'name', studentname: 'name', fullname: 'name',
  rollno: 'rollNo', roll: 'rollNo', rollnumber: 'rollNo', sno: 'rollNo', no: 'rollNo',
  sport: 'sport', sportname: 'sport', game: 'sport', discipline: 'sport',
  batch: 'batch', batchname: 'batch', group: 'batch', class: 'batch',
};
const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A date-column header looks like DD/MM/YYYY (also accepts DD-MM-YYYY).
const DATE_HEADER_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
function parseHeaderDate(h) {
  const m = String(h || '').trim().match(DATE_HEADER_RE);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function formatDDMMYYYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Composite key used to line up an imported cell with any already-saved
// attendance row for the same student+date+sport+batch. Trimmed + lowercased
// so a casing/whitespace difference doesn't cause a real update to be
// misread as a brand-new insert (or vice versa).
const normKey = (v) => (v || '').toString().trim().toLowerCase();
const rowKey = (studentId, date, sport, batch) => `${studentId}::${date}::${normKey(sport)}::${normKey(batch)}`;
// Key for attendance_day_status lookups — matches AttendanceTab's dsKey.
// '*' is the batch sentinel for rows closed before batch-level locking existed.
const dsKey = (sport, batch) => `${normKey(sport)}::${normKey(batch)}`;

function parseCSVLine(line) {
  const cols = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cols.push(cur.trim());
  return cols;
}

export default function ImportAttendanceModal({ academyId, existingStudents, sportFilter, batchFilter, markedBy, onClose, onImported }) {
  const [preview, setPreview] = useState(null); // { dateColumns, studentRows, insertCount, updateCount, unchangedCount, rejected }
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false); // true once user has reviewed the summary and is on the final "are you sure" step

  const downloadTemplate = () => {
    // Sample data comes from the admin/staff's own visible students, preferring
    // the currently filtered sport/batch, otherwise the first sport+batch found.
    let sampleSource = existingStudents;
    if (sportFilter) sampleSource = sampleSource.filter(s => s.sport === sportFilter);
    if (batchFilter) sampleSource = sampleSource.filter(s => s.batchLabel === batchFilter);
    if (!sampleSource.length) {
      const firstSport = existingStudents[0]?.sport;
      const firstBatch = existingStudents.find(s => s.sport === firstSport)?.batchLabel;
      sampleSource = existingStudents.filter(s => s.sport === firstSport && s.batchLabel === firstBatch);
    }
    const sample = sampleSource.slice(0, 2);

    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    const d1 = formatDDMMYYYY(today.toISOString().slice(0, 10));
    const d2 = formatDDMMYYYY(tomorrow.toISOString().slice(0, 10));
    const headers = ['Name', 'RollNo', 'Sport', 'Batch', d1, d2];

    const rows = sample.length
      ? sample.map((s, i) => [s.name, s.roll_no, s.sport, s.batchLabel, i === 0 ? 'P' : 'A', i === 0 ? 'A' : 'P'])
      : [['Student Name', 'Roll No', 'Sport', 'Batch', 'P', 'A']];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    const instr = [
      ['HOW TO USE THIS TEMPLATE'], [''],
      ['1. Name or RollNo is required to identify the student.'],
      ["2. Batch must exactly match the student's batch in the app \u2014 rows are skipped if it doesn't."],
      ['3. Add one column per date to mark, with the header as DD/MM/YYYY (e.g. 15/06/2025).'],
      ['4. Fill each date column with P for Present, A for Absent. Leave a cell blank to skip that student for that date.'],
      ['5. First row is treated as header and skipped.'],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI['!cols'] = [{ wch: 78 }];
    XLSX.utils.book_append_sheet(wb, wsI, 'Instructions');
    XLSX.writeFile(wb, 'Attendance_Import_Template.xlsx');
  };

  const parseText = async (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { setError('File must have a header row and at least one data row.'); return; }
    const headerCols = parseCSVLine(lines[0]);
    const colMap = {};
    const dateCols = []; // { index, iso }
    headerCols.forEach((h, i) => {
      const key = HEADER_MAP[normHeader(h)];
      if (key && !(key in colMap)) { colMap[key] = i; return; }
      const iso = parseHeaderDate(h);
      if (iso) dateCols.push({ index: i, iso });
    });
    if (colMap.name === undefined && colMap.rollNo === undefined) {
      setError('Could not find a "Name" or "RollNo" column.'); return;
    }
    if (!dateCols.length) {
      setError('No date columns found. Headers must be in DD/MM/YYYY format.'); return;
    }

    // Attendance can't be marked for future dates — same rule as the manual
    // P/A buttons. Drop those columns from marking entirely rather than
    // rejecting the whole file; surface which dates got skipped in the preview.
    const today = todayIso();
    const futureDateCols = dateCols.filter(dc => dc.iso > today);
    const validDateCols = dateCols.filter(dc => dc.iso <= today);
    if (!validDateCols.length) {
      setError('All date columns are in the future — attendance cannot be marked for future dates.'); return;
    }

    const get = (cols, key) => (colMap[key] !== undefined ? (cols[colMap[key]] || '').trim() : '');
    const matchedRows = []; // { student, cells: [{iso, status}] } — pre-classification
    const rejected = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const name = get(cols, 'name');
      const rollNo = get(cols, 'rollNo');
      const sportRaw = get(cols, 'sport');
      const batchRaw = get(cols, 'batch');
      if (!name && !rollNo) { rejected.push({ label: `Row ${i + 1}`, reason: 'Missing Name and RollNo', kind: 'reject' }); continue; }

      let student = null;
      if (rollNo) student = existingStudents.find(s => (s.roll_no || '').toLowerCase() === rollNo.toLowerCase());
      if (!student && name) {
        const matches = existingStudents.filter(s => (s.name || '').toLowerCase() === name.toLowerCase());
        student = matches.length === 1 ? matches[0] : matches.find(s =>
          (!batchRaw || s.batchLabel?.toLowerCase() === batchRaw.toLowerCase()) &&
          (!sportRaw || s.sport?.toLowerCase() === sportRaw.toLowerCase())
        );
      }
      if (!student) { rejected.push({ label: name || rollNo, reason: 'Student not found in this academy', kind: 'reject' }); continue; }

      if (batchRaw && student.batchLabel?.toLowerCase() !== batchRaw.toLowerCase()) {
        rejected.push({ label: student.name, reason: `Batch "${batchRaw}" doesn't match student's batch (${student.batchLabel})`, kind: 'reject' });
        continue;
      }
      if (sportRaw && student.sport?.toLowerCase() !== sportRaw.toLowerCase()) {
        rejected.push({ label: student.name, reason: `Sport "${sportRaw}" doesn't match student's sport (${student.sport})`, kind: 'reject' });
        continue;
      }

      const cells = [];
      validDateCols.forEach(dc => {
        const val = (cols[dc.index] || '').trim().toUpperCase();
        if (val === 'P' || val === 'A') cells.push({ iso: dc.iso, status: val });
        // blank or anything else -> that single cell is just not marked, no reason needed
      });
      if (!cells.length) {
        rejected.push({ label: student.name, reason: 'No P/A value in any date column', kind: 'skip' });
        continue;
      }
      matchedRows.push({ student, cells });
    }

    if (!matchedRows.length) {
      setPreview({
        dateColumns: validDateCols.map(d => d.iso), futureDatesSkipped: futureDateCols.map(d => d.iso),
        studentRows: [], rejected, insertCount: 0, updateCount: 0, unchangedCount: 0,
      });
      setError('');
      return;
    }

    // Check what's already saved so each cell can be classified as a brand-new
    // insert vs. an update to (or no change from) an existing mark, instead of
    // blindly overwriting. Matched on student+date+sport+batch — the same
    // composite key attendance is actually stored/upserted under — so a
    // student with two enrollments on the same date is compared correctly
    // and one sport's mark never gets confused with the other's.
    const studentIds = [...new Set(matchedRows.map(r => r.student.id))];
    const isoDates = [...new Set(matchedRows.flatMap(r => r.cells.map(c => c.iso)))];
    const existingMap = {};
    try {
      const { data: existingRows, error: fetchErr } = await supabase.from('attendance')
        .select('student_id,date,sport,batch,status')
        .eq('academy_id', academyId)
        .in('student_id', studentIds)
        .in('date', isoDates);
      if (fetchErr) throw fetchErr;
      (existingRows || []).forEach(r => {
        existingMap[rowKey(r.student_id, r.date, r.sport, r.batch)] = r.status;
      });
    } catch (err) {
      setError(`Could not check existing attendance before import: ${err.message}`);
      return;
    }

    // A closed register locks out new marks the same way the manual P/A
    // buttons do — check before classifying so a closed cell is skipped
    // instead of silently overwriting (or being blocked entirely by RLS/a
    // trigger later, with no explanation shown here). Fails open (treats as
    // not-closed) if this table isn't reachable, matching AttendanceTab's
    // own fallback posture rather than blocking every import on it.
    const sportsInvolved = [...new Set(matchedRows.map(r => r.student.sport).filter(Boolean))];
    const closedMap = {};
    try {
      const { data: statusRows, error: statusErr } = await supabase.from('attendance_day_status')
        .select('date,sport,batch,completed')
        .eq('academy_id', academyId)
        .in('date', isoDates)
        .in('sport', sportsInvolved);
      if (statusErr) throw statusErr;
      (statusRows || []).forEach(r => {
        if (!r.completed) return;
        closedMap[`${r.date}::${dsKey(r.sport, r.batch || '*')}`] = true;
      });
    } catch { /* fail open — see note above */ }
    const isClosedFor = (iso, sport, batch) =>
      !!closedMap[`${iso}::${dsKey(sport, batch)}`] || !!closedMap[`${iso}::${dsKey(sport, '*')}`];

    let insertCount = 0, updateCount = 0, unchangedCount = 0, lockedCount = 0, ineligibleCount = 0;
    const studentRows = matchedRows.map(({ student, cells }) => {
      const marks = cells.map(c => {
        // Same eligibility rule as the manual P/A buttons: no marking before
        // a student joined, or on/after the date they were banned.
        if (student.join_date && c.iso < student.join_date) {
          ineligibleCount++;
          return { iso: c.iso, status: c.status, action: 'ineligible', reason: 'before join date' };
        }
        if (student.banned && (!student.banned_on || c.iso >= student.banned_on)) {
          ineligibleCount++;
          return { iso: c.iso, status: c.status, action: 'ineligible', reason: 'student banned' };
        }
        if (isClosedFor(c.iso, student.sport, student.batchLabel)) {
          lockedCount++;
          return { iso: c.iso, status: c.status, action: 'locked' };
        }
        const existingStatus = existingMap[rowKey(student.id, c.iso, student.sport, student.batchLabel)];
        let action;
        if (existingStatus === undefined) { action = 'insert'; insertCount++; }
        else if (existingStatus === c.status) { action = 'unchanged'; unchangedCount++; }
        else { action = 'update'; updateCount++; }
        return { iso: c.iso, status: c.status, action, previousStatus: existingStatus };
      });
      return {
        student, marks,
        insertCount: marks.filter(m => m.action === 'insert').length,
        updateCount: marks.filter(m => m.action === 'update').length,
        unchangedCount: marks.filter(m => m.action === 'unchanged').length,
        lockedCount: marks.filter(m => m.action === 'locked').length,
        ineligibleCount: marks.filter(m => m.action === 'ineligible').length,
      };
    });

    setPreview({
      dateColumns: validDateCols.map(d => d.iso), futureDatesSkipped: futureDateCols.map(d => d.iso),
      studentRows, rejected, insertCount, updateCount, unchangedCount, lockedCount, ineligibleCount,
    });
    setError('');
  };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
    setPreview(null);
    setConfirming(false);
    const ext = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();
    if (ext === 'csv') {
      reader.onload = ev => parseText(ev.target.result);
      reader.readAsText(file);
    } else if (ext === 'xlsx' || ext === 'xls') {
      reader.onload = ev => {
        try {
          const wb = XLSX.read(ev.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          parseText(XLSX.utils.sheet_to_csv(ws));
        } catch (err) { setError('Could not read Excel file: ' + err.message); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError('Please choose a .csv, .xlsx or .xls file.');
    }
  };

  const submit = async () => {
    if (!preview?.studentRows.length) return;
    setSubmitting(true);
    const payload = [];
    preview.studentRows.forEach(({ student, marks }) => {
      marks.forEach(m => {
        if (m.action === 'unchanged' || m.action === 'locked' || m.action === 'ineligible') return; // nothing to write
        payload.push({
          academy_id: academyId, student_id: student.id, date: m.iso,
          status: m.status, sport: student.sport, batch: student.batchLabel, marked_by: markedBy || 'Import',
        });
      });
    });
    if (!payload.length) { setSubmitting(false); onImported(); onClose(); return; }
    // Upsert in chunks to stay well under request size limits. Conflict target
    // includes sport+batch — matching the real unique constraint on
    // `attendance` — so a student's two different enrollments on the same
    // date each get their own row instead of one overwriting the other.
    let hadError = false;
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await supabase.from('attendance').upsert(payload.slice(i, i + 500), { onConflict: 'academy_id,student_id,date,sport,batch' });
      if (error) hadError = true;
    }
    // Best-effort activity log entry, same shape as AttendanceTab's logAttendance —
    // never blocks the UI if it fails.
    try {
      await supabase.from('audit_log').insert({
        academy_id: academyId,
        actor_name: markedBy || 'Import',
        action: `Imported attendance: ${preview.insertCount} new, ${preview.updateCount} updated, across ${preview.studentRows.length} student(s)`,
        description: `Imported attendance: ${preview.insertCount} new, ${preview.updateCount} updated, across ${preview.studentRows.length} student(s)`,
      });
    } catch { /* audit log is best-effort */ }
    setSubmitting(false);
    if (hadError) { setError('Some rows failed to save — please check and re-import if needed.'); return; }
    onImported();
    onClose();
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999 }}>
      <div style={{ background: 'var(--card)', width: '100%', maxWidth: 480, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>⬆️ Import Attendance</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>📋 Required CSV/Excel format:</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11.5, color: 'var(--gray)', marginBottom: 8, wordBreak: 'break-all' }}>
              Name, RollNo, Sport, Batch, DD/MM/YYYY, DD/MM/YYYY, ...
            </div>
            <div>• <strong>Name</strong> or <strong>RollNo</strong> is required to identify the student.</div>
            <div>• <strong>Batch</strong> must exactly match the student's batch in the app — rows are skipped if it doesn't.</div>
            <div>• Add one column per date to mark, with the header as <strong>DD/MM/YYYY</strong> (e.g. 15/06/2025).</div>
            <div>• Fill each date column with <strong>P</strong> for Present, <strong>A</strong> for Absent. Leave a cell blank to skip that student for that date.</div>
            <div>• First row treated as header and skipped.</div>
            <div>• Future-dated columns are skipped automatically — attendance can't be marked ahead of time.</div>
            <div>• Rows before a student's join date, after they were banned, or on a closed register are skipped automatically.</div>
          </div>

          <button className="btn btn-outline btn-sm" onClick={downloadTemplate}>📥 Download Excel Template</button>

          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', display: 'block', marginBottom: 6 }}>Choose CSV or Excel File</label>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="form-input" />
          </div>

          {error && <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px' }}>⚠️ {error}</div>}

          {preview && (
            <>
              {preview.futureDatesSkipped?.length > 0 && (
                <div style={{ fontSize: 12, color: '#fbbf24', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)', borderRadius: 8, padding: '8px 10px' }}>
                  🔒 Future dates are not allowed — {preview.futureDatesSkipped.length} column(s) skipped: {preview.futureDatesSkipped.map(formatDDMMYYYY).join(', ')}
                </div>
              )}
              {(preview.lockedCount > 0 || preview.ineligibleCount > 0) && (
                <div style={{ fontSize: 12, color: '#f87171', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px' }}>
                  ⛔ {preview.lockedCount + preview.ineligibleCount} cell(s) blocked
                  {preview.lockedCount > 0 && ` — ${preview.lockedCount} on a closed register`}
                  {preview.lockedCount > 0 && preview.ineligibleCount > 0 && ','}
                  {preview.ineligibleCount > 0 && ` ${preview.ineligibleCount} before join date / after ban`}
                  . See below for which — reopen the register on the Attendance tab first if these need to go in.
                </div>
              )}
              {(() => {
                const skippedRows = preview.rejected.filter(r => r.kind === 'skip');
                const rejectedRows = preview.rejected.filter(r => r.kind !== 'skip');
                const skipTotal = preview.unchangedCount + skippedRows.length;
                return (
                  <>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>Insert</div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: '#16a34a' }}>{preview.insertCount}</div>
                      </div>
                      <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>Update</div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: '#d97706' }}>{preview.updateCount}</div>
                      </div>
                      <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>Blocked</div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: '#dc2626' }}>{preview.lockedCount + preview.ineligibleCount}</div>
                      </div>
                      <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>Skip</div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--gray)' }}>{skipTotal}</div>
                      </div>
                      <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>Reject</div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: '#dc2626' }}>{rejectedRows.length}</div>
                      </div>
                    </div>

                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {preview.studentRows.map((r, i) => (
                        <div key={'m' + i} className="card" style={{ padding: 10, fontSize: 12.5 }}>
                          <div><strong>{r.student.name}</strong> · #{r.student.roll_no} · {r.student.sport}/{r.student.batchLabel}</div>
                          <div style={{ marginTop: 5, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {r.insertCount > 0 && (
                              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(22,163,74,.12)', color: '#16a34a' }}>
                                + {r.insertCount} new
                              </span>
                            )}
                            {r.updateCount > 0 && (
                              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(217,119,6,.12)', color: '#d97706' }}>
                                ↻ {r.updateCount} update
                              </span>
                            )}
                            {r.unchangedCount > 0 && (
                              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'var(--card2)', color: 'var(--gray)' }}>
                                = {r.unchangedCount} unchanged
                              </span>
                            )}
                            {r.lockedCount > 0 && (
                              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(220,38,38,.12)', color: '#dc2626' }}>
                                🔒 {r.lockedCount} register closed
                              </span>
                            )}
                            {r.ineligibleCount > 0 && (
                              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(220,38,38,.12)', color: '#dc2626' }}>
                                ⛔ {r.ineligibleCount} not eligible
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {skippedRows.map((r, i) => (
                        <div key={'s' + i} className="card" style={{ padding: 10, fontSize: 12.5, opacity: .75 }}>
                          <strong>{r.label}</strong> — {r.reason}
                          <span style={{ float: 'right', fontWeight: 700, color: 'var(--gray)' }}>Skipped</span>
                        </div>
                      ))}
                      {rejectedRows.map((r, i) => (
                        <div key={'r' + i} className="card" style={{ padding: 10, fontSize: 12.5, opacity: .75 }}>
                          <strong>{r.label}</strong> — {r.reason}
                          <span style={{ float: 'right', fontWeight: 700, color: '#dc2626' }}>Rejected</span>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </div>

        {preview && (preview.insertCount + preview.updateCount) > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
            {confirming && (
              <div style={{ padding: '12px 16px 0' }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.6, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)', borderRadius: 8, padding: '10px 12px' }}>
                  ⚠️ This will save <strong>{preview.insertCount} new</strong> attendance record{preview.insertCount === 1 ? '' : 's'}
                  {preview.updateCount > 0 && (
                    <> and <strong>overwrite {preview.updateCount} existing</strong> record{preview.updateCount === 1 ? '' : 's'}</>
                  )}. This can't be undone. Continue?
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, padding: 16 }}>
              {!confirming ? (
                <>
                  <button className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
                  <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={() => setConfirming(true)}>
                    Review Import ({preview.insertCount + preview.updateCount})
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setConfirming(false)} disabled={submitting}>Back</button>
                  <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={submit} disabled={submitting}>
                    {submitting ? 'Importing…' : `Confirm & Import ${preview.insertCount + preview.updateCount}`}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {preview && (preview.insertCount + preview.updateCount) === 0 && (
          <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
            <button className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
