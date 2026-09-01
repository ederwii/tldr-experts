---
title: Español
---

# tldr-experts — en español

La traducción al español está en camino. Por ahora, la documentación completa está en
inglés:

- [Quickstart](/quickstart) — instalar, iniciar un proyecto y firmar la primera etapa
- [Conceptos](/concepts/stages) — las cinco etapas, los archivos como estado, las
  compuertas, la evidencia y los presupuestos
- [Guías](/guides/driving) — atendido o desatendido, costos, expertos, preguntas frecuentes
- [Referencia](/reference/cli) — resumen de la CLI y notas de versión

## Mientras tanto, en dos líneas

tldrx divide el trabajo en cinco etapas — **What → How → Plan → Build → Watch** — y cada
una termina en una **compuerta**: nada continúa hasta que alguien la firma. Todo lo que
produce son archivos dentro de tu repositorio, y esos archivos *son* el estado: la
herramienta los vuelve a leer en cada comando para decidir qué sigue.

Para probarlo sin riesgo, sin clave de API y sin gastar nada:

```bash
npm i -g tldr-experts
tldrx learn
```

::: info Esta página es un marcador
La estructura de idiomas del sitio ya está configurada. Traducir consiste en copiar las
páginas en inglés dentro de `docs-site/es/` y añadir su barra lateral en
`docs-site/.vitepress/config.mts`.
:::
