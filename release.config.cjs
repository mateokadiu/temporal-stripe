/**
 * semantic-release config. Conventional commits drive the version bump:
 *   - feat: → minor
 *   - fix:  → patch
 *   - BREAKING CHANGE: footer → major
 *
 * Releases publish the workspace's two public packages to npm. The two are
 * versioned in lockstep — easier than trying to coordinate ranges across them.
 */
module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/changelog',
      { changelogFile: 'CHANGELOG.md' },
    ],
    [
      'semantic-release-monorepo',
      {
        // Apply per-package; the GH Actions release workflow runs sr per package.
      },
    ],
    [
      '@semantic-release/npm',
      {
        // pkgRoot is set per-package in the GH workflow.
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json', 'packages/*/package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
};
