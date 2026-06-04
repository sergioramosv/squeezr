# El problema de las tool descriptions
> Descubierto el 2026-06-01 analizando captures reales. Resuelto en v1.54.0.

## ¿De qué va?

Cada vez que Claude Code hace una petición a Anthropic, manda el array `tools[]` con la definición de cada herramienta disponible. Cada herramienta tiene un campo `description` con el texto que explica a la IA cómo usarla.

**El problema: esas descriptions son enormes y se mandan en cada request.**

## Los números reales (req-0002.json)

| Métrica | Valor |
|---|---|
| Tools por request | **145** |
| Chars totales en descriptions | **98,006 chars** |
| Tokens equivalentes | **~28,001 tokens** |
| Coste a $3/MTok (Sonnet) | **~$0.084 solo en tool descriptions** por request |

### Las peores offensoras

| Tool | Chars | Lo que realmente importa |
|---|---|---|
| Workflow | 18,285 | 263 chars (primer párrafo) |
| Bash | 10,441 | 53 chars (primer párrafo) |
| PowerShell | 8,151 | ~80 chars |
| Agent | 7,686 | ~150 chars |
| Monitor | 5,186 | ~100 chars |

El resto (10,000-18,000 chars) son ejemplos, notas de uso, advertencias repetitivas. Claude ya conoce estas herramientas de su entrenamiento. La documentación extra no aporta.

## Por qué es un problema
Las descriptions no cambian entre requests. Son iguales en el request 1 y en el request 200 de la misma sesión. Se están mandando **28,000 tokens de texto redundante en cada request**.

Con una sesión de 50 requests: **1,400,000 tokens** gastados solo en descripciones de herramientas.

## El problema con la solución inicial (v1.54.0 → corregido en v1.54.1)

v1.54.0 truncaba TODAS las descriptions al primer párrafo. Correcto para Bash (Claude lo conoce de entrenamiento) pero incorrecto para:
- **Workflow** (18K): el resto del texto es el spec completo del scripting DSL — sin él Claude no sabe usar `agent()`, `parallel()`, `pipeline()`, etc.
- **Tools MCP** (mcp__planning-task-mcp__*, mcp__github-mcp__*, etc.): Claude no los conoce de entrenamiento, necesita la description completa para saber qué parámetros usar.

**v1.54.1** añade `tool_desc_safe_only = true` (whitelist): solo trunca los 10 built-ins.

## La solución correcta (v1.54.1)

**Truncar al primer párrafo** (hasta el primer `\n\n`). El primer párrafo es la descripción real. Lo demás es documentación de referencia.

### Resultado tras la corrección

| Métrica | Antes | Después |
|---|---|---|
| Chars totales | 98,006 | 17,329 |
| Tokens equivalentes | ~28,001 | ~4,951 |
| **Ahorro por request** | — | **~23,050 tokens** |

Bash: 10,441 chars → 53 chars. Workflow: 18,285 → 263 chars.

## Config

En `~/.squeezr/squeezr.toml`:
```toml
tool_desc_compress = true    # activa la compresión
tool_desc_first_para = true  # usa primer párrafo (default cuando compress=true)
```

Activado por defecto desde v1.54.0. Solo aplica a descriptions >500 chars. Nunca toca `input_schema` ni `name`.

## Lo que NO hemos tocado (por ahora)

- **108 tools** tienen ≤200 chars de description — ya son compactas, se dejan igual.
- **`input_schema`** — nunca se toca. Es el JSON que define los parámetros y es funcional.
- **`name`** — nunca se toca. Es lo que Claude Code usa para llamar a la herramienta.

## Próximo paso relacionado: MCP tool filtering (v1.55.0)

Con 145 tools hay otra oportunidad: **no mandar herramientas que no son relevantes para la tarea**. Si el usuario está trabajando en código Python, no necesita las herramientas del servidor de HubSpot MCP. Filtrar por servidor MCP podría eliminar decenas de tools del array completamente.

Pero esto requiere más análisis (¿qué tools vienen de qué servidor? ¿cómo sabe Squeezr cuáles son relevantes?) y es de **riesgo alto** — se trata en v1.55.0.
