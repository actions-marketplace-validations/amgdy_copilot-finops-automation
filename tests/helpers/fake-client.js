/**
 * A minimal fake of GitHubClient for apply-engine/cost-center unit tests.
 * Records every write request and serves canned budgets / cost centers.
 */
export class FakeClient {
  constructor({ budgets = [], costCenters = [], teams = [], failBudgetWrite = false, failBudgetList = false, failResourceAssign = false } = {}) {
    this.budgets = budgets;
    this.costCenters = costCenters;
    this.teams = teams;
    this.failBudgetWrite = failBudgetWrite;
    this.failBudgetList = failBudgetList;
    this.failResourceAssign = failResourceAssign;
    this.requests = [];
    this._ccSeq = 0;
  }

  async paginateEnvelope(route, _params, _envelopeKey) {
    if (route.includes("/teams")) return structuredClone(this.teams);
    if (route.includes("/cost-centers")) return structuredClone(this.costCenters);
    if (route.includes("/budgets") && this.failBudgetList) {
      const err = new Error("budget list failed");
      err.status = 503;
      err.response = { data: { message: "temporary billing API failure" } };
      throw err;
    }
    if (route.includes("/budgets")) return structuredClone(this.budgets);
    return [];
  }

  async request(route, params = {}) {
    this.requests.push({ route, params });

    if (route.startsWith("POST") && route.endsWith("/cost-centers")) {
      const id = `cc-id-${++this._ccSeq}`;
      const cc = { id, name: params.name, state: "active", resources: [] };
      this.costCenters.push(cc);
      return { data: { id, name: params.name, resources: [] } };
    }
    if (route.includes("/cost-centers/{cost_center_id}/resource")) {
      if (this.failResourceAssign) {
        const err = new Error("assignment rejected by API");
        err.status = 422;
        err.response = { data: { message: "team not found" } };
        throw err;
      }
      return { data: {} };
    }
    if (route.startsWith("DELETE") && route.includes("/cost-centers/{cost_center_id}")) {
      const cc = this.costCenters.find((c) => c.id === params.cost_center_id);
      if (cc) cc.state = "deleted";
      return { data: {} };
    }
    if (route.includes("/budgets")) {
      if (this.failBudgetWrite) {
        const spec = typeof this.failBudgetWrite === "object" ? this.failBudgetWrite : {};
        const message = spec.message || "budget rejected by API";
        const err = new Error(message);
        err.status = spec.status || 422;
        err.response = { data: { message } };
        throw err;
      }
      return { data: {} };
    }
    return { data: {} };
  }

  /** All write requests whose route matches a substring. */
  writes(substr) {
    return this.requests.filter((r) => r.route.includes(substr));
  }
}
