"""Create Synapse's database if it does not exist yet.

Synapse insists on a database with LC_COLLATE/LC_CTYPE "C" (index order must not
depend on the OS locale). Railway's Postgres service only ships its default
database, which is not created that way, so this makes a dedicated one from
template0 the first time. Idempotent: a no-op once the database exists.
Connects to SYNAPSE_DB_ADMIN_DATABASE (the service's default database).
"""
import os
import sys

import psycopg2
from psycopg2 import sql


def main(env=os.environ):
    target = env.get("SYNAPSE_DB_NAME", "synapse")
    conn = psycopg2.connect(
        host=env["SYNAPSE_DB_HOST"],
        port=int(env.get("SYNAPSE_DB_PORT", "5432")),
        user=env["SYNAPSE_DB_USER"],
        password=env["SYNAPSE_DB_PASSWORD"],
        dbname=env.get("SYNAPSE_DB_ADMIN_DATABASE", "railway"),
        sslmode=env.get("SYNAPSE_DB_SSLMODE", "prefer"),
    )
    conn.autocommit = True  # CREATE DATABASE cannot run in a transaction
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (target,))
        if cur.fetchone():
            print(f"database {target!r} already exists", flush=True)
            return
        cur.execute(
            sql.SQL(
                "CREATE DATABASE {} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
            ).format(sql.Identifier(target))
        )
        print(f"created database {target!r} (UTF8, C collation)", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyError as missing:
        sys.exit(f"ensure_db: required variable {missing} is not set")
