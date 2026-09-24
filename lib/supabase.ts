import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public values: they are bundled into the browser code. Row Level Security in
// the database is what protects the data, not the secrecy of this key.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && key);

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
