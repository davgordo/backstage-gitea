#!/usr/bin/env bash
set -euo pipefail

# publish-both-plugins.sh
#
# Unified pipeline: fetch @backstage/* Gitea modules from npmjs, restructure
# for RHDH dynamic plugins (peerDependencies migration), publish to the
# Gitea npm registry, validate, and update deployment configs.
#
# Steps:
#   A) Decorate catalog-backend-module-gitea from npmjs
#   B) Decorate scaffolder-backend-module-gitea from npmjs
#   C) Publish both as @$GITEA_NPM_SCOPE/* to the Gitea npm registry
#   D) Validate by fetching back from the registry
#   E) Update values-rhdh.yaml and dynamic-plugins.yaml
#
# Requires ../.env with GITEA_BASE_URL, GITEA_TOKEN and GITEA_NPM_SCOPE.
# Usage:
#   ./scripts/publish-both-plugins.sh

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist-rhdh"
DIST_CONFIG="$SCRIPT_DIR/dist-config"
PLUGIN_ROOT="$SCRIPT_DIR/dynamic-plugins-root"

# Load .env from project root
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

NPM_SCOPE="${GITEA_NPM_SCOPE:-}"
NPM_REGISTRY="${GITEA_BASE_URL:-}/api/packages/${NPM_SCOPE}/npm/"
GITEA_TOKEN="${GITEA_TOKEN:-}"

if [ -z "$NPM_SCOPE" ]; then
  echo "ERROR: GITEA_NPM_SCOPE not set (check .env)"; exit 1
fi
if [ -z "$GITEA_TOKEN" ]; then
  echo "ERROR: GITEA_TOKEN not set (check .env)"; exit 1
fi

echo ""; echo "================================================"
echo "  Gitea Plugins: Build + Publish Pipeline"
echo "================================================"
echo "  Registry: $NPM_REGISTRY"
echo "  Scope:    @$NPM_SCOPE"
echo ""

# Clean previous dist
rm -rf "$DIST_DIR" "$PLUGIN_ROOT" "$DIST_CONFIG"
mkdir -p "$DIST_DIR" "$PLUGIN_ROOT" "$DIST_CONFIG"

# -------------------------------------------------------------------
# A) Decorate catalog plugin from npmjs
# -------------------------------------------------------------------
echo "━━━ A) Decorating catalog-backend-module-gitea ━━━"

# NOTE: source is @backstage on npmjs.org; we repack and publish as @$NPM_SCOPE to Gitea
# Pin to version compatible with RHDH 1.9.4 (Backstage 1.45.3) — 0.1.7+ requires newer deps
CATALOG_NPM_SOURCE="@backstage/plugin-catalog-backend-module-gitea"
CATALOG_VERSION="0.1.6"

# Pack from npmjs
CATALOG_NPM_TARBALL=$(mktemp --suffix=.tgz)
( cd "$(dirname "$CATALOG_NPM_TARBALL")" && npm pack "${CATALOG_NPM_SOURCE}@${CATALOG_VERSION}" --registry=https://registry.npmjs.org 2>/dev/null )
mv "$(ls -t "$(dirname "$CATALOG_NPM_TARBALL")"/backstage-plugin-catalog-backend-module-gitea-*.tgz 2>/dev/null | head -1)" "$CATALOG_NPM_TARBALL" 2>/dev/null || true

# Extract and restructure for RHDH
CATALOG_WORK=$(mktemp -d)
tar xzf "$CATALOG_NPM_TARBALL" -C "$CATALOG_WORK"

mkdir -p "$PLUGIN_ROOT/@backstage/plugin-catalog-backend-module-gitea/$CATALOG_VERSION/dist"
cp -r "$CATALOG_WORK/package/dist/"* "$PLUGIN_ROOT/@backstage/plugin-catalog-backend-module-gitea/$CATALOG_VERSION/dist/"
cp "$CATALOG_WORK/package/package.json" "$PLUGIN_ROOT/@backstage/plugin-catalog-backend-module-gitea/$CATALOG_VERSION/"

# Fix entry points and move @backstage/* dependencies to peerDependencies for RHDH
node -e "
  const fs=require('fs'); const p=JSON.parse(fs.readFileSync('$PLUGIN_ROOT/@backstage/plugin-catalog-backend-module-gitea/$CATALOG_VERSION/package.json','utf8'));
  p.main='./dist/index.cjs.js'; p.types='./dist/index.d.ts';
  p.exports={'.':{'require':'./dist/index.cjs.js','types':'./dist/index.d.ts','default':'./dist/index.cjs.js'},'./package.json':'./package.json'};
  delete p.typesVersions;
  if(!p.peerDependencies) p.peerDependencies={};
  for(const [k,v] of Object.entries(p.dependencies||{})) {
    if(k.startsWith('@backstage/')){
      p.peerDependencies[k]=v;
      delete p.dependencies[k];
    }
  }
  if(Object.keys(p.dependencies||{}).length===0) delete p.dependencies;
  fs.writeFileSync('$PLUGIN_ROOT/@backstage/plugin-catalog-backend-module-gitea/$CATALOG_VERSION/package.json', JSON.stringify(p,null,2)+'\n');
"

# Create RHDH tarball
(cd "$PLUGIN_ROOT" && tar czf "$DIST_DIR/catalog-backend-module-gitea-$CATALOG_VERSION.tgz" @backstage/plugin-catalog-backend-module-gitea)
echo "  version:  $CATALOG_VERSION"
echo "  tarball:  catalog-backend-module-gitea-$CATALOG_VERSION.tgz"

# -------------------------------------------------------------------
# B) Build scaffolder plugin from LOCAL SOURCE
# -------------------------------------------------------------------
echo ""
echo "━━━ B) Building scaffolder-backend-module-gitea from local source ━━━"

# Source is ../scaffolder-backend-module-gitea (project root)
LOCAL_SCAFFOLDER_DIR="$SCRIPT_DIR/../scaffolder-backend-module-gitea"

if [ ! -d "$LOCAL_SCAFFOLDER_DIR" ]; then
  echo "ERROR: Local scaffolder source not found at $LOCAL_SCAFFOLDER_DIR"; exit 1
fi

# Read version from local package.json
SCAFFOLDER_VERSION=$(node -p "require('$LOCAL_SCAFFOLDER_DIR/package.json').version")
echo "  local version: $SCAFFOLDER_VERSION"

# Build with backstage-cli
echo "  → building with backstage-cli ..."
(cd "$LOCAL_SCAFFOLDER_DIR" && npm run build)

# Extract built dist and package.json for RHDH dynamic plugin structure
mkdir -p "$PLUGIN_ROOT/@backstage/plugin-scaffolder-backend-module-gitea/$SCAFFOLDER_VERSION/dist"
cp -r "$LOCAL_SCAFFOLDER_DIR/dist/"* "$PLUGIN_ROOT/@backstage/plugin-scaffolder-backend-module-gitea/$SCAFFOLDER_VERSION/dist/"
cp "$LOCAL_SCAFFOLDER_DIR/package.json" "$PLUGIN_ROOT/@backstage/plugin-scaffolder-backend-module-gitea/$SCAFFOLDER_VERSION/"

# Fix entry points and move @backstage/* dependencies to peerDependencies for RHDH
node -e "
  const fs=require('fs'); const p=JSON.parse(fs.readFileSync('$PLUGIN_ROOT/@backstage/plugin-scaffolder-backend-module-gitea/$SCAFFOLDER_VERSION/package.json','utf8'));
  p.main='./dist/index.cjs.js'; p.types='./dist/index.d.ts';
  p.exports={'.':{'require':'./dist/index.cjs.js','types':'./dist/index.d.ts','default':'./dist/index.cjs.js'},'./package.json':'./package.json'};
  delete p.typesVersions;
  if(!p.peerDependencies) p.peerDependencies={};
  for(const [k,v] of Object.entries(p.dependencies||{})) {
    if(k.startsWith('@backstage/')){
      p.peerDependencies[k]=v;
      delete p.dependencies[k];
    }
  }
  if(Object.keys(p.dependencies||{}).length===0) delete p.dependencies;
  fs.writeFileSync('$PLUGIN_ROOT/@backstage/plugin-scaffolder-backend-module-gitea/$SCAFFOLDER_VERSION/package.json', JSON.stringify(p,null,2)+'\n');
"

# Create RHDH tarball
(cd "$PLUGIN_ROOT" && tar czf "$DIST_DIR/scaffolder-backend-module-gitea-$SCAFFOLDER_VERSION.tgz" @backstage/plugin-scaffolder-backend-module-gitea)
SCAFFOLDER_TARBALL="$DIST_DIR/scaffolder-backend-module-gitea-$SCAFFOLDER_VERSION.tgz"

echo "  version:  $SCAFFOLDER_VERSION"
echo "  tarball:  $(basename "$SCAFFOLDER_TARBALL")"

# -------------------------------------------------------------------
# C) Publish both to Gitea npm registry
# -------------------------------------------------------------------
echo ""
echo "━━━ C) Publishing to $NPM_REGISTRY ━━━"

# Scoped package names (with -dynamic suffix for RHDH 1.9.4)
CATALOG_NPM_PKG="@${NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic"
SCAFFOLDER_NPM_PKG="@${NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic"

# Helper: repack RHDH tarball into npm-publishable form and publish
publish_rhdh_tarball() {
  local pkg_name="$1" pkg_version="$2" rhdh_tarball="$3"
  echo "  → publish_rhdh_tarball called: $pkg_name@$pkg_version from $rhdh_tarball"

  local PWORK=$(mktemp -d)
  tar xzf "$rhdh_tarball" -C "$PWORK"

  # Locate package.json inside the extracted tarball
  local PJSON=$(find "$PWORK" -name package.json -not -path '*/node_modules/*' | head -1)
  [ -z "$PJSON" ] && { echo "  ERROR: no package.json in tarball"; rm -rf "$PWORK"; return 1; }

  # Patch for npm publishing under @$NPM_SCOPE
  node -e "
    const fs=require('fs'); const p=JSON.parse(fs.readFileSync('$PJSON','utf8'));
    p.name='$pkg_name'; p.version='$pkg_version';
    p.main='./dist/index.cjs.js'; p.types='./dist/index.d.ts';
    p.exports={'.':{'require':'./dist/index.cjs.js','types':'./dist/index.d.ts','default':'./dist/index.cjs.js'},'./package.json':'./package.json'};
    delete p.typesVersions;
    p.publishConfig={access:'public', registry:'$NPM_REGISTRY'};
    if(!p.files) p.files=['dist']; else if(!p.files.includes('dist')) p.files.push('dist');
    delete p.scripts;  // avoid prepack/postpack failing outside build env
    fs.writeFileSync('$PJSON', JSON.stringify(p,null,2)+'\n');
  "

  # Pack into npm tarball (cd into package directory, not PWORK root)
  local PKG_DIR
  PKG_DIR=$(dirname "$PJSON")
  local pack_output
  pack_output=$(cd "$PKG_DIR" && npm pack 2>&1) || {
    echo "  ERROR: npm pack failed: $pack_output"; rm -rf "$PWORK"; return 1; }
  local NPM_TGZ=$(ls -t "$PKG_DIR"/*.tgz 2>/dev/null | head -1)
  [ -z "$NPM_TGZ" ] && { echo "  ERROR: npm pack produced no tarball"; rm -rf "$PWORK"; return 1; }

  # Write .npmrc in PKG_DIR with scope-based registry and _authToken
  local npmrc_host
  npmrc_host=$(echo "${NPM_REGISTRY%/}" | sed 's|^https\?://||')
  cat > "$PKG_DIR/.npmrc" <<EOF
@${NPM_SCOPE}:registry=${NPM_REGISTRY}
//${npmrc_host}/:_authToken=${GITEA_TOKEN}
EOF

  local result pub_exit
  echo "  → publishing $NPM_TGZ ..."
  pub_exit=0
  result=$(cd "$PKG_DIR" && \
    npm publish "$NPM_TGZ" \
      --access public \
      --registry="${NPM_REGISTRY}" 2>&1) || pub_exit=$?
  echo "  → npm publish exited $pub_exit"
  if [ $pub_exit -eq 0 ]; then
    echo "  ✓ $pkg_name@$pkg_version published"
  elif echo "$result" | grep -qi "409\|E409\|You cannot publish over the previously published version"; then
    echo "  ⚡ $pkg_name@$pkg_version already published (skipping)"
  else
    echo "  ✗ $pkg_name@$pkg_version FAILED:"
    echo "    $result"
    rm -rf "$PWORK"
    return 1
  fi

  rm -rf "$PWORK"
}

publish_rhdh_tarball "$CATALOG_NPM_PKG" "$CATALOG_VERSION" "$DIST_DIR/catalog-backend-module-gitea-$CATALOG_VERSION.tgz"
publish_rhdh_tarball "$SCAFFOLDER_NPM_PKG" "$SCAFFOLDER_VERSION" "$SCAFFOLDER_TARBALL"

# -------------------------------------------------------------------
# D) Validate and compute integrity from registry tarballs
# -------------------------------------------------------------------
echo ""
echo "━━━ D) Validating packages and computing integrity ━━━"

# Small delay to let registry index
sleep 2

# Helper to compute sha256 in base64 (SPDX format) from a file
hex_to_base64() {
  python3 -c "import sys,binascii,base64; print(base64.b64encode(binascii.unhexlify(sys.argv[1])).decode(), end='')" "$1"
}

validate_and_hash_from_registry() {
  local pkg_name="$1" pkg_version="$2"
  local VWORK=$(mktemp -d)

  # .npmrc for auth
  local npmrc_host
  npmrc_host=$(echo "${NPM_REGISTRY%/}" | sed 's|^https\?://||')
  printf '%s\n' \
    "@${NPM_SCOPE}:registry=${NPM_REGISTRY}" \
    "//${npmrc_host}:_authToken=${GITEA_TOKEN}" \
    > "$VWORK/.npmrc"

  local fetch_result
  fetch_result=$(cd "$VWORK" && npm pack "${pkg_name}@${pkg_version}" 2>&1) || {
    echo "  ✗ $pkg_name@$pkg_version — fetch failed"
    rm -rf "$VWORK"; return 1
  }

  local FTARBALL=$(ls -t "$VWORK"/*.tgz 2>/dev/null | head -1)
  [ -z "$FTARBALL" ] && { echo "  ✗ $pkg_name@$pkg_version — no tarball from fetch"; rm -rf "$VWORK"; return 1; }

  # Extract and verify structure
  local VEXTRACT=$(mktemp -d)
  tar xzf "$FTARBALL" -C "$VEXTRACT"
  local FJSON=$(find "$VEXTRACT" -name package.json -not -path '*/node_modules/*' | head -1)
  local FDIST=$(find "$VEXTRACT" -name dist -type d | head -1)

  if [ -n "$FJSON" ] && [ -n "$FDIST" ]; then
    local fver=$(node -p "require('$FJSON').version")
    if [ "$fver" = "$pkg_version" ]; then
      echo "  ✓ $pkg_name@$pkg_version — package.json + dist/ verified"
    else
      echo "  ⚠ $pkg_name@$pkg_version — version mismatch (fetched: $fver)"
    fi
  else
    echo "  ✗ $pkg_name@$pkg_version — missing package.json or dist/"
  fi

  # Compute sha256 in SPDX base64 format from the fetched tarball (what RHDH will download)
  local hex_hash
  hex_hash=$(sha256sum "$FTARBALL" | awk '{print $1}')
  local b64_hash
  b64_hash=$(hex_to_base64 "$hex_hash")
  echo "  → integrity: sha256-${b64_hash}"

  # Save the base64 hash so step E can use it
  echo "$b64_hash" > "$DIST_DIR/${pkg_name##*/}-hash.b64"

  rm -rf "$VWORK" "$VEXTRACT"
}

validate_and_hash_from_registry "$CATALOG_NPM_PKG" "$CATALOG_VERSION"
validate_and_hash_from_registry "$SCAFFOLDER_NPM_PKG" "$SCAFFOLDER_VERSION"

# Read the computed hashes
CATALOG_HASH_B64=$(cat "$DIST_DIR/plugin-catalog-backend-module-gitea-dynamic-hash.b64")
SCAFFOLDER_HASH_B64=$(cat "$DIST_DIR/plugin-scaffolder-backend-module-gitea-dynamic-hash.b64")

echo ""
echo "  Catalog integrity:    sha256-${CATALOG_HASH_B64}"
echo "  Scaffolder integrity: sha256-${SCAFFOLDER_HASH_B64}"

# -------------------------------------------------------------------
# E) Copy templates to dist-config and update with real values
# -------------------------------------------------------------------
echo ""
echo "━━━ E) Generating config files ━━━"

# Copy templates to dist-config so we don't modify the originals
cp "$SCRIPT_DIR/values-rhdh.yaml" "$DIST_CONFIG/values-rhdh.yaml"
cp "$SCRIPT_DIR/dynamic-plugins.yaml" "$DIST_CONFIG/dynamic-plugins.yaml"

# Query registry metadata to get exact tarball URLs
get_registry_tarball_url() {
  local pkg_name="$1" pkg_version="$2"
  # URL-encode the scoped package name (@ → %40, / → %2F)
  local encoded
  encoded=$(echo "$pkg_name" | sed 's|@|%40|g; s|/|%2F|g')

  local raw
  raw=$(curl -sf -H "Authorization: Bearer $GITEA_TOKEN" "$NPM_REGISTRY$encoded") || {
    echo "  WARNING: could not fetch metadata for $pkg_name@$pkg_version"
    return 1
  }
  echo "$raw" | node -e "
      const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const v=d.versions['$pkg_version'];
      console.log(v && v.dist ? v.dist.tarball : 'NOTFOUND');
    "
}

CATALOG_URL=$(get_registry_tarball_url "$CATALOG_NPM_PKG" "$CATALOG_VERSION") || CATALOG_URL=""
SCAFFOLDER_URL=$(get_registry_tarball_url "$SCAFFOLDER_NPM_PKG" "$SCAFFOLDER_VERSION") || SCAFFOLDER_URL=""

[ -z "$CATALOG_URL" ] && echo "  WARNING: could not resolve catalog URL — config update may be incomplete"
[ -z "$SCAFFOLDER_URL" ] && echo "  WARNING: could not resolve scaffolder URL — config update may be incomplete"

echo "  catalog URL:    ${CATALOG_URL:-(unknown)}"
echo "  scaffolder URL: ${SCAFFOLDER_URL:-(unknown)}"

# Use yq if available, otherwise node-based YAML update
if command -v yq &>/dev/null; then
  # yq-based update on dist-config copies
  yq -i ".dynamicPlugins.install[0].package = \"@${NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic@${CATALOG_VERSION}\"" "$DIST_CONFIG/values-rhdh.yaml"
  yq -i ".dynamicPlugins.install[0].integrity = \"sha256-${CATALOG_HASH_B64}\"" "$DIST_CONFIG/values-rhdh.yaml"
  yq -i ".dynamicPlugins.install[1].package = \"@${NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic@${SCAFFOLDER_VERSION}\"" "$DIST_CONFIG/values-rhdh.yaml"
  yq -i ".dynamicPlugins.install[1].integrity = \"sha256-${SCAFFOLDER_HASH_B64}\"" "$DIST_CONFIG/values-rhdh.yaml"
  yq -i ".dynamicPlugins.hosts[0].packages[0] = \"${CATALOG_URL}\"" "$DIST_CONFIG/values-rhdh.yaml"
  yq -i ".dynamicPlugins.hosts[0].packages[1] = \"${SCAFFOLDER_URL}\"" "$DIST_CONFIG/values-rhdh.yaml"

  yq -i ".plugins[0].package = \"@${NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic@${CATALOG_VERSION}\"" "$DIST_CONFIG/dynamic-plugins.yaml"
  yq -i ".plugins[0].integrity = \"sha256-${CATALOG_HASH_B64}\"" "$DIST_CONFIG/dynamic-plugins.yaml"
  yq -i ".plugins[1].package = \"@${NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic@${SCAFFOLDER_VERSION}\"" "$DIST_CONFIG/dynamic-plugins.yaml"
  yq -i ".plugins[1].integrity = \"sha256-${SCAFFOLDER_HASH_B64}\"" "$DIST_CONFIG/dynamic-plugins.yaml"
else
  # Node-based YAML update on dist-config copies
  VALUES_FILE="$DIST_CONFIG/values-rhdh.yaml" \
  DYNAMIC_PLUGINS_FILE="$DIST_CONFIG/dynamic-plugins.yaml" \
  NPM_SCOPE="$NPM_SCOPE" \
  CATALOG_VER="$CATALOG_VERSION" \
  CATALOG_HASH="$CATALOG_HASH_B64" \
  CATALOG_URL="$CATALOG_URL" \
  SCAFFOLDER_VER="$SCAFFOLDER_VERSION" \
  SCAFFOLDER_HASH="$SCAFFOLDER_HASH_B64" \
  node << 'NODESCRIPT'
    const fs = require('fs');
    const scope = process.env.NPM_SCOPE;

    // values-rhdh.yaml
    let v = fs.readFileSync(process.env.VALUES_FILE, 'utf8');

    // Replace catalog package and integrity (lines 14-16 area)
    v = v.replace(/package: '(@[^/]+\/)?plugin-catalog-backend-module-gitea-dynamic@[^']+'/g,
      `package: '@${scope}/plugin-catalog-backend-module-gitea-dynamic@${process.env.CATALOG_VER}'`);
    v = v.replace(/(?<=catalog-backend-module-gitea-dynamic@[^']+'\s*\n\s*disabled: false\s*\n\s*integrity: ')[^']+/g,
      process.env.CATALOG_HASH);

    // Replace scaffolder package and integrity
    v = v.replace(/package: '(@[^/]+\/)?plugin-scaffolder-backend-module-gitea-dynamic@[^']+'/g,
      `package: '@${scope}/plugin-scaffolder-backend-module-gitea-dynamic@${process.env.SCAFFOLDER_VER}'`);
    v = v.replace(/(?<=scaffolder-backend-module-gitea-dynamic@[^']+'\s*\n\s*disabled: false\s*\n\s*integrity: ')[^']+/g,
      process.env.SCAFFOLDER_HASH);

    // Replace host package URLs (handle both / and %2F between scope and plugin name; match any hostname + any scope placeholder)
    v = v.replace(/https:\/\/[^'\/\s]+\s*\n?\s*\/api\/packages\/[^'\/\s]+\s*\n?\s*\/npm\/(%40[^'/\s]+(%2F|\/))?plugin-catalog-backend-module-gitea-dynamic\/[^'\n]+/g,
      process.env.CATALOG_URL);
    v = v.replace(/https:\/\/[^'\/\s]+\s*\n?\s*\/api\/packages\/[^'\/\s]+\s*\n?\s*\/npm\/(%40[^'/\s]+(%2F|\/))?plugin-scaffolder-backend-module-gitea-dynamic\/[^'\n]+/g,
      process.env.SCAFFOLDER_URL);

    fs.writeFileSync(process.env.VALUES_FILE, v);
    console.log('  ✓ values-rhdh.yaml updated');

    // dynamic-plugins.yaml
    let d = fs.readFileSync(process.env.DYNAMIC_PLUGINS_FILE, 'utf8');

    d = d.replace(/package: '(@[^/]+\/)?plugin-catalog-backend-module-gitea-dynamic@[^']+'/g,
      `package: '@${scope}/plugin-catalog-backend-module-gitea-dynamic@${process.env.CATALOG_VER}'`);
    d = d.replace(/(?<=catalog-backend-module-gitea-dynamic@[^']+'\s*\n\s*disabled: false\s*\n\s*integrity: ')[^']+/g,
      process.env.CATALOG_HASH);

    d = d.replace(/package: '(@[^/]+\/)?plugin-scaffolder-backend-module-gitea-dynamic@[^']+'/g,
      `package: '@${scope}/plugin-scaffolder-backend-module-gitea-dynamic@${process.env.SCAFFOLDER_VER}'`);
    d = d.replace(/(?<=scaffolder-backend-module-gitea-dynamic@[^']+'\s*\n\s*disabled: false\s*\n\s*integrity: ')[^']+/g,
      process.env.SCAFFOLDER_HASH);

    fs.writeFileSync(process.env.DYNAMIC_PLUGINS_FILE, d);
    console.log('  ✓ dynamic-plugins.yaml updated');
NODESCRIPT
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "================================================"
echo "  Done — both plugins built, published, validated"
echo "================================================"
echo ""
echo "  Catalog:    @${NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic@${CATALOG_VERSION}"
echo "              sha256: sha256-${CATALOG_HASH_B64}"
echo "  Scaffolder: @${NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic@${SCAFFOLDER_VERSION}"
echo "              sha256: sha256-${SCAFFOLDER_HASH_B64}"
echo ""
echo "  Registry:   ${NPM_REGISTRY}"
echo "  Configs:    dist-config/values-rhdh.yaml, dist-config/dynamic-plugins.yaml"
echo ""
