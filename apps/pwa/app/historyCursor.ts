export type GatewayHistoryCursor = {
  before?: string;
  complete: boolean;
};

export function advanceHistoryCursor(
  current: GatewayHistoryCursor | undefined,
  requestBefore: string | undefined,
  response: { nextBefore?: string; hasMore: boolean },
): GatewayHistoryCursor | undefined {
  if ((current?.before ?? undefined) !== requestBefore || current?.complete) {
    return current;
  }
  return {
    ...(response.nextBefore ? { before: response.nextBefore } : {}),
    complete: !response.hasMore,
  };
}
