---
title: Expertos
---

# Expertos

Un experto es una carpeta de contexto que se pega dentro del prompt de una etapa. Las
reglas sobre qué puede entrar ahí son la parte interesante.

`tldrx init` te los siembra y nunca pregunta. Cuántos, depende de lo que haya encontrado la
detección — aquí, un solo lenguaje y ninguna carpeta de código que el mapa leyera como
dominio:

```
expert            status   last_trained  areas  evidence  levels
----------------  -------  ------------  -----  --------  ------
architect         created  never         1      0         0
delivery          created  never         1      0         0
developer         created  never         1      0         0
javascript-stack  created  never         1      0         0
operations        created  never         1      0         0
product           created  never         1      0         0

architect — created
  loaded by: how (named), plan (named)
  architect  ☆☆☆☆☆ 0  (no evidence)
```

Se siembran tres clases. Cinco **expertos de rol**, siempre: `product` para What,
`architect` para How y Plan, `delivery` para Plan, `developer` para Build, `operations` para
Watch; los archivos de etapa los nombran, así que no dependen de la detección. Luego un
**experto de stack** por lenguaje, detectado o declarado — dos lenguajes son dos de ellos, y
por eso el conteo de arriba es un piso y no una regla. Y luego un **experto de dominio** por
cada carpeta de código de primer nivel que el mapa leyó como dominio, con tope de ocho para
que un monorepo grande no acabe con cincuenta esbozos que nadie entrena. El repo de arriba
no tenía ninguno que sembrar; uno de verdad casi siempre sí.

Todos arrancan en nivel 0, y un experto en nivel 0 no está roto: aporta la descripción de su
rol y nada más.

## Qué trae uno adentro

```
.tldrx/experts/billing/
  expert.md              el rol, el dominio que le toca y sus reglas de cita — esto lo escribió una persona
  competencies.yml       una línea por área, calculada de la evidencia, nunca autodeclarada
  knowledge/money.md     lo que encontró el entrenamiento, cada punto con su fuente
```

La tabla de estrellas es la parte honesta:

```
ef-core  ★★★☆☆ 3  (17 evidence, newest 2026-08-20)
```

**Un nivel se mueve porque se citó un archivo, nunca porque un agente dijo que aprendió
algo.** Nada de lo que un experto afirme sobre sí mismo cambia su número.

## Qué expertos carga una etapa

Tres reglas, y nada más tres:

1. la etapa lo nombra (`experts:` en `stage.yml`);
2. es el experto `<language>-stack` de alguno de los repos del run;
3. es un experto de **dominio** cuyas rutas declaradas el run sí cita — o que queda a dos
   saltos de una ruta citada en el grafo del código.

`tldrx expert list` imprime una línea `loaded by:` por cada uno — `how (named), plan
(named)` — para que un experto entrenado que ninguna etapa va a cargar jamás deje de ser
invisible.

Todos los expertos cargados comparten **un solo** presupuesto de conocimiento de 48 KB,
repartido según qué tan relevante es cada uno para este run, en vez de darle uno propio a
cada quien. Los archivos que la etapa declaró como entradas se llenan primero: una entrada
que la etapa pidió le gana a material de referencia que nadie pidió.

## Cómo entrenar uno

```bash
tldrx expert create billing --domain money
tldrx expert train billing --area money --mode light --print-prompt   # gratis: imprime y se para
tldrx expert train billing --area money --mode light
```

`--mode light` lee el código. `--mode full` escarba en los handoffs de los runs terminados;
los expertos de rol solo se entrenan en `full`, porque su materia es el flujo de trabajo y
no una carpeta de código.

Dos cosas hacen que el resultado sea confiable:

- **Ningún modelo elige qué leer.** Una pasada previa determinista escoge los archivos a
  partir del mapa de código, del grafo y de una búsqueda acotada por palabras clave — con
  tope de 40 archivos y 96 KB, y todo lo que rebasa el tope queda **listado por nombre como
  "not read"**, para que un subagente no pueda describir un archivo que nunca le enseñaron.
- **El dominio declarado del experto es un límite duro.** Una cita fuera de él no le gana
  evidencia a ese experto, por muy cierta que sea.

`tldrx expert recompute` vuelve a derivar cada nivel a partir de la evidencia que hay en
disco.

## ¿De verdad hace falta?

No. Un experto sin entrenar se gana una nota en stderr que nombra su comando de
entrenamiento, y nunca bloquea nada ni cambia un código de salida. Entrenar es lo que haces
cuando una etapa se la pasa volviendo a deducir lo mismo sobre tu código: el conocimiento
entrenado ya viene con sus fuentes, así que la etapa siguiente lo puede reusar tal cual en
lugar de pagar por redescubrirlo.

El detalle completo: [4 — Experts](https://github.com/ederwii/tldr-experts/blob/main/docs/guide/04-experts.md).
