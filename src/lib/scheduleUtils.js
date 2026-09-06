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
