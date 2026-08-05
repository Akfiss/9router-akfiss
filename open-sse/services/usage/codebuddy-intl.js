/**
 * CodeBuddy Intl usage handler
 *
 * Talks to https://www.codebuddy.ai/v2/billing/meter/get-user-resource
 * Response shape mirrors codebuddy-cn: data.Response.Data.Accounts[] with
 * CapacitySize / CapacityUsed / CapacityRemain / CycleEndTime / PackageName.
 *
 * Free trial accounts get a single 250-credit "CodeBuddy One-time Free 2-Week
 * Pro Plan Trial" package (one-shot, not recurring).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { U, parseResetTime } from "./shared.js";

const PROVIDER_ID = "codebuddy-intl";

function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

export async function getCodeBuddyIntlUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "CodeBuddy credential not available." };
  }

  try {
    const response = await proxyAwareFetch(U(PROVIDER_ID).url, {
      method: "POST",
      headers: {
        ...(PROVIDERS[PROVIDER_ID]?.transport?.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "CodeBuddy credential invalid or expired." };
    }
    if (!response.ok) {
      return { message: `CodeBuddy quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: `CodeBuddy quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: "CodeBuddy connected. No credit package found." };
    }

    const cycleEndMs = (acc) => {
      const r = parseResetTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const isRefill = (acc) => {
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    const seenRefill = {};
    refills.forEach((acc) => {
      const start = parseResetTime(acc.CycleStartTime);
      const end = parseResetTime(acc.CycleEndTime);
      let base = "Monthly";
      if (start && end) {
        const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
        if (days <= 1.5) base = "Daily";
        else if (days <= 10) base = "Weekly";
      }
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: true,
      };
    });
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: false,
      };
    });

    const basePkg = refills[0] || accounts[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || "CodeBuddy";

    return { plan, quotas };
  } catch (error) {
    return { message: `CodeBuddy error: ${error.message}` };
  }
}
