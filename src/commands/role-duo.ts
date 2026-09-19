import { seedRoleDuo, withdrawHolderConsent, type RoleDuoSeed } from "../role-duo/seed.js";

/** Implements `duo role-duo seed <definitionPath>` (#72): reads the hand-authored definition, seeds standing orders from every consenting holder's active rules, and writes the result to `<definitionPath>` with `.seed.json` in place of `.json`. */
export function runRoleDuoSeed(definitionPath: string): RoleDuoSeed {
  return seedRoleDuo(definitionPath);
}

/** Implements `duo role-duo withdraw <definitionPath> <holderId>` (#72's withdrawal checkbox): records the withdrawal in the definition file and re-seeds immediately. */
export function runRoleDuoWithdraw(definitionPath: string, holderId: string): RoleDuoSeed {
  return withdrawHolderConsent(definitionPath, holderId);
}
