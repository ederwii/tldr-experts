import { defineConfig } from "vitepress";

const REPO = "https://github.com/ederwii/tldr-experts";

// One sidebar, shared by every English page. Phase 2 (Spanish) adds a second one
// under `locales.es` — the structure below is what it will mirror.
const sidebarEn = [
  {
    text: "Start here",
    items: [
      { text: "What tldrx is", link: "/" },
      { text: "Quickstart", link: "/quickstart" },
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
      { text: "Release notes", link: "/reference/changelog" },
    ],
  },
];

export default defineConfig({
  title: "tldr-experts",
  description:
    "A file-based AI development workflow. Five stages, a gate you own at the end of each, and every claim on disk carrying a source.",
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
        nav: [
          { text: "Quickstart", link: "/quickstart" },
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
    // Phase 2. The directory exists with one placeholder page so the locale switcher
    // is wired now and translations are a drop-in later.
    es: {
      label: "Español",
      lang: "es",
      link: "/es/",
      themeConfig: {
        nav: [{ text: "Inicio", link: "/es/" }],
        sidebar: [{ text: "Español", items: [{ text: "Estado", link: "/es/" }] }],
      },
    },
  },

  themeConfig: {
    socialLinks: [{ icon: "github", link: REPO }],
    search: { provider: "local" },
    footer: {
      message: "MIT licensed. Alpha software — interfaces may change.",
      copyright: "© 2026 Alan Martinez",
    },
  },
});
