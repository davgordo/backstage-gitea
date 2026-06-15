#!/usr/bin/env bash
set -euo pipefail

# Builds/fetches the two Gitea modules, stages them as RHDH-compatible npm
# packages, publishes them to Gitea, validates the published artifacts, and
# renders deployment configuration.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist-rhdh"
DIST_CONFIG="$SCRIPT_DIR/dist-config"
STAGE_ROOT="$SCRIPT_DIR/dynamic-plugins-root"
LOCAL_SCAFFOLDER_DIR="$PROJECT_ROOT/scaffolder-backend-module-gitea"

CATALOG_SOURCE="@backstage/plugin-catalog-backend-module-gitea"
CATALOG_SOURCE_VERSION="0.1.10"
CATALOG_VERSION="0.1.10-rhdh.1.10.1.1"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

GITEA_BASE_URL="${GITEA_BASE_URL:-}"
GITEA_TOKEN="${GITEA_TOKEN:-}"
GITEA_NPM_SCOPE="${GITEA_NPM_SCOPE:-}"

require_value() {
  local name="$1"
  [ -n "${!name:-}" ] || { echo "ERROR: $name is not set (check .env)"; exit 1; }
}

require_command() {
  command -v "$1" >/dev/null || { echo "ERROR: required command not found: $1"; exit 1; }
}

require_value GITEA_BASE_URL
require_value GITEA_TOKEN
require_value GITEA_NPM_SCOPE
require_command npm
require_command node
require_command yq

NPM_SCOPE="$GITEA_NPM_SCOPE"
NPM_REGISTRY="${GITEA_BASE_URL%/}/api/packages/${NPM_SCOPE}/npm/"
NPMRC_HOST="${NPM_REGISTRY%/}"
NPMRC_HOST="${NPMRC_HOST#http://}"
NPMRC_HOST="${NPMRC_HOST#https://}"

CATALOG_PACKAGE="@${NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic"
SCAFFOLDER_PACKAGE="@${NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic"

WORK_ROOT="$(mktemp -d)"
AUTH_NPMRC="$WORK_ROOT/.npmrc"

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

write_npmrc() {
  local target="$1"
  cat > "$target" <<EOF
@${NPM_SCOPE}:registry=${NPM_REGISTRY}
//${NPMRC_HOST}/:_authToken=${GITEA_TOKEN}
EOF
  chmod 600 "$target"
}

write_npmrc "$AUTH_NPMRC"

echo
echo "================================================"
echo "  Gitea Plugins: Build + Publish Pipeline"
echo "================================================"
echo "  Registry: $NPM_REGISTRY"
echo "  Scope:    @$NPM_SCOPE"
echo

rm -rf "$DIST_DIR" "$DIST_CONFIG" "$STAGE_ROOT"
mkdir -p "$DIST_DIR" "$DIST_CONFIG" "$STAGE_ROOT"

# Stage one standard npm package and make its Backstage dependencies peers.
stage_package() {
  local source_dir="$1"
  local package_name="$2"
  local package_version="$3"
  local stage_dir="$4"

  mkdir -p "$stage_dir/dist"
  cp -r "$source_dir/dist/." "$stage_dir/dist/"
  cp "$source_dir/package.json" "$stage_dir/package.json"

  node "$SCRIPT_DIR/scripts/prepare-package.mjs" \
    "$stage_dir/package.json" \
    "$package_name" \
    "$package_version" \
    "$NPM_REGISTRY"
}

pack_package() {
  local stage_dir="$1"
  local output_path="$2"
  local pack_name

  if ! pack_name="$(cd "$stage_dir" && npm pack --silent --ignore-scripts)"; then
    echo "ERROR: failed to pack $stage_dir"
    return 1
  fi
  mv "$stage_dir/$pack_name" "$output_path"
}

publish_package() {
  local package_name="$1"
  local package_version="$2"
  local tarball="$3"
  local result

  echo "  -> publishing $package_name@$package_version"
  if result="$(npm publish "$tarball" \
      --userconfig="$AUTH_NPMRC" \
      --access=public \
      --registry="$NPM_REGISTRY" \
      --ignore-scripts 2>&1)"; then
    echo "  OK: published"
  elif echo "$result" | grep -qi "409\|E409\|previously published version"; then
    echo "  OK: version already published"
  else
    echo "ERROR: failed to publish $package_name@$package_version"
    echo "$result"
    return 1
  fi
}

validate_package() {
  local package_name="$1"
  local package_version="$2"
  local hash_file="$3"
  local validation_dir="$WORK_ROOT/validate-${package_name##*/}"
  local fetched_tarball package_json fetched_name fetched_version hash

  mkdir -p "$validation_dir"
  if ! fetched_tarball="$(cd "$validation_dir" && npm pack \
      "$package_name@$package_version" \
      --userconfig="$AUTH_NPMRC" \
      --registry="$NPM_REGISTRY" \
      --silent)"; then
    echo "ERROR: failed to fetch $package_name@$package_version"
    return 1
  fi
  fetched_tarball="$validation_dir/$fetched_tarball"

  tar xzf "$fetched_tarball" -C "$validation_dir"
  package_json="$validation_dir/package/package.json"

  [ -f "$package_json" ] || { echo "ERROR: $package_name has no package.json"; return 1; }
  [ -d "$validation_dir/package/dist" ] || { echo "ERROR: $package_name has no dist/"; return 1; }
  [ -f "$validation_dir/package/dist/index.cjs.js" ] || {
    echo "ERROR: $package_name has no dist/index.cjs.js"
    return 1
  }

  fetched_name="$(node -p "require('$package_json').name")"
  fetched_version="$(node -p "require('$package_json').version")"
  [ "$fetched_name" = "$package_name" ] || {
    echo "ERROR: expected package $package_name, fetched $fetched_name"
    return 1
  }
  [ "$fetched_version" = "$package_version" ] || {
    echo "ERROR: expected version $package_version, fetched $fetched_version"
    return 1
  }

  hash="$(node -e "
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    process.stdout.write(
      crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('base64'),
    );
  " "$fetched_tarball")"
  printf '%s\n' "$hash" > "$hash_file"
  echo "  OK: $package_name@$package_version (sha256-$hash)"
}

registry_tarball_url() {
  npm view "$1@$2" dist.tarball \
    --userconfig="$AUTH_NPMRC" \
    --registry="$NPM_REGISTRY"
}

echo "A) Fetching and staging catalog plugin"
CATALOG_SOURCE_ROOT="$WORK_ROOT/catalog-source"
mkdir -p "$CATALOG_SOURCE_ROOT"
if ! CATALOG_TARBALL="$(cd "$CATALOG_SOURCE_ROOT" && npm pack \
    "$CATALOG_SOURCE@$CATALOG_SOURCE_VERSION" \
    --registry=https://registry.npmjs.org \
    --silent)"; then
  echo "ERROR: failed to fetch $CATALOG_SOURCE@$CATALOG_SOURCE_VERSION from npmjs"
  exit 1
fi
tar xzf "$CATALOG_SOURCE_ROOT/$CATALOG_TARBALL" -C "$CATALOG_SOURCE_ROOT"

CATALOG_STAGE="$STAGE_ROOT/${CATALOG_PACKAGE#@*/}/$CATALOG_VERSION"
stage_package \
  "$CATALOG_SOURCE_ROOT/package" \
  "$CATALOG_PACKAGE" \
  "$CATALOG_VERSION" \
  "$CATALOG_STAGE"
CATALOG_OUTPUT="$DIST_DIR/catalog-backend-module-gitea-$CATALOG_VERSION.tgz"
pack_package "$CATALOG_STAGE" "$CATALOG_OUTPUT"
echo "  OK: $(basename "$CATALOG_OUTPUT")"

echo
echo "B) Building and staging scaffolder plugin"
[ -d "$LOCAL_SCAFFOLDER_DIR" ] || {
  echo "ERROR: local scaffolder source not found at $LOCAL_SCAFFOLDER_DIR"
  exit 1
}
(cd "$LOCAL_SCAFFOLDER_DIR" && npm run build)
SCAFFOLDER_VERSION="$(node -p "require('$LOCAL_SCAFFOLDER_DIR/package.json').version")"
SCAFFOLDER_STAGE="$STAGE_ROOT/${SCAFFOLDER_PACKAGE#@*/}/$SCAFFOLDER_VERSION"
stage_package \
  "$LOCAL_SCAFFOLDER_DIR" \
  "$SCAFFOLDER_PACKAGE" \
  "$SCAFFOLDER_VERSION" \
  "$SCAFFOLDER_STAGE"
SCAFFOLDER_OUTPUT="$DIST_DIR/scaffolder-backend-module-gitea-$SCAFFOLDER_VERSION.tgz"
pack_package "$SCAFFOLDER_STAGE" "$SCAFFOLDER_OUTPUT"
echo "  OK: $(basename "$SCAFFOLDER_OUTPUT")"

echo
echo "C) Publishing packages"
publish_package "$CATALOG_PACKAGE" "$CATALOG_VERSION" "$CATALOG_OUTPUT"
publish_package "$SCAFFOLDER_PACKAGE" "$SCAFFOLDER_VERSION" "$SCAFFOLDER_OUTPUT"

echo
echo "D) Validating published packages"
CATALOG_HASH_FILE="$DIST_DIR/plugin-catalog-backend-module-gitea-dynamic-hash.b64"
SCAFFOLDER_HASH_FILE="$DIST_DIR/plugin-scaffolder-backend-module-gitea-dynamic-hash.b64"
validate_package "$CATALOG_PACKAGE" "$CATALOG_VERSION" "$CATALOG_HASH_FILE"
validate_package "$SCAFFOLDER_PACKAGE" "$SCAFFOLDER_VERSION" "$SCAFFOLDER_HASH_FILE"

CATALOG_HASH="$(cat "$CATALOG_HASH_FILE")"
SCAFFOLDER_HASH="$(cat "$SCAFFOLDER_HASH_FILE")"
CATALOG_URL="$(registry_tarball_url "$CATALOG_PACKAGE" "$CATALOG_VERSION")"
SCAFFOLDER_URL="$(registry_tarball_url "$SCAFFOLDER_PACKAGE" "$SCAFFOLDER_VERSION")"

echo
echo "E) Rendering deployment configuration"
cp "$SCRIPT_DIR/values-rhdh.yaml" "$DIST_CONFIG/values-rhdh.yaml"
cp "$SCRIPT_DIR/dynamic-plugins.yaml" "$DIST_CONFIG/dynamic-plugins.yaml"
write_npmrc "$DIST_CONFIG/npmrc"

NPM_SCOPE="$NPM_SCOPE" \
CATALOG_VERSION="$CATALOG_VERSION" \
CATALOG_HASH="$CATALOG_HASH" \
CATALOG_URL="$CATALOG_URL" \
SCAFFOLDER_VERSION="$SCAFFOLDER_VERSION" \
SCAFFOLDER_HASH="$SCAFFOLDER_HASH" \
SCAFFOLDER_URL="$SCAFFOLDER_URL" \
yq -i '
  .dynamicPlugins.install[0].package = "@" + strenv(NPM_SCOPE) + "/plugin-catalog-backend-module-gitea-dynamic@" + strenv(CATALOG_VERSION) |
  .dynamicPlugins.install[0].integrity = "sha256-" + strenv(CATALOG_HASH) |
  .dynamicPlugins.install[1].package = "@" + strenv(NPM_SCOPE) + "/plugin-scaffolder-backend-module-gitea-dynamic@" + strenv(SCAFFOLDER_VERSION) |
  .dynamicPlugins.install[1].integrity = "sha256-" + strenv(SCAFFOLDER_HASH) |
  .dynamicPlugins.hosts[0].packages[0] = strenv(CATALOG_URL) |
  .dynamicPlugins.hosts[0].packages[1] = strenv(SCAFFOLDER_URL)
' "$DIST_CONFIG/values-rhdh.yaml"

NPM_SCOPE="$NPM_SCOPE" \
CATALOG_VERSION="$CATALOG_VERSION" \
CATALOG_HASH="$CATALOG_HASH" \
SCAFFOLDER_VERSION="$SCAFFOLDER_VERSION" \
SCAFFOLDER_HASH="$SCAFFOLDER_HASH" \
yq -i '
  .plugins[0].package = "@" + strenv(NPM_SCOPE) + "/plugin-catalog-backend-module-gitea-dynamic@" + strenv(CATALOG_VERSION) |
  .plugins[0].integrity = "sha256-" + strenv(CATALOG_HASH) |
  .plugins[1].package = "@" + strenv(NPM_SCOPE) + "/plugin-scaffolder-backend-module-gitea-dynamic@" + strenv(SCAFFOLDER_VERSION) |
  .plugins[1].integrity = "sha256-" + strenv(SCAFFOLDER_HASH)
' "$DIST_CONFIG/dynamic-plugins.yaml"

echo
echo "================================================"
echo "  Done: packages published, validated, and rendered"
echo "================================================"
echo "  Catalog:    $CATALOG_PACKAGE@$CATALOG_VERSION"
echo "  Scaffolder: $SCAFFOLDER_PACKAGE@$SCAFFOLDER_VERSION"
echo "  Configs:    $DIST_CONFIG"
echo
