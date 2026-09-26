import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// deploy/synapse/ensure_db.py and create_admin.py run inside the Synapse
// container (docs/deploy/railway.md). Neither can reach a real Postgres or
// Synapse here, so each test drives the module from a short python3 program
// with the network edge faked (psycopg2 for ensure_db, `call` for create_admin).
// python3 is the only dependency; skip when absent.
const dir = join(__dirname, "..", "deploy", "synapse");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function py(program: string, env: Record<string, string> = {}) {
  const result = spawnSync("python3", ["-c", program], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return result;
}

// A stand-in `psycopg2` importable by ensure_db.py, whose connect() fails
// FAILS times with OperationalError before it hands back a connection.
const FAKE_PSYCOPG2 = `
import json, sys, types

class OperationalError(Exception):
    pass

class Cursor:
    def __init__(self, log, exists): self.log, self.exists = log, exists
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, query, params=None): self.log.append(str(query))
    def fetchone(self): return (1,) if self.exists else None

class Conn:
    autocommit = False
    def __init__(self, log, exists): self.log, self.exists = log, exists
    def cursor(self): return Cursor(self.log, self.exists)

class Query:
    def __init__(self, text): self.text = text
    def format(self, ident): return Query(self.text.replace("{}", ident.name))
    def __str__(self): return self.text

class Identifier:
    def __init__(self, name): self.name = name

sql = types.ModuleType("psycopg2.sql")
sql.SQL, sql.Identifier = Query, Identifier
fake = types.ModuleType("psycopg2")
fake.OperationalError, fake.sql = OperationalError, sql
sys.modules["psycopg2"], sys.modules["psycopg2.sql"] = fake, sql

log, sleeps, attempts = [], [], []

def make_connect(fails, exists=False):
    def connect(**params):
        attempts.append(sorted(params))
        if len(attempts) <= fails:
            raise OperationalError('connection to server at "postgres.railway.internal" failed: refused\\nmore detail')
        return Conn(log, exists)
    return connect

import ensure_db
ENV = {"SYNAPSE_DB_HOST": "h", "SYNAPSE_DB_USER": "u", "SYNAPSE_DB_PASSWORD": "hunter2-not-logged"}
`;

describe.skipIf(!hasPython)("deploy/synapse/ensure_db.py", () => {
  it("waits for Postgres to come up, then creates the database", () => {
    const { status, stdout, stderr } = py(
      `${FAKE_PSYCOPG2}
ensure_db.main(ENV, connect=make_connect(3), sleep=sleeps.append)
print(json.dumps({"attempts": len(attempts), "sleeps": sleeps, "create": [q for q in log if q.startswith("CREATE")]}))`,
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.filter((l) => l.startsWith("waiting for postgres"))).toHaveLength(3);
    expect(lines[0]).toBe('waiting for postgres (1/30): connection to server at "postgres.railway.internal" failed: refused');
    expect(stdout).not.toContain("hunter2-not-logged");
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.attempts).toBe(4);
    expect(summary.sleeps).toEqual([2, 2, 2]);
    expect(summary.create).toHaveLength(1);
    expect(summary.create[0]).toContain("CREATE DATABASE synapse");
  });

  it("gives up after 30 tries when Postgres never answers, and says why", () => {
    const { status, stderr } = py(
      `${FAKE_PSYCOPG2}
try:
    ensure_db.main(ENV, connect=make_connect(10**6), sleep=sleeps.append)
except OperationalError as error:
    print(json.dumps({"attempts": len(attempts), "sleeps": len(sleeps)}), file=sys.stderr)
    sys.exit(3)`,
    );
    expect(status).toBe(3);
    expect(JSON.parse(stderr.trim())).toEqual({ attempts: 30, sleeps: 29 });
  });

  it("does not create the database when it already exists", () => {
    const { status, stdout } = py(
      `${FAKE_PSYCOPG2}
ensure_db.main(ENV, connect=make_connect(0, exists=True), sleep=sleeps.append)
print(json.dumps([q for q in log if q.startswith("CREATE")]))`,
    );
    expect(status).toBe(0);
    expect(stdout.trim().split("\n").pop()).toBe("[]");
  });
});

const GOOD_PASSWORD = "p".repeat(64);
// Runs create_admin.main with `call` replaced by a scripted fake.
function admin(env: Record<string, string>, responses: string) {
  return py(
    `
import sys
import create_admin
calls = []
responses = ${responses}
def fake_call(base, method, path, body=None):
    calls.append((method, path))
    return responses[len(calls) - 1]
create_admin.call = fake_call
create_admin.main(${JSON.stringify(env).replace(/true/g, "True")})
`,
  );
}

describe.skipIf(!hasPython)("deploy/synapse/create_admin.py", () => {
  it("refuses a short admin password before talking to Synapse", () => {
    const { status, stderr, stdout } = admin({ SYNAPSE_ADMIN_PASSWORD: "p".repeat(31) }, "[]");
    expect(status).not.toBe(0);
    expect(stderr).toContain("at least 32 characters");
    expect(stderr).not.toContain("Traceback");
    expect(stderr).not.toContain("p".repeat(31));
    expect(stdout).toBe("");
  });

  it("says so, without a traceback, when shared-secret registration is not enabled", () => {
    const { status, stderr, stdout } = admin(
      { SYNAPSE_ADMIN_PASSWORD: GOOD_PASSWORD, SYNAPSE_REGISTRATION_SHARED_SECRET: "s3cret" },
      `[(400, {"errcode": "M_UNKNOWN", "error": "Shared secret registration is not enabled"})]`,
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain("shared-secret registration is not enabled");
    expect(stderr).toContain("SYNAPSE_REGISTRATION_SHARED_SECRET");
    expect(stderr).not.toContain("Traceback");
    expect(stderr).not.toContain("KeyError");
    expect(stdout).toBe("");
  });

  it("creates the account with the shared secret and prints only the token", () => {
    const { status, stderr, stdout } = admin(
      { SYNAPSE_ADMIN_PASSWORD: GOOD_PASSWORD, SYNAPSE_REGISTRATION_SHARED_SECRET: "s3cret" },
      `[(200, {"nonce": "abc"}), (200, {"access_token": "tok-123"})]`,
    );
    expect(status).toBe(0);
    expect(stdout).toBe("tok-123\n");
    expect(stderr).toContain("created @workspace-admin:duo");
  });

  it("only logs in when the shared secret is unset", () => {
    const { status, stdout } = admin({ SYNAPSE_ADMIN_PASSWORD: GOOD_PASSWORD }, `[(200, {"access_token": "tok-456"})]`);
    expect(status).toBe(0);
    expect(stdout).toBe("tok-456\n");
  });
});
