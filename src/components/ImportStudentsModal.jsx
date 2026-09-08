import { useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabaseClient';
import { buildBatchKey } from '../lib/batchKey';
import { usePlan } from '../context/PlanContext';

const HEADER_MAP = {
  name: 'name', studentname: 'name', fullname: 'name',
  rollno: 'rollNo', roll: 'rollNo', rollnumber: 'rollNo', sno: 'rollNo', no: 'rollNo',
  batch: 'batch', batchname: 'batch', group: 'batch', class: 'batch',
  sport: 'sport', sportname: 'sport', game: 'sport', discipline: 'sport',
  dob: 'dob', dateofbirth: 'dob', birthdate: 'dob', birthday: 'dob',
  gender: 'gender', sex: 'gender',
  height: 'height', heightcm: 'height',
  weight: 'weight', weightkg: 'weight',
  parent: 'parent', parentname: 'parent', guardian: 'parent', guardianname: 'parent',
  contact: 'contact', contact1: 'contact', phone: 'contact', mobile: 'contact', phonenumber: 'contact',
  contact2: 'contact2', phone2: 'contact2', altcontact: 'contact2', alternatecontact: 'contact2',
  school: 'school', schoolname: 'school', college: 'school',
  address: 'address',
  joindate: 'joinDate', joiningdate: 'joinDate', joined: 'joinDate', dateofjoining: 'joinDate',
};
const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function excelDateToIso(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (/^\d{4,5}$/.test(s)) {
    const d = new Date(Math.round((parseFloat(s) - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY -> YYYY-MM-DD
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

function rollPrefix(sport, batch) {
  const s = String(sport || '').trim(), b = String(batch || '').trim();
  if (!s || !b) return '';
  return (s[0] + b[0]).toUpperCase();
}

function calcAge(dobIso) {
  if (!dobIso) return '';
  const d = new Date(dobIso);
  if (isNaN(d)) return '';
  const today = new Date();
  if (d > today) return '';
  let age = today.getFullYear() - d.getFullYear();
  const mDiff = today.getMonth() - d.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

// Compares numeric-ish fields (height/weight/bmi) regardless of whether the
// value comes back from Supabase as a string or a number (depends on the
// column type) — a plain === here would flag every row as "changed" purely
// because of a type mismatch, not an actual data difference.
function numEq(a, b) {
  const blankA = a === '' || a === null || a === undefined;
  const blankB = b === '' || b === null || b === undefined;
  if (blankA && blankB) return true;
  if (blankA || blankB) return false;
  const na = Number(a), nb = Number(b);
  if (isNaN(na) || isNaN(nb)) return String(a) === String(b);
  return Math.abs(na - nb) < 0.05;
}

function calcBmi(heightCm, weightKg) {
  const h = parseFloat(heightCm);
  const w = parseFloat(weightKg);
  if (!h || !w || h <= 0 || w <= 0) return '';
  const m = h / 100;
  return (w / (m * m)).toFixed(1);
}

function normalizeGender(val) {
  const s = String(val || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'm' || s === 'male') return 'Male';
  if (s === 'f' || s === 'female') return 'Female';
  return 'Other';
}

// Two rows within the SAME import file (neither matched to an existing DB
// student) are treated as the same brand-new student if they share strong
// identifying info, or — when neither row has any identifying info at all —
// if the name matches. This mirrors the existing-student matching rules
// below, but applied within the file so a new student listed across several
// sport/batch rows becomes one student with multiple enrollments instead of
// one duplicate student per row.
function sameNewStudent(g, row) {
  if (g.name.toLowerCase() !== row.name.toLowerCase()) return false;
  const gNums = [g.contact, g.contact2].filter(Boolean);
  const rNums = [row.contact, row.contact2].filter(Boolean);
  const contactOverlap = gNums.length > 0 && rNums.length > 0 && rNums.some(n => gNums.includes(n));
  const dobParentMatch = !!(row.dob && g.dob && row.parent && g.parent && g.dob === row.dob && g.parent.toLowerCase() === row.parent.toLowerCase());
  if (contactOverlap || dobParentMatch) return true;
  const noIdentifyingInfo = !row.contact && !row.contact2 && !row.dob && !row.parent && !g.contact && !g.contact2 && !g.dob && !g.parent;
  return noIdentifyingInfo;
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

export default function ImportStudentsModal({ academyId, sports, batches, existingStudents, totalStudents, onClose, onImported }) {
  const { limits, plan } = usePlan();
  const [rows, setRows] = useState(null); // parsed+validated rows, or null before a file is chosen
  const [rejected, setRejected] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const downloadTemplate = () => {
    const headers = ['Name', 'RollNo', 'Sport', 'Batch', 'DOB', 'Gender', 'Height', 'Weight', 'Parent', 'Contact', 'Contact2', 'School', 'JoinDate'];
    const today = new Date().toISOString().slice(0, 10);
    const firstSport = sports[0]?.name || 'Sport A';
    const firstBatch = batches.find(b => b.sport === firstSport)?.batchLabel || 'Batch 1';
    const example1 = ['Arjun Kumar', '', firstSport, firstBatch, '2013-06-15', 'Male', '150', '45', 'Ramesh Kumar', '9876543210', '', 'ABC School', today];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, example1]);
    ws['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Students');
    const instr = [
      ['HOW TO USE THIS TEMPLATE'], [''],
      ['1. Fill one row per student. Delete the example row before importing.'],
      ['2. Name, Sport and Batch are required. Sport/Batch must match ones already in the app.'],
      ['3. Leave RollNo blank to auto-generate (Sport initial + Batch initial + number).'],
      ['4. Dates: YYYY-MM-DD or DD/MM/YYYY.'],
      ['5. Gender: Male, Female, or Other (M/F also accepted).'],
      ['6. Height in cm, Weight in kg. Both optional — leave blank if unknown.'],
      ['7. A row matching an existing student (shared contact, same DOB+parent, or a sport/batch they\'re already enrolled in) updates that student instead of duplicating.'],
      ['8. A student can appear in multiple rows with different Sport/Batch — each row adds or updates that one enrollment, so a student can end up enrolled in several batches. This also works for brand-new students in the same file.'],
      ['9. If nothing on the row actually differs from the existing student and enrollment, it is marked "Skip" and left untouched.'],
      ['10. Adding a NEW sport/batch to an already-enrolled student with no Contact/DOB/Parent given only matches by name, and only if that name is unique in your roster — add a Contact or DOB if two students share a name.'],
    ];
    const wsI = XLSX.utils.aoa_to_sheet(instr);
    wsI['!cols'] = [{ wch: 70 }];
    XLSX.utils.book_append_sheet(wb, wsI, 'Instructions');
    XLSX.writeFile(wb, 'Student_Import_Template.xlsx');
  };

  const downloadRejected = () => {
    const headers = ['Name', 'RollNo', 'Sport', 'Batch', 'DOB', 'Gender', 'Height', 'Weight', 'Parent', 'Contact', 'Contact2', 'School', 'JoinDate', 'Reason'];
    const rowsOut = rejected.map(r => [
      r.raw?.Name || '', r.raw?.RollNo || '', r.raw?.Sport || '', r.raw?.Batch || '',
      r.raw?.DOB || '', r.raw?.Gender || '', r.raw?.Height || '', r.raw?.Weight || '',
      r.raw?.Parent || '', r.raw?.Contact || '', r.raw?.Contact2 || '',
      r.raw?.School || '', r.raw?.JoinDate || '', r.reason,
    ]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rowsOut]);
    ws['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 12 }, { wch: 34 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Rejected');
    XLSX.writeFile(wb, 'Rejected_Students.xlsx');
  };

  const parseText = (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { setError('File must have a header row and at least one data row.'); return; }
    const headerCols = parseCSVLine(lines[0]);
    const colMap = {};
    headerCols.forEach((h, i) => {
      const key = HEADER_MAP[normHeader(h)];
      if (key && !(key in colMap)) colMap[key] = i;
    });
    if (colMap.name === undefined) { setError('Could not find a "Name" column.'); return; }

    const get = (cols, key) => (colMap[key] !== undefined ? (cols[colMap[key]] || '').trim() : '');
    const parsed = [];
    const rej = [];
    const previewRollNums = existingStudents.map(s => (s.roll_no || '').toUpperCase());
    // Brand-new students (no DB match) discovered in this file, keyed so a
    // student appearing across multiple sport/batch rows is only inserted once.
    const newGroups = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const name = get(cols, 'name');
      const sportRaw = get(cols, 'sport');
      const batchRaw = get(cols, 'batch');
      const raw = {
        Name: name, RollNo: get(cols, 'rollNo'), Sport: sportRaw, Batch: batchRaw,
        DOB: get(cols, 'dob'), Gender: get(cols, 'gender'), Height: get(cols, 'height'), Weight: get(cols, 'weight'),
        Parent: get(cols, 'parent'), Contact: get(cols, 'contact'),
        Contact2: get(cols, 'contact2'), School: get(cols, 'school'), JoinDate: get(cols, 'joinDate'),
      };
      // Silently skip fully-blank rows — spreadsheet apps often leave empty
      // formatted rows (row-height/styling with no cell data) when a file is
      // re-saved, and those shouldn't count as rejected import rows.
      const isBlankRow = Object.values(raw).every(v => !v);
      if (isBlankRow) continue;

      if (!name) { rej.push({ label: `Row ${i + 1}`, reason: 'Missing name', raw }); continue; }
      const matchedSport = sports.find(s => s.name.toLowerCase() === sportRaw.toLowerCase());
      if (!matchedSport) { rej.push({ label: name, reason: `Sport "${sportRaw}" not found`, raw }); continue; }
      const matchedBatch = batches.find(b => b.sport === matchedSport.name && b.batchLabel.toLowerCase() === batchRaw.toLowerCase());
      if (!matchedBatch) { rej.push({ label: name, reason: `Batch "${batchRaw}" not found under ${matchedSport.name}`, raw }); continue; }

      const dob = excelDateToIso(get(cols, 'dob'));
      const contact = get(cols, 'contact');
      const contact2 = get(cols, 'contact2');
      const parent = get(cols, 'parent');

      // Match against an existing student. Three tiers, in order of trust:
      //  1. Strong signal: shared contact number, or same DOB + parent name.
      //  2. No identifying info given, but this row's sport/batch is already
      //     one of the student's CURRENT enrollments (checks the full list,
      //     not just the legacy "primary" sport/batch) — this is what lets a
      //     re-imported lightweight roster update existing rows instead of
      //     duplicating them.
      //  3. No identifying info, and this is a sport/batch they're NOT yet
      //     enrolled in — only safe to assume it's the same person if the
      //     name is unique across the whole academy roster; otherwise a
      //     silent guess here could merge two different people's records.
      const sameNameExisting = existingStudents.filter(s => (s.name || '').toLowerCase() === name.toLowerCase());
      const match = sameNameExisting.find(s => {
        const importNums = [contact, contact2].filter(Boolean);
        const existingNums = [s.contact, s.contact2].filter(Boolean);
        const contactOverlap = importNums.length > 0 && existingNums.length > 0 && importNums.some(n => existingNums.includes(n));
        const dobParentMatch = !!(dob && s.dob && parent && s.parent && s.dob === dob && s.parent.toLowerCase() === parent.toLowerCase());
        if (contactOverlap || dobParentMatch) return true;
        const noIdentifyingInfo = !contact && !contact2 && !dob && !parent;
        if (!noIdentifyingInfo) return false;
        const sEnrollments = s.enrollments && s.enrollments.length > 0
          ? s.enrollments : [{ sport: s.sport, batchLabel: s.batchLabel }];
        if (sEnrollments.some(en => en.sport === matchedSport.name && en.batchLabel === matchedBatch.batchLabel)) return true;
        return sameNameExisting.length === 1;
      });

      let rollNo = get(cols, 'rollNo').toUpperCase();
      const selfRollNo = match ? (match.roll_no || '').toUpperCase() : '';
      const height = get(cols, 'height');
      const weight = get(cols, 'weight');
      const school = get(cols, 'school');
      const address = get(cols, 'address');
      const joinDate = excelDateToIso(get(cols, 'joinDate')) || new Date().toISOString().slice(0, 10);
      const gender = normalizeGender(get(cols, 'gender'));
      let newGroupId = null;
      let isGroupPrimary = false;

      if (match) {
        // Editing an existing student: if they typed a roll number that's
        // actually different from this student's own, and it collides with
        // a DIFFERENT existing student, reject the row rather than silently
        // reassigning or letting it fail at the database.
        if (rollNo && rollNo !== selfRollNo && previewRollNums.includes(rollNo)) {
          rej.push({ label: name, reason: `Roll number "${rollNo}" is already used by another student`, raw });
          continue;
        }
      } else {
        // Not in the DB — but might be the SAME new student as an earlier
        // row in this file (e.g. one row per sport). If so, reuse that
        // student's roll number/details instead of generating a new one,
        // so we don't create a duplicate student at submit time.
        const group = newGroups.find(g => sameNewStudent(g, { name, dob, parent, contact, contact2 }));
        if (group) {
          rollNo = group.rollNo;
          newGroupId = group.id;
          // Fill in any identifying/demographic info this row has that the
          // group is still missing, so later rows in the file can match too.
          if (!group.dob && dob) group.dob = dob;
          if (!group.parent && parent) group.parent = parent;
          if (!group.contact && contact) group.contact = contact;
          if (!group.contact2 && contact2) group.contact2 = contact2;
          if (!group.height && height) group.height = height;
          if (!group.weight && weight) group.weight = weight;
          if (!group.school && school) group.school = school;
          if (!group.address && address) group.address = address;
          if (!group.gender && gender) group.gender = gender;
        } else {
          if (rollNo && previewRollNums.includes(rollNo)) rollNo = ''; // clashes, regenerate
          if (!rollNo) {
            const prefix = rollPrefix(matchedSport.name, matchedBatch.batchLabel);
            let maxNum = 0;
            previewRollNums.forEach(rn => {
              if (rn.startsWith(prefix)) {
                const n = parseInt(rn.slice(prefix.length), 10);
                if (!isNaN(n) && n > maxNum) maxNum = n;
              }
            });
            const next = maxNum + 1;
            rollNo = prefix + String(next).padStart(next >= 100 ? 3 : 2, '0');
          }
          previewRollNums.push(rollNo);
          newGroupId = newGroups.length;
          isGroupPrimary = true;
          newGroups.push({
            id: newGroupId, name, rollNo, dob, parent, contact, contact2, height, weight, school, address, gender,
            sport: matchedSport.name, batchLabel: matchedBatch.batchLabel, joinDate,
          });
        }
      }

      const effHeightForBmi = height || (match ? match.height : '') || (newGroupId !== null ? newGroups[newGroupId].height : '');
      const effWeightForBmi = weight || (match ? match.weight : '') || (newGroupId !== null ? newGroups[newGroupId].weight : '');

      parsed.push({
        _match: match || null,
        _newGroupId: newGroupId,
        _groupRef: newGroupId !== null ? newGroups[newGroupId] : null,
        _isGroupPrimary: isGroupPrimary,
        name, rollNo, sport: matchedSport.name, batchLabel: matchedBatch.batchLabel,
        dob, age: calcAge(dob) ? String(calcAge(dob)) : '', gender, height, weight,
        bmi: calcBmi(effHeightForBmi, effWeightForBmi),
        parent, contact, contact2, school, address,
        joinDate,
      });
    }

    // Finalize each new-student group's derived fields (age/BMI) now that
    // every row has had a chance to fill in missing details for it.
    newGroups.forEach(g => {
      g.age = calcAge(g.dob) ? String(calcAge(g.dob)) : '';
      g.bmi = calcBmi(g.height, g.weight);
    });

    // Second pass: for matched rows, work out if the import would actually
    // change anything. If every effective field is identical to what's already
    // stored, mark it "no changes" so it's shown/handled as a Skip rather than
    // a pointless Update write.
    parsed.forEach(r => {
      if (!r._match) return;
      const m = r._match;
      const effRollNo = r.rollNo || m.roll_no || '';
      const effContact = r.contact || m.contact || '';
      const effContact2 = r.contact2 || m.contact2 || '';
      const effAddress = r.address || m.address || '';
      const effSchool = r.school || m.school || '';
      const effGender = r.gender || m.gender || '';
      const effHeight = r.height || m.height || '';
      const effWeight = r.weight || m.weight || '';
      const effBmi = r.bmi || m.bmi || '';
      const effBatchKey = buildBatchKey(r.sport, r.batchLabel);
      // A student can now hold several enrollments (multiple sport/batch rows),
      // so "no changes" also requires this row's specific sport+batch to
      // already exist for the student — not just that the legacy primary
      // batch field matches.
      const existingEnrollments = m.enrollments && m.enrollments.length > 0
        ? m.enrollments : [{ sport: m.sport, batchLabel: m.batchLabel }];
      const enrollmentExists = existingEnrollments.some(en => en.sport === r.sport && en.batchLabel === r.batchLabel);
      r._noChanges = (
        effRollNo === (m.roll_no || '') &&
        effContact === (m.contact || '') &&
        effContact2 === (m.contact2 || '') &&
        effAddress === (m.address || '') &&
        effSchool === (m.school || '') &&
        effGender === (m.gender || '') &&
        numEq(effHeight, m.height || '') &&
        numEq(effWeight, m.weight || '') &&
        numEq(effBmi, m.bmi || '') &&
        effBatchKey === (m.batch || '') &&
        enrollmentExists
      );
    });

    // Enforce the plan's student limit on NEW students only — matched/updated
    // rows don't add to the count. Overflow rows are bumped to "rejected"
    // rather than silently dropped, so the user sees exactly which rows to
    // remove or upgrade for.
    const planLimit = limits.students;
    if (planLimit !== null && planLimit !== undefined) {
      const baseline = totalStudents ?? existingStudents.length;
      let remainingSlots = Math.max(0, planLimit - baseline);
      const admittedGroupIds = new Set();
      const kept = [];
      for (const r of parsed) {
        if (r._match) { kept.push(r); continue; } // updates don't consume a slot
        // Extra enrollment rows for an already-admitted new student don't
        // cost another slot — it's still the same one student.
        if (admittedGroupIds.has(r._newGroupId)) { kept.push(r); continue; }
        if (remainingSlots > 0) { kept.push(r); admittedGroupIds.add(r._newGroupId); remainingSlots--; continue; }
        rej.push({
          label: r.name,
          reason: `Plan limit reached (${planLimit} students on your ${plan?.name || 'current'} plan) — upgrade to import more.`,
          raw: {
            Name: r.name, RollNo: r.rollNo, Sport: r.sport, Batch: r.batchLabel, DOB: r.dob,
            Gender: r.gender, Height: r.height, Weight: r.weight, Parent: r.parent,
            Contact: r.contact, Contact2: r.contact2, School: r.school, JoinDate: r.joinDate,
          },
        });
      }
      parsed.splice(0, parsed.length, ...kept);
    }

    setRows(parsed);
    setRejected(rej);
    setError('');
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
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

  const inserts = (rows || []).filter(r => !r._match);
  const updates = (rows || []).filter(r => r._match && !r._noChanges);
  const skipped = (rows || []).filter(r => r._match && r._noChanges);
  // A new student can span several insert rows (one per sport/batch), so the
  // number of NEW STUDENTS is the count of unique groups, not insert rows.
  const newStudentCount = new Set(inserts.map(r => r._newGroupId)).size;

  const submit = async () => {
    const newEnrollmentNote = inserts.length !== newStudentCount ? ` (${inserts.length} enrollments)` : '';
    const summary = `This will import ${newStudentCount + updates.length} student${newStudentCount + updates.length === 1 ? '' : 's'}:\n\n` +
      `• New: ${newStudentCount}${newEnrollmentNote}\n• Update: ${updates.length}\n• Skip (no changes): ${skipped.length}\n• Rejected: ${rejected.length}\n\nContinue?`;
    if (!window.confirm(summary)) return;

    setSubmitting(true);
    const failures = [];
    if (inserts.length) {
      // Collapse insert rows down to one payload row per unique new-student
      // group — a student who appears in several rows (one per sport/batch)
      // must only be created once, not once per row.
      const groups = [];
      const seenGroupIds = new Set();
      for (const r of inserts) {
        if (seenGroupIds.has(r._newGroupId)) continue;
        seenGroupIds.add(r._newGroupId);
        groups.push(r._groupRef);
      }
      const payload = groups.map(g => ({
        academy_id: academyId, name: g.name, roll_no: g.rollNo,
        batch: buildBatchKey(g.sport, g.batchLabel), dob: g.dob || null, age: g.age || null, gender: g.gender || null,
        height: g.height || null, weight: g.weight || null, bmi: g.bmi || null, parent: g.parent || null,
        contact: g.contact || null, contact2: g.contact2 || null, school: g.school || null, address: g.address || null,
        join_date: g.joinDate,
      }));
      const { data: savedRows, error: insErr } = await supabase.from('students').insert(payload).select();
      if (insErr) {
        // A single duplicate roll number fails the WHOLE batch insert (it's
        // one statement) — surface that clearly rather than reporting success.
        failures.push(insErr.code === '23505'
          ? 'One or more new students have a roll number that already exists — none of the new students were added. Fix the roll number(s) and re-import.'
          : `New students not saved: ${insErr.message}`);
      } else if (savedRows) {
        // Map each new-student group to its saved DB id, then create one
        // enrollment per original row — so a student with several rows
        // (several sport/batch pairs) ends up with several enrollments
        // under the single student record just created for them.
        const idByGroupId = new Map();
        savedRows.forEach((row, i) => idByGroupId.set(groups[i].id, row.id));
        const enrollRows = inserts.map(r => ({
          academy_id: academyId, student_id: idByGroupId.get(r._newGroupId), sport: r.sport, batch: r.batchLabel,
          join_date: r.joinDate, active: true,
        }));
        // Plain insert, not upsert: the unique index on (student_id, sport,
        // batch) is partial — "WHERE active" — so Postgres has no matching
        // unique constraint for a plain ON CONFLICT target and the upsert
        // would fail. It's also unnecessary here: these students were just
        // created, so there's no existing row to conflict with.
        const { error: enrollErr } = await supabase.from('enrollments').insert(enrollRows);
        if (enrollErr) failures.push(`New students saved, but enrollments failed: ${enrollErr.message}`);
      }
    }
    for (const r of updates) {
      // Build the patch from only the fields THIS row actually has a value
      // for. A student can have several rows in one file (one per sport/
      // batch), and each row's blank fields fall back to `r._match` — a
      // snapshot taken BEFORE the import started, which doesn't know about
      // writes an earlier row in this same submit already made. Falling
      // back to that stale snapshot would re-write it and silently revert
      // whatever the earlier row just saved. Omitting the key entirely
      // instead leaves the column untouched in Postgres, so a blank cell
      // means "leave as is," never "revert to before this import."
      const patch = {};
      if (r.rollNo) patch.roll_no = r.rollNo;
      patch.batch = buildBatchKey(r.sport, r.batchLabel);
      if (r.contact) patch.contact = r.contact;
      if (r.contact2) patch.contact2 = r.contact2;
      if (r.address) patch.address = r.address;
      if (r.school) patch.school = r.school;
      if (r.gender) patch.gender = r.gender;
      if (r.height) patch.height = r.height;
      if (r.weight) patch.weight = r.weight;
      if (r.bmi) patch.bmi = r.bmi;

      const { error: updErr } = await supabase.from('students').update(patch).eq('id', r._match.id);
      if (updErr) {
        failures.push(`${r.name}: ${updErr.code === '23505' ? `roll number "${r.rollNo}" already in use` : updErr.message}`);
        continue;
      }
      // Only insert an enrollment when the student doesn't already have an
      // ACTIVE one for this sport/batch. `r._match.enrollments` only ever
      // surfaces active enrollments (see AcademyDataContext), so absence
      // here means either no enrollment exists yet, or only a past/ended
      // one does. Either way we insert a brand-new row rather than
      // resurrecting an old one — the DB enforces uniqueness only among
      // active rows (a partial index), so a fresh insert is always the
      // correct move and any old, ended row's left_date/end_reason is left
      // untouched as accurate history. Re-inserting when one is already
      // active would violate that index, so we guard against it here.
      const existingActiveEnrollments = r._match.enrollments && r._match.enrollments.length > 0
        ? r._match.enrollments : [{ sport: r._match.sport, batchLabel: r._match.batchLabel }];
      const alreadyActive = existingActiveEnrollments.some(en => en.sport === r.sport && en.batchLabel === r.batchLabel);
      if (!alreadyActive) {
        const { error: enrollErr } = await supabase.from('enrollments').insert({
          academy_id: academyId, student_id: r._match.id, sport: r.sport, batch: r.batchLabel,
          join_date: r.joinDate, active: true,
        });
        if (enrollErr) failures.push(`${r.name} (enrollment): ${enrollErr.message}`);
      }
    }
    setSubmitting(false);
    if (failures.length > 0) {
      // Report what actually failed rather than silently claiming success —
      // rows that did succeed are already saved, so refresh the list, but
      // keep the modal open so the user can see and fix the failures.
      setError(`Some rows didn't save:\n${failures.join('\n')}`);
      onImported();
      return;
    }
    onImported();
    onClose();
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,20,40,.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: 'var(--card)', width: '100%', maxWidth: 480, maxHeight: '85vh', borderRadius: 14, margin: '0 auto', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>⬆️ Import Students</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button className="btn btn-outline btn-sm" onClick={downloadTemplate}>📥 Download Template</button>

          <div>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray)', display: 'block', marginBottom: 6 }}>Choose file (.csv, .xlsx, .xls)</label>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="form-input" />
          </div>

          {error && <div style={{ fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.25)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-line' }}>⚠️ {error}</div>}

          {rows && (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--gray)' }}>New</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--green, #16a34a)' }}>{newStudentCount}</div>
                  {inserts.length !== newStudentCount && (
                    <div style={{ fontSize: 9.5, color: 'var(--gray)' }}>{inserts.length} enrollments</div>
                  )}
                </div>
                <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--gray)' }}>Update</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--accent2)' }}>{updates.length}</div>
                </div>
                <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--gray)' }}>Skip</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--gray)' }}>{skipped.length}</div>
                </div>
                <div className="card" style={{ flex: 1, padding: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--gray)' }}>Rejected</div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: '#dc2626' }}>{rejected.length}</div>
                </div>
              </div>

              {rejected.length > 0 && (
                <button className="btn btn-outline btn-sm" onClick={downloadRejected} style={{ alignSelf: 'flex-start' }}>
                  ⬇️ Export Rejected ({rejected.length}) to fix & re-upload
                </button>
              )}

              <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((r, i) => (
                  <div key={i} className="card" style={{ padding: 10, fontSize: 12.5 }}>
                    <strong>{r.name}</strong> · {r.rollNo} · {r.sport}/{r.batchLabel}{r.gender ? ` · ${r.gender}` : ''}{r.height ? ` · ${r.height}cm` : ''}{r.weight ? ` · ${r.weight}kg` : ''}{r.bmi ? ` · BMI ${r.bmi}` : ''}
                    <span style={{
                      float: 'right', fontWeight: 700,
                      color: r._noChanges ? 'var(--gray)' : r._match ? 'var(--accent2)' : 'var(--green, #16a34a)',
                    }}>
                      {r._noChanges ? 'Skip' : r._match ? 'Update' : (r._newGroupId !== null && !r._isGroupPrimary ? 'New · +enrollment' : 'New')}
                    </span>
                  </div>
                ))}
                {rejected.map((r, i) => (
                  <div key={'r' + i} className="card" style={{ padding: 10, fontSize: 12.5, opacity: .7 }}>
                    <strong>{r.label}</strong> — {r.reason}
                    <span style={{ float: 'right', fontWeight: 700, color: '#dc2626' }}>Skipped</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {rows && (inserts.length > 0 || updates.length > 0) && (
          <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--card2)' }}>
            <button className="btn btn-outline" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 1.4 }} onClick={submit} disabled={submitting}>
              {submitting ? 'Importing…' : `Import ${newStudentCount + updates.length} Students`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
