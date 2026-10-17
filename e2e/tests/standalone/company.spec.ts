import { expect, test } from '@playwright/test';

import { startCompanySmokeHost } from '../../helpers/company.js';

/**
 * The whole Company path, driven the way a user drives it: type a prompt, answer
 * what it asks, read the Contract, approve it, and watch the work be verified.
 *
 * Every assertion is a visible outcome. Nothing here reads the fixture's
 * filesystem state — what the worker wrote is proven by the declared check
 * command passing and by the report naming the file it touched, both of which
 * the user can see in the drawer.
 */
test('Company plans, asks, waits for approval, then verifies the approved work', {
  tag: '@area:company',
}, async ({ page }, testInfo) => {
  // A real chain — real host, PTY helper, bridge, and one OS process per role —
  // is minutes of work on a cold Windows box. 240s covers the full
  // Director→Advisor→approval→Worker→verify→Judge path plus the drawer proof.
  test.setTimeout(240_000);
  const host = await startCompanySmokeHost();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(host.url);

    const company = page.getByTestId('company-workspace');
    await expect(company).toBeVisible();
    // The catalog is only real once a native runtime has answered for it.
    await expect(company.getByText(/mô hình: \d+\/\d+ dùng được/)).toBeVisible({ timeout: 45_000 });

    await page.getByTestId('prompt-input').fill(
      'Create result.txt with the verification fixture content and run the declared verify.',
    );
    await page.getByTestId('prompt-input').press('Control+Enter');

    // The Company asks before it plans, and the question waits for a real answer.
    const question = company.getByTestId('question-panel');
    await expect(question.getByText('Create the result file?', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await question.getByRole('radio', { name: /proceed/i }).check();
    await question.getByRole('button', { name: 'Gửi câu trả lời' }).click();

    // Nothing runs until the Contract is approved, so the board stays empty of work.
    const plan = company.getByTestId('contract-plan');
    await expect(plan).toBeVisible({ timeout: 45_000 });
    await expect(plan).toContainText('result.txt');
    // The plan names the file the approved task will write and the criterion it
    // will be held to; the command that proves it runs after approval.
    await expect(plan).toContainText('exists in the workspace');
    await expect(company.getByTestId('company-board')).toContainText('Không có gì ở đây');

    const approve = plan.getByRole('button', { name: 'Duyệt và chạy' });
    await expect(approve).toBeEnabled({ timeout: 45_000 });
    await approve.click();

    // The Worker runs for real: it writes the file and reports the change.
    const done = company.getByTestId('company-lane-done');
    await expect(done.getByRole('button', { name: /result\.txt/ })).toBeVisible({ timeout: 90_000 });

    await done.getByRole('button', { name: /result\.txt/ }).click();
    const drawer = company.getByTestId('session-drawer');
    // The drawer's tabs are the session's console, activity, questions, cost
    // and report; there is no `attempts` tab, so that click waited out the
    // whole test budget.
    await drawer.getByRole('button', { name: 'Hoạt động', exact: true }).click();
    // The declared check ran against the real workspace and exited zero.
    await expect(drawer).toContainText('mã thoát 0');

    await drawer.getByRole('button', { name: 'Báo cáo', exact: true }).click();
    // The report names the file that changed and says the criterion passed.
    await expect(drawer).toContainText('result.txt');
    await expect(drawer).toContainText(/passed/i);

    await page.screenshot({ path: testInfo.outputPath('company-approved-result.png'), fullPage: true });
  } finally {
    await testInfo.attach('company-host.log', { body: host.logs(), contentType: 'text/plain' });
    await host.close();
  }
});