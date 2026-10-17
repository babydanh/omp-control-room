import { Button } from './ui/Button.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <div
      className="absolute inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onDismiss}
    >
      <div
        className="pixel-panel py-24 px-32 max-w-xl text-center leading-[1.3]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-12 text-accent">Chúng ta nợ bạn một lời xin lỗi!</div>
        <p className="text-xl m-0 mb-12">
          Chúng tôi vừa chuyển sang bộ tài nguyên mã nguồn mở hoàn toàn, tất cả đều được xây dựng từ
          đầu với tất cả tâm huyết. Điều đó có nghĩa là bố cục trước đây của bạn đã phải được đặt
          lại.
        </p>
        <p className="text-xl m-0 mb-12">Chúng tôi thực sự rất tiếc về điều đó.</p>
        <p className="text-xl m-0 mb-12">
          Tin tốt? Đây chỉ là một lần, và nó mở đường cho nhiều cập nhật thú vị sắp tới.
        </p>
        <p className="text-xl m-0 mb-20">Hãy theo dõi, và cảm ơn bạn đã dùng Pixel Agents!</p>
        <Button variant="accent" size="xl" onClick={onDismiss}>
          Đã hiểu
        </Button>
      </div>
    </div>
  );
}
