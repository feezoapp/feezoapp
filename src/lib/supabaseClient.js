import { createClient } from '@supabase/supabase-js';

// ── SUPABASE CONFIG (anon key is public — RLS protects the data) ──
const SUPABASE_URL = 'https://iiuokufzhkdbeqjgerfb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_uOC4g-pOgUQxa4EmYBjljw_YSl6MSvQ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'sac_supabase_auth',
  },
});

// Same convention used everywhere a plain academy username needs to become
// a Supabase Auth email: if it already looks like an email, leave it alone;
// otherwise suffix it. Login (AuthContext) does this inline — this is the
// same rule, exported so Signup can use the exact same identity.
export function toAuthEmail(rawId) {
  const id = rawId.trim().toLowerCase();
  return id.includes('@') ? id : id + '@gmail.com';
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

// Creates the Supabase Auth user only — creating the `academies` row and
// the `app_users` row is done by the caller (SignupPasswordScreen) right
// after, once it has the new auth user's id to link them together.
export async function signUp(email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data ? data.user : null;
}
