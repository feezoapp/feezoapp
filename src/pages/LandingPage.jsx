import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';

// Mirrors the `plans` table in Supabase. Update here if pricing changes,
// or swap this for a live fetch from Supabase once the marketing site
// needs to stay in sync automatically.
const PLANS = [
  {
    code: 'basic', name: 'Basic', tagline: 'Replace your spreadsheet',
    description: 'Perfect for small academies just getting started',
    price_monthly: 499, price_annual: 4999, recommended: false,
    limits: { students: 50, staff: 2 },
    features: ['Attendance tracking', 'Manual fee tracking', 'Up to 2 sports, 4 batches', '7-day history snapshots'],
  },
  {
    code: 'pro', name: 'Pro', tagline: 'Run your academy professionally',
    description: 'Everything you need to manage a thriving academy',
    price_monthly: 1499, price_annual: 14999, recommended: true,
    limits: { students: 250, staff: 4 },
    features: ['Attendance & manual fee tracking', 'WhatsApp & SMS reminders', 'Bulk import / export', 'PDF & Excel reports', 'Enquiry & class log', 'Activity log', '15-day history snapshots'],
  },
  {
    code: 'premium', name: 'Premium', tagline: 'Scale across branches & coaches',
    description: 'For multi-branch academies and professional sports businesses',
    price_monthly: 2999, price_annual: 29999, recommended: false,
    limits: { students: null, staff: 20 },
    features: ['Everything in Pro', 'Performance & leaderboards', 'Staff scheduling & leave management', 'Custom branding & domain', 'Unlimited history snapshots', 'Priority WhatsApp + phone support'],
  },
];

const FAQS = [
  { q: 'Do I need a card to start the free trial?', a: 'No. You can set up your academy, add students, and try attendance and fee tracking before you pay anything.' },
  { q: 'Can I switch plans later?', a: 'Yes. Upgrade or downgrade any time from your dashboard — your students, attendance history, and fee records carry over.' },
  { q: 'What happens if I go over my student limit?', a: "We'll let you know before you hit the ceiling, so you can move to a plan that fits before it affects your day-to-day." },
  { q: 'Is my academy\u2019s data safe if I stop using FeeZo?', a: 'You can export your attendance, fees, and student records to Excel or PDF at any time — your data isn\u2019t locked in.' },
];

const WEEK_ATTENDANCE = [58, 72, 64, 81, 69, 90, 92];

function money(n) { return '₹' + n.toLocaleString('en-IN'); }
function fmtLimit(n, singular) { return n === null ? `Unlimited ${singular}s` : `Up to ${n} ${singular}${n === 1 ? '' : 's'}`; }

function BrandMark() {
  return (
    <svg viewBox="0 0 48 46" fill="none">
      <path fill="#fff" d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
    </svg>
  );
}

function CountUp({ value, prefix = '', suffix = '', formatIN = false, start }) {
  const [display, setDisplay] = useState(0);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!start) return;
    if (reduced) { setDisplay(value); return; }
    const dur = 1200;
    const t0 = performance.now();
    let raf;
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.floor(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const shown = formatIN ? display.toLocaleString('en-IN') : display;
  return <>{prefix}{shown}{suffix}</>;
}

// Fades + slides an element up once it scrolls into view. Falls back to
// already-visible for prefers-reduced-motion (handled in CSS).
function Reveal({ as: Tag = 'div', className = '', children, ...rest }) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); io.disconnect(); } },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={`lp-sr${inView ? ' lp-sr-in' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export default function LandingPage() {
  const [annual, setAnnual] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [countStart, setCountStart] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // JetBrains Mono isn't loaded by index.html — inject it once for the scoreboard digits.
    if (!document.getElementById('lp-font-mono')) {
      const link = document.createElement('link');
      link.id = 'lp-font-mono';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&display=swap';
      document.head.appendChild(link);
    }
    const t = setTimeout(() => setCountStart(true), 300);

    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); window.removeEventListener('scroll', onScroll); };
  }, []);

  return (
    <div className="feezo-landing">
      <header className={`lp-header${scrolled ? ' lp-scrolled' : ''}`}>
        <nav className="lp-wrap lp-nav">
          <div className="lp-brand">
            <span className="lp-brand-mark"><BrandMark /></span>
            FeeZo
          </div>
          <div className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="lp-nav-cta">
            <Link to="/home" className="lp-btn lp-btn-primary lp-btn-sm">Log in</Link>
            <button className="lp-burger" aria-label="Menu" onClick={() => setMobileOpen(v => !v)}>
              <i className="ti ti-menu-2" />
            </button>
          </div>
        </nav>
        <div className={`lp-mobile-panel${mobileOpen ? ' lp-open' : ''}`}>
          <a href="#features" onClick={() => setMobileOpen(false)}>Features</a>
          <a href="#how" onClick={() => setMobileOpen(false)}>How it works</a>
          <a href="#pricing" onClick={() => setMobileOpen(false)}>Pricing</a>
          <a href="#faq" onClick={() => setMobileOpen(false)}>FAQ</a>
          <Link to="/home" onClick={() => setMobileOpen(false)}>Log in</Link>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-flood lp-f1" />
        <div className="lp-flood lp-f2" />
        <div className="lp-wrap lp-hero-grid">
          <div>
            <span className="lp-eyebrow lp-reveal lp-d1">For sports academies &amp; coaches</span>
            <h1 className="lp-reveal lp-d2">Replace the spreadsheet.<br />Keep the <span>trophy count.</span></h1>
            <p className="lp-lead lp-reveal lp-d3">FeeZo tracks attendance, fees, and performance for cricket, swimming, badminton and every other academy — so coaches coach, and owners stop chasing receipts on WhatsApp.</p>
            <div className="lp-hero-actions lp-reveal lp-d4">
              <Link to="/signup" className="lp-btn lp-btn-primary">Start free trial <i className="ti ti-arrow-right" /></Link>
              <a href="#pricing" className="lp-btn lp-btn-ghost">See pricing</a>
            </div>
            <div className="lp-hero-note lp-reveal lp-d4"><i className="ti ti-shield-check" /> No card needed to try &nbsp;&middot;&nbsp; Set up an academy in under 10 minutes</div>
          </div>
          <div>
            <div className="lp-mock">
              <span className="lp-mock-tag">Today, 6:42 PM</span>
              <div className="lp-mock-bar">
                <span className="lp-mock-dot" /><span className="lp-mock-dot" /><span className="lp-mock-dot" />
                <span className="lp-mock-url">app.feezo.in/home</span>
              </div>
              <div className="lp-board">
                <div className="lp-board-top">
                  <div className="lp-board-academy">
                    <span className="lp-board-avatar" />
                    <div><strong>Riverside Sports Academy</strong><span>Cricket &middot; Swimming &middot; Badminton</span></div>
                  </div>
                  <span className="lp-live">LIVE</span>
                </div>
                <div className="lp-board-stats">
                  <div className="lp-stat-tile lp-s1"><b><CountUp value={214} start={countStart} /></b><span>Students</span></div>
                  <div className="lp-stat-tile lp-s2"><b><CountUp value={92} suffix="%" start={countStart} /></b><span>Attendance</span></div>
                  <div className="lp-stat-tile lp-s3"><b><CountUp value={184200} prefix="₹" formatIN start={countStart} /></b><span>Fees today</span></div>
                </div>
                <div className="lp-board-chart">
                  {WEEK_ATTENDANCE.map((v, i) => (
                    <i key={i} style={{ height: `${(v / 100) * 48}px`, animationDelay: `${0.5 + i * 0.06}s` }} />
                  ))}
                </div>
                <div className="lp-board-foot">
                  <div className="lp-lead-chip"><span className="lp-medal">{'🥇'}</span> Top scorer this week: Aditya R.</div>
                  <small>+18 this month</small>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-strip">
        <div className="lp-wrap">
          <span>Cricket academies</span><span>&middot;</span><span>Swimming clubs</span><span>&middot;</span><span>Badminton coaching</span><span>&middot;</span><span>Football schools</span><span>&middot;</span><span>Multi-branch academies</span>
        </div>
      </div>

      <section id="features">
        <div className="lp-wrap">
          <Reveal className="lp-sec-head">
            <span className="lp-eyebrow">Features</span>
            <h2>Everything your academy already does &mdash; just faster.</h2>
            <p>Built around the parts of running an academy that eat your evenings: attendance registers, fee follow-ups, and figuring out who's actually improving.</p>
          </Reveal>
          <div className="lp-feat-grid">
            {[
              {
                ic: 'lp-ic1', icon: 'ti-checkbox', title: 'Attendance in one tap',
                body: 'Mark a whole batch present or absent in seconds, with a locked daily record so nothing gets edited after the fact.',
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span>Morning batch</span><span className="lp-mini-chip lp-ok"><i className="ti ti-check" style={{ fontSize: 11 }} />18/20</span></div>
                    <div className="lp-mini-row"><span>Evening batch</span><span className="lp-mini-chip lp-ok"><i className="ti ti-check" style={{ fontSize: 11 }} />22/24</span></div>
                  </div>
                ),
              },
              {
                ic: 'lp-ic2', icon: 'ti-cash', title: 'Fees without the follow-up',
                body: "See who's paid, who's due, and send a WhatsApp reminder from the same screen \u2014 no separate ledger book.",
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span>Aarav K.</span><span className="lp-mini-chip lp-ok">Paid</span></div>
                    <div className="lp-mini-row"><span>Diya S.</span><span className="lp-mini-chip lp-due">Due ₹1,200</span></div>
                  </div>
                ),
              },
              {
                ic: 'lp-ic3', icon: 'ti-trophy', title: 'Performance & leaderboards',
                body: "Score students on points and attendance, and let a weighted leaderboard show who's putting in the work.",
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span>{'🥇'} Aditya R.</span><div className="lp-mini-bar"><i style={{ width: '92%', background: 'linear-gradient(90deg,#FFB020,#F59E0B)' }} /></div></div>
                    <div className="lp-mini-row"><span>{'🥈'} Meera V.</span><div className="lp-mini-bar"><i style={{ width: '81%', background: 'linear-gradient(90deg,#8E52FF,#6D28D9)' }} /></div></div>
                  </div>
                ),
              },
              {
                ic: 'lp-ic4', icon: 'ti-calendar-time', title: 'Staff scheduling & leave',
                body: 'Build weekly coach schedules and handle leave requests with a simple admin approval flow.',
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span>Coach Ravi</span><span className="lp-mini-chip lp-ok">On duty</span></div>
                    <div className="lp-mini-row"><span>Coach Sana</span><span className="lp-mini-chip lp-due">On leave</span></div>
                  </div>
                ),
              },
              {
                ic: 'lp-ic5', icon: 'ti-file-report', title: 'Reports that export',
                body: 'Pull PDF and Excel reports for attendance, fees, and enquiries whenever a parent \u2014 or a branch owner \u2014 asks.',
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span><i className="ti ti-file-type-pdf" style={{ marginRight: 6 }} />Fees_August.pdf</span><span style={{ color: 'var(--lp-ink-faint)' }}>2.1 MB</span></div>
                    <div className="lp-mini-row"><span><i className="ti ti-file-spreadsheet" style={{ marginRight: 6 }} />Attendance.xlsx</span><span style={{ color: 'var(--lp-ink-faint)' }}>640 KB</span></div>
                  </div>
                ),
              },
              {
                ic: 'lp-ic6', icon: 'ti-building-skyscraper', title: 'Built for multiple branches',
                body: 'Run one academy or ten, each with its own students, staff, and sports, from a single login.',
                mini: (
                  <div className="lp-mini">
                    <div className="lp-mini-row"><span>Coimbatore Branch</span><span className="lp-mini-chip lp-ok">Active</span></div>
                    <div className="lp-mini-row"><span>Chennai Branch</span><span className="lp-mini-chip lp-ok">Active</span></div>
                  </div>
                ),
              },
            ].map((f, i) => (
              <Reveal className="lp-feat-card" key={f.title} style={{ transitionDelay: `${(i % 3) * 0.08}s` }}>
                <div className={`lp-feat-icon ${f.ic}`}><i className={`ti ${f.icon}`} /></div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                {f.mini}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section id="how" style={{ background: 'var(--lp-panel)', borderTop: '1px solid var(--lp-border)', borderBottom: '1px solid var(--lp-border)' }}>
        <div className="lp-wrap">
          <Reveal as="div" className="lp-sec-head lp-center" style={{ marginBottom: 64 }}>
            <span className="lp-eyebrow">How it works</span>
            <h2>Up and running before your next session.</h2>
          </Reveal>
          <div className="lp-steps">
            <Reveal as="div" className="lp-step">
              <div className="lp-step-num">01</div>
              <h3>Set up your academy</h3>
              <p>Add your sports, batches, and students &mdash; import from a spreadsheet if you've already got one.</p>
            </Reveal>
            <Reveal as="div" className="lp-step" style={{ transitionDelay: '.1s' }}>
              <div className="lp-step-num">02</div>
              <h3>Run your day</h3>
              <p>Mark attendance, log fees, and note enquiries as they happen, from your phone or the front desk.</p>
            </Reveal>
            <Reveal as="div" className="lp-step" style={{ transitionDelay: '.2s' }}>
              <div className="lp-step-num">03</div>
              <h3>Watch it add up</h3>
              <p>Attendance streaks, fee collection, and leaderboards update themselves &mdash; no month-end scramble.</p>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="pricing" className="lp-pricing">
        <div className="lp-wrap">
          <Reveal className="lp-sec-head lp-center">
            <span className="lp-eyebrow">Pricing</span>
            <h2>One plan for every stage of your academy.</h2>
            <p>Start small and upgrade as you add batches, branches, and coaches. All prices in INR, plus GST.</p>
          </Reveal>
          <div className="lp-toggle-wrap">
            <span className={`lp-toggle-label${!annual ? ' lp-active' : ''}`}>Monthly</span>
            <button
              className={`lp-toggle${annual ? ' lp-on' : ''}`}
              aria-label="Toggle annual billing"
              onClick={() => setAnnual(v => !v)}
            >
              <span className="lp-knob" />
            </button>
            <span className={`lp-toggle-label${annual ? ' lp-active' : ''}`}>Annual</span>
            <span className="lp-save-badge">Save up to 17%</span>
          </div>
          <div className="lp-plans">
            {PLANS.map((p, i) => {
              const price = annual ? p.price_annual : p.price_monthly;
              const period = annual ? '/year' : '/month';
              const equivMonthly = annual ? Math.round(p.price_annual / 12) : null;
              const fullYear = p.price_monthly * 12;
              const savePct = annual ? Math.round((1 - p.price_annual / fullYear) * 100) : 0;
              return (
                <Reveal as="div" className={`lp-plan${p.recommended ? ' lp-reco' : ''}`} key={p.code} style={{ transitionDelay: `${i * 0.08}s` }}>
                  {p.recommended && <span className="lp-plan-badge">Most popular</span>}
                  <div className="lp-plan-name">{p.name}</div>
                  <div className="lp-plan-tagline">{p.tagline}</div>
                  <div className="lp-plan-price"><b>{money(price)}</b><span>{period}</span></div>
                  <div className="lp-plan-equiv">
                    {annual ? `\u2248 ${money(equivMonthly)}/mo \u00b7 save ${savePct}% vs monthly` : '\u00A0'}
                  </div>
                  <div className="lp-plan-desc">{p.description}</div>
                  <ul className="lp-plan-feat">
                    <li><i className="ti ti-users" /> {fmtLimit(p.limits.students, 'student')}</li>
                    <li><i className="ti ti-id-badge-2" /> {fmtLimit(p.limits.staff, 'staff member')}</li>
                    {p.features.map((f) => <li key={f}><i className="ti ti-check" /> {f}</li>)}
                  </ul>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section id="faq">
        <div className="lp-wrap">
          <Reveal className="lp-sec-head lp-center">
            <span className="lp-eyebrow">FAQ</span>
            <h2>Questions academy owners ask</h2>
          </Reveal>
          <Reveal as="div" className="lp-faq">
            {FAQS.map((f, i) => (
              <div className={`lp-faq-item${openFaq === i ? ' lp-open' : ''}`} key={f.q}>
                <div className="lp-faq-q" onClick={() => setOpenFaq(openFaq === i ? -1 : i)}>
                  {f.q} <i className="ti ti-plus" />
                </div>
                <div className="lp-faq-a">{f.a}</div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section style={{ paddingTop: 0 }}>
        <Reveal as="div" className="lp-cta-band">
          <h2>Ready to ditch the spreadsheet?</h2>
          <p>Set up your academy in the time it takes to plan tomorrow's session.</p>
          <div className="lp-cta-actions">
            <Link to="/signup" className="lp-btn lp-btn-dark">Start free trial</Link>
            <a href="#pricing" className="lp-btn lp-btn-outline-lt">Compare plans</a>
          </div>
        </Reveal>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-foot-grid">
            <div className="lp-foot-brand">
              <div className="lp-brand">
                <span className="lp-brand-mark"><BrandMark /></span>
                FeeZo
              </div>
              <p>Attendance, fees, and performance tracking for sports academies &mdash; built to replace the spreadsheet, not add to it.</p>
            </div>
            <div className="lp-foot-col">
              <h4>Product</h4>
              <a href="#features">Features</a>
              <a href="#pricing">Pricing</a>
              <a href="#how">How it works</a>
            </div>
            <div className="lp-foot-col">
              <h4>Company</h4>
              <a href="#">About</a>
              <a href="#">Contact</a>
            </div>
            <div className="lp-foot-col">
              <h4>Legal</h4>
              <a href="#">Privacy policy</a>
              <a href="#">Terms of service</a>
            </div>
          </div>
          <div className="lp-foot-bottom">
            <span>&copy; 2026 FeeZo. All rights reserved.</span>
            <span>Made for academies that would rather be on the field.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
