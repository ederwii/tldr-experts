import { defineConfig } from "vitepress";
import { tldrxStatusLabel, tldrxVersion } from "../version.ts";

const REPO = "https://github.com/ederwii/tldr-experts";

// Resolved once, at build time, from package.json and the README release table — never
// typed into a page. See docs-site/version.ts for why. Exposed through `themeConfig` on
// the root AND on each locale: VitePress merges the two, and a page that renders
// `undefined` here would advertise nothing at all, so both are set explicitly.
const VERSION = tldrxVersion();
const STATUS = tldrxStatusLabel();

// One sidebar, shared by every English page. `sidebarEs` below is its Spanish mirror:
// same shape, same order, every link prefixed `/es/`.
const sidebarEn = [
  {
    text: "Start here",
    items: [
      { text: "What tldrx is", link: "/" },
      { text: "Quickstart", link: "/quickstart" },
      { text: "Live demo", link: "/demo" },
    ],
  },
  {
    text: "Concepts",
    items: [
      { text: "The five stages", link: "/concepts/stages" },
      { text: "The files are the state", link: "/concepts/files-as-state" },
      { text: "Gates and who closes them", link: "/concepts/gates" },
      { text: "Evidence", link: "/concepts/evidence" },
      { text: "Budgets", link: "/concepts/budgets" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "Attended or unattended", link: "/guides/driving" },
      { text: "Budgets and estimates", link: "/guides/budgets" },
      { text: "Experts", link: "/guides/experts" },
      { text: "FAQ for the impatient", link: "/guides/faq" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "CLI overview", link: "/reference/cli" },
      { text: "Dashboard", link: "/reference/dashboard" },
      { text: "Release notes", link: "/reference/changelog" },
    ],
  },
];

// The Spanish mirror of `sidebarEn`. Release notes are generated from CHANGELOG.md at
// build time and are deliberately NOT translated — a second copy would drift — so this
// one entry points at the English page rather than a /es/ path that does not exist.
const sidebarEs = [
  {
    text: "Empieza aquí",
    items: [
      { text: "Qué es tldrx", link: "/es/" },
      { text: "Guía rápida", link: "/es/quickstart" },
      { text: "Demo en vivo", link: "/es/demo" },
    ],
  },
  {
    text: "Conceptos",
    items: [
      { text: "Las cinco etapas", link: "/es/concepts/stages" },
      { text: "Los archivos son el estado", link: "/es/concepts/files-as-state" },
      { text: "Compuertas y quién las cierra", link: "/es/concepts/gates" },
      { text: "Evidencia", link: "/es/concepts/evidence" },
      { text: "Presupuestos", link: "/es/concepts/budgets" },
    ],
  },
  {
    text: "Guías",
    items: [
      { text: "Atendido o desatendido", link: "/es/guides/driving" },
      { text: "Presupuestos y estimaciones", link: "/es/guides/budgets" },
      { text: "Expertos", link: "/es/guides/experts" },
      { text: "Preguntas frecuentes", link: "/es/guides/faq" },
    ],
  },
  {
    text: "Referencia",
    items: [
      { text: "Resumen de la CLI", link: "/es/reference/cli" },
      { text: "Dashboard", link: "/es/reference/dashboard" },
      { text: "Notas de versión (en inglés)", link: "/reference/changelog" },
    ],
  },
];

export default defineConfig({
  title: "tldr-experts",
  description:
    "An evidence-first, file-based AI development framework. Five stages, a gate at the end of each whose closer you choose, and every claim on disk carrying a source.",
  base: "/tldr-experts/",
  cleanUrls: true,
  lastUpdated: true,
  // Dead links fail the build. Left on deliberately: this site links into the repo's
  // own docs a lot, and a rename there should break the build, not the reader.
  ignoreDeadLinks: false,

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        tldrxVersion: VERSION,
        tldrxStatus: STATUS,
        nav: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "Demo", link: "/demo" },
          { text: "Concepts", link: "/concepts/stages" },
          { text: "Guides", link: "/guides/driving" },
          { text: "Reference", link: "/reference/cli" },
        ],
        sidebar: sidebarEn,
        editLink: {
          pattern: `${REPO}/edit/main/docs-site/:path`,
          text: "Edit this page on GitHub",
        },
        outline: [2, 3],
      },
    },
    es: {
      label: "Español",
      lang: "es",
      link: "/es/",
      description:
        "Un framework de desarrollo con IA basado en archivos y en evidencia. Cinco etapas, una compuerta al final de cada una cuyo cierre tú decides, y toda afirmación en disco con su fuente al lado.",
      themeConfig: {
        tldrxVersion: VERSION,
        tldrxStatus: STATUS,
        nav: [
          { text: "Guía rápida", link: "/es/quickstart" },
          { text: "Demo", link: "/es/demo" },
          { text: "Conceptos", link: "/es/concepts/stages" },
          { text: "Guías", link: "/es/guides/driving" },
          { text: "Referencia", link: "/es/reference/cli" },
        ],
        sidebar: sidebarEs,
        editLink: {
          pattern: `${REPO}/edit/main/docs-site/:path`,
          text: "Edita esta página en GitHub",
        },
        outline: { level: [2, 3], label: "En esta página" },
        // Without these the chrome around Spanish prose stays in English.
        docFooter: { prev: "Anterior", next: "Siguiente" },
        lastUpdatedText: "Última actualización",
        returnToTopLabel: "Volver arriba",
        sidebarMenuLabel: "Menú",
        darkModeSwitchLabel: "Apariencia",
        lightModeSwitchTitle: "Cambiar a modo claro",
        darkModeSwitchTitle: "Cambiar a modo oscuro",
        langMenuLabel: "Cambiar de idioma",
        footer: {
          message: "Publicado bajo licencia MIT. Software beta: los formatos de archivo ya están congelados.",
          copyright: "© 2026 Alan Martinez",
        },
      },
    },
  },

  themeConfig: {
    tldrxVersion: VERSION,
    tldrxStatus: STATUS,
    socialLinks: [{ icon: "github", link: REPO }],
    search: {
      provider: "local",
      options: {
        locales: {
          es: {
            translations: {
              button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" },
              modal: {
                displayDetails: "Mostrar detalles",
                resetButtonTitle: "Limpiar la búsqueda",
                backButtonTitle: "Regresar",
                noResultsText: "Sin resultados para",
                footer: {
                  selectText: "para seleccionar",
                  navigateText: "para navegar",
                  closeText: "para cerrar",
                },
              },
            },
          },
        },
      },
    },
    footer: {
      message: "MIT licensed. Beta software — the file formats are frozen.",
      copyright: "© 2026 Alan Martinez",
    },
  },
});
