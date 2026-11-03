#!/bin/sh
# Runs once on first container start (empty volume).
# Creates the owner role (runs migrations) and the app role (runtime, least privilege),
# hands the app database to the owner, and creates the disposable test database.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$SITESYNC_OWNER_PASSWORD" \
  -v app_pw="$SITESYNC_APP_PASSWORD" \
  -v app_db="$POSTGRES_DB" <<'SQL'
CREATE ROLE sitesync_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE sitesync_app LOGIN PASSWORD :'app_pw';

ALTER DATABASE :"app_db" OWNER TO sitesync_owner;
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"app_db" TO sitesync_app;

CREATE DATABASE sitesync_test OWNER sitesync_owner;
REVOKE ALL ON DATABASE sitesync_test FROM PUBLIC;
GRANT CONNECT ON DATABASE sitesync_test TO sitesync_app;
SQL
