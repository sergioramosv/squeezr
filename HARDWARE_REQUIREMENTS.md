# Squeezr — Requisitos de hardware

> Sin el modelo local squeezr-1B. Datos medidos en producción (v1.55.6, Windows 11, 2026-06-04).

## TL;DR

Squeezr es un proxy HTTP en Node.js. **Corre en cualquier máquina de los últimos 10 años.** No necesita GPU. El trabajo pesado (compresión AI) se delega a APIs cloud (Haiku/GPT-mini/Gemini Flash) o a un Ollama externo opcional.

## Requisitos mínimos

| Recurso | Mínimo | Recomendado | Notas |
|---|---|---|---|
| **CPU** | 1 core x64/arm64 | 2+ cores | Regex + MD5 + diff Myers; picos breves al procesar requests de 1-2MB |
| **RAM** | 256 MB libres | 512 MB libres | Medido real: ~140 MB en uso con 3 procesos (proxy + MITM + desktop proxy) |
| **Disco** | 200 MB | 300 MB | 128 MB node_modules + ~10 MB código + caches en `~/.squeezr/` (acotados) |
| **Red** | Salida HTTPS (443) | — | api.anthropic.com, api.openai.com, generativelanguage.googleapis.com |
| **GPU** | No necesaria | — | Toda la compresión AI es cloud (o Ollama externo) |

## Software

| Requisito | Versión |
|---|---|
| **Node.js** | ≥ 18 (probado en 24.x) |
| **SO** | Windows 10/11, macOS, Linux, WSL2 |
| **npm** | El que venga con Node |

## Consumo medido (v1.55.6)

- **RAM proceso principal:** ~140 MB working set (proxy + dashboard + MITM 8081)
- **Desktop proxy** (opcional, solo Claude/Codex Desktop): proceso aparte, ~80 MB
- **CPU idle:** ~0% — solo trabaja cuando pasa un request
- **CPU pico:** un core durante 10-50 ms por request (deterministic pipeline es síncrono)
- **Disco en `~/.squeezr/`:** caches acotados — cache.json (LRU 1000 entradas), history.json (500 sesiones max), captures (20 max, opt-in)

## Latencia añadida por request

| Pipeline | Latencia |
|---|---|
| Determinístico (regex, dedup, diff) | 5-50 ms |
| Compresión AI (Haiku/GPT-mini/Flash) | 300-1500 ms (solo bloques viejos > threshold, en paralelo) |
| Forward al upstream | passthrough (streaming intacto) |

## Puertos usados (configurables)

| Puerto | Uso |
|---|---|
| 8080 | Proxy HTTP principal (Claude Code, Codex CLI, Aider, Gemini CLI) + dashboard |
| 8081 | MITM proxy (Codex OAuth) |
| 8443 / 8088 | Desktop proxy (solo si usas Claude/Codex Desktop) |

## Lo que NO necesitas

- ❌ GPU / CUDA
- ❌ Docker
- ❌ Base de datos (todo es JSON en `~/.squeezr/`)
- ❌ Ollama (opcional — solo si quieres backend de compresión 100% local)

## Nota: con squeezr-1B (futuro)

Cuando el modelo local squeezr-1B esté disponible vía Ollama, los requisitos suben: ~2 GB RAM extra para el modelo (1.5B params bf16 → ~1 GB en Q4) y CPU con AVX2 o GPU pequeña para inferencia razonable. Se documentará por separado.
