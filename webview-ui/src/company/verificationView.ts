/**
 * verificationView: how a Contract's acceptance criteria map to the commands
 * that prove them.
 *
 * The Contract names criteria; the verification profiles name the exact
 * `{executable, argv, cwd}` each criterion is checked with. The plan panel
 * needs both to show what WILL be run next to what already ran, and the drawer
 * needs the same map to label evidence. Keeping the join here means the two
 * cannot disagree about which command proves which criterion.
 */

import type { VerificationProfile } from '../../../core/src/company.js';

/** Criterion -> the verification command ids declared for it. */
export function commandsByCriterion(
  profiles: Record<string, VerificationProfile>,
): Map<string, readonly string[]> {
  const byCriterion = new Map<string, string[]>();
  for (const profile of Object.values(profiles)) {
    for (const command of profile.commands) {
      for (const criterionId of profile.criterionIds) {
        const existing = byCriterion.get(criterionId);
        if (existing) {
          existing.push(command.id);
        } else {
          byCriterion.set(criterionId, [command.id]);
        }
      }
    }
  }
  return byCriterion;
}
