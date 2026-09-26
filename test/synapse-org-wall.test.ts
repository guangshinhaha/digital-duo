import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// deploy/synapse/modules/duo_org_wall is the Synapse module that makes the org wall
// a hard wall (#235, docs/deploy/hosted-workspace.md §6). Its decisions and its Synapse
// glue are Python, unit-tested with unittest against a stand-in `synapse` (python3 is the
// only dependency; skipped when absent). The same module against a REAL Synapse is
// deploy/synapse/modules/duo_org_wall/tests/real_synapse.py: slow (it installs and
// starts Synapse), so it is opt-in here.
const modules = join(__dirname, "..", "deploy", "synapse", "modules");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("deploy/synapse/modules/duo_org_wall (unit)", () => {
  it("passes its unittest suite", () => {
    const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", "duo_org_wall/tests", "-t", ".", "-p", "test_*.py"], {
      cwd: modules,
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    });
    expect(result.stderr, result.stderr).toMatch(/\nOK\s*$/);
    expect(result.status).toBe(0);
  });
});

describe("the image ships the module", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "deploy", "synapse", "Dockerfile"), "utf8");

  it("copies it, compiles it and puts it on PYTHONPATH, without its tests", () => {
    expect(dockerfile).toContain("COPY modules/ /modules/");
    expect(dockerfile).toContain("ENV PYTHONPATH=/modules");
    expect(readFileSync(join(__dirname, "..", "deploy", "synapse", ".dockerignore"), "utf8")).toContain("**/tests");
  });
});

// Opt in: DUO_TEST_SYNAPSE_PYTHON=/path/to/venv/bin/python (a Python with matrix-synapse
// at the version the Dockerfile pins). About 20 seconds; nothing leaves 127.0.0.1.
const synapsePython = process.env.DUO_TEST_SYNAPSE_PYTHON;
describe.skipIf(!synapsePython)("deploy/synapse/modules/duo_org_wall against a real Synapse (opt-in)", () => {
  it("passes every check of real_synapse.py", () => {
    const pinned = /matrixdotorg\/synapse:v([\d.]+)/.exec(readFileSync(join(__dirname, "..", "deploy", "synapse", "Dockerfile"), "utf8"))?.[1];
    const version = spawnSync(synapsePython!, ["-c", "import synapse; print(synapse.__version__)"], { encoding: "utf8" }).stdout.trim();
    expect(version, "DUO_TEST_SYNAPSE_PYTHON must have the Synapse version the Dockerfile pins").toBe(pinned);
    const result = spawnSync(synapsePython!, [join(modules, "duo_org_wall", "tests", "real_synapse.py")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.stdout, result.stdout + result.stderr).toMatch(/\d+ checks, 0 failed/);
    expect(result.status).toBe(0);
  }, 300_000);
});
