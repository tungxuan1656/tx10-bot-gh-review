import type { InstallationOctokit } from './github-discussion.js'
import type { PullRequestContext } from './types.js'

export type ReviewReaction = 'eyes' | 'hooray' | 'confused' | 'laugh'

const reviewReactionContents = new Set<ReviewReaction>([
  'eyes',
  'hooray',
  'confused',
  'laugh',
])

type IssueReaction = {
  content?: string | null
  id: number
  user?: {
    login?: string | null
  } | null
}

function isReviewReactionContent(
  content: string | null | undefined,
): content is ReviewReaction {
  return (
    typeof content === 'string' &&
    reviewReactionContents.has(content as ReviewReaction)
  )
}

function isBotAuthoredReaction(
  reaction: IssueReaction,
  botLogin: string,
): boolean {
  return (
    reaction.user?.login === botLogin &&
    isReviewReactionContent(reaction.content)
  )
}

export async function setPullRequestReaction(
  octokit: InstallationOctokit,
  context: PullRequestContext,
  reaction: ReviewReaction,
  botLogin: string,
): Promise<void> {
  const currentReactions = await octokit.paginate(
    octokit.rest.reactions.listForIssue,
    {
      owner: context.owner,
      repo: context.repo,
      issue_number: context.pullNumber,
      per_page: 100,
    },
  )

  const botReactions = (currentReactions as IssueReaction[]).filter((item) =>
    isBotAuthoredReaction(item, botLogin),
  )

  const matchingReaction = botReactions.find((item) => item.content === reaction)

  if (botReactions.length === 1 && matchingReaction) {
    return
  }

  const staleReactions = botReactions.filter((item) => item.content !== reaction)

  if (matchingReaction) {
    if (staleReactions.length > 0) {
      await Promise.all(
        staleReactions.map((item) =>
          octokit.rest.reactions.deleteForIssue({
            owner: context.owner,
            repo: context.repo,
            reaction_id: item.id,
            issue_number: context.pullNumber,
          }),
        ),
      )
    }

    return
  }

  await octokit.rest.reactions.createForIssue({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    content: reaction,
  })

  if (staleReactions.length === 0) {
    return
  }

  await Promise.all(
    staleReactions.map((item) =>
      octokit.rest.reactions.deleteForIssue({
        owner: context.owner,
        repo: context.repo,
        reaction_id: item.id,
        issue_number: context.pullNumber,
      }),
    ),
  )
}
