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
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    '@semantic-release/npm',
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
