# Squeezr 2.0 — Roadmap

> Qué hace falta para que Squeezr sea una **2.0 de verdad** y no un número inflado.
>
> Premisa: los **8 puntos del plan headroom→squeezr** (recorte de salida, SmartCrusher JSON,
> `learn`, benchmarks, AST tree-sitter, TextCrusher, cache-detector, doctor) nos ponen **a la
> par de headroom en features**. Estar a la par NO es una 2.0. Una 2.0 es cuando Squeezr deja
> de ser "un headroom en Node" y se vuelve algo que ellos no son.
>
> Este documento cubre los dos pilares que van **por encima** de los 8 puntos:
> **A)** lo que *gana* el número mayor (breaking, legítimo SemVer), y
> **B)** la capacidad estrella (el foso / moat).

Estado: propuesta. Fecha: 2026-07-21. Versión base al escribir: 1.83.0.

---

## A. Lo que "gana" el número mayor (breaking — legítimo SemVer)

Sin esto, técnicamente sigue siendo 1.x aunque le pongas un 2 en la caja. Una 2.0.0 en
SemVer significa **rompo compatibilidad**. Los 8 puntos son todos aditivos y opt-in (MINOR);
estos dos cambios son los que de verdad justifican el salto de major.

### A.1 — Rediseño del esquema de configuración

**Problema.** Hoy `[compression]` acumula ~25 flags sueltas por acreción histórica
(`ai_compression`, `compress_system_prompt`, `compress_conversation`, `compress_tool_inputs`,
`tool_desc_*` ×5, `stale_*` ×3, `mcp_*` ×2, `skip_tools`, `only_tools`, `ai_skip_tools`…).
Es difícil de razonar y de documentar.

**Cambio.** Reorganizar el `squeezr.toml` en namespaces claros:

```toml
[input]     # todo lo que comprime lo que ENTRA (tool results, system prompt, tool descs, MCP)
[output]    # recorte de salida (ya introducido en 1.83.0)
[ai]        # backend, master switch, min-chars, rate-limit, guardrails
[safety]    # bypass, circuit-breaker, cache-barrier, structured/compressibility guards
```

**Por qué es breaking (y por tanto major).** El toml viejo deja de mapear 1:1.

**Mitigación obligatoria.** **Migración automática** del `~/.squeezr/squeezr.toml` viejo al
nuevo esquema en el primer arranque de la 2.0 (leer flags antiguas → escribir nuevas →
backup del original). El usuario no debe tocar nada a mano. Un cambio de esquema **con
migración automática** es el motivo canónico y limpio de una 2.0.

### A.2 — Cambiar los defaults a los seguros de alto valor

**Problema.** Las dos mayores ganancias baratas y sin riesgo están **OFF por defecto**:
`tool_desc_compress` (≈17–23K tokens/request) y, en general, el aprovechamiento pleno del
pipeline determinista. Instalar Squeezr hoy no ahorra hasta que el usuario configura.

**Cambio.** Encender por defecto lo que es **determinista y seguro**:

- `tool_desc_compress = true` (con `tool_desc_expand = true`, ya recuperable).
- Dedup determinista y patrones tool-specific: confirmados ON.
- **Se mantienen OFF por defecto** los que tocan comportamiento o cuestan: `ai_compression`,
  `[output].enabled`, `compress_tool_inputs` (este último NUNCA on — corrompió código en disco,
  ver 1.82.0).

**Por qué es major.** Cambia el comportamiento de fábrica: instalar y actualizar a 2.0 empieza
a comprimir solo. Eso es un cambio de contrato observable → MAJOR.

**Regla de oro.** Ningún default nuevo puede: (a) tocar el prefijo cacheado, (b) hacer una
llamada facturable con token OAuth, ni (c) mutar bytes que van a disco. Solo se encienden
transformaciones **deterministas, cache-safe y reversibles**.

---

## B. La capacidad estrella (el foso — elegir 1, no las 3)

Esto es lo que le da **titular** a la 2.0. Son tres candidatos; la recomendación es hacer
**uno** bien, no los tres a medias.

### B.1 — Zest como clasificador entrenado (no generativo) — RECOMENDADO

**El salto más grande y el foso más difícil de copiar.**

Hoy Zest es un LLM pequeño que **reescribe** el bloque (generativo). Eso implica: latencia
alta, no determinista (riesgo de romper el prompt-cache si el output varía entre requests),
y riesgo de omitir un token crítico (mitigado con guardrail + retry, pero sigue ahí).

**Cambio.** Reentrenar/reconvertir Zest en un **clasificador keep/drop por token** (la
arquitectura de Kompress-v2 de headroom: encoder tipo ModernBERT con cabeza de clasificación
binaria por token + cabeza de importancia de span), exportado a **ONNX** y servido local.

**Ventajas frente al enfoque actual:**

- **Determinista** → mismo input, mismo output byte a byte → **cache-safe por diseño**
  (no dependemos del guardrail para no romper el cache).
- **Milisegundos**, no segundos: corre en el request-path sin timeouts ni circuit-breaker.
- **Extractivo**: solo conserva/elimina tokens del original, nunca inventa → imposible que
  corrompa un path/error/identificador (se pueden forzar como must-keep, como hace Kompress).
- Es **exactamente el moat de headroom** y ya tenemos (a) el modelo base (Qwen3.5-0.8B → Zest)
  y (b) los datos: sesiones reales capturadas + `session_cache.json` con 161 bloques ya
  comprimidos que sirven de señal de entrenamiento.

**Coste.** Es el punto más caro: requiere pipeline de entrenamiento (etiquetado keep/drop a
partir de las compresiones buenas ya validadas), export ONNX y runtime en Node
(`onnxruntime-node`). Pero es lo que convierte "otro proxy de compresión" en "el compresor con
modelo propio".

### B.2 — Modo librería (`import { compress } from 'squeezr'`)

Headroom lo tiene y Squeezr no: además de proxy, exponer una API embebible
(`compress(messages, opts)`) para usar Squeezr dentro de apps y SDKs, no solo delante de un
CLI. Multiplica el mercado (cualquier app Node que llame a Anthropic/OpenAI puede embeberlo).
Menos foso que B.1, pero mucho más barato y abre integraciones.

### B.3 — Multi-proveedor de primera

Codex / Gemini / Cursor tan bien tratados como Anthropic (el MITM ya está hecho; falta pulir
paridad de pipeline y stats por proveedor). Convierte Squeezr de "add-on de Claude Code" a
"plataforma de compresión". Foso medio; sobre todo amplía alcance.

### B.4 — Caché/RAG de consultas frecuentes (opt-in, medido)

**Idea (Sergio).** Cachear consultas frecuentes por sesión/proyecto (tipo RAG) para que, en
vez de releer código o rebuscar en internet, se consulte primero esa caché y se reutilice la
respuesta si es relevante. Manu: buena idea, pero **hay que testear y comparar con y sin (A/B)**.

**Encaje honesto.** Es una capacidad **B-tier adicional**, NO la que "gana" el número mayor
(eso lo hace el pilar A). Es aditiva y opt-in, así que por sí sola sería MINOR; entra en 2.0
como extra de valor, no como espina dorsal. Framear siempre como opt-in y **medido**, nunca
como default.

**Decisiones v1** (Karajan researcher + architect, 2026-07-21):

- **Mecanismo:** Fase 0 = *spike* para investigar si el proxy puede suprimir un `tool_use`
  NATIVO (Read/WebSearch) y responderlo local (santo grial: evita el re-read). Fallback:
  tool inyectado voluntario `squeezr_cache_query` estilo `expand.ts`.
- **Alcance:** dos capas — proyecto (base) + sesión (fresca encima).
- **Matching v1:** solo **md5-exacto** (cero falsos positivos). BM25/SimHash quedan para v2+
  detrás de flag con presupuesto de error medido.
- **A/B (Manu):** replay **offline** sobre el corpus de `requestCapture` extendiendo `bench.ts`
  (brazo control sin caché vs brazo caché). Un brazo de control en vivo está prohibido por la
  regla de oro (re-facturaría con el OAuth del usuario).

**Riesgo nº1: staleness.** Servir un Read de un archivo ya editado o un WebSearch obsoleto =
respuesta mal en silencio. Invalidación estricta (mtime+size para Reads, TTL para web) y
**miss ruidoso**, nunca silent fallback. Toda sustitución gateada por `hasCacheMarkers` (para
no romper la prompt-cache) y recuperable vía `squeezr_expand`.

**Reutiliza** todo lo existente sin dependencias nuevas: `cache.ts`, `sessionCache`, `expand.ts`,
`relevance.ts` (BM25, v2), `jsonCrush.ts` (SimHash, v2), `requestCapture` (redacción), `bench.ts`,
`stats.ts`. Plan detallado y por fases en **[`QUERY_CACHE_PLAN.md`](../QUERY_CACHE_PLAN.md)**.

---

## Mejoras adicionales apuntadas para 2.0

- **Compresor de código con tree-sitter (AST real)** — upgrade del punto 5. Hoy (1.87.0) la
  extracción de estructura es "AST-lite" por heurísticas/regex (ts/py/go/rs/java/c/cpp), sin
  dependencias, que es lo correcto para vistas de lectura recuperables vía expand. Para 2.0,
  `web-tree-sitter` + gramáticas daría salida **siempre reparseable** y ranking de funciones
  por importancia. Se dejó fuera de la 1.x a propósito porque añade MB de WASM y erosiona la
  ventaja "un comando, un runtime"; entra en 2.0 como mejora fuerte, no como sustituto.

## Veredicto

**Squeezr 2.0 = los 8 puntos (paridad) + A (config limpia con migración + defaults que ahorran
solos) + B.1 (Zest clasificador determinista).**

La **caché/RAG (B.4)** viaja como **extra opt-in y medido**, no como lo que justifica el major
(eso sigue siendo el pilar A). Se lanza cuando su A/B offline demuestre ahorro real.

Posicionamiento que lo cierra y que headroom no puede reclamar con la misma fuerza:

> **"Squeezr 2 — el optimizador de contexto y salida para el ecosistema Claude que ahorra de
> fábrica y con un modelo propio determinista que jamás rompe tu prompt-cache."**

(El pilar C — ahorro *medido* con holdout + suite de accuracy publicada + arnés de regresión
de cache — no se detalla aquí por petición; queda como el tercer pilar de credibilidad para
acompañar el lanzamiento.)
