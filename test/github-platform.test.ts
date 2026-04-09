import { describe, expect, it, vi } from "vitest";

import { buildReviewMarker } from "../src/review/summary.js";
import { createGitHubReviewPlatform } from "../src/review/github-platform.js";
import type { PullRequestContext } from "../src/review/types.js";

function createPullRequestContext(): PullRequestContext {
  return {
    action: "opened",
    installationId: 7,
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
    title: "Example",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headSha: "abc123",
    baseSha: "def456",
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
  const request = vi.fn().mockResolvedValue({
    data: {
      slug: "review-bot",
    },
  });
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
      githubAppId: "123",
      githubPrivateKey: "private-key",
    },
    {
      createAppOctokit: () =>
        ({
          request,
        }) as never,
      createInstallationOctokit: () =>
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

  return { platform, request };
}

describe("createGitHubReviewPlatform", () => {
  it("ignores marker comments that were not authored by the app bot", async () => {
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

  it("accepts marker comments authored by the app bot", async () => {
    const marker = buildReviewMarker("abc123");
    const { platform, request } = createPlatformWithPublishedItems({
      comments: [
        {
          body: marker,
          user: {
            login: "review-bot[bot]",
          },
        },
      ],
      reviews: [],
    });

    const result = await platform.hasPublishedResult(createPullRequestContext(), marker);

    expect(result).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
