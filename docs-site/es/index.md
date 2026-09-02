---
layout: home

hero:
  name: tldr-experts
  text: Un framework de desarrollo con IA basado en evidencia
  tagline: Cinco etapas, una compuerta en cada una, y toda afirmación citada o rechazada. Corre desde tu terminal o desde Claude Code.
  actions:
    - theme: brand
      text: Guía rápida
      link: /es/quickstart
    - theme: alt
      text: Pruébalo sin conexión y gratis
      link: /es/quickstart#primero-pruebalo-gratis
    - theme: alt
      text: GitHub
      link: https://github.com/ederwii/tldr-experts
features:
  - title: Tú decides, él lo registra
    details: Cada etapa se detiene. Tú la apruebas, con una nota. Quién firmó, cuándo y por qué queda en un archivo que vas a poder leer seis semanas después.
  - title: Toda afirmación lleva su fuente
    details: Un hallazgo sin un archivo, una línea, un comando o un id de hecho detrás se rechaza antes de que la etapa pueda terminar. Se acabaron los párrafos muy seguros de sí mismos sobre código que nadie abrió.
  - title: El dinero se mide, no se adivina
    details: "Cada dólar que se reporta viene de lo que el modelo cobró de verdad. El único comando que estima lo dice con todas sus letras: ESTIMATE."
  - title: Los archivos son el estado
    details: Todo vive en .tldrx/ y tldrx-work/, dentro de tu repo. Haz commit y quien clone se lleva el run completo.
---

<script setup>
// The version and maturity tag come from package.json and the README release table at
// build time (docs-site/version.ts), so this page cannot lag a release.
import { useData } from 'vitepress'
const { theme } = useData()
</script>

## Qué es

Le pides a una IA que construya algo. Se va, hace un montón de cosas y vuelve con un
resumen que no te queda más que creerle. Después ya no hay forma de saber qué leyó, qué
supuso, cuánto costó ni quién estuvo de acuerdo con nada de eso.

tldrx le pone forma a eso. El trabajo se parte en cinco etapas — **What → How → Plan →
Build → Watch** — y cada una termina en una **compuerta** (*gate*). Una compuerta es un
alto: nada de lo que viene después corre hasta que esté firmada. Unas las firmas tú; otras
las puede firmar la herramienta sola, pero solo cuando puede mostrar en qué se basó.

Todo lo que produce una etapa es un archivo dentro de tu repo: la intención, el diseño, el
plan, las preguntas que no pudo responder, las respuestas que le diste, el dinero gastado.
Esos archivos no son un reporte del estado. **Son** el estado: la herramienta los vuelve a
leer para decidir qué sigue. El estado canónico vive en disco: se puede inspeccionar,
comparar, versionar y recuperar.

## Cómo se siente

::: info 1 — Abre una pieza de trabajo
`tldrx run new payments --scope feature --budget 25` escribe una carpeta. Todavía no ha
corrido nada y no se ha gastado nada.
:::

::: info 2 — Corre una etapa
`tldrx next` corre la etapa donde está el cursor, escribe sus archivos y se detiene en la
compuerta con código de salida `4`: "el trabajo está hecho, la decisión es tuya".
:::

::: info 3 — Fírmala, o regrésala
`tldrx approve --note "why"` vuelve a correr las verificaciones de la etapa contra lo
que hay en disco y adelanta el cursor. `tldrx reject --note "…"` la regresa, y el siguiente
intento lee tu nota.
:::

Repite hasta terminar el run. `tldrx run auto` hace esa repetición por ti y se detiene la
primera vez que algo de verdad necesita a una persona.

## Cuando nadie está viendo

Los tres pasos de arriba son contigo en el teclado. El otro caso es el exigente: le
entregas un run para toda la noche, dentro de los límites que tú escribiste — qué
compuertas puede cerrar un agente, y cuánto puede costar todo — y lo que regresa no es un
resumen que no te quede más que creer. Es el run mismo: los archivos que escribió cada
etapa, la nota de evidencia debajo de cada firma, el dinero que de verdad gastó, todo en
disco y en el orden que quieras leerlo.

```bash
tldrx init            # determinista y sin conexión: archivos y git nada más, $0.00
tldrx run new payments --scope feature --budget 25 \
  --attended-by host --gates what:agent,plan:agent,build:agent,watch:agent
tldrx drive --unattended    # el mandato: pégalo en una sesión de Claude Code
```

Ese último comando no abre ningún run y no lanza nada: imprime el **mandato** desde el que
maneja la sesión. El mandato es lo que mantiene honesta la noche — un subagente que
programa, luego un revisor nuevo que nunca es quien escribió el código, una compuerta que
se firma solo sobre una nota de evidencia escrita, y las cuatro cosas para las que sí tiene
que despertarte en lugar de decidirlas.

[Atendido o desatendido](/es/guides/driving): las tres maneras de correr una etapa, cuál
elegir, y qué cuesta cada una.

## En qué punto está

**{{ theme.tldrxStatus }}, versión {{ theme.tldrxVersion }}.** Todos los comandos son reales y están probados — la documentación
de este sitio se escribió corriéndolos — y la autoridad es `tldrx --help` en tu máquina, no
este sitio.

El requisito para llegar a **beta** era público y ya se cumplió: formatos de archivo
congelados (los esquemas `version: 1` solo crecen), dos o más workspaces reales llevados
hasta la fase Build, y una ruta de actualización documentada. Las versiones hasta la 0.3.1
fueron `alpha`; la 0.4.0 fue la primera `beta`. **Stable** quiere decir 1.0 y semver de ahí
en adelante.

El paquete se instala como `tldr-experts` y te deja dos comandos: `tldrx` (el corto) y
`tldr-experts` (el mismo binario).
