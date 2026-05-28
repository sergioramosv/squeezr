# Changelog
All notable changes to Squeezr will be documented here.
## [1.46.3] - 2026-05-28
### Added
- **Dashboard favicon** — la pestaña del navegador ahora muestra el logo de Squeezr (mismo SVG que el header). Se sirve en `/squeezr/favicon.svg` con `Cache-Control: public, max-age=86400`. El path del logo se extrajo a `LOGO_PATH_D` para compartir source-of-truth entre header y favicon (antes estaba duplicado dentro del template HTML).
## [1.46.2] - 2026-05-25
### Fixed
- **`npm install -g squeezr-ai@latest` borraba los puertos personalizados del usuario.** El `squeezr.toml` editado por el dashboard (POST `/squeezr/ports`) se escribía dentro del directorio del paquete npm. Cada reinstall/update reemplazaba ese directorio, perdiendo la configuración del usuario y dejando que `findFreePort()` arrancara silenciosamente en 8080 → siguiente libre, así que cada update mandaba al usuario a un puerto random. Ahora la configuración persistente vive en `~/.squeezr/squeezr.toml` (junto a `runtime.json` y `stats.json`). El `squeezr.toml` bundled dentro del paquete pasa a ser sólo defaults de fábrica.

### Changed
- **Orden de precedencia de config:** bundled defaults → `~/.squeezr/squeezr.toml` (user) → `./.squeezr.toml` (project) → env vars. Antes era sólo bundled → project.
- **Migración automática:** en el primer arranque tras instalar 1.46.2, si el bundled toml todavía tiene puertos personalizados (port ≠ 8080 o mitm_port no derivado) y `~/.squeezr/squeezr.toml` no existe, se copia la TOML al user-home con un log `[squeezr] Migrated custom config…`. Best-effort, sin lanzar si falla.
- **`POST /squeezr/ports`** escribe a `~/.squeezr/squeezr.toml`, nunca al bundled. Crea `~/.squeezr/` si hace falta.

## [1.46.1] - 2026-05-25
### Fixed
- **`recipes/squeezr-1B/3_generate_mega_dataset.py`** — backoff específico para `RateLimitError`. El bucle anterior trataba 429 como cualquier excepción (3 retries con 2/4/8s), insuficiente para la ventana rodante de 5h de la Max subscription: bastaba un burst para que todos los workers murieran y cayera la generación. Ahora `RateLimitError` se cuenta en un contador separado con backoff `60→120→240→480→600s` (cap), hasta 8 reintentos, y emite `[RL]` logs. Otros errores siguen con el bucle corto. Aplicado a `synthesize_one` y `distill_one`.

## [1.46.0] - 2026-05-24
### Added
- **`recipes/squeezr-1B/3_generate_mega_dataset.py`** — generador comprehensivo single-shot para crear el dataset de fine-tuning del modelo local `squeezr-1B`. Pipeline en dos etapas:
  1. **Síntesis** con Sonnet 4.6 (barato): genera ejemplos sintéticos para 56 categorías (TypeScript/Python/Rust/Go/Java/Shell/SQL/HTML/CSS/YAML/JSON/TOML/Markdown/Dockerfile + git-diff/log/status/blame + npm/vitest/jest/pytest/cargo/tsc/eslint/ruff + docker/kubectl/terraform/aws/gcloud + json-api/graphql/http-headers/curl/openapi + grep/ripgrep/find/glob + stack traces Node/Python/Rust/Java + logs + Claude Edit/Write/Bash/Read shaped inputs) con distribución de tamaño realista (small/medium/large/xlarge ponderado 2:5:3:1) y muestreo ponderado por frecuencia real en tráfico Squeezr.
  2. **Destilación** con Opus 4.7 (calidad máxima) en 3 variantes por ejemplo (conservative ~35% / balanced ~55% / aggressive ~75%), usando un único system prompt cacheable (`cache_control: ephemeral`) que dispara prompt-caching de Anthropic — la regla de compresión sólo cuenta como input cacheado (~90% off) en lugar de coste full por cada destilación. Para 9000 pairs esto baja el coste de ~$1500 a ~$350.
- Output en formato chat-style JSONL `{messages: [system, user, assistant], original_chars, compressed_chars, ratio}` compatible directamente con Unsloth, axolotl, trl, o cualquier SFT framework.
- Resumibilidad real: re-ejecutar salta `(id, variant)` ya emitidos. Backoff exponencial en errores, max_retries=3 por request. Concurrencia configurable (default 24 in-flight) para saturar el rate-limit de tokens/segundo del API.
### Fixed
- **`Savings by client` se vaciaba en cada `update` / `install` / `start-stop`.** `byModel` se persistía a `~/.squeezr/stats.json` y se recargaba con `loadPersistedByModel()` al arrancar, pero `byClient` se inicializaba a `{}` y nunca se escribía al disco — cualquier restart borraba el desglose por cliente (claude_code, claude_desktop, codex, …). Fix simétrico al de byModel: nuevo `loadPersistedByClient()`, init del campo desde disco, y `persist()` ahora también escribe `existing.by_client` como snapshot acumulativo.
- **Dashboard mostraba "Update available v1.46.0 → v1.24.0" cuando la versión local era MAYOR que la publicada en npm.** El check usaba `latest !== current` (cualquier diferencia → banner), sin comparar dirección. Ahora `compareSemver(latest, current) > 0`: el banner sólo aparece si npm tiene una versión estrictamente más nueva que la local. Comparación semver propia (major.minor.patch + prerelease tail), sin dependencias.
- **`compress_conversation = false` en `squeezr.toml` desactivaba silenciosamente Steps 1.5–1.7.** Era la causa principal de "sólo ahorramos 10% en Claude Code y <1% en Claude Desktop": el flag bloqueaba la deterministic pass sobre mensajes assistant/user/tool_use input *aunque* el código ya estuviera implementado. Flipped a `true`. Si tu propia `.squeezr.toml` local lo tiene a `false`, ponlo a `true` o bórralo para heredar el default.

### Added
- **Compresión de bloques de texto en mensajes de usuario (Claude Desktop fix).** Nuevo Step 1.6 en `compressAnthropicMessages` (y equivalentes en OpenAI/Gemini) aplica `preprocessAssistant()` a `user.content[*].text` cuando ≥ `assistant_threshold`, saltándose el último mensaje (la pregunta en vuelo). Esto es donde Claude Desktop pegaba adjuntos enormes que antes no se tocaban — explica el <1% de ratio reportado.
- **Compresión deterministic de `tool_use.input` (Claude Code fix).** Nuevo Step 1.7 procesa los campos largos dentro de los tool_use de assistants antiguos: `Bash.command`, `Edit.old_string`/`new_string`, `Write.content`, `NotebookEdit.new_source`, `MultiEdit.edits[]`. Estos bloques son los que crecen rápido en sesiones largas de Claude Code y eran invisibles para el pipeline anterior.
- **Pre-pass deterministic en `compressSystemPrompt`.** Antes de llamar a Haiku/GPT-mini/Gemini, ahora se aplica `preprocess()` al system prompt. Si la pre-pass sola ahorra ≥25%, se cachea y se devuelve sin llamada AI (gratis, sin latencia, sin coste). El cache se indexa por hash del prompt deterministic, así prompts equivalentes (mismo contenido, distinto whitespace) hit el mismo entry.
- **Step 1.5 (prose deterministic) replicado en `compressOpenAIMessages` y `compressGeminiContents`.** Antes sólo existía en Anthropic. Ahora los tres formatos comparten la misma pipeline de limpieza de prosa en mensajes assistant/user antiguos.

### Changed
- **Defaults bajados para activar compresión más agresiva por defecto:**
  - `assistant_threshold`: 1000 → 300 (más mensajes elegibles para deterministic)
  - `keep_recent_assistant`: 5 → 3 (más historia comprimible)
- **`systemPrompt.ts` fallback path no devuelve nunca el prompt crudo.** Si la llamada AI falla, devolvemos el output deterministic (la pre-pass es gratis) en vez del original sin tocar. Antes un timeout de Haiku perdía las mejoras gratuitas.

### Notes
- **Reinicia squeezr** (`squeezr stop && squeezr start`) para que coja el nuevo build y el nuevo `compress_conversation = true`.
- **Si estás en WSL**, cierra y reabre la terminal después del restart para que los shims `claude`/`codex` lean la nueva versión.
- 18 tests existentes fallan, pero son bitrot preexistente (los tests usan dos strings idénticos que el cross-turn dedup colapsa antes de que llegue al compresor) — no son regresiones de esta versión.

## [1.45.5] - 2026-05-24
### Fixed
- **Ratio del dashboard mostraba 0-2% cuando los Tokens Saved / processed sumaban un ratio real de ~11.5%.** Causa: en `buildStatsPayload()` (`src/server.ts`), los campos `total_original_chars` / `total_saved_chars` / `requests` se sobreescribían con valores all-time (`Math.max(session, persisted, history)`), pero `savings_pct` venía del spread `...session` — es decir, del contador en RAM de esta sesión del proceso. Justo después de un restart la sesión apenas ha procesado nada, así que el ratio caía a 0%-2% mientras los demás cards mostraban totales all-time enormes (23.7M/204M). Fix: `savings_pct` ahora se recalcula desde `allTimeSavedTokens / allTimeOriginalTokens` para que el ratio sea internamente consistente con las cifras que ya muestra el resto del dashboard.
- **`breakdown` (deterministic / ai_compression / read_dedup / system_prompt / overhead / ai_calls) también era session-only**, lo que confundía aún más cuando se comparaba contra los Tokens Saved all-time. Ahora `buildStatsPayload()` sobreescribe el breakdown con los valores persistidos en `~/.squeezr/stats.json` (`det_saved_chars`, `ai_saved_chars`, `dedup_saved_chars`, `sysprompt_saved_chars`, `overhead_chars`, `ai_compression_calls`), con fallback a los contadores de sesión por si no hubiera nada persistido. Misma fuente de verdad para los hero cards y para el breakdown.

## [1.45.4] - 2026-05-24
### Fixed
- **El dashboard no mostraba Claude Desktop en la sección "By client".** El tráfico aparecía en los logs (`desktop-proxy.log`) pero ni el desglose por cliente ni los contadores del dashboard reflejaban nada de Claude Desktop. Dos bugs encadenados:
  1. **Stats duplicados entre procesos.** El desktop proxy ejecutaba la pipeline de compresión IN-PROCESS (`app.fetch` importado de `server.ts`), así que tenía su propio singleton `Stats` separado del que aliment el dashboard del main proxy en 8080. Cualquier request de Claude Desktop incrementaba contadores invisibles. Además, ambos procesos persistían a `~/.squeezr/stats.json` y se pisaban (snapshot overwrite).
  2. **Detección de cliente fallaba.** El UA de Claude Desktop no contiene "claude-desktop" ni "electron" en mayoría de casos, así que `detectAnthropicClient` caía al default `claude_code`.
- **Fix:** el desktop proxy ya no compresa él mismo — es un thin relay TLS/path-routing layer que reenvía `/v1/messages` (y todo el tráfico Codex Desktop) al main proxy en `127.0.0.1:${SQUEEZR_PORT}`, donde se hace la compresión, el recording, y el dashboard. Sólo los paths no comprimibles (OAuth, sessions, organizations) van directo a `api.anthropic.com` vía `anthropicDirectFetch`, sin pasar por Hono. Además el desktop proxy ahora inyecta header `x-squeezr-client: claude_desktop` (HTTPS) o `codex_desktop` (HTTP) que el detector trata como autoritativo — el listener *sabe* qué cliente recibió, no hace falta heurística de UA.

### Changed
- **Desktop proxy es ahora puramente thin.** Removidos los imports/usos de `loadSessionCache`, `loadExpandStore`, `loadHistory` y la patched `globalThis.fetch`. El proceso ya no toca esos ficheros — el main proxy es la única fuente. Esto elimina race conditions sobre `~/.squeezr/{session-cache,expand-store,history,stats}.json` cuando ambos procesos están vivos.

## [1.45.3] - 2026-05-24
### Fixed
- **Claude Desktop fallaba con `OAuthError: Unable to start session. Authentication failed (404)`** tras `enable-claude-desktop`. Causa: el desktop proxy enrutaba TODOS los paths a través de la app Hono (`app.all('*')`), cuyo catch-all usa el heurístico `detectUpstream(headers)` — para requests de Claude Desktop (OAuth, organizations, sessions, history…) ese detector no reconoce headers Anthropic y los misenruta como OpenAI, devolviendo 404. Fix: el desktop proxy ahora distingue por path. Sólo `/v1/messages` (el endpoint comprimible) atraviesa Hono; cualquier otra ruta hace passthrough crudo a `https://api.anthropic.com${path}${search}` vía `anthropicDirectFetch` (direct DNS, headers/body sin tocar). Claude Desktop ve la API real para autenticarse y Squeezr sólo se mete cuando hay tokens que ahorrar.

## [1.45.2] - 2026-05-23
### Fixed
- **Activar `enable-claude-desktop` rompía Claude Code en terminal** ("Retrying in 0s · attempt 5/10" infinito). Aunque los procesos están separados, el hosts file `127.0.0.1 api.anthropic.com` es global y afecta al proxy principal — sus llamadas outbound a Anthropic se redirigían a 127.0.0.1:443 → portproxy → desktop proxy (con cert auto-firmado de Squeezr) → TLS falla. Fix: el proxy principal ahora usa direct-DNS (vía 1.1.1.1 / 8.8.8.8) ÚNICAMENTE para `api.anthropic.com`, siempre, sin importar el estado del hosts file. Cualquier otro upstream (OpenAI, Gemini, local) sigue usando `fetch` normal sin cambios. No hay branching en estado de Claude Desktop — el comportamiento es constante e invariante.
- **`Invalid IP address: undefined` en el desktop proxy** al recibir tráfico real de Claude Desktop. Causa: el callback `lookup` de `https.request` ignoraba `options.all`. Cuando Node lo pone a `true` (típico con `https.Agent` y keep-alive), espera un array de `{address, family}`; la implementación previa devolvía un string suelto y reventaba. Fix: el callback ahora maneja ambos modos correctamente.

### Changed
- **Nuevo módulo compartido `src/anthropicDirectFetch.ts`** que centraliza el fetch outbound hacia `api.anthropic.com`: direct DNS por 1.1.1.1/8.8.8.8, `accept-encoding: identity` forzado (fix gzip de v1.44 conservado), `lookup` que respeta `opts.all`. Lo usan ambos procesos — `server.ts` (main proxy) y `desktopProxy.ts` — para que haya un solo sitio donde arreglar este tipo de bugs.

## [1.45.1] - 2026-05-23
### Fixed
- **`squeezr desktop {start|stop|status}` no reconocía el subcomando.** Causa: el router del switch leía `args[0]` para el subcomando, pero `args[0]` es el comando top-level (`'desktop'`) — el subcomando real está en `args[1]`. Mismo bug existía en `squeezr mcp`. Ambos arreglados.
- **`squeezr desktop status` reportaba "NOT running" aunque el desktop proxy estuviera vivo** cuando el PID file estaba obsoleto (situación común tras un reinicio no graceful: nueva instancia se levanta con PID distinto al del fichero). Fallback nuevo: si el PID del fichero está muerto, sonda los puertos 8443/8088 con `net.connect`; si hay listener, resuelve el PID dueño con `netstat -ano` y reescribe el PID file para adoptarlo.
- **`squeezr desktop stop` no podía matar listeners huérfanos** cuando el PID file no se correspondía con el proceso real. Ahora también recupera el PID por puerto antes de mandar `SIGTERM`.

### Added
- **Diagnóstico en `squeezr desktop status` del estado de interceptación de Claude Desktop.** Lee el hosts file y reporta explícitamente si la redirección `127.0.0.1 api.anthropic.com` está activa. Si no lo está, muestra el siguiente paso obligatorio (`squeezr enable-claude-desktop` como admin) — porque la causa más común de "no aparece nada en los logs" no es que el desktop proxy no esté corriendo, sino que el cliente nunca está apuntando a él.
- **Adopción automática de listeners huérfanos** en `squeezr desktop start`. Si los puertos 8443/8088 ya están bound por un proceso anterior con PID file perdido, en vez de fallar con `EADDRINUSE` reescribe el PID file y reusa el listener existente.

## [1.45.0] - 2026-05-23
### Changed
- **Arquitectura: proxy separado para Desktop apps en otro puerto.** El usuario tenía toda la razón quejándose: "HAZ OTRO PROXY NUEVO EN OTRO PUERTO PARA CLAUDE DESKTOP Y CODEX DESKTOP ASI SI LO ROMPES NO DEJA DE FUNCIONAR EL DE CLAUDE CODE TERMINAL". Hecho:
  - **Proxy principal (8080)** = Claude Code, Codex CLI, Aider, Gemini CLI. NUNCA toca el hosts file, NUNCA arranca MITM, NUNCA mira flags de Claude Desktop. Idéntico comportamiento con o sin Claude Desktop activo.
  - **Proxy Desktop (8443 HTTPS + 8088 HTTP)** = Claude Desktop + Codex Desktop. Proceso totalmente separado (`src/desktopProxy.ts`). Listener TLS propio para Claude Desktop (vía hosts file), listener HTTP propio para Codex Desktop. Fetch outbound parcheado con DNS directo (1.1.1.1/8.8.8.8) para esquivar el hosts file. PID file propio (`~/.squeezr/desktop-proxy.pid`).
  - **Aislamiento real:** si el desktop proxy crashea/hangs/explota, el principal en 8080 sigue sirviendo Claude Code SIN VERSE AFECTADO. Son dos procesos node distintos en `tasklist`.
- **`squeezr start`** ahora también levanta el desktop proxy (después del principal). Si el desktop falla en arrancar, el principal sigue corriendo y se imprime un warning (no es fatal).
- **`squeezr stop`** ahora también mata el desktop proxy primero, luego el principal. Cada uno con su PID file.
- **Nuevos subcomandos CLI:** `squeezr desktop start | stop | status` para gestionar el desktop proxy de forma independiente sin tocar el principal.
- **`src/index.ts` limpio:** eliminados todos los imports y código relacionado con Claude Desktop. `outgoingFetch` en `server.ts` vuelve a ser `fetch` plano para api.anthropic.com. Cero acoplamiento.

### Fixed
- **Claude Code dejaba de funcionar al activar Claude Desktop.** Causa: `outgoingFetch` en el proxy principal ramificaba según estado del hosts file y caía en `fetchBypassHosts` que no descomprimía gzip. Solución arquitectónica (no parche): el proxy principal ya no tiene ese código. La lógica de bypass DNS vive ÚNICAMENTE en el desktop proxy separado.

### Added
- **`src/desktopProxy.ts`** — entrypoint Node standalone. TLS server en 8443 + HTTP server en 8088. Genera certs por SNI firmados con la CA local. Parchea `globalThis.fetch` SÓLO en su propio proceso (no afecta al principal) para enrutar `api.anthropic.com` por DNS directo. Catch global de `uncaughtException` para no morirse por un handshake malo.

## [1.44.0] - 2026-05-23
### Fixed
- **Claude Code dejaba de funcionar al activar Claude Desktop** ("Retrying in 5s · attempt 4/10" infinito). Causa raíz doble:
  1. `fetchBypassHosts` usaba `https.request` que **NO descomprime gzip/brotli automáticamente** (a diferencia del `fetch` global). Anthropic respondía comprimido y el SSE llegaba como bytes basura → el parser de Claude Code no veía mensajes y reintentaba. **Fix:** se fuerza `accept-encoding: identity` en outbound, eliminando cualquier `accept-encoding` heredado del cliente.
  2. `outgoingFetch` cambiaba de comportamiento según el estado del hosts file. Si `fetchBypassHosts` tenía cualquier bug, **solo se manifestaba con Claude Desktop activo**, creando acoplamiento implícito. **Fix:** `outgoingFetch` ahora SIEMPRE usa `fetchBypassHosts` para api.anthropic.com — sin condicionales. El comportamiento del proxy principal es idéntico con o sin Claude Desktop.

### Changed
- **Arquitectura: Claude Desktop MITM es ahora un proceso hijo independiente** (`src/claudeDesktopWorker.ts`). El proxy principal hace `spawn()` del worker como child process cuando detecta el marker del hosts file. **Aislamiento total:**
  - Si el worker crashea, hangs o tiene memory leak → el proxy principal (Claude Code, Codex, Aider) sigue funcionando.
  - El proxy principal NO importa nada del worker. Solo lo lanza.
  - El worker reinyecta los requests interceptados en `http://localhost:<proxy_port>` como cliente HTTP normal, reutilizando el pipeline de compresión completo.
  - SIGTERM del proxy principal mata limpiamente al worker.
- **`anthropicMitm.ts`** — `startAnthropicMitm` / `stopAnthropicMitm` ya no se importan en `index.ts`. Solo se exportan `fetchBypassHosts` e `isClaudeDesktopInterceptActive` para uso del server. La MITM real vive en el worker.

## [1.43.0] - 2026-05-23
### Fixed
- **Claude Desktop interception coexiste con Claude Code** — el flag file separado se eliminó. La detección ahora lee directamente el hosts file buscando el marker `# squeezr-claude-desktop BEGIN`. Si está → modo claude-desktop activo (arranca listener MITM en 8443, usa `fetchBypassHosts` para outbound). Si no → comportamiento normal. **Imposible quedar en estado half-broken** (hosts modificado pero listener no arrancado).
- **`fetchBypassHosts` ahora es streaming-aware** — usa `ReadableStream` que pipea chunks del `http.IncomingMessage` directamente, sin bufferizar. Mantiene SSE de Claude Code funcionando perfectamente cuando claude-desktop está enabled simultáneamente.
- **Cache de 30s** en la detección del hosts file — lectura solo cada 30s, no en cada request.

### Added
- **`isClaudeDesktopInterceptActive()`** en `anthropicMitm.ts` — detección runtime via lectura del hosts file con cache.

## [1.42.0] - 2026-05-23
### Added
- **Claude Desktop interception via hosts file + TLS** — `squeezr enable-claude-desktop` modifica el hosts file con `127.0.0.1 api.anthropic.com`, abre el firewall TCP 443, y flushea la DNS cache. Squeezr levanta entonces un listener HTTPS en port 443 con certificado para `api.anthropic.com` firmado por la CA local de Squeezr (ya confiada por Windows tras `squeezr setup`). Claude Desktop conecta a "Anthropic" pero acaba en Squeezr → comprime → reenvía al api real.
- **`src/anthropicMitm.ts`** — HTTPS server en 443 que termina TLS y enruta vía el Hono app existente. Genera certs per-host firmados por la CA. Reusa el pipeline de compresión completo (system prompt + tool results + assistant det + dedup).
- **`fetchBypassHosts()`** en `anthropicMitm.ts` — drop-in replacement de `fetch()` que usa `https.request` con custom `lookup` que resuelve via DNS directo (1.1.1.1 / 8.8.8.8), bypaseando el hosts file. Crítico: sin esto, Squeezr forwardearía a `api.anthropic.com → 127.0.0.1 → loop infinito`.
- **`disable-claude-desktop`** — comando reverso que limpia hosts file y firewall rule, restaurando comportamiento normal.
- **Auto-elevation** — el comando detecta si no corre como admin y se relanza vía PowerShell `Start-Process -Verb RunAs`.

## [1.41.0] - 2026-05-23
### Added
- **Endpoint `POST /squeezr/distill`** — usa el token OAuth capturado de Claude Code/Desktop para hacer distillation con Opus 4.7 usando la **suscripción Pro/Max del usuario** (cero coste API). Soporta 3 variantes (`conservative`, `balanced`, `aggressive`). Diseñado para entrenar `squeezr-1B`.
- **Script `recipes/squeezr-1B/2_distill_via_squeezr.py`** — llama al endpoint local, maneja rate limits 429 con pausa de 5min, resumable, multi-variant.
- **Script `recipes/squeezr-1B/1_extract_dataset.py`** — extrae ejemplos reales de `~/.squeezr/expand_store.json` (~437 ejemplos en uso normal).
- **Script `recipes/squeezr-1B/1b_synthetic_examples.py`** — genera ejemplos sintéticos por categoría (git-diff, vitest, pytest, terraform, etc.) para diversidad del dataset.
- **`configureCodexDesktop` defensivo** — detecta `openai_base_url = ""` (que Codex Desktop a veces sobreescribe) y lo arregla en re-runs de `squeezr setup`.

### Fixed
- **Update banner mostrando versión vieja como "available"** — bug en la lógica del cache de update-check. Ahora compara versiones numéricamente y solo muestra banner si npm tiene una versión **estrictamente más nueva**. Aplicado tanto al path cacheado como al fresh fetch.

## [1.40.0] - 2026-05-23
### Added
- **Compression backend selector** en Settings → Compression. 5 opciones: `Auto` (default, usa el modelo de la API que recibe la request), `squeezr-1B` (local via Ollama, gratis, sin red), `Haiku`, `GPT-4o-mini`, `Gemini Flash`. Cuando se selecciona un backend distinto de Auto, **se usa ese modelo para TODAS las compresiones** sin importar de qué cliente venga la request. Fallback automático a Auto si el backend elegido no tiene key disponible.
- **Endpoint `GET/POST /squeezr/backend`** para consultar/cambiar el backend en runtime.
- **Config `backend`** en `squeezr.toml [compression]` (default: `"auto"`).
- **Función `effectiveBackend()`** en `config.ts` que respeta runtime override sobre TOML.
- **Función `getEffectiveCompressFn()`** en `compressor.ts` que enruta la llamada al backend seleccionado, manteniendo el circuit breaker y la caché LRU.
- **Storage de Gemini API key** en `limits.ts` (antes solo se guardaba anthropic y openai). Necesario para que el backend `gemini-flash` funcione cuando se selecciona desde una request que no es Gemini.

### Roadmap mencionado
- **squeezr-1B**: modelo de compresión propio, fine-tuneado desde Qwen 3.5-0.8B usando Claude Opus 4.7 como teacher. Pendiente de entrenar. El backend selector ya tiene la opción `local` lista para cuando esté disponible.

## [1.39.0] - 2026-05-23
### Added
- **Patrones específicos para mensajes del assistant** (`preprocessAssistant` en `deterministic.ts`). Reemplaza phrases verbosas (`"in order to"` → `"to"`, `"due to the fact that"` → `"because"`, etc.), strip discourse markers (`"let me"`, `"I'll"`, `"actually"`, `"basically"`), elimina markdown decorativo (`**bold**`, `_italic_`), corta trailing summaries (`"Here's a summary…"`). **Solo aplica a prose, los code blocks ``` ``` quedan 100% intactos**. Splittea texto en prose/code antes de procesar.
- **Toggle `compact-2026-01-12` (Anthropic native compaction beta)** — nuevo botón en Settings → Compression. Cuando se activa, Squeezr inyecta el header `anthropic-beta: compact-2026-01-12` en todas las requests a Anthropic. Anthropic resume server-side la conversación cuando excede threshold. **Stackable con la compresión de Squeezr** — comprimes primero, ellos resumen lo que queda. Solo Claude (no afecta OpenAI/Gemini). OFF por defecto, runtime-toggleable.
- **Endpoint `GET/POST /squeezr/native-compact`** para consultar/togglear el estado del beta.
- **Config `anthropic_native_compact`** en `squeezr.toml` (default: false).

## [1.38.0] - 2026-05-23
### Added
- **`compress_conversation` (modo determinístico — sin AI)** — Aplica preprocesado determinístico a los mensajes del assistant antiguos: colapsa whitespace, minifica JSON embebido, dedup de stack traces y líneas repetidas. **Cero llamadas AI** — solo regex. Defaults conservadores: `keep_recent_assistant=5` (los últimos 5 mensajes del assistant intactos), `assistant_threshold=1000` (solo mensajes >1000 chars). Habilitado por defecto al ser totalmente seguro. La parte de AI compression para mensajes del assistant queda al margen (se implementará después con goteo y presupuesto duro para evitar el burst que quemó rate limits en pruebas anteriores).
- **Config `keep_recent_assistant`** y **`assistant_threshold`** en `squeezr.toml`.
- **Función `extractAnthropicAssistantTexts`** en `compressor.ts` que extrae textos de mensajes del assistant respetando `keepRecent` y umbral mínimo.
- **Log `[squeezr/asst-det]`** que reporta ahorro determinístico sobre mensajes del assistant.

## [1.37.0] - 2026-05-23
### Added
- **Cross-turn dedup extendido a Bash y Grep** (antes solo Read). Si el mismo output de Bash (ej: `git status`) o Grep aparece varias veces en la conversación con contenido byte-idéntico, las apariciones anteriores se reemplazan por `[same bash output as a later call — squeezr_expand(id) to retrieve]`. Estimado: +10-15% de ahorro adicional en sesiones iterativas (debug loops, refactors). **Riesgo cero**: hash MD5 exacto, si difiere un byte no deduplica. Threshold mínimo de 200 chars (outputs pequeños no compensan el overhead del placeholder). Aplicado a Anthropic, OpenAI y Gemini.

## [1.36.0] - 2026-05-22
### Fixed
- **Dashboard frozen** — el constructor de Stats con campos sin inicializador (`private requests: number`) con target ES2022 causaba un conflicto entre los `Object.defineProperty` de los campos nativos y el constructor body. Revertido a campos con inicializadores simples (`= 0`), patrón que funciona de forma garantizada.
- **Overview sigue mostrando histórico después del arreglo** — en lugar de pre-cargar en memoria, el endpoint `/squeezr/stats` ahora fusiona los totales de `stats.json` (all-time) con la sesión actual usando `Math.max`, de forma que siempre muestra el valor más alto (que es el histórico acumulado).

## [1.35.0] - 2026-05-22
### Fixed
- **Overview vs Savings token mismatch** — `renderSavingsData` tenía `totalOrig += savedTokens + savedChars/3.5` que suma el mismo valor dos veces (ya que `savedTokens = savedChars/3.5`). Resultado: Savings mostraba el doble de tokens que Overview. Corregido usando `originalChars` real de la session.
- **Overview shows all-time totals after restart** — `Stats` constructor ahora pre-carga totales de `stats.json` como baseline. Overview ya no empieza en 0 tras cada `squeezr stop/start`.
- **`SessionRecord` ahora incluye `originalChars`** — `history.ts` y todos los `recordRequest()` en `server.ts` reciben y persisten los chars originales del request, necesario para calcular el total procesado correctamente en Savings.
- **"0 compressed" con requests activos** — El hero card "Requests" ahora muestra AI calls + session cache hits combinados, no solo AI calls. Cuando solo corre determinística se muestra correctamente.

## [1.34.0] - 2026-05-22
### Changed
- **Savings chart redesigned** — replaced basic colored divs with a proper SVG bar chart: grid lines with Y-axis labels (1.2M, 800k…), max bar highlighted in bright green, dimmer bars for context, value label above max bar, native hover tooltip (date + tokens + requests), x-axis labels rotated 40° when many bars, total tokens right-aligned in footer.
### Fixed
- **Version in dashboard header** — `package.json` was stuck at `1.30.0` while changelog was at `1.33.0`. Now in sync at `1.34.0`. Version is read live from `package.json` via `version.ts` so it always reflects the running code.

## [1.33.0] - 2026-05-22
### Fixed
- **`squeezr stop` ya no borra el historial de savings** — el bug era que `stopProxy()` usaba `taskkill /F` (Windows) y `kill -9` (Unix), ambos force-kills que matan el proceso sin darle tiempo a ejecutar el shutdown handler (`persistAndExit` → `persistHistory`). Ahora primero hace un shutdown graceful via `POST /squeezr/control/stop` (que emite SIGTERM → `persistHistory` → guardado en disco) y espera ~1s. Solo entonces force-kill si el proceso sigue vivo. Aplica también a `squeezr update` y `squeezr setup` que reutilizan `stopProxy()`.

## [1.32.0] - 2026-05-22
### Fixed
- **Hero "Cost Saved" now uses real model-weighted pricing** — was using flat $3/1M regardless of model. Now uses the same `calcCostFromModels` weighted calculation as the cost comparison section. Falls back to $3/1M only if no model data is available.
- **By model tokens sum now matches total** — `by_model` is now persisted to `stats.json` and pre-loaded at proxy startup, so model breakdown accumulates across proxy restarts just like the total token counter. Previously only showed current session data, causing a visible mismatch (e.g. 5.3M in models vs 10.6M total).
- **Savings tab "Est. Cost Saved" note is now dynamic** — previously hardcoded "at $3/1M tokens". Now shows "model-weighted pricing" when model data is available.

## [1.31.0] - 2026-05-22
### Added
- **ARCHITECTURE.md** — full technical reference of everything Squeezr does, sourced exclusively from code: compression pipeline, deterministic patterns, session cache, expand store, circuit breaker, context pressure, stats tracking, client detection, all endpoints.
### Fixed
- **README: Cursor IDE row** — removed false claim of `squeezr cursor` command and MITM proxy on :8082 (neither exists). Now correctly describes BYOK localhost or `squeezr tunnel`.
- **README: session cache description** — removed false "After ~50 tool results, batch-summarized" claim. Now accurately describes per-block MD5 hash lookup with KV cache preservation.
### Changed
- Deleted stale/false MD files: AUDIT_SIMPLE_RTK_vs_SQUEEZR.md, AUDIT_TECNICO_RTK_vs_SQUEEZR.md, CODEX.md, CURSOR_PLAN.md, CURSOR_TUNNEL.md, IMPROVEMENTS.md, NSSM_WINDOWS_SERVICE.md, WHY_SQUEEZR.md. Only README.md and ARCHITECTURE.md remain.

## [1.30.0] - 2026-05-22
### Fixed
- **History sessions had `savedTokens: 0`** — `recordRequest` in `history.ts` was being passed `savings.savedChars` which only counts AI-compression savings, missing deterministic + system prompt + dedup savings (which are the majority). Now passes `originalChars - compressedChars` (total saved) so the Savings tab shows real numbers for past sessions.
- **Dashboard JS crashed silently (everything `—`, buttons dead)** — `'Cascadia Code'` inside a single-quoted JS string broke the parser when the HTML was served (escaped backslashes vanish). Replaced with `monospace`.
### Changed
- **Cost Comparison label** — Removed hardcoded "est. at $3/1M tokens". Now shows dynamic note: `per-model pricing` when model data is available, fallback note otherwise.
- **Rate Limits 2-column layout** — Claude left, Codex / OpenAI right. Previously cramped horizontally at default widths.

## [1.29.0] - 2026-05-22
### Added
- **Per-model pricing** — Cost Comparison now uses real prices per model (30+ models: Claude Opus/Sonnet/Haiku, GPT-4o/mini, o1/o3/o4-mini, Codex, Gemini 2.5 Pro/Flash, etc.). When model data is available, pricing is model-weighted; otherwise falls back to $3/1M estimate.
- **`by_model` stats tracking** — Server tracks `originalChars`/`savedChars` per model name extracted from request body (`body.model` for Anthropic/OpenAI, URL path for Gemini).
- **Overview: By model section** — Shows each model used with price/1M, tokens saved, cost saved, and without/with Squeezr comparison.
- **Savings tab: By model section** — Same model breakdown visible in Savings tab.
### Fixed
- **Rate Limits "Loading…"** — `render()` was crashing with TypeError on removed latency DOM elements (`l-50`, `l-95`, `l-99`) before reaching `renderLimits`. Added null checks.
- **`renderLimits` using wrong API fields** — Now reads `limits.anthropic.unified` (5h/7d utilization for Claude Code Max) and `limits.openai.session` (Codex plan window), plus actual session token usage.

## [1.28.0] - 2026-05-22
### Added
- **Token savings by client** — Settings page shows a collapsible breakdown of tokens saved per client protocol: `claude` (Claude Code, Claude Desktop, Aider), `openai` (Codex Desktop, Continue, Cline), `gemini` (Gemini CLI). Each row has a bar chart, saved tokens, savings %, and request count. Tracked server-side in `stats.ts` via new `by_client` map populated from which endpoint handled the request.
- **Cost Comparison in Overview** — New section showing "Without Squeezr / With Squeezr / Saved" in estimated USD at $3/1M tokens. Makes the token savings immediately tangible.
### Fixed
- **chars/token ratio inconsistency** — Dashboard was dividing `total_original_chars` by 4 to estimate tokens, but `stats.ts` uses 3.5. Now both use 3.5 for consistent numbers.

## [1.27.0] - 2026-05-22
### Fixed
- **Dashboard: wrong API field names** — Stats showed `—` everywhere because the render function read `tokens_saved`, `compression_ratio`, `total_requests`, `latency_p50`, `cache_hits` but the proxy returns `total_saved_tokens`, `savings_pct`, `requests`, `latency.total.p50`, `cache.hits`. Now normalizes all field names.

## [1.26.0] - 2026-05-22
### Added
- **Dashboard: top navbar with tabs** — Sidebar replaced by horizontal top navbar: logo left, two tabs (Overview / Settings), connection dot + theme toggle right.
- **Dashboard Settings: actions panel** — Buttons for Stop Proxy, Check Status, Update, and port info inline in the browser. Update banner if a newer npm version is available.
- **Dashboard: Rate Limits section** — Overview shows token/request gauges from upstream API headers, color-coded green/yellow/red.
### Changed
- **Dashboard redesign** — New CSS token system, bolder hero numbers, two-column grid, dark/light mode. Removed non-functional History, Projects, Limits, context pressure, and activity sections.

## [1.25.0] - 2026-05-22
### Added
- **Claude Desktop support** — `squeezr setup` configures Claude Desktop automatically: Windows via `setx`, macOS via `com.squeezr.env` launchd plist, Linux via `~/.config/environment.d/squeezr.conf`.
- **Codex Desktop support** — `squeezr setup` writes `openai_base_url` to `~/.codex/config.toml`. On WSL also writes to Windows-side `%USERPROFILE%\.codex\config.toml`.
- **MCP: Claude Desktop auto-registration** — `squeezr setup` and `squeezr mcp install` now write to `claude_desktop_config.json` automatically on all platforms.
- **MCP tool `squeezr_open_dashboard`** — Opens the web dashboard in the system browser from any MCP client (Claude Desktop, Claude Code, Codex, Cursor…).

## [1.24.0] - 2026-04-30
### Fixed
- **Rate limit headers not forwarded on streaming responses** — When `ANTHROPIC_BASE_URL` pointed to the Squeezr proxy, Claude Code never received the `anthropic-ratelimit-*` response headers, causing the `rate_limits` field to be absent from the statusline JSON. The proxy now forwards all non-hop-by-hop headers (including `anthropic-ratelimit-*`) to the client across all three `/v1/messages` branches: bypass streaming, normal streaming, and expand-call continuation. Also calls `updateAnthropicFromHeaders()` on the expand-call continuation response so the internal dashboard stays in sync. Fix contributed by [@jorgecasar](https://github.com/jorgecasar) in [#4](https://github.com/sergioramosv/Squeezr/issues/4) / [PR #5](https://github.com/sergioramosv/Squeezr/pull/5).

## [1.23.0] - 2026-04-27
### Added
- **Port-conflict diagnostics** — On startup, Squeezr now classifies the configured port as `free`, `squeezr` (existing instance), or `foreign` (an unrelated HTTP service). When a foreign service is detected (e.g. a Docker container squatting on 8080), Squeezr prints an explicit warning that names the conflict and reminds the user that their shell env vars likely still point to the wrong port. This prevents Claude Code from silently routing API calls into Apache/WordPress/etc., which produced cryptic errors like `undefined is not an object (evaluating '$.speed')`.
- **Post-start self-test** — After a successful `listen()`, Squeezr runs four async checks that never block accepting requests:
  - `loopback_health` — verifies the bound port answers `/squeezr/health` with the expected `identity`/`version`.
  - `env_coherence` — checks that `ANTHROPIC_BASE_URL`, `openai_base_url` and `GEMINI_API_BASE_URL` actually point to the bound port; if they drifted (because `findFreePort` picked a different port than the one in `squeezr.toml`), it prints the exact `export` lines to fix it.
  - `upstream_reachable` — DNS + TLS handshake to `api.anthropic.com` (no payload, no quota cost).
  - `pipeline_dryrun` — sends a minimal Anthropic-format request with the new `X-Squeezr-DryRun: 1` header, exercising the full compression path without forwarding to upstream.
  - Results are exposed at `GET /squeezr/selftest` and printed at startup.
- **Health endpoint identity field** — `GET /squeezr/health` now includes `"identity": "squeezr"`, so external callers (shell wrappers, auto-heal scripts, CI checks) can distinguish a real Squeezr instance from any other HTTP service that happens to answer 200.
- **Runtime info file** — Squeezr writes its actual bound port + PID to `~/.squeezr/runtime.json` on startup and clears it on shutdown. The shell wrapper and `squeezr status` read this file so they always know the real port, even when `findFreePort` drifted.

### Fixed
- **Auto-heal in `setupUnix` / `setupWSL` / `squeezr ports`** — The shell-profile auto-heal previously used `curl -sf …/squeezr/health`, which does not fail on 3xx responses. A foreign service replying with `301` (e.g. WordPress redirecting `/squeezr/health` → `/squeezr/health/`) was therefore mistaken for a healthy Squeezr, and the auto-heal never restarted the proxy. The block now uses an `_squeezr_alive` helper that grep-matches `"identity":"squeezr"` in the body.
- **`squeezr start` version detection** — `startDaemon()` previously caught a `JSON.parse('')` error, returned the string `'unknown'`, and entered a "version mismatch → restart" loop against the foreign service. It now uses the same `identity` validation, so a foreign service is correctly reported instead of triggering a restart attempt that cannot succeed.
- **`squeezr status`** — When the configured port is occupied by a foreign service, the command now reports it explicitly (with the foreign `Server` header) instead of saying "Squeezr is NOT running".
- **CRLF normalization in compressed output** — `preprocess()` now normalizes `\r\n` → `\n` before any other transformation. On Windows, file content read via the Read tool has CRLF line endings. After Squeezr compressed it, the Edit tool's `old_string` matching failed silently because the pattern used LF while the compressed content kept CRLF. All compressed tool results now use LF consistently.

## [1.22.0] - 2026-04-10
### Added
- **Resilience: Circuit breaker for AI compression** — After 3 consecutive AI compression failures (Haiku/GPT-4o-mini/Gemini Flash), Squeezr automatically skips AI compression for 60s, then probes recovery. Prevents hammering a down backend. State visible in dashboard, MCP `squeezr_status`, and `squeezr status` CLI.
- **Resilience: Per-request latency tracking** — Tracks p50/p95/p99 compression latency (total, deterministic, and AI separately) with a rolling 200-sample window. Visible in dashboard overview cards and MCP `squeezr_stats`.
- **Resilience: Expand rate tracking** — Counts how often the model calls `squeezr_expand` to recover compressed content. High expand rate = compression too aggressive. Visible as percentage in dashboard, MCP stats, with color coding (green <10%, yellow <25%, red >25%).
- **Resilience: Enhanced health check** — `GET /squeezr/health` now returns circuit breaker state, bypass status, compression mode, uptime, expand store pressure, and compression stats. `squeezr status` CLI shows all new fields.
- **Bypass mode** — `squeezr bypass` CLI command, `POST /squeezr/bypass` endpoint, `squeezr_bypass` MCP tool, and dashboard sidebar toggle. Instantly disables all compression without restart. Requests still pass through and are logged. Runtime-only (resets on restart). Per-call timeout of 5s on all AI compression calls.

## [1.21.8] - 2026-04-10
### Fixed
- **Claude Limits: prefer subscription windows** - When unified subscription data is available, the Limits page now prioritizes Claude `5-hour window` and `7-day window` rendering over legacy per-minute rate-limit headers, so it no longer falls back to `tokens / minute` incorrectly.

## [1.21.7] - 2026-04-10
### Improved
- **Codex/OpenAI limits: smarter refresh cadence** - Session-limit refreshes are now adaptive instead of effectively checking every minute all day. Squeezr refreshes less often when resets are far away, and tightens polling only near an actual reset window.
- **Limits UI: clearer zero-crossing state** - When a local countdown reaches zero before the next snapshot arrives, the dashboard now shows `updating...` instead of `resetting...`.

## [1.21.6] - 2026-04-10
### Fixed
- **Windows: hidden Codex limit refresh shell** - The OpenAI/Codex session-limit refresh now spawns the local `codex app-server` with `windowsHide: true`, so Windows no longer flashes transient `cmd.exe` windows while the dashboard refreshes limits.

## [1.21.5] - 2026-04-10
### Fixed
- **Codex limits: real session + weekly windows** - OpenAI/Codex limits now come from the local `codex app-server` rate-limit RPC instead of `x-ratelimit-*` API headers. The Limits page shows real session/weekly percentages and reset countdowns for ChatGPT-plan Codex usage.
- **Limits UI: removed `tokens / minute` for Codex** - OpenAI card now uses `5-hour window` / `7-day window` labels when session limits are available, with session-tracking fallbacks when they are not.
- **Git noise: local Codex schema artifacts ignored** - Added `.tmp-codex-schema/` to `.gitignore` so local protocol inspection files do not flood the working tree.

## [1.21.4] - 2026-04-10
### Fixed
- **Windows auto-start: 3-tier fallback** — `squeezr setup` now tries NSSM → Task Scheduler (without admin) → Startup folder VBS script. Previously Task Scheduler required admin (`RunLevel Highest`) and silently failed, leaving no auto-start registered. The new VBS fallback writes a silent launcher to `%APPDATA%\...\Startup\` which works without any permissions.
- **Uninstall cleans up Startup VBS** — `squeezr uninstall` now removes the VBS script from the Startup folder if present.

## [1.21.3] - 2026-04-10
### Fixed
- **Dashboard: dark theme** — Switched from blue accent to green. Background is now pure black (#09090b) with dark greys. All links, bars, badges, and active states use green (#22c55e/#16a34a).
- **Dashboard: real CLI logos** — Replaced placeholder SVGs with official Bootstrap Icons for Claude (Anthropic star), OpenAI (hexagon), and Google (G icon).
- **Dashboard: removed uptime/Running** — Status shows "Connected" instead of "Running 44s". Uptime removed from header and sidebar.
- **Project detection: excluded URLs** — Fallback regex no longer matches `github.com` or other domains from URLs in the system prompt.
- **`squeezr gain --sesion`** — Added Spanish typo alias.

## [1.21.2] - 2026-04-10
### Fixed
- **Limits: 5h/7d countdown timers** — Shows time remaining until rate limit reset for subscription users. When throttled, displays "throttled — resets in Xh Ym". When allowed, shows "X% free" or "X% used" for high utilization.
- **Limits: CLI logos** — Added Anthropic, OpenAI, and Gemini SVG icons next to each CLI card header.
- **Dashboard: Squeezr logo in sidebar** — Added the green compression bars SVG logo next to the brand name.
- **Dashboard: removed uptime/Running** — Removed uptime counter from header and sidebar. Status now shows "Connected" instead of "Running 44s".
- **Project detection: fixed `github.com` false positive** — Fallback regex now excludes URLs (`://`), single-char segments, and common system dirs (`mnt`, `c`, `node_modules`, `.claude`, etc.). No longer extracts domain names from URLs in the system prompt.
- **`squeezr gain --sesion`** — Added Spanish typo alias for `--session`.

## [1.21.1] - 2026-04-10
### Fixed
- **Limits page now shows subscription rate limits** — Claude Code subscription (OAuth) uses `anthropic-ratelimit-unified-*` headers instead of standard per-minute limits. Squeezr now captures the 5-hour rolling window utilization (%), 7-day weekly ceiling utilization (%), and overage status. Dashboard shows these as filled gauges with proper labels ("5-hour window", "7-day window") instead of empty dashes.

## [1.21.0] - 2026-04-10
### Added
- **MCP auto-update notification** — Every MCP tool response now checks npm for newer versions (cached 30 min). When an update is available, appends `🆕 Squeezr vX.Y.Z available. Run: squeezr update` to the tool output so the user sees it naturally in the chat.

## [1.20.1] - 2026-04-10
### Fixed
- **Limits page gauges empty with subscription** — With Claude Code subscription (OAuth), the token/input/output gauges showed "—" even though usage data existed. Now displays session totals (total tokens, input, output, requests) in the gauge areas when rate limit headers are unavailable. Same fix for OpenAI.

## [1.20.0] - 2026-04-10
### Added
- **`squeezr gain --session`** — Live session savings fetched from the running proxy. Shows project name, uptime, breakdown, and by-tool stats.
- **`squeezr gain --details`** — All-time stats with by-tool breakdown.
- **AI compression cost deducted from NET** — When AI compression is active, the estimated token cost of Haiku/GPT-mini calls is now subtracted from NET saved, giving a true net figure.
- **MCP tool `squeezr_set_project`** — Manually set or clear the current project name. Useful when auto-detection shows the wrong name. Set persists until cleared or proxy restarts.
- **`/squeezr/project` REST endpoint** — GET returns current project, POST sets/clears manual override.
- **MCP `squeezr_stats` now includes savings breakdown** — Shows deterministic, AI compression, read dedup, system prompt, and tag overhead in the stats output.

### Fixed
- **Project detection extracted garbage from system prompt** — The fallback regex captured the first path segment after `/Users/` (e.g. "Ramos") instead of the actual project name. Now extracts the LAST meaningful segment, skipping common parent dirs (Users, Documents, home, etc.). For `C:\Users\Ramos\Documents\InvoiceApp` → now correctly returns "InvoiceApp".

### Improved
- **`squeezr gain` aligned box** — Fixed broken alignment where `│` borders didn't close correctly. All rows now use a fixed-width renderer that guarantees exact alignment.
- **`squeezr gain` shows chars + tokens** — Every savings line now shows both chars and approximate tokens side by side.
- **Hidden zero lines** — Lines with 0 savings (e.g. AI compression when not active) are hidden instead of showing "-0 chars".

## [1.19.0] - 2026-04-10
### Added
- **Honest `squeezr gain` with full savings breakdown** — Complete rewrite of the gain report. Now shows each savings source separately: deterministic preprocessing, AI compression, read-dedup, system prompt compression, tag overhead, and estimated AI compression cost. Displays NET savings instead of inflated totals. Warns when AI compression cost exceeds savings.
- **Dashboard: Savings Breakdown section** — New Overview panel showing real-time breakdown of savings by source (deterministic, AI, dedup, system prompt, overhead, AI calls).
- **Dashboard: Relative timestamps in History** — Session cards now show "2h ago", "yesterday", etc. alongside the time range.

### Fixed
- **Limits page showed all dashes with Claude Code subscription** — Claude Code with Max/Pro subscription uses OAuth (not API key), and Anthropic does not send `anthropic-ratelimit-*` headers for subscription users. The Limits page required these headers to show ANY data. Now shows usage counters (session/today input/output tokens) regardless of rate limit headers, with a "subscription" badge instead of "live". Same fix applied to OpenAI and Gemini.

### Improved
- **Dashboard: History filters empty sessions** — Sessions with 0 requests are no longer shown.
- **Dashboard: Budget bar updates on Save** — Clicking Save now re-renders the budget bar with current usage data instead of resetting to 0.
- **Dashboard: Mode change reverts on failure** — If the POST to `/squeezr/config` fails, the UI reverts to the previous active mode button instead of staying in a broken state.

### Fixed
- **Triangular accumulation bug in `stats.ts`** — `persist()` was writing cumulative session totals on each request instead of deltas, causing exponential inflation of saved chars. Now writes only the delta from each request.
- **Deterministic savings not counted** — `preprocessForTool()` savings (strip ANSI, collapse whitespace, git/test patterns) were logged but never included in `Savings`. Now tracked and reported.
- **Read-dedup savings not counted** — Duplicate file reads were collapsed but chars saved were not included in metrics. Now tracked and reported.
- **Tag overhead not subtracted from savings** — `buildAndCache()` calculated `savedChars = original - result` without accounting for the `[squeezr:XXXX -NN%]` tag added to each compressed block (~35 chars). Now uses `original - fullString` for accurate NET savings.
- **System prompt compression not tracked** — `compressSystemPrompt()` now returns original/compressed lengths; savings are tracked separately in stats.
- **Project detection was always 'unknown'** — `extractProjectName()` ran AFTER system prompt compression, which destroyed the `<cwd>` tags. Moved extraction before compression for both Anthropic and OpenAI handlers. Projects page now correctly detects and tracks per-project stats.
- **Gemini streaming token tracking broken** — SSE parser incorrectly used Anthropic event format (`message_start`/`message_delta`) for Gemini streams. Replaced with a JSON chunk parser that extracts `usageMetadata` from Gemini's actual streaming format.
- **OpenAI billing never populated in streaming mode** — `maybeRefreshOpenAIBilling()` was only called in the non-streaming path. Since Codex uses streaming exclusively, the Limits page never showed OpenAI credits/limits. Now called in both paths.
- **Streaming request count inflated 2x for Anthropic** — `addAnthropicUsage` incremented `requestsSession` on both `message_start` (input) and `message_delta` (output) SSE events. Now only counts on input tokens (one per request).
- **OpenAI billing `lastFetched` updated on failure** — If both billing API calls failed, the 5-minute cooldown still applied, preventing retries. Now only updates `lastFetched` when at least one request succeeds.
- **Budget tracker label mismatch** — Dashboard showed "tokens/month" but used daily counters that reset at midnight. Labels corrected to "tokens/day".
- **Budget save button triggered mode change** — The `#budget-save` button shared the `.mode-btn` class, causing mode buttons to deactivate visually when saving budget. Separated into its own class.
- **Dead code removed** — Unused `CHARS_PER_TOKEN` constant in `limits.ts`.

## [1.17.13] - 2026-04-10
### Fixed
- **SSL cert load failure on second terminal** — `ensureCA()` now always regenerates `bundle.crt` on startup instead of only on first run. Fixes the `warn: ignoring extra certs … load failed: error:10000002:SSL routines:OPENSSL_internal:system library` warning that appeared when opening a new Claude terminal.
- **System CA bundle removed from `bundle.crt`** — The bundle previously concatenated the system CA store (`/etc/ssl/certs/ca-certificates.crt`) which could contain certs that BoringSSL/Node.js rejects (notably in WSL). `bundle.crt` now contains only the Squeezr self-signed CA cert; Node.js trusts its own root CAs independently.

## [1.17.12] - 2026-04-06
### Added
- **Dashboard URL in banner** — `squeezr start`, `squeezr status`, and `squeezr update` now print `Dashboard: http://localhost:PORT/squeezr/dashboard` alongside the proxy URLs.
- **Dashboard port in `squeezr ports`** — Shows dashboard URL (shares the proxy port) in the current-ports summary.
### Fixed
- **`squeezr stop` now kills MCP server** — New `killMcpProcesses()` helper kills the `squeezr-mcp` Node process (stdio MCP server) when stopping. Uses PowerShell `Get-CimInstance` (replaces deprecated `wmic`) on Windows, `pkill` on Unix.
- **`squeezr update` uses same helper** — Replaced the broken `wmic` calls with `killMcpProcesses()`, which works on Windows 11 (wmic removed). Retry loop also uses it.
- **`squeezr uninstall` removes MCP registrations** — Calls `mcpUninstall()` before removing the npm package, cleaning `.claude.json`, Cursor, Windsurf, and Cline MCP configs automatically.

## [1.17.11] - 2026-04-06
### Fixed
- **SyntaxError on startup** — `mcpInstall()` was missing a closing `}` for the catch block (introduced in v1.17.6), causing `Unexpected end of input` on Node.js v24. All commands were broken on fresh installs. Also fixed `installed` counter not being incremented inside the try block.

## [1.17.10] - 2026-04-06
### Fixed
- **`squeezr update` EBUSY on Windows** — The MCP server process (`squeezr-mcp`) launched by Claude Code kept `dist/mcp.js` and other dist files locked, preventing npm from renaming the module directory. Fix: `update` now kills squeezr-mcp via `wmic` before installing, waits 2 s (up from 1 s), and retries npm install up to 4 times (3 s apart) on `EBUSY`/`EPERM` errors, with a broader wmic sweep on each retry. Clear error message if all retries fail.

## [1.17.9] - 2026-04-06
### Added
- **LIMITS dashboard page** — 5th sidebar page showing real-time rate limit gauges and token consumption per CLI.
- **Anthropic rate limits (live)** — `anthropic-ratelimit-*` headers extracted from every Anthropic response. Shows tokens/min remaining, requests/min remaining, input/output token sub-limits, and countdown to reset. Badge turns green on first data.
- **OpenAI rate limits (live)** — `x-ratelimit-*` headers extracted from every OpenAI response. Shows tokens/min and requests/min remaining with reset countdowns.
- **OpenAI billing** — `GET /v1/dashboard/billing/subscription` + `credit_grants` polled every 5 min using the API key seen in requests. Shows credit balance and hard limit in USD.
- **Gemini quota tracking** — Google does not expose quota headers on success; Squeezr records them when a 429 error occurs. Shows last known limit and 429 error count.
- **Token usage counters** — Input + output tokens accumulated from response bodies and SSE stream events (`message_start`, `message_delta` for Anthropic; final usage chunk for OpenAI). Shown per-CLI: session total and today total with automatic midnight rollover.
- **Personal monthly budget bar** — User enters a monthly token budget in the LIMITS page; Squeezr renders a progress bar with color-coded fill (green → yellow → red). Persisted in localStorage.
- **Reset countdown timer** — 1-second interval updates "resets in Xs" counters on rate limit gauges while the LIMITS page is visible.
- **`GET /squeezr/limits`** — New REST endpoint returning the full limits snapshot (rate limits + usage + billing).

## [1.17.8] - 2026-04-06
### Added
- **Dashboard sidebar navigation** — 4-page SPA: Overview, Projects, History, Settings. Replaces the single-page layout.
- **SVG icons throughout** — sidebar nav icons and compression mode buttons (Soft/Normal/Aggressive/Critical) now use clean SVG icons instead of emojis.
- **Per-project stats** — Squeezr detects which project is active by extracting the working directory from Claude Code's system prompt (`<cwd>` tag). Projects page shows aggregate stats across all sessions per project.
- **Session history** — History page shows all past proxy sessions grouped by project and day, with start/end time, duration, request count, and tokens saved. Persists to `~/.squeezr/history.json`.
- **Project-aware Overview** — project name badge shown in the dashboard header when a project is detected.
- **New API endpoints** — `GET /squeezr/history`, `GET /squeezr/projects`, `POST /squeezr/control/stop`.
- **MCP: squeezr_stop** — stop the proxy gracefully from any MCP-compatible AI CLI.
- **MCP: squeezr_check_updates** — check npm registry for newer Squeezr version.
- **MCP: squeezr_update** — update to latest version via `npm install -g squeezr-ai@latest`.

## [1.17.7] - 2026-04-06
### Fixed
- Removed stale `dist/cursorMitm.js` from npm package (leaked again after clean build). Added `prepack` script to auto-delete it permanently on every publish.

## [1.17.6] - 2026-04-06
### Added
- **Squeezr MCP server** — Universal MCP server (`squeezr-mcp`) compatible with Claude Code, Cursor, Windsurf, Cline, and any MCP-capable AI CLI. Exposes 5 tools:
  - `squeezr_status` — Check if proxy is running; returns version, port, uptime, compression mode.
  - `squeezr_stats` — Real-time token savings, compression %, cost saved estimate, per-tool breakdown.
  - `squeezr_set_mode` — Hot-reload compression mode (soft/normal/aggressive/critical) without restarting.
  - `squeezr_config` — Current thresholds, keepRecent, cache sizes, available modes.
  - `squeezr_habits` — Detects wasteful patterns this session (duplicate reads, excessive Bash calls, cache efficiency).
- **Auto-install on setup** — `squeezr setup` automatically registers the MCP server in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Windsurf, and Cline. Manual control via `squeezr mcp install` / `squeezr mcp uninstall`.

## [1.17.4] - 2026-04-06
### Fixed
- Repackage: removed in-progress `cursorMitm.js` that was accidentally included in 1.17.3 dist. No functional changes vs 1.17.3.
## [1.17.5] - 2026-04-06
### Added
- **Real-time web dashboard** — `GET /squeezr/dashboard` opens a live dark-theme dashboard. Updates every 2s via SSE. Shows tokens saved, compression %, requests, estimated cost saved, per-tool breakdown, sparkline chart, context pressure bars, and cache sizes.
- **Compression mode selector** — Switch 🐢 Soft / ⚖️ Normal / 🔥 Aggressive / 🚨 Critical from the dashboard with instant effect via `POST /squeezr/config { mode }`.
- **Hot-reload compression mode** — Mode changes take effect immediately without restarting the proxy. Overrides TOML thresholds and keepRecent in memory.
- **Port conflict auto-recovery** — On `EADDRINUSE`, Squeezr scans upward and binds to the first free port, printing a clear warning instead of crashing.
- **Dashboard URL on startup** — `http://localhost:PORT/squeezr/dashboard` printed when proxy starts.

## [1.17.3] - 2026-04-06
### Fixed
- **Critical: AI compression burst on first activation** — On first use with existing long conversations, ALL historical tool results were sent as simultaneous Haiku API calls via `Promise.allSettled`, consuming the entire Anthropic token quota in minutes. Now only tool results from the **current user message** (genuinely new blocks) are AI-compressed. All historical uncached blocks receive deterministic-only compression (free, no API calls).
- **Session cache and expand store persist to disk** — Both stores survive terminal restarts (`~/.squeezr/session_cache.json` and `~/.squeezr/expand_store.json`). On startup, previously compressed blocks are loaded from disk — reopening any terminal with a long conversation causes zero Haiku API calls. Caches flush every 60s and on SIGINT/SIGTERM.
- **Read tool excluded from AI compression by default** — Code files are never AI-summarized (destroys quality). Only free deterministic preprocessing is applied. Configurable via `ai_skip_tools` in `squeezr.toml`.
- **System prompt array format now compressed** — Claude Code sends `system` as an array (`[{type:'text', text:'...'}]`); the previous `typeof system === 'string'` guard was always `false`, silently skipping system prompt compression entirely.
- **`estimatePressure` includes system prompt size** — Context pressure was computed from message chars only, ignoring the large system prompt. Adaptive thresholds now account for the full context correctly.

## [1.17.2] - 2026-04-03
### Added
- **Cursor IDE subscription MITM proxy** — `squeezr cursor` starts an HTTP/2 MITM proxy on port 8082 that transparently intercepts Cursor's ConnectRPC traffic to `api2.cursor.sh`. Compresses conversation context using Cursor's own models (cursor-small) or deterministic preprocessing. Works with Cursor's subscription plan — no separate API key (BYOK) needed. Chat, Agent, and Composer modes are compressed; tab completions (cursor-small) are not interceptable. System proxy is configured/cleaned up automatically on start/stop.
- **Cursor BYOK support via tunnel** — `squeezr tunnel` starts a Cloudflare Quick Tunnel exposing the proxy as a public HTTPS URL. Use this URL in Cursor → Settings → Models → Override OpenAI Base URL to route Cursor chat/agent through Squeezr. No account or install required (uses `cloudflared` or `npx cloudflared@latest` as fallback).
- **Continue extension support** — VS Code and JetBrains Continue extension works directly with `apiBase: http://localhost:8080/v1`. No tunnel needed.
- **CORS middleware** — Cursor's Electron renderer sends OPTIONS preflight before every POST. The proxy now responds with `204 + Access-Control-Allow-*` headers so Cursor can connect without CORS errors. Has no effect on CLI tools.

## [1.17.1] - 2026-04-03
### Fixed
- **`HTTPS_PROXY` no longer set globally on macOS/Linux/WSL** — the same root cause as the Windows 502 bug in v1.17.0 was present in the Unix shell profile setup and the bash/zsh shell wrapper. `HTTPS_PROXY=http://localhost:8081` was being exported into `~/.zshrc`, `~/.bashrc`, and `~/.profile`, routing all HTTPS traffic (including Claude Code) through the MITM proxy and causing 502 errors on every request. Fixed in `setupUnix()`, `setupWSL()`, `installBashWrapper()`, and `configurePorts()`.
- **`SSL_CERT_FILE` no longer set globally** — this variable was pointing to a bundle containing only the Squeezr MITM CA cert (not the full system CA bundle), which would break TLS verification for all tools using OpenSSL. Replaced with `NODE_EXTRA_CA_CERTS` which is additive and safe.
- **macOS Keychain trust for MITM CA** — `squeezr setup` on macOS now adds the MITM CA certificate to the login Keychain so Codex (Rust binary) trusts the proxy's TLS certificate.

## [1.17.0] - 2026-04-03
### Added
- **Shell wrappers auto-refresh env vars** — `squeezr setup` and `squeezr update` install a shell wrapper (PowerShell on Windows, bash/zsh on Linux/macOS/WSL) that automatically applies env vars to the current session after `start`, `setup`, or `update`. No more closing and reopening terminals. Shows a one-time banner on first install. `squeezr uninstall` cleans it up.
- **`squeezr update` resolves the new binary correctly** — finds the freshly installed package via `npm root -g` and spawns the daemon directly. No stale version issues on WSL or Windows.

### Fixed
- **Node.js v24 compatibility** — strip `Expect` header from forwarded requests. Node 24's undici rejects this header, causing 500 errors on all proxied requests.
- **`HTTPS_PROXY` no longer set globally on Windows** — routing all HTTPS traffic through the MITM proxy broke Claude Code (502), npm (ECONNREFUSED), and other tools. `HTTPS_PROXY` is now only needed for Codex and should be set per-session.
- **`squeezr stop` clears `HTTPS_PROXY` from Windows registry** — cleans up the legacy entry left by older versions.
- **`squeezr update` no longer shows stale "Update available" banner** — update cache is written with the new version after install.

## [1.16.6] - 2026-04-03
### Fixed
- **`squeezr uninstall` now runs `npm uninstall -g`** automatically — full removal in one command, no manual step needed.
- **`update` and `uninstall` clear `HTTPS_PROXY` before npm commands** — prevents ECONNREFUSED when npm tries to go through the dead proxy.
- **Update banner no longer shows stale/inverted versions** — cache is cleared after `squeezr update`.

## [1.16.5] - 2026-04-03
### Fixed
- **Env vars now written to `~/.profile`** — fixes Claude Code 502 errors caused by env vars in `.bashrc` being skipped by the `case $-` interactive-shell guard. Login shells (and WSL default terminals) load `.profile` before `.bashrc`'s guard, so `ANTHROPIC_BASE_URL` is always available.
- **`squeezr uninstall` cleans `.profile`** too.

## [1.16.4] - 2026-04-03
### Added
- **`squeezr update`** — one command to kill all old processes (brute force on both ports), install latest from npm, and start the new version. Fixes 502 errors caused by stale processes surviving updates.
- Update notification banner now suggests `squeezr update` instead of `npm install -g`.

## [1.16.3] - 2026-04-03
### Added
- **Update notifications** — Squeezr checks npm for new versions every 4 hours (non-blocking, cached in `~/.squeezr/update-check.json`). Shows a banner after any command if a newer version is available.

## [1.16.2] - 2026-04-03
### Fixed
- **`squeezr ports` now applies changes immediately** — auto-stops and restarts the proxy after changing ports, updates shell profiles (Unix) and Windows registry (WSL) automatically. No more manual export/restart needed.
- **Port config reads from `squeezr.toml`** — all commands now read the HTTP port from toml as fallback when env var isn't set. Prevents port mismatch after `squeezr ports` in a fresh terminal.

## [1.16.1] - 2026-04-03
### Fixed
- **`squeezr stop` shows both ports** — output now matches `start` and `status` format, showing both HTTP and MITM proxy ports. Uses configured ports from `squeezr.toml` / env vars.

## [1.16.0] - 2026-04-03
### Added
- **`squeezr uninstall`** — completely removes Squeezr: stops proxy, removes env vars (Windows registry / shell profiles), removes CA from certificate store, removes auto-start (NSSM/Task Scheduler/launchd/systemd), deletes `~/.squeezr` and config.
### Fixed
- **Auto-restart on version mismatch** — `squeezr start` now checks if the running process version matches the installed version. If mismatched (e.g. after `npm update`), it auto-kills the old process and starts the new one. This was the root cause of 502 errors after updates.

## [1.15.0] - 2026-04-03
### Added
- **`squeezr ports` command** — interactive prompt to change HTTP proxy and MITM proxy ports. Updates `squeezr.toml` and env vars.
- **`mitmPort` config field** — MITM proxy port is now independently configurable via `mitm_port` in `squeezr.toml` or `SQUEEZR_MITM_PORT` env var. Defaults to `port + 1`.

## [1.14.14] - 2026-04-03
### Fixed
- **`start` and `already running` messages show both proxies** — output now lists HTTP proxy (:8080) and MITM proxy (:8081) with their purpose, matching `status` output.

## [1.14.13] - 2026-04-03
### Fixed
- **`squeezr stop` kills zombies** — now kills all processes on both port 8080 (HTTP proxy) and 8081 (MITM proxy) with `kill -9`. No more stale processes surviving a version update.
- **`squeezr status` shows both proxies** — output now lists both the HTTP proxy (Claude/Aider/Gemini) and MITM proxy (Codex) with their ports.

## [1.14.12] - 2026-04-03
### Fixed
- **Node 18 compatibility** — replaced `import.meta.dirname` (Node 22+) with `fileURLToPath(import.meta.url)` in config loader. Fixes crash on WSL/Linux with Node 18.

## [1.14.11] - 2026-04-03
### Changed
- Reverted Node 18 compat — set engines to `>=22`. (Reverted in 1.14.12)

## [1.14.10] - 2026-04-03
### Fixed
- **Version desync** — `version.ts` was hardcoded and never updated by `npm version`. Now reads version from `package.json` at runtime.

## [1.14.9] - 2026-04-03
### Fixed
- Same as 1.14.10 — initial fix for version desync.

## [1.14.8] - 2026-04-03
### Fixed
- **npm/git ECONNREFUSED** — the MITM proxy was TLS-terminating ALL CONNECT requests (npm, git, curl, etc.), causing failures when Squeezr was the system `HTTPS_PROXY`. Now only `chatgpt.com` gets TLS-terminated; all other domains get a transparent TCP tunnel. Removes `NO_PROXY` from setup since it's no longer needed.

## [1.14.7] - 2026-04-03
### Fixed
- **Codex CA trust on Windows** — Codex is a Rust binary that uses the Windows Certificate Store, not `NODE_EXTRA_CA_CERTS`. Setup now imports the MITM CA via `certutil -addstore -user Root` (no admin required) with machine-level fallback.
- **Docs rewrite** — README.md and CODEX.md fully rewritten with accurate architecture, per-platform CA trust, and configuration reference.

## [1.14.6] - 2026-04-03
### Fixed
- **Claude 502** — `forwardHeaders()` was passing the `Upgrade` header to undici's `fetch`, which throws `InvalidArgumentError: invalid upgrade header`. Added `upgrade` to `SKIP_REQ_HEADERS`. Root cause confirmed from production logs.

## [1.14.5] - 2026-04-03
### Fixed
- **Codex auth.openai.com blocked** — `HTTPS_PROXY` was intercepting ALL HTTPS traffic including OpenAI auth endpoints. Added `NO_PROXY` excluding `auth.openai.com`, `api.openai.com`, `api.anthropic.com` and others so only `chatgpt.com` WebSocket traffic goes through the MITM.
- **Codex JWT routed to Ollama** — `isLocalKey()` returned `true` for JWT tokens (`eyJ...`) because they don't start with `sk-`. Added `!k.startsWith('eyj')` check so Codex OAuth tokens route to OpenAI, not local.
- **OpenAI compression loop** — `compressWithGptMini()` inherited `openai_base_url=http://localhost:8080` from the environment, causing compression calls to loop back through Squeezr. Now hardcodes `baseURL: 'https://api.openai.com/v1'`.

## [1.14.4] - 2026-04-03
### Fixed
- **Codex routing** — `/responses` was still hitting Anthropic when no auth header present because `detectUpstream` defaults to Anthropic. Now `/v1/responses` explicitly forces upstream to OpenAI regardless of headers. Verified: request reaches `api.openai.com/v1/responses` correctly.

## [1.14.3] - 2026-04-03
### Fixed
- **Claude 502** — `compressWithHaiku()` was creating `new Anthropic()` without an explicit `baseURL`, so the SDK inherited `ANTHROPIC_BASE_URL=http://localhost:8080` from the environment and sent compression requests back to Squeezr itself, causing infinite recursion. Now always uses `https://api.anthropic.com` directly.
- **Codex 404** — catch-all was forwarding `/responses` to `api.openai.com/responses` (no `/v1/`). Added `/responses` to `NEEDS_V1` so it correctly maps to `/v1/responses`.
- **Codex auth** — Codex CLI does not include its OAuth Bearer token when `openai_base_url` points to a custom proxy. Squeezr now reads it from `~/.codex/auth.json` and injects it automatically when the outbound request has no `authorization` header.

## [1.14.2] - 2026-04-03
### Fixed
- **`squeezr setup` on Windows** — set `NODE_EXTRA_CA_CERTS` pointing to the MITM CA. Node.js (Codex CLI) does not use the Windows Certificate Store, so `certutil` alone was insufficient — the Codex process would reject the MITM certificate. `NODE_EXTRA_CA_CERTS` adds the CA to Node.js's trusted roots without replacing the default bundle.

## [1.14.1] - 2026-04-03
### Fixed
- **`squeezr setup` on Windows** — now sets `HTTPS_PROXY=http://localhost:8081` via `setx` so Codex MITM interception is configured automatically.
- **MITM CA trust on Windows** — after starting the proxy, setup waits for the CA cert to be generated and runs `certutil -addstore Root` to trust it in the Windows Certificate Store. Falls back with a manual command if admin is required.

## [1.14.0] - 2026-04-03
### Fixed
- **`squeezr setup` on Windows** — auto-start now uses NSSM when available, registering Squeezr as a proper Windows service with automatic restart on crash. Falls back to Task Scheduler if NSSM is not installed or admin privileges are missing. Eliminates `ConnectionRefused` errors caused by the proxy crashing mid-session without recovery.
- **NSSM service config** — stdout/stderr logs to `~/.squeezr/service-stdout.log` / `service-stderr.log` with 24h rotation and 3s restart delay.

### Added
- `NSSM_WINDOWS_SERVICE.md` — full guide covering installation, service creation, log inspection, troubleshooting, and uninstall.
- README — NSSM documented as recommended Windows auto-start method with quick-install commands.

## [1.13.1] - 2026-04-03

### Fixed
- **`squeezr stop` on WSL2** — `lsof -ti :PORT` returns multiple PIDs (listening process + connected clients); now uses `-sTCP:LISTEN` flag to get only the listening process, with fallback to `fuser`. Stops reliably on first try.
- **`squeezr setup` on Unix** — detects existing shell profiles missing `HTTPS_PROXY`/`SSL_CERT_FILE` (MITM proxy vars from older installs) and rewrites the block to include them.
- **`squeezr setup` on WSL2** — same fix as Unix: old profiles without MITM vars now get updated automatically.

## [1.13.0] - 2026-04-02

### Added
- **Codex MITM compression** — Squeezr can now compress OpenAI Codex CLI context in real-time. A TLS-terminating MITM proxy on port 8081 intercepts Codex's WebSocket traffic to `chatgpt.com`, finds `function_call_output` tool results exceeding the threshold, and compresses them via a separate WebSocket call to `gpt-5.4-mini` using the same ChatGPT OAuth token — no API keys needed, no extra costs beyond your existing Codex subscription.
- **WebSocket frame parser/builder** — full implementation of RFC 6455 frame encoding/decoding with masking support, used for both intercepting Codex frames and making compression requests.
- **Automatic `permessage-deflate` stripping** — the MITM strips `Sec-WebSocket-Extensions` from upgrade requests so frames arrive as plain text, avoiding deflate context desync when modifying payloads.
- **`chatgpt-account-id` capture** — intercepted from HTTP requests and forwarded to compression calls for proper account scoping.

### Changed
- **MITM proxy rewritten** — replaced the broken HTTP POST compression approach (Cloudflare 403) with direct WebSocket-to-WebSocket compression. The proxy now opens a dedicated WS connection to `chatgpt.com/backend-api/codex/responses` for each compression call.
- Removed unused dependencies: `ws`, `fzstd`, `@types/ws`.
- Removed unused `oauthRefresh.ts`.

## [1.12.0] - 2026-04-02

### Added
- **Codex MITM proxy (experimental)** — HTTPS proxy on port 8081 with auto-generated CA for TLS termination. Intercepts `CONNECT` tunnels, generates per-host certificates, and supports WebSocket upgrade detection. `squeezr setup` now configures `HTTPS_PROXY` and `SSL_CERT_FILE` environment variables for Codex integration.
- **`node-forge` dependency** — for CA/certificate generation.

## [1.11.3] - 2026-04-02

### Fixed
- **Codex WebSocket proxy** — Codex v0.118 uses WebSocket (`ws://`) for the Responses API. Squeezr now upgrades HTTP connections on `/responses` and `/v1/responses` to a bidirectional WebSocket proxy that forwards to `wss://api.openai.com`. Includes automatic ChatGPT OAuth token refresh on `401` mid-stream.
- **WebSocket routing for OAuth tokens** — ChatGPT OAuth bearer tokens (JWTs starting with `eyJ`) were incorrectly detected as local Ollama keys, routing WebSocket traffic to `ws://localhost:11434` instead of `wss://api.openai.com`. Fixed by excluding JWT-format tokens from the local-key check.
- **OAuth token proxy** — added `/oauth/token` pass-through so Codex can use `CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://localhost:PORT/oauth/token` when needed.
- **`/models` path rewrite** — catch-all now rewrites bare `/models` (and other OpenAI root paths) to `/v1/models` so Codex model enumeration works correctly.

## [1.11.2] - 2026-04-02

### Fixed
- **Codex / OpenAI Responses API support** — Codex CLI uses the Responses API (`POST /responses`) instead of Chat Completions. Squeezr now has dedicated routes for both `/responses` and `/v1/responses` with full streaming (SSE pipe-through), compression of `function_call_output` tool results, and correct header forwarding. Previously these requests fell through to the catch-all, which blocked indefinitely on streaming responses and caused 401 errors.
- **Catch-all streaming** — the catch-all handler now detects `text/event-stream` responses and pipes them through correctly instead of buffering the full response with `arrayBuffer()`.

## [1.11.1] - 2026-04-01

### Fixed
- **Daemon resilience** — `squeezr start` now survives Ctrl+C and terminal close. The daemon ignores `SIGINT` and `SIGHUP`; only `squeezr stop` (which sends `SIGTERM`) can stop it. Dev mode (`npm run dev`) still responds to Ctrl+C as before.

## [1.11.0] - 2026-04-01

### Added
- **WSL2 support** — `squeezr setup` now detects WSL2 automatically. Configures both the WSL shell profile (`.bashrc`/`.zshrc`) and Windows environment (`setx`). Auto-start cascades: systemd → Windows Task Scheduler → shell auto-heal.
- **Auto-heal guard** — on all Unix platforms (macOS, Linux, WSL2), `squeezr setup` adds a shell profile snippet that checks if the proxy is alive on every terminal open and starts it in the background if not. Zero manual intervention after setup, ever.

## [1.10.1] - 2026-04-01

### Added
- **`squeezr setup`** — one-command setup on any OS. Sets `ANTHROPIC_BASE_URL`, `openai_base_url`, `GEMINI_API_BASE_URL` permanently and registers Squeezr as a login service (Task Scheduler on Windows, launchd on macOS, systemd on Linux). After running `squeezr setup` once and restarting the terminal, everything works automatically.

## [1.10.0] - 2026-04-01

### Added
- **OAuth / subscription support** — Claude Code via claude.ai subscription (no API key) now works fully. Squeezr extracts the `Authorization: Bearer` token and reuses it for Haiku compression calls, so no extra credentials are needed regardless of how you authenticate.
- **`skip_tools` / `only_tools` config** — explicit control over which tools Squeezr compresses. `skip_tools = ["Read"]` blacklists specific tools; `only_tools = ["Bash"]` whitelists (takes priority over skip_tools).
- **`# squeezr:skip` inline marker** — add anywhere in a Bash command to prevent that specific result from being compressed (e.g. `git diff HEAD~3  # squeezr:skip`). Supported in Anthropic and OpenAI formats.
- **10 new tests** — `shouldSkipTool` logic in config (7 cases), skip/only/inline-skip in compressor (3 cases) (190 total)

### Changed
- `Config.shouldSkipTool(name)` method: checks `onlyTools` whitelist first, then `skipTools` blacklist
- `squeezr.toml`: added commented-out examples for `skip_tools`, `only_tools`, and inline `# squeezr:skip`
- Published as `squeezr-ai` on npm (name `squeezr` was taken by an unrelated image tool)

## [1.9.0] - 2026-04-01

### Fixed
- **Health endpoint returned `v1.0.0`** — `GET /squeezr/health` now returns the real version. Introduced `src/version.ts` as single source of truth; `index.ts` and `server.ts` both import from it. No more manual version drift across files.
- **`squeezr discover` showed `readDedup: 0`** — cross-turn Read dedup runs in `compressor.ts`, not `deterministic.ts`. Added exported `hitPattern()` to `deterministic.ts` and call it from the dedup step.

### Added
- **Cross-turn Read dedup for OpenAI/Gemini** — parity with Anthropic format. `compressOpenAIMessages` and `compressGeminiContents` now detect and collapse duplicate file reads.
- **Adaptive deterministic patterns at high context pressure** — patterns now receive the request's `pressure` value and tighten thresholds automatically:
  - `git diff` at >90%: 0 context lines per hunk (was always 1)
  - `git log` at >75%: cap 20 commits; at >90%: cap 10 (was always 30)
  - `grep` at >75%: 6 matches/file; at >90%: 4 (was always 8)
  - generic truncation at >90%: keep last 30 lines from 50-line threshold (was 80/50)
- `pressure` param threaded through `preprocessForTool` → `applyBashPatterns` (backward-compatible default = 0)

## [1.8.0] - 2026-04-01

### Added
- **Per-project `.squeezr.toml`** — Squeezr now looks for `.squeezr.toml` in the working directory and deep-merges it over the global config. Enables per-repo overrides (thresholds, compression model, etc.)
- **Cross-turn Read deduplication** — when the model reads the same file multiple times in a session, earlier occurrences are replaced with `[same file content as a later read — squeezr_expand(id) to retrieve]`. Keeps the most recent copy at full fidelity; collapses all earlier identical reads.
- **`squeezr discover`** — pattern coverage CLI that queries the running proxy and prints which deterministic patterns fired, how many outputs hit the generic fallback, and Read/Grep/Glob breakdown. Run after a session to spot coverage gaps.
- **Pattern hit tracking** — `detPatternHits` counter in `deterministic.ts` tracks every pattern match; exposed via `/squeezr/stats` as `pattern_hits`
- **README badges** — npm version, license, Node.js version, test count
- `src/discover.ts` new CLI command

### Changed
- `bin/squeezr.js`: added `discover` subcommand, bumped version string to 1.8.0

## [1.7.0] - 2026-04-01

### Added
- **Stack trace deduplication** — repeated Node.js/Python stack frames collapsed to `[same N-frame stack trace repeated]`; runs in base pipeline before per-tool patterns
- **Git diff function summary** — large diffs (>100 output lines) get a `Changed: fn1, fn2, ...` prefix extracted from `@@` headers
- **Semantic Read for large code files** — `.ts/.js/.py/.go/.rs` files >500 lines show imports + top-level signatures only, bodies omitted; smaller files keep head+tail
- 6 new tests (180 total)

### Changed
- `deduplicateStackTraces` runs before `deduplicateLines` in base pipeline (block-level dedup must precede line-level dedup)

## [1.6.0] - 2026-03-31

### Added
- **Playwright test compaction** — strips passing `✓` lines, keeps `✘`/FAILED blocks with context
- **Python/pytest compaction** — keeps `FAILED`/`ERROR` lines + tracebacks, strips passing dots
- **Go test compaction** — keeps `--- FAIL` blocks + `FAIL` summary, strips `--- PASS`
- **Terraform compaction** — keeps resource change blocks + Plan summary, strips attribute noise
- **`git branch` compaction** — caps at 20 branches with omission note
- **wget compaction** — strips progress/connection noise, keeps final URL + save path
- **Generic error extractor** — auto-extracts error lines ± context from any unrecognised output > 30 lines with > 50% noise (replaces manual `rtk err <cmd>` prefix)
- 15 new tests (174 total)

### Fixed
- `looksLikeGitBranch` false positive on Playwright output (now requires pure `[* ] identifier` branch name pattern, no colons/parens/brackets)

## [1.5.0] - 2026-03-31

### Added
- **`git status` compaction** — detects and compacts to `* branch [tracking] + Staged/Modified/Untracked` format (RTK parity)
- **`git log --oneline` detection** — caps at 30 commits with `... [N more commits]` (full verbose format was already supported)
- **`pnpm list` / `npm list` compaction** — keeps direct deps, strips nested tree with omission count
- **`pnpm outdated` compaction** — caps at 30 packages
- **Prisma CLI compaction** — strips ASCII box-drawing tip blocks, keeps meaningful output
- **`gh pr checks` compaction** — caps large check tables at 25 rows
- **Generic long-output truncation** — any unrecognised bash output > 80 lines gets last 50 lines + omission note (replaces the overly-broad docker logs detector)
- 20 new tests covering all new patterns (159 total)

### Fixed
- `looksLikePkgList` false-positive on Prisma box-drawing output (now requires `├──` not just `└──`)
- `looksLikeKubectl` false-positive on `gh pr checks` header (now requires specific kubectl column patterns)
- `compactGitStatus` on clean working tree now shows "nothing to commit" message

## [1.4.0] - 2026-03-31

### Added
- **Full unit test suite** — 139 tests across 6 test files covering all modules: `deterministic.ts`, `cache.ts`, `sessionCache.ts`, `expand.ts`, `config.ts`, `compressor.ts`

### Fixed
- `extractInstallSummary` regex `/\d+ packages? in/` → `/\d+ packages? in \d/` to prevent false matches on `packages installed`

## [1.3.0] - 2026-03-31

### Added
- **Full RTK pattern parity** — Squeezr now covers all major RTK tool patterns at the proxy level. No manual `rtk` prefix needed for any of these:
  - **git**: `diff` (context reduction to 1 line/hunk), `log` (one line per commit)
  - **cargo**: `test` (failures only), `build/check/clippy` (errors/warnings only, no "Compiling X" spam)
  - **JS/TS**: `vitest/jest` (failures only + summary), `tsc` (errors grouped by file), `eslint/biome` (grouped, no rule URLs), `prettier --check` (files needing format only), `next build` (route table + errors only)
  - **package managers**: `pnpm/npm install` (summary line only)
  - **Docker**: `ps` (compact), `images` (no dangling, short IDs), `logs` (last 50 lines)
  - **kubectl**: `get` (compact column alignment)
  - **gh CLI**: `pr view` (metadata only), `run list` (capped), `issue list` (capped)
  - **curl**: strip verbose `-v` headers, keep response body
- **Grep tool compaction** — matches grouped by file, capped at 8 per file, max 30 files
- **Read tool compaction** — files >200 lines show head + tail with omission note; lockfiles replaced with summary count

## [1.2.0] - 2026-03-31

### Added
- **RTK-style turn-1 compression** — `preprocessForTool()` applies tool-specific deterministic patterns to ALL tool results including recent ones. No need to prefix commands with `rtk`. Covers: `git diff` (context line reduction), `cargo test/build/clippy` (errors/failures only), `vitest/jest` (failures only), `tsc` (errors grouped by file), `eslint/biome` (grouped, no rule URLs), `pnpm/npm install` (summary only), `Glob` (compact file listings).
- **Deterministic compression is now always on, even for recent blocks** — previously only AI compression was skipped for recent blocks. Now all blocks get at minimum the RTK-style pass.

## [1.1.0] - 2026-03-31

### Added
- **Differential compression** — session-level cache tracks compressed blocks across requests. Blocks identical to a previous request skip the entire pipeline (preprocessing + AI call). In a 100-request session with 40 tool results: ~4,000 Haiku calls → ~200.
- **KV cache warming** — `storeOriginal` now uses a deterministic MD5-based ID instead of random bytes. Identical content always produces the same `[squeezr:id -ratio%]` string, preserving Anthropic's prefix cache across requests (90% cost reduction on unchanged history).
- `sessionCache.ts` — in-memory Map persisting for the lifetime of the proxy session
- `session_cache_hits` counter in stats summary and `/squeezr/stats` endpoint
- `session_cache_size` exposed in `/squeezr/stats`

## [1.0.0] - 2026-03-31

### Changed
- **Full TypeScript rewrite** — entire codebase migrated from Python to TypeScript/Node.js
- **Hono** replaces FastAPI as the HTTP framework — faster startup, no Python runtime needed
- No more `pip install` — pure npm package, install with `npm install -g squeezr`
- Requires Node.js 18+ (was Python 3.9+)

### Added
- **Deterministic preprocessing pipeline** (6 stages before AI compression): strip ANSI codes, strip progress bars, strip timestamps, deduplicate repeated lines, minify inline JSON, collapse whitespace
- **`expand()` feature** — model can call `squeezr_expand(id)` to retrieve original content when needed; Squeezr intercepts the tool call and makes a continuation request transparently
- **Gemini CLI support** (`POST /v1beta/models/*`) — compresses `functionResponse` blocks using Gemini Flash 8B
- **Per-format compression**: Anthropic `tool_result`, OpenAI `role:tool`, Gemini `functionResponse`
- **`GET /squeezr/expand/:id`** endpoint to retrieve stored originals via HTTP
- LRU compression cache with configurable max entries
- System prompt compression with separate cache (`~/.squeezr/sysprompt_cache.json`)
- `src/gain.ts` — TypeScript gain stats CLI replacing `gain.py`

## [0.6.0] - 2026-03-31

### Added
- **Ollama / local LLM support** — requests with dummy keys (`ollama`, `lm-studio`, etc.) are detected as local and routed to Ollama
- **Configurable compression model** — set any model you have installed via `squeezr.toml [local] compression_model` or `SQUEEZR_LOCAL_MODEL` env var
- **`[local]` config section** in `squeezr.toml` with `upstream_url`, `compression_model`, and `dummy_keys`
- `config.is_local_key()` detects local requests from auth key
- `compress_local_messages()` uses Ollama's OpenAI-compatible `/v1` endpoint for compression
- `SQUEEZR_LOCAL_UPSTREAM` and `SQUEEZR_LOCAL_MODEL` env var overrides

### Changed
- `/v1/chat/completions` now checks for local key before routing to OpenAI
- Version bumped to 0.6.0

## [0.5.0] - 2026-03-31

### Added
- **Gemini CLI support** — `/v1beta/models/{model}:generateContent` endpoint intercepts and compresses Gemini requests
- **Gemini Flash 8B compression** — cheapest Google model compresses `functionResponse` parts, reuses `x-goog-api-key` from request
- **Gemini system instruction compression** — `systemInstruction` field compressed via Flash 8B and cached
- **Gemini streaming** — `streamGenerateContent` SSE forwarded transparently
- `system_prompt.py` now supports `use_google=True` for Gemini system prompts
- `extract_google_key()` reads `x-goog-api-key` header or `?key=` query param
- `detect_upstream()` now identifies Google API from headers

### Changed
- `_stream()` helper accepts optional `params` dict for query string forwarding
- Version bumped to 0.5.0

## [0.4.0] - 2026-03-31

### Added
- **OpenAI / Codex CLI support** — `POST /v1/chat/completions` endpoint proxies and compresses Codex requests
- **GPT-4o-mini compression for Codex** — reuses the OpenAI key already in the request, no extra keys needed
- **Smart upstream detection** — catch-all route detects Anthropic vs OpenAI from headers and forwards to the right API
- **OpenAI system message compression** — first `role: "system"` message compressed via GPT-4o-mini
- `openai>=1.0.0` added to requirements

### Changed
- `system_prompt.py` now accepts `use_openai=True` to compress via GPT-4o-mini
- `main.py` refactored: shared `_stream()` helper, dedicated OpenAI endpoint
- Version bumped to 0.4.0

## [0.3.0] - 2026-03-31

### Added
- **System prompt compression** — Haiku compresses Claude Code's ~13KB system prompt on first request and caches it. Estimated -40% per request.
- **Adaptive thresholds** — compression aggressiveness scales with context pressure: low/mid/high/critical tiers based on % of context used
- **Compression cache** — repeated tool results are served from `~/.squeezr/cache.json` at zero Haiku cost. Hit rate shown in `/squeezr/stats`
- **Conversation compression** — opt-in (`compress_conversation = true` in `squeezr.toml`) to also compress old user/assistant messages
- **Auto-start on login** — `install.sh` configures launchd (macOS) or systemd (Linux); `install.ps1` registers a Windows Task Scheduler task
- **`squeezr.toml` config file** — all settings editable in TOML, env vars still override
- **Dry-run mode** — set `SQUEEZR_DRY_RUN=1` to see what would be compressed without modifying requests
- Cache stats (`size`, `hits`, `misses`, `hit_rate_pct`) exposed in `/squeezr/stats`
- Context pressure logged when above 50%

### Changed
- `config.py` reads from `squeezr.toml` first, env vars override
- `requirements.txt` adds `tomli` for Python < 3.11
- Version bumped to 0.3.0

## [0.2.0] - 2026-03-31

### Added
- `gain.py` CLI command — shows token savings with breakdown by tool (Bash, Read, Grep, etc.)
- Per-tool savings tracking in stats (count, chars saved, avg compression %)
- Efficiency bar visualization (24-char block meter)
- Stats persistence to `~/.squeezr/stats.json` across proxy restarts
- `--reset` flag for `gain.py` to clear saved stats
- Tool name extraction from `tool_use` blocks to enrich compression reporting

### Changed
- `stats.py` now tracks `by_tool` breakdown per request
- `compressor.py` now returns tool names alongside savings data
- Version bumped to 0.2.0

## [0.1.0] - 2026-03-31

### Added
- Local API proxy that intercepts Claude Code requests to Anthropic API
- Semantic compression of old tool results using Claude Haiku
- Configurable compression threshold (`SQUEEZR_THRESHOLD`, default 800 chars)
- Configurable recent context preservation (`SQUEEZR_KEEP_RECENT`, default 3 tool results)
- Real-time per-request savings logging to console
- `/squeezr/stats` endpoint for session summary
- `/squeezr/health` endpoint
- Catch-all route to forward any Anthropic endpoint without modification
- Full streaming support (SSE passthrough)
- `install.sh` for macOS/Linux
- `install.ps1` for Windows
