# Reinventar la compresión IA de Squeezr — diseño basado en datos reales

> Análisis de las sesiones reales del usuario (2026-06-04). El objetivo: que la
> compresión IA sea la insignia de Squeezr y suba el ahorro MUY por encima del
> ~14% determinístico actual, SIN romper el prompt cache de Anthropic (el bug que
> reventó el plan hoy).

## 1. Qué aprendimos del incidente

- La compresión IA **rompía el prompt cache de Anthropic**: cada request mutaba el
  prefijo en sitios distintos (Haiku no-determinista + cap rotativo de 5) → cache
  miss permanente → Anthropic re-facturaba el contexto completo (~180k tokens) a
  precio full cada turno. ~50% del plan de 5h en 10 min.
- Conclusión: **comprimir el prefijo no es el problema; comprimirlo de forma
  INESTABLE sí lo es.**

## 2. Datos reales — ratio de compresión IA por tamaño de bloque

De `session_cache.json` (161 bloques ya comprimidos por el AI en producción):

| Tamaño bloque | n   | Ratio medio | Cuántos EXPANDEN |
|---------------|-----|-------------|------------------|
| < 500 chars   | 85  | **−22.7%**  | 37 (¡expande!)   |
| 500–2k        | 66  | +41.9%      | 1                |
| 2k–5k         | 8   | +75.8%      | 0                |
| 5k–20k        | 2   | +91.6%      | 0                |

**Lección:** el AI es contraproducente en bloques pequeños (los alarga) y brutal
en grandes. Umbral mínimo seguro: ~800–1500 chars. Nunca tocar < 800 con AI.

## 3. Datos reales — distribución de tamaños (capture req-0020, 126 tool_results)

| Categoría             | Bloques | Chars    | % del total |
|-----------------------|---------|----------|-------------|
| ≥ 2k (AI gana 75-91%) | 23      | 260,546  | **87%**     |
| 800–2k (AI ~42%)      | 16      | 19,279   | 6%          |
| < 800 (AI expande)    | 87      | 20,814   | 7%          |

**Pareto puro:** 23 bloques (18%) tienen el 87% del contenido. Comprimir SOLO esos
con AI captura casi todo el beneficio con cero riesgo de expansión.

**Potencial medido:** comprimir big(80%) + mid(42%) = **~217k chars (~62k tokens)
ahorrados de 300k = 72% de compresión sobre los tool_results** de ese request.

## 4. Arquitectura propuesta: compresión IA estable, persistente, cache-safe

### Principio
Anthropic cachea lo que le mandas. Si le mandas el historial **comprimido** y ese
comprimido es **byte-idéntico entre requests**, Anthropic cachea la versión
comprimida y cada request siguiente paga cache-read sobre MENOS tokens. Ahorras Y
mantienes el cache.

### Reglas (todas verificadas contra los datos)
1. **Solo AI en bloques ≥ 1500 chars** (donde gana ≥75% y nunca expande). Los
   pequeños → determinística o intactos.
2. **Cada bloque se comprime UNA vez** y el resultado se guarda en un caché
   persistente en disco (`hash(original) → comprimido`). Nunca se re-comprime.
3. **Siempre se aplica la versión cacheada** (no rotativo, no "5 por request").
   Esto hace el prefijo byte-estable → cache de Anthropic válido.
4. **Determinismo del modelo:** squeezr-1B en greedy (temp=0) es determinista. Con
   el caché persistente, incluso Haiku queda estable (el resultado se fija en la
   primera compresión y no se vuelve a llamar).
5. **Coste:** 1 llamada AI por bloque único (amortizada) + 1 cache miss la primera
   vez que un bloque del prefijo se comprime. Después: ahorro permanente.

### Rollout seguro (sin repetir el incidente)
- Empezar con `backend=local` (squeezr-1B, gratis) para que las pruebas no gasten
  plan. Haiku solo opt-in con API key facturada aparte.
- Rate-limit duro ya existe (20 calls/5min).
- Bypass persistente ya existe (parada de emergencia).
- Medir cache_creation vs cache_read tokens de las cabeceras de Anthropic para
  confirmar en vivo que NO se rompe el cache (siguiente paso de instrumentación).
- Activar gradualmente: primero medir en dry-run, luego 1 conversación, luego todo.

## 5. Números esperados

Hoy (solo determinística, cache-safe): **~14%**.
Con AI estable sobre bloques grandes: **~50–72%** de compresión sobre los
tool_results, manteniendo el cache. El ahorro neto real dependerá de cuánto del
contexto son tool_results grandes (en las sesiones del usuario: la mayoría).

## 6. Estado / siguientes pasos

- [ ] Subir el umbral AI a ≥1500 chars (los datos lo exigen — evita expansión).
- [ ] Caché de compresión persistente en disco (hoy `session_cache.json` es por
      sesión; hacerlo all-time y SIEMPRE-aplicar).
- [ ] Quitar el cap rotativo de 5 → comprimir todos los bloques grandes elegibles
      una vez, de forma estable.
- [ ] Instrumentar cache_creation/cache_read de Anthropic en el dashboard.
- [ ] Probar con squeezr-1B local (gratis) antes de Haiku.
