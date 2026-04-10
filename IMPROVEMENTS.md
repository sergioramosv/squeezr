# Squeezr — Mejoras para ser más potente sin perder calidad

## 🔴 TIER 1 — Alto impacto, poco esfuerzo

### 1. Extend dedup a Bash y Grep (no solo Read)
Hoy solo deduplica `Read` repetidos. Pero `git status` 5 veces = 5x el mismo output.
Detectar outputs idénticos de Bash/Grep entre requests y colapsarlos igual que Read.
- **Ganancia estimada:** 10-15% en sesiones con retries/loops
- **Riesgo de calidad:** CERO (el original se guarda en expand store)
- **Archivos:** `src/compressor.ts` (3 handlers)

### 2. Cross-session cache precarga
Al arrancar, cargar las últimas 100 compresiones del disco (`session_cache.json`).
Si el hash coincide con un tool result nuevo, reutilizar sin re-comprimir.
- **Ganancia:** +15-20% hit rate desde la primera request
- **Riesgo:** CERO (los hashes son exactos)
- **Archivos:** `src/sessionCache.ts`

### 3. Threshold por herramienta
Bash genera output denso (errores, diffs) → comprimir antes (threshold=600).
Read genera código estructurado → dejar más contexto (threshold=1200).
Grep siempre es compactable → threshold=400.
```toml
[compression.tool_thresholds]
bash = 600
read = 1200
grep = 400
glob = 300
```
- **Ganancia:** +5-10% eficiencia global
- **Riesgo:** BAJO (ajustable por usuario)
- **Archivos:** `src/config.ts`, `src/compressor.ts`

### 4. Pattern Inspector en dashboard
Nueva sección en Overview que muestra qué patrones determinísticos están funcionando:
```
gitDiff      ████████ 45 hits  -12,340 chars
readHeadTail ██████   28 hits  -8,200 chars
deduplicateLines ████ 15 hits  -3,100 chars
```
Los datos ya están en `pattern_hits` — solo falta la visualización.
- **Archivos:** `src/dashboard.ts`

### 5. Settings page con controles reales (no read-only)
Hoy Settings solo muestra valores. Agregar:
- Slider de threshold (50-3000)
- Slider de keep_recent (0-10)
- Checkbox: compress system prompt
- Botón: Clear session cache
- Botón: Clear LRU cache
- Botón: Download stats.json
- **Archivos:** `src/dashboard.ts`, `src/server.ts` (ampliar POST /squeezr/config)

---

## 🟡 TIER 2 — Impacto medio, esfuerzo medio

### 6. Stacked bar de savings por fuente
Visualización en Overview que muestra de dónde viene cada ahorro:
```
[██████████ Deterministic 72%] [████ Dedup 12%] [██ SysPrompt 10%] [░ Overhead 6%]
```
Los datos ya están en `breakdown` — solo falta el render con CSS bars.
- **Archivos:** `src/dashboard.ts`

### 7. Compression Heatmap por herramienta
```
Bash (git diff)     ██████████  94% savings
Bash (npm install)  ████████░░  83%
Read (*.ts)         ██░░░░░░░░  15%
Grep (src/)         ██████░░░░  62%
```
Identifica qué herramientas se benefician más/menos de la compresión.
- **Archivos:** `src/dashboard.ts` (render), `src/stats.ts` (ya tiene by_tool)

### 8. Predicción de agotamiento en Limits
```
Anthropic tokens/min: 45K used, 5K remaining
⚠ At current pace, exhausted in ~6.7 seconds
[▓▓▓▓▓▓▓▓▓░] 90% — switch to critical mode?
```
- **Archivos:** `src/dashboard.ts`, `src/limits.ts`

### 9. Página de auditoría de compresión AI
Mostrar las últimas 20 compresiones AI:
```
Original (chars) | Compressed | Ratio | Model  | Time
1,200           | 180        | 85%   | Haiku  | 240ms
[expandable: ver original vs comprimido side-by-side]
```
Permite verificar que la AI no borra info crítica.
- **Archivos:** `src/compressor.ts` (guardar historial), `src/dashboard.ts` (nueva página)

### 10. Log aggregation pattern (Docker, npm, Maven)
Nuevo patrón determinístico para logs repetitivos:
```
[INFO] Processing file X
[INFO] Processing file Y
... [1000 more lines]
→ [INFO] Processing file X ... +999 similar lines
```
Aplica a: docker logs, npm install verbose, Maven/Gradle builds, k8s logs.
- **Ganancia:** 20-40% en deployment outputs
- **Archivos:** `src/deterministic.ts`

### 11. Validación de system prompt compression
Nunca comprimir chunks que contengan `NEVER`, `MUST`, `CRITICAL`, `IMPORTANT`.
Preservar siempre: nombres de herramientas, reglas de comportamiento, constraints.
- **Riesgo actual:** system prompt compression puede borrar instrucciones críticas
- **Archivos:** `src/systemPrompt.ts`

---

## 🟢 TIER 3 — Nice to have

### 12. Comparativa cross-session en History
```
Session A (10:00-10:30): 15K tokens saved, 45% rate
Session B (11:00-11:45): 12K tokens saved, 42% rate
Δ: -3K tokens (-20%), deterministic +5%
```

### 13. Config hot-reload completo
POST `/squeezr/config` acepta todos los parámetros, no solo `mode`:
```json
{ "threshold": 500, "keep_recent": 2, "skip_tools": ["read"] }
```

### 14. Per-request compression detail log
Guardar JSON de cada request con desglose:
```json
{
  "timestamp": "...",
  "tool_results": [{
    "tool": "Bash",
    "original": 2000,
    "compressed": 150,
    "method": "deterministic",
    "pattern": "gitDiff"
  }]
}
```
Habilita análisis post-hoc y endpoint queryable `/squeezr/stats?from=T1&to=T2`.

### 15. ROI Calculator
```
Session: ~45K tokens saved → $0.68 avoided
Compression cost: $0.004 (45 Haiku calls)
NET: $0.676 (ROI: 169x)
```

### 16. Budget alerts en terminal
```
[squeezr] ⚠ 78% of daily budget used. At this pace, limit in ~2.3h.
[squeezr] 💡 Switch to critical: squeezr mode critical
```

### 17. Implementar `compress_conversation`
El `squeezr.toml` tiene `compress_conversation = false` pero NO está implementado.
Comprimir mensajes user/assistant antiguos (no solo tool results).

---

## Patrones determinísticos — Auditoría de agresividad

### ⚠ Demasiado agresivos (riesgo de perder info)
| Patrón | Problema | Fix |
|--------|----------|-----|
| `compactGitDiff` (presión alta) | Pierde contexto de diff | Siempre guardar mínimo 1 línea contexto |
| `compactPkgList` | Omite dependencias anidadas | Hacer configurable, warning si omite >50 paquetes |
| `compactReadOutput` | head/tail puede omitir bugs en medio del archivo | Priorizar extracción de exports/funciones |
| `stripTimestamps` | Puede perder contexto temporal | Solo strip si hay >10 timestamps seguidos |

### ✅ Seguros (no pierden info útil)
- git status, log, branch
- tsc, eslint, prettier errors
- docker ps/images, kubectl get
- gh pr/run/issue
- stripAnsi, deduplicateLines, deduplicateStackTraces
- minifyJson

---

## Resumen ejecutivo

| Área | Mejoras | Impacto total |
|------|---------|---------------|
| Compresión sin AI | Dedup Bash/Grep, cross-session cache, threshold por tool | +20-30% ahorro |
| Compresión con AI | Threshold por tool, system prompt validation | +5-10% calidad |
| Dashboard | Pattern inspector, heatmap, stacked bars, settings controls | Visibilidad real |
| Nuevos patrones | Log aggregation, JSON dedup | +10-20% en enterprise |
| Predicción | Budget alerts, rate limit ETA | Prevención de sorpresas |
