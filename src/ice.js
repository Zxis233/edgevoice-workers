const FALLBACK_ICE_SERVERS = [
  {
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]
  }
];

export async function resolveIceServers(env) {
  const turnKeyId = env.CLOUDFLARE_TURN_KEY_ID;
  const turnToken = env.CLOUDFLARE_TURN_TOKEN;

  if (!turnKeyId || !turnToken) {
    return FALLBACK_ICE_SERVERS;
  }

  const ttl = Number.parseInt(env.TURN_TTL_SECONDS ?? "3600", 10) || 3600;
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${turnToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ttl })
    }
  );

  if (!response.ok) {
    return FALLBACK_ICE_SERVERS;
  }

  const data = await response.json();
  if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
    return data.iceServers;
  }

  return FALLBACK_ICE_SERVERS;
}
