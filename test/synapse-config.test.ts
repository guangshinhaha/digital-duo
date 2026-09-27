import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDir } from "./helpers/temp-dir.js";

// deploy/synapse/render_config.py turns Railway env into homeserver.yaml at
// every boot (docs/deploy/railway.md, "Synapse and Postgres"). Its output is
// JSON — valid YAML — so the invariants the deploy depends on are asserted
// on the parsed document. python3 is the only dependency; skip when absent.
const tempDir = useTempDir();
const script = join(__dirname, "..", "deploy", "synapse", "render_config.py");
// render_config.py proves its output loads back through PyYAML (a Synapse
// dependency, so always in the image); a host without it cannot run the script.
const hasPython = spawnSync("python3", ["-c", "import yaml"]).status === 0;

const SECRET = "shared-secret-for-tests";
const BASE_ENV = {
  SYNAPSE_PUBLIC_BASEURL: "https://synapse.example.test",
  SYNAPSE_REGISTRATION_SHARED_SECRET: SECRET,
  SYNAPSE_DB_HOST: "postgres.railway.internal",
  SYNAPSE_DB_USER: "postgres",
  SYNAPSE_DB_PASSWORD: 'pa"ss: word # with yaml-hostile chars',
};

function render(env: Record<string, string>) {
  const dir = tempDir();
  const secretPath = join(dir, "secrets", "registration_shared_secret");
  const result = spawnSync("python3", [script, dir, secretPath], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { result, dir, secretPath };
}

describe.skipIf(!hasPython)("deploy/synapse/render_config.py", () => {
  it("renders a closed, federation-off homeserver on Postgres with media on the volume", () => {
    const { result, dir, secretPath } = render(BASE_ENV);
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, "homeserver.yaml"), "utf8"));

    expect(config.server_name).toBe("duo");
    expect(config.public_baseurl).toBe("https://synapse.example.test");
    expect(config.enable_registration).toBe(false);
    expect(config.federation_domain_whitelist).toEqual([]);
    expect(config.user_directory.search_all_users).toBe(false);
    expect(config.report_stats).toBe(false);

    // Federation is off in both directions, and the org walls (§6, §11) hold:
    // profiles need auth and a shared room, invites carry no profile data.
    expect(config.trusted_key_servers).toEqual([]);
    expect(config.allow_public_rooms_over_federation).toBe(false);
    expect(config.url_preview_enabled).toBe(false);
    expect(config.require_auth_for_profile_requests).toBe(true);
    expect(config.limit_profile_requests_to_users_who_share_rooms).toBe(true);
    expect(config.include_profile_data_on_invite).toBe(false);

    // One client-only listener: no `federation` resource, so those routes 404.
    expect(config.listeners).toHaveLength(1);
    const names = config.listeners.flatMap((l: { resources: { names: string[] }[] }) => l.resources.flatMap((r) => r.names));
    expect(names).toEqual(["client"]);
    expect(config.listeners[0].bind_addresses).toEqual(["::"]);
    expect(config.listeners[0].x_forwarded).toBe(true);

    expect(config.database.name).toBe("psycopg2");
    expect(config.database.args.host).toBe("postgres.railway.internal");
    expect(config.database.args.password).toBe(BASE_ENV.SYNAPSE_DB_PASSWORD);
    expect(config.media_store_path).toBe("/data/media_store");
    expect(config.signing_key_path).toBe("/data/signing.key");
  });

  it("sets provisioning-burst rate limits well above Synapse's defaults", () => {
    const { dir } = render(BASE_ENV);
    const config = JSON.parse(readFileSync(join(dir, "homeserver.yaml"), "utf8"));
    for (const limit of [config.rc_message, config.rc_registration, config.rc_joins.local, config.rc_invites.per_user]) {
      expect(limit.per_second).toBeGreaterThanOrEqual(100);
      expect(limit.burst_count).toBeGreaterThanOrEqual(1000);
    }
    // Left alone on purpose: it protects the service account's password.
    expect(config.rc_login).toBeUndefined();
  });

  it("loads the org wall module with the server name and the service account", () => {
    const { dir } = render({ ...BASE_ENV, SYNAPSE_SERVER_NAME: "workspace" });
    const config = JSON.parse(readFileSync(join(dir, "homeserver.yaml"), "utf8"));
    expect(config.modules).toEqual([
      {
        module: "duo_org_wall.module.DuoOrgWall",
        config: { server_name: "workspace", service_accounts: ["@workspace-admin:workspace"] },
      },
    ]);
    // The default server name, as create_admin.py registers the account under.
    const fallback = JSON.parse(readFileSync(join(render(BASE_ENV).dir, "homeserver.yaml"), "utf8"));
    expect(fallback.modules[0].config).toEqual({ server_name: "duo", service_accounts: ["@workspace-admin:duo"] });
  });

  it("keeps the shared secret out of homeserver.yaml, in a private file", () => {
    const { dir, secretPath } = render(BASE_ENV);
    const yaml = readFileSync(join(dir, "homeserver.yaml"), "utf8");
    expect(yaml).not.toContain(SECRET);
    expect(JSON.parse(yaml).registration_shared_secret_path).toBe(secretPath);
    expect(readFileSync(secretPath, "utf8")).toBe(SECRET);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "homeserver.yaml")).mode & 0o777).toBe(0o600);
  });

  it("leaves the shared-secret admin API off once the secret is unset", () => {
    const { SYNAPSE_REGISTRATION_SHARED_SECRET: _secret, ...bootstrapped } = BASE_ENV;
    const { result, dir, secretPath } = render(bootstrapped);
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, "homeserver.yaml"), "utf8"));
    expect(config.registration_shared_secret_path).toBeUndefined();
    expect(config.registration_shared_secret).toBeUndefined();
    expect(config.enable_registration).toBe(false);
    expect(existsSync(secretPath)).toBe(false);
  });

  it("fails cleanly, writing nothing, when a value cannot survive YAML (astral-plane character)", () => {
    const { result, dir } = render({ ...BASE_ENV, SYNAPSE_DB_PASSWORD: "pass-\u{1F600}-word" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("YAML round trip");
    expect(result.stderr).not.toContain("Traceback");
    expect(result.stderr).not.toContain("pass-");
    expect(existsSync(join(dir, "homeserver.yaml"))).toBe(false);
    expect(existsSync(join(dir, "secrets", "registration_shared_secret"))).toBe(false);
  });

  it("loads back through YAML as exactly the rendered config, hostile characters included", () => {
    const { dir } = render(BASE_ENV);
    const check = spawnSync(
      "python3",
      ["-c", "import json,sys,yaml; t=open(sys.argv[1]).read(); assert yaml.safe_load(t)==json.loads(t)", join(dir, "homeserver.yaml")],
      { encoding: "utf8" },
    );
    expect(check.status).toBe(0);
  });

  it("honours the server name and refuses to boot with a required variable missing", () => {
    const named = render({ ...BASE_ENV, SYNAPSE_SERVER_NAME: "workspace" });
    expect(JSON.parse(readFileSync(join(named.dir, "homeserver.yaml"), "utf8")).server_name).toBe("workspace");

    const { SYNAPSE_DB_PASSWORD: _dropped, ...incomplete } = BASE_ENV;
    const broken = render(incomplete);
    expect(broken.result.status).not.toBe(0);
    expect(broken.result.stderr).toContain("SYNAPSE_DB_PASSWORD");
    expect(broken.result.stderr).not.toContain(SECRET);
  });
});
