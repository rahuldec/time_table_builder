// Vercel serverless function — proxies the OD3 Academic API so the bearer
// token stays server-side. It's never sent to, or bundled into, the browser
// (unlike a VITE_-prefixed env var, which Vite bakes straight into the
// shipped JS and anyone can read from the deployed site).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const baseUrl = process.env.ACADEMIC_API_BASE_URL;
  const token = process.env.ACADEMIC_API_TOKEN;
  const session = process.env.ACADEMIC_SESSION;

  if (!baseUrl || !token || !session) {
    res.status(500).json({
      message:
        "Server is missing Academic API configuration. Set ACADEMIC_API_BASE_URL, ACADEMIC_API_TOKEN, ACADEMIC_SESSION in Vercel project env vars.",
    });
    return;
  }

  const { entity, pageNumber, pageSize } = req.body ?? {};
  if (!entity || typeof entity !== "string") {
    res.status(400).json({ message: "entity is required" });
    return;
  }

  const upstream = await fetch(
    `${baseUrl}/api/list/subjectCourseMapping?pageSize=${pageSize ?? 50}&pageNumber=${pageNumber ?? 1}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The upstream API expects the raw JWT here, not a "Bearer " prefix.
        Authorization: token,
      },
      body: JSON.stringify({ entity, session }),
    }
  );

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("Content-Type", "application/json");
  res.send(text);
}
