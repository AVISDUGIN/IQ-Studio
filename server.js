import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const isDev = process.argv.includes('--dev');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

if (isDev) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false,
    root: __dirname,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(__dirname, 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, '0.0.0.0', () => {
  console.log(`IQ Studio listening on port ${port}${isDev ? ' (development)' : ''}`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.warn('Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment before using the app.');
  }
});
