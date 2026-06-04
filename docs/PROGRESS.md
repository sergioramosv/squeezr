# Squeezr — Qué hemos hecho, qué falta, qué no hemos hecho

> Documento de estado. Fecha: 2026-06-01. Versión actual: v1.55.1

---

## ¿Qué es Squeezr en una frase?

Un proxy que se sienta entre tu cliente de IA (Claude Code, Codex, Aider...) y Anthropic/OpenAI/Google, y **achica el contexto antes de enviarlo** para que gastes menos tokens y llegues más lejos sin que la IA lo note.

---

## Lo que hemos construido (v1.46.3 → v1.55.1)

### v1.46.3 — Favicon del dashboard *(línea base)*
**Para alguien que no sabe:** El panel de control de Squeezr (página web en `localhost:8080/squeezr/dashboard`) ya tiene icono en la pestaña del navegador.  
**Técnico:** Añadido favicon SVG incrustado en el HTML del dashboard. Sin cambios en el pipeline de compresión.

---

### v1.47.0 — Captura de peticiones *(opt-in)*
**Para alguien que no sabe:** Squeezr puede guardar una copia anónima de cada conversación que pasa por él (sin tokens de autenticación) para analizar cómo mejorar las compresiones futuras.  
**Técnico:** Módulo `requestCapture.ts`. Escribe a `~/.squeezr/captures/req-NNNN.json`. Activado con `capture_requests = true` en el toml. Para automáticamente tras `capture_limit` ficheros (default 20). Las claves de API se redactan.  
**Estado actual:** El user toml (`~/.squeezr/squeezr.toml`) ya tiene `capture_requests = true`. **Hace falta correr `squeezr restart` para que el proxy lo cargue.**

---

### v1.48.0 — Deduplicación de imágenes
**Para alguien que no sabe:** Si la misma imagen aparece varias veces en la conversación (screenshot repetido, logo...), Squeezr solo la manda una vez y reemplaza las copias por una referencia.  
**Técnico:** `imageDedup.ts`. Hash MD5 de cada bloque `image` en el array `messages`. Solo opera sobre `messages[]`, nunca sobre `tools[]` ni `system`. Sin llamada AI.

---

### v1.49.0 — Deduplicación de adjuntos y artefactos de texto
**Para alguien que no sabe:** Si un fragmento largo de texto (código pegado, un fichero grande) aparece varias veces en la conversación, solo se manda una vez.  
**Técnico:** `attachmentDedup.ts`. Bloques de texto ≥500 chars en `messages[]`. Hash MD5 por contenido. El duplicado se reemplaza por `[squeezr: duplicate of block #N above — X chars elided]`.

---

### v1.50.0 — Compresión de lecturas repetidas de ficheros (diff)
**Para alguien que no sabe:** Cuando la IA lee el mismo fichero varias veces a lo largo de la conversación, solo guarda la primera versión completa; las siguientes las convierte en un "diff" (solo las líneas que cambiaron).  
**Técnico:** `diffRead.ts`. Detecta bloques `tool_result` del tool `Read` con el mismo `file_path`. Aplica diff Myers (via npm `diff`). El ahorro es mayor cuando el fichero cambia poco entre lecturas.

---

### v1.51.0 — Deduplicación de bloques de skill/plugin en system prompt
**Para alguien que no sabe:** Claude Code a veces inyecta el mismo bloque de instrucciones de un plugin repetido varias veces en el prompt de sistema. Squeezr elimina las copias.  
**Técnico:** `skillDedup.ts`. Pre-pass sobre el system prompt (string o array). Hash MD5 por bloque (separado por líneas en blanco, ≥4 líneas y ≥200 chars). Duplicados → `[squeezr: duplicate of block #N above]`. Corre antes de la compresión AI del system prompt.

---

### v1.52.0 — Glosario cross-sesión *(modo pasivo)*
**Para alguien que no sabe:** Squeezr empieza a llevar un registro de las rutas y nombres largos que más se repiten en tus conversaciones (`/home/usuario/MiProyecto/src/...`) para poder abreviarlos después. En esta versión **solo observa, no toca nada**.  
**Técnico:** `glossaryStore.ts`. Escanea `messages[]` buscando paths absolutos y identificadores ≥30 chars que aparezcan ≥20 veces. Los persiste en `~/.squeezr/glossary.json` como `token → $P1`, `$P2`... Nunca muta el body.  
**Estado actual:** El glosario tiene 1 entrada: `C:/Users/Ramos/Documents/Squeezr → $P1` (vista 279 veces).

---

### v1.53.0 — Summarización de turnos obsoletos
**Para alguien que no sabe:** Cuando una conversación supera 40 mensajes, los más antiguos ya son "historia vieja". Squeezr comprime los textos largos del asistente en esos turnos viejos a una línea con las palabras clave, manteniendo los últimos 15 turnos intactos.  
**Técnico:** `staleTurns.ts`. Cuenta mensajes `user` (cada uno = un turno). Si hay >40, los que están antes del turno `total-15` son "stale". Para cada mensaje `assistant` stale: si el bloque `text` >250 chars → lo reemplaza por `[⧖ Nch | keyword1, path/file.ts, Error:...] Preview 80 chars…`. Keywords extraídos: file paths, errores, nombres de funciones. NUNCA toca `tool_use`, `tool_result`, ni mensajes user.

---

### v1.54.0 — Sustitución activa del glosario
**Para alguien que no sabe:** Ahora que el glosario tiene datos, Squeezr reemplaza activamente los tokens largos conocidos por sus abreviaciones (`$P1`, `$P2`...) en los mensajes viejos, e inyecta una leyenda en el prompt de sistema para que la IA sepa qué significa cada abreviación.  
**Técnico:** `glossarySub.ts`. Lee el glosario, cuenta ocurrencias de cada token en el request actual. Si un token aparece ≥3 veces → lo reemplaza en bloques `text` de `user` y `assistant` (nunca en `tool_use` inputs ni `tool_result` content, nunca en el último mensaje user). Si `netSavedChars > 0` → inyecta `[squeezr-glossary: $P1=...; $P2=...]` como bloque en `body.system` (después de `compressSystemPrompt` para que la leyenda no se comprima).

---

### v1.55.0 — Compresión de descriptions de tools *(default OFF)*
**Para alguien que no sabe:** Cada vez que la IA pide hacer algo, recibe una descripción larga de cada herramienta disponible. Squeezr puede eliminar el espacio en blanco innecesario de esas descripciones. Está apagado por defecto hasta tener datos reales (captures) para calibrarlo sin riesgo.  
**Técnico:** `toolDescComp.ts`. Opera sobre `body.tools[]`. Solo toca el campo `description` (nunca `input_schema` ni `name`). Dos modos: normalización de whitespace (siempre segura) y truncación hard a N chars (opt-in via `tool_desc_max_chars`). Activar con `tool_desc_compress = true` en el toml.

---

### v1.55.1 — Comando `squeezr restart`
**Para alguien que no sabe:** Antes no existía un comando para reiniciar Squeezr. Había que hacer `squeezr stop` y luego `squeezr start` manualmente.  
**Técnico:** Añadido `case 'restart'` al switch del CLI (`bin/squeezr.js`): llama a `stopProxy()`, espera 1500ms para que los puertos queden libres, luego llama a `startDaemon()`. El wait es el mismo que usa `startDaemon` internamente cuando detecta version mismatch.

---

## Lo que NO hemos hecho / caveats importantes

| Cosa | Por qué no |
|------|-----------|
| `squeezr restart` no existía hasta hoy | Nunca se añadió al CLI original |
| Captures no estaban activos | `capture_requests` es opt-in. El user toml se creó hoy pero **hace falta correr `squeezr restart` para que entre en efecto** |
| `tool_desc_compress` está OFF | Regla de proyecto: no tocar `tools[]` sin captures reales. Falta calibrar qué se puede cortar sin romper nada |
| Glosario solo tiene 1 entrada | El threshold de 20 ocurrencias es alto. Solo `C:/Users/Ramos/Documents/Squeezr` lo ha cruzado. Con captures activos y más uso, crecerá |
| v1.53.0 (stale turns) nunca se ha disparado en producción | Necesitas >40 turnos en una misma conversación. Las conversaciones normales de desarrollo suelen ser más cortas |
| v1.54.0 (glossary sub) es efectivamente un no-op hoy | Solo hay 1 ref y necesita ≥3 ocurrencias en el mismo request. Con más uso del proxy acumulará más refs |
| Tests de `compressor.test.ts` fallan (12 tests) | Fallo pre-existente, no introducido por nosotros. Los tests esperan `[squeezr:...]` pero reciben `[same bash output...]` — bug en cómo el test mocking interactúa con el dedup por sesión |
| Tests de `probePort.test.ts` y `rateLimitHeaders.test.ts` fallan | Tests de red que necesitan puertos reales disponibles — fallan en CI/entornos restrictivos |

---

## Lo que queda por hacer

### Inmediato
- [ ] **`squeezr restart`** para activar captures (ya tienes el comando, solo córrelo)
- [ ] Verificar que `~/.squeezr/captures/` se puebla tras las próximas peticiones
- [ ] Analizar los captures para calibrar `tool_desc_max_chars` (¿cuánto se puede cortar?)

### Cola de features (en orden de riesgo ascendente)

| Versión | Feature | Riesgo | Bloqueado por |
|---------|---------|--------|---------------|
| v1.56.0 | **MCP tool filtering per-server** — filtrar herramientas MCP por servidor (ej: no mandar tools de servidor X al modelo cuando no son necesarias) | 🔴 ALTO | Captures reales de requests con MCP tools |
| v1.57.0 | **Anthropic prompt cache markers** — gestionar los marcadores `cache_control` que Claude Code inyecta para aprovechar el caché de 1h de Anthropic | 🔴🔴 MUY ALTO | Entender exactamente cómo Claude Code los coloca hoy |

### Zest (modelo local de compresión)
- [ ] Dataset: 1613 rows actuales → objetivo 3000 rows (task #30)
- [ ] Cuando Opus quota se refresque, generar más datos sintéticos
- [ ] GGUF conversion del modelo mergeado en `out/squeezr-merged/`
- [ ] Publicar el modelo en HuggingFace

---

## Próximos pasos concretos (ahora mismo)

1. **`squeezr restart`** → activa captures
2. Usar Claude Code normalmente durante un rato (el proxy capturará las primeras 20 peticiones)
3. Mirar `~/.squeezr/captures/req-0001.json` para ver cómo son las tool descriptions reales
4. Con esos datos, definir un buen valor para `tool_desc_max_chars` y activar `tool_desc_compress = true`
5. Entonces: implementar v1.56.0 (MCP filtering) con datos reales
