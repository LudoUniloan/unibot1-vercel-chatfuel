export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    git_commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
    node_version: process.version,
    time: new Date().toISOString(),
  });
}
