import type { GitHubPullRequestFile, PriorSuccessfulReviewInfo, PriorSuccessfulReviewState, PRCommit, PRInfoObject, PullRequestContext } from './types.js'
import type { InstallationOctokit } from './github-discussion.js'

const maxCommits = 30
const maxCommitMessageChars = 200

function truncateCommitMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? message
  if (firstLine.length <= maxCommitMessageChars) {
    return firstLine
  }
  return `${firstLine.slice(0, maxCommitMessageChars)}...`
}

function toSuccessfulReviewState(
  state: string | null | undefined,
): PriorSuccessfulReviewState | null {
  if (state === 'APPROVED') {
    return 'APPROVED'
  }

  if (state === 'CHANGES_REQUESTED') {
    return 'CHANGES_REQUESTED'
  }

  if (state === 'COMMENTED') {
    return 'COMMENTED'
  }

  return null
}

export async function listPullRequestFiles(
  octokit: InstallationOctokit,
  context: PullRequestContext,
): Promise<GitHubPullRequestFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    per_page: 100,
  })

  return files.map((file) => ({
    path: file.filename,
    status: file.status,
    ...(file.patch ? { patch: file.patch } : {}),
  }))
}

export async function getFileContent(
  octokit: InstallationOctokit,
  context: PullRequestContext,
  path: string,
): Promise<string | null> {
  const response = await octokit.rest.repos.getContent({
    owner: context.owner,
    repo: context.repo,
    path,
    ref: context.headSha,
  })

  if (
    Array.isArray(response.data) ||
    response.data.type !== 'file' ||
    !response.data.content
  ) {
    return null
  }

  return Buffer.from(response.data.content, 'base64').toString('utf8')
}

export async function hasPublishedResult(
  octokit: InstallationOctokit,
  context: PullRequestContext,
  marker: string,
  botLogin: string,
): Promise<boolean> {
  const [reviews, comments] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: context.owner,
      repo: context.repo,
      issue_number: context.pullNumber,
      per_page: 100,
    }),
  ])

  return [...reviews, ...comments].some((item) =>
    item.body?.includes(marker) === true &&
    item.user?.login === botLogin &&
    typeof item.body === 'string',
  )
}

export async function getPriorSuccessfulReview(
  octokit: InstallationOctokit,
  context: PullRequestContext,
  botLogin: string,
): Promise<PriorSuccessfulReviewInfo> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    per_page: 100,
  })

  const latest = [...reviews]
    .filter((review) => review.user?.login === botLogin)
    .map((review) => ({
      commitId: review.commit_id ?? null,
      state: toSuccessfulReviewState(review.state),
      submittedAt: review.submitted_at ?? '',
    }))
    .filter(
      (
        review,
      ): review is {
        commitId: string | null
        state: PriorSuccessfulReviewState
        submittedAt: string
      } => review.state !== null,
    )
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
    .at(0)

  if (!latest) {
    return {
      hasPriorSuccessfulReview: false,
      latestReviewedSha: null,
      latestReviewState: null,
    }
  }

  return {
    hasPriorSuccessfulReview: true,
    latestReviewedSha: latest.commitId,
    latestReviewState: latest.state,
  }
}

export async function getPRInfo(
  octokit: InstallationOctokit,
  context: PullRequestContext,
): Promise<PRInfoObject> {
  const [commitsRaw, filesRaw, prRaw] = await Promise.all([
    octokit.rest.pulls.listCommits({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: maxCommits,
    }),
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: 100,
    }),
    octokit.rest.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
    }),
  ])

  const commits: PRCommit[] = commitsRaw.data.map((c) => ({
    sha: c.sha,
    message: truncateCommitMessage(c.commit.message),
  }))

  const changedFilePaths = filesRaw.map((f) => f.filename)

  return {
    owner: context.owner,
    repo: context.repo,
    pullNumber: context.pullNumber,
    title: prRaw.data.title,
    description: (prRaw.data.body ?? '').slice(0, 4_000),
    headSha: context.headSha,
    baseSha: context.baseSha,
    headRef: context.headRef,
    baseRef: context.baseRef,
    htmlUrl: prRaw.data.html_url,
    commits,
    changedFilePaths,
  }
}
