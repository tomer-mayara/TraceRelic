import { Then } from "@cucumber/cucumber";

export interface ForkTotalsScenario {
  checkForkTotals(parentTokens: number, childTokens: number): void | Promise<void>;
}

Then("the parent shows {int} and the linked child shows {int}", function (
  this: ForkTotalsScenario, parentTokens: number, childTokens: number,
) {
  return this.checkForkTotals(parentTokens, childTokens);
});
