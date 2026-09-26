"""Create Synapse's database if it does not exist yet.

Synapse insists on a database with LC_COLLATE/LC_CTYPE "C" (index order must not
depend on the OS locale). Railway's Postgres service only ships its default
database, which is not created that way, so this makes a dedicated one from
template0 the first time. Idempotent: a no-op once the database exists.
Connects to SYNAPSE_DB_ADMIN_DATABASE (the service's default database), waiting
for Postgres to accept connections first: on a cold project start it can come up
after Synapse, and Railway's restart policy only retries a few times.
"""
import os
import sys
import time

import psycopg2
from psycopg2 import sql


def connect_with_retry(attempts=30, delay=2, connect=None, sleep=time.sleep, **params):
    """psycopg2.connect, retried while Postgres is not accepting connections yet.

    30 tries 2 seconds apart is about a minute. Only the error's first line is
    logged (it names the host, never the password); the last error is raised
    once the tries run out, so a wrong password still fails, just slowly.
    """
    connect = connect or psycopg2.connect
    for attempt in range(1, attempts + 1):
        try:
            return connect(**params)
        except psycopg2.OperationalError as error:
            if attempt == attempts:
                raise
            reason = (str(error).strip().splitlines() or [type(error).__name__])[0]
            print(f"waiting for postgres ({attempt}/{attempts}): {reason}", flush=True)
            sleep(delay)


def main(env=os.environ, connect=None, sleep=time.sleep):
    target = env.get("SYNAPSE_DB_NAME", "synapse")
    conn = connect_with_retry(
        connect=connect,
        sleep=sleep,
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
