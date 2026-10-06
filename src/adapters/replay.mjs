/**
 * Replay adapter: the "model" already answered (e.g. a Claude Code subagent in the user's own session), and its reply
 * text is fed through the SAME runner checks as any other agent — scope, secrets, URLs, apply, verify.
 * No network. `usage` is whatever the caller reports (or undefined, so the runner charges the worst case).
 */
import { extractCodeBlock } from "./ollama.mjs";

export function makeReplayAgent({ replyText, usage }) {
  return async function replayAgent({ task }) {
    const code = extractCodeBlock(replyText);
    return { text: String(replyText ?? ""), files: code ? { [task.allowed[0]]: code } : {}, usage };
  };
}
