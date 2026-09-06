import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAcademyData } from '../context/AcademyDataContext';

// Uses the global `Chart` object loaded via CDN script tag in index.html:
// <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
// No npm install required.

const PRESENT_STATUS = 'P';
const BLUE = '#2563eb';
const SAPPHIRE = '#1d4ed8';
const TREND_ORANGE = '#f59e0b';
const TRACK = '#e2e8f0';

// distinct color per program bar, cycled if there are more programs than colors.
// falls back to a program's own `color` field if one is set on the record.
const PROGRAM_COLORS = ['#2563eb', '#f59e0b', '#22c55e', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#14b8a6'];
function colorForProgram(idx, pr) {
  return pr?.color || PROGRAM_COLORS[idx % PROGRAM_COLORS.length];
}

function bmiCategory(bmi) {
  if (bmi < 18.5) return { label: 'Underweight', color: '#f59e0b' };
  if (bmi < 25) return { label: 'Normal', color: '#22c55e' };
  if (bmi < 30) return { label: 'Overweight', color: '#f59e0b' };
  return { label: 'Obese', color: '#ef4444' };
}

// Local calendar date, not .toISOString() — a UTC conversion of local
// midnight silently rolls back a day in any timezone ahead of UTC (see the
// same fix already applied in scheduleUtils.js / AwardPointsModal.jsx).
function pad2(n) { return String(n).padStart(2, '0'); }
function toLocalDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayIsoLocal() { return toLocalDateStr(new Date()); }
function monthStartIsoLocal() { const d = new Date(); d.setDate(1); return toLocalDateStr(d); }

const TABS = [
  { key: 'points', label: '🏆 Points' },
  { key: 'attendance', label: '📆 Attendance' },
  { key: 'bmi', label: '⚖️ BMI' },
];

// centered-text plugin for doughnut/gauge charts
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart) {
    const opts = chart.config.options.plugins?.centerText;
    if (!opts) return;
    const { ctx, chartArea: { left, right, top, bottom } } = chart;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.fillStyle = opts.color || BLUE;
    ctx.fillText(opts.mainText, cx, cy - 8);
    ctx.font = '400 11px system-ui, sans-serif';
    ctx.fillStyle = '#888';
    ctx.fillText(opts.subText, cx, cy + 12);
    ctx.restore();
  },
};

// draws the numeric value above each bar top / line point
const valueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    if (!chart.config.options.plugins?.valueLabels) return;
    const { ctx } = chart;
    chart.data.datasets.forEach((ds, i) => {
      if (ds.hideLabels) return;
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      ctx.save();
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.fillStyle = ds.type === 'line' ? TREND_ORANGE : '#0369a1';
      ctx.textAlign = 'center';
      meta.data.forEach((el, idx) => {
        const val = ds.data[idx];
        if (val === null || val === undefined) return;
        ctx.fillText(`${val}${ds.valueSuffix || ''}`, el.x, el.y - 10);
      });
      ctx.restore();
    });
  },
};

function useChart(canvasRef, buildConfig, deps) {
  const chartRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || typeof window === 'undefined' || !window.Chart) return;
    const Chart = window.Chart;
    if (!Chart.registry.plugins.get('centerText')) Chart.register(centerTextPlugin);
    if (!Chart.registry.plugins.get('valueLabels')) Chart.register(valueLabelsPlugin);
    const config = buildConfig();
    if (!config) return;
    chartRef.current = new Chart(canvasRef.current.getContext('2d'), config);
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function StudentChartsModal({
  row, academyId, userId, userName, canEdit,
  totalPoints, earnedPoints, pointsRecords, challenges, programs,
  attendanceRecords, sportAttendanceRecords, onClose,
}) {
  const [tab, setTab] = useState('points');
  const [chartReady, setChartReady] = useState(typeof window !== 'undefined' && !!window.Chart);
  const { applyStudentSave } = useAcademyData();

  useEffect(() => {
    if (chartReady) return;
    const id = setInterval(() => {
      if (window.Chart) { setChartReady(true); clearInterval(id); }
    }, 150);
    return () => clearInterval(id);
  }, [chartReady]);

  // ---------- Points tab data ----------
  const challengeById = useMemo(() => {
    const m = {};
    challenges.forEach(c => { m[c.id] = c; });
    return m;
  }, [challenges]);

  const pointsList = useMemo(() => {
    return pointsRecords
      .filter(p => challengeById[p.challenge_id])
      .map(p => ({
        id: p.id,
        challengeName: challengeById[p.challenge_id]?.name || 'Challenge',
        points: Number(p.points_awarded || 0),
        date: p.awarded_at || p.created_at,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [pointsRecords, challengeById]);

  // entries (individual awards, all programs mixed) vs by-program (pick "All Programs" or
  // a single program to see its own award history/trend)
  const [pointsView, setPointsView] = useState('entries'); // 'entries' | 'cumulative'
  const [showProgramTrend, setShowProgramTrend] = useState(true);
  const [selectedProgramId, setSelectedProgramId] = useState(null); // 'ALL' | a program id
  const [entryCount, setEntryCount] = useState('3'); // 'all' | '3' | '5' | '10'
  const [expandedChart, setExpandedChart] = useState(false); // fullscreen rotated chart view

  const switchPointsView = (view) => setPointsView(view);

  // running total per program (all-time) — used for dropdown labels and summary lines.
  // Assumes each program_challenges row carries a `program_id` linking it back to the
  // programs table; if your schema names that column differently, swap it below.
  const programTotalsMap = useMemo(() => {
    const totals = {};
    pointsRecords.forEach(p => {
      const c = challengeById[p.challenge_id];
      if (!c || !c.program_id) return;
      totals[c.program_id] = (totals[c.program_id] || 0) + Number(p.points_awarded || 0);
    });
    return totals;
  }, [challengeById, pointsRecords]);

  // every configured challenge grouped under its program — powers the "(N challenges)"
  // count shown next to each program name and the expandable breakdown list.
  const challengesByProgram = useMemo(() => {
    const map = {};
    challenges.forEach(c => {
      if (!c.program_id) return;
      (map[c.program_id] = map[c.program_id] || []).push(c);
    });
    return map;
  }, [challenges]);

  // this student's earned points per individual challenge (summed across all awards)
  const earnedByChallenge = useMemo(() => {
    const m = {};
    pointsRecords.forEach(p => { m[p.challenge_id] = (m[p.challenge_id] || 0) + Number(p.points_awarded || 0); });
    return m;
  }, [pointsRecords]);

  // which programs currently have their challenge breakdown expanded — a Set so
  // more than one can be open at once, independent of chart controls above
  const [expandedProgramIds, setExpandedProgramIds] = useState(new Set());
  const toggleProgramExpand = (id) => {
    setExpandedProgramIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // default to "All Programs" once the list loads
  useEffect(() => {
    if (pointsView === 'cumulative' && !selectedProgramId && programs && programs.length > 0) {
      setSelectedProgramId('ALL');
    }
  }, [pointsView, programs, selectedProgramId]);

  const isAllPrograms = selectedProgramId === 'ALL';
  const selectedProgramIndex = (programs || []).findIndex(p => p.id === selectedProgramId);
  const selectedProgramObj = selectedProgramIndex >= 0 ? programs[selectedProgramIndex] : null;
  const selectedProgramColor = colorForProgram(selectedProgramIndex, selectedProgramObj);

  // one row per program with its all-time total — used for the "All Programs" overview chart
  const programTotalsList = useMemo(() => {
    return (programs || []).map(pr => ({ ...pr, total: programTotalsMap[pr.id] || 0 }));
  }, [programs, programTotalsMap]);

  // every individual award for the selected single program, oldest → newest
  const selectedProgramEntries = useMemo(() => {
    if (!selectedProgramId || isAllPrograms) return [];
    return pointsRecords
      .filter(p => challengeById[p.challenge_id]?.program_id === selectedProgramId)
      .map(p => ({
        id: p.id,
        challengeName: challengeById[p.challenge_id]?.name || 'Challenge',
        points: Number(p.points_awarded || 0),
        date: p.awarded_at || p.created_at,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [selectedProgramId, isAllPrograms, pointsRecords, challengeById]);

  // sliced down to the number of most-recent entries picked in the selector
  const displayedProgramEntries = useMemo(() => {
    if (entryCount === 'all') return selectedProgramEntries;
    const n = Number(entryCount);
    return selectedProgramEntries.slice(-n);
  }, [selectedProgramEntries, entryCount]);

  // current entry vs the one right before it, so you can see at a glance
  // whether the student's latest performance is trending up or down
  const programTrendDelta = useMemo(() => {
    const n = selectedProgramEntries.length;
    if (n < 2) return null;
    const current = selectedProgramEntries[n - 1];
    const previous = selectedProgramEntries[n - 2];
    return { current: current.points, previous: previous.points, delta: current.points - previous.points };
  }, [selectedProgramEntries]);

  // ---------- Attendance tab data ----------
  // Defaults to this month's start through today; end date can't go past
  // today since a session that hasn't happened yet can't be marked.
  const [attFrom, setAttFrom] = useState(monthStartIsoLocal());
  const [attTo, setAttTo] = useState(todayIsoLocal());

  // "Working days" = any date within range that ANY student in this sport
  // has an attendance row for — matches how PerformancePage's leaderboard
  // percentage is computed, so this chart's numbers agree with it instead
  // of using a different definition (this student's own rows) than before.
  const workingDaysList = useMemo(() => {
    const dates = new Set(
      (sportAttendanceRecords || [])
        .filter(a => a.date >= attFrom && a.date <= attTo)
        .map(a => a.date)
    );
    return Array.from(dates).sort();
  }, [sportAttendanceRecords, attFrom, attTo]);

  const presentDatesSet = useMemo(() => {
    const s = new Set();
    attendanceRecords
      .filter(a => a.date >= attFrom && a.date <= attTo)
      .forEach(a => { if ((a.status || '').toUpperCase() === PRESENT_STATUS) s.add(a.date); });
    return s;
  }, [attendanceRecords, attFrom, attTo]);

  const totalDays = workingDaysList.length;
  const presentDays = workingDaysList.filter(d => presentDatesSet.has(d)).length;
  const absentDays = Math.max(0, totalDays - presentDays);

  // ---------- BMI tab data ----------
  const [metrics, setMetrics] = useState([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [saving, setSaving] = useState(false);

  const loadMetrics = async () => {
    if (!academyId || !row?.student?.id) return;
    setLoadingMetrics(true);
    const { data, error } = await supabase
      .from('student_body_metrics')
      .select('*')
      .eq('academy_id', academyId)
      .eq('student_id', row.student.id)
      .order('recorded_at', { ascending: true });
    if (!error) setMetrics(data || []);
    setLoadingMetrics(false);
  };
  useEffect(() => { loadMetrics(); }, [academyId, row?.student?.id]); // eslint-disable-line

  const bmiSeries = useMemo(() => {
    return metrics.map(m => ({
      date: (m.recorded_at || '').slice(0, 10),
      heightCm: m.height_cm,
      weightKg: m.weight_kg,
      bmi: m.height_cm ? Number((m.weight_kg / Math.pow(m.height_cm / 100, 2)).toFixed(1)) : null,
    })).filter(m => m.bmi);
  }, [metrics]);

  const latest = bmiSeries[bmiSeries.length - 1];
  const latestCategory = latest ? bmiCategory(latest.bmi) : null;

  const saveMetric = async () => {
    const h = Number(height), w = Number(weight);
    if (!h || !w) { alert('Enter both height (cm) and weight (kg).'); return; }
    setSaving(true);
    const { error } = await supabase.from('student_body_metrics').insert({
      academy_id: academyId,
      student_id: row.student.id,
      height_cm: h,
      weight_kg: w,
      recorded_by_id: userId,
      recorded_by_name: userName,
      recorded_at: new Date().toISOString(),
    });
    if (error) { setSaving(false); alert('Failed to save: ' + error.message); return; }

    // students.height/weight/bmi is the current-value source of truth read
    // everywhere else (Student Details, exports, Edit Student form) —
    // student_body_metrics is history only, so keep this row in sync too.
    const currentBmi = Number((w / Math.pow(h / 100, 2)).toFixed(1));
    const { data: updatedStudent, error: studentErr } = await supabase
      .from('students')
      .update({ height: String(h), weight: String(w), bmi: String(currentBmi) })
      .eq('id', row.student.id)
      .select()
      .single();
    setSaving(false);
    if (studentErr) { alert('Saved to history, but failed to update the student record: ' + studentErr.message); return; }
    if (updatedStudent) applyStudentSave(updatedStudent); // merge immediately — don't wait on the realtime event

    setHeight(''); setWeight('');
    loadMetrics();
  };

  // ---------- chart instances ----------
  const pointsCanvasRef = useRef(null);
  const programEntriesCanvasRef = useRef(null);
  const attendanceCanvasRef = useRef(null);
  const bmiCanvasRef = useRef(null);

  // Points tab — ENTRIES view: bar chart (points per award) + a trend line drawn over the same values
  useChart(pointsCanvasRef, () => {
    if (tab !== 'points' || pointsView !== 'entries' || !chartReady || pointsList.length === 0) return null;
    const values = pointsList.map(p => p.points);
    return {
      data: {
        labels: pointsList.map(p => p.challengeName),
        datasets: [
          {
            type: 'bar',
            label: 'Points',
            data: values,
            backgroundColor: SAPPHIRE,
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 44,
            order: 2,
            hideLabels: true,
          },
          {
            type: 'line',
            label: 'Trend',
            data: values,
            borderColor: TREND_ORANGE,
            backgroundColor: TREND_ORANGE,
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: TREND_ORANGE,
            tension: 0.35,
            order: 1,
          },
        ],
      },
      options: {
        animation: { duration: 900, easing: 'easeOutCubic' },
        layout: { padding: { top: 20 } },
        plugins: { legend: { display: false }, valueLabels: true },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
          y: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#64748b' } },
        },
      },
    };
  }, [tab, pointsView, chartReady, pointsList]);

  // Points tab — BY PROGRAM view: either an "All Programs" totals overview
  // (one bar per program, tap to drill into it) or, for a single selected
  // program, one bar per individual award entry (so 5 awards = 5 bars).
  useChart(programEntriesCanvasRef, () => {
    if (tab !== 'points' || pointsView !== 'cumulative' || !chartReady) return null;

    if (isAllPrograms) {
      if (programTotalsList.length === 0) return null;
      const values = programTotalsList.map(p => p.total);
      const colors = programTotalsList.map((p, i) => colorForProgram(i, p));
      const datasets = [
        {
          type: 'bar',
          label: 'Points',
          data: values,
          backgroundColor: colors,
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 44,
          order: 2,
          hideLabels: true,
        },
      ];
      if (showProgramTrend) {
        datasets.push({
          type: 'line', label: 'Trend', data: values,
          borderColor: TREND_ORANGE, backgroundColor: TREND_ORANGE, borderWidth: 2,
          pointRadius: 4, pointBackgroundColor: TREND_ORANGE, tension: 0.35, order: 1,
        });
      }
      return {
        data: { labels: programTotalsList.map(p => p.name), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 900, easing: 'easeOutCubic' },
          layout: { padding: { top: 20 } },
          plugins: { legend: { display: false }, valueLabels: true },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
            y: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#64748b' } },
          },
          onClick: (evt, elements) => {
            if (!elements.length) return;
            const pr = programTotalsList[elements[0].index];
            if (pr) setSelectedProgramId(pr.id);
          },
        },
      };
    }

    if (displayedProgramEntries.length === 0) return null;
    const values = displayedProgramEntries.map(e => e.points);
    const datasets = [
      {
        type: 'bar',
        label: 'Points',
        data: values,
        backgroundColor: selectedProgramColor,
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 44,
        order: 2,
        hideLabels: true,
      },
    ];
    if (showProgramTrend) {
      datasets.push({
        type: 'line',
        label: 'Trend',
        data: values,
        borderColor: TREND_ORANGE,
        backgroundColor: TREND_ORANGE,
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: TREND_ORANGE,
        tension: 0.35,
        order: 1,
      });
    }
    return {
      data: { labels: displayedProgramEntries.map(e => (e.date || '').slice(0, 10)), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeOutCubic' },
        layout: { padding: { top: 20 } },
        plugins: { legend: { display: false }, valueLabels: true },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
          y: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#64748b' } },
        },
      },
    };
  }, [tab, pointsView, chartReady, isAllPrograms, programTotalsList, displayedProgramEntries, showProgramTrend, selectedProgramColor, expandedChart]);

  // Attendance tab — full pie chart, present vs absent
  useChart(attendanceCanvasRef, () => {
    if (tab !== 'attendance' || !chartReady) return null;
    return {
      type: 'pie',
      data: {
        labels: ['Present', 'Absent'],
        datasets: [{ data: [presentDays, absentDays], backgroundColor: [BLUE, TRACK], borderWidth: 0 }],
      },
      options: {
        animation: { animateRotate: true, duration: 900, easing: 'easeOutCubic' },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 12 } } },
          tooltip: { enabled: true },
        },
      },
    };
  }, [tab, chartReady, presentDays, absentDays]);

  // BMI tab — bar chart (BMI per recorded entry) + a trend line drawn over the same values
  useChart(bmiCanvasRef, () => {
    if (tab !== 'bmi' || !chartReady || bmiSeries.length === 0) return null;
    const values = bmiSeries.map(m => m.bmi);
    return {
      data: {
        labels: bmiSeries.map(m => m.date),
        datasets: [
          {
            type: 'bar',
            label: 'BMI',
            data: values,
            backgroundColor: SAPPHIRE,
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 44,
            order: 2,
            hideLabels: true,
          },
          {
            type: 'line',
            label: 'Trend',
            data: values,
            borderColor: TREND_ORANGE,
            backgroundColor: TREND_ORANGE,
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: TREND_ORANGE,
            tension: 0.35,
            order: 1,
          },
        ],
      },
      options: {
        animation: { duration: 900, easing: 'easeOutCubic' },
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { display: false },
          valueLabels: true,
          tooltip: {
            enabled: true,
            displayColors: false,
            callbacks: {
              title: (items) => bmiSeries[items[0]?.dataIndex]?.date || '',
              label: (item) => {
                const m = bmiSeries[item.dataIndex];
                if (!m) return '';
                return [`Height: ${m.heightCm} cm`, `Weight: ${m.weightKg} kg`, `BMI: ${m.bmi}`];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#64748b' } },
          y: { grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#64748b' } },
        },
      },
    };
  }, [tab, chartReady, bmiSeries]);

  // shared collapsible "Program (N challenges)" list — click a program to expand
  // and see every challenge under it with this student's points. Used under both
  // the Points Given and By Program sub-views so the breakdown is consistent.
  const renderProgramList = () => (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 6 }}>PROGRAMS</div>
      {(programs || []).map((pr, i) => {
        const progChallenges = challengesByProgram[pr.id] || [];
        const isOpen = expandedProgramIds.has(pr.id);
        const dotColor = colorForProgram(i, pr);
        return (
          <div key={pr.id} style={{ marginBottom: 6 }}>
            <div
              onClick={() => toggleProgramExpand(pr.id)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 12px', borderRadius: 10, background: 'var(--card2)', cursor: 'pointer',
                border: `1px solid ${dotColor}`,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                {pr.name}
                <span style={{ color: 'var(--gray)', fontWeight: 400, fontSize: 11 }}>
                  ({progChallenges.length} challenge{progChallenges.length === 1 ? '' : 's'})
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <b style={{ color: BLUE, fontSize: 13 }}>{programTotalsMap[pr.id] || 0} pts</b>
                <span style={{ color: 'var(--gray)', fontSize: 11 }}>{isOpen ? '▲' : '▼'}</span>
              </span>
            </div>

            {isOpen && (
              <div style={{ marginTop: 4 }}>
                {progChallenges.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 12 }}>No challenges configured for this program.</div>
                ) : progChallenges.map(c => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px 8px 14px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                    <span>{c.name}</span>
                    <b style={{ color: earnedByChallenge[c.id] ? BLUE : 'var(--gray)' }}>{earnedByChallenge[c.id] || 0} pts</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
    {/* fullscreen rotated chart view — like a trading-app landscape chart.
        Rotates a viewport-sized box via CSS transform (no real device orientation
        change / permission needed) and re-hosts the SAME canvas node so the chart
        just resizes into it. */}
    {expandedChart && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--bg, #0b0f14)' }}>
        <div
          style={{
            position: 'fixed', top: '50%', left: '50%',
            width: '100vh', height: '100vw',
            transform: 'translate(-50%, -50%) rotate(90deg)',
            display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--offwhite)' }}>
              {isAllPrograms ? 'All Programs' : selectedProgramObj?.name}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--gray)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showProgramTrend} onChange={e => setShowProgramTrend(e.target.checked)} />
                Trend
              </label>
              <button onClick={() => setExpandedChart(false)} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--gray)', cursor: 'pointer', padding: 4 }}>✕</button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <canvas ref={programEntriesCanvasRef} />
          </div>
        </div>
      </div>
    )}
    {/* Rendered in-flow as the page content (swapped in by the parent) instead of a
    // fixed overlay — keeps a single scroll container with the rest of the app.
    */}
    <div style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--gray)', cursor: 'pointer', padding: 4 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{row.student.name}</div>
          <div style={{ fontSize: 11, color: 'var(--gray)' }}>{row.sport} · {row.batchLabel}</div>
        </div>
      </div>

      {!chartReady && (
        <div style={{ fontSize: 11, color: '#f59e0b', background: '#f59e0b1a', padding: '6px 10px', borderRadius: 6, marginBottom: 10 }}>
          Loading chart engine… if this doesn't clear, make sure the Chart.js script tag is added to index.html.
        </div>
      )}

      {/* tabs — always a single row */}
      <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 6, marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: '1 1 0', fontSize: 11, padding: '8px 4px', whiteSpace: 'nowrap' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 16, borderRadius: 14 }}>

        {/* ---------- POINTS ---------- */}
        {tab === 'points' && (
          <div>
            {/* entries vs cumulative-by-program toggle */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button
                onClick={() => switchPointsView('entries')}
                className={`btn btn-sm ${pointsView === 'entries' ? 'btn-primary' : 'btn-outline'}`}
                style={{ flex: 1, fontSize: 11, padding: '7px 4px' }}
              >
                Points Given
              </button>
              <button
                onClick={() => switchPointsView('cumulative')}
                className={`btn btn-sm ${pointsView === 'cumulative' ? 'btn-primary' : 'btn-outline'}`}
                style={{ flex: 1, fontSize: 11, padding: '7px 4px' }}
              >
                By Program (Cumulative)
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: SAPPHIRE }}>{earnedPoints}</div>
              <div style={{ fontSize: 12, color: 'var(--gray)' }}>of {totalPoints} pts</div>
            </div>

            {/* ---------- ENTRIES sub-view ---------- */}
            {pointsView === 'entries' && (
              <>
                {pointsList.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 20 }}>No points awarded yet.</div>
                ) : (
                  <div style={{ height: 220 }}>
                    <canvas ref={pointsCanvasRef} />
                  </div>
                )}

                {renderProgramList()}
              </>
            )}

            {/* ---------- BY PROGRAM sub-view ---------- */}
            {pointsView === 'cumulative' && (
              <>
                {!programs || programs.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 20 }}>No programs set up for this sport yet.</div>
                ) : (
                  <>
                    {/* controls row: program select (All Programs + each program) + entry count — sit at the top */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <select
                        value={selectedProgramId || ''}
                        onChange={e => setSelectedProgramId(e.target.value)}
                        className="form-input"
                        style={{ flex: 1.4, fontSize: 12, padding: '7px 8px' }}
                      >
                        <option value="ALL">All Programs</option>
                        {programs.map(pr => (
                          <option key={pr.id} value={pr.id}>
                            {pr.name} ({programTotalsMap[pr.id] || 0} pts)
                          </option>
                        ))}
                      </select>
                      {!isAllPrograms && (
                        <select
                          value={entryCount}
                          onChange={e => setEntryCount(e.target.value)}
                          className="form-input"
                          style={{ flex: 1, fontSize: 12, padding: '7px 8px' }}
                        >
                          <option value="all">All entries</option>
                          <option value="3">Last 3</option>
                          <option value="5">Last 5</option>
                          <option value="10">Last 10</option>
                        </select>
                      )}
                    </div>

                    {/* trend line toggle — sits above the chart */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gray)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={showProgramTrend} onChange={e => setShowProgramTrend(e.target.checked)} />
                        Trend line
                      </label>
                    </div>

                    {(isAllPrograms ? programTotalsList.length === 0 : selectedProgramEntries.length === 0) ? (
                      <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 20 }}>
                        {isAllPrograms ? 'No programs set up for this sport yet.' : 'No points awarded in this program yet.'}
                      </div>
                    ) : (
                      <>
                        {/* chart card header: name/total on the left, expand icon on the right */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                            {isAllPrograms ? (
                              'All Programs'
                            ) : (
                              <>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: selectedProgramColor, display: 'inline-block' }} />
                                {selectedProgramObj?.name}
                                <span style={{ color: 'var(--gray)', fontWeight: 400 }}>· {programTotalsMap[selectedProgramId] || 0} pts total</span>
                              </>
                            )}
                          </span>
                          <button
                            onClick={() => setExpandedChart(true)}
                            title="Expand fullscreen"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--gray)', padding: 4 }}
                          >
                            ⤢
                          </button>
                        </div>

                        {!expandedChart && (
                          <div style={{ height: 220 }}>
                            <canvas ref={programEntriesCanvasRef} />
                          </div>
                        )}

                        {isAllPrograms ? (
                          <div style={{ fontSize: 10, color: 'var(--gray)', textAlign: 'center', marginTop: 4 }}>Tap a bar to drill into that program</div>
                        ) : (
                          <>
                            {/* current vs previous entry — quick read on whether performance is trending up or down */}
                            {programTrendDelta && (
                              <div style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10,
                                fontSize: 12, fontWeight: 700,
                                color: programTrendDelta.delta > 0 ? '#22c55e' : programTrendDelta.delta < 0 ? '#ef4444' : 'var(--gray)',
                              }}>
                                {programTrendDelta.delta > 0 ? '▲' : programTrendDelta.delta < 0 ? '▼' : '–'}
                                {' '}{Math.abs(programTrendDelta.delta)} pts vs previous entry
                                <span style={{ color: 'var(--gray)', fontWeight: 400 }}>
                                  ({programTrendDelta.previous} → {programTrendDelta.current})
                                </span>
                              </div>
                            )}

                            {/* chronological list of what's currently plotted, most recent first */}
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', margin: '14px 0 6px' }}>ENTRIES SHOWN</div>
                            {displayedProgramEntries.slice().reverse().map(e => (
                              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                                <span>{e.challengeName}</span>
                                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                  <span style={{ color: 'var(--gray)', fontSize: 10 }}>{(e.date || '').slice(0, 10)}</span>
                                  <b style={{ color: BLUE }}>+{e.points}</b>
                                </span>
                              </div>
                            ))}
                          </>
                        )}
                      </>
                    )}

                    {renderProgramList()}
                  </>
                )}
              </>
            )}
          </div>
        )}


        {/* ---------- ATTENDANCE (full pie) ---------- */}
        {tab === 'attendance' && (
          <div>
            {/* date range filter — defaults to this month's start through today */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14 }}>
              <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }}
                value={attFrom} max={attTo}
                onChange={e => setAttFrom(e.target.value)} />
              <span style={{ fontSize: 11, color: 'var(--gray)' }}>–</span>
              <input type="date" className="form-input" style={{ flex: 1, fontSize: 11, padding: '7px 6px' }}
                value={attTo} max={todayIsoLocal()}
                onChange={e => setAttTo(e.target.value > todayIsoLocal() ? todayIsoLocal() : e.target.value)} />
            </div>

            <div style={{ height: 240, maxWidth: 280, margin: '0 auto' }}>
              <canvas ref={attendanceCanvasRef} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', marginTop: 8 }}>
              {presentDays} of {totalDays} days present
            </div>

            {/* every working day in range, with this student's status —
                newest first so the most relevant/recent gaps are on top */}
            {workingDaysList.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray)', marginBottom: 6 }}>WORKING DAYS</div>
                {workingDaysList.slice().reverse().map(date => {
                  const present = presentDatesSet.has(date);
                  return (
                    <div key={date} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
                      <span>{date}</span>
                      <span style={{ fontWeight: 700, color: present ? '#22c55e' : '#ef4444' }}>
                        {present ? 'Present' : 'Absent'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', marginTop: 16 }}>
                No sessions recorded for {row.sport} in this date range.
              </div>
            )}
          </div>
        )}

        {/* ---------- BMI (bar + trend line) ---------- */}
        {tab === 'bmi' && (
          <div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <input type="number" placeholder="Height (cm)" className="form-input" style={{ flex: 1, minWidth: 100, fontSize: 12, padding: '8px' }}
                  value={height} onChange={e => setHeight(e.target.value)} />
                <input type="number" placeholder="Weight (kg)" className="form-input" style={{ flex: 1, minWidth: 100, fontSize: 12, padding: '8px' }}
                  value={weight} onChange={e => setWeight(e.target.value)} />
                <button className="btn btn-primary btn-sm" onClick={saveMetric} disabled={saving}>
                  {saving ? '...' : 'Add'}
                </button>
              </div>
            )}

            {loadingMetrics && <div style={{ textAlign: 'center', color: 'var(--gray)', padding: 10 }}>Loading…</div>}

            {!loadingMetrics && bmiSeries.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: 12 }}>No height/weight recorded yet.</div>
            )}

            {!loadingMetrics && bmiSeries.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, justifyContent: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: BLUE }}>{latest.bmi}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: latestCategory.color }}>{latestCategory.label}</div>
                </div>
                <div style={{ height: 220 }}>
                  <canvas ref={bmiCanvasRef} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
