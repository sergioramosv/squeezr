# Squeezr — Architecture Reference

> Based exclusively on source code as of 2026-05-22. Nothing inferred or invented.

---

## 1. Qué es Squeezr

Squeezr es un **proxy HTTP local** que se interpone entre cualquier cliente AI (Claude Code, Claude Desktop, Codex Desktop/CLI, Aider, Gemini CLI, Cursor, Windsurf, Cline, etc.) y las APIs upstream de Anthropic, OpenAI y Google Gemini.

El proxy escucha en **dos puertos**:

| Puerto | Función |
|--------|---------|
| `8080` (configurable) | Proxy HTTP plano — recibe requests de Claude Code, Aider, Gemini CLI, Claude Desktop. Configurado via `ANTHROPIC_BASE_URL`, `GEMINI_API_BASE_URL`, `openai_base_url`. |
| `8081` (configurable, `mitmPort = port + 1`) | Proxy MITM con intercepción TLS — usado por Codex CLI que hace HTTPS directo. Configurado via `HTTPS_PROXY`. |

El proxy:
1. Recibe el request completo del cliente AI.
2. Aplica el pipeline de compresión sobre los tool results (y opcionalmente el system prompt).
3. Reenvía el request modificado a la API upstream real.
4. Devuelve la respuesta al cliente sin modificarla (salvo interceptar `squeezr_expand`).

---

## 2. Pipeline de compresión — orden exacto de pasos

El pipeline se ejecuta **una vez por request** que llega al proxy. Los pasos son idénticos para Anthropic y OpenAI (Gemini es análogo). El código está en `compressor.ts`, funciones `compressAnthropicMessages`, `compressOpenAIMessages`, `compressGeminiContents`.

### Paso 0 — Read dedup (cross-turn)

Antes de cualquier otra cosa, se escanean **todos** los tool results de tipo `Read` en la conversación completa de derecha a izquierda (el más reciente primero). Si el mismo contenido de fichero aparece varias veces, todas las ocurrencias anteriores a la más reciente se reemplazan con:

```
[same file content as a later read in conversation — squeezr_expand(<id>) to retrieve]
```

El ID es el hash MD5 del contenido original (6 chars), almacenado en el expand store para que el modelo pueda recuperarlo. Las posiciones deduplicadas se marcan en `dedupedSet` y se saltan en todos los pasos siguientes.

### Paso 1 — Compresión determinística (todos los bloques)

Se ejecuta `preprocessForTool(text, toolName, pressure)` sobre **todos** los tool results (incluidos los recientes, es decir los del turno actual). No hay excepciones por recencia aquí.

El resultado reemplaza el contenido del bloque en la copia de los mensajes si cambia. Se acumula `detSaved` para estadísticas.

### Paso 2 — AI compression (solo bloques históricos grandes)

1. Se calculan los **candidatos**: todos los tool results excepto los `keepRecent` más recientes.
2. De esos candidatos se filtran los que superan el **threshold** de caracteres (por defecto 800, adaptativo según presión de contexto) y no están en `dedupedSet`.
3. Si quedan candidatos, se consulta el **circuit breaker**: si está open, se saltea el paso 2 completamente.
4. Si `dryRun` está activo, se loguea lo que se haría y se retorna sin comprimir.
5. Para cada candidato se comprueba la **session cache** (`getBlock(hashText(text))`):
   - Si hay hit: se reutiliza el `fullString` exacto ya comprimido (preserva KV cache).
   - Si hay miss y AI está habilitado y el bloque es genuinamente nuevo (del último mensaje del usuario): se encola para AI compression.
   - Si hay miss pero el bloque es histórico (no del último turno): se salta la AI compression para ese bloque (previene burst en activación inicial).
6. Los bloques nuevos a comprimir se pasan a `runCompression()` que llama al backend AI en paralelo con `Promise.allSettled`.
7. Los resultados se escriben en la copia de mensajes con el formato `[squeezr:id -ratio%] resultado`.
8. Se llama a `buildAndCache()` que: genera el ID determinístico (MD5 6 chars), construye el `fullString`, calcula el `savedChars` neto (original menos fullString incluyendo el tag), y guarda en session cache y expand store.

---

## 3. Qué comprime y qué NO comprime

### Se comprimen
- **Tool results** (`role: "user"`, `type: "tool_result"` en Anthropic; `role: "tool"` en OpenAI; `parts[].functionResponse` en Gemini).
- El **system prompt** si tiene más de 2000 caracteres y `compressSystemPrompt` está habilitado (por defecto: sí). Se comprimen los bloques `type: "text"` del array `system`, o el string `system` directamente.

### NO se comprimen
- Mensajes de texto del usuario (`role: "user"` con `type: "text"`).
- Mensajes del asistente (`role: "assistant"`).
- Tool calls (el assistant solicitando llamar a una herramienta).
- Los `keepRecent` tool results más recientes (por defecto: los últimos 3) son excluidos de la AI compression (pero sí pasan por la compresión determinística).
- Tool results de herramientas en `aiSkipTools` (por defecto: `['read']`) solo pasan por determinística, no por AI compression.
- Tool results de herramientas en `skipTools` se excluyen completamente.
- Bloques ya deduplicados por read-dedup.
- Cuando `isBypassed()` es true: nada se comprime en absoluto.
- Cuando `config.disabled` es true: se devuelven los mensajes sin modificar.

### Distinción clave
La compresión determinística (Paso 1) se aplica a **todos** los tool results incluidos los recientes. La AI compression (Paso 2) solo se aplica a los históricos que superan el threshold.

---

## 4. keepRecent

`keepRecent` es un entero (por defecto 3, configurable en `squeezr.toml` como `keep_recent`) que define cuántos tool results del final de la conversación quedan protegidos de la **AI compression** (pero no de la determinística).

En código:
```typescript
const candidates = allResults.slice(0, Math.max(0, allResults.length - effectiveKeepRecent(config)))
```

Si hay 10 tool results y `keepRecent = 3`, los candidatos a AI compress son los primeros 7. Los últimos 3 se omiten de candidatos.

`effectiveKeepRecent` devuelve `runtimeOverrides.keepRecent` si está definido (set por modo), o `config.keepRecent` del TOML.

En los modos predefinidos:
- `soft`: keepRecent = 10
- `normal`: keepRecent = 3
- `aggressive`: keepRecent = 1
- `critical`: keepRecent = 0 (todo es candidato)

---

## 5. Compresión determinística — patrones exactos

El código está en `src/deterministic.ts` (935 líneas).

### Pipeline base (`preprocess(text)`)

Se ejecuta sobre todos los tool results (excepto `Read`, que usa `preprocessRead`). Orden:

1. **Normalizar CRLF → LF** (`\r\n` → `\n`, `\r` → `\n`)
2. **`stripAnsi`**: elimina secuencias de escape ANSI (`\x1B[...m`), OSC (`\x1B]...\x07`), y caracteres de control.
3. **`stripProgressBars`** (NO se aplica a `Read`): filtra líneas donde el contenido no-whitespace/no-barra es menos del 30% de la longitud y longitud ≤ 5. Elimina barras de progreso visuales.
4. **`stripTimestamps`**: elimina ISO 8601 (`2024-01-01T12:00:00Z`), timestamps entre corchetes `[12:00:00]`, y timestamps al inicio de línea.
5. **`deduplicateStackTraces`**: identifica bloques de stack trace (líneas que empiezan con ≥2 espacios seguidos de `at `, `File "` o `in <`). Si el mismo bloque de ≥3 frames aparece más de una vez, las repeticiones se reemplazan con `... [same N-frame stack trace repeated]`.
6. **`deduplicateLines`**: para líneas que aparecen 3 o más veces, solo mantiene la primera aparición y añade `... [repeated N more times]`.
7. **`minifyJson`**: busca objetos JSON de más de 200 chars embebidos en el texto y los minifica con `JSON.stringify(JSON.parse(...))`.
8. **`collapseWhitespace`**: elimina espacios/tabs al final de línea, colapsa 3+ líneas en blanco a 2, trim global.

### Patrones específicos por herramienta (`preprocessForTool`)

Después del pipeline base, se aplica lógica específica según el nombre de la herramienta:

**`read`** — usa `preprocessRead` (igual que base pero sin `stripProgressBars`) + `compactReadOutput`:
- Si ≤ 200 líneas: sin truncado.
- Si es lockfile (`integrity sha`, `"resolved"`, `# yarn lockfile`): reemplaza todo el contenido con `[lockfile — N lines, ~M packages — omitted to save tokens]`.
- Si > 500 líneas y es código reconocible (TS/JS, Python, Go, Rust): extrae solo las líneas estructurales (imports, exports, funciones, clases, tipos) y añade `... [N implementation lines omitted]`.
- Si > 200 líneas y no es código: mantiene primeras 100 + últimas 80 líneas con `... [N lines omitted]`.

**`bash`** — detección por contenido y aplicación del primer patrón que coincide (en orden):
| Patrón | Detección | Transformación |
|--------|-----------|----------------|
| `gitDiff` | contiene `diff --git` o `--- a/` y `+++ b/` | Mantiene headers, hunks `@@`, líneas `+`/`-`, y N líneas de contexto (0 si pressure ≥ 0.9). Si > 100 líneas, prepende resumen de funciones cambiadas. |
| `gitLog` | empieza con `commit ` y tiene `Author:`/`Date:`, o ≥3 líneas con hash hex 7-12 chars | Compacta a una línea por commit; cap de 30/20/10 commits según presión. |
| `gitStatus` | empieza con `On branch ` o `HEAD detached at` | Extrae rama, staged/modified/untracked como listas compactas. |
| `gitBranch` | >80% de líneas son branch names (sin colons ni espacios medios) | Si ≤ 20 ramas: sin cambios. Si > 20: mantiene rama actual + 15 primeras + cuenta omitidas. |
| `cargoTest` | contiene `test ... ok` o `test ... FAILED` | Extrae solo bloques FAILED, errores `error[`, panics; o la línea `test result:` si no hay fallos. |
| `cargoBuild` | contiene `error[E\d+]` o `Compiling` + `error`/`warning` | Extrae diagnósticos `error[...]`/`warning[...]` con sus localizaciones `-->` y `|`. |
| `vitest` | contiene `✓`/`✕`/`×` y `Test Files`/`PASS`/`FAIL` | Extrae líneas de fallo, AssertionError, Expected/Received, y líneas de resumen. |
| `playwright` | contiene `playwright` o `.spec.ts` y `passed`/`failed`/`Error` | Extrae bloques de test fallido con sus detalles; omite tests que pasaron. |
| `pyTraceback` | contiene `Traceback (most recent call last)` o `FAILED` + `.py::` | Extrae tracebacks completos y líneas `FAILED`/`ERROR`. |
| `goTest` | contiene `--- PASS:`/`--- FAIL:` o `ok`/`FAIL` + ns | Extrae solo tests fallidos y líneas de resumen. |
| `tsc` | contiene `error TS\d+:` | Agrupa errores por fichero, muestra hasta 5 errores por fichero. |
| `eslint` | contiene `\d+:\d+  error`/`warning` | Mantiene líneas de error (sin URLs), cabeceras de fichero y resumen. |
| `prettier` | contiene `[warn]` + `needs formatting` | Mantiene ficheros con problemas y línea de resumen. |
| `nextBuild` | contiene `Next.js` + `Route (` o `Failed to compile` | Mantiene tabla de rutas, errores, y `First Load JS`. |
| `pkgInstall` | contiene `added N package` o `packages are looking for funding` | Extrae solo líneas de resumen (added, removed, Done in, vulnerabilities). |
| `pkgList` | contiene `├──` + `@` o `v\d+` | Mantiene paquetes directos (hasta 60) + cuenta de paquetes anidados. |
| `pkgOutdated` | contiene `Current  Wanted  Latest` | Si ≤ 30 líneas: sin cambios. Si > 30: cap a 30 + cuenta omitidas. |
| `terraform` | contiene `will be created`/`destroyed`/`must be replaced` | Extrae líneas de resumen de cambios y plan summary. |
| `npx` | contiene `npm warn` o `Packages: N installed` | Elimina ruido de instalación npx, mantiene output real. |
| `dockerPs` | contiene `CONTAINER ID` + `IMAGE` | Acorta IDs de contenedor a 12 chars. |
| `dockerImages` | contiene `REPOSITORY` + `TAG` + `IMAGE ID` | Elimina imágenes dangling `<none>`, acorta IDs. |
| `kubectl` | empieza con `NAME  READY  STATUS` o `NAME  STATUS  ROLES` etc. | Colapsa múltiples espacios a dobles. |
| `prisma` | contiene `prisma` + `┌`/`└─` | Elimina cajas de decoración `┌...└`. |
| `ghPrChecks` | contiene `CONCLUSION` + `success`/`failure` (sin `WORKFLOW`) | Cap a 25 líneas. |
| `ghPr` | contiene `title:`/`state:`/`url:` + `github.com` | Mantiene metadata clave, elimina body largo. |
| `ghRunList` | contiene `STATUS` + `CONCLUSION` + `WORKFLOW` | Cap a 20 líneas. |
| `ghIssueList` | contiene `ISSUE` + `TITLE` + `STATE` | Cap a 25 líneas. |
| `curl` | contiene `* Connected to` o >3 líneas `>` | Elimina cabeceras verbose (`>`, `*`), mantiene body. |
| `wget` | contiene `--` + `Resolving`/`Connecting to`/`saved [` | Mantiene solo líneas de resultado final. |
| Generic error extractor | output > 30 líneas y hay líneas de error pero < 50% del total | Extrae líneas con `Error`/`FATAL`/`failed` + 1 línea de contexto antes y después. |
| `truncated` (fallback) | cualquier otra cosa con > 80 líneas (50 si pressure ≥ 0.9) | Mantiene últimas 50 líneas (30 si pressure ≥ 0.9) con nota de omisión. |

**`grep`** — `compactGrepOutput`:
- Si < 20 líneas: sin cambios.
- Agrupa matches por fichero (formato `file:linenum:content`).
- Cap de 8 matches por fichero (6 si pressure ≥ 0.75, 4 si pressure ≥ 0.9).
- Cap de 30 ficheros totales.

**`glob`** — si > 30 ficheros: `compactFileListing` que muestra `N files total:` seguido de la lista de directorios con su conteo de ficheros.

### Tracking de patrones

Cada vez que se activa un patrón, se incrementa `detPatternHits[patternName]`. Este mapa se expone en `/squeezr/stats` como `pattern_hits` y es usado por `squeezr discover` para reportar cobertura.

---

## 6. Read dedup

Read dedup colapsa lecturas duplicadas del **mismo fichero** dentro de una conversación. Se ejecuta como Paso 0, antes de cualquier otra compresión.

**Algoritmo** (igual para Anthropic y OpenAI, análogo para Gemini):

1. Se itera sobre todos los tool results de tipo `Read` de **derecha a izquierda** (del más reciente al más antiguo).
2. Para cada bloque se calcula `hashText(text)` (MD5 hex).
3. Si el hash no se ha visto: se registra como "la versión más reciente" en `seenMostRecent` y se guarda su ID en `readHashToId` (el ID es el hash MD5 6-char del contenido, generado por `storeOriginal`).
4. Si el hash ya se ha visto: el bloque actual es una lectura más antigua del mismo fichero. Se reemplaza su contenido con:
   ```
   [same file content as a later read in conversation — squeezr_expand(<id>) to retrieve]
   ```
   Se añade al `dedupedSet` y se acumula `readDedupSaved`.

Resultado: solo permanece el read más reciente de cada fichero. Los anteriores quedan como referencias expandibles.

---

## 7. AI compression — cuándo se activa y qué hace

### Cuándo se activa

Un bloque entra en AI compression si cumple **todas**:
1. No está en `dedupedSet` (no fue deduplicado).
2. No está en los últimos `keepRecent` tool results.
3. Su longitud (tras determinística) es ≥ threshold.
4. El circuit breaker no está open.
5. `config.dryRun` es false.
6. El bloque **no tiene hit en session cache**.
7. `aiEnabled()` devuelve true.
8. El bloque proviene del **último mensaje del usuario** (para Anthropic: `c.index === lastMsgIdx`; para OpenAI: `c.index > newStartIdx`). Esta condición es clave: si en la primera activación hay 50 bloques históricos sin cache, solo los nuevos del turno actual se AI-comprimen para evitar un burst de llamadas.
9. La herramienta no está en `aiSkipTools` (por defecto `['read']` — el tool Read no va a AI compression).

### Qué modelo se usa por API

| API | Modelo de compresión |
|-----|----------------------|
| Anthropic (Claude Code) | `claude-haiku-4-5-20251001` via `compressWithHaiku` |
| OpenAI / Codex Desktop | `gpt-4o-mini` via `compressWithGptMini` |
| Gemini CLI | `gemini-1.5-flash-8b` via `compressWithGeminiFlash` |
| Ollama / local | modelo configurado en `localCompressionModel` (default: `qwen2.5-coder:1.5b`) via `compressWithOllama` |

**Importante**: el modelo de compresión siempre llama a la API real, nunca al proxy. El código hardcodea las URLs reales (`https://api.anthropic.com`, `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com`) para evitar recursión infinita.

### El prompt de compresión

```
You are compressing a coding tool output to save tokens.
Extract ONLY what is essential: errors, file paths, function names,
test failures, key values, warnings.
Be extremely concise, target under 150 tokens.
Output only the compressed content, nothing else.
```

Se pasan los primeros 4000 chars del bloque (ya preprocesado por determinística). Max tokens de respuesta: 300.

### LRU cache de compresión

Antes de llamar al API, se consulta `CompressionCache` (LRU en memoria, `cacheMaxEntries = 1000`). La key es el texto preprocesado. Si hay hit, se devuelve el resultado cacheado sin llamar al API.

### Después de la compresión

Se llama a `buildAndCache(original, result)`:
1. Calcula ratio: `Math.round((1 - result.length / original.length) * 100)`.
2. Genera ID: `storeOriginal(original)` → MD5 del original, 6 chars. El ID es determinístico: mismo contenido = mismo ID.
3. Construye `fullString`: `[squeezr:id -ratio%] resultado`.
4. Calcula `savedChars` = `original.length - fullString.length` (neto, contando el overhead del tag).
5. Guarda en session cache: `setBlock(hashText(original), { fullString, savedChars, originalChars })`.

---

## 8. Session cache

Fichero: `src/sessionCache.ts`. Almacén en memoria `Map<string, SessionBlock>`.

### Propósito doble

1. **Compresión diferencial**: si un bloque ya fue comprimido en un request anterior de la misma sesión proxy, se reutiliza inmediatamente sin pasar por determinística+AI.
2. **Preservación de KV cache**: Anthropic activa su KV cache solo cuando el prefijo del mensaje es byte-for-byte idéntico entre requests. Al reutilizar el mismo `fullString` exacto (incluido el `[squeezr:id -ratio%]` con ID determinístico), se garantiza que los tokens históricos ya cacheados en Anthropic no se invaliden.

### API

```typescript
hashText(text: string): string        // MD5 del texto original
getBlock(hash: string): SessionBlock  // lookup por hash
setBlock(hash: string, block: SessionBlock): void  // almacena
```

```typescript
interface SessionBlock {
  fullString: string      // "[squeezr:id -ratio%] resultado" — exactamente lo que se embebe
  savedChars: number      // chars ahorrados netos (original.length - fullString.length)
  originalChars: number   // longitud del original
}
```

### Persistencia en disco

- Se carga de `~/.squeezr/session_cache.json` al arrancar el proxy (`loadSessionCache()`).
- Se persiste a ese fichero en shutdown (`persistSessionCache()`).
- El fichero se deserializa directamente al Map en memoria.

### Cuándo se reutiliza

En el Paso 2 de compresión, para cada candidato a AI compression:
```typescript
const cached = getBlock(hashText(c.text))
if (cached) sessionHits.push(...)
else if (aiEnabled() && isNewBlock) toCompress.push(...)
```

Un session cache hit evita la llamada AI completamente y escribe el `fullString` almacenado directamente en el mensaje.

---

## 9. squeezr_expand — el expand store

Fichero: `src/expand.ts`. Almacén en memoria `Map<string, string>` (id → original).

### Mecanismo completo

1. **Al comprimir**: `buildAndCache` llama a `storeOriginal(original)`. Esta función calcula `md5(original).slice(0, 6)` como ID y guarda `store.set(id, original)`. El ID es determinístico.

2. **Inyección de herramienta**: En cada request procesado, antes de reenviar al upstream, se inyecta `squeezr_expand` en la lista de herramientas:
   - Para Anthropic: `injectExpandToolAnthropic(body)` añade la tool con `input_schema` si no está ya.
   - Para OpenAI: `injectExpandToolOpenAI(body)` añade la tool en formato OpenAI si no está ya.
   - Para Gemini: no se inyecta (sin tool injection en el código actual).

3. **Interceptación de respuesta**: Tras recibir la respuesta del upstream (solo non-streaming en el código actual):
   - Anthropic: `handleAnthropicExpandCall(responseBody)` busca en `response.content` un bloque `type: "tool_use"` con `name: "squeezr_expand"`. Si encuentra, extrae el `id` de `block.input.id`.
   - OpenAI: `handleOpenAIExpandCall(responseBody)` busca en `choices[0].message.tool_calls` una llamada a `squeezr_expand`. Parsea `arguments` como JSON y extrae `args.id`.

4. **Si hay expand call**: el proxy NO devuelve la respuesta al cliente. En cambio:
   - Recupera `original = retrieveOriginal(id)`.
   - Construye un turno de continuación que incluye el resultado de la herramienta con el contenido original.
   - Hace una segunda llamada a la API upstream con ese contexto extendido.
   - Devuelve esa segunda respuesta al cliente.
   - Se registra en `stats.recordExpand(true)`.

5. **Persistencia**: similar a session cache, se carga de `~/.squeezr/expand_store.json` al arrancar y se persiste en shutdown.

### Definición de la herramienta expuesta al modelo

```
Description: "Retrieve the full original content of a Squeezr-compressed tool result.
Use this when you need more detail than the compressed summary provides."
Input: { id: string — "The 6-char ID from [squeezr:ID] in the compressed content" }
```

---

## 10. System prompt compression

Fichero: `src/systemPrompt.ts`.

### Cuándo se activa

- `config.compressSystemPrompt` es true (por defecto: sí).
- `config.dryRun` es false.
- El system prompt tiene más de **2000 caracteres** (`MIN_LENGTH = 2000`).
- Se ejecuta **antes** de `extractProjectName` (que lee `<cwd>` del system prompt) — en realidad el código en `server.ts` extrae el proyecto antes de comprimir el system prompt, pero la compresión ocurre antes de llamar a `compressAnthropicMessages`.

### Qué hace

1. Calcula `md5(prompt)` como clave de cache.
2. Consulta `~/.squeezr/sysprompt_cache.json`. Si hay hit, devuelve el valor cacheado sin llamar al API.
3. Si no hay cache, llama al modelo de compresión con el prompt de instrucción:
   ```
   Compress this AI assistant system prompt to under 600 tokens.
   Keep: tool names, behavioral rules, key constraints, critical instructions.
   Remove: verbose examples, repetitive explanations, formatting guides, long documentation.
   Output only the compressed prompt.
   ```
   Pasa los primeros 10000 chars del system prompt. Max tokens respuesta: 700.
4. Guarda el resultado comprimido en el cache JSON.
5. Devuelve `{ text, originalLen, compressedLen }`.

### Backend según API

| API | Backend |
|-----|---------|
| Anthropic (Claude Code) | `haiku` — llama a la API real de Anthropic |
| OpenAI | `gpt-mini` — llama a la API real de OpenAI |
| Gemini | `gemini-flash` — llama a Google Generative Language API |
| Ollama | no comprime (devuelve el prompt original sin cambios) |

### Diferencia con tool results

El system prompt se comprime **una vez por conversación** (cacheado permanentemente en disco por hash). Los tool results se comprimen en cada request donde aparezcan como no-recientes. La compresión del system prompt se registra con `stats.recordSystemPromptSaved(originalLen, compressedLen)`.

---

## 11. Bypass mode

Fichero: `src/bypass.ts`.

Variable booleana en memoria `let bypassed = false`. Se puede activar/desactivar:
- Via `POST /squeezr/bypass` con `{ enabled: boolean }` (o sin body para toggle).
- Via MCP tool `squeezr_bypass`.
- Via CLI `squeezr bypass`, `squeezr bypass --on`, `squeezr bypass --off`.

**Cuando bypass está ON**:
- Los mensajes se reenvían al upstream **sin modificar**.
- Se siguen registrando estadísticas (`stats.recordWithProject` con `savedChars = 0`).
- Se siguen extrayendo rate limits de las respuestas.
- Se sigue registrando en `history.recordRequest`.
- **No** se inyecta `squeezr_expand`.
- **No** se comprimen system prompts.

**Reset**: se resetea a false al reiniciar el proxy (runtime-only, no toca ficheros de config).

---

## 12. Circuit breaker

Fichero: `src/circuitBreaker.ts`.

Singleton `circuitBreaker = new CircuitBreaker()` con configuración por defecto:
- `failureThreshold = 3` — 3 fallos consecutivos para abrir
- `resetTimeoutMs = 60_000` — 60 segundos de cooldown
- `callTimeoutMs = 5_000` — 5 segundos de timeout por llamada AI

### Estados

```
closed → normal, AI habilitado
  ↓ (3 fallos consecutivos)
open → AI compression saltada, requests pasan solo con determinística
  ↓ (60s transcurridos)
half-open → se permite 1 llamada probe
  ↓ (si tiene éxito) → closed
  ↓ (si falla) → open (reset timer)
```

### Cómo protege

En el Paso 2, antes de cualquier AI call:
```typescript
if (!circuitBreaker.shouldAllow()) {
  // skip AI compression entirely
  return [msgs, emptySavings(false, detSaved, readDedupSaved, detMs)]
}
```

Cada AI call individual pasa por `circuitBreaker.call(fn)` que:
1. Verifica que el estado no sea open.
2. Ejecuta `Promise.race([fn(), timeout(5000ms)])`.
3. Llama a `recordSuccess()` si tiene éxito → cierra el circuito.
4. Llama a `recordFailure()` si falla o timeout → incrementa contador.

El snapshot completo del circuito se incluye en `/squeezr/health` y `/squeezr/stats`.

---

## 13. Context pressure

La presión de contexto se calcula en `estimatePressure(messages, extraChars)`:

```typescript
function estimatePressure(messages: unknown[], extraChars = 0): number {
  const chars = JSON.stringify(messages).length + extraChars
  return Math.min(chars / 800_000, 1.0)
}
```

La unidad es `chars / 800_000`, saturada a 1.0. Se pasan los mensajes ya procesados (parcialmente comprimidos en el turno actual), más `systemExtraChars` (longitud del system prompt).

### Cómo afecta al threshold

Si `adaptiveEnabled` es true (por defecto):
```typescript
thresholdForPressure(pressure: number): number {
  if (pressure >= 0.90) return adaptiveCritical  // 150
  if (pressure >= 0.75) return adaptiveHigh      // 400
  if (pressure >= 0.50) return adaptiveMid       // 800
  return adaptiveLow                             // 1500
}
```

Cuando hay más presión, el threshold baja: se comprimen bloques más pequeños.

Los runtime overrides (`runtimeOverrides.threshold`) tienen prioridad absoluta sobre el adaptativo:
```typescript
export function effectiveThreshold(config: Config, pressure: number): number {
  if (runtimeOverrides.threshold !== undefined) return runtimeOverrides.threshold
  return config.thresholdForPressure(pressure)
}
```

La presión también afecta a patrones determinísticos: `compactGitDiff`, `compactGitLog`, `compactGrepOutput` y `truncateLongOutput` reciben el valor de `pressure` y aplican reglas más agresivas si `pressure >= 0.9`.

---

## 14. Stats y métricas

Fichero: `src/stats.ts`. Singleton `stats = new Stats()` exportado desde `server.ts`.

### Lo que acumula en memoria por sesión

- `requests`: total de requests procesados.
- `totalOriginalChars` / `totalCompressedChars`: chars antes/después de compresión.
- `totalCompressions`: número de bloques AI-comprimidos.
- `totalSessionCacheHits`: bloques servidos desde session cache.
- `byTool`: por herramienta — `count`, `savedChars`, `originalChars`.
- `byProject`: por proyecto — `requests`, `savedChars`, `savedTokens`.
- `byClient`: por cliente detectado (`claude_code`, `codex_desktop`, `cursor`, etc.) — `requests`, `originalChars`, `savedChars`.
- `byModel`: por model ID (`claude-opus-4-5`, `gpt-4o`, etc.) — `requests`, `originalChars`, `savedChars`.
- `totalDetSaved`, `totalDedupSaved`, `totalAiSaved`, `totalOverheadChars`, `totalSyspromptSaved`, `totalAiCompressionCalls`: breakdown honesto.
- `expandCalls`, `expandHits`, `expandMisses`: tasa de expand (métrica de calidad — si es alta, la compresión es demasiado agresiva).
- Tres `LatencyTracker` (ventana rodante de 200 muestras): `latencyTotal`, `latencyDet`, `latencyAi`. Expone p50/p95/p99/avg/last.

### Conversión chars → tokens

`CHARS_PER_TOKEN = 3.5` — usada consistentemente en todo el código para reportar tokens ahorrados.

### Persistencia en disco

`~/.squeezr/stats.json` — se escribe en **modo delta**: en cada request se suma solo el incremento del request actual a los acumulados existentes en disco. Esto corrige el bug antiguo de "acumulación triangular". El by_tool se escribe como snapshot de la sesión actual (valores acumulados correctos).

### Endpoint `/squeezr/stats`

Retorna el resumen completo incluyendo:
- Totales de sesión y ratio de compresión.
- `breakdown`: desglose por tipo (deterministic, ai_compression, read_dedup, system_prompt, overhead, ai_calls).
- `latency`: percentiles de latencia para compresión total, determinística, y AI.
- `expand`: calls, hits, misses, rate_pct.
- `by_tool`, `by_model`, `by_client`.
- `pattern_hits`: mapa de patrones determinísticos activados.
- `cache`: stats del LRU cache (`CompressionCache`).
- `expand_store_size`, `session_cache_size`.
- `limits`: snapshot completo de rate limits (Anthropic, OpenAI, Gemini).
- `circuit_breaker`: snapshot del circuito.
- `mode`, `version`, `port`, `bypassed`, `dry_run`.

---

## 15. History / Savings

Fichero: `src/history.ts`. Fichero en disco: `~/.squeezr/history.json`.

### Estructura

Una "sesión" = un proceso proxy (un `squeezr start`). Cada sesión tiene un `SESSION_ID` aleatorio generado al arrancar.

```typescript
interface SessionRecord {
  id: string
  project: string           // nombre del proyecto detectado (o 'unknown')
  startTime: number         // epoch ms
  endTime: number           // epoch ms — actualizado en cada flush
  requests: number
  savedChars: number
  savedTokens: number       // savedChars / 3.5
  compressions: number
  byTool: Record<string, { count: number; savedTokens: number }>
}
```

### Flujo

1. Por cada request se llama `recordRequest(project, savedChars, compressions, byTool)` que acumula en variables en memoria.
2. En shutdown (`SIGTERM`), `persistHistory()` escribe o actualiza el record de la sesión actual en `history.json`.
3. El fichero guarda hasta `MAX_SESSIONS = 500` sesiones (las más antiguas se descartan cuando se supera el límite).

### Endpoints

- `GET /squeezr/history`: retorna todas las sesiones históricas + sesión actual en vuelo.
- `GET /squeezr/projects`: agrega por proyecto (`getProjectAggregates`) — sessions, requests, savedTokens, lastSeen.

### Detección del proyecto

`extractProjectName(body)` en `server.ts` lee el nombre del directorio de trabajo desde el system prompt del request:
1. Busca `<cwd>/path/to/project</cwd>` (formato Claude Code).
2. Si no, busca `current working directory: /path`.
3. Si no, busca el último segmento de un path filesystem (`C:\...` o `/Users/...`), saltando directorios genéricos (`users`, `home`, `documents`, `src`, `node_modules`, etc.).
4. Si nada coincide: devuelve `'unknown'`.

Si se ha fijado un proyecto manual via `/squeezr/project` o MCP `squeezr_set_project`, ese valor tiene prioridad.

---

## 16. Rate limits

Fichero: `src/limits.ts`.

### Por API

**Anthropic** — se actualiza en cada response a partir de cabeceras:
- `anthropic-ratelimit-requests-limit/remaining/reset`
- `anthropic-ratelimit-tokens-limit/remaining/reset`
- `anthropic-ratelimit-input-tokens-limit/remaining`
- `anthropic-ratelimit-output-tokens-limit/remaining`
- Para cuentas de suscripción OAuth: `anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, etc. (ventanas de 5h y 7d con status `allowed`/`throttled`/`blocked`).

**OpenAI** — se actualiza en cada response:
- `x-ratelimit-limit-requests/remaining/reset-requests`
- `x-ratelimit-limit-tokens/remaining/reset-tokens`
- Reset es relativo (ej: `"1s"`, `"6m0s"`) y se convierte a epoch ms.
- Para Codex Desktop: se consulta el MCP endpoint `account/rateLimits/read` del proceso `codex app-server` via stdin/stdout cada 5 minutos (con spawn detachado, timeout 4s).
- Billing OpenAI: se puede consultar (polling) desde `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/credit_grants`.

**Gemini** — solo en responses 429: cabeceras `x-ratelimit-limit`/`ratelimit-limit`, más contador de `errorCount429` y `lastErrorEpoch`.

### Acumulación de uso

Por cada response se acumula en `UsageState`:
- `inputSession` / `outputSession`: tokens de la sesión actual.
- `inputToday` / `outputToday`: tokens del día actual (se resetea a medianoche con `rolloverIfNeeded`).
- `requestsSession`.

El snapshot completo se expone en `GET /squeezr/limits` y embebido en `/squeezr/stats`.

---

## 17. MCP tools

Fichero: `src/mcp.ts`. Servidor MCP con transporte stdio.

Las tools expuestas son:

| Tool | Descripción |
|------|-------------|
| `squeezr_status` | GET `/squeezr/health` + `/squeezr/stats`. Retorna versión, puerto, uptime, modo, bypass, circuit breaker. |
| `squeezr_stats` | GET `/squeezr/stats`. Retorna tokens ahorrados, chars, %, requests, session cache hits, desglose por herramienta, breakdown, latencia. |
| `squeezr_set_mode` | POST `/squeezr/config` con `{ mode }`. Cambia a `soft`/`normal`/`aggressive`/`critical` instantáneamente. |
| `squeezr_config` | GET `/squeezr/stats` + lee `squeezr.toml`. Retorna threshold, keepRecent, aiEnabled, aiSkipTools, modo actual. |
| `squeezr_habits` | GET `/squeezr/stats`, analiza `pattern_hits`. Reporta qué patrones determinísticos se han activado y cuánto han ahorrado. |
| `squeezr_stop` | POST `/squeezr/control/stop`. Para el proxy. |
| `squeezr_check_updates` | Fetch a `registry.npmjs.org/squeezr-ai/latest`. Compara con versión actual. |
| `squeezr_update` | Ejecuta `npm install -g squeezr-ai@latest`. |
| `squeezr_bypass` | POST `/squeezr/bypass` con `{ enabled }`. Activa/desactiva bypass mode. |
| `squeezr_set_project` | POST `/squeezr/project` con `{ project }`. Fija nombre de proyecto o lo resetea a auto-detección. |
| `squeezr_open_dashboard` | Abre `http://localhost:PORT/squeezr/dashboard` en el navegador del sistema (platform-specific: `cmd /c start`, `open`, `xdg-open`). |

Adicionalmente, Squeezr inyecta automáticamente en el contexto del modelo la tool `squeezr_expand` (definida en `expand.ts`), que es interceptada por el proxy antes de llegar al upstream.

El servidor MCP se registra en `~/.claude.json` (Claude Code), `claude_desktop_config.json` (Claude Desktop), `~/.cursor/mcp.json` (Cursor), `~/.codeium/windsurf/mcp_config.json` (Windsurf) y `~/.vscode/extensions/mcp_settings.json` (Cline) via `squeezr mcp install`.

---

## 18. Setup CLI (bin/squeezr.js)

### `squeezr start`

1. Comprueba si hay un proceso Squeezr en el puerto configurado via `probeSqueezr` (verifica el campo `identity: "squeezr"` en `/squeezr/health` para no confundir con otros servicios).
2. Si está corriendo con la versión correcta: muestra los puertos y termina.
3. Si está corriendo con versión distinta: lo mata y espera 1.5s.
4. Lanza `dist/index.js` como proceso **detachado** (`spawn` con `detached: true`, `stdio: ['ignore', logFd, logFd]`, `SQUEEZR_DAEMON=1`). Logs van a `~/.squeezr/squeezr.log`.

### `squeezr stop`

1. Busca PIDs en el puerto HTTP y MITM (via `netstat -ano | findstr` en Windows, `lsof -ti` o `fuser` en Unix).
2. Los mata con `taskkill /F /PID` en Windows o `kill -9` en Unix.
3. También mata procesos MCP (`squeezr.*mcp` o `mcp.js`).
4. Limpia `HTTPS_PROXY` del entorno (`setx HTTPS_PROXY ""` en Windows/WSL).

### `squeezr setup` (Windows: `setupWindows`)

1. Setea env vars permanentes via `setx` (scope usuario, sin admin):
   - `ANTHROPIC_BASE_URL=http://localhost:PORT`
   - `GEMINI_API_BASE_URL=http://localhost:PORT`
   - `NODE_EXTRA_CA_CERTS=~/.squeezr/mitm-ca/ca.crt`
   - **NO** setea `HTTPS_PROXY` globalmente (rompería Claude Code y npm).
2. Configura `~/.codex/config.toml` con `openai_base_url = "http://localhost:PORT/v1"`.
3. Ejecuta `mcpInstall` para registrar el servidor MCP en todos los clientes.
4. Instala el PowerShell wrapper en `Microsoft.PowerShell_profile.ps1` para que las env vars se auto-refresquen tras `start`/`setup`/`update`.
5. Auto-start: intenta NSSM (servicio Windows con restart en crash) → fallback a Task Scheduler (`schtasks`) → fallback a VBS en carpeta Startup.
6. Lanza el proxy en background.
7. Espera a que aparezca la CA MITM (`~/.squeezr/mitm-ca/ca.crt`) y la añade al certificate store de Windows (máquina → usuario).

### `squeezr setup` (Unix/macOS: `setupUnix`)

1. Añade bloque en `~/.bashrc`, `~/.zshrc` y `~/.profile` con:
   - `ANTHROPIC_BASE_URL`, `openai_base_url`, `GEMINI_API_BASE_URL`, `NODE_EXTRA_CA_CERTS`.
   - Guard de auto-heal: si `curl` no detecta Squeezr corriendo (validando `"identity":"squeezr"`), lo arranca automáticamente con `nohup`.
2. Auto-start: launchd plist en `~/Library/LaunchAgents/` (macOS) o systemd unit en `~/.config/systemd/user/` (Linux).
3. Instala el bash wrapper en `.bashrc`/`.zshrc` para auto-refresh de env vars.
4. MCP install.
5. Lanza el proxy.

### `squeezr mcp install`

Escribe `{ type: "stdio", command: "node", args: ["/path/to/dist/mcp.js"] }` como entrada `squeezr` en `mcpServers` de los ficheros de config de cada cliente compatible. Solo modifica ficheros que ya existen (excepto `~/.claude.json` que siempre se crea/actualiza).

### `squeezr ports`

Interactivo: lee nuevos puertos del usuario, actualiza `squeezr.toml`, setea env vars (Windows: `setx`; Unix: reemplaza bloque en shell profiles), y reinicia el proxy.

---

## 19. Clientes soportados — detección por User-Agent

La función `detectAnthropicClient(ua)` en `server.ts` mapea el `User-Agent` del request a un identificador de cliente:

| User-Agent contiene | Cliente detectado |
|---------------------|-------------------|
| `claude-code` o `claude_code` | `claude_code` |
| `claude-desktop`, `claude desktop`, `electron` | `claude_desktop` |
| `aider` | `aider` |
| `opencode`, `open-code` | `opencode` |
| `cursor` | `cursor` |
| `cline`, `roo` | `cline` |
| `windsurf` | `windsurf` |
| (ninguno de los anteriores) | `claude_code` (default para `/v1/messages`) |

La función `detectOpenAIClient(ua)` mapea para la ruta `/v1/chat/completions`:

| User-Agent contiene | Cliente detectado |
|---------------------|-------------------|
| `codex` | `codex_desktop` |
| `cursor` | `cursor` |
| `continue` | `continue` |
| `cline`, `roo` | `cline` |
| `windsurf` | `windsurf` |
| `aider` | `aider` |
| (ninguno) | `openai_other` |

Gemini CLI (ruta `/v1beta/models/*`) siempre se registra como `'gemini'`.

Para Codex Desktop, si no hay header `Authorization` en el request, se intenta leer el token OAuth desde `~/.codex/auth.json` (`tokens.access_token`) y se inyecta como `Bearer` token.

---

## 20. Puertos y endpoints

### Endpoints del proxy principal (port 8080)

| Método | Ruta | Función |
|--------|------|---------|
| POST | `/v1/messages` | Anthropic API (Claude Code, Claude Desktop, Aider, etc.) |
| POST | `/v1/chat/completions` | OpenAI API (Codex Desktop, Cursor, Cline, Aider) + Ollama/LM Studio local |
| POST | `/v1beta/models/*` | Gemini API (Gemini CLI) |
| POST | `/oauth/token` | Proxy OAuth token refresh para Codex (reenvía a `auth.openai.com`) |
| ALL | `*` | Catch-all: proxy transparente (models, embeddings, responses, etc.) hacia Anthropic/OpenAI/Google según headers |
| GET | `/squeezr/health` | Health check — retorna `{ identity: "squeezr", status, version, uptime_seconds, mode, bypassed, circuit_breaker, port, mitm_port }` |
| GET | `/squeezr/stats` | Stats completas de sesión |
| GET | `/squeezr/limits` | Rate limits por API |
| GET | `/squeezr/history` | Sesiones históricas |
| GET | `/squeezr/projects` | Agregados por proyecto |
| GET | `/squeezr/expand/:id` | Recupera original comprimido por ID |
| GET | `/squeezr/project` | Proyecto actual |
| POST | `/squeezr/project` | Setea/limpia proyecto manual |
| GET | `/squeezr/dashboard` | Dashboard HTML |
| GET | `/squeezr/events` | SSE stream de stats (cada 2 segundos) |
| GET | `/squeezr/selftest` | Self-test (último resultado, o `?run=1` para ejecutar) |
| GET | `/squeezr/bypass` | Estado bypass |
| POST | `/squeezr/bypass` | Activa/desactiva/toggle bypass |
| POST | `/squeezr/config` | Cambia modo de compresión |
| POST | `/squeezr/ports` | Actualiza puertos en squeezr.toml |
| POST | `/squeezr/control/stop` | Para el proxy gracefully |

### Puerto MITM (8081)

El servidor MITM intercepta HTTPS a nivel TLS para clientes que no soportan `base_url` override (principalmente Codex CLI en algunos escenarios). No está implementado en los ficheros fuente analizados (`src/server.ts` no contiene el servidor MITM directamente; es gestionado por el módulo de inicialización en `dist/index.js` que no fue incluido en la solicitud).

### CORS

Middleware CORS aplicado a todas las rutas: responde OPTIONS con 204 y cabeceras `Access-Control-Allow-*: *`. Necesario para Cursor (Electron renderer hace preflight).

---

## 21. Cómo afecta al contexto completo de la conversación

### La API de Claude siempre recibe todos los mensajes

La API de Anthropic (y OpenAI, y Gemini) requiere que en cada request se envíe **el array completo de mensajes** de la conversación desde el principio. No hay mecanismo nativo de "continuar desde el turno 47" — cada request es stateless y contiene todo el historial.

Squeezr **no elimina mensajes**. El número de mensajes que va en el request es siempre el mismo. Lo que hace es reducir el **peso** de esos mensajes modificando el contenido de los tool results dentro de ellos.

### Cómo reduce el payload en la práctica

En una sesión de 50 turnos, sin Squeezr:

```
Request #51:
  [mensaje 1]  usuario: "hola"                          → 20 chars
  [mensaje 2]  assistant: "Claro, ¿en qué te ayudo?"   → 30 chars
  [mensaje 3]  tool_result: [10.000 chars de fichero]   → 10.000 chars
  [mensaje 4]  assistant: "Veo que el fichero..."       → 150 chars
  [mensaje 5]  tool_result: [8.000 chars de git diff]   → 8.000 chars
  ...
  [mensaje 50] tool_result: [5.000 chars nuevo]         → 5.000 chars (reciente)
  Total payload: ~180.000 chars
```

Con Squeezr, ese mismo request #51:

```
  [mensaje 1]  usuario: "hola"                           → 20 chars (intacto)
  [mensaje 2]  assistant: "Claro, ¿en qué te ayudo?"    → 30 chars (intacto)
  [mensaje 3]  tool_result: [squeezr:a1b2c3 -78%] error en línea 45, función X → 200 chars
  [mensaje 4]  assistant: "Veo que el fichero..."        → 150 chars (intacto)
  [mensaje 5]  tool_result: [squeezr:d4e5f6 -71%] +23 lines in Header.tsx     → 180 chars
  ...
  [mensaje 50] tool_result: [5.000 chars nuevo]          → 5.000 chars (reciente, intacto)
  Total payload: ~35.000 chars  (-81%)
```

El ahorro viene de que los tool results de los turnos 3, 5, 7... (históricos) están comprimidos. Los mensajes de texto (usuario y assistant) y el turno actual permanecen intactos.

### Qué crece con la conversación y qué no

| Componente | Sin Squeezr | Con Squeezr |
|-----------|-------------|-------------|
| Mensajes de texto (usuario/assistant) | Crece ilimitado | Crece igual (no se toca) |
| Tool results históricos | Crece proporcional al número de tools ejecutadas | Se mantiene bajo (comprimidos a ~15-25% del original) |
| Tool results recientes (últimos `keepRecent`) | Tamaño real | Tamaño real (intactos) |
| System prompt | Se repite cada request | Comprimido una vez, reutilizado (~600 chars vs 13.000) |

### Lo que NO hace (documentado en IMPROVEMENTS.md como pendiente)

`squeezr.toml` tiene la opción `compress_conversation = false` pero **no está implementada**. Comprimir mensajes de texto de usuario/assistant (no solo tool results) está listado en IMPROVEMENTS.md como mejora futura (Tier 3, ítem 17).

---

## 22. Calidad — ¿Pierde información? ¿Por qué (generalmente) no

### El problema del apretón

Cualquier compresión que reduce el tamaño puede perder información. La pregunta es: ¿qué información pierde Squeezr y cuándo importa?

### Por qué la pérdida es aceptable en la mayoría de casos

**1. Solo comprime lo que ya se actuó**

La regla `keepRecent` (por defecto 3) garantiza que los tool results del turno actual y los 2 anteriores están intactos. La AI compression solo actúa sobre tool results *históricos* — resultados de herramientas ejecutadas hace varios turnos, sobre los que el modelo ya tomó decisiones.

Un `git diff` del turno 5 que el modelo ya usó para hacer un cambio: si Claude necesita revisitarlo, puede llamar a `squeezr_expand(id)`. Si no lo necesita, el espacio se ha recuperado sin pérdida funcional.

**2. Determinística no pierde información útil en la mayoría de patrones**

Los patrones determinísticos (Paso 1) están diseñados para eliminar *ruido*, no *señal*:
- ANSI codes, progress bars, timestamps repetidos → no aportan nada al razonamiento
- Stack traces duplicados → la info está en la primera aparición
- JSON minificado → misma info, menos bytes
- Lockfiles → Claude no necesita las 50.000 líneas de `package-lock.json`

El fichero `IMPROVEMENTS.md` identifica 4 patrones que pueden ser demasiado agresivos:
- `compactGitDiff` con presión alta: puede perder contexto de diff (fix: mantener siempre mínimo 1 línea de contexto)
- `compactPkgList`: omite dependencias anidadas (fix: hacer configurable)
- `compactReadOutput` (head/tail): puede omitir bugs en el medio del fichero (fix: priorizar extracción de exports/funciones)
- `stripTimestamps`: puede perder contexto temporal si hay pocos timestamps (fix: solo strip si hay >10 timestamps seguidos)

**3. El expand store como red de seguridad**

Cada bloque comprimido con AI tiene un ID determinístico (MD5 6 chars) que permite recuperar el original completo. Claude puede en cualquier momento llamar a `squeezr_expand("a1b2c3")` y recibir el contenido original intacto.

La tasa de expand calls es la métrica de calidad principal: si Claude llama a expand frecuentemente, la compresión es demasiado agresiva. El dashboard lo muestra con colores:
- Verde: < 10% de blocks comprimidos necesitan expand
- Amarillo: 10-25%
- Rojo: > 25% (señal de que hay que subir `keep_recent` o bajar la agresividad)

**4. La AI compression usa el contenido real, no regex ciega**

El modelo de compresión (Haiku, GPT-4o-mini, Gemini Flash) recibe el texto y extrae lo esencial: errores, paths, nombres de función, fallos de tests, valores clave. No es un regex que corta líneas — es comprensión semántica del output. El resultado es generalmente más útil para Claude que el output bruto (que incluye mucho ruido visual).

**5. El session cache preserva el KV cache de Anthropic**

Los IDs son determinísticos (MD5). Si el bloque comprimido del mensaje 3 produjo `[squeezr:a1b2c3 -78%] ...` en el request anterior, producirá exactamente el mismo string en el request siguiente. Esto significa que el prefijo de bytes es idéntico → Anthropic reutiliza el KV cache del turno anterior → los tokens históricos comprimidos no cuestan nada de compute en el siguiente request.

### Cuándo SÍ puede perder información relevante

- **compactReadOutput en ficheros con bugs en el medio**: si un fichero de 600 líneas tiene un bug en la línea 300, head+tail lo omite. Mitigación: `squeezr_expand` si Claude necesita revisitarlo.
- **AI compression en código con lógica compleja**: el modelo de compresión puede simplificar demasiado un output denso. Mitigación: aumentar `keep_recent`, usar bypass para herramientas críticas.
- **System prompt compression**: puede eliminar instrucciones importantes si el system prompt es muy largo. El fichero `IMPROVEMENTS.md` señala que no se validan chunks con `NEVER`, `MUST`, `CRITICAL` antes de comprimir (mejora pendiente).
- **Primer request con historial largo sin session cache**: si hay 40 bloques históricos sin session cache, ninguno entra en AI compression (solo session cache hits y nuevos del turno actual). Los bloques históricos sin cache solo tienen compresión determinística hasta que sean procesados en turnos futuros.

### Resumen de garantías

| Garantía | Implementada |
|----------|-------------|
| Tool results del turno actual nunca se AI-comprimen | ✅ (`keepRecent` ≥ 1) |
| Bloques comprimidos siempre recuperables | ✅ (expand store, persistido en disco) |
| Compresión determinística no inventa contenido | ✅ (regex/regexp puro, sin AI) |
| Mismo bloque → mismo ID siempre | ✅ (MD5 determinístico) |
| Bypass instantáneo si hay problemas | ✅ (`squeezr bypass --on`) |
| Tasa de expand monitoreable en tiempo real | ✅ (dashboard + MCP) |
| Mensajes de texto usuario/assistant intactos | ✅ (no se tocan) |
| Validación de `NEVER`/`MUST` en system prompt antes de comprimir | ❌ (pendiente, IMPROVEMENTS.md ítem 11) |

---

## 23. Opciones de config que existen pero no están implementadas

### `compress_conversation`

`squeezr.toml` acepta `compress_conversation = true/false` y `config.ts` lo lee y expone como `config.compressConversation`. Sin embargo, **ningún código en `compressor.ts` lee esta propiedad**. `compressAnthropicMessages`, `compressOpenAIMessages` y `compressGeminiContents` comprimen exclusivamente bloques `tool_result` — nunca mensajes de texto de usuario o assistant, independientemente del valor de esta opción.

### Streaming en expand calls

La interceptación de `squeezr_expand` solo funciona en requests **non-streaming**. Si un request llega con `stream: true` y el modelo decide llamar a `squeezr_expand`, el proxy no puede interceptar esa tool call dentro del stream SSE — el expand se pierde y Claude no recibe el contenido original. Solo los requests sin streaming tienen expand totalmente funcional.

---

## Diagrama de flujo simplificado (Anthropic)

```
Claude Code
    │ POST /v1/messages
    ▼
┌─────────────────────────────────────────────────────────┐
│  server.ts — /v1/messages handler                       │
│                                                         │
│  1. extractProjectName(body)   ← lee <cwd> del system   │
│  2. compressSystemPrompt()     ← si >2000 chars         │
│  3. compressAnthropicMessages()                         │
│     ├─ Paso 0: Read dedup (cross-turn)                  │
│     ├─ Paso 1: preprocessForTool() en todos los blocks  │
│     │    └─ deterministic.ts: base pipeline + patrones  │
│     └─ Paso 2: AI compress (solo históricos > threshold)│
│          ├─ session cache hit → reutiliza fullString     │
│          └─ miss → Haiku API → buildAndCache()          │
│  4. injectExpandToolAnthropic(body)                     │
│  5. stats.recordWithProject(...)                        │
│  6. fetch → api.anthropic.com/v1/messages               │
│  7. updateAnthropicFromHeaders(resp.headers)            │
│  8. handleAnthropicExpandCall(respBody)                 │
│     └─ si expand: 2ª llamada con original recuperado    │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Claude Code ← respuesta (comprimida en historial, fresca en último turno)
```



Cómo funciona la inyección de la tool

  Cada vez que llega un request a Squeezr (por ejemplo, Claude Code envía un POST a /v1/messages), antes de reenviarlo a
   la API de Anthropic, Squeezr hace dos cosas:

  1. Comprime los mensajes (lo que ya conoces)
  2. Inyecta la tool squeezr_expand en el array de tools del request

  El request original que llega de Claude Code es algo así:

  {
    "model": "claude-opus-4-7",
    "messages": [...],
    "tools": [
      { "name": "Read", "description": "...", "input_schema": {...} },
      { "name": "Bash", "description": "...", "input_schema": {...} },
      { "name": "Edit", "description": "...", "input_schema": {...} }
    ]
  }

  Squeezr modifica el array tools y añade:

  {
    "name": "squeezr_expand",
    "description": "Retrieve the full original content of a Squeezr-compressed tool result. Use this when you need more
  detail than the compressed summary provides.",
    "input_schema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "The 6-char ID from [squeezr:ID] in the compressed content"
        }
      },
      "required": ["id"]
    }
  }

  Cuando Anthropic recibe el request, Claude ve esa tool exactamente igual que ve Read, Bash, Edit. No sabe que es
  "especial" — para Claude es simplemente otra herramienta disponible.

  Cómo Claude decide usarla

  Claude está entrenado para leer la description de cada tool y decidir cuándo llamarla. Cuando Claude lee en el
  historial:

  tool_result: [squeezr:f8e3a9 -82%] Created Header.tsx with darkMode prop, conditional className...

  Razona internamente algo así:
  - "Veo el marcador [squeezr:f8e3a9 -82%]"
  - "Tengo una tool squeezr_expand cuya descripción dice exactamente eso: usarla cuando vea un ID [squeezr:ID]"
  - "Si solo necesito recordar el concepto general, el resumen me sirve. Si necesito el contenido exacto (para hacer una
   edición precisa), llamo a squeezr_expand({id: 'f8e3a9'})"

  El ciclo completo de un expand

  Turno 30:
  1. User: "edita Header.tsx para añadir un prop fontSize"
  2. Claude ve en el historial: [squeezr:f8e3a9 -82%] Created Header.tsx...
  3. Claude decide: "Para editar precisamente, necesito ver el código real"
  4. Claude llama: squeezr_expand({id: "f8e3a9"})
  5. Squeezr intercepta esa llamada antes de devolver la respuesta al cliente
  6. Recupera el contenido original del expand_store en disco
  7. Hace una SEGUNDA llamada a Anthropic con ese contenido completo añadido al contexto
  8. Anthropic responde con la edición correcta
  9. Squeezr devuelve esa respuesta al cliente

  Todo esto pasa de forma transparente. Claude Code no sabe que hay un proxy, no sabe que hubo dos llamadas. Solo recibe
   la respuesta final.

  Por qué funciona tan bien

  1. Claude es muy bueno usando tools nuevas
  Las descripciones de tools son lenguaje natural. Si la descripción es clara ("usa esto cuando veas [squeezr:ID]"),
  Claude la usa sin entrenamiento previo.

  2. El marcador [squeezr:ID] es muy visible
  No es disimulado. Cuando Claude escanea el historial buscando información, ese marcador destaca como un puntero claro.

  3. El ratio -82% da información adicional
  Claude sabe que -82% significa que se eliminó mucho contenido. Si necesita precisión, el porcentaje le señala "aquí
  hay mucho original disponible si lo necesitas".

  El detalle técnico — código real

  En src/expand.ts está la inyección:

  export function injectExpandToolAnthropic(body) {
    if (!Array.isArray(body.tools)) body.tools = []
    // Solo añadir si no está ya
    if (body.tools.find(t => t.name === 'squeezr_expand')) return
    body.tools.push({
      name: 'squeezr_expand',
      description: 'Retrieve the full original content of a Squeezr-compressed tool result. ' +
                   'Use this when you need more detail than the compressed summary provides.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The 6-char ID from [squeezr:ID] in the compressed content' }
  },
        required: ['id']
      }
    })
  }

  Se ejecuta en CADA request, justo antes de reenviar a Anthropic. Garantizado que Claude siempre tenga la tool
  disponible.