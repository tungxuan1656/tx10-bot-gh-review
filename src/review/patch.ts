const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function getCommentableRightSideLines(patch: string): Set<number> {
  const commentableLines = new Set<number>()
  let currentNewLine = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    const hunkHeader = line.match(hunkHeaderPattern)
    if (hunkHeader?.[1]) {
      currentNewLine = Number(hunkHeader[1])
      inHunk = true
      continue
    }

    if (!inHunk || line.length === 0) {
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      commentableLines.add(currentNewLine)
      currentNewLine += 1
      continue
    }

    if (line.startsWith(' ') || line === '\\ No newline at end of file') {
      if (line.startsWith(' ')) {
        commentableLines.add(currentNewLine)
        currentNewLine += 1
      }
      continue
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue
    }
  }

  return commentableLines
}

export function isCommentableRightSideLine(
  patch: string,
  line: number,
): boolean {
  return getCommentableRightSideLines(patch).has(line)
}
