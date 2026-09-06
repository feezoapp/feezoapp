// Shared logic for turning a program's frequency (daily/weekly/monthly/custom)
// plus its last points entry into a due date — used by StudentHistoryModal to
// gate the Add Points button, and by useOverdueEntries for the bell dot.

export const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30 };

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Finds the next date >= from that falls on one of the program's selected
// weekdays (custom_days: array of 0=Sun..6=Sat).
function nextCustomDate(from, customDays) {
  if (!customDays || customDays.length === 0) return startOfDay(from);
  let d = startOfDay(from);
  for (let i = 0; i < 7; i++) {
    if (customDays.includes(d.getDay())) return d;
    d = addDays(d, 1);
  }
  return d; // unreachable in practice — loop always finds a match within 7 days
}

// baseDate: the last points entry date for this program, or (if none yet)
// the program's from_date/created_at — a brand-new program is due from day one.
export function getDueDate(program, lastEntryDate) {
  if (program.frequency === 'custom') {
    // search from the day AFTER the last entry so an entry made ON a
    // scheduled day clears that day's dot; before any entry, search from
    // the program's own start date instead of created_at so a program that
    // starts in the future doesn't show as due immediately.
    const from = lastEntryDate
      ? addDays(lastEntryDate, 1)
      : (program.from_date || program.created_at || new Date().toISOString());
    return nextCustomDate(from, program.custom_days);
  }
  if (!lastEntryDate) {
    // No entry has ever been made — this program is due from its own start
    // date, not one full period after created_at. Using created_at here
    // was the bug: it made a brand-new Weekly/Monthly program falsely
    // appear "not due" for a whole extra period after being set up, even
    // though the comment above this function says the opposite is intended.
    return startOfDay(program.from_date || program.created_at || new Date().toISOString());
  }
  const freqDays = FREQ_DAYS[program.frequency] || 7;
  return addDays(lastEntryDate, freqDays);
}

export function isDue(program, lastEntryDate) {
  const due = getDueDate(program, lastEntryDate);
  return new Date() >= due;
}

// overdue = still not entered a full day past the due date — this is the
// threshold that should trigger the notification bell's red dot
export function isOverdue(program, lastEntryDate) {
  const due = getDueDate(program, lastEntryDate);
  const overdueSince = addDays(due, 1);
  return new Date() >= overdueSince;
}

// Formats a Date using its LOCAL calendar fields, not .toISOString() (which
// converts to UTC first). For any timezone ahead of UTC — e.g. IST, UTC+5:30
// — midnight local time is still the previous day in UTC, so .toISOString()
// silently shifts every period boundary back by one calendar day. That
// mismatch is what let already-awarded weeks keep showing up as "missing":
// the date saved on award and the date computed while enumerating periods
// were each shifted independently and landed on different days.
function pad2(n) { return String(n).padStart(2, '0'); }
function toLocalDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Buckets a chosen date into the "period" that a program's frequency
// awards points against — one row per period per student per challenge,
// instead of one row ever. Daily/Custom programs use the exact date;
// Weekly buckets to that week's Sunday; Monthly buckets to the 1st of
// the month. This used to be duplicated separately in AwardPointsModal.jsx
// and PerformancePage.jsx — now shared here so the leaderboard's period
// count, the award modal's bucketing, and the history gap-check never
// disagree about what counts as "one period".
export function periodStartFor(frequency, dateIso) {
  const d = new Date(dateIso + 'T00:00:00');
  if (frequency === 'monthly') {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
  }
  if (frequency === 'weekly') {
    const sunday = new Date(d);
    sunday.setDate(d.getDate() - d.getDay());
    return toLocalDateStr(sunday);
  }
  return dateIso; // daily & custom — one period per calendar date
}

function todayIsoForPeriods() { return toLocalDateStr(new Date()); }

// Every period from a program's start date through today (capped at its
// end date, if it has one and it's already passed) — the full set of
// periods that could ever have a points entry.
export function enumeratePeriods(program, todayIsoStr = todayIsoForPeriods()) {
  const startIso = program.from_date;
  if (!startIso) return [];
  const capEndIso = program.to_date && program.to_date < todayIsoStr ? program.to_date : todayIsoStr;
  if (capEndIso < startIso) return [];

  const periods = [];
  if (program.frequency === 'monthly') {
    let cur = periodStartFor('monthly', startIso);
    while (cur <= capEndIso) {
      periods.push(cur);
      const d = new Date(cur + 'T00:00:00'); d.setMonth(d.getMonth() + 1);
      cur = toLocalDateStr(d);
    }
  } else if (program.frequency === 'weekly') {
    let cur = periodStartFor('weekly', startIso);
    while (cur <= capEndIso) {
      periods.push(cur);
      const d = new Date(cur + 'T00:00:00'); d.setDate(d.getDate() + 7);
      cur = toLocalDateStr(d);
    }
  } else if (program.frequency === 'custom' && Array.isArray(program.custom_days) && program.custom_days.length) {
    const d = new Date(startIso + 'T00:00:00');
    const end = new Date(capEndIso + 'T00:00:00');
    while (d <= end) {
      if (program.custom_days.includes(d.getDay())) periods.push(toLocalDateStr(d));
      d.setDate(d.getDate() + 1);
    }
  } else {
    const d = new Date(startIso + 'T00:00:00');
    const end = new Date(capEndIso + 'T00:00:00');
    while (d <= end) {
      periods.push(toLocalDateStr(d));
      d.setDate(d.getDate() + 1);
    }
  }
  return periods;
}

// Periods with no points entry yet for any of this program's challenges —
// the actual gaps staff need to go back and fill in, surfaced explicitly so
// there's no guessing which past date(s) still need points.
export function missingPeriodsFor(program, challenges, existingPoints) {
  const progChallengeIds = new Set(challenges.filter(c => c.program_id === program.id).map(c => c.id));
  const entered = new Set(existingPoints.filter(p => progChallengeIds.has(p.challenge_id)).map(p => p.period_start));
  return enumeratePeriods(program).filter(p => !entered.has(p));
}
