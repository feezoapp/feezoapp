import { useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/auditLog';
import { exportStudentProfilePdf } from '../lib/exporters';
import AchievementsSection from './AchievementsSection';

function calcAge(dobIso) {
  if (!dobIso) return '';
  const d = new Date(dobIso);
  if (isNaN(d)) return '';
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const mDiff = today.getMonth() - d.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

function Row({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--gray)', fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ContactRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--gray)', fontSize: 12 }}>{label}</span>
      <a href={`tel:${value}`} onClick={e => e.stopPropagation()}
        style={{ fontSize: 13, fontWeight: 700, textAlign: 'right', color: 'var(--accent2)', textDecoration: 'none' }}>
        📞 {value}
      </a>
    </div>
  );
}

export default function StudentDetailModal({ student, academyId, isAdmin, canViewContact, canExport, onClose, onEdit, onChanged }) {
  const { appUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const isBanned = !!student.banned;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const [{ data: academy }, { data: achievements }] = await Promise.all([
        supabase.from('academies').select('name, logo_url').eq('id', academyId).maybeSingle(),
        supabase.from('achievements').select('*').eq('student_id', student.id).eq('academy_id', academyId),
      ]);
      await exportStudentProfilePdf(student, academy || {}, achievements || [], canViewContact);
      logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Downloaded profile PDF for ${student.name}` });
    } catch (e) {
      alert(e.message || 'Failed to generate PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const toggleBan = async () => {
    setBusy(true);
    const banned = !isBanned;
    const bannedOn = banned
      ? (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()
      : null;
    await supabase.from('students').update({ banned, banned_on: bannedOn }).eq('id', student.id);
    setBusy(false);
    logActivity({
      academyId, actorId: appUser?.id, actorName: appUser?.name,
      message: banned ? `Marked student ${student.name} as dropout` : `Restored student ${student.name} from dropout`,
    });
    onChanged();
    onClose();
  };

  const doDelete = async () => {
    if (!isAdmin) return; // UI already hides this from staff; guard kept in case of direct calls
    if (!confirm(`Permanently delete "${student.name}"? Attendance & fee history will remain but be orphaned.`)) return;
    setBusy(true);
    await supabase.from('students').delete().eq('id', student.id);
    setBusy(false);
    logActivity({ academyId, actorId: appUser?.id, actorName: appUser?.name, message: `Deleted student ${student.name}` });
    onChanged();
    onClose();
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--card)', width: '100%', maxWidth: 480, margin: '0 auto', maxHeight: '88vh', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>👤</span>
            <span style={{ fontWeight: 800, fontSize: 16 }}>Student Details</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handleDownload}
              disabled={downloading}
              aria-label="Download Profile PDF"
              title="Download Profile PDF"
              style={{
                width: 30, height: 30, borderRadius: '50%', background: 'var(--card2)',
                border: '1px solid var(--border)', cursor: downloading ? 'wait' : 'pointer',
                fontSize: 14, color: 'var(--accent2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: downloading ? 0.6 : 1,
              }}
            >
              {downloading ? '…' : '⬇️'}
            </button>
            <button onClick={onClose} aria-label="Close"
              style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 15, color: 'var(--gray)' }}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px' }}>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            {student.roll_no && (
              <div style={{ display: 'inline-flex', background: 'var(--accent2)', color: '#fff', borderRadius: 8, padding: '3px 14px', fontSize: 13, fontWeight: 800, marginBottom: 8 }}>
                Roll No. {student.roll_no}
              </div>
            )}
            <div style={{ fontSize: 18, fontWeight: 800 }}>{student.name}</div>
            {isBanned && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                <span className="badge badge-red" style={{ fontSize: 11, padding: '3px 9px', borderRadius: 10 }}>Dropout</span>
              </div>
            )}
          </div>

          <div style={{ color: 'var(--gray)', fontSize: 12, marginBottom: 6, marginTop: 4 }}>👤 Personal Info</div>
          <Row label="Age" value={student.dob ? calcAge(student.dob) : student.age} />
          <Row label="Date of Birth" value={student.dob} />
          <Row label="Gender" value={student.gender} />
          <Row label="Parent / Guardian" value={student.parent} />
          <ContactRow label="Contact 1" value={canViewContact ? student.contact : null} />
          <ContactRow label="Contact 2" value={canViewContact ? student.contact2 : null} />
          {!canViewContact && <div style={{ fontSize: 11, color: 'var(--gray)', padding: '4px 0' }}>🔒 Contact number hidden. Ask admin to grant access.</div>}
          <Row label="School" value={student.address} />
          <Row label="Joined" value={student.join_date} />

          {(student.height || student.weight || student.bmi) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ color: 'var(--gray)', fontSize: 11 }}>Height</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{student.height ? `${student.height} cm` : '—'}</div>
              </div>
              <div>
                <div style={{ color: 'var(--gray)', fontSize: 11 }}>Weight</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{student.weight ? `${student.weight} kg` : '—'}</div>
              </div>
              <div>
                <div style={{ color: 'var(--gray)', fontSize: 11 }}>BMI</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{student.bmi || '—'}</div>
              </div>
            </div>
          )}

          <div style={{ padding: '10px 0' }}>
            <div style={{ color: 'var(--gray)', fontSize: 12, marginBottom: 6 }}>🏆 Sports Enrolled</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(student.enrollments && student.enrollments.length > 0
                ? student.enrollments
                : [{ sport: student.sport, batchLabel: student.batchLabel }]
              ).map((en, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-blue" style={{ fontSize: 11, padding: '3px 9px', borderRadius: 10 }}>
                    Sport: {en.sport}
                  </span>
                  <span className="badge badge-blue" style={{ fontSize: 11, padding: '3px 9px', borderRadius: 10 }}>
                    Batch: {en.batchLabel}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <AchievementsSection studentId={student.id} academyId={academyId} canEdit={true} />
        </div>

        <div style={{ display: 'flex', gap: 6, padding: 16, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button className="btn btn-primary btn-sm" style={{ flex: 1 }} disabled={busy} onClick={() => { onClose(); onEdit(student); }}>✏️ Edit</button>
          {!isBanned
            ? <button className="btn btn-warning btn-sm" style={{ flex: 1 }} disabled={busy} onClick={toggleBan}>🚫 Block</button>
            : <button className="btn btn-success btn-sm" style={{ flex: 1 }} disabled={busy} onClick={toggleBan}>✅ Restore</button>}
          {isAdmin && <button className="btn btn-danger btn-sm" style={{ flex: 1 }} disabled={busy} onClick={doDelete}>🗑️ Delete</button>}
        </div>
      </div>
    </div>,
    document.body
  );
}
