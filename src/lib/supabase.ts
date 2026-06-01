import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

export type BackendUser = User

export type RemoteBook = {
  id: string
  title: string
  source_type: 'txt' | 'epub' | 'pdf'
  file_path: string
  file_name: string
  file_size: number | null
  file_last_modified: number | null
  created_at: string
  last_opened_at: string | null
}

export type RemoteProgress = {
  book_id: string
  word_index: number
  page_number: number | null
}

export type RemoteBookmark = {
  id: string
  book_id: string
  label: string
  word_index: number
  created_at: string
}

export type RemoteSettings = {
  rate: number
  pitch: number
  volume: number
  voice_uri: string | null
  profile: string | null
  focus_mode: boolean | null
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let client: SupabaseClient | null = null

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const bookStorageBucket = process.env.NEXT_PUBLIC_SUPABASE_BOOK_BUCKET || 'book-files'

export function getSupabaseClient() {
  if (!isSupabaseConfigured) return null

  if (!client) {
    client = createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  }

  return client
}
