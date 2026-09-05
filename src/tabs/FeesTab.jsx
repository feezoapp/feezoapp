import { useEffect, useMemo, useRef, useState } from 'react';
import { useAcademyData } from '../context/AcademyDataContext';
import { useAuth } from '../context/AuthContext';
import { usePlan } from '../context/PlanContext';
import { supabase } from '../lib/supabaseClient';
import { logActivity } from '../lib/auditLog';
import { exportGenericPdf, exportGenericXlsx } from '../lib/exporters';
import SendMessageModal from '../components/SendMessageModal';
import { DEFAULT_MSG, DEFAULT_THANK } from '../components/FeeMsgModal';
import ImportFeesModal from '../components/ImportFeesModal';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m is 1-indexed

// Supabase/PostgREST caps any single .select() at 1000 rows by default.
// Year view (or even Month view, for a busy academy) can have more
// attendance rows than that — a plain query would silently truncate,
// under-counting who's actually eligible for fees that period. Page
// through in 1000-row chunks instead of trusting one request to return
// everything. Matches AttendanceTab's identical fetchAllRows helper.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// Trimmed + lowercased comparison so a stray space or casing difference
// between a sport/batch on a student's enrollment and the one used in a
// filter or on an attendance row doesn't cause a silent mismatch.
const norm = (v) => (v || '').toString().trim().toLowerCase();

// A composite key per enrollment (student + sport + batch) — matches the
// same pattern AttendanceTab uses, so a student with two enrollments (same
// or different sport) gets exactly one fee row per enrollment, never merged
// and never duplicated.
const keyFor = (studentId, sport, batchLabel) => `${studentId}::${norm(sport)}::${norm(batchLabel)}`;

// Same centered popup used by StudentsTab's / AttendanceTab's / HomeTab's
// Sport/Batch/Sort filters — a dark overlay + a card of radio rows, closing
// itself on selection.
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

const STATUS_OPTIONS = [
  { v: 'outstanding', l: 'Unpaid + Partial' },
  { v: 'all', l: 'All Status' },
  { v: 'paid', l: 'Paid' },
  { v: 'partial', l: 'Partially Paid' },
  { v: 'unpaid', l: 'Unpaid' },
];

function buildMsg(tpl, ctx) {
  return tpl
    .replace(/{name}/g, ctx.name || '')
    .replace(/{month}/g, ctx.month || '')
    .replace(/{academy}/g, ctx.academy || '')
    .replace(/{amount}/g, ctx.amount != null ? String(ctx.amount) : '')
    .replace(/{method}/g, ctx.method || '');
}

// Returns 'unpaid' | 'partial' | 'paid' by comparing what's been paid
// (fee.amount, a running total) against the total owed (fee.amount_due).
// This is the single source of truth for a fee's state — the stored
// `status` column is kept in sync with this on every save, so filters/
// exports can read it directly without recomputing.
// Legacy rows saved before partial-payment support have no amount_due;
// those fall back to their old stored status so existing paid/unpaid
// history isn't reinterpreted.
function feeStatus(fee) {
  if (!fee) return 'unpaid';
  // A scholarship row is always treated as fully settled — the student
  // owes nothing, regardless of what amount_due/amount happen to hold.
  if (fee.is_scholarship) return 'paid';
  const due = parseInt(fee.amount_due, 10);
  const paid = parseInt(fee.amount, 10) || 0;
  if (!due || isNaN(due)) return (fee.status === 'paid' && paid > 0) ? 'paid' : 'unpaid';
  if (paid <= 0) return 'unpaid';
  if (paid >= due) return 'paid';
  return 'partial';
}
const isPaidEntry = (fee) => feeStatus(fee) === 'paid';
const isPartialEntry = (fee) => feeStatus(fee) === 'partial';

// Whether a fee row matches the currently selected status filter.
// 'outstanding' is a convenience bucket covering both unpaid and partially
// paid rows — it's the default view so staff land on students who still
// owe money instead of a full/all list.
function matchesStatusFilter(status, statusFilter) {
  if (statusFilter === 'all') return true;
  if (statusFilter === 'outstanding') return status === 'unpaid' || status === 'partial';
  return status === statusFilter;
}

// Auto-generated, human-traceable transaction ID: TXN-<first 3 chars of the
// academy id>-<student roll number>-<zero-padded sequence>. The sequence is
// the student's running payment count across ALL their fee entries (every
// sport/batch/month), so it climbs 001, 002, 003... across their whole
// history rather than resetting per fee row.
function genTxnId(academyId, rollNo, seq) {
  const academyPart = (academyId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'ACD';
  const rollPart = (rollNo || 'NA').toString().toUpperCase();
  const seqPart = String(seq).padStart(3, '0');
  return `TXN-${academyPart}-${rollPart}-${seqPart}`;
}

// A student owes fees for a given *enrollment* (sport + batch) for a given
// month only if they were enrolled on/before that month AND they have at
// least one Present attendance record for that specific sport+batch in it —
// matches isEnrolledOnDate() + studentAttendedMonth() in the HTML app,
// extended to be per-sport-and-batch (checked against the `batch` column on
// `attendance`) so a student in two batches of the same sport only counts
// as eligible for the batch they actually attended, not both.
function isEligible(student, year, month, attendanceByStudent, sport, batchLabel) {
  if (student.join_date) {
    const checkEnd = toIso(new Date(year, month, 0)); // last day of month
    if (student.join_date > checkEnd) return false;
  }
  const rows = attendanceByStudent[student.id];
  return !!(rows && rows.some(r =>
    r.status === 'P' &&
    (!sport || norm(r.sport) === norm(sport)) &&
    (!batchLabel || norm(r.batch) === norm(batchLabel))
  ));
}

// Staff can create a first-time entry and add further installments while
// the fee isn't yet fully paid. Once the full amount has been collected,
// only admin can reopen (reset) or otherwise touch it.
function canEditFee(fee, isAdmin) {
  if (isAdmin) return true;
  if (!fee) return true;
  return feeStatus(fee) !== 'paid';
}

// Modal for creating/editing a single student's fee entry for a given
// month + sport + batch. Supports partial payments: the first save records
// the Total Amount Due plus whatever's being paid right now. If that's
// less than the total, the fee stays "Partially Paid" until enough
// installments bring it to the full amount — staff can only ADD a new
// installment (auto-totalled), never edit or overwrite what's already
// been collected. Once fully paid it locks; only admin can reset it.
function FeeEntryModal({ student, monthKey, monthLabel, sport, batchLabel, fee, nextTxnSeq, onClose, onSaved }) {
  const { academyId, appUser, user, isAdmin } = useAuth();
  const status = feeStatus(fee);
  const due = fee?.amount_due ? parseInt(fee.amount_due, 10) : null;
  const paidSoFar = fee?.amount ? parseInt(fee.amount, 10) : 0;
  const remaining = due != null ? Math.max(due - paidSoFar, 0) : null;
  const payments = fee?.payments || [];
  const lastPayment = payments.length > 0 ? payments[payments.length - 1] : null;
  const isFirstEntry = status === 'unpaid' && !due;
  const locked = status === 'paid' && !isAdmin;

  // Auto-generated transaction ID for whatever payment is about to be
  // recorded in this modal session. Computed once up front from the
  // student's running payment count so it's stable while the form is open.
  const txnId = genTxnId(academyId, student.roll_no, nextTxnSeq);

  const [totalDue, setTotalDue] = useState(due ?? '');
  // 'full' | 'partial' | 'scholarship' — only meaningful once a total due
  // amount is known. Full Payment auto-fills the amount field with whatever's
  // left; Partial Payment leaves it to manual entry; Scholarship waives the
  // fee entirely — no amount, method, or transaction ID is collected.
  const [payType, setPayType] = useState('full');
  const [payNow, setPayNow] = useState('');
  const [method, setMethod] = useState(fee?.method || 'cash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  // Keep the amount field in sync with the Full/Partial toggle once we know
  // what's owed (i.e. after Total Due has been entered on a first entry, or
  // always for a follow-up installment where `remaining` is already known).
  useEffect(() => {
    const knownDue = isFirstEntry ? parseInt(totalDue, 10) : remaining;
    if (payType === 'full' && knownDue > 0) {
      setPayNow(String(knownDue));
    } else if (payType === 'partial' && payNow === String(knownDue)) {
      setPayNow('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payType, totalDue]);

  const save = async () => {
    setError('');
    const nowAmt = parseInt(payNow, 10) || 0;
    let payload;

    if (payType === 'scholarship') {
      // Scholarship waives the fee entirely — the student owes nothing.
      // No transaction ID or payment method is recorded since no money
      // actually changes hands; a zero-amount entry is logged purely for
      // an audit trail of who granted it and when.
      const dueAmt = isFirstEntry ? (parseInt(totalDue, 10) || 0) : parseInt(fee.amount_due, 10);
      const newPayments = [...payments, {
        amount: 0, method: 'scholarship', transaction_id: null,
        by: appUser?.name || user?.email || '', at: new Date().toISOString(),
        note: 'Fee waived — scholarship',
      }];
      payload = {
        academy_id: academyId, student_id: student.id, sport, batch_label: batchLabel, month: monthKey,
        status: 'paid', amount_due: dueAmt, amount: dueAmt, method: 'scholarship',
        is_scholarship: true,
        paid_date: toIso(new Date()),
        collected_by: appUser?.name || user?.email || '',
        payments: newPayments, msg_sent: fee?.msg_sent || [],
      };
    } else if (isFirstEntry) {
      const dueAmt = parseInt(totalDue, 10);
      if (!dueAmt || dueAmt < 1) { setError('Enter the total amount due'); return; }
      if (nowAmt < 0) { setError('Invalid amount'); return; }
      if (nowAmt > dueAmt) { setError(`Amount paid (₹${nowAmt}) can't be greater than the amount due (₹${dueAmt})`); return; }
      const newPayments = nowAmt > 0
        ? [...payments, { amount: nowAmt, method, transaction_id: txnId, by: appUser?.name || user?.email || '', at: new Date().toISOString() }]
        : payments;
      const newStatus = nowAmt >= dueAmt ? 'paid' : (nowAmt > 0 ? 'partial' : 'unpaid');
      payload = {
        academy_id: academyId, student_id: student.id, sport, batch_label: batchLabel, month: monthKey,
        status: newStatus, amount_due: dueAmt, amount: nowAmt,
        method: nowAmt > 0 ? method : null,
        is_scholarship: false,
        paid_date: newStatus === 'paid' ? toIso(new Date()) : null,
        collected_by: appUser?.name || user?.email || '',
        payments: newPayments, msg_sent: fee?.msg_sent || [],
      };
    } else {
      if (!nowAmt || nowAmt < 1) { setError('Enter the amount being paid now'); return; }
      const dueAmt = parseInt(fee.amount_due, 10);
      if (nowAmt > remaining) { setError(`Amount paid (₹${nowAmt}) can't be greater than the remaining balance (₹${remaining})`); return; }
      const newPaid = paidSoFar + nowAmt;
      const newPayments = [...payments, { amount: nowAmt, method, transaction_id: txnId, by: appUser?.name || user?.email || '', at: new Date().toISOString() }];
      const newStatus = newPaid >= dueAmt ? 'paid' : 'partial';
      payload = {
        academy_id: academyId, student_id: student.id, sport, batch_label: batchLabel, month: monthKey,
        status: newStatus, amount_due: dueAmt, amount: newPaid, method,
        is_scholarship: false,
        paid_date: newStatus === 'paid' ? toIso(new Date()) : (fee.paid_date || null),
        collected_by: appUser?.name || user?.email || '',
        payments: newPayments, msg_sent: fee.msg_sent || [],
      };
    }

    setSaving(true);
    try {
      const { data, error: err } = await supabase
        .from('fees')
        .upsert(payload, { onConflict: 'student_id,sport,batch_label,month' })
        .select()
        .single();
      if (err) throw err;
      logActivity({
        academyId, actorId: appUser?.id, actorName: appUser?.name || user?.email,
        message: payload.status === 'paid'
          ? `Marked ${sport}${batchLabel ? ' (' + batchLabel + ')' : ''} fee fully paid for ${student.name} (${monthLabel}, ₹${payload.amount})`
          : `Recorded ₹${nowAmt} payment for ${student.name} — ${sport}${batchLabel ? ' (' + batchLabel + ')' : ''} (${monthLabel}), ₹${payload.amount}/₹${payload.amount_due} so far`,
      });
      onSaved(data);
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const resetToUnpaid = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        academy_id: academyId, student_id: student.id, sport, batch_label: batchLabel, month: monthKey,
        status: 'unpaid', amount_due: fee?.amount_due || null, amount: null, method: null,
        is_scholarship: false,
        paid_date: null, collected_by: appUser?.name || user?.email || '',
        payments: [], msg_sent: fee?.msg_sent || [],
      };
      const { data, error: err } = await supabase
        .from('fees')
        .upsert(payload, { onConflict: 'student_id,sport,batch_label,month' })
        .select()
        .single();
      if (err) throw err;
      logActivity({
        academyId, actorId: appUser?.id, actorName: appUser?.name || user?.email,
        message: `Reset ${sport}${batchLabel ? ' (' + batchLabel + ')' : ''} fee to unpaid for ${student.name} (${monthLabel})`,
      });
      onSaved(data);
    } catch (err) {
      setError(err.message || 'Failed to reset');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 400 }}>
        <div className="modal-title">
          <span>💰 {student.name}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 10 }}>
          {monthLabel} · {sport}{batchLabel ? ` · ${batchLabel}` : ''}
        </div>

        {!isFirstEntry && (
          <div style={{ background: 'var(--card2)', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: 'var(--gray)' }}>Total Due</span><span>₹{due}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: 'var(--gray)' }}>Paid So Far</span><span>₹{paidSoFar}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>Remaining</span><span style={{ color: remaining > 0 ? 'var(--red)' : 'var(--green)' }}>₹{remaining}</span>
            </div>
            {lastPayment && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.1)', color: 'var(--gray)' }}>
                Last payment: ₹{lastPayment.amount} · {lastPayment.method} · {lastPayment.by}
                {lastPayment.at && <> · {new Date(lastPayment.at).toLocaleDateString()}</>}
                {lastPayment.transaction_id && <div style={{ marginTop: 2 }}>{lastPayment.transaction_id}</div>}
              </div>
            )}
          </div>
        )}

        {locked ? (
          <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 10 }}>
            🔒 This fee is fully paid. Only an admin can reopen it.
          </div>
        ) : (
          <>
            {isFirstEntry && (
              <div className="form-group">
                <label className="form-label">Total Amount Due ₹</label>
                <input type="number" min="1" className="form-input" value={totalDue} onChange={e => setTotalDue(e.target.value)} placeholder="e.g. 300" />
              </div>
            )}

            <div className="form-group">
                <label className="form-label">Payment Type</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 700, background: payType === 'full' ? 'var(--accent2)' : 'var(--card2)', color: payType === 'full' ? '#fff' : 'var(--gray)' }}
                    onClick={() => setPayType('full')}
                  >💯 Full</button>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 700, background: payType === 'partial' ? 'var(--accent2)' : 'var(--card2)', color: payType === 'partial' ? '#fff' : 'var(--gray)' }}
                    onClick={() => setPayType('partial')}
                  >➗ Partial</button>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1, padding: '7px 0', fontSize: 12, fontWeight: 700, background: payType === 'scholarship' ? 'var(--gold, #e0a020)' : 'var(--card2)', color: payType === 'scholarship' ? '#fff' : 'var(--gray)' }}
                    onClick={() => setPayType('scholarship')}
                  >🎓 Scholarship</button>
                </div>
              </div>

            {payType === 'scholarship' ? (
              <div style={{ background: 'rgba(230,160,20,0.12)', border: '1px solid rgba(230,160,20,0.4)', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 12, color: 'var(--gold, #e0a020)' }}>
                🎓 This student is on scholarship — no payment is required. This fee will be marked fully settled with ₹0 collected.
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label">
                    {isFirstEntry ? 'Amount Paying Now ₹ (leave blank if none yet)' : `Amount Paying Now ₹ (remaining ₹${remaining})`}
                  </label>
                  <input
                    type="number" min={isFirstEntry ? '0' : '1'} className="form-input" value={payNow}
                    onChange={e => { setPayNow(e.target.value); setPayType('partial'); }}
                    placeholder="Enter amount"
                    readOnly={payType === 'full'}
                  />
                </div>

                {(isFirstEntry ? parseInt(payNow, 10) > 0 : true) && (
                  <>
                    <div className="form-group">
                      <label className="form-label">Payment Method</label>
                      <select className="form-select" value={method} onChange={e => setMethod(e.target.value)}>
                        <option value="cash">Cash</option>
                        <option value="upi">UPI</option>
                        <option value="card">Card</option>
                        <option value="bank">Bank Transfer</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Transaction ID (auto-generated)</label>
                      <input type="text" className="form-input" value={txnId} readOnly style={{ opacity: 0.75 }} />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {fee?.collected_by && (
          <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 8 }}>Last saved by: {fee.collected_by}</div>
        )}

        {isAdmin && status !== 'unpaid' && !confirmReset && (
          <button className="btn" style={{ width: '100%', fontSize: 11, color: 'var(--red)', background: 'transparent', border: '1px solid var(--red)', marginBottom: 8 }} onClick={() => setConfirmReset(true)}>
            🔓 Admin: Reset to Unpaid
          </button>
        )}
        {confirmReset && (
          <div style={{ fontSize: 11, marginBottom: 8, color: 'var(--red)' }}>
            This clears all recorded payments for this entry. Are you sure?
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: 'var(--red)', color: '#fff' }} onClick={resetToUnpaid} disabled={saving}>Confirm Reset</button>
            </div>
          </div>
        )}

        {!locked && (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn" style={{ flex: 1, background: 'var(--card2)' }} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : '💾 Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FeesTab() {
  const { visibleStudents, visibleSports, visibleBatches, academy } = useAcademyData();
  const { isAdmin, academyId, appUser, user, canExport } = useAuth();
  const { hasFeature, cheapestPlanWithFeature } = usePlan();
  // Matches the pattern AttendanceTab uses for `markedBy` — real name lives
  // on appUser (the app_users row), not the raw Supabase auth `user`.
  const collectedBy = appUser?.name || user?.email || (isAdmin ? 'Admin' : 'Staff');

  const today = new Date();
  const [viewMode, setViewMode] = useState('month'); // 'month' | 'year'
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [year, setYear] = useState(today.getFullYear());
  const [sportFilter, setSportFilter] = useState('');
  const [batchFilter, setBatchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('outstanding'); // 'all' | 'outstanding' | 'paid' | 'partial' | 'unpaid'
  const [search, setSearch] = useState('');
  const [includeNoAttendance, setIncludeNoAttendance] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [popup, setPopup] = useState(null); // 'month' | 'year' | 'sport' | 'batch' | 'status' | null

  const [fees, setFees] = useState([]);
  const [txnCounts, setTxnCounts] = useState({}); // student_id -> total payment count, ALL months (needed for sequential txn IDs)
  const [attendance, setAttendance] = useState([]); // {student_id, status, date}
  const [loading, setLoading] = useState(false);

  const [sendModal, setSendModal] = useState(null);
  const [entryModal, setEntryModal] = useState(null); // { student, monthKey, monthLabel, sport, fee }
  const [showImport, setShowImport] = useState(false);

  // A row's `month` key is fine to compare lexically ('2026-01' <= '2026-08')
  // since it's always YYYY-MM. Used both for the scoped fetch below and to
  // decide whether an incoming realtime row belongs on screen right now.
  const monthKeyFor = (y, m) => `${y}-${pad(m)}`;
  const rowInScope = (row) => {
    if (!row?.month) return false;
    return viewMode === 'year' ? row.month.slice(0, 4) === String(year) : row.month === monthKeyFor(year, month);
  };

  // Fee rows for display are scoped to whatever period is on screen (current
  // month, or the whole selected year) — same pattern AttendanceTab already
  // uses for the `attendance` table — instead of pulling every fee row the
  // academy has ever recorded.
  const loadFees = async () => {
    if (!academyId) return;
    let q = supabase.from('fees').select('*').eq('academy_id', academyId);
    q = viewMode === 'year'
      ? q.gte('month', monthKeyFor(year, 1)).lte('month', monthKeyFor(year, 12))
      : q.eq('month', monthKeyFor(year, month));
    const { data } = await q;
    setFees(data || []);
  };
  useEffect(() => { loadFees(); }, [academyId, viewMode, month, year]);

  // Transaction IDs are numbered sequentially per student across their
  // ENTIRE history (see genTxnId), not just the visible period, so this
  // needs a separate all-time query. Kept cheap by selecting only the two
  // columns actually needed (not the full row — skips amount, method,
  // msg_sent, collected_by, etc.) so it stays far lighter than the old
  // `select('*')` even though it still touches every fee row.
  const loadTxnCounts = async () => {
    if (!academyId) return;
    const { data } = await supabase.from('fees').select('student_id, payments').eq('academy_id', academyId);
    const counts = {};
    (data || []).forEach(f => {
      const n = (f.payments || []).length;
      if (!n) return;
      counts[f.student_id] = (counts[f.student_id] || 0) + n;
    });
    setTxnCounts(counts);
  };
  useEffect(() => { loadTxnCounts(); }, [academyId]);

  // ---- Realtime sync ----
  // `fees` isn't loaded through AcademyDataContext — it's fetched here,
  // scoped to the visible period, and kept in sync locally after each save.
  // A changed row only gets merged into `fees` if it belongs to the period
  // currently on screen; any change anywhere (any month) still triggers a
  // debounced refresh of `txnCounts`, since that has to stay accurate
  // academy-wide regardless of which month you're looking at.
  const txnCountsDebounceRef = useRef(null);
  const scheduleTxnCountsReload = () => {
    clearTimeout(txnCountsDebounceRef.current);
    txnCountsDebounceRef.current = setTimeout(loadTxnCounts, 400);
  };

  useEffect(() => {
    if (!academyId) return;

    const channel = supabase
      .channel(`fees-${academyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fees', filter: `academy_id=eq.${academyId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old;
            if (!oldRow) return;
            if (rowInScope(oldRow)) setFees(prev => prev.filter(f => f.id !== oldRow.id));
          } else {
            const row = payload.new;
            if (!row) return;
            if (rowInScope(row)) {
              setFees(prev => {
                const idx = prev.findIndex(f => f.id === row.id);
                if (idx === -1) return [...prev, row];
                const next = prev.slice();
                next[idx] = row;
                return next;
              });
            }
          }
          scheduleTxnCountsReload();
        })
      .subscribe();

    return () => { clearTimeout(txnCountsDebounceRef.current); supabase.removeChannel(channel); };
  }, [academyId, viewMode, month, year]);

  // Attendance is fetched fresh for whichever period is being viewed (month or full year),
  // since that determines who's "eligible" to owe fees. Paginated via
  // fetchAllRows so a busy academy's Year view (or even a busy Month) can't
  // silently truncate at Supabase's 1000-row-per-request default.
  useEffect(() => {
    (async () => {
      if (!academyId) return;
      setLoading(true);
      try {
        const from = viewMode === 'year' ? `${year}-01-01` : `${year}-${pad(month)}-01`;
        const to = viewMode === 'year' ? `${year}-12-31` : `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
        const buildQuery = () => supabase.from('attendance').select('id,student_id,status,date,sport,batch')
          .eq('academy_id', academyId).gte('date', from).lte('date', to);
        const data = await fetchAllRows(buildQuery);
        setAttendance(data);
      } catch (err) {
        console.error('Attendance fetch failed:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [academyId, viewMode, month, year]);

  // ---- Realtime sync for attendance ----
  // `attendance` isn't loaded through AcademyDataContext either — like
  // `fees` above, it's fetched here scoped to the visible period. Without
  // this subscription, marking a student Present/Absent in AttendanceTab
  // only showed up here after manually flipping the month away and back
  // (which happens to re-trigger the fetch effect above) — not live. This
  // mirrors the `fees` channel: merge a changed row in only if its date
  // falls within the period currently on screen.
  const attendanceInScope = (row) => {
    if (!row?.date) return false;
    const from = viewMode === 'year' ? `${year}-01-01` : `${year}-${pad(month)}-01`;
    const to = viewMode === 'year' ? `${year}-12-31` : `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
    return row.date >= from && row.date <= to;
  };

  useEffect(() => {
    if (!academyId) return;

    const channel = supabase
      .channel(`fees-attendance-${academyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance', filter: `academy_id=eq.${academyId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old;
            if (!oldRow) return;
            setAttendance(prev => prev.filter(r => r.id !== oldRow.id));
          } else {
            const row = payload.new;
            if (!row || !attendanceInScope(row)) return;
            setAttendance(prev => {
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx === -1) return [...prev, row];
              const next = prev.slice();
              next[idx] = row;
              return next;
            });
          }
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [academyId, viewMode, month, year]);

  const attendanceByStudentByMonth = useMemo(() => {
    // { 'YYYY-MM': { studentId: [rows] } }
    const out = {};
    attendance.forEach(r => {
      const mk = r.date.slice(0, 7);
      if (!out[mk]) out[mk] = {};
      if (!out[mk][r.student_id]) out[mk][r.student_id] = [];
      out[mk][r.student_id].push(r);
    });
    return out;
  }, [attendance]);

  const feeMap = useMemo(() => {
    const m = {};
    fees.forEach(f => { m[`${f.student_id}|${norm(f.sport)}|${norm(f.batch_label)}|${f.month}`] = f; });
    return m;
  }, [fees]);

  const batchesForSport = useMemo(() =>
    visibleBatches.filter(b => !sportFilter || b.sport === sportFilter),
    [visibleBatches, sportFilter]);

  // Flatten each student's enrollments into one row per sport+batch — same
  // pattern as AttendanceTab — so a student in two sports gets two separate,
  // independently trackable fee rows instead of being collapsed into one
  // (which was silently dropping the second sport's fee entirely).
  const enrollmentRows = useMemo(() => {
    const rows = [];
    visibleStudents.forEach(s => {
      const enrollments = (s.enrollments && s.enrollments.length > 0)
        ? s.enrollments : [{ sport: s.sport, batchLabel: s.batchLabel }];
      enrollments.forEach(en => {
        if (!en.sport) return;
        rows.push({ student: s, sport: en.sport, batchLabel: en.batchLabel, key: keyFor(s.id, en.sport, en.batchLabel) });
      });
    });
    return rows;
  }, [visibleStudents]);

  const sportScopedRows = useMemo(() =>
    enrollmentRows.filter(r =>
      (!sportFilter || norm(r.sport) === norm(sportFilter)) &&
      (!batchFilter || norm(r.batchLabel) === norm(batchFilter))
    ),
    [enrollmentRows, sportFilter, batchFilter]);

  const searchedRows = useMemo(() => {
    if (!search.trim()) return sportScopedRows;
    const q = search.trim().toLowerCase();
    return sportScopedRows.filter(r => (r.student.name || '').toLowerCase().includes(q) || (r.student.roll_no || '').toLowerCase().includes(q));
  }, [sportScopedRows, search]);

  // Builds the display rows for one month: eligible enrollments (enrolled +
  // attended that specific sport), each paired with their fee entry (or null
  // if not yet recorded). Enrollments with zero attendance that month are
  // tracked separately and only mixed into `rows` when includeNoAttendance
  // is checked.
  function buildMonthRows(y, m) {
    const monthKey = `${y}-${pad(m)}`;
    const attByStudent = attendanceByStudentByMonth[monthKey] || {};
    const eligible = [];
    const noAttendance = [];
    searchedRows.forEach(r => {
      const s = r.student;
      const enrolledBy = !s.join_date || s.join_date <= toIso(new Date(y, m, 0));
      if (!enrolledBy) return;
      if (isEligible(s, y, m, attByStudent, r.sport, r.batchLabel)) {
        eligible.push(r);
      } else {
        noAttendance.push(r);
      }
    });
    const toRow = (r) => {
      const fee = feeMap[`${r.student.id}|${norm(r.sport)}|${norm(r.batchLabel)}|${monthKey}`] || null;
      const st = feeStatus(fee);
      return { student: r.student, sport: r.sport, batchLabel: r.batchLabel, fee, monthKey, status: st, paid: st === 'paid', key: r.key };
    };
    const rows = eligible.map(toRow).concat(includeNoAttendance ? noAttendance.map(toRow) : []);
    return { monthKey, rows, noAttendance };
  }

  const periods = useMemo(() => {
    if (viewMode === 'month') return [buildMonthRows(year, month)];
    return Array.from({ length: 12 }, (_, i) => buildMonthRows(year, i + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, year, month, searchedRows, attendanceByStudentByMonth, feeMap, includeNoAttendance]);

  const allRows = useMemo(() => periods.flatMap(p => p.rows), [periods]);
  const paidRows = useMemo(() => allRows.filter(r => r.status === 'paid'), [allRows]);
  const partialRows = useMemo(() => allRows.filter(r => r.status === 'partial'), [allRows]);
  const unpaidRows = useMemo(() => allRows.filter(r => r.status === 'unpaid'), [allRows]);
  const totalNoAttendance = useMemo(() => periods.reduce((s, p) => s + p.noAttendance.length, 0), [periods]);

  const outstandingRows = useMemo(() => allRows.filter(r => r.status === 'unpaid' || r.status === 'partial'), [allRows]);

  const activeRows = statusFilter === 'all' ? allRows
    : statusFilter === 'outstanding' ? outstandingRows
    : statusFilter === 'paid' ? paidRows
    : statusFilter === 'partial' ? partialRows
    : unpaidRows;

  const monthLabelFor = (mk) => {
    const [y, m] = mk.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  };

  const openReminder = (row) => {
    const monthLabel = monthLabelFor(row.monthKey);
    const text = buildMsg(academy?.msg_template || DEFAULT_MSG, { name: row.student.name, month: monthLabel, academy: academy?.name });
    setSendModal({ row, student: row.student, month: monthLabel, kind: 'reminder', text });
  };
  const openThankYou = (row) => {
    const monthLabel = monthLabelFor(row.monthKey);
    const text = buildMsg(academy?.thank_template || DEFAULT_THANK, { name: row.student.name, month: monthLabel, academy: academy?.name, amount: row.fee?.amount, method: row.fee?.method || 'Cash' });
    setSendModal({ row, student: row.student, month: monthLabel, kind: 'paid', text });
  };
  const openEntry = (row) => {
    setEntryModal({ student: row.student, monthKey: row.monthKey, monthLabel: monthLabelFor(row.monthKey), sport: row.sport, batchLabel: row.batchLabel, fee: row.fee });
  };

  // Logs a sent reminder/thank-you against the fee row (creating a bare unpaid
  // row if one doesn't exist yet), so the Remind button can show a running count.
  const recordMsgSent = async (row, kind, type) => {
    if (!row) return;
    const existing = row.fee;
    const entry = { kind, type, by: appUser?.name || user?.email || '', at: new Date().toISOString() };
    const msgSent = [...(existing?.msg_sent || []), entry];
    const payload = {
      academy_id: academyId,
      student_id: row.student.id,
      sport: row.sport,
      batch_label: row.batchLabel,
      month: row.monthKey,
      status: existing?.status || 'unpaid',
      amount_due: existing?.amount_due ?? null,
      amount: existing?.amount ?? null,
      method: existing?.method ?? null,
      is_scholarship: existing?.is_scholarship ?? false,
      paid_date: existing?.paid_date ?? null,
      collected_by: existing?.collected_by ?? null,
      payments: existing?.payments || [],
      msg_sent: msgSent,
    };
    const { data, error } = await supabase
      .from('fees')
      .upsert(payload, { onConflict: 'student_id,sport,batch_label,month' })
      .select()
      .single();
    if (!error && data) {
      setFees(prev => {
        const idx = prev.findIndex(f => f.id === data.id);
        if (idx === -1) return [...prev, data];
        const next = [...prev];
        next[idx] = data;
        return next;
      });
      logActivity({
        academyId, actorId: appUser?.id, actorName: appUser?.name || user?.email,
        message: `Sent ${kind === 'thank' ? 'payment thank-you' : 'fee reminder'} (${type}) to ${row.student.name} — ${row.sport}${row.batchLabel ? ' (' + row.batchLabel + ')' : ''}`,
      });
    }
  };

  const goPrevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); } else { setMonth(m => m - 1); }
  };
  const goNextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); } else { setMonth(m => m + 1); }
  };

  const exportRows = activeRows.map(r => ({
    Student: r.student.name, Roll: r.student.roll_no, Sport: r.sport, Batch: r.batchLabel,
    Month: monthLabelFor(r.monthKey),
    'Amount Due': r.fee?.amount_due || 0,
    'Amount Paid': r.fee?.amount || 0,
    Status: r.fee?.is_scholarship ? 'Scholarship' : r.status === 'paid' ? 'Paid' : r.status === 'partial' ? 'Partially Paid' : 'Unpaid',
  }));

  return (
    <div className="page active" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>💰 Fees</div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canExport && hasFeature('has_reports') && (
            <>
              <button className="btn btn-gold btn-sm" style={{ padding: '5px 9px', fontSize: 11 }} onClick={() => exportGenericPdf('Fees Report', ['Student', 'Roll', 'Sport', 'Batch', 'Month', 'Amount Due', 'Amount Paid', 'Status'], exportRows.map(Object.values), 'fees.pdf')}>PDF</button>
              <button className="btn btn-success btn-sm" style={{ padding: '5px 9px', fontSize: 11 }} onClick={() => exportGenericXlsx(exportRows, 'fees.xlsx', 'Fees')}>XL</button>
            </>
          )}
          {canExport && !hasFeature('has_reports') && (() => {
            const target = cheapestPlanWithFeature('has_reports');
            return (
              <button
                className="btn btn-outline btn-sm"
                style={{ padding: '5px 9px', fontSize: 11, opacity: 0.5, cursor: 'not-allowed' }}
                disabled
                title={target ? `Upgrade to ${target.name} to unlock exports` : 'Not available on your plan'}
              >
                PDF/XL
              </button>
            );
          })()}
          {hasFeature('has_bulk_import') && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowImport(true)}>⬆️ Import</button>
          )}
          {!hasFeature('has_bulk_import') && (() => {
            const target = cheapestPlanWithFeature('has_bulk_import');
            return (
              <button
                className="btn btn-outline btn-sm"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
                disabled
                title={target ? `Upgrade to ${target.name} to unlock bulk import` : 'Not available on your plan'}
              >
                ⬆️ Import
              </button>
            );
          })()}
        </div>
      </div>

      {/* Filters dropdown: view mode, month, year, sport, batch */}
      <div className="card" style={{ padding: 0, marginBottom: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setFiltersOpen(v => !v)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
        >
          <span>Filters — {viewMode === 'year' ? `Full Year ${year}` : `${MONTHS[month - 1]} ${year}`}{sportFilter ? ` · ${sportFilter}` : ''}{batchFilter ? ` · ${batchFilter}` : ''}</span>
          <span>{filtersOpen ? '▲' : '▼'}</span>
        </button>

        {filtersOpen && (
          <div style={{ padding: '0 12px 12px' }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button
                style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: viewMode === 'month' ? 'var(--accent2)' : 'var(--card2)', color: viewMode === 'month' ? '#fff' : 'var(--gray)' }}
                onClick={() => setViewMode('month')}
              >📅 Month</button>
              <button
                style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: viewMode === 'year' ? 'var(--accent2)' : 'var(--card2)', color: viewMode === 'year' ? '#fff' : 'var(--gray)' }}
                onClick={() => setViewMode('year')}
              >🗓️ Full Year</button>
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
              {viewMode === 'month' && (
                <>
                  <button
                    className="btn btn-xs"
                    style={{ padding: '6px 10px' }}
                    onClick={goPrevMonth}
                  >◀</button>
                  <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 12, padding: '7px 9px' }} onClick={() => setPopup('month')}>
                    {MONTHS[month - 1]}
                  </button>
                  <button
                    className="btn btn-xs"
                    style={{ padding: '6px 10px' }}
                    onClick={goNextMonth}
                  >▶</button>
                </>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
              <button className="btn btn-xs" style={{ padding: '6px 10px' }} onClick={() => setYear(y => y - 1)}>◀</button>
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 12, padding: '7px 9px' }} onClick={() => setPopup('year')}>
                {year}
              </button>
              <button className="btn btn-xs" style={{ padding: '6px 10px' }} onClick={() => setYear(y => y + 1)}>▶</button>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('sport')}>
                {sportFilter || 'All Sports'}
              </button>
              <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('batch')}>
                {batchFilter || 'All Batches'}
              </button>
            </div>
          </div>
        )}
      </div>

      {popup === 'month' && (
        <FilterPopup title="Select Month" onClose={() => setPopup(null)}>
          {MONTHS.map((mLabel, i) => (
            <RadioRow key={mLabel} name="monthsel" checked={month === i + 1} onChange={() => { setMonth(i + 1); setPopup(null); }} label={mLabel} />
          ))}
        </FilterPopup>
      )}

      {popup === 'year' && (
        <FilterPopup title="Select Year" onClose={() => setPopup(null)}>
          {Array.from({ length: 6 }, (_, i) => today.getFullYear() - 3 + i).map(y => (
            <RadioRow key={y} name="yearsel" checked={year === y} onChange={() => { setYear(y); setPopup(null); }} label={String(y)} />
          ))}
        </FilterPopup>
      )}

      {popup === 'sport' && (
        <FilterPopup title="Select Sport" onClose={() => setPopup(null)}>
          <RadioRow name="sportsel" checked={!sportFilter} onChange={() => { setSportFilter(''); setBatchFilter(''); setPopup(null); }} label="All Sports" />
          {visibleSports.map(s => (
            <RadioRow key={s.id} name="sportsel" checked={sportFilter === s.name} onChange={() => { setSportFilter(s.name); setBatchFilter(''); setPopup(null); }} label={s.name} />
          ))}
        </FilterPopup>
      )}

      {popup === 'batch' && (
        <FilterPopup title="Select Batch" onClose={() => setPopup(null)}>
          <RadioRow name="batchsel" checked={!batchFilter} onChange={() => { setBatchFilter(''); setPopup(null); }} label="All Batches" />
          {batchesForSport.map(b => (
            <RadioRow key={b.id} name="batchsel" checked={batchFilter === b.batchLabel} onChange={() => { setBatchFilter(b.batchLabel); setPopup(null); }} label={b.batchLabel} />
          ))}
        </FilterPopup>
      )}

      {popup === 'status' && (
        <FilterPopup title="Filter by Status" onClose={() => setPopup(null)}>
          {STATUS_OPTIONS.map(o => (
            <RadioRow
              key={o.v} name="statussel" checked={statusFilter === o.v}
              onChange={() => { setStatusFilter(o.v); setPopup(null); }}
              label={`${o.l} (${
                o.v === 'outstanding' ? outstandingRows.length
                : o.v === 'paid' ? paidRows.length
                : o.v === 'partial' ? partialRows.length
                : o.v === 'unpaid' ? unpaidRows.length
                : allRows.length
              })`}
            />
          ))}
        </FilterPopup>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="form-input" style={{ flex: 1, fontSize: 12 }} placeholder="🔍 Search name or roll no." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Paid / Unpaid filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button className="btn btn-outline btn-sm" style={{ flex: 1, fontSize: 12, padding: '7px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setPopup('status')}>
          {STATUS_OPTIONS.find(o => o.v === statusFilter)?.l}
        </button>
      </div>

      {totalNoAttendance > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={includeNoAttendance} onChange={e => setIncludeNoAttendance(e.target.checked)} />
          <span style={{ fontSize: 11, color: 'var(--gray)' }}>Include {totalNoAttendance} student{totalNoAttendance > 1 ? 's' : ''} with no attendance this period</span>
        </label>
      )}

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 90 }}>
        {loading && <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--gray)' }}>Loading…</div>}

        {!loading && activeRows.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--gray)' }}>
            {statusFilter === 'paid' ? 'No paid students yet.'
              : statusFilter === 'partial' ? 'No partially paid students.'
              : statusFilter === 'unpaid' ? 'No unpaid students 🎉'
              : statusFilter === 'outstanding' ? 'No unpaid or partially paid students 🎉'
              : 'No students to show.'}
          </div>
        )}

        {!loading && viewMode === 'year' ? (
          periods.map(p => {
            const pRows = p.rows.filter(r => matchesStatusFilter(r.status, statusFilter));
            if (pRows.length === 0) return null;
            return (
              <div key={p.monthKey}>
                <div style={{ padding: '6px 4px', fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>{monthLabelFor(p.monthKey)}</div>
                {pRows.map(r => (
                  <FeeRow key={r.key + r.monthKey} row={r} isAdmin={isAdmin} onReminder={openReminder} onThankYou={openThankYou} onEdit={openEntry} />
                ))}
              </div>
            );
          })
        ) : (
          !loading && activeRows.map(r => (
            <FeeRow key={r.key + r.monthKey} row={r} isAdmin={isAdmin} onReminder={openReminder} onThankYou={openThankYou} onEdit={openEntry} />
          ))
        )}

      </div>

      {sendModal && (
        <SendMessageModal
          student={sendModal.student}
          month={sendModal.month}
          kind={sendModal.kind}
          initialText={sendModal.text}
          onClose={() => setSendModal(null)}
          onSent={(type) => recordMsgSent(sendModal.row, sendModal.kind, type)}
        />
      )}

      {entryModal && (
        <FeeEntryModal
          student={entryModal.student}
          monthKey={entryModal.monthKey}
          monthLabel={entryModal.monthLabel}
          sport={entryModal.sport}
          batchLabel={entryModal.batchLabel}
          fee={entryModal.fee}
          nextTxnSeq={(txnCounts[entryModal.student.id] || 0) + 1}
          onClose={() => setEntryModal(null)}
          onSaved={(updated) => {
            const wasFullyPaid = feeStatus(entryModal.fee) === 'paid';
            setFees(prev => {
              const idx = prev.findIndex(f => f.id === updated.id);
              if (idx === -1) return [...prev, updated];
              const next = [...prev];
              next[idx] = updated;
              return next;
            });
            // Optimistic local bump so a second payment opened right after
            // this one still gets the correct next sequence number, without
            // waiting on the debounced realtime refetch to catch up.
            const oldCount = (entryModal.fee?.payments || []).length;
            const newCount = (updated.payments || []).length;
            if (newCount !== oldCount) {
              setTxnCounts(prev => ({
                ...prev,
                [updated.student_id]: Math.max(0, (prev[updated.student_id] || 0) + (newCount - oldCount)),
              }));
            }
            setEntryModal(null);
            // Payment just crossed from partial/unpaid to fully paid — prompt
            // to send the thank-you message right away instead of making
            // staff hunt the row down in the Paid tab afterward. If they
            // close the popup without sending, recordMsgSent never runs, so
            // it's never counted.
            if (!wasFullyPaid && feeStatus(updated) === 'paid') {
              openThankYou({
                student: entryModal.student,
                sport: entryModal.sport,
                batchLabel: entryModal.batchLabel,
                monthKey: entryModal.monthKey,
                fee: updated,
              });
            }
          }}
        />
      )}

      {showImport && (
        <ImportFeesModal
          academyId={academyId}
          existingStudents={visibleStudents}
          sportFilter={sportFilter}
          batchFilter={batchFilter}
          collectedBy={collectedBy}
          isAdmin={isAdmin}
          onClose={() => setShowImport(false)}
          onImported={() => { loadFees(); loadTxnCounts(); }}
        />
      )}
    </div>
  );
}

function FeeRow({ row, isAdmin, onReminder, onThankYou, onEdit }) {
  const { student, sport, batchLabel, fee, status, paid } = row;
  const editable = canEditFee(fee, isAdmin);
  const scholarship = !!fee?.is_scholarship;
  // A fee row can exist purely because a reminder was logged against it (see
  // recordMsgSent) — that shouldn't flip the button to "Edit". Only treat it
  // as a real entry once someone has actually saved payment info.
  const hasEntry = !!fee?.collected_by;
  const partial = status === 'partial';
  const due = fee?.amount_due ? parseInt(fee.amount_due, 10) : null;
  const amountPaid = fee?.amount ? parseInt(fee.amount, 10) : 0;
  const remaining = due != null ? Math.max(due - amountPaid, 0) : null;
  const btnLabel = scholarship ? '🔒 Scholarship' : paid && !editable ? '🔒 Paid' : (partial ? '➕ Add Payment' : (hasEntry ? '✏️ Edit' : '💳 Pay'));
  const badgeLabel = scholarship ? 'scholarship' : paid ? 'paid' : partial ? 'partially paid' : 'unpaid';
  const reminderCount = (fee?.msg_sent || []).filter(m => m.kind === 'reminder').length;
  const thankYouCount = (fee?.msg_sent || []).filter(m => m.kind === 'paid').length;

  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 10px', marginBottom: 8, flexWrap: 'nowrap', overflow: 'hidden' }}>
      <div style={{ flex: '1 1 0%', minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{student.name}</div>
        <div style={{ fontSize: 10, color: 'var(--gray)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {sport}{batchLabel ? ` · ${batchLabel}` : ''}
          {scholarship && <span style={{ color: 'var(--gold, #e0a020)' }}> · 🎓 fee waived</span>}
          {!scholarship && partial && due != null && <span style={{ color: 'var(--gold)' }}> · ₹{amountPaid}/₹{due} (₹{remaining} left)</span>}
          {!scholarship && fee?.method && <span> · {fee.method}</span>}
          {fee?.collected_by && <span style={{ color: 'var(--gold)' }}> · 👤 {fee.collected_by}</span>}
        </div>
      </div>
      <span
        className={'badge ' + (scholarship ? 'badge-gold' : paid ? 'badge-green' : partial ? 'badge-orange' : 'badge-red')}
        style={{ fontSize: 9, padding: '2px 6px', borderRadius: 8, flexShrink: 0, whiteSpace: 'nowrap', ...(partial && !scholarship ? { background: 'rgba(230,160,20,0.18)', color: '#e0a020' } : {}), ...(scholarship ? { background: 'rgba(160,120,255,0.18)', color: '#a078ff' } : {}) }}
      >
        {badgeLabel}
      </span>
      {paid ? (
        <button className="btn btn-outline" title="Send thank-you" style={{ fontSize: 10, padding: '3px 7px', borderRadius: 6, flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => onThankYou(row)}>🎉{thankYouCount > 0 ? ` ${thankYouCount}` : ''}</button>
      ) : (
        <button className="btn btn-outline" title="Send reminder" style={{ fontSize: 10, padding: '3px 7px', borderRadius: 6, flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => onReminder(row)}>💬{reminderCount > 0 ? ` ${reminderCount}` : ''}</button>
      )}
      <button
        className="btn btn-primary"
        title={btnLabel}
        style={{ fontSize: 10, padding: '3px 7px', borderRadius: 6, flexShrink: 0, whiteSpace: 'nowrap', opacity: paid && !editable ? 0.5 : 1 }}
        disabled={paid && !editable}
        onClick={() => editable && onEdit(row)}
      >
        {btnLabel}
      </button>
    </div>
  );
}
