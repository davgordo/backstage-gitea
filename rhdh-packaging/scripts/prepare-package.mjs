#!/usr/bin/env node

import fs from 'node:fs';

const [packageJsonPath, packageName, packageVersion, registry] =
  process.argv.slice(2);

if (!packageJsonPath || !packageName || !packageVersion || !registry) {
  console.error(
    'Usage: prepare-package.mjs <package-json> <name> <version> <registry>',
  );
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

packageJson.name = packageName;
packageJson.version = packageVersion;
packageJson.main = './dist/index.cjs.js';
packageJson.types = './dist/index.d.ts';
packageJson.exports = {
  '.': {
    require: './dist/index.cjs.js',
    types: './dist/index.d.ts',
    default: './dist/index.cjs.js',
  },
  './package.json': './package.json',
};
packageJson.files = ['dist'];
packageJson.publishConfig = { access: 'public', registry };

delete packageJson.typesVersions;
delete packageJson.scripts;

packageJson.peerDependencies ??= {};
for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  if (name.startsWith('@backstage/')) {
    packageJson.peerDependencies[name] = version;
    delete packageJson.dependencies[name];
  }
}

if (Object.keys(packageJson.dependencies ?? {}).length === 0) {
  delete packageJson.dependencies;
}

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
