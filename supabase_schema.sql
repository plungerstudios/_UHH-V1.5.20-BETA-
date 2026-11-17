create table if not exists public.chat_histories (
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null,
  title text not null,
  updated_at timestamptz not null,
  mode text not null check (mode in ('casual', 'formal', 'expert')),
  messages jsonb not null default '[]'::jsonb,
  deleted boolean not null default false,
  primary key (user_id, chat_id)
);

alter table public.chat_histories enable row level security;

revoke all on public.chat_histories from anon, authenticated;
grant select, insert, update, delete on public.chat_histories to authenticated;

drop policy if exists "Users manage their own chat histories" on public.chat_histories;
create policy "Users manage their own chat histories"
on public.chat_histories
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 2000000, array['image/jpeg'])
on conflict (id) do update
set public = false,
    file_size_limit = 2000000,
    allowed_mime_types = array['image/jpeg'];

drop policy if exists "Users manage their own chat images" on storage.objects;
create policy "Users manage their own chat images"
on storage.objects
for all
to authenticated
using (
  bucket_id = 'chat-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'chat-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
