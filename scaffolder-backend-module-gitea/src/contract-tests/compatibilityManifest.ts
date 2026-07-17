export type CompatibilityStatus = 'supported' | 'accepted-no-op' | 'rejected' | 'gitea-extension';

export const compatibilityContracts = {
  'publish:github': {
    replacement: 'publish:gitea',
    requiredOutputs: ['remoteUrl', 'repoContentsUrl', 'commitHash'],
    giteaExtensions: ['repoId'],
    giteaInputExtensions: ['signCommit'],
    requirednessDifferences: ['description'],
    rejected: [
      'bypassPullRequestAllowances', 'restrictions',
      'requiredConversationResolution', 'requireLastPushApproval',
      'repoVariables', 'secrets', 'oidcCustomization', 'customProperties',
      'subscribe', 'requiredLinearHistory',
      'homepage', 'deleteBranchOnMerge', 'allowMergeCommit',
      'allowSquashMerge', 'squashMergeCommitTitle',
      'squashMergeCommitMessage', 'allowRebaseMerge', 'allowAutoMerge',
      'allowUpdateBranch', 'hasProjects', 'hasWiki', 'hasIssues', 'topics',
    ],
  },
  'publish:github:pull-request': {
    replacement: 'publish:gitea:pull-request',
    requiredOutputs: ['remoteUrl', 'pullRequestNumber', 'targetBranchName'],
    acceptedNoOp: ['gitAuthorName', 'gitAuthorEmail', 'forceEmptyGitAuthor', 'draft'],
    rejected: ['forceFork'],
    giteaExtensions: ['pullRequestUrl', 'branchName'],
    giteaInputExtensions: [],
    requirednessDifferences: ['description'],
  },
  'github:webhook': {
    replacement: 'gitea:webhook',
    comparedInputs: ['repoUrl', 'webhookUrl', 'webhookSecret', 'events', 'active', 'contentType', 'insecureSsl', 'token'],
    giteaExtensions: ['httpMethod', 'branchFilter', 'hookId', 'hookUrl'],
    giteaInputExtensions: ['httpMethod', 'branchFilter'],
    requirednessDifferences: [],
  },
} as const;
