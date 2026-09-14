\set ON_ERROR_STOP on
-- Synthetic accounts only. Sessions are signed with this disposable stack's JWT key.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, email_change_token_current, phone_change, phone_change_token, encrypted_password)
select ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated', 'authenticated', 'stress-' || i || '@example.test', now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false,
  '', '', '', '', '', '', '', '', ''
from generate_series(1, 10000) i
on conflict (id) do nothing;
insert into supabash.workspaces (id, owner_id)
select ('20000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid
from generate_series(1, 10000) i;
