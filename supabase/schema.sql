-- ChatHub schema for Supabase (run in SQL Editor)
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  display_name text not null default 'مستخدم',
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,email,display_name)
  values(new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do update set email=excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check(type in ('direct','group')),
  title text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint group_requires_title check(type <> 'group' or (title is not null and length(trim(title)) > 0))
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check(role in ('admin','member')),
  joined_at timestamptz not null default now(),
  primary key(conversation_id,user_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  body text,
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  constraint message_has_content check (
    (body is not null and length(trim(body)) > 0) or attachment_path is not null
  ),
  constraint attachment_size_limit check(attachment_size is null or attachment_size <= 20971520)
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id,created_at desc);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);

create or replace function public.is_conversation_member(cid uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(select 1 from public.conversation_members cm where cm.conversation_id=cid and cm.user_id=auth.uid());
$$;

create or replace function public.find_direct_conversation(other_user uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select c.id
  from public.conversations c
  where c.type='direct'
    and exists(select 1 from public.conversation_members a where a.conversation_id=c.id and a.user_id=auth.uid())
    and exists(select 1 from public.conversation_members b where b.conversation_id=c.id and b.user_id=other_user)
    and (select count(*) from public.conversation_members x where x.conversation_id=c.id)=2
  limit 1;
$$;
revoke all on function public.find_direct_conversation(uuid) from public;
grant execute on function public.find_direct_conversation(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated" on public.profiles for select to authenticated using (true);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());

drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations for select to authenticated using(public.is_conversation_member(id));
drop policy if exists "authenticated create conversations" on public.conversations;
create policy "authenticated create conversations" on public.conversations for insert to authenticated with check(created_by=auth.uid());
drop policy if exists "group admins update conversation" on public.conversations;
create policy "group admins update conversation" on public.conversations for update to authenticated
using(exists(select 1 from public.conversation_members cm where cm.conversation_id=id and cm.user_id=auth.uid() and cm.role='admin'))
with check(exists(select 1 from public.conversation_members cm where cm.conversation_id=id and cm.user_id=auth.uid() and cm.role='admin'));

drop policy if exists "members read membership" on public.conversation_members;
create policy "members read membership" on public.conversation_members for select to authenticated using(public.is_conversation_member(conversation_id));
drop policy if exists "creator adds initial members" on public.conversation_members;
create policy "creator adds initial members" on public.conversation_members for insert to authenticated
with check (
  user_id=auth.uid()
  or exists(select 1 from public.conversations c where c.id=conversation_id and c.created_by=auth.uid())
  or exists(select 1 from public.conversation_members cm where cm.conversation_id=conversation_id and cm.user_id=auth.uid() and cm.role='admin')
);

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages for select to authenticated using(public.is_conversation_member(conversation_id));
drop policy if exists "members send own messages" on public.messages;
create policy "members send own messages" on public.messages for insert to authenticated
with check(sender_id=auth.uid() and public.is_conversation_member(conversation_id));
drop policy if exists "sender deletes own messages" on public.messages;
create policy "sender deletes own messages" on public.messages for delete to authenticated using(sender_id=auth.uid());

-- Private storage bucket. Do not make it public.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chat-files','chat-files',false,20971520,
 array['image/*','audio/*','application/pdf','text/plain','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict(id) do update set public=false,file_size_limit=20971520;

drop policy if exists "conversation members upload own files" on storage.objects;
create policy "conversation members upload own files" on storage.objects for insert to authenticated
with check (
 bucket_id='chat-files'
 and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
 and (storage.foldername(name))[2]=auth.uid()::text
 and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);
drop policy if exists "conversation members read files" on storage.objects;
create policy "conversation members read files" on storage.objects for select to authenticated
using (
 bucket_id='chat-files'
 and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);
drop policy if exists "file owner deletes own files" on storage.objects;
create policy "file owner deletes own files" on storage.objects for delete to authenticated
using(bucket_id='chat-files' and (storage.foldername(name))[2]=auth.uid()::text);

-- Enable Realtime for messages table in Dashboard > Database > Publications if not already enabled.
-- Supabase Dashboard: Database > Replication > enable messages for supabase_realtime.