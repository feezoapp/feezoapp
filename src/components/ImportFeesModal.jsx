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
const pad = (n) => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METHODS = ['cash', 'upi', 'card', 'bank'];

// A month's fee data is spread across three columns sharing an "MM/YYYY"
// prefix: "MM/YYYY Due", "MM/YYYY Paid", "MM/YYYY Method" (also accepts
// MM-YYYY). A single P/A-style cell doesn't carry enough info for a fee
// entry, so — unlike AttendanceTab's one-column-per-date — fees use one
// three-column *group* per month.
const MONTH_HEADER_RE = /^(\d{1,2})[/-](\d{4})\s+(due|paid|method)$/i;
function parseMonthHeader(h) {
  const m = String(h || '').trim().match(MONTH_HEADER_RE);
  if (!m) return null;
  const [, mo, y, field] = m;
  const moNum = parseInt(mo, 10);
  if (moNum < 1 || moNum > 12) return null;
  return { monthKey: `${y}-${pad(moNum)}`, field: field.toLowerCase() };
}
function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

// Composite key matching the real unique constraint fees is upserted
// under (student_id, sport, batch_label, month) — same pattern as
// AttendanceTab/ImportAttendanceModal's rowKey, one dimension longer
// since fees aren't per-date.
const normKey = (v) => (v || '').toString().trim().toLowerCase();
const rowKey = (studentId, sport, batchLabel, monthKey) => `${studentId}::${normKey(sport)}::${normKey(batchLabel)}::${monthKey}`;

// FIX 1: future-dating guard. Header parsing alone (MONTH_HEADER_RE) never
// checked the month against today — a typo'd or genuinely far-future
// "MM/YYYY" header would import without complaint. Next month is still
// allowed (advance billing is a normal use case), anything further out
// is rejected per-cell below.
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function maxAllowedMonthKey() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
}

// Same overlap test AttendanceTab/FeesTab use to decide whether an
// enrollment segment counts for a given month — a segment counts if its
// join_date/left_date window overlaps that month at all.
function enrollmentOverlapsMonth(en, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const periodStart = `${monthKey}-01`;
  const periodEnd = `${y}-${pad(m)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return (!en.join_date || en.join_date <= periodEnd) && (!en.left_date || en.left_date >= periodStart);
}

// Resolves which sport+batch a student was actually enrolled in for a
// given month, from their full enrollment history — not just their
// current sport/batch — so a fee for a month before a batch switch lands
// against the OLD batch instead of being rejected or misattributed to
// whatever they're in now. Falls back to their single current enrollment
// if no history is recorded. If more than one segment overlaps (a
// mid-month switch), the most-recently-active one wins — still-active
// (no left_date) beats anything closed out, and among closed-out segments
// the latest left_date wins.
function resolveEnrollmentForMonth(student, monthKey) {
  const history = (student.enrollmentHistory && student.enrollmentHistory.length > 0)
    ? student.enrollmentHistory
    : [{ sport: student.sport, batchLabel: student.batchLabel, join_date: student.join_date, left_date: null }];
  const overlapping = history.filter(en => en.sport && enrollmentOverlapsMonth(en, monthKey));
  if (!overlapping.length) return null;
  overlapping.sort((a, b) => {
    if (!a.left_date && b.left_date) return -1;
    if (a.left_date && !b.left_date) return 1;
    return (b.left_date || '').localeCompare(a.left_date || '');
  });
  return overlapping[0];
}

// FIX 2: per-month enrollment check for a row that PINS an explicit
// Sport/Batch. Previously that path only ran studentEverHadEnrollment once
// per row — "did the student ever have this sport/batch" — which says
// nothing about whether it was active in each specific month. That let a
// pinned row create fee entries for months before the student joined that
// batch, or after they'd already left it. This mirrors
// resolveEnrollmentForMonth but additionally filters to the sport/batch
// actually named on the row.
function findPinnedEnrollmentForMonth(student, sport, batchLabel, monthKey) {
  const history = (student.enrollmentHistory && student.enrollmentHistory.length > 0)
    ? student.enrollmentHistory
    : [{ sport: student.sport, batchLabel: student.batchLabel, join_date: student.join_date, left_date: null }];
  const matches = history.filter(en =>
    (!sport || (en.sport || '').toLowerCase() === sport.toLowerCase()) &&
    (!batchLabel || (en.batchLabel || '').toLowerCase() === batchLabel.toLowerCase()) &&
    enrollmentOverlapsMonth(en, monthKey)
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (!a.left_date && b.left_date) return -1;
    if (a.left_date && !b.left_date) return 1;
    return (b.left_date || '').localeCompare(a.left_date || '');
  });
  return matches[0];
}

// FIX 3 (soft check): presence-based eligibility, mirroring FeesTab's
// isEligible() — a fee entry for a month the student was enrolled in but
// never actually attended (no Present record for that sport/batch) is
// still allowed on import (advance billing / manual catch-up are normal),
// but it's flagged in the preview instead of silently going through
// unnoticed, since the earlier version never checked attendance at all.
async function fetchAttendancePresence(academyId, studentIds, monthKeys) {
  if (!studentIds.length || !monthKeys.length) return {};
  const from = `${monthKeys[0]}-01`;
  const [ly, lm] = monthKeys[monthKeys.length - 1].split('-').map(Number);
  const to = `${monthKeys[monthKeys.length - 1]}-${String(new Date(ly, lm, 0).getDate()).padStart(2, '0')}`;
  const { data, error } = await supabase.from('attendance')
    .select('student_id,sport,batch,date,status')
    .eq('academy_id', academyId)
    .eq('status', 'P')
    .in('student_id', studentIds)
    .gte('date', from)
    .lte('date', to);
  if (error) throw error;
  const map = {}; // studentId -> Set of "sport::batch::monthKey"
  (data || []).forEach(r => {
    const mk = r.date.slice(0, 7);
    const k = `${normKey(r.sport)}::${normKey(r.batch)}::${mk}`;
    if (!map[r.student_id]) map[r.student_id] = new Set();
    map[r.student_id].add(k);
  });
  return map;
}

// Whether this sport/batch appears ANYWHERE in the student's record —
// current or past — used to validate an explicit Sport/Batch column
// against the student's full history instead of just their current
// enrollment, so a row correctly naming an old batch isn't rejected just
// because the student has since switched.
function studentEverHadEnrollment(student, sport, batchLabel) {
  const history = (student.enrollmentHistory && student.enrollmentHistory.length > 0)
    ? student.enrollmentHistory
    : [{ sport: student.sport, batchLabel: student.batchLabel }];
  return history.some(en =>
    (!sport || (en.sport || '').toLowerCase() === sport.toLowerCase()) &&
    (!batchLabel || (en.batchLabel || '').toLowerCase() === batchLabel.toLowerCase())
  );
}

// Same auto-generated transaction ID scheme as FeesTab's genTxnId — kept as
// a local copy since each import modal is self-contained (matches how
// ImportAttendanceModal/ImportStudentsModal don't import helpers from their
// tab files either).
function genTxnId(academyId, rollNo, seq) {
  const academyPart = (academyId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'ACD';
  const rollPart = (rollNo || 'NA').toString().toUpperCase();
  const seqPart = String(seq).padStart(3, '0');
  return `TXN-${academyPart}-${rollPart}-${seqPart}`;
}

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

// Same "once fully paid, only admin can touch it" rule FeesTab's canEditFee
// enforces on manual entry — kept as a local copy (self-contained modal,
// same convention as duplicating parseCSVLine/genTxnId above) so a staff
// member importing a sheet can't silently overwrite a settled fee that
// they'd be blocked from editing by hand.
function feeStatus(row) {
  if (!row) return 'unpaid';
  if (row.is_scholarship) return 'paid';
  const due = parseInt(row.amount_due, 10);
  const paid = parseInt(row.amount, 10) || 0;
  if (!due || isNaN(due)) return paid > 0 ? 'paid' : 'unpaid';
  if (paid <= 0) return 'unpaid';
  if (paid >= due) return 'paid';
  return 'partial';
}

export default function ImportFeesModal({ academyId, existingStudents, sportFilter, batchFilter, collectedBy, isAdmin, onClose, onImported }) {
  const [preview, setPreview] = useState(null); // { monthColumns, studentRows, insertCount, updateCount, unchangedCount, rejected, _maxTxnSeq }
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const downloadTemplate = () => {
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
    const thisMonth = `${pad(today.getMonth() + 1)}/${today.getFullYear()}`;
    const headers = ['Name', 'RollNo', 'Sport', 'Batch', `${thisMonth} Due`, `${thisMonth} Paid`, `${thisMonth} Method`];
    const rows = sample.length
      ? sample.map((s, i) => [s.name, s.roll_no, '', '', 1000, i === 0 ? 1000 : 500, i === 0 ? 'cash' : 'upi'])
      : [['Student Name', 'Roll No', '', '', 1000, 1000, 'cash']];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Fees');
    const instr = [
      ['HOW TO USE THIS TEMPLATE'], [''],
      ['1. Name or RollNo is required to identify the student.'],
      ['2. Sport/Batch are optional. Leave BOTH blank to auto-detect the correct sport/batch for each month from the'],
      ['   student\u2019s enrollment history \u2014 this correctly handles a student who switched batches partway through the'],
      ['   year, attributing each month\u2019s fee to whichever batch they were actually in at the time.'],
      ['3. Fill in Sport/Batch only to PIN every month in that row to one specific enrollment (current or past) \u2014'],
      ['   useful when a name matches more than one student, or to force a whole row onto an old batch. It\'s checked'],
      ['   against the student\u2019s full history, not just their current batch, so a valid past batch is accepted.'],
      ['4. Add a group of 3 columns per month: "MM/YYYY Due", "MM/YYYY Paid", "MM/YYYY Method" (e.g. 06/2026 Due).'],
      ['5. Due = total amount owed for that month. Paid = amount collected so far \u2014 0 or blank if nothing collected yet.'],
      ['6. Method = cash, upi, card, or bank. Use "scholarship" to mark the fee fully waived (Due/Paid become optional).'],
      ['7. Leave all three cells in a month-group blank to skip that student for that month.'],
      ['8. First row is treated as header and skipped.'],
      ['9. A row matching an existing entry exactly (same Due/Paid/Method) is left unchanged \u2014 no duplicate payment is recorded.'],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI['!cols'] = [{ wch: 82 }];
    XLSX.utils.book_append_sheet(wb, wsI, 'Instructions');
    XLSX.writeFile(wb, 'Fees_Import_Template.xlsx');
  };

  const parseText = async (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { setError('File must have a header row and at least one data row.'); return; }
    const headerCols = parseCSVLine(lines[0]);
    const colMap = {};
    const monthGroups = {}; // monthKey -> { due: idx, paid: idx, method: idx }
    headerCols.forEach((h, i) => {
      const key = HEADER_MAP[normHeader(h)];
      if (key && !(key in colMap)) { colMap[key] = i; return; }
      const mh = parseMonthHeader(h);
      if (mh) {
        if (!monthGroups[mh.monthKey]) monthGroups[mh.monthKey] = {};
        monthGroups[mh.monthKey][mh.field] = i;
      }
    });
    if (colMap.name === undefined && colMap.rollNo === undefined) {
      setError('Could not find a "Name" or "RollNo" column.'); return;
    }
    const monthKeys = Object.keys(monthGroups).filter(mk => monthGroups[mk].due !== undefined).sort();
    if (!monthKeys.length) {
      setError('No month columns found. Headers must be like "MM/YYYY Due", "MM/YYYY Paid", "MM/YYYY Method".'); return;
    }

    const get = (cols, idx) => (idx !== undefined ? (cols[idx] || '').trim() : '');
    const matchedRows = []; // { student, cells: [{monthKey, due, paid, method, isScholarship}] }
    const rejected = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const name = get(cols, colMap.name);
      const rollNo = get(cols, colMap.rollNo);
      const sportRaw = get(cols, colMap.sport);
      const batchRaw = get(cols, colMap.batch);
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

      // An explicit Sport/Batch on the row pins EVERY month in it to that one
      // enrollment (current or past) — validated against the student's full
      // history, not just their current sport/batch, so a row correctly
      // naming an old batch isn't rejected just because they've since
      // switched. Leaving both blank instead lets each month resolve its
      // own sport/batch from history below, which is what handles a
      // mid-year switch without needing two separate rows.
      if ((batchRaw || sportRaw) && !studentEverHadEnrollment(student, sportRaw, batchRaw)) {
        const want = [sportRaw, batchRaw].filter(Boolean).join('/');
        rejected.push({ label: student.name, reason: `"${want}" doesn't match any of the student's current or past enrollments`, kind: 'reject' });
        continue;
      }

      const cells = [];
      let rowHadRejection = false;
      for (const mk of monthKeys) {
        const g = monthGroups[mk];
        const dueRaw = get(cols, g.due);
        const paidRaw = get(cols, g.paid);
        const methodRaw = get(cols, g.method).toLowerCase();
        if (!dueRaw && !paidRaw && !methodRaw) continue; // fully blank group -> skip this month for this student

        // FIX 1: reject months further out than next calendar month.
        if (mk > maxAllowedMonthKey()) {
          rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: `Future month beyond ${monthLabel(maxAllowedMonthKey())} isn't allowed`, kind: 'reject' });
          rowHadRejection = true;
          continue;
        }

        const isScholarship = methodRaw === 'scholarship';
        const dueParsed = parseInt(dueRaw, 10);
        if (!isScholarship && (!dueRaw || isNaN(dueParsed) || dueParsed < 1)) {
          rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: 'Due amount missing or invalid', kind: 'reject' });
          rowHadRejection = true;
          continue;
        }
        // Sport/Batch given on the row pins this month to that exact
        // enrollment; otherwise resolve which one was actually active THIS
        // month from the student's history, so a switch mid-year still
        // lands each month's fee against whichever batch they were really
        // in at the time.
        let cellSport, cellBatch;
        if (sportRaw || batchRaw) {
          const pinned = findPinnedEnrollmentForMonth(student, sportRaw, batchRaw, mk);
          if (!pinned) {
            const want = [sportRaw, batchRaw].filter(Boolean).join('/');
            rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: `Not enrolled in "${want}" during this month`, kind: 'reject' });
            rowHadRejection = true;
            continue;
          }
          cellSport = sportRaw || pinned.sport;
          cellBatch = batchRaw || pinned.batchLabel;
        } else {
          const en = resolveEnrollmentForMonth(student, mk);
          if (!en) {
            rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: 'Not enrolled in any sport/batch during this month', kind: 'reject' });
            rowHadRejection = true;
            continue;
          }
          cellSport = en.sport;
          cellBatch = en.batchLabel;
        }
        const due = isScholarship ? (isNaN(dueParsed) ? 0 : dueParsed) : dueParsed;
        const paid = isScholarship ? due : (parseInt(paidRaw, 10) || 0);
        if (!isScholarship && paid > due) {
          rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: `Paid (₹${paid}) can't exceed Due (₹${due})`, kind: 'reject' });
          rowHadRejection = true;
          continue;
        }
        if (!isScholarship && methodRaw && !METHODS.includes(methodRaw)) {
          rejected.push({ label: `${student.name} — ${monthLabel(mk)}`, reason: `Unrecognized method "${methodRaw}" — use cash, upi, card, bank, or scholarship`, kind: 'reject' });
          rowHadRejection = true;
          continue;
        }
        cells.push({
          monthKey: mk, due, paid,
          method: isScholarship ? 'scholarship' : (paid > 0 ? (methodRaw || 'cash') : null),
          isScholarship, sport: cellSport, batchLabel: cellBatch,
        });
      }
      if (!cells.length) {
        if (!rowHadRejection) rejected.push({ label: student.name, reason: 'No fee data in any month column', kind: 'skip' });
        continue;
      }
      matchedRows.push({ student, cells });
    }

    if (!matchedRows.length) {
      setPreview({ monthColumns: monthKeys, studentRows: [], rejected, insertCount: 0, updateCount: 0, unchangedCount: 0 });
      setError('');
      return;
    }

    // Check what's already saved so each cell can be classified as a brand-new
    // insert vs. an update to (or no change from) an existing entry — matched
    // on student+sport+batch+month, the same composite key fees is actually
    // upserted under, same principle as ImportAttendanceModal's existingMap.
    const studentIds = [...new Set(matchedRows.map(r => r.student.id))];
    const existingMap = {};
    const maxTxnSeq = {}; // studentId -> running payment count, seeds the next txn id
    try {
      const { data: existingRows, error: fetchErr } = await supabase.from('fees')
        .select('student_id,sport,batch_label,month,amount_due,amount,method,is_scholarship,payments,msg_sent,paid_date')
        .eq('academy_id', academyId)
        .in('student_id', studentIds);
      if (fetchErr) throw fetchErr;
      (existingRows || []).forEach(r => {
        existingMap[rowKey(r.student_id, r.sport, r.batch_label, r.month)] = r;
        const n = (r.payments || []).length;
        if (n) maxTxnSeq[r.student_id] = (maxTxnSeq[r.student_id] || 0) + n;
      });
    } catch (err) {
      setError(`Could not check existing fees before import: ${err.message}`);
      return;
    }

    // Soft eligibility check (FIX 3) — best-effort, never blocks the import.
    let presenceMap = {};
    try {
      presenceMap = await fetchAttendancePresence(academyId, studentIds, monthKeys);
    } catch (err) {
      console.error('Attendance eligibility check failed (import proceeds without warnings):', err);
    }
    const thisMonth = currentMonthKey();

    let insertCount = 0, updateCount = 0, unchangedCount = 0;
    const studentRows = matchedRows.map(({ student, cells }) => {
      const marks = cells.map(c => {
        const existing = existingMap[rowKey(student.id, c.sport, c.batchLabel, c.monthKey)];
        // A month that hasn't happened yet can't have attendance, so only
        // warn for months up to and including the current one.
        const attKey = `${normKey(c.sport)}::${normKey(c.batchLabel)}::${c.monthKey}`;
        const warning = (!c.isScholarship && c.monthKey <= thisMonth && !presenceMap[student.id]?.has(attKey))
          ? 'No attendance recorded for this sport/batch that month'
          : null;
        // A non-admin importer can't touch a fee that's already fully paid or
        // scholarship-settled — matches canEditFee's rule for manual entry.
        if (existing && !isAdmin && feeStatus(existing) === 'paid') {
          rejected.push({ label: `${student.name} — ${monthLabel(c.monthKey)}`, reason: 'Fee already fully paid — only admin can modify', kind: 'reject' });
          return null;
        }
        const same = existing &&
          (parseInt(existing.amount_due, 10) || 0) === c.due &&
          (parseInt(existing.amount, 10) || 0) === c.paid &&
          (existing.method || null) === c.method &&
          !!existing.is_scholarship === c.isScholarship;
        let action;
        if (!existing) { action = 'insert'; insertCount++; }
        else if (same) { action = 'unchanged'; unchangedCount++; }
        else { action = 'update'; updateCount++; }
        return { ...c, action, existing, warning };
      }).filter(Boolean);
      return {
        student, marks,
        insertCount: marks.filter(m => m.action === 'insert').length,
        updateCount: marks.filter(m => m.action === 'update').length,
        unchangedCount: marks.filter(m => m.action === 'unchanged').length,
      };
    }).filter(r => r.marks.length > 0);

    setPreview({ monthColumns: monthKeys, studentRows, rejected, insertCount, updateCount, unchangedCount, _maxTxnSeq: maxTxnSeq });
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
    const txnSeq = { ...(preview._maxTxnSeq || {}) };
    const payload = [];
    preview.studentRows.forEach(({ student, marks }) => {
      marks.forEach(m => {
        if (m.action === 'unchanged') return; // nothing to write — already saved as-is
        const existingPayments = m.existing?.payments || [];
        const newPayments = [...existingPayments];
        // FIX 4: log only the NEW money, not the whole "amount" column again.
        // The old code pushed a payment entry of m.paid every time — so
        // re-importing a row that already had ₹500 on file with an updated
        // ₹800 Paid would log an ₹800 transaction on top of the original
        // ₹500 instead of the actual ₹300 top-up, inflating the payments
        // history relative to the real money collected.
        const previouslyPaid = parseInt(m.existing?.amount, 10) || 0;
        const newlyPaid = m.paid - previouslyPaid;
        if (m.isScholarship && !m.existing?.is_scholarship) {
          newPayments.push({
            amount: 0, method: 'scholarship', transaction_id: null,
            by: collectedBy || 'Import', at: new Date().toISOString(),
            note: 'Fee waived — scholarship (bulk import)',
          });
        } else if (!m.isScholarship && newlyPaid > 0) {
          txnSeq[student.id] = (txnSeq[student.id] || 0) + 1;
          newPayments.push({
            amount: newlyPaid, method: m.method,
            transaction_id: genTxnId(academyId, student.roll_no, txnSeq[student.id]),
            by: collectedBy || 'Import', at: new Date().toISOString(), note: 'Bulk import',
          });
        }
        // A downward correction (Paid reduced from what's on file) still
        // updates amount_due/amount/status below but intentionally logs no
        // new payment entry — it's a correction, not a new transaction.
        const status = m.isScholarship ? 'paid' : m.paid >= m.due && m.due > 0 ? 'paid' : m.paid > 0 ? 'partial' : 'unpaid';
        payload.push({
          academy_id: academyId, student_id: student.id, sport: m.sport, batch_label: m.batchLabel, month: m.monthKey,
          status, amount_due: m.due, amount: m.paid, method: m.method,
          is_scholarship: m.isScholarship,
          paid_date: status === 'paid' ? todayIso() : (m.existing?.paid_date || null),
          collected_by: collectedBy || 'Import',
          payments: newPayments, msg_sent: m.existing?.msg_sent || [],
        });
      });
    });
    if (!payload.length) { setSubmitting(false); onImported(); onClose(); return; }
    // Upsert in chunks to stay well under request size limits. Conflict target
    // matches the real unique constraint on `fees` (student_id, sport,
    // batch_label, month) — same one FeesTab's save()/resetToUnpaid() use.
    let hadError = false;
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await supabase.from('fees').upsert(payload.slice(i, i + 500), { onConflict: 'student_id,sport,batch_label,month' });
      if (error) hadError = true;
    }
    try {
      await supabase.from('audit_log').insert({
        academy_id: academyId,
        actor_name: collectedBy || 'Import',
        action: `Imported fees: ${preview.insertCount} new, ${preview.updateCount} updated, across ${preview.studentRows.length} student(s)`,
        description: `Imported fees: ${preview.insertCount} new, ${preview.updateCount} updated, across ${preview.studentRows.length} student(s)`,
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
          <div style={{ fontWeight: 800, fontSize: 16 }}>⬆️ Import Fees</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--card2)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>📋 Required CSV/Excel format:</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11.5, color: 'var(--gray)', marginBottom: 8, wordBreak: 'break-all' }}>
              Name, RollNo, Sport (optional), Batch (optional), MM/YYYY Due, MM/YYYY Paid, MM/YYYY Method, ...
            </div>
            <div>• <strong>Name</strong> or <strong>RollNo</strong> is required to identify the student.</div>
            <div>• <strong>Sport/Batch are optional</strong> — leave both blank to auto-detect each month's correct batch from the student's enrollment history (handles a mid-year switch correctly). Fill them in only to pin every month in that row to one specific enrollment.</div>
            <div>• Add a group of 3 columns per month: <strong>MM/YYYY Due</strong>, <strong>MM/YYYY Paid</strong>, <strong>MM/YYYY Method</strong>.</div>
            <div>• Method is <strong>cash</strong>, <strong>upi</strong>, <strong>card</strong>, <strong>bank</strong>, or <strong>scholarship</strong> (fully waives the fee).</div>
            <div>• Leave all three cells in a month-group blank to skip that student for that month.</div>
            <div>• First row treated as header and skipped.</div>
          </div>

          <button className="btn btn-outline btn-sm" onClick={downloadTemplate}>📥 Download Excel Template</button>

          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', display: 'block', marginBottom: 6 }}>Choose CSV or Excel File</label>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="form-input" />
          </div>

          {error && <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px' }}>⚠️ {error}</div>}

          {preview && (() => {
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
                    <div style={{ fontSize: 10, color: 'var(--gray)' }}>Skip</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--gray)' }}>{skipTotal}</div>
                  </div>
                  <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: 'var(--gray)' }}>Reject</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: '#dc2626' }}>{rejectedRows.length}</div>
                  </div>
                </div>

                <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {preview.studentRows.map((r, i) => {
                    const historical = r.marks.filter(m => m.sport !== r.student.sport || m.batchLabel !== r.student.batchLabel);
                    return (
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
                      </div>
                      {historical.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--gray)' }}>
                          🕘 {historical.map(m => `${monthLabel(m.monthKey)} → ${m.sport}/${m.batchLabel}`).join(' · ')} (past enrollment, not their current batch)
                        </div>
                      )}
                      {r.marks.some(m => m.warning) && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#d97706' }}>
                          ⚠️ {r.marks.filter(m => m.warning).map(m => `${monthLabel(m.monthKey)}: ${m.warning}`).join(' · ')}
                        </div>
                      )}
                    </div>
                    );
                  })}
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
        </div>

        {preview && (preview.insertCount + preview.updateCount) > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
            {confirming && (
              <div style={{ padding: '12px 16px 0' }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.6, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)', borderRadius: 8, padding: '10px 12px' }}>
                  ⚠️ This will save <strong>{preview.insertCount} new</strong> fee record{preview.insertCount === 1 ? '' : 's'}
                  {preview.updateCount > 0 && (
                    <> and <strong>overwrite {preview.updateCount} existing</strong> record{preview.updateCount === 1 ? '' : 's'}</>
                  )}, recording a payment entry for anything with money collected. This can't be undone. Continue?
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
