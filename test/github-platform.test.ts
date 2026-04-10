import { describe, expect, it, vi } from "vitest";

import { buildReviewMarker } from "../src/review/summary.js";
import { createGitHubReviewPlatform } from "../src/review/github-platform.js";
import type { PullRequestContext } from "../src/review/types.js";

function createPullRequestContext(): PullRequestContext {
  return {
    action: "review_requested",
    installationId: 0,
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
    title: "Example",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headSha: "abc123",
    headRef: "feature/example",
    headCloneUrl: "https://github.com/acme/repo.git",
    baseSha: "def456",
    baseRef: "main",
    baseCloneUrl: "https://github.com/acme/repo.git",
  };
}

function createPlatformWithPublishedItems(input: {
  comments: Array<{ body?: string; user?: { login?: string } }>;
  reviews: Array<{ body?: string; user?: { login?: string } }>;
}) {
  const listFiles = vi.fn();
  const listReviews = vi.fn();
  const createReview = vi.fn();
  const listComments = vi.fn();
  const createComment = vi.fn();
  const getContent = vi.fn();
  const paginate = vi.fn((route: unknown) => {
    if (route === listReviews) {
      return Promise.resolve(input.reviews);
    }

    if (route === listComments) {
      return Promise.resolve(input.comments);
    }

    return Promise.resolve([]);
  });

  const platform = createGitHubReviewPlatform(
    {
      githubToken: "ghp_test_token",
      githubBotLogin: "review-bot",
    },
    {
      createOctokit: () =>
        ({
          paginate,
          rest: {
            pulls: {
              listFiles,
              listReviews,
              createReview,
            },
            issues: {
              listComments,
              createComment,
            },
            repos: {
              getContent,
            },
          },
        }) as never,
    },
  );

  return { platform };
}

describe("createGitHubReviewPlatform", () => {
  it("ignores marker comments that were not authored by the configured bot login", async () => {
    const marker = buildReviewMarker("abc123");
    const { platform } = createPlatformWithPublishedItems({
      comments: [
        {
          body: `Human copied the marker ${marker}`,
          user: {
            login: "teammate",
          },
        },
      ],
      reviews: [],
    });

    const result = await platform.hasPublishedResult(createPullRequestContext(), marker);

    expect(result).toBe(false);
  });

  it("accepts marker comments authored by the configured bot login", async () => {
    const marker = buildReviewMarker("abc123");
    const { platform } = createPlatformWithPublishedItems({
      comments: [
        {
          body: marker,
          user: {
            login: "review-bot",
          },
        },
      ],
      reviews: [],
    });

    const result = await platform.hasPublishedResult(createPullRequestContext(), marker);

    expect(result).toBe(true);
  });
});
