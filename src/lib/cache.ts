import NodeCache from "node-cache";

// Standard TTL of 5 minutes.
// checkperiod of 2 minutes to clear expired items.
export const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

/**
 * Invalidates all cached dashboard aggregations for a specific user.
 * Since monthly rollover savings, cumulative savings-all-time, and 12-month
 * trend queries cross month boundaries, updating any expense, income, budget,
 * or category clears all dashboard cache keys for that user.
 */
export function invalidateUserDashboard(userId: string): void {
  const prefix = `dashboard_${userId}_`;
  const keys = cache.keys();
  for (const k of keys) {
    if (k.startsWith(prefix)) {
      cache.del(k);
    }
  }
}

