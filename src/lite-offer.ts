import { TEAMCLAWS_ORIGIN } from "./constants.js";
import type { FetchLike } from "./http.js";

export const LITE_OFFER_URL = `${TEAMCLAWS_ORIGIN}/offers/agents/`;

export async function fetchLiteOffer(fetcher: FetchLike, signal?: AbortSignal) {
  const response = await fetcher(LITE_OFFER_URL, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: signal ?? null,
  });
  if (!response.ok) throw new Error("Offer unavailable");
  const data = (await response.json()) as {
    offer?: unknown;
    cardless_days?: unknown;
    extra_days_with_card?: unknown;
    claim_guidance?: unknown;
    renewal?: {
      name?: unknown;
      amount_minor?: unknown;
      currency?: unknown;
      interval?: unknown;
    };
  } | null;
  const renewal = data?.renewal;
  if (
    data?.offer !== "lite" ||
    !positiveInteger(data.cardless_days) ||
    !positiveInteger(data.extra_days_with_card) ||
    typeof data.claim_guidance !== "string" ||
    !data.claim_guidance.trim() ||
    typeof renewal?.name !== "string" ||
    !renewal.name.trim() ||
    !positiveInteger(renewal.amount_minor) ||
    renewal.currency !== "USD" ||
    renewal.interval !== "monthly"
  ) {
    throw new Error("Invalid offer");
  }
  return {
    offer: data.offer,
    cardless_days: data.cardless_days,
    extra_days_with_card: data.extra_days_with_card,
    renewal: {
      name: renewal.name,
      amount_minor: renewal.amount_minor,
      currency: renewal.currency,
      interval: renewal.interval,
    },
    claim_guidance: data.claim_guidance,
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
