create extension if not exists "pgcrypto";

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('txt', 'epub', 'pdf')),
  file_path text not null,
  file_name text not null,
  file_size bigint,
  file_last_modified bigint,
  created_at timestamptz not null default now(),
  last_opened_at timestamptz
);

create table if not exists public.reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  word_index integer not null default 0,
  page_number integer,
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  word_index integer not null,
  label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reader_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rate numeric not null default 1,
  pitch numeric not null default 1,
  volume numeric not null default 0.9,
  voice_uri text,
  profile text,
  focus_mode boolean default false,
  updated_at timestamptz not null default now()
);

alter table public.books enable row level security;
alter table public.reading_progress enable row level security;
alter table public.bookmarks enable row level security;
alter table public.reader_settings enable row level security;

create policy "Users manage own books" on public.books
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own progress" on public.reading_progress
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own bookmarks" on public.bookmarks
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own settings" on public.reader_settings
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('book-files', 'book-files', false)
on conflict (id) do nothing;

create policy "Users upload own book files" on storage.objects
  for insert
  with check (bucket_id = 'book-files' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users read own book files" on storage.objects
  for select
  using (bucket_id = 'book-files' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users update own book files" on storage.objects
  for update
  using (bucket_id = 'book-files' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'book-files' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users delete own book files" on storage.objects
  for delete
  using (bucket_id = 'book-files' and auth.uid()::text = (storage.foldername(name))[1]);
