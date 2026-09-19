import NodeCache from "node-cache";

// Standard TTL of 5 minutes.
// checkperiod of 2 minutes to clear expired items.
export const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
