export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers
  });
}

export function errorResponse(status, error, details) {
  return json(
    {
      error,
      details
    },
    { status }
  );
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
