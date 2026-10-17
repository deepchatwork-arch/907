import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? Deno.env.get('ADMIN_CORS_ORIGIN') ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const isWeakPasswordError = (msg: string): boolean => /password|weak/i.test(msg);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: authData, error: authError } = await caller.auth.getUser();
    if (authError || !authData.user) return json({ error: 'auth_required', message: 'Session expired' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: me, error: profileError } = await admin
      .from('profiles')
      .select('id,role,active')
      .eq('id', authData.user.id)
      .maybeSingle();
    if (profileError) return json({ error: 'db_error', message: 'Profile lookup failed' }, 500);
    if (!me || me.role !== 'admin' || !me.active) return json({ error: 'forbidden', message: 'Admin access required' }, 403);

    const b = await req.json();
    const domain = 'sklad.internal';

    const loadTarget = async () => {
      const { data } = await admin.from('profiles').select('id,role').eq('id', b.id).single();
      return data;
    };

    const countAdmins = async (excludeId?: string) => {
      let q = admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if (excludeId) q = q.neq('id', excludeId);
      const { count } = await q;
      return count ?? 0;
    };

    switch (b.action) {
      case 'list': {
        const { data, error } = await admin.from('profiles')
          .select('id,login,full_name,role,active,created_at').order('created_at');
        if (error) return json({ error: 'db_error', message: error.message }, 400);
        return json({ users: data });
      }
      case 'create': {
        const login = String(b.login ?? '').trim().toLowerCase();
        const password = String(b.password ?? '');
        const fullName = String(b.full_name ?? '').trim();
        const role = ['admin', 'manager', 'supervisor'].includes(String(b.role)) ? String(b.role) : 'supervisor';
        if (!/^[a-z0-9._-]{3,32}$/.test(login)) return json({ error: 'invalid_login', message: 'Login must be 3-32 chars: a-z, 0-9, . _ -' }, 400);
        if (password.length < 1) return json({ error: 'weak_password', message: 'Password is required' }, 400);
        if (!fullName) return json({ error: 'missing_name', message: 'Name is required' }, 400);
        if (fullName.length > 100) return json({ error: 'name_too_long', message: 'Name must be 100 characters or fewer' }, 400);
        const { data: created, error } = await admin.auth.admin.createUser({
          email: `${login}@${domain}`, password, email_confirm: true,
        });
        if (error || !created.user) {
          const authMsg = error?.message ?? 'create_failed';
          if (authMsg.toLowerCase().includes('already')) {
            return json({ error: 'login_taken', message: 'login_taken' }, 400);
          }
          if (isWeakPasswordError(authMsg)) {
            return json({ error: 'weak_password', message: authMsg }, 400);
          }
          return json({ error: 'create_failed', message: authMsg }, 400);
        }
        const { error: pe } = await admin.from('profiles').insert({
          id: created.user.id, login, full_name: fullName, role,
        });
        if (pe) {
          await admin.auth.admin.deleteUser(created.user.id);
          return json({ error: 'profile_not_saved', message: pe.message }, 400);
        }
        return json({ id: created.user.id, login });
      }
      case 'set_password': {
        const target = await loadTarget();
        if (!target) return json({ error: 'not_found', message: 'User not found' }, 404);
        if (String(b.password ?? '').length < 1) return json({ error: 'weak_password', message: 'Password is required' }, 400);
        const { error } = await admin.auth.admin.updateUserById(b.id, { password: b.password });
        if (error) {
          const authMsg = error.message;
          if (isWeakPasswordError(authMsg)) {
            return json({ error: 'weak_password', message: authMsg }, 400);
          }
          return json({ error: 'update_failed', message: authMsg }, 400);
        }
        return json({ ok: true });
      }
      case 'set_active': {
        const target = await loadTarget();
        if (!target) return json({ error: 'not_found', message: 'User not found' }, 404);
        const active = !!b.active;
        if (!active && target.id === me.id) return json({ error: 'self_deactivate', message: 'Cannot deactivate yourself' }, 400);
        if (!active && target.role === 'admin' && (await countAdmins(target.id)) === 0) return json({ error: 'last_admin', message: 'Cannot deactivate the last admin' }, 400);
        const { error } = await admin.auth.admin.updateUserById(b.id, { ban_duration: active ? 'none' : '876000h' });
        if (error) return json({ error: 'update_failed', message: error.message }, 400);
        await admin.from('profiles').update({ active }).eq('id', b.id);
        return json({ ok: true });
      }
      case 'rename': {
        const target = await loadTarget();
        if (!target) return json({ error: 'not_found', message: 'User not found' }, 404);
        const name = String(b.full_name ?? '').trim();
        if (!name) return json({ error: 'missing_name', message: 'Name is required' }, 400);
        if (name.length > 100) return json({ error: 'name_too_long', message: 'Name must be 100 characters or fewer' }, 400);
        await admin.from('profiles').update({ full_name: name }).eq('id', b.id);
        return json({ ok: true });
      }
      case 'set_role': {
        const target = await loadTarget();
        if (!target) return json({ error: 'not_found', message: 'User not found' }, 404);
        if (!['admin', 'manager', 'supervisor'].includes(String(b.role))) return json({ error: 'invalid_role', message: 'Invalid role' }, 400);
        if (target.role === 'admin' && b.role !== 'admin' && (await countAdmins(target.id)) === 0) return json({ error: 'last_admin', message: 'Cannot demote the last admin' }, 400);
        const { error } = await admin.from('profiles').update({ role: b.role }).eq('id', b.id);
        if (error) return json({ error: 'update_failed', message: error.message }, 400);
        return json({ ok: true });
      }
      case 'delete': {
        const target = await loadTarget();
        if (!target) return json({ error: 'not_found', message: 'User not found' }, 404);
        if (target.id === me.id) return json({ error: 'self_delete', message: 'Cannot delete yourself' }, 400);
        if (target.role === 'admin' && (await countAdmins(target.id)) === 0) return json({ error: 'last_admin', message: 'Cannot delete the last admin' }, 400);
        const { error } = await admin.auth.admin.deleteUser(b.id);
        return error ? json({ error: 'delete_failed', message: error.message }, 400) : json({ ok: true });
      }
      default:
        return json({ error: 'unknown_action', message: 'Unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: 'internal', message: String(e) }, 500);
  }
});
