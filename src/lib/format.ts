/** USD with precision that suits small AI costs: $0, $0.0042, $3.10, $250. */
export const usd = (n: number) => (n === 0 ? "$0" : `$${n < 10 ? n.toFixed(n < 1 ? 4 : 2) : n.toFixed(0)}`);
