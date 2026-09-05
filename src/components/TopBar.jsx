import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAcademyData } from '../context/AcademyDataContext';
import { supabase } from '../lib/supabaseClient';
import { addDays, isTaskMissed, todayIso, urgencyFor } from '../lib/calendarDate';
import { isDue, isOverdue } from '../lib/scheduleUtils';

// Note: todayIso/tomorrowIso now come from calendarDate.js, which builds
// dates from local parts instead of toISOString() — avoids the day-shift
// bug in UTC+ locales that this file used to have.
const tomorrowIso = () => addDays(todayIso(), 1);

// shared urgency coloring: red if the date has passed, orange if today/tomorrow, else neutral
function statusFor(dateStr) {
  const today = todayIso();
  const tomorrow = tomorrowIso();
  if (dateStr < today) return { label: 'Overdue', color: '#ef4444' };
  if (dateStr === today) return { label: 'Today', color: '#f97316' };
  if (dateStr === tomorrow) return { label: 'Tomorrow', color: '#f97316' };
  return { label: dateStr, color: 'var(--offwhite)' };
}

export default function TopBar({ academyName, logoUrl, greeting, onToggleMenu, onToggleNotif, hasNotif, enquiriesPath = '/enquiries', calendarPath = '/calendar', performancePath = '/admin/performance' }) {
  const { isAdmin, academyId, appUser, user } = useAuth();
  const { visibleStudents } = useAcademyData();
  const navigate = useNavigate();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  const date = now.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });

  const [showBellMenu, setShowBellMenu] = useState(false); // small menu: list of alert categories
  const [showEnquiryAlerts, setShowEnquiryAlerts] = useState(false);
  const [showLeaveAlerts, setShowLeaveAlerts] = useState(false);
  const [showTaskAlerts, setShowTaskAlerts] = useState(false);
  const [showPerformanceAlerts, setShowPerformanceAlerts] = useState(false);
  const [selectedEnquiry, setSelectedEnquiry] = useState(null);
  const [selectedLeave, setSelectedLeave] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedPerformance, setSelectedPerformance] = useState(null);

  const createdByName = appUser?.name || appUser?.id || 'Staff';

  // ---- Enquiry follow-up reminders ----
  const [enquiryRows, setEnquiryRows] = useState([]);

  const loadEnquiries = async () => {
    if (!academyId) return;
    const { data, error } = await supabase
      .from('enquiries')
      .select('id, name, phone, reminder_date, assigned_to, created_by, archived')
      .eq('academy_id', academyId)
      .eq('archived', false)
      .not('reminder_date', 'is', null);
    if (!error) setEnquiryRows(data || []);
  };

  // ---- Leave requests awaiting approval ----
  const [leaveRows, setLeaveRows] = useState([]);

  const loadLeaves = async () => {
    if (!academyId) return;
    const { data, error } = await supabase
      .from('leave_requests')
      .select('id, staff_id, staff_name, date, reason, status')
      .eq('academy_id', academyId)
      .eq('status', 'pending');
    if (!error) setLeaveRows(data || []);
  };

  // ---- Task check-in/out warnings (missed entries + pending admin review) ----
  const [taskRows, setTaskRows] = useState([]);

  const loadTasks = async () => {
    if (!academyId) return;
    const { data, error } = await supabase
      .from('week_schedules')
      .select('id, task, date, in_time, out_time, status, staff_id, missed_reason, reviewed_at')
      .eq('academy_id', academyId)
      .in('status', ['scheduled', 'pending', 'in_progress']);
    if (!error) setTaskRows(data || []);
  };

  // ---- Performance: programs due/overdue for a points entry ----
  const [perfPrograms, setPerfPrograms] = useState([]);
  const [perfChallenges, setPerfChallenges] = useState([]);
  const [perfPoints, setPerfPoints] = useState([]);

  const loadPerformance = async () => {
    if (!academyId) return;
    const [progRes, chalRes, ptsRes] = await Promise.all([
      supabase.from('programs').select('id, name, sport, frequency, custom_days, from_date, to_date, created_at').eq('academy_id', academyId),
      supabase.from('program_challenges').select('id, program_id').eq('academy_id', academyId),
      supabase.from('student_challenge_points').select('student_id, challenge_id, awarded_at, created_at').eq('academy_id', academyId),
    ]);
    if (!progRes.error) setPerfPrograms(progRes.data || []);
    if (!chalRes.error) setPerfChallenges(chalRes.data || []);
    if (!ptsRes.error) setPerfPoints(ptsRes.data || []);
  };

  useEffect(() => {
    loadEnquiries();
    loadLeaves();
    loadTasks();
    loadPerformance();
    const t = setInterval(() => { loadEnquiries(); loadLeaves(); loadTasks(); loadPerformance(); }, 60000); // keep the bell fresh without a page reload
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [academyId]);

  const enquiryPending = useMemo(() => {
    let list = enquiryRows;
    if (!isAdmin) {
      list = list.filter(q => q.assigned_to === appUser?.id || q.created_by === createdByName || q.created_by === appUser?.id);
    }
    return [...list].sort((a, b) => a.reminder_date.localeCompare(b.reminder_date));
  }, [enquiryRows, isAdmin, appUser, createdByName]);

  const leavePending = useMemo(() => {
    // admins see everyone's pending leave (needs their action); staff see only their own (awaiting approval)
    let list = leaveRows;
    if (!isAdmin) list = list.filter(l => l.staff_id === user?.id);
    return [...list].sort((a, b) => a.date.localeCompare(b.date));
  }, [leaveRows, isAdmin, user]);

  const enquiryUrgency = useMemo(() => {
    const today = todayIso();
    const tomorrow = tomorrowIso();
    return {
      overdue: enquiryPending.filter(q => q.reminder_date < today).length,
      dueSoon: enquiryPending.filter(q => q.reminder_date === today || q.reminder_date === tomorrow).length,
    };
  }, [enquiryPending]);

  const leaveUrgency = useMemo(() => {
    const today = todayIso();
    const tomorrow = tomorrowIso();
    return {
      overdue: leavePending.filter(l => l.date < today).length,
      dueSoon: leavePending.filter(l => l.date === today || l.date === tomorrow).length,
    };
  }, [leavePending]);

  // A task shows up in the bell while it's still open (not done/cancelled)
  // and urgencyFor() flags it — same logic that colors the task card in
  // the Calendar tab. Reviewing a missed entry clears it here too.
  const taskPending = useMemo(() => {
    let list = taskRows.filter(t => !!urgencyFor(t));
    if (!isAdmin) list = list.filter(t => t.staff_id === user?.id);
    return [...list].sort((a, b) => a.date.localeCompare(b.date));
  }, [taskRows, isAdmin, user]);

  const taskUrgency = useMemo(() => ({
    overdue: taskPending.filter(t => isTaskMissed(t) || t.missed_reason).length,
    dueSoon: taskPending.filter(t => !isTaskMissed(t) && !t.missed_reason).length,
  }), [taskPending]);

  // one row per student+program that currently has a due (or overdue) points entry
  const performancePending = useMemo(() => {
    if (!perfPrograms.length || !visibleStudents?.length) return [];
    const challengeToProgram = {};
    perfChallenges.forEach(c => { challengeToProgram[c.id] = c.program_id; });

    const lastEntryByStudentProgram = {};
    perfPoints.forEach(p => {
      const programId = challengeToProgram[p.challenge_id];
      if (!programId) return;
      const key = `${p.student_id}|${programId}`;
      const date = p.awarded_at || p.created_at;
      if (!lastEntryByStudentProgram[key] || new Date(date) > new Date(lastEntryByStudentProgram[key])) {
        lastEntryByStudentProgram[key] = date;
      }
    });

    const rows = [];
    const today = todayIso();
    visibleStudents.forEach(student => {
      const sports = new Set((student.enrollments || []).map(e => e.sport));
      perfPrograms.forEach(program => {
        if (!sports.has(program.sport)) return;
        if (program.to_date && program.to_date < today) return; // completed programs don't page anyone
        const hasChallenges = perfChallenges.some(c => c.program_id === program.id);
        if (!hasChallenges) return;
        const key = `${student.id}|${program.id}`;
        const lastDate = lastEntryByStudentProgram[key];
        if (!isDue(program, lastDate)) return;
        rows.push({
          id: key,
          studentName: student.name,
          programName: program.name,
          sport: program.sport,
          overdue: isOverdue(program, lastDate),
        });
      });
    });
    return rows;
  }, [perfPrograms, perfChallenges, perfPoints, visibleStudents]);

  const performanceUrgency = useMemo(() => ({
    overdue: performancePending.filter(p => p.overdue).length,
    dueSoon: performancePending.filter(p => !p.overdue).length,
  }), [performancePending]);

  // ---- Browser notifications for pending items (only while this tab is open) ----
  // Register the service worker once. Android Chrome refuses to run
  // `new Notification()` directly (throws "Illegal constructor") and
  // requires notifications to go through a Service Worker registration's
  // showNotification() instead — this gives us that registration. Desktop
  // browsers don't strictly need it, but using the same path everywhere
  // keeps the behavior consistent.
  const swRegistrationRef = useRef(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js')
      .then(reg => { swRegistrationRef.current = reg; })
      .catch(err => console.warn('Service worker registration failed:', err));
  }, []);

  const notifiedIdsRef = useRef(new Set());
  const notifFirstRunRef = useRef(true);

  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const categories = [
      { key: 'enq', emoji: '⏰', label: 'Enquiry follow-up',
        items: enquiryPending.map(q => ({ id: q.id, detail: `${q.name} — reminder ${q.reminder_date}` })) },
      { key: 'leave', emoji: '⏳', label: 'Leave request',
        items: leavePending.map(l => ({ id: l.id, detail: `${l.staff_name} — ${l.date}` })) },
      { key: 'task', emoji: '✅', label: 'Task alert',
        items: taskPending.map(t => ({ id: t.id, detail: `${t.task} — ${t.date}` })) },
      { key: 'perf', emoji: '🏆', label: 'Performance due',
        items: performancePending.map(p => ({ id: p.id, detail: `${p.studentName} — ${p.programName}` })) },
    ];

    const allItems = categories.flatMap(c =>
      c.items.map(item => ({ catKey: c.key, id: `${c.key}-${item.id}`, detail: item.detail })));

    if (notifFirstRunRef.current) {
      // Don't fire a burst of notifications for everything already pending
      // when the tab first loads — only notify for items that show up *after*.
      allItems.forEach(item => notifiedIdsRef.current.add(item.id));
      notifFirstRunRef.current = false;
      return;
    }

    // Collect only the genuinely NEW items since last run — this still
    // decides WHETHER to notify, so we don't re-notify every 60s poll for
    // the same pending stuff.
    const newItems = [];
    allItems.forEach(item => {
      if (notifiedIdsRef.current.has(item.id)) return;
      notifiedIdsRef.current.add(item.id);
      newItems.push(item);
    });
    if (newItems.length === 0) return; // nothing new this cycle — no notification

    // The notification BODY summarizes the TOTAL current pending count per
    // category — not just what's new — so opening it always reflects
    // everything still pending, not just the delta that triggered it.
    const totalByCat = {};
    categories.forEach(c => { totalByCat[c.key] = c.items.length; });
    const totalCount = categories.reduce((sum, c) => sum + c.items.length, 0);
    const activeCats = categories.filter(c => totalByCat[c.key] > 0);

    let title, body;
    if (totalCount === 1) {
      const onlyCat = activeCats[0];
      title = `${onlyCat.emoji} ${onlyCat.label}`;
      body = onlyCat.items[0].detail;
    } else {
      const parts = activeCats.map(c => `${c.emoji} ${totalByCat[c.key]} ${c.label}${totalByCat[c.key] > 1 ? 's' : ''}`);
      title = `🔔 ${totalCount} pending in FeeZo`;
      body = parts.join(' · ');
    }

    // Where a tap should land. Single active category → its path directly.
    // Multiple → prioritize whichever category has an overdue item, since
    // that's the more urgent thing to route the user toward. The bell menu
    // in-app still covers the rest of the categories.
    const pathFor = { enq: enquiriesPath, leave: calendarPath, task: calendarPath, perf: performancePath };
    const urgencyByCat = { enq: enquiryUrgency, leave: leaveUrgency, task: taskUrgency, perf: performanceUrgency };
    const targetCat = activeCats.find(c => urgencyByCat[c.key].overdue > 0) || activeCats[0];
    const targetUrl = targetCat ? pathFor[targetCat.key] : '/';

    // `tag` makes this replace any previous FeeZo notification still
    // showing, instead of stacking a second one, in case this effect
    // somehow ran twice in quick succession. `data.url` is read by
    // sw.js's notificationclick handler to route a tap to the right page.
    const opts = { body, icon: '/icons/notification-icon.png', tag: 'feezo-pending-updates', data: { url: targetUrl } };
    const reg = swRegistrationRef.current;

    if (reg && reg.showNotification) {
      // Preferred path — works on Android Chrome as well as desktop.
      // Click handling for this path lives in sw.js (notificationclick).
      reg.showNotification(title, opts).catch(err =>
        console.warn('showNotification failed:', err));
    } else {
      // Fallback for browsers where the service worker hasn't finished
      // registering yet, or doesn't support it — desktop Chrome/Firefox
      // still allow the direct constructor. Android Chrome would throw
      // here, hence the try/catch. This path isn't routed through the
      // service worker, so it needs its own click handler.
      try {
        const n = new Notification(title, opts);
        n.onclick = () => {
          window.focus();
          navigate(targetUrl);
          n.close();
        };
      } catch (err) {
        console.warn('Notification not supported in this browser context:', err);
      }
    }
  }, [enquiryPending, leavePending, taskPending, performancePending, enquiryUrgency, leaveUrgency, taskUrgency, performanceUrgency, navigate, enquiriesPath, calendarPath, performancePath]);

  const dotFor = (urgency) => urgency.overdue > 0 ? '#ef4444' : (urgency.dueSoon > 0 ? '#f97316' : null);
  const enquiryDot = dotFor(enquiryUrgency);
  const leaveDot = dotFor(leaveUrgency);
  const taskDot = dotFor(taskUrgency);
  const performanceDot = dotFor(performanceUrgency);
  const bellDot = [enquiryDot, leaveDot, taskDot, performanceDot].includes('#ef4444') ? '#ef4444'
    : (enquiryDot || leaveDot || taskDot || performanceDot) ? '#f97316'
    : (hasNotif ? '#22c55e' : null);

  const openBell = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        Notification.requestPermission();
      } catch (err) {
        console.warn('Notification permission request failed:', err);
      }
    }
    setShowBellMenu(s => !s);
    onToggleNotif?.();
  };

  const goToEnquiries = () => {
    setSelectedEnquiry(null);
    setShowEnquiryAlerts(false);
    setShowBellMenu(false);
    navigate(enquiriesPath, { state: { focusEnquiryId: selectedEnquiry?.id } });
  };

  const goToCalendar = () => {
    setSelectedLeave(null);
    setShowLeaveAlerts(false);
    setShowBellMenu(false);
    navigate(calendarPath, { state: { focusLeaveId: selectedLeave?.id } });
  };

  const goToTask = () => {
    setSelectedTask(null);
    setShowTaskAlerts(false);
    setShowBellMenu(false);
    navigate(calendarPath, { state: { focusTaskId: selectedTask?.id } });
  };

  const goToPerformance = () => {
    setSelectedPerformance(null);
    setShowPerformanceAlerts(false);
    setShowBellMenu(false);
    navigate(performancePath);
  };

  return (
    <div className="topbar" data-app-header style={{ gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        <div
          className="logo-img"
          onClick={() => { if (isAdmin) navigate('/profile'); }}
          style={{ cursor: 'pointer', flexShrink: 0, overflow: 'hidden' }}
          title="Go to Profile"
        >{logoUrl ? <img src={logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '⚔️'}</div>
        <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <div className="academy-name" style={{ whiteSpace: 'normal', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.25, fontSize: 13, wordBreak: 'break-word' }}>
            {academyName || 'Academy'}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {greeting}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ position: 'relative' }}>
            <button onClick={openBell} aria-label="Notifications"
              style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gray)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {bellDot && <span style={{ position: 'absolute', top: 4, right: 4, width: 9, height: 9, background: bellDot, borderRadius: '50%', border: '2px solid var(--card2)' }} />}
            </button>

            {showBellMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowBellMenu(false)} />
                <div className="card" style={{ position: 'absolute', top: 40, right: 0, width: 230, padding: 6, zIndex: 999, boxShadow: '0 8px 24px rgba(0,0,0,.3)' }}>
                  {enquiryPending.length === 0 && leavePending.length === 0 && taskPending.length === 0 && performancePending.length === 0 && (
                    <div style={{ padding: '14px 8px', textAlign: 'center', fontSize: 12.5, color: 'var(--gray)' }}>Nothing pending. 🎉</div>
                  )}

                  {enquiryPending.length > 0 && (
                    <div
                      onClick={() => { setShowBellMenu(false); setShowEnquiryAlerts(true); }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 8px', borderRadius: 6, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {enquiryDot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: enquiryDot, flexShrink: 0 }} />}
                        ⏰ Enquiry Alerts
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray)' }}>{enquiryPending.length}</span>
                    </div>
                  )}

                  {leavePending.length > 0 && (
                    <div
                      onClick={() => { setShowBellMenu(false); setShowLeaveAlerts(true); }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 8px', borderRadius: 6, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {leaveDot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: leaveDot, flexShrink: 0 }} />}
                        ⏳ Leave Alerts
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray)' }}>{leavePending.length}</span>
                    </div>
                  )}

                  {taskPending.length > 0 && (
                    <div
                      onClick={() => { setShowBellMenu(false); setShowTaskAlerts(true); }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 8px', borderRadius: 6, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {taskDot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: taskDot, flexShrink: 0 }} />}
                        ✅ Task Alerts
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray)' }}>{taskPending.length}</span>
                    </div>
                  )}

                  {performancePending.length > 0 && (
                    <div
                      onClick={() => { setShowBellMenu(false); setShowPerformanceAlerts(true); }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 8px', borderRadius: 6, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {performanceDot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: performanceDot, flexShrink: 0 }} />}
                        🏆 Performance Alerts
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gray)' }}>{performancePending.length}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <button className="hamburger-btn" onClick={onToggleMenu} aria-label="Navigation"
            style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)' }}>
            <span></span><span></span><span></span>
          </button>
        </div>
        <div style={{ textAlign: 'right', lineHeight: 1.2 }}>
          <div className="datetime-combined" style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{time}, {date}</div>
        </div>
      </div>

      {/* ---- Enquiry Alerts table window ---- */}
      {showEnquiryAlerts && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowEnquiryAlerts(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 420, maxHeight: '78vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>⏰ Enquiry Alerts {enquiryPending.length > 0 && `(${enquiryPending.length})`}</div>
              <button onClick={() => setShowEnquiryAlerts(false)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>

            {enquiryPending.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--gray)' }}>Nothing pending. 🎉</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, padding: '8px 16px', fontSize: 10.5, fontWeight: 700, color: 'var(--gray)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ flex: 1.3, minWidth: 0 }}>NAME</div>
                  <div style={{ flex: 1.2, minWidth: 0 }}>CONTACT</div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>REMINDER</div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {enquiryPending.map(q => {
                    const s = statusFor(q.reminder_date);
                    return (
                      <div key={q.id} onClick={() => { setShowEnquiryAlerts(false); setSelectedEnquiry(q); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ flex: 1.3, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</div>
                        <div style={{ flex: 1.2, minWidth: 0, fontSize: 11.5, color: 'var(--accent2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.phone || '—'}</div>
                        <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: s.color, whiteSpace: 'nowrap' }}>{q.reminder_date}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ---- Leave Alerts table window ---- */}
      {showLeaveAlerts && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowLeaveAlerts(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 420, maxHeight: '78vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>🌴 Leave Alerts {leavePending.length > 0 && `(${leavePending.length})`}</div>
              <button onClick={() => setShowLeaveAlerts(false)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>

            {leavePending.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--gray)' }}>Nothing pending. 🎉</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, padding: '8px 16px', fontSize: 10.5, fontWeight: 700, color: 'var(--gray)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ flex: 1.3, minWidth: 0 }}>NAME</div>
                  <div style={{ flex: 1.2, minWidth: 0 }}>REASON</div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>DATE</div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {leavePending.map(l => {
                    const s = statusFor(l.date);
                    return (
                      <div key={l.id} onClick={() => { setShowLeaveAlerts(false); setSelectedLeave(l); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ flex: 1.3, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.staff_name}</div>
                        <div style={{ flex: 1.2, minWidth: 0, fontSize: 11.5, color: 'var(--gray)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.reason || '—'}</div>
                        <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: s.color, whiteSpace: 'nowrap' }}>{l.date}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ---- Task Alerts table window ---- */}
      {showTaskAlerts && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowTaskAlerts(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 420, maxHeight: '78vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>✅ Task Alerts {taskPending.length > 0 && `(${taskPending.length})`}</div>
              <button onClick={() => setShowTaskAlerts(false)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>

            {taskPending.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--gray)' }}>Nothing pending. 🎉</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, padding: '8px 16px', fontSize: 10.5, fontWeight: 700, color: 'var(--gray)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ flex: 1.3, minWidth: 0 }}>TASK</div>
                  <div style={{ flex: 1.2, minWidth: 0 }}>STATUS</div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>DATE</div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {taskPending.map(t => {
                    const u = urgencyFor(t);
                    return (
                      <div key={t.id} onClick={() => { setShowTaskAlerts(false); setSelectedTask(t); }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ flex: 1.3, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.task || 'Untitled Task'}</div>
                        <div style={{ flex: 1.2, minWidth: 0, fontSize: 11.5, color: u.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.label}</div>
                        <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: u.color, whiteSpace: 'nowrap' }}>{t.date}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ---- Performance Alerts table window ---- */}
      {showPerformanceAlerts && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowPerformanceAlerts(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 420, maxHeight: '78vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>🏆 Performance Alerts {performancePending.length > 0 && `(${performancePending.length})`}</div>
              <button onClick={() => setShowPerformanceAlerts(false)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>

            {performancePending.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--gray)' }}>Nothing pending. 🎉</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, padding: '8px 16px', fontSize: 10.5, fontWeight: 700, color: 'var(--gray)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div style={{ flex: 1.3, minWidth: 0 }}>STUDENT</div>
                  <div style={{ flex: 1.2, minWidth: 0 }}>PROGRAM</div>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>STATUS</div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {performancePending.map(p => (
                    <div key={p.id} onClick={() => { setShowPerformanceAlerts(false); setSelectedPerformance(p); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--card2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div style={{ flex: 1.3, minWidth: 0, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.studentName}</div>
                      <div style={{ flex: 1.2, minWidth: 0, fontSize: 11.5, color: 'var(--gray)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.programName}</div>
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: p.overdue ? '#ef4444' : '#f97316', whiteSpace: 'nowrap' }}>{p.overdue ? 'Overdue' : 'Due'}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ---- Enquiry detail popup ---- */}
      {selectedEnquiry && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setSelectedEnquiry(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 320, padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{selectedEnquiry.name}</div>
              <button onClick={() => setSelectedEnquiry(null)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>
            {selectedEnquiry.phone && (
              <a href={`tel:${selectedEnquiry.phone}`} style={{ display: 'block', fontSize: 13, color: 'var(--accent2)', textDecoration: 'none', marginBottom: 8 }}>📞 {selectedEnquiry.phone}</a>
            )}
            <div style={{ fontSize: 12.5, marginBottom: 16 }}>
              <span style={{ color: 'var(--gray)' }}>⏰ Reminder: </span>
              <span style={{ fontWeight: 700, color: statusFor(selectedEnquiry.reminder_date).color }}>
                {selectedEnquiry.reminder_date} ({statusFor(selectedEnquiry.reminder_date).label})
              </span>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} onClick={goToEnquiries}>
              ➜ Go to Enquiries
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ---- Leave detail popup ---- */}
      {selectedLeave && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setSelectedLeave(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 320, padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{selectedLeave.staff_name}</div>
              <button onClick={() => setSelectedLeave(null)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>
            {selectedLeave.reason && (
              <div style={{ fontSize: 12.5, color: 'var(--gray)', fontStyle: 'italic', marginBottom: 8 }}>{selectedLeave.reason}</div>
            )}
            <div style={{ fontSize: 12.5, marginBottom: 16 }}>
              <span style={{ color: 'var(--gray)' }}>📆 Leave date: </span>
              <span style={{ fontWeight: 700, color: statusFor(selectedLeave.date).color }}>
                {selectedLeave.date} ({statusFor(selectedLeave.date).label})
              </span>
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: 'var(--gray)', background: 'var(--card2)', borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase' }}>Pending</span>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} onClick={goToCalendar}>
              ➜ Go to Calendar
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ---- Task detail popup ---- */}
      {selectedTask && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setSelectedTask(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 320, padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{selectedTask.task || 'Untitled Task'}</div>
              <button onClick={() => setSelectedTask(null)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>
            {selectedTask.missed_reason && (
              <div style={{ fontSize: 12.5, color: 'var(--gray)', fontStyle: 'italic', marginBottom: 8 }}>{selectedTask.missed_reason}</div>
            )}
            <div style={{ fontSize: 12.5, marginBottom: 16 }}>
              <span style={{ color: 'var(--gray)' }}>📆 Date: </span>
              <span style={{ fontWeight: 700, color: urgencyFor(selectedTask)?.color }}>
                {selectedTask.date} ({urgencyFor(selectedTask)?.label})
              </span>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} onClick={goToTask}>
              ➜ Go to Calendar
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ---- Performance detail popup ---- */}
      {selectedPerformance && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setSelectedPerformance(null)}>
          <div className="card" style={{ width: '100%', maxWidth: 320, padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{selectedPerformance.studentName}</div>
              <button onClick={() => setSelectedPerformance(null)} style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--card2)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginBottom: 8 }}>{selectedPerformance.sport} · {selectedPerformance.programName}</div>
            <div style={{ fontSize: 12.5, marginBottom: 16 }}>
              <span style={{ color: 'var(--gray)' }}>🏆 Points entry: </span>
              <span style={{ fontWeight: 700, color: selectedPerformance.overdue ? '#ef4444' : '#f97316' }}>
                {selectedPerformance.overdue ? 'Overdue' : 'Due now'}
              </span>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} onClick={goToPerformance}>
              ➜ Go to Performance
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
