import type { GitHubPullRequestFile } from "./types.js";

const supportedExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".py", ".java"]);
const ignoredPrefixes = ["node_modules/", "dist/", "build/"];
const ignoredSuffixes = [
  ".lock",
  ".min.js",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
];

export function isReviewableFilePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");

  if (ignoredPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
    return false;
  }

  if (ignoredSuffixes.some((suffix) => normalizedPath.endsWith(suffix))) {
    return false;
  }

  const extension = normalizedPath.includes(".")
    ? normalizedPath.slice(normalizedPath.lastIndexOf("."))
    : "";

  return supportedExtensions.has(extension);
}

export function filterReviewableFiles(files: GitHubPullRequestFile[]): GitHubPullRequestFile[] {
  return files.filter((file) => {
    if (!isReviewableFilePath(file.path)) {
      return false;
    }

    if (!file.patch || file.status === "removed") {
      return false;
    }

    return true;
  });
}
