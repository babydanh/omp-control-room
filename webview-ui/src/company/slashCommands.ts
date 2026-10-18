/**
 * slashCommands: the `/` vocabulary of OMP's own composer, transcribed.
 *
 * Nothing in this file is invented. Every command, alias, description, inline
 * hint and `allowArgs` flag is copied from the installed OMP sources under
 * `node_modules/@oh-my-pi/pi-coding-agent/src/slash-commands/`, and each entry
 * carries the `source` it was read from. The rules are ported, not paraphrased:
 *
 *  - `parseSlashCommand`  <- src/slash-commands/helpers/parse.ts:22-36. The
 *    separator is the EARLIEST whitespace OR `:` so both `/foo bar` and
 *    `/foo:bar` yield `{ name: "foo", args: "bar" }`.
 *  - `OMP_SLASH_COMMANDS` <- the seven arrays concatenated at
 *    src/slash-commands/builtin-registry.ts:40-48, in that order. 84 entries.
 *  - `lookupSlashCommand` <- builtin-registry.ts:50-56, which indexes each
 *    command by its name AND every alias in one flat map.
 *  - `resolveSlashCommand` <- the gate in
 *    src/slash-commands/builtin-registry.ts:133-140: unparseable text, an
 *    unknown name, or arguments given to a command that sets no `allowArgs`
 *    are all `return false` there, and the caller
 *    (src/modes/controllers/input-controller.ts:1071-1081) falls through and
 *    sends the text to the model as an ordinary prompt.
 *
 * Two adaptations are marked below and are deliberate, not omissions; see
 * `OMP_ADAPTATIONS`.
 */

/** Parsed slash-command text after stripping the leading `/`. */
export interface ParsedSlashCommand {
  name: string;
  args: string;
  text: string;
}

/**
 * Parse a slash-invocation string into `name`/`args`.
 *
 * Port of OMP `src/slash-commands/helpers/parse.ts:22-36`. The separator is
 * the earliest whitespace or `:` character so that both `/foo bar` and
 * `/foo:bar` map to `{ name: "foo", args: "bar" }`.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  if (!text.startsWith('/')) return null;
  const body = text.slice(1);
  if (!body) return null;
  const firstWhitespace = body.search(/\s/);
  const firstColon = body.indexOf(':');
  const firstSeparator =
    firstWhitespace === -1
      ? firstColon
      : firstColon === -1
        ? firstWhitespace
        : Math.min(firstWhitespace, firstColon);
  if (firstSeparator === -1) return { name: body, args: '', text };
  return {
    name: body.slice(0, firstSeparator),
    args: body.slice(firstSeparator + 1).trim(),
    text,
  };
}

/** One builtin slash command, as OMP declares it. */
export interface OmpSlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  /** Static ghost-text hint OMP shows after the command name. */
  inlineHint?: string;
  /** Whether the dispatcher accepts text after the name. */
  allowArgs: boolean;
  /** `path:line` in the installed OMP sources this entry was read from. */
  source: string;
}

/**
 * OMP's builtin `/` commands, in registry order (builtin-registry.ts:40-48:
 * modes, collaboration, session, lifecycle, marketplace, skills, control).
 *
 * Two descriptions are lettered rather than copied: OMP interpolates a keycap
 * through `formatKeyHint(...)`, which is a terminal-theme lookup with no
 * webview equivalent, so the literal key is written instead.
 */
export const OMP_SLASH_COMMANDS: readonly OmpSlashCommand[] = [
  {
    name: 'security',
    description: 'Lên kế hoạch, chạy, xem, nhập và so sánh các lần quét bảo mật gốc OMP',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:275',
  },
  {
    name: 'settings',
    description: 'Mở menu cài đặt',
    allowArgs: false,
    source: 'src/slash-commands/builtin-modes.ts:296',
  },
  {
    name: 'setup',
    aliases: ['providers'],
    description: 'Mở trình thiết lập provider',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:305',
  },
  {
    name: 'plan',
    description: 'Bật/tắt chế độ lập kế hoạch (agent lập kế hoạch trước khi thực thi)',
    inlineHint: '[prompt]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:323',
  },
  {
    name: 'plan-review',
    description: 'Mở lại màn hình duyệt kế hoạch cho kế hoạch gần nhất (chỉ ở chế độ lập kế hoạch)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-modes.ts:344',
  },
  {
    name: 'vibe',
    description:
      'Bật/tắt chế độ vibe (phiên worker trực tiếp, lâu dài, nhanh hoặc tốt; bộ công cụ chỉ đọc)',
    inlineHint: '[prompt]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:355',
  },
  {
    name: 'goal',
    description: 'Bật/tắt chế độ mục tiêu (mục tiêu tự trị và lâu dài cho phiên này)',
    inlineHint: '[objective]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:373',
  },
  {
    name: 'guided-goal',
    description: 'Để agent phỏng vấn bạn ngay trong chat, rồi thiết lập chế độ mục tiêu',
    inlineHint: '[rough objective]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:399',
  },
  {
    name: 'loop',
    description:
      "Bật/tắt chế độ lặp. Khi đang bật, câu lệnh tiếp theo bạn gửi sẽ được gửi lại sau mỗi lần agent nhường quyền điều khiển. Giới hạn bằng số lần/thời lượng, hoặc điều kiện bằng --until '<cmd>' / --while '<cmd>' — mã thoát của lệnh quyết định vòng lặp kế tiếp có chạy hay không. Esc tạm dừng vòng lặp đang chạy; gõ /loop lần nữa để tắt.",
    inlineHint: "[count|duration] [--while|--until '<cmd>'] [prompt]",
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:411',
  },
  {
    name: 'queue',
    description: 'Xếp một tin nhắn vào hàng chờ để gửi sau khi agent nhường quyền điều khiển',
    inlineHint: '<message>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:438',
  },
  {
    name: 'model',
    aliases: ['models'],
    description: 'Đổi model cho phiên này',
    allowArgs: false,
    source: 'src/slash-commands/builtin-modes.ts:451',
  },
  {
    name: 'switch',
    description:
      'Đổi model cho phiên này (giống alt+p); nhận id khớp một phần, provider/id, @role, :level',
    inlineHint: '[model]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:495',
  },
  {
    name: 'fast',
    description:
      'Bật/tắt dịch vụ nhanh (OpenAI service_tier=priority hoặc ultrafast, Anthropic speed=fast, Google priority)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:546',
  },
  {
    name: 'slow',
    description:
      'Bật/tắt chế độ chậm: flex tier trên OpenAI/Google; trên Anthropic, tiếp tục ở mức ưu tiên thấp sau khi đã chạm giới hạn phiên Claude',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:574',
  },
  {
    name: 'skillful',
    description: 'Bật/tắt việc liệt kê các skill khả dụng trong system prompt (chỉ trong phiên)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:602',
  },
  {
    name: 'extended-context',
    description: 'Bật/tắt cửa sổ ngữ cảnh mở rộng',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:658',
  },
  {
    name: 'computer',
    description: 'Bật/tắt prelude computer-use gốc cho phiên này',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:685',
  },
  {
    name: 'ratchet',
    description:
      'Xây dựng (hoặc tái dùng) một eval cho một luồng LLM, rồi hillclimb không cần giám sát',
    inlineHint: '[flow and goal]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:730',
  },
  {
    name: 'prewalk',
    description: 'Chuẩn bị hoặc khởi động lại một lần bàn giao model một-shot',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:764',
  },
  {
    name: 'modelpreset',
    description: 'Lưu và chuyển đổi preset model (model theo vai trò + mức độ suy luận)',
    inlineHint: '[save|switch|delete|list] [name]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-modes.ts:814',
  },
  {
    name: 'advisor',
    description: 'Bật/tắt advisor (một model thứ hai duyệt từng lượt và chèn ghi chú)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:62',
  },
  {
    name: 'export',
    description: 'Xuất phiên ra tệp HTML',
    inlineHint: '[--themes] [path]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:179',
  },
  {
    name: 'trace',
    description: 'Mở trace của phiên này trong bảng điều khiển thống kê',
    allowArgs: false,
    source: 'src/slash-commands/builtin-collaboration.ts:203',
  },
  {
    name: 'dump',
    description: 'Chép bản ghi của phiên vào clipboard (và ghi JSON yêu cầu LLM ra tmp)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:230',
  },
  {
    name: 'share',
    description: 'Chia sẻ phiên qua một liên kết được mã hóa (share server hoặc secret gist)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-collaboration.ts:263',
  },
  {
    name: 'collab',
    description: 'Chia sẻ phiên này trực tiếp qua một relay',
    inlineHint: '[start|view|list|stop|status] [relayUrl]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:289',
  },
  {
    name: 'join',
    description: 'Tham gia một phiên cộng tác đã được chia sẻ',
    inlineHint: '<link>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:418',
  },
  {
    name: 'leave',
    description: 'Rời khỏi phiên cộng tác',
    allowArgs: false,
    source: 'src/slash-commands/builtin-collaboration.ts:450',
  },
  {
    name: 'browser',
    description: 'Bật/tắt chế độ headless hay hiển thị cho prelude trình duyệt',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:475',
  },
  {
    name: 'copy',
    description: 'Chọn một đoạn văn bản hoặc mã trong cuộc trò chuyện để sao chép',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:545',
  },
  {
    name: 'open',
    description:
      'Mở liên kết cuối cùng trong cuộc trò chuyện bằng trình duyệt của bạn (hoặc chọn một liên kết bằng /copy)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-collaboration.ts:597',
  },
  {
    name: 'todo',
    description: 'Xem hoặc chỉnh sửa danh sách việc cần làm của agent',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:207',
  },
  {
    name: 'session',
    description: 'Các lệnh quản lý phiên',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:245',
  },
  {
    name: 'jobs',
    description: 'Hiển thị trạng thái các tác vụ nền chạy bất đồng bộ',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:323',
  },
  {
    name: 'usage',
    description: 'Hiển thị mức sử dụng và hạn mức của provider',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:367',
  },
  {
    name: 'stats',
    description: 'Mở bảng điều khiển thống kê cục bộ',
    inlineHint: '[--port <port>] [--host <host>]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:414',
  },
  {
    name: 'changelog',
    description: 'Hiển thị các mục changelog',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:449',
  },
  {
    name: 'hotkeys',
    description: 'Hiển thị toàn bộ phím tắt',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:478',
  },
  {
    name: 'tools',
    description: 'Hiển thị các công cụ hiện đang hiển thị với agent',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:487',
  },
  {
    name: 'context',
    description: 'Hiển thị chi tiết mức dùng ngữ cảnh ước tính',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:516',
  },
  {
    name: 'extensions',
    aliases: ['status'],
    description: 'Mở bảng điều khiển Extension Control Center',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:535',
  },
  {
    name: 'agents',
    description: 'Mở trung tâm agents (model, prewalk và advisor riêng cho từng agent)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:545',
  },
  {
    name: 'git',
    description: 'Mở giao diện git (xem diff so sánh, staging, trình soạn commit)',
    inlineHint: '[revision]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:554',
  },
  {
    name: 'hub',
    description: 'Mở Agent Hub trực tiếp',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:565',
  },
  {
    name: 'branch',
    aliases: ['rewind'],
    description: 'Quay lui về một tin nhắn trước, giữ lại đường đi cũ thành một nhánh',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:574',
  },
  {
    name: 'fork',
    description: 'Tạo một nhánh fork mới từ một tin nhắn trước',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:584',
  },
  {
    name: 'tree',
    description: 'Duyệt cây phiên (chuyển nhánh)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-session.ts:593',
  },
  {
    name: 'login',
    description: 'Đăng nhập bằng provider OAuth',
    inlineHint: '[provider|redirect URL]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:602',
  },
  {
    name: 'logout',
    description: 'Đăng xuất khỏi provider OAuth',
    inlineHint: '[provider]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:655',
  },
  {
    name: 'mcp',
    description: 'Quản lý máy chủ MCP (thêm, liệt kê, gỡ, kiểm thử)',
    inlineHint: '<subcommand>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-session.ts:678',
  },
  {
    name: 'ssh',
    description: 'Quản lý máy chủ SSH (thêm, liệt kê, gỡ)',
    inlineHint: '<subcommand>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:153',
  },
  {
    name: 'new',
    description: 'Bắt đầu phiên mới',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:176',
  },
  {
    name: 'fresh',
    description: 'Đặt lại trạng thái luồng của provider mà không thay đổi bản ghi cục bộ',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:185',
  },
  {
    name: 'clear',
    description: 'Xóa ngữ cảnh cuộc trò chuyện tại chỗ, giữ nguyên phiên hiện tại',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:207',
  },
  {
    name: 'delete',
    description: 'Xóa phiên hiện tại và bắt đầu phiên mới',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:218',
  },
  {
    name: 'compact',
    description: 'Nén thủ công ngữ cảnh của phiên',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:227',
  },
  {
    name: 'shake',
    description: 'Loại bỏ nội dung nặng khỏi ngữ cảnh (kết quả công cụ, các khối lớn)',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:293',
  },
  {
    name: 'handoff',
    description: 'Tóm tắt phiên thành tài liệu bàn giao và nén tại chỗ',
    inlineHint: '[focus instructions]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:322',
  },
  {
    name: 'resume',
    description: 'Tiếp tục một phiên khác',
    inlineHint: '[session id|@claude|@codex]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:389',
  },
  {
    name: 'pin',
    description: 'Ghim hoặc bỏ ghim một phiên lên đầu danh sách tiếp tục',
    inlineHint: '[session id]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:420',
  },
  {
    name: 'btw',
    description: 'Hỏi một câu hỏi phụ, hoặc xem lại lịch sử BTW của phiên này',
    inlineHint: '[question]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:451',
  },
  {
    name: 'tan',
    description: 'Chạy một agent nền đầy đủ cho một nhánh công việc phụ',
    inlineHint: '<work>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:463',
  },
  {
    name: 'omfg',
    description: 'Rút ra một quy tắc TTSR từ một lời phàn nàn để chặn hành vi lặp lại',
    inlineHint: '<complaint>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:475',
  },
  {
    name: 'cleanse',
    description: 'Phát hiện và sửa các chẩn đoán dự án bằng subagent song song có trọng số',
    inlineHint: '[request] [--all]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:487',
  },
  {
    name: 'retry',
    description: 'Thử lại lượt agent vừa thất bại',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:499',
  },
  {
    name: 'debug',
    description: 'Mở bộ chọn công cụ debug',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:534',
  },
  {
    name: 'memory',
    description: 'Xem và vận hành việc bảo trì memory',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:543',
  },
  {
    name: 'rename',
    description: 'Đổi tên phiên hiện tại (bỏ trống tiêu đề để tự sinh)',
    inlineHint: '[title]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:632',
  },
  {
    name: 'move',
    description: 'Chuyển phiên hiện tại sang một thư mục khác',
    inlineHint: '[<path>]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:710',
  },
  {
    name: 'wt',
    aliases: ['worktree'],
    description: 'Chuyển phiên này sang một worktree mới, kèm theo các thay đổi',
    inlineHint: '[<branch>]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:740',
  },
  {
    name: 'add-dir',
    description: 'Thêm một thư mục workspace vào phiên này (multi-root)',
    inlineHint: '<path>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:775',
  },
  {
    name: 'remove-dir',
    description: 'Gỡ một thư mục workspace khỏi phiên này',
    inlineHint: '<path>',
    allowArgs: true,
    source: 'src/slash-commands/builtin-lifecycle.ts:807',
  },
  {
    name: 'dirs',
    description: 'Liệt kê các thư mục workspace của phiên này',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:836',
  },
  {
    name: 'exit',
    description: 'Thoát ứng dụng',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:845',
  },
  {
    name: 'restart',
    description: 'Khởi động lại omp với cùng các cờ khởi chạy, tiếp tục phiên này',
    allowArgs: false,
    source: 'src/slash-commands/builtin-lifecycle.ts:850',
  },
  {
    name: 'marketplace',
    description: 'Quản lý các nguồn plugin marketplace và plugin đã cài',
    allowArgs: true,
    source: 'src/slash-commands/builtin-marketplace.ts:45',
  },
  {
    name: 'plugins',
    aliases: ['plugin'],
    description: 'Xem và quản lý các plugin đã cài',
    allowArgs: true,
    source: 'src/slash-commands/builtin-marketplace.ts:425',
  },
  {
    name: 'reload-plugins',
    description: 'Tải lại toàn bộ plugin (skills, commands, hooks, tools, agents, MCP)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-marketplace.ts:557',
  },
  {
    name: 'skills',
    description: 'Tìm kiếm, cài đặt và cập nhật skills từ registry skills.omp.sh',
    allowArgs: true,
    source: 'src/slash-commands/builtin-skills.ts:66',
  },
  {
    name: 'force',
    aliases: ['force:'],
    description: 'Buộc lượt tiếp theo dùng một công cụ cụ thể',
    inlineHint: '<tool-name> [prompt]',
    allowArgs: true,
    source: 'src/slash-commands/builtin-control.ts:9',
  },
  {
    name: 'live',
    description: 'Bật chế độ giọng nói thời gian thực chạy trên Codex',
    allowArgs: false,
    source: 'src/slash-commands/builtin-control.ts:59',
  },
  {
    name: 'record',
    description: 'Bắt đầu hoặc dừng ghi hình màn hình này ra một tệp xem lại được (omp play)',
    allowArgs: false,
    source: 'src/slash-commands/builtin-control.ts:68',
  },
  {
    name: 'pause',
    description: 'Đóng băng mọi agent (chính, subagent, advisor) cho tới khi được tiếp tục',
    allowArgs: false,
    source: 'src/slash-commands/builtin-control.ts:77',
  },
  {
    name: 'quit',
    aliases: ['q'],
    description: 'Thoát ứng dụng',
    allowArgs: false,
    source: 'src/slash-commands/builtin-control.ts:86',
  },
];

/**
 * What this port deliberately does not reproduce. Listed so the divergence is
 * a decision on the record rather than a gap somebody has to rediscover.
 */
export const OMP_ADAPTATIONS = {
  /**
   * OMP's dispatcher runs INSIDE the TUI (`input-controller.ts:1051-1082`).
   * The Company reaches OMP through the bridge extension's `sendUserMessage`
   * (`server/src/company/ompBridgeExtension.ts:1056-1082`), which lands in
   * `AgentSession.sendUserMessage` (`agent-session.ts:8571`) and never touches
   * the slash dispatcher. So a command the client does not handle itself is
   * sent to the model as literal text — which is exactly what OMP does for text
   * its dispatcher returns `false` on, and the reason `SubmitPromptInput` would
   * have to grow a `command` field for the rest to work at all.
   */
  unroutedCommandsBecomePromptText: true,
  /**
   * OMP resolves a selector with fuzzy ids, `@role` aliases and `:level`
   * thinking suffixes against `session.scopedModels` /
   * `session.modelRegistry` (`builtin-modes.ts:50-69` ->
   * `config/model-resolver.ts:2005`). None of that is in the company snapshot;
   * the client matches what it can prove from the runtime catalog and refuses
   * the rest rather than guessing.
   */
  selectorResolutionIsCatalogExact: true,
  /**
   * OMP's `/model` with no arguments opens the Model Hub dashboard and
   * `/switch` opens the picker (`selector-controller.ts:615-621`). The company
   * has no dashboard, so both open the one picker over the runtime catalog.
   */
  modelHubIsACatalogPicker: true,
} as const;

/** A slash invocation the dispatcher would accept. */
export interface ResolvedSlashCommand {
  parsed: ParsedSlashCommand;
  command: OmpSlashCommand;
}

/**
 * The accept gate, ported from `executeBuiltinSlashCommand`
 * (builtin-registry.ts:133-140). Returning `null` means OMP would have
 * returned `false` and the text would have gone to the model verbatim:
 *
 *  - the text is not a slash invocation at all (`:134`);
 *  - the name is not a builtin and not an alias (`:136-137`);
 *  - arguments were given to a command that declares no `allowArgs` (`:138`).
 */
export function resolveSlashCommand(text: string): ResolvedSlashCommand | null {
  const parsed = parseSlashCommand(text);
  if (!parsed) return null;
  const command = lookupSlashCommand(parsed.name);
  if (!command) return null;
  if (parsed.args.length > 0 && !command.allowArgs) return null;
  return { parsed, command };
}

/**
 * The command-name completion token for a draft, or `null` when the draft is
 * not naming a command.
 *
 * OMP only completes a command in the FIRST token: the first separator ends
 * the name (`helpers/parse.ts:26-33`), so anything past it is arguments and
 * the user is editing an argument, not naming a command. The token always
 * starts at index 1 of the draft, right after the leading `/`.
 */
export function commandCompletionQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const body = text.slice(1);
  if (/[\s:]/.test(body)) return null;
  return body;
}

/**
 * Every command name and alias in one flat index, built the way OMP builds
 * `BUILTIN_SLASH_COMMAND_LOOKUP` (builtin-registry.ts:50-56): each command is
 * keyed by its name and then by every alias.
 */
const COMMAND_INDEX: Record<string, OmpSlashCommand> = {};
for (const command of OMP_SLASH_COMMANDS) {
  COMMAND_INDEX[command.name] = command;
  for (const alias of command.aliases ?? []) COMMAND_INDEX[alias] = command;
}

/**
 * Port of `lookupBuiltinSlashCommand` (builtin-registry.ts:181-183). The
 * `hasOwn` guard matters: a plain property read would answer `/constructor`
 * and `/toString` with something inherited rather than "unknown command".
 */
export function lookupSlashCommand(name: string): OmpSlashCommand | undefined {
  return Object.hasOwn(COMMAND_INDEX, name) ? COMMAND_INDEX[name] : undefined;
}

/**
 * Which of OMP's four model-command replies to produce. Each case is OMP's own
 * wording, taken from the line cited beside it; the company reuses the strings
 * rather than paraphrasing them so a reply read here matches a reply read in
 * the terminal.
 */
export type OmpModelMessage =
  /** `Unknown model: <selector>.` — builtin-modes.ts:466-469 */
  | 'unknown'
  /** `Model set to <provider>/<id>.` — builtin-modes.ts:474 */
  | 'set'
  /** `Session-only model: <provider>/<id>.` — builtin-modes.ts:521 */
  | 'switched'
  /** `Current model: <provider>/<id>` — builtin-modes.ts:485 */
  | 'current';

/**
 * Format one of OMP's model-command replies. `selector` is the model the user
 * asked for; an empty one is what OMP reports when nothing is selected
 * (`Current model:` has a no-model form and the others do not).
 */
export function ompModelMessage(kind: OmpModelMessage, selector: string): string {
  const model = selector.trim();
  switch (kind) {
    case 'unknown':
      return `Model không xác định: ${model}. Hãy dùng ACP \`session/setModel\` để chọn qua bảng chọn, hoặc liệt kê model có sẵn bằng /model.`;
    case 'set':
      return `Đã đặt model thành ${model}.`;
    case 'switched':
      return `Model chỉ dùng cho phiên này: ${model}.`;
    case 'current':
      return model === '' ? 'Chưa chọn model nào.' : `Model hiện tại: ${model}`;
  }
}
/** Command names matching a typed prefix, in OMP's registry order. */
export function commandCompletions(typed: string): OmpSlashCommand[] {
  const needle = typed.toLowerCase();
  return OMP_SLASH_COMMANDS.filter(
    (command) =>
      command.name.startsWith(needle) ||
      (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(needle)),
  );
}
