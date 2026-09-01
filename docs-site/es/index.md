---
layout: home

hero:
  name: tldr-experts
  text: Un flujo de desarrollo con IA que deja rastro por escrito
  tagline: Cinco etapas, una compuerta tuya al final de cada una, y toda afirmación escrita en un archivo con su fuente al lado. Corre desde tu terminal o desde Claude Code.
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
  - title: Son nada más archivos
    details: Todo vive en .tldrx/ y tldrx-work/, dentro de tu repo. Haz commit y quien clone se lleva el run completo.
---

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
leer para decidir qué sigue, así que no hay nada que se pueda desincronizar.

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
`tldrx approve --note "por qué"` vuelve a correr las verificaciones de la etapa contra lo
que hay en disco y adelanta el cursor. `tldrx reject --note "…"` la regresa, y el siguiente
intento lee tu nota.
:::

Repite hasta terminar el run. `tldrx run auto` hace esa repetición por ti y se detiene la
primera vez que algo de verdad necesita a una persona.

## En qué punto está

**Alpha, versión 0.3.1.** Todos los comandos son reales y están probados — la documentación
de este sitio se escribió corriéndolos — pero las interfaces pueden cambiar sin aviso, y la
autoridad es `tldrx --help` en tu máquina, no este sitio.

El requisito para llegar a **beta** es público y ya se está avanzando en él: formatos de
archivo congelados (los esquemas `version: 1` solo crecen), dos o más workspaces reales
llevados hasta la fase Build, y una ruta de actualización documentada. **Stable** quiere
decir 1.0 y semver de ahí en adelante.

El paquete se instala como `tldr-experts` y te deja dos comandos: `tldrx` (el corto) y
`tldr-experts` (el mismo binario).
