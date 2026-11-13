import { createClient } from '@supabase/supabase-js';

let clientPromise;

export async function getSupabase() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('تعذر تحميل إعدادات الاتصال.');
        const config = await response.json();
        if (!config.supabaseUrl || !config.supabaseAnonKey) {
          throw new Error('أضف SUPABASE_URL وSUPABASE_ANON_KEY إلى متغيرات البيئة ثم أعد تشغيل التطبيق.');
        }
        return createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
        });
      });
  }
  return clientPromise;
}
