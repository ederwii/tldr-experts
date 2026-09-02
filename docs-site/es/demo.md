---
title: Demo en vivo
---

<script setup>
import { withBase } from 'vitepress'
</script>

# Demo en vivo

Abajo hay una página real de `tldrx dashboard --static`. No es una captura ni una maqueta:
la exportación se genera en cada despliegue de este sitio con el mismo constructor de modelo
y el mismo renderer que usa el comando en tu terminal, así que lo que ves es lo que dibuja
el `tldrx` de hoy.

::: warning Todos los números son inventados
El workspace detrás de esta página no existe. Está armado con los fixtures sintéticos de la
propia suite de pruebas del framework — ocho runs con nombres como *Player scoreboard* y
*Migrate the ledger*, dos expertos inventados, dólares inventados, firmas inventadas. Ningún
proyecto, cliente ni repositorio real aparece aquí, y el generador se niega físicamente a
leer de otro lugar que no sea `test/fixtures/`.
:::

<p>
  <a :href="withBase('/dashboard-demo/index.html')" target="_blank" rel="noreferrer"><strong>Abrir la demo a pantalla completa →</strong></a>
</p>

<iframe
  :src="withBase('/dashboard-demo/index.html')"
  title="tldrx dashboard — demo"
  loading="lazy"
  style="width:100%;height:80vh;border:1px solid var(--vp-c-divider);border-radius:8px;background:#FFFDF8"
></iframe>

## Qué mirar

| En la página | Qué te está mostrando |
|---|---|
| La lista de runs | Ocho runs a la vez, y los cuatro estados que significan **hay una persona bloqueando**: una pregunta abierta, una compuerta pendiente, una etapa fallida, un bundle esperando a que alguien lo corra. El que puedes retomar ahora lleva `← next`. |
| `260901-scoreboard` | Ábrelo. El camino de ejecución etapa por etapa — experto, modelo, costo, quién firmó la compuerta y cuándo —, más el handoff que escribió y las preguntas que no pudo contestar solo. |
| `260903-delta` | Un run detenido en una pregunta. Esta es la forma del asunto: la herramienta no adivina una ventana de retención, se detiene y pregunta. |
| `260903-bravo`, `260903-golf` | Runs que no están bloqueados por una persona: están esperando a que termine otro run. |
| Experts | Dos perfiles de competencia, con los niveles **recalculados desde la evidencia al momento de leer** en lugar de leídos del disco, y las filas de evidencia detrás de cada uno. |

Todo lo que hay ahí salió de archivos. No hay base de datos ni servidor detrás de los
números — [los archivos son el estado](/es/concepts/files-as-state), y el dashboard es una
lectura de ellos.

## Pruébalo en tu propio workspace

```bash
tldrx dashboard              # un servidor vivo en 127.0.0.1, que se redibuja al cambiar los archivos
tldrx dashboard --static     # escribe un index.html autocontenido y se detiene
```

La exportación estática es un solo archivo con el CSS, el JavaScript y los datos
incrustados. No pide nada por red — por eso se puede dejar caer en un sitio estático como
este, y por eso no filtra nada sobre quién la abre. En
[la referencia del dashboard](/es/reference/dashboard) está qué trae cada vista y qué cosas
la página deliberadamente **no** hace.

## Cómo se mantiene honesta esta página

Se regenera desde cero en cada despliegue de la documentación, con
`docs-site/scripts/gen-demo.ts`, y el workflow que publica el sitio también corre cuando
cambia el código del dashboard o los fixtures detrás de él. Una demo que se reconstruye no
puede volverse en silencio la foto de una versión que ya no existe — y la suite de pruebas
sostiene lo demás: que la página es autocontenida, que no nombra ninguna ruta de la máquina
que la construyó, y que quitarle el único banner deja bytes idénticos a los que escribe la
CLI.
