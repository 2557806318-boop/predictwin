/**
 * PRIVATE STRATEGY INTENTIONALLY OMITTED.
 * Implement research logic here. The default MUST NOT generate orders.
 * Direction probability must not treat executable depth as directional evidence.
 * @param {{round: object, features: object, nowMs: number}} context
 * @returns {{action:'SKIP', reason:string}|{action:'CANDIDATE',side:'UP'|'DOWN',budgetWei:bigint,probabilityLower:string,minEdge:string}}
 */
export function decide(context) {
  void context;
  return { action: 'SKIP', reason: 'STRATEGY_NOT_IMPLEMENTED' };
}
