---
title: Guía rápida
---

# Guía rápida

Instálalo, apúntalo a un proyecto y consigue que se firme una etapa: unos cinco minutos.
Cada salida que ves aquí abajo vino de correr el comando; donde está recortada, lo dice.

## Instalar

```bash
npm i -g tldr-experts     # te deja `tldrx` y `tldr-experts`: el mismo binario
tldrx doctor              # la autoridad sobre qué más te hace falta
```

Para *correr* tldrx necesitas **Node 20 o más nuevo**, y nada más: el paquete se publica
como un bundle ya compilado, sin dependencias en tiempo de ejecución. **Bun 1.3+** aquí es
herramienta de quien contribuye —compila ese bundle y corre la suite de pruebas—, así que no
te hace falta para instalar ni para usar un tldrx publicado. `doctor` revisa lo demás — `git`,
`claude`, un par de extras opcionales — y para cada cosa que falte imprime el comando de
instalación en vez de instalarla por su cuenta. Una máquina limpia termina en
`All required tools present. ✓`.

## Primero, pruébalo gratis

```bash
tldrx learn
```

Ocho capítulos, unos quince minutos, en un sandbox desechable con un repo de juguete y un
agente de utilería. Cada comando ahí dentro es el de verdad — `init`, `run new`, `next`,
`answer`, `approve`, y un Build que corta una rama y corre un DoD real — así que nada de lo
que te enseña puede desviarse de lo que hace el binario. **Sin llave de API, sin red,
$0.00**, y no escribe nada fuera de su propio directorio de sandbox.

```
1. init — what the framework knows before you tell it anything
2. a question becomes a fact
3. the gate — an approval is a record, not a keystroke
4. build one story — branch, agent, DoD, commit, merge, review
5. when things go wrong — a red DoD, and the way back from it
6. the agent gate — what a signature has to rest on
7. attended — you write the code, the framework still keeps the record
8. money — the ledger, the estimate, and the brake
```

Retoma donde te quedaste; `--chapter <n>` salta, `--list` muestra el avance, `--reset`
empieza de cero. Si lo que quieres es entender tldrx sin tocar nada tuyo, quédate aquí.

## Luego, en tu propio proyecto

### 1. Configúralo

```bash
cd your-project
tldrx init            # determinista y sin conexión: archivos y git nada más, $0.00
tldrx interview --init
```

```
tldrx init — single-repo, 1 repo(s) under /Users/you/acme-api
  acme-api             javascript · confidence high · branch main
  map        6 documents via graphify
  experts    6 seeded at level 0
  questions  4 written to .tldrx/init-questions.md
```

Ahí va recortado: después de `questions` sigue un resumen de `files` — cuántos archivos se
escribieron, cuántos se crearon y cuántos eran tuyos y se quedaron intactos.

`init` escribe `.tldrx/`: lo que detectó, un mapa del código, los seis expertos de arriba —
cinco expertos de rol siempre, un experto de stack por lenguaje y un experto de dominio por
cada carpeta de código de primer nivel que encontró el mapa, con tope de ocho — y la lista
corta de preguntas que la detección no pudo responder. `interview --init` te las hace en la
terminal — contéstalas ahí en lugar de editar el archivo, porque la entrevista es lo que
registra cada respuesta como un hecho numerado en `.tldrx/memory/facts.yml`:

```
(3/4) Q3 · Who owns `acme-api`?
      Why asked: ownership cannot be read from the filesystem and nothing is recorded yet
      A) I own it        B) other — write the owner's name below
[A-E · free text · s=skip · q=quit] >  recorded Q3 → F003 (area ownership)
```

### 2. Abre una pieza de trabajo

```bash
tldrx run new bulk-pricing --scope feature --budget 5
```

```
created tldrx-work/260901-bulk-pricing — scope feature (feature.yml), 5 stage(s), $5.00 ceiling
```

Después, `tldrx run status` te enseña la forma que tiene: cinco etapas, un techo por fase,
el cursor puesto en la primera y cuáles compuertas son tuyas — `3 human, 2 auto` para un
run de scope `feature`.

### 3. Corre la primera etapa

```bash
tldrx next
```

```
01-what/what done — $0.31 of $4.00 (claim-sources:passed, no-reask:skipped, budget-gate:skipped)
gate pending: tldrx approve
```

::: tip El código de salida 4 no es un error
`next` sale con `4` — *esperando a una persona*. El trabajo está hecho; la decisión es
tuya. (La segunda cifra es el techo de esa etapa, no el del run. Esa salida viene del
sandbox, donde el agente es de utilería; en tu proyecto la cifra en dólares es lo que el
modelo cobró de verdad.)
:::

Lee `tldrx-work/260901-bulk-pricing/01-what/handoff.md`. Si la etapa te preguntó algo,
`tldrx answer Q1 "a JSON file the build reads"` → `Q1 answered → F001`.

### 4. Firma la compuerta

```bash
tldrx approve --note "a price change should be a data change, not a code change"
```

```
approved 01-what/what (claim-sources:passed, no-reask:skipped, budget-gate:skipped)
cursor → 02-how/how (ready)
```

`approve` **vuelve a correr las verificaciones de la etapa contra lo que hay en disco** y
luego registra quién firmó, cuándo, y tu nota tal cual en `run.yml`. Esa nota es lo que lee
la etapa siguiente. Después `tldrx next` otra vez, y así hasta Watch.

## Y de aquí

- Llévalo hasta la siguiente decisión de verdad con `tldrx run auto` — [Atendido o desatendido](/es/guides/driving).
- Qué puede cerrar una compuerta por su cuenta — [Compuertas](/es/concepts/gates).
- Manejarlo desde Claude Code — [Preguntas frecuentes](/es/guides/faq#puedo-manejarlo-desde-claude-code).
- Haz commit de `.tldrx/` y `tldrx-work/` — [los archivos son el estado](/es/concepts/files-as-state).
