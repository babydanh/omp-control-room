import type { ButtonHTMLAttributes } from 'react';

export type CompanyButtonVariant = 'default' | 'accent';
export type CompanyButtonSize = 'sm' | 'md';

export interface CompanyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CompanyButtonVariant;
  size?: CompanyButtonSize;
}

const VARIANT_CLASS: Record<CompanyButtonVariant, string> = {
  default: '',
  accent: 'company-btn-accent',
};

const SIZE_CLASS: Record<CompanyButtonSize, string> = {
  sm: '',
  md: 'company-btn-md',
};

/**
 * Company-scoped button: a raised fill and no edge. The shared `Button` keeps the
 * 2px pixel frame, which clashes with the company chrome.
 */
export function CompanyButton({
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: CompanyButtonProps) {
  const classes = ['company-btn', SIZE_CLASS[size], VARIANT_CLASS[variant], className]
    .filter(Boolean)
    .join(' ');
  return <button className={classes} {...rest} />;
}
