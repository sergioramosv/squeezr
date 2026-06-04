# Cómo funciona el Prompt Cache de Anthropic (y por qué Squeezr casi te arruina)

> Escrito tras el incidente del 2026-06-04: ~50% del plan de 5h gastado en 10
> minutos porque Squeezr invalidaba el cache sin saberlo. Este documento explica
> el mecanismo para que no vuelva a pasar — ni a nosotros ni a ningún usuario.

---

## 1. El problema que el cache resuelve

Los LLM no tienen memoria entre peticiones. Cada vez que escribes un mensaje en
Claude Code, el cliente reenvía **TODA la conversación desde el principio**:

```
Mensaje 1:  [system] [user: "hola"]
Mensaje 2:  [system] [user: "hola"] [asst: "..."] [user: "lee este fichero"]
Mensaje 3:  [system] [user: "hola"] [asst: "..."] [user: "lee..."] [tool_result: 50KB] [user: "ahora arregla X"]
...
Mensaje 50: ← reenvía TODO lo anterior otra vez (puede ser 180.000 tokens)
```

Sin cache, pagarías esos 180k tokens **a precio completo en cada mensaje**.
Una conversación larga de 50 mensajes costaría millones de tokens facturados.

## 2. La solución de Anthropic: cachear el prefijo

Anthropic permite marcar puntos de la conversación con `cache_control`:

```json
{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }
```

Todo lo que está **antes del marcador** (el "prefijo") se guarda en los
servidores de Anthropic ya procesado (el estado KV del modelo). En el siguiente
mensaje, si el prefijo llega **byte a byte idéntico**, no lo re-procesa: lo lee
del cache.

### Los tres precios

| Concepto            | Cuándo se aplica                                  | Precio (vs input normal) |
|---------------------|---------------------------------------------------|--------------------------|
| **Cache Write/Creation** | La primera vez que un tramo se cachea         | **1.25x** (Sonnet ~$3.75/MTok) |
| **Cache Read**      | Tramo ya cacheado que llega idéntico             | **0.1x** (Sonnet ~$0.30/MTok) — **10x más barato** |
| Input normal        | Tokens sin cachear (sin marcador)                 | 1x (Sonnet ~$3/MTok)    |

En la respuesta del API viene el desglose real:

```json
"usage": {
  "input_tokens": 1200,                  // sin cachear
  "cache_creation_input_tokens": 5000,   // cacheado AHORA (1.25x)
  "cache_read_input_tokens": 175000,     // leído del cache (0.1x) ← lo barato
  "output_tokens": 800
}
```

### El flujo normal (sano)

```
Mensaje 1:  creation=10k  read=0      ← primer mensaje, se cachea todo
Mensaje 2:  creation=2k   read=10k    ← lo viejo se LEE, solo lo nuevo se cachea
Mensaje 3:  creation=1.5k read=12k    ← el cache crece, las lecturas dominan
...
Mensaje N:  creation=pequeño  read=ENORME  ← 90%+ de tu contexto va a 0.1x
```

El marcador avanza con la conversación: cada turno "absorbe" el contenido nuevo
al cache. Las lecturas dominan → pagas ~10% de lo que pagarías sin cache.

## 3. La regla de oro: BYTE A BYTE

El cache es un hash del prefijo exacto. **Un solo byte distinto en cualquier
punto del prefijo invalida el cache desde ese punto hasta el final.**

```
Cacheado:   [system][msg1][msg2][msg3][msg4]...[msg200]
Llega:      [system][msg1][msg2*][msg3][msg4]...[msg200]
                          ↑ un byte cambiado aquí
Resultado:  cache HIT solo hasta msg1.
            msg2..msg200 (¡180k tokens!) → cache CREATION otra vez (1.25x)
```

No hay "fuzzy matching", no hay tolerancia. Idéntico o re-pagas.

## 4. Lo que hizo Squeezr mal (las 3 formas de romperlo que encontramos hoy)

Squeezr se sienta entre Claude Code y Anthropic y comprime la conversación.
Cada una de estas pasadas mutaba el prefijo de forma DISTINTA en cada petición:

### Rotura #1 — Compresión AI no determinista + rotativa (v1.56.1)
Haiku comprime el mismo bloque con palabras distintas cada vez, y además el cap
"5 bloques por request" comprimía bloques DIFERENTES cada turno. El prefijo
cambiaba siempre → cache miss permanente → re-facturación completa cada mensaje.
**Esto causó el incidente del 50% del plan.**

### Rotura #2 — Compresión determinística con pressure variable (v1.63.0)
La limpieza por regex usaba un parámetro `pressure` calculado del tamaño de la
conversación. La conversación crece cada turno → pressure distinto → el MISMO
bloque se comprimía ligeramente distinto → prefijo distinto → cache miss.
**Fix:** pressure fijo (`DET_PRESSURE=0`) → salida byte-estable entre requests.

### Rotura #3 — Stale-turns con frontera móvil (v1.67.1)
El colapso de turnos viejos usa una ventana "mantén los últimos 15". La ventana
se desliza un turno por mensaje → cada mensaje colapsa un bloque MÁS que el
anterior → el prefijo muta cada turno.
**Fix:** desactivado cuando hay cache markers.

### La detectora: la card "Prompt Cache" (v1.67.0)
Mide `cache_read` vs `cache_creation` en vivo. **Hit Health = read/(read+creation)**.
- 🟢 ≥80% — cache sano
- 🟡 50–79% — aceptable (tras un restart baja temporalmente)
- 🔴 <50% — algo está invalidando el prefijo y estás pagando de más

Resultado medido hoy: health 23% → 72% tras los fixes (y subiendo).

## 5. Las reglas que Squeezr sigue ahora (grabadas a fuego)

1. **Nada que toque el prefijo cacheado puede variar entre requests.**
   - Determinística: OK porque es byte-estable (mismo input → mismo output, siempre).
   - AI/dedup/diff/stale-turns: NO son estables → solo operan después del último
     `cache_control` marker, o cuando no hay markers (clientes sin cache).
2. **Comprimir el prefijo de forma ESTABLE es seguro y bueno**: Anthropic cachea
   la versión comprimida → pagas cache-read sobre MENOS tokens. Doble ahorro.
3. **Comprimir el prefijo de forma INESTABLE es la ruina**: ahorras N tokens y
   pagas 180k re-cacheados. Pierdes 10-100x lo que ahorras.
4. **El futuro (REINVENT_AI.md):** compresión AI estable = comprimir cada bloque
   UNA vez (modelo determinista o caché persistente en disco) y aplicar SIEMPRE
   exactamente esa versión. Así el AI también se vuelve cache-safe.

## 6. Chuleta rápida

- El cache dura ~5 min (ephemeral) o 1h (extendido); Claude Code lo renueva con cada mensaje.
- Mínimo cacheable: 1024 tokens (Sonnet/Opus) / 2048 (Haiku).
- Máximo 4 marcadores `cache_control` por petición.
- `cache_creation` alto sostenido = dinero quemándose. Mira la card.
- El proxy NUNCA debe tocar los marcadores `cache_control` (Claude Code los gestiona).
