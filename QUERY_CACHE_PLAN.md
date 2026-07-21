# Query/RAG Cache — Plan (B-tier capability, opt-in)

> Idea (Sergio): cachear consultas frecuentes por sesión/proyecto (tipo RAG) para,
> en vez de releer código o rebuscar en internet, consultar primero esa caché.
> Manu: buena idea, pero hay que testear y comparar con y sin (A/B).
>
> Estado: **planificado, no en el roadmap actual**. No es un default: opt-in + medido.
> Investigado por Karajan (researcher + architect). Veredicto: viable con restricciones duras.

## Decisiones tomadas (Sergio, 2026-07-21)
1. **Mecanismo v1**: hacer primero un **spike** que investigue si el proxy puede
   suprimir un `tool_use` NATIVO del cliente (Read/WebSearch) y responderlo local.
   Es el santo grial (evita el read de verdad); si no es factible, se cae al
   fallback de tool inyectado voluntario (estilo `expand.ts`).
2. **Alcance**: **dos capas** — proyecto (base persistente) + sesión (capa fresca por encima).
3. **Matching v1**: **solo md5-exacto**. Cero falsos positivos. BM25/SimHash quedan
   fuera de v1 (detrás de flag y con presupuesto de error medido, para v2).
4. **A/B**: **replay offline** sobre el corpus de `requestCapture` en `bench.ts`
   (brazo control = sin caché vs brazo caché). Nada de A/B en vivo (re-facturaría).

## Reglas innegociables (GOLDEN RULE)
- No mutar el prefijo cacheado. Gating obligatorio por `hasCacheMarkers`/`cacheBarrier`.
- Ninguna llamada facturable con el OAuth del usuario.
- Todo lo sustituido debe ser recuperable vía `squeezr_expand` (`storeOriginal`).
- No persistir secretos: reutilizar la redacción de `requestCapture`.
- No silent fallbacks: ante cualquier duda de frescura → **miss ruidoso**, nunca servir stale.

## Arquitectura (interceptor por capas sobre el proxy actual)
Reutiliza infraestructura existente, **cero dependencias nuevas** (embeddings/ONNX excluidos):
`cache.ts` (LRU md5), `sessionCache` (atomic write), `expand.ts` (short-circuit precedente),
`relevance.ts` (BM25, v2), `jsonCrush.ts` (SimHash, v2), `requestCapture` (redacción),
`stats.ts`/`dashboard.ts`, `bench.ts`.

Capas: interceptación → gating (opt-in + hasCacheMarkers + scope) → retrieval (md5-exacto)
→ invalidación (mtime+size para Reads, TTL para web) → store (md5→entry, atomic, LRU acotado)
→ recoverabilidad (expand) → redacción → medición A/B.

## Fases

### Fase 0 — SPIKE de factibilidad (BLOQUEANTE, time-box ~4h)
Determina toda la arquitectura. Objetivo: ¿puede el proxy interceptar un `tool_use`
nativo de Read/WebSearch en la respuesta del modelo y satisfacerlo localmente sin que
el cliente ejecute la herramienta, y sin romper la prompt-cache en Claude Code?
- Salida: documento corto SPIKE_TOOLUSE.md con veredicto factible / no factible.
- Gate: si NO factible → v1 = tool inyectado voluntario `squeezr_cache_query` (expand-style).

### Fase 1 — Store + clave exacta + invalidación (~150 LOC + tests)
- `queryCache.ts`: `getQueryCache(config)` singleton (espejo de `getCache`).
  Entradas `QueryCacheEntry{key,kind,payloadRef(expandId),savedChars,originalChars,createdAt,lastUsedAt,hits}`.
  Store content-addressable md5, atomic tmp+rename, LRU acotado (`queryCacheMaxEntries`).
- Dos capas: `queryCacheScope: 'project' | 'session' | 'layered'` (default `layered`).
- Invalidación: `ReadProvenance{absPath,mtimeMs,sizeBytes}` → miss si cambia; `WebProvenance{query,url,fetchedAt,ttlMs}` → miss al expirar.
- Config opt-in: `queryCacheEnabled: false` por defecto + `queryCacheWebTtlMs`, `queryCacheKeyMode: 'exact'`.
- Tests: hit/miss md5, invalidación por mtime/size, TTL web, recoverabilidad vía expand,
  cache-safety (no sustituir con cache markers presentes).

### Fase 2 — Harness A/B offline (~120 LOC + tests)
- `benchQueryCache({arm:'control'|'cache', corpus})` extendiendo `bench.ts`.
- Replay determinista sobre `~/.squeezr/captures/`. Reporta delta compression% + fact-recall.
- Contadores aislados `queryCache_*` en `stats.ts` (no doble contar con session_cache/expand).

### Fase 3 — Wiring (según Fase 0)
- Si spike OK: short-circuit del tool_use nativo, gateado por hasCacheMarkers.
- Si no: tool inyectado `squeezr_cache_query(kind, query|path)` interceptado local.

### Fase 4 — Observabilidad + docs
- Superficie en `dashboard.ts` y `/status`. CHANGELOG.md (bump versión → commit).
- README de la feature (opt-in, cómo correr el A/B).

## Riesgos y mitigaciones
- Staleness (nº1): invalidación estricta mtime/size + TTL, miss ruidoso.
- Prompt-cache: gating hasCacheMarkers idéntico a toolResultDedup/diffRead.
- Falsos positivos: v1 solo md5-exacto (0 falsos).
- Crecimiento disco: LRU acotado + atomic write, tercer store.
- Privacidad: redacción requestCapture antes de persistir.
- A/B: replay offline (no hay brazo de control en vivo posible).
