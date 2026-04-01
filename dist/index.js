import { serve } from '@hono/node-server';
import { app, stats } from './server.js';
import { config } from './config.js';
import { VERSION } from './version.js';
const PORT = config.port;
serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Squeezr v${VERSION} listening on http://localhost:${PORT}`);
    console.log(`Mode: ${config.dryRun ? 'dry-run' : 'active'}`);
    if (config.disabled)
        console.log('WARNING: compression is disabled');
    console.log(`Backends: Anthropic → Haiku | OpenAI → GPT-4o-mini | Gemini → Flash-8B | Local → ${config.localCompressionModel}`);
    console.log(`Stats: http://localhost:${PORT}/squeezr/stats`);
});
const isDaemon = !!process.env.SQUEEZR_DAEMON;
if (isDaemon) {
    // Daemon mode: ignore SIGINT (Ctrl+C) and SIGHUP (terminal close)
    // Only stop via `squeezr stop` which sends SIGTERM
    process.on('SIGINT', () => { });
    process.on('SIGHUP', () => { });
}
else {
    // Dev mode (npm run dev): allow Ctrl+C to stop
    process.on('SIGINT', () => {
        const s = stats.summary();
        console.log(`\n[squeezr] Session summary: ${s.requests} requests | -${s.total_saved_chars.toLocaleString()} chars (~${s.total_saved_tokens.toLocaleString()} tokens, ${s.savings_pct}% saved)`);
        process.exit(0);
    });
}
process.on('SIGTERM', () => process.exit(0));
