import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Server-side client — uses the service-role key so it bypasses RLS.
 * Never expose this to the browser.
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

/**
 * Browser-safe client — uses the anon key (respects RLS).
 * Only has SELECT access per the policies in schema.sql.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
