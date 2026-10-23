# Handoff: Agent Board — đội nhiều vai, chế độ gọn, thống kê tool
<!-- Đọc file này TRƯỚC khi làm tiếp nhánh. Cập nhật TRƯỚC khi báo xong, fast-handoff, hoặc hết phiên. -->
Cập nhật: 2026-10-24 01:55 · bởi: omp · nhánh: feat/multi-role-company · OpenSpec: không có

## Mục tiêu
Board điều phối đội agent (trưởng đội chia việc, chế độ gọn mỗi repo một phiên trong tab herdr riêng), cây git có tab "Phối hợp" và "Thống kê tool". Lần này: tab "Thống kê tool" hiện % usage token Claude theo phiên chính/subagent/skill/plugin và nút chuyển skill Claude không dùng sang `name-only`.

## Trạng thái
- Xong (23/10): chế độ gọn chạy việc con trên phiên omp của board theo vai, ngay trong repo (không worktree), qua 3 commit:
  - `00a44f6`: `workItemService.ts` `start()` bỏ `claimRepoPane` (không chiếm phiên herdr của người dùng, không biết model của nó); gỡ cổng `roster.wake` + `agentBack`; lời nhắn trưởng đội gọn (`squadModel.ts:629`).
  - `45ccfbf`: việc gọn mở phiên vai **chat** dưới khoá `squad:<vai>:<repo>` (`squadWorkstreamKey`), prompt gửi chế độ chat thẳng vào phiên. Lý do: vai thực thi (worker, qa) cần hợp đồng nên chế độ company bị `refuseSession` từ chối rồi rơi sang Director mở workstream mới (chạy thật lần đầu thấy S3 director `gpt-6.1-sol`, runner bị chiếm, "All 4 live runners are in use"). Model lấy theo vai trong khoá: `squadWorkstreamRole` (`workItemScheduler.ts`) + `modelRoleOf` (`companyRuntime.ts`) dùng ở `acquireNewSession` (requestedModel) và `startRun` (launch profile).
  - `b2ccea4`: `acquireNewSession` dùng lại phiên rảnh còn sống thì trả nguyên, `openChatSession` không `startRun` lần hai (`hasLiveRun`). Trước đó lượt sau ném `HostError: Session already exists`.
- Bằng chứng: vitest server cả bộ 164 file, 2667 pass / 12 skip; test mới `companyRuntime.test.ts` "runs a squad chat session opened under a role key on that role model…" và "hands back the idle live session…" (tắt bản sửa thì đỏ: 2 runner); `tsc` + eslint sạch; build, board pid 4036. Chạy thật 2 lượt qua WS (`companySquadRequest`, workspace `V:\Duancanhan\Project_QuanLyGiaiDau`): lượt 1 App → S8, Web → S9 (kết quả 6, 8); lượt 2 dùng lại đúng S8, S9 (7, 9), không phiên mới, không Director, trưởng đội chờ đúng rồi `done`.
- Cài đặt đội đổi qua WS: `engineLeader` claude (Opus) → `omp` (trưởng đội = vai plan host = `zai/glm-5.3:max`), theo ý người dùng bỏ Opus.
- Xong (24/10), người dùng chê thẻ đội "một đống form, không như session": việc con của đội gọn giờ là thẻ thường đi Sẵn sàng → Đang làm → Xong (`workItemView.ts` `visibleWorkItems` bỏ lọc). Thẻ đội gọn chỉ hiện lúc trưởng đội lập kế hoạch và khi xong (vào cột Xong, không còn "Chờ bạn"), ẩn khi đang chạy (`squadView.ts` `squadLaneFor`). Bấm thẻ việc con mở thẳng log phiên chạy nó (`BoardShell.tsx` `openWorkItemCard`; lỗi/review hoặc chưa giao thì mở panel). Thẻ phiên trùng với thẻ việc bị ẩn (`boardView.ts` thêm phiên đang giữ việc vào `carded`). Khung đội gọn bỏ form duyệt (tự duyệt), việc con mỗi dòng bấm mở phiên, lịch sử thu gọn (`SquadRunPanel.tsx`).
- Xong (24/10): khoá vùng code chỉ tính trong cùng repo (`workItemScheduler.ts` `conflictWith`, `SchedulerHold.repo`). Trước đó 2 việc đọc README.md ở 2 repo khác nhau chặn nhau ("Vùng readme.md đang có việc khác giữ").
- Bằng chứng 24/10: vitest webview 106 file / 1552 pass; server scheduler + work item 209 pass, test mới "does not hold an area named the same in another repo"; `tsc` gốc + `server/tsconfig.test.json` sạch; build, board pid 32180. Chạy thật qua giao diện (nút Đội), lượt 5: #43 App → S8, #44 Backend → S10 chạy song song, bấm #43 mở terminal S8, xong cả hai vào cột Xong. Ảnh ở `build/reports/squad-smoke-20261024/sau-khi-sua/` (không commit).
- Trước đó: commit `a5311e2` (thống kê tool, usage token, nút name-only).
- Đang dở: không. Chưa push nhánh (upstream đang là `mine/main`).
- Tiếp theo: hồ sơ vai của board (`state.settings.roleProfiles`) KHÔNG tự theo `omp config get modelRoles`; 23/10 đã đồng bộ tay qua `companySettingsUpdate`. Đổi vai trong omp sau này thì phải đồng bộ lại. Việc thử 24–44 trên bảng là của các lượt kiểm thử, tự vào Lưu trữ sau 7 ngày. Cột Xong xếp cũ trước nên việc mới nằm cuối cột.

## Đã thử
| Cách | Kết quả | Vì sao / bằng chứng |
|---|---|---|
| Gán token cho skill = mọi lượt từ lúc gọi tới câu người dùng kế tiếp | bỏ | ponytail ra 21,8% trong khi `/usage` không liệt kê; skill nạp đầu phiên nuốt cả phiên |
| Skill = nội dung skill (isMeta sau lần nạp, ký tự/4) ghi cache 1 lần rồi đọc cache mỗi message sau | giữ, ghi rõ ước lượng | subagent khớp `/usage` (general-purpose 21,6% vs 21%, reviewer 8,5% vs 8%); skill thấp hơn `/usage` (~0,1–0,2% vs 1%) |
| `mode: enum [name-only]` trong asyncapi | thất bại | `scripts/generate-messages.ts:128-141` bỏ alias enum một giá trị → `AnonymousSchema_1855` không tồn tại; đổi sang `const: name-only` |

## Ràng buộc đang có
- File dở của phiên Claude/omp khác, KHÔNG đụng: `webview-ui/src/company/components/RolesDialog.tsx`, `library/ClaudeRolesPage.tsx`, `library/SkillsPage.tsx`, `e2e/tmp-sess.mjs` (nguồn: phiên 15a2769f).
- `setClaudeSkillMode` chỉ đổi skill trong `~/.claude/skills` đang nạp đầy đủ (không có override hoặc `on`); không bao giờ nới `off`/`user-invocable-only`; ghi qua `mutateClaudeSettings` (sao lưu + chống ghi đè đồng thời).
- % usage là ƯỚC LƯỢNG theo giá API công khai (sonnet = 1, opus 5/3, haiku 1/3; cache ghi 1,25, đọc 0,1, output 5), không phải cách Anthropic tính hạn mức; skill/plugin chồng lên phiên chính/subagent.
- Thống kê đo lượt gọi skill/MCP/tool, không đo tính năng sản phẩm có ai dùng.
- Ổ V: phải ≥10 GB thì `activity-ledger` mới cho chạy test/build (lần này người dùng chọn xoá `build/` của App).

## Ràng buộc thay đổi lần này
- Đổi: chế độ gọn KHÔNG còn giao việc cho phiên herdr có sẵn của người dùng; chạy trên phiên chat của board dưới khoá vai (2 test cũ thay bằng `runs compact items on board omp sessions per role…` / `holds a compact item while the omp pool is full…`). Người dùng chọn cách này ngày 23/10 ("làm đi").
- Đổi: phiên chat có khoá `squad:<vai>:<repo>` chạy model của vai đó, không phải model chat.
- Bỏ: cổng `WorkItemRoster.wake`; `WorkItemHerdr` không còn `wake`.
- Đổi (24/10): việc con đội gọn hiện trên bảng như việc thường (trước bị giấu trong thẻ đội); đội gọn xong vào Xong, không chờ bấm "Đóng". Test cũ đổi theo: `companySquadView.test.ts` "hides a working compact run…", `companyWorkItemView.test.ts` "shows compact-run children as cards…".
- Đổi (24/10): area cùng tên ở repo khác không còn chặn nhau.

## Câu hỏi còn mở
- Người dùng chưa bấm thử nút chuyển name-only thật (sẽ sửa `~/.claude/settings.json`).
- Token board từng hiện trong log phiên khi smoke; nên `scripts/board-start.ps1 -RotateToken`.
