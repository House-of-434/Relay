export function ReplyIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="1 3 22 18"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M19 19v-4q0-1.25-.875-2.125T16 12H6.825l3.6 3.6L9 17l-6-6l6-6l1.425 1.4l-3.6 3.6H16q2.075 0 3.538 1.463T21 15v4h-2Z" />
    </svg>
  );
}
