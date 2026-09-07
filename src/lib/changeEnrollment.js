// lib/changeEnrollment.js
import { supabase } from './supabaseClient';

/**
 * Transfers a student to a new sport/batch, or discontinues them from one.
 *
 * Behavior:
 *  - Always closes the student's current ACTIVE enrollment row for `oldSport`
 *    (sets active=false, left_date=today, end_reason, end_notes).
 *  - If reason === 'Changed', also inserts a brand-new enrollment row for the
 *    new sport/batch (active=true, join_date=today). No new student row is
 *    ever created — this only touches `enrollments`.
 *  - If reason === 'Discontinued', no new row is inserted — the student simply
 *    has one fewer active enrollment.
 *
 * @param {Object} params
 * @param {string} params.academyId
 * @param {string} params.studentId
 * @param {string} params.oldSport      - sport currently being changed/discontinued
 * @param {string} params.reason        - 'Changed' | 'Discontinued'
 * @param {string} params.notes         - required free-text notes
 * @param {string} [params.newSport]    - required if reason === 'Changed'
 * @param {string} [params.newBatch]    - required if reason === 'Changed'
 * @returns {Promise<{closedEnrollment: object, newEnrollment: object|null}>}
 */
export async function changeEnrollment({
  academyId,
  studentId,
  oldSport,
  reason,
  notes,
  newSport,
  newBatch,
}) {
  // --- Validation ---
  if (!academyId || !studentId || !oldSport) {
    throw new Error('academyId, studentId, and oldSport are required.');
  }
  if (reason !== 'Changed' && reason !== 'Discontinued') {
    throw new Error('Reason must be either "Changed" or "Discontinued".');
  }
  if (!notes || !notes.trim()) {
    throw new Error('Notes are required.');
  }
  if (reason === 'Changed' && (!newSport || !newBatch)) {
    throw new Error('New sport and batch are required when reason is "Changed".');
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 1. Close the specific active enrollment for this sport
  const { data: closedRows, error: closeError } = await supabase
    .from('enrollments')
    .update({
      active: false,
      left_date: today,
      end_reason: reason,
      end_notes: notes.trim(),
    })
    .eq('student_id', studentId)
    .eq('sport', oldSport)
    .eq('active', true)
    .select();

  if (closeError) throw closeError;

  if (!closedRows || closedRows.length === 0) {
    throw new Error(
      `No active enrollment found for student ${studentId} in sport "${oldSport}".`
    );
  }

  let newEnrollment = null;

  // 2. If Changed, open the new enrollment row
  if (reason === 'Changed') {
    const { data: insertedRows, error: insertError } = await supabase
      .from('enrollments')
      .insert({
        academy_id: academyId,
        student_id: studentId,
        sport: newSport,
        batch: newBatch,
        join_date: today,
        active: true,
      })
      .select();

    if (insertError) throw insertError;
    newEnrollment = insertedRows?.[0] ?? null;
  }

  return {
    closedEnrollment: closedRows[0],
    newEnrollment,
  };
}
