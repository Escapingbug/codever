export type PairingRoute = {
  pairingLink: string | null;
  deviceInvitation: string | null;
  shortInvitation: string | null;
  rejectedQueryPairing: boolean;
  sanitizedPath: string;
};

/** Parses and consumes pairing-only URL state without exposing it in history. */
export function pairingRouteFromUrl(input: string): PairingRoute {
  const url = new URL(input);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const pairingLink = hash.get("pair");
  const deviceInvitation = hash.get("invite");
  const shortInvitation = hash.has("i") || hash.has("k") ? url.toString() : null;
  const rejectedQueryPairing =
    url.searchParams.has("pair") ||
    url.searchParams.has("invite") ||
    url.searchParams.has("i") ||
    url.searchParams.has("k");
  hash.delete("pair");
  hash.delete("invite");
  hash.delete("i");
  hash.delete("k");
  url.searchParams.delete("pair");
  url.searchParams.delete("invite");
  url.searchParams.delete("i");
  url.searchParams.delete("k");
  const nextHash = hash.toString();
  return {
    pairingLink,
    deviceInvitation,
    shortInvitation,
    rejectedQueryPairing,
    sanitizedPath: `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
  };
}

export function hasPairingRoute(route: PairingRoute): boolean {
  return Boolean(
    route.pairingLink ||
      route.deviceInvitation ||
      route.shortInvitation ||
      route.rejectedQueryPairing,
  );
}
