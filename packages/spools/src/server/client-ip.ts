/**
 * Resolve the client IP from X-Forwarded-For given how many trusted proxies sit in
 * front of the server. Each proxy appends the address it saw, so only the last
 * `hops` entries are trustworthy; anything further left was sent by the client.
 */
export function clientIp(
  forwardedFor: string | null,
  socketIp: string | undefined,
  hops: number,
): string | undefined {
  if (hops === 0 || !forwardedFor) {
    return socketIp
  }

  const chain = forwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return chain[chain.length - hops] ?? socketIp
}
