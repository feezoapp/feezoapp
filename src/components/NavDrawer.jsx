import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePlan } from '../context/PlanContext';

const NAV_ITEMS = [
  { to: '/home', label: 'Home', icon: '🏠' },
  { to: '/students', label: 'Students', icon: '🎓' },
  { to: '/attendance', label: 'Attendance', icon: '📝' },
  { to: '/fees', label: 'Fees', icon: '💳' },
  { to: '/enquiry', label: 'Enquiry', icon: '💬' },
  { to: '/admin/ClassLogPage', label: 'Class Log', icon: '📋' },
  { to: '/admin/activity', label: 'Activity', icon: '📊' },
  { to: '/admin/performance', label: 'Performance', icon: '🏆' },
  { to: '/calendar', label: 'Calendar', icon: '📅', end: true },
  { to: '/calendar/leave', label: 'Leave Request', icon: '📊' },
  { to: '/profile', label: 'Profile', icon: '👤' },
];

export default function NavDrawer({ open, onClose }) {
  const { isAdmin, appUser, user, logout } = useAuth();
  const { plan } = usePlan();
  const navigate = useNavigate();

  const go = (to) => { navigate(to); onClose(); };

  return (
    <>
      <div className={'drawer-overlay' + (open ? ' open' : '')} onClick={onClose} />
      <div className={'drawer' + (open ? ' open' : '')}>
        <div className="drawer-header">
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent2)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, flexShrink: 0 }}>
            {(appUser?.name || user?.email || '?').charAt(0).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--offwhite)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {appUser?.name || 'Staff Member'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--gray)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{isAdmin ? 'Admin' : 'Staff'}</span>
              {plan?.name && (
                <span style={{
                  fontSize: 9.5, fontWeight: 700, padding: '1px 7px', borderRadius: 8,
                  background: 'var(--accent2)', color: '#fff', textTransform: 'uppercase', letterSpacing: 0.3,
                }}>
                  {plan.name}
                </span>
              )}
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="drawer-nav">
          {NAV_ITEMS.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={onClose}
              className={({ isActive }) => 'drawer-item' + (isActive ? ' active' : '')}>
              <span className="drawer-icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}

          <button
            onClick={() => { onClose(); logout(); }}
            className="drawer-item"
            style={{ color: '#f87171', background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}
          >
            <span className="drawer-icon">🚪</span>
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </>
  );
}
