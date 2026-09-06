/**
 * Overlays are facts about manifests (stack packs design §4.4). Every rule fires on a
 * synthetic manifest that names the signal and stays silent on its negative; the evidence
 * string is the table's, verbatim, because that string is written into workspace.yml.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverlayRules, detectOverlays, includeNames, OVERLAY_RULES, PACK_LANGUAGES,
  pyprojectDependencies, readManifests, requirementNames,
} from "../src/core/detect/overlays.ts";
import { detectStack } from "../src/core/detect/stack.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A throwaway repo dir holding exactly `files` (path → text). Dirs ending in `/` are created empty. */
function repo(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "tldrx-overlays-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    if (rel.endsWith("/")) { mkdirSync(join(dir, rel), { recursive: true }); continue; }
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  return dir;
}

function pkg(deps: Record<string, string>, dev: Record<string, string> = {}): string {
  return JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev }) + "\n";
}

async function overlays(dir: string): Promise<Record<string, string>> {
  const stack = await detectStack(dir);
  const out: Record<string, string> = {};
  for (const item of await detectOverlays(dir, stack.packageJson)) out[item.id] = item.evidence;
  return out;
}

const WEB_CSPROJ = "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <ItemGroup>\n    <PackageReference Include=\"Swashbuckle.AspNetCore\" />\n  </ItemGroup>\n</Project>\n";

describe("the table is what ships", () => {
  test("thirteen rules, unique ids, every id assigned to at least one pack language", () => {
    expect(OVERLAY_RULES).toHaveLength(13);
    expect(new Set(OVERLAY_RULES.map((rule) => rule.id)).size).toBe(13);
    for (const rule of OVERLAY_RULES) {
      expect(rule.languages.length, rule.id).toBeGreaterThan(0);
      for (const lang of rule.languages) expect(PACK_LANGUAGES).toContain(lang);
    }
  });

  test("a repo with no manifest at all yields no overlay — never a guess", async () => {
    expect(await overlays(repo({ "README.md": "# hi\n" }))).toEqual({});
  });
});

describe("JavaScript / TypeScript rules", () => {
  test("react fires on a dependency and says which group it came from", async () => {
    expect(await overlays(repo({ "package.json": pkg({ react: "*" }) })))
      .toEqual({ react: "package.json: dependencies.react" });
  });

  test("vite + react without next is a SPA; with next it is not", async () => {
    const spa = await overlays(repo({ "package.json": pkg({ react: "*" }, { vite: "*" }) }));
    expect(spa["vite-react-spa"]).toBe("package.json: devDependencies.vite + dependencies.react");
    const withNext = await overlays(repo({ "package.json": pkg({ react: "*", next: "*" }, { vite: "*" }), "app/": "" }));
    expect(withNext["vite-react-spa"]).toBeUndefined();
    expect(withNext["next-app-router"]).toBe("package.json: dependencies.next; app/ present");
  });

  test("next without an app/ directory is not the app router", async () => {
    expect((await overlays(repo({ "package.json": pkg({ next: "*" }) })))["next-app-router"]).toBeUndefined();
    expect((await overlays(repo({ "package.json": pkg({ next: "*" }), "src/app/": "" })))["next-app-router"])
      .toBe("package.json: dependencies.next; src/app/ present");
  });

  test("expo-router, express and prisma each fire on their own package", async () => {
    const found = await overlays(repo({ "package.json": pkg({ "expo-router": "*", express: "*" }, { prisma: "*" }) }));
    expect(found["expo-router"]).toBe("package.json: dependencies.expo-router");
    expect(found["node-express"]).toBe("package.json: dependencies.express");
    expect(found.prisma).toBe("package.json: devDependencies.prisma");
    expect((await overlays(repo({ "package.json": pkg({ "@prisma/client": "*" }) }))).prisma)
      .toBe("package.json: dependencies.@prisma/client");
    expect((await overlays(repo({ "package.json": pkg({ expo: "*" }) })))["expo-router"])
      .toBe("package.json: dependencies.expo");
  });
});

describe(".NET rules", () => {
  test("a Web SDK project with no Controllers/ is minimal APIs; with one it is controllers", async () => {
    const minimal = await overlays(repo({ "src/Api/Api.csproj": WEB_CSPROJ }));
    expect(minimal).toEqual({ "aspnet-minimal-apis": "src/Api/Api.csproj: Sdk=Web; no Controllers/" });
    const controllers = await overlays(repo({ "src/Api/Api.csproj": WEB_CSPROJ, "src/Api/Controllers/": "" }));
    expect(controllers).toEqual({ "aspnet-controllers": "src/Api/Api.csproj: Sdk=Web; Controllers/ present" });
  });

  test("a library project is neither", async () => {
    expect(await overlays(repo({ "src/Lib/Lib.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n" }))).toEqual({});
  });

  test("MediatR is found in a csproj PackageReference, case-insensitively, evidence as written", async () => {
    const found = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"mediatr\" Version=\"1\" /></ItemGroup></Project>\n",
    }));
    expect(found["mediatr-cqrs"]).toBe("src/App/App.csproj: Include=\"mediatr\"");
  });

  test("Directory.Packages.props is honoured when the csproj carries no version", async () => {
    const found = await overlays(repo({
      "Directory.Packages.props": "<Project><ItemGroup><PackageVersion Include=\"MediatR\" Version=\"12.0.0\" /></ItemGroup></Project>\n",
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"MediatR\" /></ItemGroup></Project>\n",
    }));
    expect(found["mediatr-cqrs"]).toBe("Directory.Packages.props: Include=\"MediatR\"");
  });

  test("EF Core needs BOTH an EntityFrameworkCore package and an Npgsql one", async () => {
    const both = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>"
        + "<PackageReference Include=\"Microsoft.EntityFrameworkCore\" Version=\"1\" />"
        + "<PackageReference Include=\"Npgsql.EntityFrameworkCore.PostgreSQL\" Version=\"1\" />"
        + "</ItemGroup></Project>\n",
    }));
    expect(both["efcore-npgsql"]).toBe("src/App/App.csproj: Include=\"Npgsql.EntityFrameworkCore.PostgreSQL\"");
    const efOnly = await overlays(repo({
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><PackageReference Include=\"Microsoft.EntityFrameworkCore\" Version=\"1\" /></ItemGroup></Project>\n",
    }));
    expect(efOnly["efcore-npgsql"]).toBeUndefined();
  });
});

describe("Python rules", () => {
  test("fastapi and sqlalchemy are read from [project] dependencies; alembic is noted either way", async () => {
    const found = await overlays(repo({
      "pyproject.toml": "[project]\nname = \"svc\"\ndependencies = [\n  \"FastAPI>=0.1\",\n  \"sqlalchemy[asyncio]\",\n]\n\n[tool.ruff]\nline-length = 100\n",
    }));
    expect(found.fastapi).toBe("pyproject.toml: dependencies fastapi");
    expect(found["sqlalchemy-alembic"]).toBe("pyproject.toml: dependencies sqlalchemy; alembic absent");
    const withAlembic = await overlays(repo({
      "pyproject.toml": "[project]\ndependencies = [\"sqlalchemy\", \"alembic\"]\n",
    }));
    expect(withAlembic["sqlalchemy-alembic"]).toBe("pyproject.toml: dependencies sqlalchemy; alembic present");
  });

  test("requirements*.txt is honoured too, comments and pins stripped", async () => {
    const found = await overlays(repo({
      "requirements.txt": "# web\nfastapi==0.100.0  # pinned\n-r requirements-dev.txt\n",
      "requirements-dev.txt": "pytest\n",
    }));
    expect(found.fastapi).toBe("requirements.txt: fastapi");
  });

  test("a dependency named in [tool.*] but not in [project] does not count", async () => {
    const found = await overlays(repo({ "pyproject.toml": "[tool.poetry.dependencies]\nfastapi = \"*\"\n" }));
    expect(found.fastapi).toBeUndefined();
  });

  test("a different package sharing a prefix does not fire — matching is exact, not startsWith", async () => {
    expect((await overlays(repo({ "pyproject.toml": "[project]\ndependencies = [\"fastapi-users\"]\n" }))).fastapi)
      .toBeUndefined();
    expect((await overlays(repo({ "pyproject.toml": "[project]\ndependencies = [\"sqlalchemy-utils\"]\n" })))["sqlalchemy-alembic"])
      .toBeUndefined();
  });
});

describe("postgres-testcontainers spans the three ecosystems", () => {
  test(".NET: an Npgsql driver plus a Testcontainers package", async () => {
    const found = await overlays(repo({
      "src/T/T.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>"
        + "<PackageReference Include=\"Npgsql\" Version=\"1\" />"
        + "<PackageReference Include=\"Testcontainers.PostgreSql\" Version=\"1\" />"
        + "</ItemGroup></Project>\n",
    }));
    expect(found["postgres-testcontainers"]).toBe("src/T/T.csproj: Npgsql + Testcontainers.PostgreSql");
  });

  test("npm: pg plus @testcontainers/postgresql", async () => {
    const found = await overlays(repo({ "package.json": pkg({ pg: "*" }, { "@testcontainers/postgresql": "*" }) }));
    expect(found["postgres-testcontainers"]).toBe("package.json: pg + @testcontainers/postgresql");
  });

  test("python: psycopg (any flavour) plus testcontainers", async () => {
    const found = await overlays(repo({ "pyproject.toml": "[project]\ndependencies = [\"psycopg[binary]\", \"testcontainers\"]\n" }));
    expect(found["postgres-testcontainers"]).toBe("pyproject.toml: psycopg + testcontainers");
  });

  test("a driver alone is not a testcontainers setup", async () => {
    expect((await overlays(repo({ "package.json": pkg({ pg: "*" }) })))["postgres-testcontainers"]).toBeUndefined();
  });

  test("psycopg2-binary is a Postgres driver too", async () => {
    const found = await overlays(repo({
      "pyproject.toml": "[project]\ndependencies = [\"psycopg2-binary\", \"testcontainers\"]\n",
    }));
    expect(found["postgres-testcontainers"]).toBe("pyproject.toml: psycopg2-binary + testcontainers");
  });

  test("driver and containers in different files: the evidence names both files, never a package the file doesn't have", async () => {
    const found = await overlays(repo({
      "package.json": pkg({ pg: "*" }),
      "src/T/T.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>"
        + "<PackageReference Include=\"Testcontainers.PostgreSql\" Version=\"1\" /></ItemGroup></Project>\n",
    }));
    expect(found["postgres-testcontainers"]).toBe("package.json: pg + src/T/T.csproj: Testcontainers.PostgreSql");
  });
});

describe("the readers", () => {
  test("includeNames reads PackageReference and PackageVersion, as written", () => {
    expect(includeNames("<PackageReference Include=\"A.B\" Version=\"1\" /><PackageVersion Include=\"c\" />"))
      .toEqual(["A.B", "c"]);
    expect(includeNames("<ProjectReference Include=\"../X/X.csproj\" />")).toEqual([]);
  });

  test("pyprojectDependencies lower-cases and strips extras, versions and markers", () => {
    expect(pyprojectDependencies("[project]\ndependencies = [\n \"Psycopg[binary]>=3 ; python_version>='3.10'\",\n 'Alembic',\n]\n"))
      .toEqual(["psycopg", "alembic"]);
    expect(pyprojectDependencies("[project]\nname='x'\n")).toEqual([]);
  });

  test("requirementNames skips blank lines, comments and -r includes", () => {
    expect(requirementNames("# c\n\nFastAPI==1\n-r other.txt\nuvicorn[standard]\n")).toEqual(["fastapi", "uvicorn"]);
  });

  test("applyOverlayRules runs the given rules in table order", async () => {
    const dir = repo({ "package.json": pkg({ react: "*", express: "*" }) });
    const manifests = await readManifests(dir, (await detectStack(dir)).packageJson);
    expect(applyOverlayRules(manifests).map((item) => item.id)).toEqual(["react", "node-express"]);
  });
});

describe("package.json keeps its two dependency groups apart", () => {
  test("detectStack reports which group a name came from", async () => {
    const stack = await detectStack(repo({ "package.json": pkg({ react: "*" }, { vite: "*" }) }));
    expect(stack.packageJson?.groups.dependencies).toEqual(["react"]);
    expect(stack.packageJson?.groups.devDependencies).toEqual(["vite"]);
    // The merged list every existing reader keys on is unchanged.
    expect(stack.packageJson?.dependencies).toEqual(["react", "vite"]);
  });
});
