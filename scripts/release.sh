#!/bin/bash
set -e

VERSION=$1
if [ -z "$VERSION" ] || ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9] ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.1.0"
  exit 1
fi

for pkg in packages/sdks/js packages/opencode-plugin apps/cli; do
  bun -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('${pkg}/package.json', 'utf8'));
    p.version = '${VERSION}';
    if (p.dependencies?.['@boboddy/sdk']) p.dependencies['@boboddy/sdk'] = '^${VERSION}';
    if (p.dependencies?.['@boboddy/opencode-plugin']) p.dependencies['@boboddy/opencode-plugin'] = '^${VERSION}';
    fs.writeFileSync('${pkg}/package.json', JSON.stringify(p, null, 2) + '\n');
    console.log('  bumped ' + p.name + ' → ${VERSION}');
  "
done

git add -A && git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"
echo ""
echo "Tagged v${VERSION}. Run: git push && git push --tags"
